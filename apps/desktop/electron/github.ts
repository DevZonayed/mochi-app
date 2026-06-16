/* GitHub REST client (PAT auth). Pure: depends only on `fetch` (injectable for
   tests), never on Electron. Callers read the token from the Keychain (providers)
   and pass it in — the token never lives in this module. */

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
