/* GitHub REST client (PAT auth). Pure: depends only on `fetch` (injectable for
   tests), never on Electron. Callers read the token from the Keychain (providers)
   and pass it in — the token never lives in this module. */

import type { PrStatus, PrCheck } from './pr-state.js';

const DEFAULT_BASE = 'https://api.github.com';
type FetchImpl = typeof fetch;

export class GhError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GhError';
    this.status = status;
  }
}

export interface GhResult<T> {
  status: number;
  ok: boolean;
  data: T;
  etag: string | null;
  /** classic PAT scopes from `x-oauth-scopes`; null for fine-grained tokens. */
  scopes: string[] | null;
}

export interface GhRequestOpts {
  token: string;
  path: string;            // e.g. '/user' or '/repos/o/r/pulls'
  method?: string;
  body?: unknown;
  base?: string;           // GitHub Enterprise seam; default api.github.com
  etag?: string | null;    // conditional request (rate-limit friendly)
  fetchImpl?: FetchImpl;
}

/** One authenticated GitHub REST call. Throws GhError on non-2xx (except 304). */
export async function ghRequest<T = unknown>(opts: GhRequestOpts): Promise<GhResult<T>> {
  const f = opts.fetchImpl ?? fetch;
  // A malformed token (non-ASCII — e.g. a corrupted Keychain decrypt yielding
  // U+FFFD) would otherwise throw the opaque "Cannot convert argument to a
  // ByteString" deep inside fetch's header coercion, surfacing as a PR/clone
  // failure with no actionable cause. Reject it here with a clear message.
  if (!/^[\x20-\x7E]+$/.test(opts.token)) {
    throw new GhError('GitHub token is malformed — reconnect GitHub in Settings.', 401);
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'maestro',
  };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.etag) headers['if-none-match'] = opts.etag;

  const res = await f((opts.base ?? DEFAULT_BASE) + opts.path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const etag = res.headers.get('etag');
  const scopesHeader = res.headers.get('x-oauth-scopes');
  const scopes = scopesHeader === null ? null : scopesHeader.split(',').map(s => s.trim()).filter(Boolean);

  if (res.status === 304) return { status: 304, ok: true, data: undefined as T, etag, scopes };

  let data: T;
  try { data = await res.json() as T; } catch { data = undefined as T; }

  if (!res.ok) {
    const msg = (data as { message?: string } | undefined)?.message ?? `GitHub returned ${res.status}`;
    throw new GhError(msg, res.status);
  }
  return { status: res.status, ok: true, data, etag, scopes };
}

export interface Viewer { login: string; scopes: string[] | null; }

/** The authenticated user (login) + the token's scopes (null for fine-grained). */
export async function getViewer(token: string, fetchImpl?: FetchImpl): Promise<Viewer> {
  const r = await ghRequest<{ login: string }>({ token, path: '/user', fetchImpl });
  return { login: r.data?.login ?? '', scopes: r.scopes };
}

