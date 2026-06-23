/* Git operations — local to this Mac, on the operator's own `git` + credentials.
   Used by the coding agent: clone a GitHub repo into ~/Maestro/<name>, read a
   project folder's branch/remote, and tell whether a folder is a repo. Clone
   progress streams back so the UI can show it live. */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

/** ── Branch listing (powers the "new chat from branch" picker) ───────────── */

export interface BranchInfo {
  /** Plain branch name — no `refs/heads/` and no `origin/` prefix. */
  name: string;
  /** True when this matches `origin/HEAD` (the repo's default branch). */
  isDefault: boolean;
  /** True when this is the current HEAD of the MAIN repo (not a worktree). */
  isCurrent: boolean;
  /** True when a corresponding `origin/<name>` ref exists. */
  hasRemote: boolean;
  /** Tip commit metadata (subject + unix timestamp), null on parse failure. */
  lastCommit: { sha: string; subject: string; date: number } | null;
}

/** Internal: parse one `for-each-ref` line, NUL-delimited fields. */
function parseRefLine(line: string): { ref: string; sha: string; subject: string; date: number } | null {
  // Format: refname\0objectname:short\0contents:subject\0committerdate:unix
  const parts = line.split('\0');
  if (parts.length < 4) return null;
  const [ref, sha, subject, dateStr] = parts;
  if (!ref) return null;
  const date = Number(dateStr);
  return { ref, sha, subject: (subject ?? '').slice(0, 200), date: Number.isFinite(date) ? date : 0 };
}

/** All local + remote `origin/*` branches (deduped: local wins when both exist).
    Sort: default first, current next, then alphabetical. Never throws. */
