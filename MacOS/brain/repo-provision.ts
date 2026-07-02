/* Repo provisioning — the "tightly coupled to GitHub" lifecycle for NEW projects.

   When a project is created with a folder on disk, Maestro immediately:
     1. `git init`s the folder if it isn't a repo yet (default branch: main),
     2. excludes `.continuum/` via `.git/info/exclude` (LOCAL exclude, never a
        committed .gitignore edit — project memory must never enter the shared
        repo; that is what caused two developers' .continuum to conflict),
     3. makes an initial commit when the repo has none,
     4. creates a private GitHub repo under the operator's account (or an org),
     5. wires it as `origin` and pushes the current branch.

   Everything is best-effort and idempotent: a folder that already has a GitHub
   origin is left untouched, a half-provisioned folder resumes where it stopped.
   The token comes from the Keychain (providers) and is only used via
   GIT_ASKPASS (pushBranch) — never written into argv or git config. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveGit, isGitRepo, repoInfo, pushBranch } from './git.js';
import { createRepo, parseGitHubRemote, GhError } from './github.js';

type FetchImpl = typeof fetch;

/** A GitHub-safe repo name from a project name: dashed, trimmed, capped. */
export function repoNameSlug(name: string): string {
  const s = (name || 'project')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics after NFKD
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 90);
  return s || 'project';
}

function git(dir: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; out: string } {
  const bin = resolveGit();
  if (!bin) return { ok: false, out: 'git is not installed' };
  try {
    return { ok: true, out: execFileSync(bin, ['-C', dir, ...args], { encoding: 'utf8', timeout: opts.timeout ?? 30_000, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr == null ? (err.message ?? '') : typeof err.stderr === 'string' ? err.stderr : err.stderr.toString();
    return { ok: false, out: stderr.trim().slice(0, 400) };
  }
}

/** Add `.continuum/` to the repo's LOCAL exclude file (`.git/info/exclude`).

    Why local and not .gitignore: `.continuum` is per-developer project memory
    (STATE.md + checkpoint chain + attachments). If it were committed — or if
    we edited the project's shared .gitignore — two developers on the same repo
    would either conflict on memory files or on the ignore entry itself. The
    local exclude keeps every clone's memory invisible to git with ZERO
    footprint in the shared repository. Worktrees share `info/exclude` via the
    common git dir, so one call covers every session worktree too. */
export function ensureContinuumExcluded(dir: string): void {
  try {
    if (!isGitRepo(dir) && !existsSync(path.join(dir, '.git'))) {
      // Also handle worktrees (`.git` is a file) — rev-parse resolves both.
      const probe = git(dir, ['rev-parse', '--git-common-dir'], { timeout: 5000 });
      if (!probe.ok) return;
    }
    const common = git(dir, ['rev-parse', '--git-common-dir'], { timeout: 5000 });
    if (!common.ok || !common.out) return;
    const commonDir = path.isAbsolute(common.out) ? common.out : path.join(dir, common.out);
    const infoDir = path.join(commonDir, 'info');
    const excludeFile = path.join(infoDir, 'exclude');
    mkdirSync(infoDir, { recursive: true });
    const cur = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    if (/^\.continuum\/?\s*$/m.test(cur)) return; // already excluded
    const next = `${cur.replace(/\n*$/, '\n')}# Maestro project memory — per-developer, synced via the memory repository (never committed here)\n.continuum/\n`;
    writeFileSync(excludeFile, next, 'utf8');
  } catch { /* best-effort — memory staying local is a hardening, not a gate */ }
}

export interface ProvisionResult {
  ok: boolean;
  /** True when a NEW GitHub repo was created by this call. */
  created?: boolean;
  remoteUrl?: string;
  fullName?: string;
  pushed?: boolean;
  reason?: string;
}

/** Ensure `dir` is a git repo with a GitHub `origin`, creating the GitHub repo
    when missing, and push the current branch so no work stays local-only.
    Idempotent; safe to fire-and-forget from the project-creation path. */
export async function provisionGitHubRemote(opts: {
  dir: string;
  name: string;
  token: string;
  /** Org login to create under; ''/undefined = the personal account. */
  owner?: string;
  private?: boolean;
  fetchImpl?: FetchImpl;
}): Promise<ProvisionResult> {
  const { dir, token } = opts;
  if (!dir || !existsSync(dir)) return { ok: false, reason: 'project folder does not exist' };
  if (!resolveGit()) return { ok: false, reason: 'git is not installed' };
  if (!token) return { ok: false, reason: 'connect GitHub first' };

  // 1. init if needed (modern default branch name; -b needs git >= 2.28).
  if (!isGitRepo(dir)) {
    const init = git(dir, ['init', '-q', '-b', 'main']);
    if (!init.ok) {
      const fallback = git(dir, ['init', '-q']);
      if (!fallback.ok) return { ok: false, reason: `git init failed: ${fallback.out}` };
    }
  }

  // 2. keep project memory out of the shared repo — forever.
  ensureContinuumExcluded(dir);

  // 3. first commit when the repo has none (a remote repo needs a ref to push).
  const hasHead = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 5000 }).ok;
  if (!hasHead) {
    git(dir, ['add', '-A']);
    const c1 = git(dir, ['commit', '-q', '--allow-empty', '-m', 'chore: initial import']);
    if (!c1.ok) {
      // No git identity configured yet → retry with a local one-off identity.
      const c2 = git(dir, ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@local', 'commit', '-q', '--allow-empty', '-m', 'chore: initial import']);
      if (!c2.ok) return { ok: false, reason: `initial commit failed: ${c2.out}` };
    }
  }

  // 4. respect an existing origin: GitHub → done; anything else → hands off.
  const info = repoInfo(dir);
  if (info.remote) {
    const gh = parseGitHubRemote(info.remote);
    if (gh) {
      // Already coupled — just make sure the current branch is up on the remote.
      const branch = info.branch ?? 'main';
      const push = pushBranch(dir, branch, { token });
      return { ok: true, created: false, remoteUrl: info.remote, fullName: `${gh.owner}/${gh.repo}`, pushed: push.ok, reason: push.ok ? undefined : push.reason };
    }
    return { ok: false, reason: 'origin points at a non-GitHub remote — left untouched' };
  }

  // 5. create the GitHub repo (collision-tolerant: name, name-2, name-3…).
  const base = repoNameSlug(opts.name);
  let created: { cloneUrl: string; fullName: string } | null = null;
  let lastErr = '';
  for (let n = 0; n < 4 && !created; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    try {
      const r = await createRepo(token, candidate, { private: opts.private ?? true, org: opts.owner || undefined, autoInit: false, description: 'Created by Maestro' }, opts.fetchImpl);
      created = { cloneUrl: r.cloneUrl, fullName: r.fullName };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      // 422 = name already exists on this account → try the next suffix.
      if (!(e instanceof GhError && e.status === 422)) break;
    }
  }
  if (!created) return { ok: false, reason: `could not create the GitHub repo: ${lastErr}`.slice(0, 300) };

  // 6. wire origin + push the current branch. The token flows via GIT_ASKPASS.
  const remoteAdd = git(dir, ['remote', 'add', 'origin', created.cloneUrl]);
  if (!remoteAdd.ok) return { ok: false, created: true, fullName: created.fullName, reason: `remote add failed: ${remoteAdd.out}` };
  const branch = repoInfo(dir).branch ?? 'main';
  const push = pushBranch(dir, branch, { token });
  return { ok: true, created: true, remoteUrl: created.cloneUrl, fullName: created.fullName, pushed: push.ok, reason: push.ok ? undefined : push.reason };
}
