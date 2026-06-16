/* Git operations — local to this Mac, on the operator's own `git` + credentials.
   Used by the coding agent: clone a GitHub repo into ~/Maestro/<name>, read a
   project folder's branch/remote, and tell whether a folder is a repo. Clone
   progress streams back so the UI can show it live. */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

let gitPath: string | null | undefined;
export function resolveGit(): string | null {
  if (gitPath !== undefined) return gitPath;
  try {
    gitPath = execFileSync('/bin/zsh', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim() || null;
  } catch {
    gitPath = null;
  }
  if (!gitPath) {
    for (const cand of ['/opt/homebrew/bin/git', '/usr/bin/git', '/usr/local/bin/git']) {
      if (existsSync(cand)) { gitPath = cand; break; }
    }
  }
  return gitPath ?? null;
}

export function gitAvailable(): boolean { return resolveGit() !== null; }

/** Commit a snapshot of a project folder so its design + attachments are
    referable by a short hash (the "commit shortcut"). Inits a git repo on first
    use; commits with a local Maestro identity so it works without global config. */
export function snapshotProject(dir: string, message: string): { ok: boolean; hash?: string; reason?: string } {
  const git = resolveGit();
  if (!git) return { ok: false, reason: 'git is not installed' };
  if (!dir || !existsSync(dir)) return { ok: false, reason: 'this project has no folder yet' };
  try {
    if (!isGitRepo(dir)) execFileSync(git, ['-C', dir, 'init', '-q'], { timeout: 10_000 });
    execFileSync(git, ['-C', dir, 'add', '-A'], { timeout: 30_000 });
    execFileSync(git, ['-C', dir, '-c', 'user.name=Maestro', '-c', 'user.email=maestro@local',
      'commit', '-q', '--allow-empty', '-m', (message || 'snapshot').slice(0, 200)], { timeout: 30_000 });
    const hash = execFileSync(git, ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 5_000 }).trim();
    return { ok: true, hash };
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : 'snapshot failed' }; }
}

export function isGitRepo(dir: string): boolean {
  try { return existsSync(path.join(dir, '.git')); } catch { return false; }
}

export interface RepoInfo { branch: string | null; remote: string | null; isRepo: boolean }

/** Best-effort branch + origin remote for a folder. Never throws. */
export function repoInfo(dir: string): RepoInfo {
  if (!dir || !existsSync(dir)) return { branch: null, remote: null, isRepo: false };
  const git = resolveGit();
  if (!git || !isGitRepo(dir)) return { branch: null, remote: null, isRepo: false };
  const run = (args: string[]): string | null => {
    try { return execFileSync(git, ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 }).trim() || null; }
    catch { return null; }
  };
  return { branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), remote: run(['remote', 'get-url', 'origin']), isRepo: true };
}

/** A git-safe branch slug from a chat title: lowercased, dashed, capped. */
export function branchSlug(title: string): string {
  const s = (title || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || 'chat';
}

/** Best-effort branch-per-chat (Conductor-style isolation). On a git repo, check
    out `branch`, creating it from HEAD if needed. Guarded: never clobbers an
    uncommitted working tree — if dirty and the target differs from the current
    branch, it leaves things as-is and reports why. Pure best-effort: any failure
    just means the chat runs on whatever branch is current. */
export function ensureBranch(dir: string, branch: string): { ok: boolean; branch: string | null; reason?: string } {
  const git = resolveGit();
  if (!git || !isGitRepo(dir)) return { ok: false, branch: null, reason: 'not a git repo' };
  const run = (args: string[]): { out: string; code: number } => {
    try { return { out: execFileSync(git, ['-C', dir, ...args], { encoding: 'utf8', timeout: 8000 }).trim(), code: 0 }; }
    catch (e) { return { out: '', code: (e as { status?: number }).status ?? 1 }; }
  };
  try {
    const cur = run(['rev-parse', '--abbrev-ref', 'HEAD']).out || null;
    if (cur === branch) return { ok: true, branch };
    const dirty = run(['status', '--porcelain']).out.length > 0;
    if (dirty) return { ok: false, branch: cur, reason: 'working tree has uncommitted changes' };
    const exists = run(['rev-parse', '--verify', '--quiet', branch]).code === 0;
    const co = exists ? run(['checkout', branch]) : run(['checkout', '-b', branch]);
    if (co.code !== 0) return { ok: false, branch: cur, reason: 'checkout failed' };
    return { ok: true, branch };
  } catch (e) { return { ok: false, branch: null, reason: (e as Error).message }; }
}

/** Derive a safe folder name from a clone URL (…/user/repo(.git) → repo). */
export function dirNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const last = cleaned.split(/[/:]/).pop() || 'repo';
  const safe = last.replace(/[^a-zA-Z0-9 _.-]/g, '').trim();
  return safe || 'repo';
}

