/* Per-session git worktree orchestration. Pure (git + fs only) so it unit-tests
   without Electron. The Electron caller (engine/dispatch) passes plain data and
   persists the resulting paths into the store. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, lstatSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { addWorktree, worktreeExists, removeWorktree, resolveBaseBranch, fetchOrigin, copyGlobsInto, isGitRepo, localRefExists } from './git.js';
import { resolveCopyGlobs } from './worktree-include.js';
import { ensureContinuumExcluded } from './repo-provision.js';

/** Where all session worktrees live (app-managed, outside the repo). */
export function worktreeRootDir(): string {
  return path.join(homedir(), 'Maestro', 'worktrees');
}

export interface EnsureWorktreeOpts {
  repoDir: string;
  worktreeRoot: string;
  projectId: string;
  sessionId: string;
  branch: string;
  base?: string;
  copyGlobs?: string[];
  setupScript?: string;
  fetch?: boolean;
  /** Per-session env (MOCHI_PORT, MOCHI_WORKSPACE_PATH, …) exposed to the setup script. */
  env?: Record<string, string>;
  /** Injectable for tests; default runs the script in a login shell in the worktree. */
  runSetup?: (cwd: string, script: string, env?: Record<string, string>) => void;
}

export interface EnsureWorktreeResult {
  ok: boolean;
  cwd: string;
  created: boolean;
  branch: string;
  base: string | null;
  reason?: string;
}

function defaultRunSetup(cwd: string, script: string, env?: Record<string, string>): void {
  spawnSync('/bin/zsh', ['-lc', script], { cwd, stdio: 'ignore', timeout: 10 * 60 * 1000, env: { ...process.env, ...env } });
}

/** Best-effort read of a committed `.worktreeinclude` from the repo root. */
function readWorktreeInclude(repoDir: string): string | null {
  try { return readFileSync(path.join(repoDir, '.worktreeinclude'), 'utf8'); } catch { return null; }
}

/** Share project memory across sessions: the worktree's `.continuum` becomes a
    SYMLINK to the main checkout's `.continuum`. Without this every session's
    checkpoints/STATE.md land in its own worktree copy — fragmenting memory and
    leaving the project-root `.continuum` (the one MemorySync mirrors to GitHub)
    stale. `.continuum/` is git-excluded via `.git/info/exclude` (shared with
    worktrees through the common git dir), so the symlink is invisible to git.
    A pre-existing REAL directory is left untouched (never destroy memory). */
export function ensureContinuumLink(repoDir: string, wtPath: string): void {
  try {
    const link = path.join(wtPath, '.continuum');
    try { lstatSync(link); return; } catch { /* absent → create the link */ }
    const target = path.join(repoDir, '.continuum');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, 'dir');
  } catch { /* best-effort — a worktree without the link still works, just unshared */ }
}

/** Create-or-resolve this session's worktree. Idempotent and symlink-safe. */
export function ensureSessionWorktree(opts: EnsureWorktreeOpts): EnsureWorktreeResult {
  const wtPath = path.join(opts.worktreeRoot, opts.projectId, opts.sessionId);

  // Keep `.continuum/` git-invisible for the repo AND all its worktrees (the
  // exclude file lives in the common git dir) — an agent `git add -A` in the
  // worktree must never stage the memory symlink.
  ensureContinuumExcluded(opts.repoDir);

  // Already registered → reuse it (no recreate). worktreeExists canonicalizes paths.
  if (existsSync(wtPath) && worktreeExists(opts.repoDir, wtPath)) {
    ensureContinuumLink(opts.repoDir, wtPath); // backfill for pre-existing worktrees
    return { ok: true, cwd: wtPath, created: false, branch: opts.branch, base: opts.base ?? null };
  }

  if (!isGitRepo(opts.repoDir)) {
    return { ok: false, cwd: opts.repoDir, created: false, branch: opts.branch, base: null, reason: 'not a git repo' };
  }

  if (opts.fetch) fetchOrigin(opts.repoDir); // best-effort; offline is fine
  const base = opts.base ?? resolveBaseBranch(opts.repoDir);
  mkdirSync(path.dirname(wtPath), { recursive: true });

  // Fork from the REMOTE base (origin/<base>) when it exists — the local base
  // branch can be arbitrarily backdated (the operator rarely pulls the main
  // checkout), and `fetchOrigin` above updates origin/* refs, NOT local ones.
  // `base` stays the short name for callers/persistence (session.baseBranch);
  // only the worktree start point is remote-qualified.
  const startPoint = base.startsWith('origin/')
    ? base
    : (localRefExists(opts.repoDir, `origin/${base}`) ? `origin/${base}` : base);
  const add = addWorktree(opts.repoDir, wtPath, opts.branch, startPoint);
  if (!add.ok) {
    return { ok: false, cwd: opts.repoDir, created: false, branch: opts.branch, base, reason: add.reason };
  }
  // Files to copy: a committed `.worktreeinclude` wins, else project copyGlobs, else .env*.
  const globs = resolveCopyGlobs({ worktreeIncludeText: readWorktreeInclude(opts.repoDir), projectGlobs: opts.copyGlobs });
  if (globs.length) copyGlobsInto(opts.repoDir, wtPath, globs);
  ensureContinuumLink(opts.repoDir, wtPath);
  if (opts.setupScript && opts.setupScript.trim()) (opts.runSetup ?? defaultRunSetup)(wtPath, opts.setupScript, opts.env);

  return { ok: true, cwd: wtPath, created: true, branch: opts.branch, base };
}

/** Remove a session's worktree (and optionally its branch). */
export function pruneSessionWorktree(opts: {
  repoDir: string; worktreeRoot: string; projectId: string; sessionId: string;
  branch?: string; deleteBranch?: boolean;
}): { ok: boolean; reason?: string } {
  const wtPath = path.join(opts.worktreeRoot, opts.projectId, opts.sessionId);
  return removeWorktree(opts.repoDir, wtPath, { deleteBranch: opts.deleteBranch ? opts.branch : undefined });
}
