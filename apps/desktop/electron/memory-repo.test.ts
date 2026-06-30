/* Tests for memory-repo: the per-project memory clone + symlink layer.
   All git ops go through the injectable GitRunner (so no shell-out); all
   GitHub ops go through fetchImpl. Real fs IS used for the symlink tests
   (we want to verify the OS-level symlink behaviour, not a fake of it). */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, lstatSync, readlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  memoryClonePath, discoverMemoryRepo, ensureMemoryRepo, pullMemory,
  commitAndPushMemory, linkMemoryIntoProject, seedMemoryClone, type GitRunner,
} from './memory-repo.js';

/** GitRunner that records calls + lets the test stub a per-cmd outcome. */
function makeGitRunner(opts: { fails?: Array<{ argsContain: string; throwMsg: string; once?: boolean }>; outputs?: Record<string, string> } = {}): GitRunner & { calls: Array<{ dir: string; args: string[] }>; clones: Array<{ url: string; dest: string }> } {
  const calls: Array<{ dir: string; args: string[] }> = [];
  const clones: Array<{ url: string; dest: string }> = [];
  const fails = [...(opts.fails ?? [])];
  return {
    calls, clones,
    run: (dir, args) => {
      calls.push({ dir, args });
      const i = fails.findIndex(f => args.some(a => a.includes(f.argsContain)));
      if (i >= 0) {
        const f = fails[i];
        if (f.once) fails.splice(i, 1);
        throw new Error(f.throwMsg);
      }
      // canned outputs by joined args
      const key = args.join(' ');
      if (opts.outputs && key in opts.outputs) return opts.outputs[key];
      return '';
    },
    clone: (url, dest) => {
      clones.push({ url, dest });
      // simulate `git clone` producing a .git dir at dest
      mkdirSync(path.join(dest, '.git'), { recursive: true });
    },
  };
}

/** Per-URL fetch stub. */
function routedFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (url: string, _init?: { method?: string }) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const r = routes[path] ?? { status: 404, body: { message: 'no route' } };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: () => null },
      json: async () => r.body ?? {},
    };
  }) as unknown as typeof fetch;
}