/** A folder inside `parent` that doesn't collide (repo, repo-2, repo-3…). */
function uniqueDirIn(parent: string, base: string): string {
  mkdirSync(parent, { recursive: true });
  let candidate = path.join(parent, base);
  let n = 2;
  while (existsSync(candidate)) { candidate = path.join(parent, `${base}-${n}`); n++; }
  return candidate;
}

export interface CloneResult { dir: string; branch: string | null; remote: string; name: string }

/** Clone `url` into <dest>/<repo-name> (dest defaults to ~/Maestro). Streams
    progress via onProgress. Rejects with an actionable Error + cleans up partials. */
export function cloneRepo(
  args: { url: string; dirName?: string; dest?: string },
  onProgress?: (line: string) => void,
): Promise<CloneResult> {
  const git = resolveGit();
  if (!git) return Promise.reject(Object.assign(new Error('git is not installed on this Mac. Install Xcode Command Line Tools (`xcode-select --install`).'), { statusCode: 503 }));

  const url = (args.url || '').trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
    return Promise.reject(Object.assign(new Error('Enter a valid git URL (https://… or git@…).'), { statusCode: 400 }));
  }
  const repoName = (args.dirName && args.dirName.trim()) || dirNameFromUrl(url);
  const parent = args.dest && existsSync(args.dest) ? args.dest : path.join(homedir(), 'Maestro');
  const dir = uniqueDirIn(parent, repoName);

  return new Promise<CloneResult>((resolve, reject) => {
    const child = spawn(git, ['clone', '--progress', '--depth', '1', url, dir], {
      // Never let git block on a credential prompt — fail fast on private repos.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10 * 60 * 1000);
    child.stderr.on('data', (d: Buffer) => {
      const s = String(d);
      stderr = (stderr + s).slice(-4000);
      // git prints progress to stderr; surface the last meaningful line.
      for (const line of s.split(/[\r\n]+/)) { const t = line.trim(); if (t) onProgress?.(t); }
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      reject(Object.assign(new Error(`Could not start git: ${e.message}`), { statusCode: 500 }));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) {
        const info = repoInfo(dir);
        resolve({ dir, branch: info.branch, remote: info.remote ?? url, name: repoName });
        return;
      }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      const tail = stderr.toLowerCase();
      let msg = `git clone failed (exit ${code}).`;
      if (tail.includes('authentication') || tail.includes('could not read username') || tail.includes('terminal prompts disabled') || tail.includes('permission denied'))
        msg = 'Clone failed: this looks like a private repo. Authenticate git on this Mac (e.g. `gh auth login`) or use a public URL.';
      else if (tail.includes('not found') || tail.includes('repository') && tail.includes('does not exist'))
        msg = 'Clone failed: repository not found. Check the URL.';
      else if (tail.includes('could not resolve host') || tail.includes('network'))
        msg = 'Clone failed: network error. Check your connection.';
      else if (stderr.trim()) msg = `Clone failed: ${stderr.trim().split(/[\r\n]+/).pop()}`;
      reject(Object.assign(new Error(msg), { statusCode: 400 }));
    });
  });
}

/** Validate a hand-picked folder is usable as a project workspace. */
export function inspectFolder(dir: string): { ok: boolean; path: string; info: RepoInfo; error?: string } {
  if (!dir || !existsSync(dir)) return { ok: false, path: dir, info: { branch: null, remote: null, isRepo: false }, error: 'Folder not found.' };
  return { ok: true, path: dir, info: repoInfo(dir) };
}

/** Async branch/remote refresh (used by dispatch without blocking). */
export function repoInfoAsync(dir: string): Promise<RepoInfo> {
  return new Promise((resolve) => {
    const git = resolveGit();
    if (!git || !isGitRepo(dir)) { resolve({ branch: null, remote: null, isRepo: isGitRepo(dir) }); return; }
    execFile(git, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }, (_e, branchOut) => {
      execFile(git, ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 5000 }, (_e2, remoteOut) => {
        resolve({ branch: branchOut.trim() || null, remote: remoteOut.trim() || null, isRepo: true });
      });
    });
  });
}

