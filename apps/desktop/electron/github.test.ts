import { describe, test, expect } from 'vitest';
import { ghRequest, getViewer, parseGitHubRemote, getRepo, findOpenPr, getPullStatus, createPull, mergePull, pickMergeMethod } from './github.js';

/** A fake fetch that routes by URL substring (for multi-call functions). */
function routeFetch(routes: Array<{ match: string; status: number; body?: unknown; headers?: Record<string, string> }>): typeof fetch {
  return (async (url: string) => {
    const r = routes.find(x => String(url).includes(x.match)) ?? { status: 404, body: { message: 'no route' }, headers: undefined };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
}

/** A fake fetch returning a canned response. Header lookups are case-insensitive. */
function fakeFetch(spec: { status: number; body?: unknown; headers?: Record<string, string> }): typeof fetch {
  return (async () => ({
    status: spec.status,
    ok: spec.status >= 200 && spec.status < 300,
    headers: { get: (k: string) => spec.headers?.[k.toLowerCase()] ?? null },
    json: async () => spec.body,
  })) as unknown as typeof fetch;
}

describe('parseGitHubRemote', () => {
  test('https with .git', () => { expect(parseGitHubRemote('https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r' }); });
  test('scp/ssh form', () => { expect(parseGitHubRemote('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' }); });
  test('https no .git + trailing slash', () => { expect(parseGitHubRemote('https://github.com/o/r/')).toEqual({ owner: 'o', repo: 'r' }); });
  test('repo name with dots', () => { expect(parseGitHubRemote('git@github.com:o/my.repo.git')).toEqual({ owner: 'o', repo: 'my.repo' }); });
  test('non-github → null', () => { expect(parseGitHubRemote('https://gitlab.com/o/r.git')).toBeNull(); });
  test('empty → null', () => { expect(parseGitHubRemote('')).toBeNull(); });
});

describe('getViewer', () => {
  test('parses login + classic-PAT scopes from header', async () => {
    const f = fakeFetch({ status: 200, body: { login: 'octocat' }, headers: { 'x-oauth-scopes': 'repo, read:org' } });
    expect(await getViewer('tok', f)).toEqual({ login: 'octocat', scopes: ['repo', 'read:org'] });
  });
  test('fine-grained PAT (no scopes header) → scopes null', async () => {
    const f = fakeFetch({ status: 200, body: { login: 'octo' } });
    expect(await getViewer('tok', f)).toEqual({ login: 'octo', scopes: null });
  });
});

describe('ghRequest', () => {
  test('throws GhError carrying the API message on 4xx', async () => {
    const f = fakeFetch({ status: 403, body: { message: 'Resource not accessible by personal access token' } });
    await expect(ghRequest({ token: 't', path: '/x', fetchImpl: f })).rejects.toThrow('Resource not accessible by personal access token');
  });
  test('304 Not Modified returns ok with the etag and no throw', async () => {
    const f = fakeFetch({ status: 304, headers: { etag: 'W/"abc"' } });
    const r = await ghRequest({ token: 't', path: '/x', etag: 'W/"abc"', fetchImpl: f });
    expect(r.status).toBe(304);
    expect(r.etag).toBe('W/"abc"');
  });
});

describe('getRepo', () => {
  test('maps default branch, merge methods, and push permission', async () => {
    const f = routeFetch([{ match: '/repos/o/r', status: 200, body: { default_branch: 'main', allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, permissions: { push: true } } }]);
    expect(await getRepo('t', 'o', 'r', f)).toMatchObject({ defaultBranch: 'main', allowSquash: true, allowMerge: false, allowRebase: false, permissionsPush: true });
  });
});

describe('findOpenPr', () => {
  test('returns the first open PR for the head branch', async () => {
    const f = routeFetch([{ match: '/pulls?', status: 200, body: [{ number: 3, html_url: 'u', title: 't', head: { sha: 's' } }] }]);
    expect(await findOpenPr('t', 'o', 'r', 'feat', f)).toMatchObject({ number: 3, headSha: 's' });
  });
  test('returns null when none', async () => {
    const f = routeFetch([{ match: '/pulls?', status: 200, body: [] }]);
    expect(await findOpenPr('t', 'o', 'r', 'feat', f)).toBeNull();
  });
});

describe('getPullStatus', () => {
  test('maps state + mergeable_state + check rollup (two calls)', async () => {
    const f = routeFetch([
      { match: '/pulls/7', status: 200, body: { number: 7, html_url: 'u', title: 't', state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'abc' } } },
      { match: '/commits/abc/check-runs', status: 200, body: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'in_progress', conclusion: null }] } },
    ]);
    const s = await getPullStatus('t', 'o', 'r', 7, f);
    expect(s).toMatchObject({ number: 7, state: 'open', mergeableState: 'clean' });
    expect(s.checks).toEqual([{ name: 'ci', status: 'success' }, { name: 'lint', status: 'pending' }]);
  });
  test('merged flag wins over state', async () => {
    const f = routeFetch([
      { match: '/pulls/7', status: 200, body: { number: 7, html_url: 'u', title: 't', state: 'closed', merged: true, mergeable: null, mergeable_state: 'unknown', head: { sha: 'abc' } } },
      { match: '/check-runs', status: 200, body: { check_runs: [] } },
    ]);
    expect((await getPullStatus('t', 'o', 'r', 7, f)).state).toBe('merged');
  });
});

describe('createPull / mergePull', () => {
  test('createPull returns number + url', async () => {
    const f = routeFetch([{ match: '/pulls', status: 201, body: { number: 9, html_url: 'pr-url' } }]);
    expect(await createPull('t', 'o', 'r', { head: 'h', base: 'b', title: 'x' }, f)).toEqual({ number: 9, url: 'pr-url' });
  });
  test('mergePull returns merged + sha', async () => {
    const f = routeFetch([{ match: '/merge', status: 200, body: { merged: true, sha: 'deadbeef' } }]);
    expect(await mergePull('t', 'o', 'r', 9, 'squash', f)).toEqual({ merged: true, sha: 'deadbeef' });
  });
});

describe('pickMergeMethod', () => {
  test('prefers squash', () => { expect(pickMergeMethod({ allowSquash: true, allowMerge: true, allowRebase: true })).toBe('squash'); });
  test('falls to merge when squash disabled', () => { expect(pickMergeMethod({ allowSquash: false, allowMerge: true, allowRebase: true })).toBe('merge'); });
  test('falls to rebase when only rebase', () => { expect(pickMergeMethod({ allowSquash: false, allowMerge: false, allowRebase: true })).toBe('rebase'); });
});