export function listBranches(repoDir: string): BranchInfo[] {
  if (!repoDir || !existsSync(repoDir) || !isGitRepo(repoDir)) return [];

  // Default = origin/HEAD (best-effort; missing on fresh clones / file:// remotes).
  const defHead = execGit(['-C', repoDir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const defaultName = defHead.ok && defHead.out ? defHead.out.replace(/^origin\//, '') : null;

  // Current = the MAIN repo's HEAD, not any session worktree's (worktrees are
  // children with their OWN HEAD; we want the operator's "real" current branch).
  const curRef = execGit(['-C', repoDir, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  const currentName = curRef.ok && curRef.out ? curRef.out : null;

  // One pass over locals + origin remotes — NUL-delimited so subjects with `|`
  // or `:` don't break the split.
  const fmt = '%(refname)%00%(objectname:short)%00%(contents:subject)%00%(committerdate:unix)';
  const r = execGit(['-C', repoDir, 'for-each-ref', `--format=${fmt}`, 'refs/heads/', 'refs/remotes/origin/']);
  if (!r.ok) return [];

  const byName = new Map<string, BranchInfo>();
  for (const raw of r.out.split('\n')) {
    if (!raw) continue;
    const parsed = parseRefLine(raw);
    if (!parsed) continue;
    const { ref, sha, subject, date } = parsed;

    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      // Local always wins — even if we later see origin/<name>, keep local's commit.
      byName.set(name, {
        name,
        isDefault: name === defaultName,
        isCurrent: name === currentName,
        hasRemote: false,            // patched in the remote-pass below
        lastCommit: { sha, subject, date },
      });
    } else if (ref.startsWith('refs/remotes/origin/')) {
      const name = ref.slice('refs/remotes/origin/'.length);
      if (name === 'HEAD') continue; // origin/HEAD is a symbolic ref, not a real branch
      const existing = byName.get(name);
      if (existing) {
        existing.hasRemote = true;
      } else {
        byName.set(name, {
          name,
          isDefault: name === defaultName,
          isCurrent: false, // remote-only branches aren't checked out anywhere
          hasRemote: true,
          lastCommit: { sha, subject, date },
        });
      }
    }
  }

  const all = [...byName.values()];
  all.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    // current floats above the rest (but never above default)
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return all;
}

/** Best-effort `git fetch origin`. No-op (ok:false) when there's no origin remote. */
export function fetchOrigin(repoDir: string): { ok: boolean; reason?: string } {
  const remotes = execGit(['-C', repoDir, 'remote']);
  if (!remotes.ok || !remotes.out.split(/\s+/).includes('origin')) return { ok: false, reason: 'no origin remote' };
  const r = execGit(['-C', repoDir, 'fetch', '--prune', 'origin'], { timeout: 60_000 });
  return r.ok ? { ok: true } : { ok: false, reason: r.out.slice(0, 200) };
}

/* ── PR-availability + push (Phase 2) ─────────────────────────────────── */

/** Commits the branch is ahead/behind `base` (`rev-list --left-right --count base...HEAD`). */
export function aheadBehind(dir: string, base: string): { ahead: number; behind: number } {
  const r = execGit(['-C', dir, 'rev-list', '--left-right', '--count', `${base}...HEAD`]);
  if (!r.ok) return { ahead: 0, behind: 0 };
  const [left, right] = r.out.split(/\s+/);
  const behind = Number(left); // commits in base not HEAD
  const ahead = Number(right); // commits in HEAD not base
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
}

/** Whether the working tree has uncommitted changes. */
export function isDirty(dir: string): boolean {
  const r = execGit(['-C', dir, 'status', '--porcelain']);
  return r.ok && r.out.length > 0;
}

/** Count of modified/added/deleted files (porcelain rows). 0 when clean. */
export function dirtyFileCount(dir: string): number {
  const r = execGit(['-C', dir, 'status', '--porcelain']);
  if (!r.ok || !r.out) return 0;
  return r.out.split('\n').filter(line => line.length > 0).length;
}

/** First line of `git log -1 --format=%s\\n%at` for the current HEAD. Returns
    null subject + null time when the branch has no commits. */
export function lastCommitInfo(dir: string): { subject: string | null; at: number | null } {
  const r = execGit(['-C', dir, 'log', '-1', '--format=%s%n%at']);
  if (!r.ok || !r.out) return { subject: null, at: null };
  const [subject = '', atStr = ''] = r.out.split('\n');
  const at = Number(atStr) * 1000;
  return { subject: subject || null, at: Number.isFinite(at) && at > 0 ? at : null };
}

/** Whether `remote` has `branch` (via ls-remote; works for file:// remotes in tests). */
export function remoteHasBranch(repoDir: string, remote: string, branch: string): boolean {
  const r = execGit(['-C', repoDir, 'ls-remote', '--heads', remote, branch], { timeout: 30_000 });
  return r.ok && r.out.split('\n').some(l => l.trim().endsWith(`refs/heads/${branch}`));
}

/** Best-effort: set origin/HEAD so resolveBaseBranch can find the default branch. */
export function setRemoteHead(repoDir: string): void {
  execGit(['-C', repoDir, 'remote', 'set-head', 'origin', '-a']);
}

/** Askpass script body: feeds git the username + token over HTTPS without putting
    the token in argv or repo config. Reads the secret from $GIT_TOKEN at runtime. */
export function buildAskpassScript(): string {
  return [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*) echo "x-access-token" ;;',
    '  *Password*) echo "$GIT_TOKEN" ;;',
    'esac',
    '',
  ].join('\n');
}

/** Push `branch` to `remote` and set upstream. With a token, authenticates over
    HTTPS via a temporary GIT_ASKPASS (token in env, never in argv/config). */
export function pushBranch(dir: string, branch: string, opts: { token?: string; remote?: string } = {}): { ok: boolean; reason?: string } {
  const git = resolveGit();
  if (!git) return { ok: false, reason: 'git is not installed' };
  const remote = opts.remote ?? 'origin';
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let askpass: string | undefined;
  try {
    if (opts.token) {
      askpass = path.join(tmpdir(), `mst-askpass-${process.pid}-${Date.now()}.sh`);
      writeFileSync(askpass, buildAskpassScript(), { mode: 0o700 });
      env.GIT_ASKPASS = askpass;
      env.GIT_TOKEN = opts.token;
    }
    execFileSync(git, ['-C', dir, 'push', '--set-upstream', remote, branch], { encoding: 'utf8', env, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr == null ? (err.message ?? '') : typeof err.stderr === 'string' ? err.stderr : err.stderr.toString();
    const low = stderr.toLowerCase();
    let reason = stderr.trim().split('\n').pop() || 'push failed';
    if (low.includes('non-fast-forward') || low.includes('rejected')) reason = 'remote branch has diverged (non-fast-forward) — update or force-with-lease';
    else if (low.includes('authentication') || low.includes('could not read') || low.includes('403') || low.includes('permission')) reason = 'push authentication failed — reconnect GitHub';
    return { ok: false, reason: reason.slice(0, 300) };
  } finally {
    if (askpass) { try { rmSync(askpass, { force: true }); } catch { /* ignore */ } }
  }
}

/** Whether a ref (e.g. `origin/feat`) exists locally. Cheap, no network. */
export function localRefExists(dir: string, ref: string): boolean {
  return execGit(['-C', dir, 'rev-parse', '--verify', '--quiet', ref]).code === 0;
}

/** Rename the local branch checked out at `wtDir`. Pure git plumbing — no remote
    push, no PR concerns. Used by the auto-rename hook: once a session's task is
    clear, swap the codename-only initial branch (`mochi/<city>/<city>`) for the
    same path with a meaningful slug (`mochi/<city>/<slug>`). Idempotent — if
    `to` already matches the current branch, returns ok with `unchanged:true`. */
export function renameLocalBranch(wtDir: string, from: string, to: string): { ok: boolean; reason?: string; unchanged?: boolean } {
  if (!from || !to || from === to) return { ok: true, unchanged: true };
  const git = resolveGit();
  if (!git || !isGitRepo(wtDir)) return { ok: false, reason: 'not a git repo' };
  // Confirm the worktree is on `from`; if it's already on `to` (re-entrant call) we're done.
  const cur = execGit(['-C', wtDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!cur.ok) return { ok: false, reason: 'could not read current branch' };
  if (cur.out === to) return { ok: true, unchanged: true };
  if (cur.out !== from) return { ok: false, reason: `worktree is on ${cur.out}, expected ${from}` };
  // Refuse if `to` already exists (another worktree may hold it, or stale local ref).
  if (execGit(['-C', wtDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${to}`]).code === 0) {
    return { ok: false, reason: `branch ${to} already exists` };
  }
  const r = execGit(['-C', wtDir, 'branch', '-m', from, to]);
  return r.ok ? { ok: true } : { ok: false, reason: r.out.slice(0, 200) };
}

/** List worktree paths that currently carry unmerged conflict markers (status
    code U on either side). Read-only: just inspects `git status --porcelain`,
    so it's safe to call as part of a preview / dialog without touching the
    worktree. Empty array on a clean worktree or non-repo. */
export function listConflictedFiles(dir: string): string[] {
  const r = execGit(['-C', dir, 'status', '--porcelain']);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const line of r.out.split('\n')) {
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    // Unmerged paths: "UU", "AA", "DD", "AU", "UA", "DU", "UD" — any 'U' in xy.
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') {
      out.push(line.slice(3).trim());
    }
  }
  return out;
}

/** Merge `base` (preferring origin/<base>) into the current branch in `dir`. A
    clean merge auto-commits; on conflict, returns the conflicted file paths and
    leaves the merge in progress so an agent/operator can resolve them. */
export function mergeBaseIntoBranch(dir: string, base: string): { ok: boolean; conflicts: string[]; reason?: string } {
  const ref = localRefExists(dir, `origin/${base}`) ? `origin/${base}` : base;
  const m = execGit(['-C', dir, 'merge', '--no-edit', ref], { timeout: 60_000 });
  if (m.ok) return { ok: true, conflicts: [] };
  const conf = execGit(['-C', dir, 'diff', '--name-only', '--diff-filter=U']);
  const conflicts = conf.ok ? conf.out.split('\n').filter(Boolean) : [];
  return conflicts.length ? { ok: false, conflicts } : { ok: false, conflicts: [], reason: m.out.slice(0, 200) };
}

// ── Conflict hunk extraction (T8 AI-resolve UI) ─────────────────────────────
//
// `parseConflictHunks` is the pure parser — given a file's content (with the
// usual git markers), it returns each conflict block with the line ranges and
// the "ours" / "theirs" payloads. Diff3-style markers (`||||||| base`) are
// recognized so the base section can be surfaced too. Pure on purpose — the
// renderer test exercises this directly without touching git/disk.

export interface ConflictHunk {
  /** 1-based line number of the `<<<<<<<` marker in the conflicted file. */
  startLine: number;
  /** 1-based line number of the `>>>>>>>` marker. */
  endLine: number;
  /** Label after `<<<<<<<` (typically the current/branch name, e.g. `HEAD`). */
  oursLabel: string;
  /** Label after `>>>>>>>` (typically the incoming branch name). */
  theirsLabel: string;
  /** Lines between `<<<<<<<` and `|||||||` (diff3) or `=======` (standard). */
  ours: string[];
  /** Diff3 only: lines between `|||||||` and `=======`. */
  base?: string[];
  /** Lines between `=======` and `>>>>>>>`. */
  theirs: string[];
}

export interface ConflictFile {
  path: string;
  hunks: ConflictHunk[];
  /** True if the file couldn't be read (gone, binary, perms). */
  unreadable?: boolean;
}

/** Pure: walk a file's text, extract every `<<<<<<< / ======= / >>>>>>>` block.
    Tolerant of diff3-style (`||||||| base`) and of mid-line whitespace.
    Skips files with no markers. Bounded by the file size — we don't budget. */
export function parseConflictHunks(text: string): ConflictHunk[] {
  // Don't capture EOL chars in the line array — we reuse `n` indices for the
  // 1-based `startLine` / `endLine` so a `\n`-vs-`\r\n` mismatch can't shift
  // the reported ranges by one.
  const lines = text.split(/\r?\n/);
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const mStart = /^<{7}(?:\s+(.*))?$/.exec(ln);
    if (!mStart) { i++; continue; }
    const startLine = i + 1;
    const oursLabel = (mStart[1] ?? '').trim();
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let sawBase = false;
    let sawSep = false;
    let theirsLabel = '';
    let endLine = -1;
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\|{7}(\s|$)/.test(l)) { sawBase = true; i++; continue; }
      if (/^={7}$/.test(l))        { sawSep  = true; i++; continue; }
      const mEnd = /^>{7}(?:\s+(.*))?$/.exec(l);
      if (mEnd) { theirsLabel = (mEnd[1] ?? '').trim(); endLine = i + 1; i++; break; }
      // Bucket by which separator we've crossed so far.
      if (!sawSep && !sawBase) ours.push(l);
      else if (!sawSep && sawBase) base.push(l);
      else theirs.push(l);
      i++;
    }
    // Drop hunks that never closed (corrupted file mid-conflict).
    if (endLine === -1 || !sawSep) continue;
    const hunk: ConflictHunk = { startLine, endLine, oursLabel, theirsLabel, ours, theirs };
    if (sawBase) hunk.base = base;
    hunks.push(hunk);
  }
  return hunks;
}

/** Read each file in `files` (paths relative to `dir`) from disk, parse the
    git conflict markers, return one ConflictFile per input. Files that are
    unreadable (binary, deleted, perms) are returned with `unreadable:true` so
    the UI can still list them. Files with zero parsed hunks are still
    returned (the file may have unresolved marker on a single line, etc.) but
    keyed empty so the dialog can flag them. */
export function getConflictHunks(dir: string, files: string[]): ConflictFile[] {
  // Lazy-import here keeps the helper testable on a tmp dir without booting
  // the rest of the module's heavy git binding.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const out: ConflictFile[] = [];
  for (const rel of files) {
    const abs = path.join(dir, rel);
    try {
      const text = readFileSync(abs, 'utf8');
      out.push({ path: rel, hunks: parseConflictHunks(text) });
    } catch {
      out.push({ path: rel, hunks: [], unreadable: true });
    }
  }
  return out;
}

/** Convenience: ask git for the conflicted files in `dir` (during an
    in-progress merge), then extract their hunks. Returns `{ files: [] }` when
    there is no merge in progress. */
export function getActiveConflictHunks(dir: string): { files: ConflictFile[] } {
  const conf = execGit(['-C', dir, 'diff', '--name-only', '--diff-filter=U']);
  const list = conf.ok ? conf.out.split('\n').filter(Boolean) : [];
  return { files: getConflictHunks(dir, list) };
}

// ── Structured diff (read-only) — feeds the phone's Diff Review screen ──────
export type DiffLineKind = 'ctx' | 'add' | 'del' | 'hunk';
export interface DiffLineOut { t: DiffLineKind; n: string; c: string }
export interface DiffFileOut { path: string; lang: string; additions: number; deletions: number; binary: boolean; lines: DiffLineOut[] }
export interface StructuredDiff {
  files: DiffFileOut[];
  additions: number;
  deletions: number;
  fileCount: number;
  truncated: boolean;
  base: string | null;
  reason?: string;
}

/** Cap the payload that crosses the relay to the phone (whole-diff line budget). */
const MAX_DIFF_LINES = 4000;

function langForPath(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', mjs: 'JS', cjs: 'JS', json: 'JSON', md: 'MD',
    css: 'CSS', scss: 'SCSS', html: 'HTML', py: 'PY', go: 'GO', rs: 'RS', rb: 'RB', sh: 'SH',
    yml: 'YML', yaml: 'YML', sql: 'SQL', toml: 'TOML', swift: 'SWIFT', java: 'JAVA', c: 'C', cpp: 'C++',
  };
  return map[ext] ?? (ext ? ext.toUpperCase().slice(0, 4) : '·');
}

/** Parse a unified `git diff` into per-file hunks with new-file line numbers.
    Pure (string in → structured out) so it is unit-testable without git. */
export function parseUnifiedDiff(raw: string): Omit<StructuredDiff, 'base' | 'reason'> {
  const files: DiffFileOut[] = [];
  let cur: DiffFileOut | null = null;
  let newLine = 0;
  let total = 0;
  let truncated = false;
  let additions = 0;
  let deletions = 0;
  const push = (l: DiffLineOut): void => {
    if (!cur) return;
    if (total >= MAX_DIFF_LINES) { truncated = true; return; }
    cur.lines.push(l); total++;
  };

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      cur = { path: '', lang: '·', additions: 0, deletions: 0, binary: false, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '').trim();
      if (p && p !== '/dev/null') { cur.path = p; cur.lang = langForPath(p); }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!cur.path) { const p = line.slice(4).replace(/^a\//, '').trim(); if (p && p !== '/dev/null') { cur.path = p; cur.lang = langForPath(p); } }
      continue;
    }
    if (line.startsWith('Binary files')) { cur.binary = true; continue; }
    if (line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line.slice(2));
      newLine = m ? Number(m[1]) : newLine;
      push({ t: 'hunk', n: '', c: line });
      continue;
    }
    // Skip extended headers (index/mode/rename/copy/new/deleted).
    if (/^(index |new file|deleted file|rename |copy |similarity |dissimilarity |old mode|new mode)/.test(line)) continue;
    const tag = line[0];
    if (tag === '+') { cur.additions++; additions++; push({ t: 'add', n: String(newLine), c: line.slice(1) }); newLine++; }
    else if (tag === '-') { cur.deletions++; deletions++; push({ t: 'del', n: '', c: line.slice(1) }); }
    else if (tag === ' ') { push({ t: 'ctx', n: String(newLine), c: line.slice(1) }); newLine++; }
    // '\ No newline at end of file' and blank trailing lines fall through.
  }
  const clean = files.filter((f) => f.path);
  return { files: clean, additions, deletions, fileCount: clean.length, truncated };
}

/** Compute the diff of ALL work since the branch left `base` (committed +
    uncommitted) via the merge-base; falls back to the working-tree diff. Read-only. */
export function structuredDiff(dir: string, baseHint?: string | null): StructuredDiff {
  const empty: StructuredDiff = { files: [], additions: 0, deletions: 0, fileCount: 0, truncated: false, base: null };
  const git = resolveGit();
  if (!git || !dir || !existsSync(dir) || !isGitRepo(dir)) return { ...empty, reason: 'not a git repository' };

  const base = (baseHint && baseHint.trim()) || resolveBaseBranch(dir);
  const ref = localRefExists(dir, `origin/${base}`) ? `origin/${base}` : (localRefExists(dir, base) ? base : null);
  let against: string | null = null;
  if (ref) {
    const mb = execGit(['-C', dir, 'merge-base', ref, 'HEAD']);
    against = mb.ok && mb.out ? mb.out : ref;
  }

  const runDiff = (args: string[]): string | null => {
    try {
      return execFileSync(git, ['-C', dir, 'diff', '--no-color', '-U3', ...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }).toString();
    } catch { return null; }
  };
  // merge-base diff captures committed + uncommitted in one pass; else the
  // working-tree diff (uncommitted only) — best effort when there's no base.
  let raw = against ? runDiff([against]) : null;
  if (raw == null || raw.trim() === '') raw = runDiff([]) ?? raw;
  if (raw == null) return { ...empty, base, reason: 'could not compute diff' };

  return { ...parseUnifiedDiff(raw), base };
}
