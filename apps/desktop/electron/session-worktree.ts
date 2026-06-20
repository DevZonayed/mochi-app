/* Per-session git worktree orchestration. Pure (git + fs only) so it unit-tests
   without Electron. The Electron caller (engine/dispatch) passes plain data and
   persists the resulting paths into the store. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { addWorktree, worktreeExists, removeWorktree, resolveBaseBranch, fetchOrigin, copyGlobsInto, isGitRepo } from './git.js';
import { resolveCopyGlobs } from './worktree-include.js';

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

/** Create-or-resolve this session's worktree. Idempotent and symlink-safe. */
export function ensureSessionWorktree(opts: EnsureWorktreeOpts): EnsureWorktreeResult {
  const wtPath = path.join(opts.worktreeRoot, opts.projectId, opts.sessionId);

  // Already registered → reuse it (no recreate). worktreeExists canonicalizes paths.
  if (existsSync(wtPath) && worktreeExists(opts.repoDir, wtPath)) {
    return { ok: true, cwd: wtPath, created: false, branch: opts.branch, base: opts.base ?? null };
  }

  if (!isGitRepo(opts.repoDir)) {
    return { ok: false, cwd: opts.repoDir, created: false, branch: opts.branch, base: null, reason: 'not a git repo' };
  }

  if (opts.fetch) fetchOrigin(opts.repoDir); // best-effort; offline is fine
  const base = opts.base ?? resolveBaseBranch(opts.repoDir);
  mkdirSync(path.dirname(wtPath), { recursive: true });

  const add = addWorktree(opts.repoDir, wtPath, opts.branch, base);
  if (!add.ok) {
    return { ok: false, cwd: opts.repoDir, created: false, branch: opts.branch, base, reason: add.reason };
  }
  // Files to copy: a committed `.worktreeinclude` wins, else project copyGlobs, else .env*.
  const globs = resolveCopyGlobs({ worktreeIncludeText: readWorktreeInclude(opts.repoDir), projectGlobs: opts.copyGlobs });
  if (globs.length) copyGlobsInto(opts.repoDir, wtPath, globs);
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
