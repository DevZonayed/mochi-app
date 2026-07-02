import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { bootstrapNewProject, bootstrapProject, seedProjectFiles, type FsLike, type GitLike } from './project-bootstrap.js';
import type { GitRunner as MemoryGitRunner } from './memory-repo.js';
import { mkdirSync, rmSync, lstatSync, readlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A FsLike that records writes + tracks "what exists" in a Map. */
function makeFs(seeded: Record<string, string> = {}): FsLike & { files: Map<string, string>; mkdirs: string[] } {
  const files = new Map<string, string>(Object.entries(seeded));
  const mkdirs: string[] = [];
  return {
    files, mkdirs,
    exists: (p: string) => files.has(p) || mkdirs.includes(p),
    mkdirp: (p: string) => { if (!mkdirs.includes(p)) mkdirs.push(p); },
    writeFileIfMissing: (p: string, text: string) => {
      if (files.has(p)) return false;
      files.set(p, text);
      return true;
    },
  };
}

/** A GitLike that records every method call. `hasCommits` returns false until
    `commit()` has been called for that dir; `init()` flips `hasRepo` to true. */
function makeGit(seed?: { hasRepo?: boolean; remote?: string | null }): GitLike & { calls: string[]; remotes: Map<string, string> } {
  const calls: string[] = [];
  const remotes = new Map<string, string>();
  let repoFlag = !!seed?.hasRepo;
  let commits = false;
  if (seed?.remote) remotes.set('origin', seed.remote);
  return {
    calls, remotes,
    init: (dir) => { calls.push(`init:${dir}`); repoFlag = true; },
    hasRepo: () => repoFlag,
    getRemoteUrl: (_d, r = 'origin') => remotes.get(r) ?? null,
    addAll: (dir) => { calls.push(`addAll:${dir}`); },
    hasCommits: () => commits,
    commit: (dir, msg) => { calls.push(`commit:${dir}:${msg}`); commits = true; },
    setRemote: (_dir, r, url) => { calls.push(`setRemote:${r}=${url}`); remotes.set(r, url); },
    currentBranch: () => 'main',
    push: (_d, remote, branch) => { calls.push(`push:${remote}/${branch}`); },
  };
}

/** Per-URL fetch routing — same pattern as github.test.ts. */
function routedFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const r = routes[path] ?? { status: 404, body: { message: 'no route' } };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: () => null },
      json: async () => r.body ?? {},
    };
  }) as unknown as typeof fetch;
}

const fixedNow = () => new Date('2026-06-23T10:00:00Z');

describe('seedProjectFiles', () => {
  test('writes README + .gitignore + .continuum/STATE.md + .claude/settings.json', () => {
    const fs = makeFs();
    const written = seedProjectFiles('/proj', 'My App', fs, new Date('2026-06-23T10:00:00Z'));
    expect(written.sort()).toEqual(['.claude/settings.json', '.continuum/STATE.md', '.gitignore', 'README.md']);
    expect(fs.files.get('/proj/README.md')).toContain('# My App');
    expect(fs.files.get('/proj/README.md')).toContain('Created 2026-06-23 with Maestro.');
    expect(fs.files.get('/proj/.gitignore')).toContain('node_modules/');
    expect(fs.files.get('/proj/.gitignore')).toContain('.env');
    expect(fs.files.get('/proj/.continuum/STATE.md')).toContain('# My App');
    expect(fs.files.get('/proj/.continuum/STATE.md')).toContain('No decisions recorded yet');
    expect(fs.files.get('/proj/.claude/settings.json')).toBe('{}\n');
  });

  test('idempotent: re-seeding a folder that has a README leaves it alone', () => {
    const fs = makeFs({ '/proj/README.md': '# pre-existing\n' });
    const written = seedProjectFiles('/proj', 'My App', fs, fixedNow());
    expect(written).not.toContain('README.md');
    expect(fs.files.get('/proj/README.md')).toBe('# pre-existing\n');
  });
});

