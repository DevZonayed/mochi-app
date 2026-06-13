/* Git operations — local to this Mac, on the operator's own `git` + credentials.
   Used by the coding agent: clone a GitHub repo into ~/Maestro/<name>, read a
   project folder's branch/remote, and tell whether a folder is a repo. Clone
   progress streams back so the UI can show it live. */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
