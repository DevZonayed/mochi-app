import { describe, test, expect } from 'vitest';
import { ghRequest, getViewer, parseGitHubRemote } from './github.js';

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
