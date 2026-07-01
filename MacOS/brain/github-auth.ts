/* GitHub auth helpers: import a token from the `gh` CLI, and compute live
   connection status (login + scopes + repo-scope capability) from a token. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getViewer } from './github.js';

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

/** A token from an already-authenticated `gh` CLI, or null if gh is absent/logged out. */
export function ghCliToken(): string | null {
  try {
    const out = execFileSync('/bin/zsh', ['-lc', 'gh auth token'], { encoding: 'utf8', timeout: 8000 }).trim();
    return out.length > 20 ? out : null;
  } catch {
    return null;
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

export interface GithubConnection {
  connected: boolean;
  login: string | null;
  scopes: string[] | null;
  /** classic PAT must include `repo`; fine-grained (scopes null) is assumed capable. */
  hasRepoScope: boolean;
}

/** Validate a token live and report identity + whether it can manage repos. */
export async function githubConnectionStatus(token: string | undefined, fetchImpl?: FetchImpl): Promise<GithubConnection> {
  if (!token) return { connected: false, login: null, scopes: null, hasRepoScope: false };
  try {
    const v = await getViewer(token, fetchImpl);
    const hasRepoScope = v.scopes === null ? true : v.scopes.includes('repo');
    return { connected: true, login: v.login, scopes: v.scopes, hasRepoScope };
  } catch {
    return { connected: false, login: null, scopes: null, hasRepoScope: false };
  }
}