/* Per-test scratch dir (real fs). */
let scratch = '';
beforeEach(() => {
  scratch = path.join(tmpdir(), `maestro-memrepo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(scratch, { recursive: true });
});
afterEach(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* */ } });

describe('memoryClonePath', () => {
  test('joins userData + memory/<slug>', () => {
    expect(memoryClonePath('foo', '/tmp/ud')).toBe(path.join('/tmp/ud', 'memory', 'foo'));
  });
  test('sanitises a slug with unsafe chars (no path traversal escape)', () => {
    // Defense-in-depth: even if a caller forgets to slugify(), we can't let
    // path separators leak through and write outside userData/memory/.
    const got = memoryClonePath('weird///../slug', '/tmp/ud');
    expect(got.startsWith(path.join('/tmp/ud', 'memory') + path.sep)).toBe(true);
    expect(got).not.toContain('/../');
    expect(got).not.toContain(path.sep + '..' + path.sep);
  });
  test('empty slug throws', () => {
    expect(() => memoryClonePath('  /// ', '/tmp/ud')).toThrow(/slug/i);
  });
});

describe('discoverMemoryRepo', () => {
  test('200 → exists:true + cloneUrl', async () => {
    const f = routedFetch({ '/repos/octo/foo-memory': { status: 200, body: { clone_url: 'https://github.com/octo/foo-memory.git' } } });
    expect(await discoverMemoryRepo('tok', 'octo', 'foo', f)).toEqual({ exists: true, cloneUrl: 'https://github.com/octo/foo-memory.git' });
  });
  test('404 → exists:false', async () => {
    const f = routedFetch({});
    expect(await discoverMemoryRepo('tok', 'octo', 'foo', f)).toEqual({ exists: false, cloneUrl: null });
  });
  test('missing user → throws (sanity)', async () => {
    await expect(discoverMemoryRepo('tok', '', 'foo')).rejects.toThrow(/user/i);
  });
});

describe('ensureMemoryRepo', () => {
  test('not on github + not local → POST /user/repos + clone', async () => {
    const ud = scratch;
    const git = makeGitRunner();
    const f = routedFetch({
      '/repos/octo/foo-memory': { status: 404 },
      '/user/repos': { status: 201, body: { clone_url: 'https://github.com/octo/foo-memory.git', html_url: 'https://github.com/octo/foo-memory' } },
    });
    const r = await ensureMemoryRepo({ token: 'tok', user: 'octo', slug: 'foo', userDataDir: ud, gitRunner: git, githubFetch: f });
    expect(r.htmlUrl).toBe('https://github.com/octo/foo-memory');
    expect(r.memoryPath).toBe(path.join(ud, 'memory', 'foo'));
    expect(git.clones[0]).toEqual({ url: 'https://github.com/octo/foo-memory.git', dest: r.memoryPath });
  });
  test('already on github + not local → skip create, just clone', async () => {
    const ud = scratch;
    const git = makeGitRunner();
    const f = routedFetch({
      '/repos/octo/foo-memory': { status: 200, body: { clone_url: 'https://github.com/octo/foo-memory.git' } },
    });
    await ensureMemoryRepo({ token: 'tok', user: 'octo', slug: 'foo', userDataDir: ud, gitRunner: git, githubFetch: f });
    // No /user/repos POST was needed; only the discover GET + a clone.
    expect(git.clones).toHaveLength(1);
  });
  test('already local + already remote → no clone, no POST (idempotent)', async () => {
    const ud = scratch;
    // Pre-seed a clone directory with a .git folder.
    const dest = path.join(ud, 'memory', 'foo');
    mkdirSync(path.join(dest, '.git'), { recursive: true });
    const git = makeGitRunner();
    const f = routedFetch({
      '/repos/octo/foo-memory': { status: 200, body: { clone_url: 'https://github.com/octo/foo-memory.git' } },
    });
    await ensureMemoryRepo({ token: 'tok', user: 'octo', slug: 'foo', userDataDir: ud, gitRunner: git, githubFetch: f });
    expect(git.clones).toHaveLength(0);
  });
  test('empty user → throws (sanity, never call POST)', async () => {
    await expect(ensureMemoryRepo({ token: 't', user: '', slug: 'foo', userDataDir: scratch })).rejects.toThrow(/user/i);
  });
});

describe('pullMemory', () => {
  test('no local clone → returns {pulled:false}', async () => {
    const r = await pullMemory('never-cloned', makeGitRunner(), scratch);
    expect(r).toEqual({ pulled: false, conflictsResolved: 0 });
  });
  test('clean clone → runs `git pull --rebase --autostash` once', async () => {
    const dest = path.join(scratch, 'memory', 'foo');
    mkdirSync(path.join(dest, '.git'), { recursive: true });
    const git = makeGitRunner();
    const r = await pullMemory('foo', git, scratch);
    expect(r.pulled).toBe(true);
    expect(git.calls).toHaveLength(1);
    expect(git.calls[0].args).toEqual(['pull', '--rebase', '--autostash']);
  });
  test('rebase conflict → checkout --theirs + rebase --continue (last-writer-wins)', async () => {
    const dest = path.join(scratch, 'memory', 'foo');
    mkdirSync(path.join(dest, '.git'), { recursive: true });
    const git = makeGitRunner({ fails: [{ argsContain: 'pull', throwMsg: 'CONFLICT (content): Merge conflict in STATE.md', once: true }] });
    const r = await pullMemory('foo', git, scratch);
    expect(r.pulled).toBe(true);
    expect(r.conflictsResolved).toBeGreaterThan(0);
    // We MUST have run `checkout --theirs .` after the pull failed.
    const sawTheirs = git.calls.some(c => c.args.join(' ').includes('checkout --theirs'));
    expect(sawTheirs).toBe(true);
    const sawContinue = git.calls.some(c => c.args.join(' ').includes('rebase --continue'));
    expect(sawContinue).toBe(true);
  });
  test('non-conflict error → aborts rebase + rethrows (no infinite retry)', async () => {
    const dest = path.join(scratch, 'memory', 'foo');
    mkdirSync(path.join(dest, '.git'), { recursive: true });
    const git = makeGitRunner({ fails: [{ argsContain: 'pull', throwMsg: 'fatal: unable to access — network down' }] });
    await expect(pullMemory('foo', git, scratch)).rejects.toThrow(/network down/);
  });
});

describe('commitAndPushMemory', () => {
  test('no local clone → returns {pushed:false}', async () => {
    expect(await commitAndPushMemory('absent', 'reason', makeGitRunner(), scratch)).toEqual({ pushed: false, sha: null });
  });
  test('happy path: add + commit + push, returns sha from rev-parse', async () => {
    const dest = path.join(scratch, 'memory', 'foo');
    mkdirSync(path.join(dest, '.git'), { recursive: true });
    const git = makeGitRunner({ outputs: { 'rev-parse HEAD': 'deadbeefdeadbeef' } });
    const r = await commitAndPushMemory('foo', 'state changed', git, scratch);
    expect(r).toEqual({ pushed: true, sha: 'deadbeefdeadbeef' });
    const adds = git.calls.filter(c => c.args[0] === 'add');
    expect(adds.length).toBeGreaterThan(0);
    const pushes = git.calls.filter(c => c.args[0] === 'push');
    expect(pushes).toHaveLength(1);
  });
  test('nothing changed → swallows "nothing to commit" and reports pushed:false', async () => {
    const dest = path.join(scratch, 'memory', 'foo');
    mkdirSync(path.join(dest, '.git'), { recursive: true });
    const git = makeGitRunner({ fails: [{ argsContain: 'commit', throwMsg: 'nothing to commit, working tree clean' }] });
    const r = await commitAndPushMemory('foo', 'state changed', git, scratch);
    expect(r).toEqual({ pushed: false, sha: null });
    // Crucially no push call was made.
    expect(git.calls.filter(c => c.args[0] === 'push')).toHaveLength(0);
  });
});

describe('linkMemoryIntoProject', () => {
  /* The four symlinks have to be exact: anything wrong in this layer means
     the agent reads the wrong STATE.md and silently loses memory across
     turns. Real fs is used so the OS-level symlink behaviour is what's
     actually verified. */

  test('fresh project, fresh memory clone → 4 symlinks created', async () => {
    const ud = scratch;
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    // seed a memory clone with the canonical files (mirrors seedMemoryClone).
    const memDir = path.join(ud, 'memory', 'foo');
    mkdirSync(path.join(memDir, 'continuum'), { recursive: true });
    mkdirSync(path.join(memDir, 'claude', 'skills'), { recursive: true });
    writeFileSync(path.join(memDir, 'claude', 'CLAUDE.md'), '# x\n');
    writeFileSync(path.join(memDir, 'claude', 'settings.json'), '{}\n');

    await linkMemoryIntoProject('foo', proj, ud);
    expect(lstatSync(path.join(proj, '.continuum')).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(proj, '.claude', 'skills')).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(proj, '.claude', 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(proj, '.claude', 'settings.json')).isSymbolicLink()).toBe(true);
    // The link target should resolve to the memory clone's matching path.
    expect(readlinkSync(path.join(proj, '.continuum'))).toBe(path.join(memDir, 'continuum'));
    expect(readFileSync(path.join(proj, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# x\n');
  });
  test('rerun is idempotent: existing CORRECT symlinks left alone, no throw', async () => {
    const ud = scratch;
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    const memDir = path.join(ud, 'memory', 'foo');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(path.join(memDir, 'claude_seed'), 'init');
    mkdirSync(path.join(memDir, 'continuum'), { recursive: true });
    mkdirSync(path.join(memDir, 'claude', 'skills'), { recursive: true });
    writeFileSync(path.join(memDir, 'claude', 'CLAUDE.md'), 'a');
    writeFileSync(path.join(memDir, 'claude', 'settings.json'), '{}');
    await linkMemoryIntoProject('foo', proj, ud);
    // run it again — should be a no-op
    await linkMemoryIntoProject('foo', proj, ud);
    // still a symlink, still pointing where we expect
    expect(readlinkSync(path.join(proj, '.continuum'))).toBe(path.join(memDir, 'continuum'));
  });
  test('symlink pointing to the WRONG place → throws (refuse silent rewrite)', async () => {
    const ud = scratch;
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    const memDir = path.join(ud, 'memory', 'foo');
    mkdirSync(path.join(memDir, 'continuum'), { recursive: true });
    mkdirSync(path.join(memDir, 'claude', 'skills'), { recursive: true });
    writeFileSync(path.join(memDir, 'claude', 'CLAUDE.md'), 'a');
    writeFileSync(path.join(memDir, 'claude', 'settings.json'), '{}');
    // Pre-existing wrong symlink: .continuum points to some stray dir.
    const stray = path.join(scratch, 'stray');
    mkdirSync(stray, { recursive: true });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(stray, path.join(proj, '.continuum'), 'dir');
    await expect(linkMemoryIntoProject('foo', proj, ud)).rejects.toThrow(/symlink/i);
  });
  test('real DIRECTORY at the target → throws ("would clobber")', async () => {
    const ud = scratch;
    const proj = path.join(scratch, 'proj');
    // The user already has a real .continuum/ they wrote into — refuse.
    mkdirSync(path.join(proj, '.continuum'), { recursive: true });
    writeFileSync(path.join(proj, '.continuum', 'STATE.md'), 'previous content');
    const memDir = path.join(ud, 'memory', 'foo');
    mkdirSync(path.join(memDir, 'continuum'), { recursive: true });
    mkdirSync(path.join(memDir, 'claude', 'skills'), { recursive: true });
    writeFileSync(path.join(memDir, 'claude', 'CLAUDE.md'), 'a');
    writeFileSync(path.join(memDir, 'claude', 'settings.json'), '{}');
    await expect(linkMemoryIntoProject('foo', proj, ud)).rejects.toThrow(/clobber/i);
    // And critically — the existing file is untouched.
    expect(readFileSync(path.join(proj, '.continuum', 'STATE.md'), 'utf8')).toBe('previous content');
  });
  test('real FILE at one of the file targets → throws (CLAUDE.md case)', async () => {
    const ud = scratch;
    const proj = path.join(scratch, 'proj');
    mkdirSync(path.join(proj, '.claude'), { recursive: true });
    writeFileSync(path.join(proj, '.claude', 'CLAUDE.md'), 'i wrote my own');
    const memDir = path.join(ud, 'memory', 'foo');
    mkdirSync(path.join(memDir, 'continuum'), { recursive: true });
    mkdirSync(path.join(memDir, 'claude', 'skills'), { recursive: true });
    writeFileSync(path.join(memDir, 'claude', 'CLAUDE.md'), 'b');
    writeFileSync(path.join(memDir, 'claude', 'settings.json'), '{}');
    await expect(linkMemoryIntoProject('foo', proj, ud)).rejects.toThrow(/clobber/i);
    expect(readFileSync(path.join(proj, '.claude', 'CLAUDE.md'), 'utf8')).toBe('i wrote my own');
  });
  test('missing .claude dir → created automatically', async () => {
    const ud = scratch;
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });               // NO .claude
    const memDir = path.join(ud, 'memory', 'foo');
    mkdirSync(path.join(memDir, 'continuum'), { recursive: true });
    mkdirSync(path.join(memDir, 'claude', 'skills'), { recursive: true });
    writeFileSync(path.join(memDir, 'claude', 'CLAUDE.md'), 'a');
    writeFileSync(path.join(memDir, 'claude', 'settings.json'), '{}');
    await linkMemoryIntoProject('foo', proj, ud);
    expect(existsSync(path.join(proj, '.claude'))).toBe(true);
    expect(lstatSync(path.join(proj, '.claude', 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });
});

describe('seedMemoryClone', () => {
  test('writes 4 canonical files (idempotent)', () => {
    const memDir = path.join(scratch, 'mem');
    const written = seedMemoryClone(memDir, { projectName: 'My App', now: new Date('2026-06-23T00:00:00Z'), maestroCommitSkill: '---\nname: maestro-commit\n---\n' });
    expect(written.sort()).toEqual([
      path.join('claude', 'CLAUDE.md'),
      path.join('claude', 'settings.json'),
      path.join('claude', 'skills', 'maestro-commit', 'SKILL.md'),
      path.join('continuum', 'STATE.md'),
    ]);
    expect(readFileSync(path.join(memDir, 'continuum', 'STATE.md'), 'utf8')).toContain('# My App');
    expect(readFileSync(path.join(memDir, 'claude', 'CLAUDE.md'), 'utf8')).toContain('STATE.md');
    expect(readFileSync(path.join(memDir, 'claude', 'settings.json'), 'utf8')).toBe('{}\n');
    expect(readFileSync(path.join(memDir, 'claude', 'skills', 'maestro-commit', 'SKILL.md'), 'utf8')).toContain('maestro-commit');
    // Rerun — no new writes (idempotent).
    const second = seedMemoryClone(memDir, { projectName: 'My App', now: new Date('2026-06-23T00:00:00Z'), maestroCommitSkill: 'whatever' });
    expect(second).toEqual([]);
  });
});
