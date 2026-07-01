import { describe, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubConnectionStatus, ghLoggedIn } from './github-auth.js';

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
  test('401 stays disconnected even when gh is logged in on disk', async () => {
    const f = fakeFetch({ status: 401, body: { message: 'Bad credentials' } });
    expect(await githubConnectionStatus('t', f, () => true)).toMatchObject({ connected: false });
  });
  test('network error but gh logged in → stays connected (matches Settings)', async () => {
    const f = (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    expect(await githubConnectionStatus('t', f, () => true)).toMatchObject({ connected: true, hasRepoScope: true });
  });
  test('network error and gh not logged in → disconnected', async () => {
    const f = (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    expect(await githubConnectionStatus('t', f, () => false)).toMatchObject({ connected: false });
  });
  test('5xx but gh logged in → stays connected', async () => {
    const f = fakeFetch({ status: 503, body: { message: 'Service unavailable' } });
    expect(await githubConnectionStatus('t', f, () => true)).toMatchObject({ connected: true });
  });
});

describe('ghLoggedIn', () => {
  test('missing hosts.yml → false', () => {
    expect(ghLoggedIn('/this/path/does/not/exist/hosts.yml')).toBe(false);
  });
  test('hosts.yml without a github.com block → false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-auth-test-'));
    const p = join(dir, 'hosts.yml');
    try {
      writeFileSync(p, '# empty\n');
      expect(ghLoggedIn(p)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('hosts.yml with github.com block → true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-auth-test-'));
    const p = join(dir, 'hosts.yml');
    try {
      writeFileSync(p, 'github.com:\n  user: octo\n  oauth_token: gho_xxx\n');
      expect(ghLoggedIn(p)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
