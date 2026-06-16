/* GitHub auth helpers: import a token from the `gh` CLI, and compute live
   connection status (login + scopes + repo-scope capability) from a token. */

import { execFileSync } from 'node:child_process';
import { getViewer } from './github.js';

type FetchImpl = typeof fetch;

/** A token from an already-authenticated `gh` CLI, or null if gh is absent/logged out. */
export function ghCliToken(): string | null {
  try {
    const out = execFileSync('/bin/zsh', ['-lc', 'gh auth token'], { encoding: 'utf8', timeout: 8000 }).trim();
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