describe('bootstrapNewProject', () => {
  test('happy path: slugifies, finds it free, creates repo, commits, pushes', async () => {
    const fs = makeFs();
    const git = makeGit();
    const routes: Record<string, { status: number; body?: unknown }> = {
      '/user': { status: 200, body: { login: 'octo' } },
      '/repos/octo/my-app': { status: 404 },
      '/user/repos': { status: 201, body: { full_name: 'octo/my-app', name: 'my-app', owner: { login: 'octo' }, clone_url: 'https://github.com/octo/my-app.git', html_url: 'https://github.com/octo/my-app' } },
    };
    const r = await bootstrapNewProject('tok', { name: 'My App', localPath: '/proj' }, { fs, git, fetchImpl: routedFetch(routes), now: fixedNow });
    expect(r.slug).toBe('my-app');
    expect(r.slugChanged).toBe(false);
    expect(r.fullName).toBe('octo/my-app');
    expect(r.htmlUrl).toBe('https://github.com/octo/my-app');
    expect(r.branchPushed).toBe('main');
    // git side-effects, in order:
    expect(git.calls).toEqual([
      'init:/proj',
      'addAll:/proj',
      'commit:/proj:chore(repo): initial commit',
      'setRemote:origin=https://github.com/octo/my-app.git',
      'push:origin/main',
    ]);
    // wrote all four seed files
    expect([...fs.files.keys()].sort()).toEqual([
      '/proj/.claude/settings.json',
      '/proj/.continuum/STATE.md',
      '/proj/.gitignore',
      '/proj/README.md',
    ]);
  });

  test('falls back to -v2 when the base slug is taken, and slugChanged=true', async () => {
    const fs = makeFs();
    const git = makeGit();
    const routes: Record<string, { status: number; body?: unknown }> = {
      '/user': { status: 200, body: { login: 'octo' } },
      '/repos/octo/my-app': { status: 200, body: { full_name: 'octo/my-app', private: true } },
      '/repos/octo/my-app-v2': { status: 404 },
      '/repos/octo/my-app-v3': { status: 200, body: { full_name: 'octo/my-app-v3', private: false } },
      '/repos/octo/my-app-v4': { status: 200, body: { full_name: 'octo/my-app-v4', private: false } },
      '/repos/octo/my-app-v5': { status: 200, body: { full_name: 'octo/my-app-v5', private: false } },
      '/user/repos': { status: 201, body: { full_name: 'octo/my-app-v2', name: 'my-app-v2', owner: { login: 'octo' }, clone_url: 'https://github.com/octo/my-app-v2.git', html_url: 'https://github.com/octo/my-app-v2' } },
    };
    const r = await bootstrapNewProject('tok', { name: 'My App', localPath: '/proj' }, { fs, git, fetchImpl: routedFetch(routes), now: fixedNow });
    expect(r.slug).toBe('my-app-v2');
    expect(r.slugChanged).toBe(true);
    expect(r.fullName).toBe('octo/my-app-v2');
  });

  test('skipInit=true: doesn\'t re-init a folder that\'s already a repo', async () => {
    const fs = makeFs();
    const git = makeGit({ hasRepo: true });
    const routes: Record<string, { status: number; body?: unknown }> = {
      '/user': { status: 200, body: { login: 'octo' } },
      '/repos/octo/adopt': { status: 404 },
      '/user/repos': { status: 201, body: { full_name: 'octo/adopt', name: 'adopt', owner: { login: 'octo' }, clone_url: 'https://github.com/octo/adopt.git', html_url: 'https://github.com/octo/adopt' } },
    };
    await bootstrapNewProject('tok', { name: 'adopt', localPath: '/repo', skipInit: true }, { fs, git, fetchImpl: routedFetch(routes), now: fixedNow });
    expect(git.calls).not.toContain('init:/repo');
    expect(git.calls).toContain('setRemote:origin=https://github.com/octo/adopt.git');
    expect(git.calls).toContain('push:origin/main');
  });

  test('remoteOnly=true: doesn\'t touch the working tree, just creates the repo + push', async () => {
    const fs = makeFs();
    const git = makeGit({ hasRepo: true });
    const routes: Record<string, { status: number; body?: unknown }> = {
      '/user': { status: 200, body: { login: 'octo' } },
      '/repos/octo/existing': { status: 404 },
      '/user/repos': { status: 201, body: { full_name: 'octo/existing', name: 'existing', owner: { login: 'octo' }, clone_url: 'https://github.com/octo/existing.git', html_url: 'https://github.com/octo/existing' } },
    };
    await bootstrapNewProject('tok', { name: 'existing', localPath: '/repo', remoteOnly: true }, { fs, git, fetchImpl: routedFetch(routes), now: fixedNow });
    expect(git.calls).not.toContain('addAll:/repo');
    expect(git.calls.filter(c => c.startsWith('commit:'))).toEqual([]);
    expect(fs.files.size).toBe(0);                              // no seed files written
    expect(git.calls).toContain('setRemote:origin=https://github.com/octo/existing.git');
    expect(git.calls).toContain('push:origin/main');
  });

  test('throws when name is empty', async () => {
    await expect(bootstrapNewProject('tok', { name: '   ', localPath: '/proj' }, { fs: makeFs(), git: makeGit(), fetchImpl: routedFetch({}) }))
      .rejects.toThrow(/name is required/i);
  });

  test('throws when GitHub token resolves to no login (auth went stale)', async () => {
    const routes: Record<string, { status: number; body?: unknown }> = {
      '/user': { status: 200, body: { login: '' } },
    };
    await expect(bootstrapNewProject('tok', { name: 'x', localPath: '/proj' }, { fs: makeFs(), git: makeGit(), fetchImpl: routedFetch(routes) }))
      .rejects.toThrow(/login/i);
  });
});