/** Parse a GitHub remote URL (ssh/https) → {owner, repo}. Null for non-GitHub. */
export function parseGitHubRemote(remote: string | null | undefined): { owner: string; repo: string } | null {
  if (!remote) return null;
  const s = remote.trim();
  // scp form: git@github.com:owner/repo(.git)
  let m = s.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  // url form: https://github.com/owner/repo(.git)(/) or ssh://git@github.com/owner/repo
  m = s.match(/^(?:https?|ssh):\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/* ── Repos + Pull Requests ────────────────────────────────────────────── */

export interface Repo { defaultBranch: string; allowSquash: boolean; allowMerge: boolean; allowRebase: boolean; permissionsPush: boolean; }

export async function getRepo(token: string, owner: string, repo: string, fetchImpl?: FetchImpl): Promise<Repo> {
  const r = await ghRequest<{ default_branch: string; allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean; permissions?: { push?: boolean } }>({ token, path: `/repos/${owner}/${repo}`, fetchImpl });
  return {
    defaultBranch: r.data.default_branch,
    allowSquash: r.data.allow_squash_merge !== false,
    allowMerge: r.data.allow_merge_commit !== false,
    allowRebase: r.data.allow_rebase_merge !== false,
    permissionsPush: !!r.data.permissions?.push,
  };
}

export interface OpenPr { number: number; url: string; title: string; headSha: string; }

/** The open PR whose head is `headBranch`, or null. */
export async function findOpenPr(token: string, owner: string, repo: string, headBranch: string, fetchImpl?: FetchImpl): Promise<OpenPr | null> {
  const r = await ghRequest<Array<{ number: number; html_url: string; title: string; head: { sha: string } }>>({ token, path: `/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(headBranch)}`, fetchImpl });
  const pr = r.data?.[0];
  return pr ? { number: pr.number, url: pr.html_url, title: pr.title, headSha: pr.head.sha } : null;
}

/** The MOST RECENT PR for `headBranch`, regardless of state (open / closed / merged).
 *  Used by `prState()` as a fallback when no open PR exists, so the UI can still
 *  show `pr-merged` (or `pr-closed`) and the right next-action hint after the PR
 *  has been squash-merged. GitHub's REST `state=all` + sort=updated DESC gives us
 *  that ordering — we take the first result. */
export async function findRecentPr(token: string, owner: string, repo: string, headBranch: string, fetchImpl?: FetchImpl): Promise<OpenPr | null> {
  const r = await ghRequest<Array<{ number: number; html_url: string; title: string; head: { sha: string } }>>({ token, path: `/repos/${owner}/${repo}/pulls?state=all&head=${owner}:${encodeURIComponent(headBranch)}&sort=updated&direction=desc&per_page=1`, fetchImpl });
  const pr = r.data?.[0];
  return pr ? { number: pr.number, url: pr.html_url, title: pr.title, headSha: pr.head.sha } : null;
}

function normalizeMergeableState(s: string): PrStatus['mergeableState'] {
  const known = ['clean', 'dirty', 'blocked', 'behind', 'unstable', 'draft', 'unknown'];
  return (known.includes(s) ? s : 'unknown') as PrStatus['mergeableState'];
}

async function getChecks(token: string, owner: string, repo: string, sha: string, fetchImpl?: FetchImpl): Promise<PrCheck[]> {
  try {
    const r = await ghRequest<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>({ token, path: `/repos/${owner}/${repo}/commits/${sha}/check-runs`, fetchImpl });
    return (r.data?.check_runs ?? []).map(c => ({
      name: c.name,
      status: c.status !== 'completed' ? 'pending' : c.conclusion === 'success' ? 'success' : 'failure',
    }));
  } catch {
    return [];
  }
}

/** Full status of PR #num: state, mergeability, and the check-run rollup. */
export async function getPullStatus(token: string, owner: string, repo: string, num: number, fetchImpl?: FetchImpl): Promise<PrStatus> {
  const r = await ghRequest<{ number: number; html_url: string; title: string; state: string; merged: boolean; mergeable: boolean | null; mergeable_state: string; head: { sha: string } }>({ token, path: `/repos/${owner}/${repo}/pulls/${num}`, fetchImpl });
  const d = r.data;
  const checks = await getChecks(token, owner, repo, d.head.sha, fetchImpl);
  return {
    number: d.number,
    url: d.html_url,
    title: d.title,
    state: d.merged ? 'merged' : d.state === 'closed' ? 'closed' : 'open',
    mergeable: d.mergeable,
    mergeableState: normalizeMergeableState(d.mergeable_state),
    checks,
  };
}

export async function createPull(token: string, owner: string, repo: string, args: { head: string; base: string; title: string; body?: string }, fetchImpl?: FetchImpl): Promise<{ number: number; url: string }> {
  const r = await ghRequest<{ number: number; html_url: string }>({ token, method: 'POST', path: `/repos/${owner}/${repo}/pulls`, body: { head: args.head, base: args.base, title: args.title, body: args.body ?? '' }, fetchImpl });
  return { number: r.data.number, url: r.data.html_url };
}

export async function mergePull(token: string, owner: string, repo: string, num: number, method: 'merge' | 'squash' | 'rebase', fetchImpl?: FetchImpl): Promise<{ merged: boolean; sha?: string }> {
  const r = await ghRequest<{ merged: boolean; sha?: string }>({ token, method: 'PUT', path: `/repos/${owner}/${repo}/pulls/${num}/merge`, body: { merge_method: method }, fetchImpl });
  return { merged: !!r.data.merged, sha: r.data.sha };
}

export async function createRepo(token: string, name: string, opts: { private?: boolean } = {}, fetchImpl?: FetchImpl): Promise<{ cloneUrl: string; sshUrl: string; fullName: string }> {
  const r = await ghRequest<{ clone_url: string; ssh_url: string; full_name: string }>({ token, method: 'POST', path: '/user/repos', body: { name, private: opts.private ?? true, auto_init: false }, fetchImpl });
  return { cloneUrl: r.data.clone_url, sshUrl: r.data.ssh_url, fullName: r.data.full_name };
}

/** Pick a merge method the repo actually allows (prefer squash → merge → rebase). */
export function pickMergeMethod(repo: { allowSquash: boolean; allowMerge: boolean; allowRebase: boolean }): 'squash' | 'merge' | 'rebase' {
  if (repo.allowSquash) return 'squash';
  if (repo.allowMerge) return 'merge';
  if (repo.allowRebase) return 'rebase';
  return 'merge';
}
