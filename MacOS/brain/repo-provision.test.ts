/* Repo provisioning — real temp repos on disk, no network: GitHub API calls
   ride fetchImpl, and the "remote" is a local bare repo so pushBranch works
   offline. Also covers the .continuum local-exclude (the multi-developer
   memory-conflict fix) incl. worktree sharing via the common git dir. */

import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTempRepo, makeTempDir } from './test-helpers.js';
import { repoNameSlug, ensureContinuumExcluded, provisionGitHubRemote } from './repo-provision.js';
import { memoryProjectSlug } from './memory-sync.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function track<T extends string>(d: T): T { cleanup.push(d); return d; }
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
/** A local bare repo standing in for github.com — push works offline. */
function makeBareRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mst-bare-'));
  execFileSync('git', ['init', '-q', '--bare', dir], { encoding: 'utf8' });
  return dir;
}

describe('repoNameSlug', () => {
  test('GitHub-safe: dashes, trimmed edges, diacritics stripped, capped', () => {
    expect(repoNameSlug('My Cool App!')).toBe('My-Cool-App');
    expect(repoNameSlug('  --café latté--  ')).toBe('cafe-latte');
    expect(repoNameSlug('')).toBe('project');
    expect(repoNameSlug('!!!').length).toBeGreaterThan(0);
    expect(repoNameSlug('x'.repeat(200)).length).toBeLessThanOrEqual(90);
  });
});

describe('memoryProjectSlug', () => {
  test('readable name + short id suffix; collision-proof across renames', () => {
    expect(memoryProjectSlug({ id: 'ABC-123-def', name: 'My Project' })).toBe('my-project-abc123de');
    expect(memoryProjectSlug({ id: '12345678', name: '' })).toBe('project-12345678');
  });
});

describe('ensureContinuumExcluded', () => {
  test('adds .continuum/ to .git/info/exclude, idempotently', () => {
    const r = track(makeTempRepo());
    ensureContinuumExcluded(r);
    const exclude = path.join(r, '.git', 'info', 'exclude');
    const first = readFileSync(exclude, 'utf8');
    expect(first).toMatch(/^\.continuum\/$/m);
    ensureContinuumExcluded(r); // second call must not duplicate
    expect(readFileSync(exclude, 'utf8')).toBe(first);
    // git actually ignores it now
    mkdirSync(path.join(r, '.continuum'), { recursive: true });
    writeFileSync(path.join(r, '.continuum', 'STATE.md'), '# memory');
    writeFileSync(path.join(r, 'tracked.txt'), 'x'); // control: git still sees real files
    const status = git(r, 'status', '--porcelain');
    expect(status).toContain('tracked.txt');
    expect(status).not.toContain('.continuum');
  });

  test('covers session worktrees via the shared common git dir', () => {
    const r = track(makeTempRepo());
    const wt = track(path.join(makeTempDir(), 'wt'));
    git(r, 'worktree', 'add', '-q', '-b', 'mochi/test', wt);
    ensureContinuumExcluded(wt); // called with the WORKTREE path
    // …but the exclude lands in the main repo's common dir, covering both.
    expect(readFileSync(path.join(r, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\.continuum\/$/m);
  });

  test('no-op (no throw) outside a git repo', () => {
    const d = track(makeTempDir());
    expect(() => ensureContinuumExcluded(d)).not.toThrow();
  });
});

describe('provisionGitHubRemote', () => {
  test('guards: missing folder / missing token', async () => {
    expect((await provisionGitHubRemote({ dir: '/nope/nothing-here', name: 'x', token: 't' })).ok).toBe(false);
    const d = track(makeTempDir());
    const res = await provisionGitHubRemote({ dir: d, name: 'x', token: '' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/GitHub/i);
  });

  test('leaves a non-GitHub origin untouched', async () => {
    const r = track(makeTempRepo());
    git(r, 'remote', 'add', 'origin', 'https://gitlab.com/acme/thing.git');
    const res = await provisionGitHubRemote({ dir: r, name: 'thing', token: 't' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/non-GitHub/);
    expect(git(r, 'remote', 'get-url', 'origin')).toBe('https://gitlab.com/acme/thing.git');
  });

  test('full provisioning: init → exclude → initial commit → create (mock API) → origin + push', async () => {
    const d = track(makeTempDir());
    writeFileSync(path.join(d, 'hello.txt'), 'hi');
    const bare = track(makeBareRepo());
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return {
        ok: true, status: 201, headers: new Headers(),
        json: async () => ({ clone_url: bare, ssh_url: bare, full_name: 'me/my-app', private: true }),
      } as unknown as Response;
    }) as typeof fetch;

    const res = await provisionGitHubRemote({ dir: d, name: 'My App', token: 'tok', fetchImpl });
    expect(res).toMatchObject({ ok: true, created: true, fullName: 'me/my-app', pushed: true });
    // repo state on disk
    expect(git(d, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(d, 'remote', 'get-url', 'origin')).toBe(bare);
    expect(readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\.continuum\/$/m);
    // the commit made it to the "remote"
    expect(execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toHaveLength(40);
    // API contract: private repo named from the slug, personal account endpoint
    expect(calls[0].url).toContain('/user/repos');
    expect(calls[0].body).toMatchObject({ name: 'My-App', private: true });
  });

  test('retries with -2 suffix on a 422 name collision, and creates under an org', async () => {
    const d = track(makeTempDir());
    const bare = track(makeBareRepo());
    const names: string[] = []; const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
      names.push(body.name); urls.push(String(url));
      if (names.length === 1) {
        return { ok: false, status: 422, headers: new Headers(), json: async () => ({ message: 'name already exists' }) } as unknown as Response;
      }
      return { ok: true, status: 201, headers: new Headers(), json: async () => ({ clone_url: bare, ssh_url: bare, full_name: `acme/${body.name}`, private: true }) } as unknown as Response;
    }) as typeof fetch;

    const res = await provisionGitHubRemote({ dir: d, name: 'app', token: 'tok', owner: 'acme', fetchImpl });
    expect(res.ok).toBe(true);
    expect(names).toEqual(['app', 'app-2']);
    expect(urls[0]).toContain('/orgs/acme/repos');
    expect(res.fullName).toBe('acme/app-2');
  });

  test('idempotent: an existing GitHub origin is kept and just pushed', async () => {
    const r = track(makeTempRepo());
    git(r, 'remote', 'add', 'origin', 'https://github.com/me/already.git');
    const boom = (async () => { throw new Error('createRepo must not be called'); }) as typeof fetch;
    const res = await provisionGitHubRemote({ dir: r, name: 'already', token: 'tok', fetchImpl: boom });
    expect(res.ok).toBe(true);
    expect(res.created).toBe(false);
    expect(res.fullName).toBe('me/already');
    // push itself fails offline — that's fine, the call must not throw
  }, 30_000);
});
