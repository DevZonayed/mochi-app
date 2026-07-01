/* GitHub auth helpers: import a token from the `gh` CLI, and compute live
   connection status (login + scopes + repo-scope capability) from a token. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getViewer, GhError } from './github.js';
import { resolveGh } from './gh-cli.js';

type FetchImpl = typeof fetch;

/** Cheap "is the gh CLI signed in?" check — file existence + a peek, no
    shell-out. `gh auth login` writes ~/.config/gh/hosts.yml the moment a
    sign-in succeeds, so this is the same source-of-truth as
    `claudeLoggedIn()` / `codexLoggedIn()` and avoids the 8-second
    `gh auth token` timeout on every Settings render. The yml peek
    (`github.com:` key) prevents a stale/empty file from reading as authed.
    `hostsPath` is injectable for tests. */
export function ghLoggedIn(hostsPath: string = join(homedir(), '.config', 'gh', 'hosts.yml')): boolean {
  try {
    if (!existsSync(hostsPath)) return false;
    const txt = readFileSync(hostsPath, 'utf8');
    return /^github\.com:/m.test(txt);
  } catch {
    return false;
  }
}

/** Read the token from a SPECIFIC `gh` binary (e.g. our managed download, which
    isn't on PATH). Used right after an in-app `gh auth login`. */
export function ghTokenFrom(ghPath: string): string | null {
  try {
    const out = execFileSync(ghPath, ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', timeout: 8000 }).trim();
    return out.length > 20 ? out : null;
  } catch {
    return null;
  }
}

/** A token from an already-authenticated `gh` CLI, or null if gh is absent/logged
    out. Resolves the SAME binary the in-app sign-in used (`resolveGh` = system
    install first, then our managed download) so the token stays readable even
    when `gh` isn't on the login-shell PATH — the exact condition that used to
    make the topbar report "GitHub not connected" while Settings (which reads
    `~/.config/gh/hosts.yml` directly) showed it connected. */
export function ghCliToken(): string | null {
  const gh = resolveGh();
  return gh ? ghTokenFrom(gh) : null;
}

export interface GithubConnection {
  connected: boolean;
  login: string | null;
  scopes: string[] | null;
  /** classic PAT must include `repo`; fine-grained (scopes null) is assumed capable. */
  hasRepoScope: boolean;
}

/** Validate a token live and report identity + whether it can manage repos.

    Offline-tolerant so the topbar and Settings agree on connection state:
    Settings computes "connected" from an offline `~/.config/gh/hosts.yml` check
    (`ghLoggedIn`), while this used to require a live GitHub round-trip. A
    transient network blip (or GitHub 5xx) would then flap the topbar to "GitHub
    not connected" while Settings stayed green. We now only report disconnected
    on a *genuine* auth failure (401/403) or when `gh` isn't logged in at all;
    any other error (network/5xx/timeout) falls back to the same on-disk signal
    Settings trusts. `cliLoggedIn` is injectable for tests. */
export async function githubConnectionStatus(
  token: string | undefined,
  fetchImpl?: FetchImpl,
  cliLoggedIn: () => boolean = ghLoggedIn,
): Promise<GithubConnection> {
  if (!token) return { connected: false, login: null, scopes: null, hasRepoScope: false };
  try {
    const v = await getViewer(token, fetchImpl);
    const hasRepoScope = v.scopes === null ? true : v.scopes.includes('repo');
    return { connected: true, login: v.login, scopes: v.scopes, hasRepoScope };
  } catch (e) {
    // A real auth failure (bad/revoked token) → disconnected so the user
    // re-authenticates. Anything else (no network, GitHub down) shouldn't
    // override the on-disk gh login that Settings already shows as connected.
    const httpStatus = e instanceof GhError ? e.status : 0;
    const authFailed = httpStatus === 401 || httpStatus === 403;
    if (!authFailed && cliLoggedIn()) {
      // Sign-in requests `repo,read:org,workflow`, so assume repo capability.
      return { connected: true, login: null, scopes: null, hasRepoScope: true };
    }
    return { connected: false, login: null, scopes: null, hasRepoScope: false };
  }
}
