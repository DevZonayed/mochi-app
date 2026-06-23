/* Repo-open lifecycle helpers: align a project's local git config to the
 * GitHub-logged-in user and point `core.hooksPath` at the repo-tracked
 * `.githooks/` directory so the trailer-stripping `prepare-commit-msg` runs.
 *
 * Both helpers are idempotent and side-effect-light: they each run a couple of
 * `git config` reads/writes and a single `gh api user` call (for identity).
 * They never throw — a repo that lacks `.git`, a missing `gh` CLI, or a
 * not-yet-logged-in user is simply a no-op so adopting a project never fails
 * because git/gh isn't set up the way we expect.
 *
 * Why this lives outside `git-service.ts`: GitService is the per-session PR
 * brain and carries state (cache, store, providers). These two helpers are
 * pure repo plumbing — they take a `repoDir` and return nothing — so keeping
 * them in their own module makes them trivial to unit-test (no Electron, no
 * store, no providers) and trivial to call from any lifecycle point
 * (clone, adopt, worktree-add).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveGit, isGitRepo } from './git.js';

/** Default user.name / user.email values we treat as "not set by the operator".
 *  Any of these → ensureCommitIdentity will overwrite them. Anything else (a
 *  real human's git config) is left alone. */
const HARNESS_DEFAULTS = new Set<string>([
  'Maestro',
  'maestro@local',
  'root',
  'unknown',
  '',
]);

/** Read a single git config value at the repo level, or null. */
function readConfig(git: string, repoDir: string, key: string): string | null {
  try {
    const out = execFileSync(git, ['-C', repoDir, 'config', '--local', '--get', key], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null; // missing key → git exits non-zero, we report null
  }
}

/** Set a single repo-local git config value. Best-effort, returns ok. */
function writeConfig(git: string, repoDir: string, key: string, value: string): boolean {
  try {
    execFileSync(git, ['-C', repoDir, 'config', '--local', key, value], {
      timeout: 5000, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Point `core.hooksPath` at the repo-tracked `.githooks/` directory exactly
 *  once per repo. Idempotent: re-runs are a no-op when the value is already
 *  `.githooks` (and the directory + the hook file exist). Silently no-ops on
 *  non-repos, missing git, or a hooks dir the operator hasn't committed yet. */
export async function ensureGitHooks(repoDir: string): Promise<void> {
  if (!repoDir || !existsSync(repoDir) || !isGitRepo(repoDir)) return;
  const git = resolveGit();
  if (!git) return;
  // Only opt in when the repo HAS the committed hooks dir — otherwise we'd
  // point git at a non-existent path and break every commit.
  if (!existsSync(path.join(repoDir, '.githooks'))) return;
  const current = readConfig(git, repoDir, 'core.hooksPath');
  if (current === '.githooks') return;
  writeConfig(git, repoDir, 'core.hooksPath', '.githooks');
}

/** What `gh api user` returns (subset we use). */
export interface GhUser { login: string; name: string | null; email: string | null }

/** Inject-for-tests: a function that returns the GitHub-logged-in user, or
 *  null when gh isn't installed / the user isn't signed in. The default
 *  implementation shells out to the system `gh` (mirrors `gh-cli.ts`'s
 *  `systemGh()` resolution). */
export type GhUserFetcher = () => Promise<GhUser | null>;

/** Build the email we'll set on commits. Prefer a real public email; else
 *  use GitHub's `<login>@users.noreply.github.com` (which still attributes
 *  commits to the user on github.com but doesn't leak their inbox). */
function commitEmailFor(user: GhUser): string {
  if (user.email && user.email.trim() && !user.email.endsWith('@users.noreply.github.com')) {
    return user.email.trim();
  }
  // GitHub's noreply form is `<id>+<login>@users.noreply.github.com` for
  // privacy-mode accounts; we don't have the numeric id here so we fall back
  // to the legacy `<login>@…` form, which github.com still accepts.
  return `${user.login}@users.noreply.github.com`;
}

/** Build the display name. Prefer the GitHub display name; fall back to login. */
function commitNameFor(user: GhUser): string {
  return user.name?.trim() || user.login;
}

/** Whether a value is "missing / harness default" — i.e. safe to overwrite
 *  without trampling on the operator's own git config. */
export function isHarnessDefault(value: string | null): boolean {
  if (value === null) return true;
  return HARNESS_DEFAULTS.has(value.trim());
}

/** Default `GhUserFetcher`: uses the system `gh` CLI via `gh api user`. We
 *  intentionally do NOT download `gh` here — repo-open shouldn't trigger a
 *  10 MB download. If `gh` isn't present, identity stays whatever the
 *  operator already has and we no-op. */
export const defaultGhUserFetcher: GhUserFetcher = async () => {
  try {
    const json = execFileSync('/bin/zsh', ['-lc', 'gh api user'], {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!json) return null;
    const u = JSON.parse(json) as { login?: string; name?: string | null; email?: string | null };
    if (!u.login) return null;
    return { login: u.login, name: u.name ?? null, email: u.email ?? null };
  } catch {
    return null;
  }
};

export interface EnsureIdentityOpts {
  /** Inject a fake `gh api user` response in tests. Default: shell out to gh. */
  fetchGhUser?: GhUserFetcher;
  /** Force overwrite even when a non-harness identity is set. Default: false. */
  force?: boolean;
}

export interface IdentityResult {
  /** false = no-op (no repo / no gh / identity already set by operator). */
  changed: boolean;
  /** Why it was a no-op or what got written. Useful in tests + logs. */
  reason: string;
  name?: string;
  email?: string;
}

/** Align a repo's local `user.name` / `user.email` with the GitHub-logged-in
 *  account (`gh api user`). Only writes when:
 *    - the repo currently has no identity set, OR
 *    - the identity matches a known harness default (`Maestro`, `root`, …)
 *  …unless `opts.force` is true. This guarantees we never overwrite the
 *  operator's deliberate `git config` choice on a real project of theirs.
 *
 *  Always resolves; never throws — repo-open must not fail because gh is logged
 *  out or git isn't installed. */
export async function ensureCommitIdentity(
  repoDir: string,
  opts: EnsureIdentityOpts = {},
): Promise<IdentityResult> {
  if (!repoDir || !existsSync(repoDir) || !isGitRepo(repoDir)) {
    return { changed: false, reason: 'not a git repo' };
  }
  const git = resolveGit();
  if (!git) return { changed: false, reason: 'git not installed' };

  const curName = readConfig(git, repoDir, 'user.name');
  const curEmail = readConfig(git, repoDir, 'user.email');

  // Respect a real, operator-set identity unless forced.
  if (!opts.force && !isHarnessDefault(curName) && !isHarnessDefault(curEmail)) {
    return { changed: false, reason: 'operator identity already set', name: curName ?? undefined, email: curEmail ?? undefined };
  }

  const fetcher = opts.fetchGhUser ?? defaultGhUserFetcher;
  const user = await fetcher();
  if (!user) return { changed: false, reason: 'gh user not available (not signed in?)' };

  const name = commitNameFor(user);
  const email = commitEmailFor(user);

  const wroteName = curName === name ? true : writeConfig(git, repoDir, 'user.name', name);
  const wroteEmail = curEmail === email ? true : writeConfig(git, repoDir, 'user.email', email);
  if (!wroteName || !wroteEmail) return { changed: false, reason: 'git config write failed' };

  const changed = curName !== name || curEmail !== email;
  return { changed, reason: changed ? 'updated to gh identity' : 'already aligned', name, email };
}
