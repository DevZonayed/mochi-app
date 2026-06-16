import { describe, test, expect } from 'vitest';
import { githubConnectionStatus } from './github-auth.js';

function fakeFetch(spec: { status: number; body?: unknown; headers?: Record<string, string> }): typeof fetch {
  return (async () => ({
    status: spec.status,
    ok: spec.status >= 200 && spec.status < 300,
    headers: { get: (k: string) => spec.headers?.[k.toLowerCase()] ?? null },
    json: async () => spec.body,
  })) as unknown as typeof fetch;
}

describe('githubConnectionStatus', () => {
  test('no token → disconnected', async () => {
    expect(await githubConnectionStatus(undefined)).toMatchObject({ connected: false, hasRepoScope: false });
  });
  test('valid token with repo scope', async () => {
    const f = fakeFetch({ status: 200, body: { login: 'octo' }, headers: { 'x-oauth-scopes': 'repo, gist' } });
    expect(await githubConnectionStatus('t', f)).toMatchObject({ connected: true, login: 'octo', hasRepoScope: true });
  });
  test('valid token missing repo scope', async () => {
    const f = fakeFetch({ status: 200, body: { login: 'octo' }, headers: { 'x-oauth-scopes': 'read:user' } });
    expect((await githubConnectionStatus('t', f)).hasRepoScope).toBe(false);
  });
  test('fine-grained PAT (no scopes header) → assumed capable', async () => {
    const f = fakeFetch({ status: 200, body: { login: 'octo' } });
    expect(await githubConnectionStatus('t', f)).toMatchObject({ connected: true, hasRepoScope: true, scopes: null });
  });
  test('401 → disconnected', async () => {
    const f = fakeFetch({ status: 401, body: { message: 'Bad credentials' } });
    expect(await githubConnectionStatus('t', f)).toMatchObject({ connected: false });
  });
});
