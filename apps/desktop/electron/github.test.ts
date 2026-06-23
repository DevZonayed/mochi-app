import { describe, test, expect } from 'vitest';
import { ghRequest, getViewer, parseGitHubRemote, getRepo, findOpenPr, findRecentPr, getPullStatus, createPull, mergePull, pickMergeMethod, listOwners } from './github.js';

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

describe('findRecentPr', () => {
  // After a squash-merge, the PR is "closed" + "merged" → state=open filter
  // returns nothing. findRecentPr uses state=all so the merged PR still
  // surfaces, which is what drives the `pr-merged` state in the UI instead
  // of the bug-y `ready-for-pr` fallback (see prState in git-service.ts).
  test('returns the most recently updated PR regardless of state', async () => {
    const f = routeFetch([{ match: '/pulls?', status: 200, body: [{ number: 45, html_url: 'u', title: 't', head: { sha: 'sha-after-squash' } }] }]);
    const got = await findRecentPr('t', 'o', 'r', 'feat', f);
    expect(got).toMatchObject({ number: 45, headSha: 'sha-after-squash' });
  });
  test('queries state=all + sort=updated DESC + per_page=1', async () => {
    // Verifying the exact GitHub query — important because getting any of
    // these wrong produces silent wrong behaviour (e.g. sort=created would
    // miss a merge of an older PR).
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(String(url));
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => [] };
    }) as unknown as typeof fetch;
    await findRecentPr('t', 'o', 'r', 'feat', f);
    expect(seen[0]).toContain('state=all');
    expect(seen[0]).toContain('sort=updated');
    expect(seen[0]).toContain('direction=desc');
    expect(seen[0]).toContain('per_page=1');
    expect(seen[0]).toContain('head=o:feat'); // owner:branch separator is a literal `:`
  });
  test('returns null when the branch has never had a PR', async () => {
    const f = routeFetch([{ match: '/pulls?', status: 200, body: [] }]);
    expect(await findRecentPr('t', 'o', 'r', 'feat', f)).toBeNull();
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

describe('listOwners', () => {
  // The picker MUST always have the user as the first row (they're the only
  // safe default for someone with no org membership). Orgs come second,
  // alphabetised — verifying both, since "first available org" would be a
  // confusing default and hurt operator trust.
  test('returns the user first, then orgs alphabetically', async () => {
    const f = routeFetch([
      { match: '/user/orgs', status: 200, body: [
        { login: 'zeta-corp', avatar_url: 'z.png' },
        { login: 'acme', avatar_url: 'a.png' },
        { login: 'maple', avatar_url: null },
      ] },
      { match: '/user', status: 200, body: { login: 'octocat', avatar_url: 'me.png' } },
    ]);
    const got = await listOwners('tok', f);
    expect(got).toEqual([
      { login: 'octocat', kind: 'user', avatarUrl: 'me.png' },
      { login: 'acme', kind: 'org', avatarUrl: 'a.png' },
      { login: 'maple', kind: 'org', avatarUrl: null },
      { login: 'zeta-corp', kind: 'org', avatarUrl: 'z.png' },
    ]);
  });
  // A user with no orgs still gets a valid one-row list — exercising the path
  // where /user/orgs returns []. (Important on a fresh GitHub account.)
  test('user with no orgs → single-row list', async () => {
    const f = routeFetch([
      { match: '/user/orgs', status: 200, body: [] },
      { match: '/user', status: 200, body: { login: 'solo', avatar_url: null } },
    ]);
    expect(await listOwners('tok', f)).toEqual([{ login: 'solo', kind: 'user', avatarUrl: null }]);
  });
  // Token whose org-read scope was revoked must STILL surface the user (the
  // picker can't render at all without at least one option). The org call
  // 403s; allSettled prevents that from killing the user row.
  test('orgs call fails → user is still returned (no orgs)', async () => {
    const f = routeFetch([
      { match: '/user/orgs', status: 403, body: { message: 'not allowed' } },
      { match: '/user', status: 200, body: { login: 'octo', avatar_url: null } },
    ]);
    expect(await listOwners('tok', f)).toEqual([{ login: 'octo', kind: 'user', avatarUrl: null }]);
  });
  // The flipside: no user means the token is stale. Throw rather than fake
  // an owner list — every downstream caller assumes the first row is a real
  // login they can push to.
  test('user call fails → throws (token bad)', async () => {
    const f = routeFetch([
      { match: '/user/orgs', status: 200, body: [] },
      { match: '/user', status: 401, body: { message: 'bad creds' } },
    ]);
    await expect(listOwners('tok', f)).rejects.toThrow(/login/i);
  });
});

describe('pickMergeMethod', () => {
  test('prefers squash', () => { expect(pickMergeMethod({ allowSquash: true, allowMerge: true, allowRebase: true })).toBe('squash'); });
  test('falls to merge when squash disabled', () => { expect(pickMergeMethod({ allowSquash: false, allowMerge: true, allowRebase: true })).toBe('merge'); });
  test('falls to rebase when only rebase', () => { expect(pickMergeMethod({ allowSquash: false, allowMerge: false, allowRebase: true })).toBe('rebase'); });
});
