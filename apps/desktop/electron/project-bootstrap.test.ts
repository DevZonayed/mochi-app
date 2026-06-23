import { describe, test, expect } from 'vitest';
import { bootstrapNewProject, seedProjectFiles, type FsLike, type GitLike } from './project-bootstrap.js';

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