/* ── Dual-repo bootstrapProject (revised Track 2) ────────────────────────
   These tests use REAL fs for the localPath + userData (so linkMemoryIntoProject
   actually creates symlinks we can inspect), but the GitHub side stays fake
   (routed fetch) and the operator's git stays fake (spy GitLike). */

let scratch = '';
beforeEach(() => {
  scratch = path.join(tmpdir(), `maestro-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(scratch, { recursive: true });
});
afterEach(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* */ } });

/** A real-fs FsLike (because linkMemoryIntoProject uses real fs). */
function realFsLike(): FsLike {
  return {
    exists: (p: string) => existsSync(p),
    mkdirp: (p: string) => { mkdirSync(p, { recursive: true }); },
    writeFileIfMissing: (p: string, text: string) => {
      if (existsSync(p)) return false;
      mkdirSync(path.dirname(p), { recursive: true });
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(p, text, 'utf8');
      return true;
    },
  };
}

/** A spy MemoryGitRunner that simulates `clone` by creating a .git dir. */
function makeMemGit(): MemoryGitRunner & { calls: Array<{ dir: string; args: string[] }>; clones: Array<{ url: string; dest: string }> } {
  const calls: Array<{ dir: string; args: string[] }> = [];
  const clones: Array<{ url: string; dest: string }> = [];
  return {
    calls, clones,
    run: (dir, args) => { calls.push({ dir, args }); return ''; },
    clone: (url, dest) => { clones.push({ url, dest }); mkdirSync(path.join(dest, '.git'), { recursive: true }); },
  };
}

describe('bootstrapProject (dual-repo)', () => {
  test('happy path: creates BOTH repos, seeds memory, symlinks project, pushes', async () => {
    const projPath = path.join(scratch, 'proj');
    mkdirSync(projPath, { recursive: true });
    const fs = realFsLike();
    const git = makeGit();
    const memGit = makeMemGit();
    const routes: Record<string, { status: number; body?: unknown }> = {
      // slug-availability cascade (only the chosen name is probed, free first try)
      '/repos/octo/my-app': { status: 404 },
      // memory-repo discover + create
      '/repos/octo/my-app-memory': { status: 404 },
      '/user/repos': { status: 201, body: { clone_url: 'https://github.com/octo/my-app.git', html_url: 'https://github.com/octo/my-app', name: 'my-app', full_name: 'octo/my-app', owner: { login: 'octo' } } },
    };
    // Two endpoints reuse /user/repos with different bodies — route by call order.
    let userRepoCalls = 0;
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      if (p === '/user/repos' && init?.method === 'POST') {
        userRepoCalls++;
        // 1st POST: memory repo create (ensureMemoryRepo path)
        // 2nd POST: code repo create (createGitHubRepo)
        if (userRepoCalls === 1) {
          return { status: 201, ok: true, headers: { get: () => null }, json: async () => ({ clone_url: 'https://github.com/octo/my-app-memory.git', html_url: 'https://github.com/octo/my-app-memory' }) };
        }
        return { status: 201, ok: true, headers: { get: () => null }, json: async () => ({ clone_url: 'https://github.com/octo/my-app.git', html_url: 'https://github.com/octo/my-app', name: 'my-app', full_name: 'octo/my-app', owner: { login: 'octo' } }) };
      }
      const r = routes[p] ?? { status: 404, body: { message: 'no route' } };
      return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: () => null }, json: async () => r.body ?? {} };
    }) as unknown as typeof fetch;

    const r = await bootstrapProject('tok', {
      user: 'octo', owner: { login: 'octo', kind: 'user' }, name: 'My App', localPath: projPath, private: true,
    }, { fs, git, memoryGit: memGit, fetchImpl, userDataDir: scratch, now: fixedNow });

    expect(r.slug).toBe('my-app');
    expect(r.codeRepoUrl).toBe('https://github.com/octo/my-app');
    expect(r.memoryRepoUrl).toBe('https://github.com/octo/my-app-memory');
    expect(r.memoryPath).toBe(path.join(scratch, 'memory', 'my-app'));
    expect(r.branchPushed).toBe('main');
    // Memory clone was created by the spy GitRunner.
    expect(memGit.clones).toHaveLength(1);
    // The four symlinks landed in the project tree.
    expect(lstatSync(path.join(projPath, '.continuum')).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(projPath, '.claude', 'skills')).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(projPath, '.claude', 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(projPath, '.claude', 'settings.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(projPath, '.continuum'))).toBe(path.join(scratch, 'memory', 'my-app', 'continuum'));
    // The code-repo side: init + addAll + commit + setRemote + push.
    const callSummary = git.calls.join('\n');
    expect(callSummary).toContain('init:' + projPath);
    expect(callSummary).toContain('addAll:' + projPath);
    expect(callSummary).toContain('commit:' + projPath + ':chore(repo): initial commit');
    expect(callSummary).toContain('setRemote:origin=https://github.com/octo/my-app.git');
    expect(callSummary).toContain('push:origin/main');
  });

  test('owner.kind="org" → code repo POSTs /orgs/${login}/repos', async () => {
    const projPath = path.join(scratch, 'proj');
    mkdirSync(projPath, { recursive: true });
    const fs = realFsLike();
    const git = makeGit();
    const memGit = makeMemGit();
    const seenPaths: string[] = [];
    const fetchImpl = (async (url: string, init?: { method?: string }) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      seenPaths.push(`${init?.method ?? 'GET'} ${p}`);
      // /repos/acme/<slug>  → 404 (slug free)
      if (p === '/repos/acme/widget') return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) };
      // memory-repo discover (under user `octo`)
      if (p === '/repos/octo/widget-memory') return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) };
      // memory-repo create (POST /user/repos)
      if (p === '/user/repos' && init?.method === 'POST') {
        return { status: 201, ok: true, headers: { get: () => null }, json: async () => ({ clone_url: 'https://github.com/octo/widget-memory.git', html_url: 'https://github.com/octo/widget-memory' }) };
      }
      // code-repo create (POST /orgs/acme/repos)
      if (p === '/orgs/acme/repos' && init?.method === 'POST') {
        return { status: 201, ok: true, headers: { get: () => null }, json: async () => ({ clone_url: 'https://github.com/acme/widget.git', html_url: 'https://github.com/acme/widget', name: 'widget', full_name: 'acme/widget', owner: { login: 'acme' } }) };
      }
      return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({ message: 'no route' }) };
    }) as unknown as typeof fetch;

    const r = await bootstrapProject('tok', {
      user: 'octo', owner: { login: 'acme', kind: 'org' }, name: 'widget', localPath: projPath,
    }, { fs, git, memoryGit: memGit, fetchImpl, userDataDir: scratch, now: fixedNow });

    expect(r.slug).toBe('widget');
    expect(r.codeRepoUrl).toBe('https://github.com/acme/widget');
    expect(r.memoryRepoUrl).toBe('https://github.com/octo/widget-memory');
    expect(seenPaths.some(s => s.startsWith('POST /orgs/acme/repos'))).toBe(true);
    expect(seenPaths.some(s => s.startsWith('POST /user/repos'))).toBe(true);
  });

  test('throws on missing user (memory repo can not be created without it)', async () => {
    await expect(bootstrapProject('tok', {
      user: '', owner: { login: 'acme', kind: 'org' }, name: 'x', localPath: scratch,
    }, { fs: realFsLike(), git: makeGit(), memoryGit: makeMemGit(), fetchImpl: routedFetch({}), userDataDir: scratch }))
      .rejects.toThrow(/user/i);
  });

  test('throws on empty name (sanity)', async () => {
    await expect(bootstrapProject('tok', {
      user: 'octo', owner: { login: 'octo', kind: 'user' }, name: '   ', localPath: scratch,
    }, { fs: realFsLike(), git: makeGit(), memoryGit: makeMemGit(), fetchImpl: routedFetch({}), userDataDir: scratch }))
      .rejects.toThrow(/name/i);
  });
});
