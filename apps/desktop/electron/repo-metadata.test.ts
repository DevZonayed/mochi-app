/* repo-metadata.test — exercises the IPC-backing helper with a MOCKED gh
   runner so the test is fully offline and the failure modes our UI relies
   on (404, 401, network) reliably map to the expected error messages. */

import { describe, it, expect } from 'vitest';
import { fetchRepoMetadata, type GhRunner } from './repo-metadata.js';

function okRunner(payload: unknown): GhRunner {
  return async () => JSON.stringify(payload);
}

function failingRunner(stderr: string, code = 1): GhRunner {
  return async () => {
    const err = Object.assign(new Error('gh failed'), { stderr, code });
    throw err;
  };
}

describe('fetchRepoMetadata', () => {
  it('parses a full gh repo view payload', async () => {
    const meta = await fetchRepoMetadata('DevZonayed', 'mochi-app', okRunner({
      name: 'mochi-app',
      owner: { login: 'DevZonayed' },
      description: 'The Mac is the brain.',
      defaultBranchRef: { name: 'master' },
      isPrivate: false,
      nameWithOwner: 'DevZonayed/mochi-app',
    }));
    expect(meta).toEqual({
      name: 'mochi-app',
      fullName: 'DevZonayed/mochi-app',
      description: 'The Mac is the brain.',
      defaultBranch: 'master',
      isPrivate: false,
      htmlUrl: 'https://github.com/DevZonayed/mochi-app',
      sshUrl: 'git@github.com:DevZonayed/mochi-app.git',
    });
  });

  it('defaults missing description to empty string', async () => {
    const meta = await fetchRepoMetadata('a', 'b', okRunner({
      name: 'b', owner: { login: 'a' }, defaultBranchRef: { name: 'main' }, isPrivate: false,
    }));
    expect(meta.description).toBe('');
  });

  it('flags private repos', async () => {
    const meta = await fetchRepoMetadata('a', 'b', okRunner({
      name: 'b', owner: { login: 'a' }, defaultBranchRef: { name: 'main' }, isPrivate: true,
    }));
    expect(meta.isPrivate).toBe(true);
  });

  it('falls back to the requested owner/repo when gh returns thin data', async () => {
    const meta = await fetchRepoMetadata('fallback-owner', 'fallback-repo', okRunner({}));
    expect(meta.fullName).toBe('fallback-owner/fallback-repo');
    expect(meta.defaultBranch).toBe('main');
  });

  it('maps gh 404 to a "repository not found" message', async () => {
    await expect(fetchRepoMetadata('ghost', 'nope', failingRunner('HTTP 404: Not Found'))).rejects.toMatchObject({
      message: expect.stringContaining('Repository not found'),
      statusCode: 404,
    });
  });

  it('maps gh auth errors to an actionable sign-in message', async () => {
    await expect(fetchRepoMetadata('a', 'b', failingRunner('HTTP 401: Bad credentials'))).rejects.toMatchObject({
      message: expect.stringContaining('GitHub authentication needed'),
      statusCode: 401,
    });
  });

  it('maps network errors to a network message', async () => {
    await expect(fetchRepoMetadata('a', 'b', failingRunner('could not resolve host: github.com'))).rejects.toMatchObject({
      message: expect.stringContaining('Network error'),
      statusCode: 503,
    });
  });

  it('rejects empty owner/repo before calling gh', async () => {
    let called = false;
    const runner: GhRunner = async () => { called = true; return ''; };
    await expect(fetchRepoMetadata('', 'repo', runner)).rejects.toMatchObject({ statusCode: 400 });
    await expect(fetchRepoMetadata('owner', '', runner)).rejects.toMatchObject({ statusCode: 400 });
    expect(called).toBe(false);
  });

  it('rejects malformed gh JSON with a 502', async () => {
    const runner: GhRunner = async () => 'not json at all';
    await expect(fetchRepoMetadata('a', 'b', runner)).rejects.toMatchObject({ statusCode: 502 });
  });
});