/* ── Worktree primitives (Conductor-style per-session isolation) ─────── */

/** Run git, returning stdout (or stderr on failure) + the exit code. Never throws. */
function execGit(args: string[], opts: { timeout?: number } = {}): { ok: boolean; out: string; code: number } {
  const git = resolveGit();
  if (!git) return { ok: false, out: '', code: 127 };
  try {
    const out = execFileSync(git, args, { encoding: 'utf8', timeout: opts.timeout ?? 15_000 }).toString().trim();
    return { ok: true, out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    const stderr = err.stderr == null ? '' : typeof err.stderr === 'string' ? err.stderr : err.stderr.toString();
    return { ok: false, out: stderr.trim(), code: err.status ?? 1 };
  }
}

/** The branch new worktrees fork from: origin/HEAD → current branch → 'main'. */
export function resolveBaseBranch(repoDir: string): string {
  const head = execGit(['-C', repoDir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out) return head.out.replace(/^origin\//, '');
  const cur = execGit(['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (cur.ok && cur.out && cur.out !== 'HEAD') return cur.out;
  return 'main';
}

export interface WorktreeEntry { path: string; branch: string | null; head: string }

/** All registered worktrees of a repo (parsed from `worktree list --porcelain`). */
export function listWorktrees(repoDir: string): WorktreeEntry[] {
  const r = execGit(['-C', repoDir, 'worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  const flush = () => { if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? '' }); };
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) { flush(); cur = { path: line.slice('worktree '.length) }; }
    else if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.branch = null;
  }
  flush();
  return out;
}

/** Add a worktree for `branch` (created from `base` if it doesn't exist yet). */
export function addWorktree(repoDir: string, wtPath: string, branch: string, base: string): { ok: boolean; path: string; reason?: string } {
  const branchExists = execGit(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
  const args = branchExists
    ? ['-C', repoDir, 'worktree', 'add', wtPath, branch]
    : ['-C', repoDir, 'worktree', 'add', '-b', branch, wtPath, base];
  const r = execGit(args, { timeout: 60_000 });
  return r.ok ? { ok: true, path: wtPath } : { ok: false, path: wtPath, reason: r.out.slice(0, 300) };
}

/** Remove a worktree (force) + prune stale admin dirs; optionally delete its branch. */
export function removeWorktree(repoDir: string, wtPath: string, opts: { deleteBranch?: string } = {}): { ok: boolean; reason?: string } {
  const rm = execGit(['-C', repoDir, 'worktree', 'remove', '--force', wtPath]);
  execGit(['-C', repoDir, 'worktree', 'prune']);
  if (opts.deleteBranch) execGit(['-C', repoDir, 'branch', '-D', opts.deleteBranch]);
  if (!rm.ok && existsSync(wtPath)) return { ok: false, reason: rm.out.slice(0, 300) };
  return { ok: true };
}

/** Copy gitignored files (e.g. `.env*`, `config/*.local.json`) from a repo into a
    worktree. The last path segment may contain `*`. Best-effort; never throws. */
export function copyGlobsInto(srcRepo: string, wtPath: string, globs: string[]): void {
  for (const glob of globs) {
    const norm = glob.replace(/^\.\//, '');
    const slash = norm.lastIndexOf('/');
    const dir = slash >= 0 ? norm.slice(0, slash) : '.';
    const pat = slash >= 0 ? norm.slice(slash + 1) : norm;
    const srcDir = path.join(srcRepo, dir);
    if (!existsSync(srcDir)) continue;
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    let entries: string[] = [];
    try { entries = readdirSync(srcDir); } catch { continue; }
    for (const name of entries) {
      if (!re.test(name)) continue;
      const from = path.join(srcDir, name);
      const to = path.join(wtPath, dir, name);
      try {
        if (!statSync(from).isFile()) continue;
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(from, to);
      } catch { /* best effort */ }
    }
  }
}

/** Resolve symlinks (e.g. macOS /var → /private/var) so paths compare equal to
    what `git worktree list` reports. Falls back to a plain resolve if the path
    no longer exists. */
function canonicalPath(p: string): string {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

/** Whether `wtPath` is already a registered worktree of `repoDir` (symlink-safe). */
export function worktreeExists(repoDir: string, wtPath: string): boolean {
  const target = canonicalPath(wtPath);
  return listWorktrees(repoDir).some(w => canonicalPath(w.path) === target);
}
