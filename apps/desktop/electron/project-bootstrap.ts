/* GitHub-first project bootstrap — turn a chosen name + local path into a
   real, committed, pushed GitHub repo before the agent starts touching it.

   Flow:
     1.  slugify(name) → suggestAvailableSlug(...)               (pick a free slug)
     2.  If the folder doesn't exist yet, create it; if it has no .git, init.
     3.  Seed README.md / .gitignore / .continuum/STATE.md /
         .claude/settings.json  (only files that don't already exist).
     4.  git add -A && git commit (cleanly — no Co-Authored-By here; the
         commit-identity hook is Track 1's job).
     5.  POST /user/repos                                         (createGitHubRepo)
     6.  git remote add origin <cloneUrl>                         (or update if set)
     7.  git push -u origin <local default branch — main usually>

   The git/fs side is injected through small interfaces so the unit tests can
   stand in (no real shell-out, no real GitHub call). The renderer never sees
   any of this — it talks to localApi → bootstrapProject → bootstrapNewProject. */

import { suggestAvailableSlug } from './github-slug.js';
import { createGitHubRepo, getViewer } from './github.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveGit } from './git.js';

type FetchImpl = typeof fetch;

/** Minimal filesystem surface — tests pass a fake. */
export interface FsLike {
  exists(p: string): boolean;
  mkdirp(p: string): void;
  writeFileIfMissing(p: string, text: string): boolean;   // returns true if it wrote
}

/** Minimal git surface — every method takes the cwd it runs in. Tests pass a
    spy that just records the calls. The shape mirrors what we actually need
    (no full porcelain client). */
export interface GitLike {
  init(dir: string): void;
  hasRepo(dir: string): boolean;
  getRemoteUrl(dir: string, remote?: string): string | null;
  addAll(dir: string): void;
  /** Detects whether HEAD already exists (some flow may be re-running). */
  hasCommits(dir: string): boolean;
  commit(dir: string, message: string): void;
  setRemote(dir: string, remote: string, url: string): void;
  /** The current branch, after init / first commit (usually 'main' or 'master'). */
  currentBranch(dir: string): string | null;
  push(dir: string, remote: string, branch: string): void;
}

export interface BootstrapInput {
  /** Free-form display name from the user (will be slugified). */
  name: string;
  /** Absolute path on disk where the project lives. */
  localPath: string;
  /** Defaults to true (private). */
  private?: boolean;
  /** A description for GitHub's repo card (optional). */
  description?: string;
  /** Skip the local `git init` (the folder is already a repo we're adopting). */
  skipInit?: boolean;
  /** If true, ONLY runs steps 1 + 5–7: no local commits or seed files. Used
      when the user adopts an existing repo that already has its own commits. */
  remoteOnly?: boolean;
}

export interface BootstrapResult {
  slug: string;
  /** The chosen slug differs from slugify(name) (i.e. base was taken → -v2). */
  slugChanged: boolean;
  owner: string;
  fullName: string;          // "owner/slug"
  htmlUrl: string;
  cloneUrl: string;
  localPath: string;
  branchPushed: string;
}

export interface BootstrapDeps {
  fs: FsLike;
  git: GitLike;
  fetchImpl?: FetchImpl;
  /** Optional clock for the seed STATE.md (default: current date). */
  now?: () => Date;
}

/** README.md seed — one line, project title + creation date. */
function seedReadme(name: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return `# ${name}\n\nCreated ${day} with Maestro.\n`;
}

/** .gitignore seed — defensive, not exhaustive. The user can extend it. */
function seedGitignore(): string {
  return [
    '# Maestro defaults',
    'node_modules/',
    '.env',
    '.env.local',
    '.env.*.local',
    '.DS_Store',
    'dist/',
    'build/',
    '.turbo/',
    '.next/',
    'out/',
    'coverage/',
    '*.log',
    '',
  ].join('\n');
}

/** .continuum/STATE.md seed — the project memory the agent reads each turn. */
function seedContinuumState(name: string, when: Date): string {
  return [
    `# ${name}`,
    '',
    `Created: ${when.toISOString()}`,
    '',
    '## Decisions',
    '',
    '_No decisions recorded yet._',
    '',
    '## Open questions',
    '',
    '_None._',
    '',
  ].join('\n');
}

/** .claude/settings.json seed — committed to the repo so per-project config
    travels with it. Empty object today; the user can add to it. */
function seedClaudeSettings(): string {
  return '{}\n';
}

/** Write the four seed files. Each is idempotent (skipped if already present),
    so re-running bootstrap or adopting a folder with one of these already
    doesn't clobber it. Returns the list of files actually written. */
export function seedProjectFiles(dir: string, name: string, fs: FsLike, now: Date): string[] {
  const written: string[] = [];
  const join = (a: string, b: string): string => (a.endsWith('/') ? a + b : a + '/' + b);
  fs.mkdirp(dir);
  if (fs.writeFileIfMissing(join(dir, 'README.md'), seedReadme(name, now))) written.push('README.md');
  if (fs.writeFileIfMissing(join(dir, '.gitignore'), seedGitignore())) written.push('.gitignore');
  fs.mkdirp(join(dir, '.continuum'));
  if (fs.writeFileIfMissing(join(dir, '.continuum/STATE.md'), seedContinuumState(name, now))) written.push('.continuum/STATE.md');
  fs.mkdirp(join(dir, '.claude'));
  if (fs.writeFileIfMissing(join(dir, '.claude/settings.json'), seedClaudeSettings())) written.push('.claude/settings.json');
  return written;
}

/** Decide whether a folder still needs its initial bootstrap commit (i.e. it's
    fresh / has no commits) or already has history we should leave alone. */
function needsInitialCommit(dir: string, git: GitLike): boolean {
  return !git.hasCommits(dir);
}

/** Default token-to-owner resolver: ask GitHub who I am. Memoized inside one
    bootstrap call (we call it at most once). */
async function resolveOwner(token: string, fetchImpl?: FetchImpl): Promise<string> {
  const v = await getViewer(token, fetchImpl);
  if (!v.login) throw new Error('Could not resolve your GitHub login. Re-authenticate and try again.');
  return v.login;
}

/** Bootstrap a brand-new project to GitHub. Returns the resolved slug + the
    remote URLs so the renderer can show "Created github.com/owner/slug ✓". */
export async function bootstrapNewProject(
  token: string,
  input: BootstrapInput,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const { fs, git } = deps;
  const fetchImpl = deps.fetchImpl;
  const now = (deps.now ?? (() => new Date()))();

  if (!input.name || !input.name.trim()) throw new Error('A project name is required.');
  if (!input.localPath) throw new Error('A local path is required.');

  const owner = await resolveOwner(token, fetchImpl);
  const slug = await suggestAvailableSlug(token, owner, input.name, fetchImpl);
  const slugChanged = slug !== slugifyForCompare(input.name);

  // Steps 2–4: local repo + seed + initial commit (skipped on remote-only adopt).
  if (!input.remoteOnly) {
    fs.mkdirp(input.localPath);
    if (!input.skipInit && !git.hasRepo(input.localPath)) {
      git.init(input.localPath);
    }
    seedProjectFiles(input.localPath, input.name, fs, now);

    if (needsInitialCommit(input.localPath, git)) {
      git.addAll(input.localPath);
      git.commit(input.localPath, 'chore(repo): initial commit');
    }
  }

  // Step 5: create the GitHub repo.
  const repo = await createGitHubRepo(token, {
    name: slug,
    private: input.private,
    description: input.description,
  }, fetchImpl);

  // Step 6: wire origin (overwrite if some stale URL was already set).
  git.setRemote(input.localPath, 'origin', repo.cloneUrl);

  // Step 7: push. Branch is whatever git ended up on (`main` for fresh inits
  // on modern git; `master` on older operator configs).
  const branch = git.currentBranch(input.localPath) ?? 'main';
  git.push(input.localPath, 'origin', branch);

  return {
    slug,
    slugChanged,
    owner: repo.owner,
    fullName: `${repo.owner}/${repo.repo}`,
    htmlUrl: repo.htmlUrl,
    cloneUrl: repo.cloneUrl,
    localPath: input.localPath,
    branchPushed: branch,
  };
}

/** Same `slugify` rules as the github-slug module — copied tiny so we don't
    re-import & couple the test surface. Used only to decide whether the
    chosen slug differs from the raw name (UI hint). */
function slugifyForCompare(name: string): string {
  return (name ?? '')
    .toString()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '') || 'project';
}

/* ── Real adapters: live `node:fs` + the operator's `git` ──────────────────
   Kept at the bottom because the testable surface above must not import them
   (we want unit tests to never shell-out). localApi.ts wires these into
   bootstrapNewProject at IPC dispatch time. */

/** node:fs-backed FsLike. `writeFileIfMissing` honours the existing-file
    invariant our seed helper relies on. */
export const realFs: FsLike = {
  exists: (p: string) => existsSync(p),
  mkdirp: (p: string) => { mkdirSync(p, { recursive: true }); },
  writeFileIfMissing: (p: string, text: string) => {
    if (existsSync(p)) return false;
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text, 'utf8');
    return true;
  },
};

/** Run `git` synchronously in `dir`. Throws on non-zero exit (with the
    stderr-tail attached) so the bootstrap can fail loud + clean. */
function git(dir: string, args: string[], timeout = 30_000): string {
  const bin = resolveGit();
  if (!bin) throw new Error('git is not installed on this Mac. Install Xcode Command Line Tools (`xcode-select --install`).');
  try {
    return execFileSync(bin, ['-C', dir, ...args], { encoding: 'utf8', timeout }).trim();
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderrTail = (err.stderr ? String(err.stderr) : '').trim().split('\n').pop() ?? '';
    const stdoutTail = (err.stdout ? String(err.stdout) : '').trim().split('\n').pop() ?? '';
    const tail = stderrTail || stdoutTail || err.message || 'git failed';
    throw Object.assign(new Error(`git ${args[0]} failed: ${tail}`), { statusCode: 500 });
  }
}

/** Shell-backed GitLike. Uses the operator's git + their credentials (gh /
    osxkeychain) so private-repo pushes "just work" if they're already
    signed in. We name the initial branch `main` explicitly so older operator
    setups (init.defaultBranch=master) still produce a `main` we can push. */
export const realGit: GitLike = {
  init: (dir) => {
    // -b main pins the initial branch even on older operator gits.
    try { git(dir, ['init', '-q', '-b', 'main']); }
    catch {
      // very old git (<2.28) has no -b: fall back to init + symbolic-ref.
      git(dir, ['init', '-q']);
      try { git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']); } catch { /* leave whatever git picked */ }
    }
  },
  hasRepo: (dir) => existsSync(path.join(dir, '.git')),
  getRemoteUrl: (dir, remote = 'origin') => {
    try { return git(dir, ['remote', 'get-url', remote], 5000) || null; } catch { return null; }
  },
  addAll: (dir) => { git(dir, ['add', '-A']); },
  hasCommits: (dir) => {
    try { git(dir, ['rev-parse', '-q', '--verify', 'HEAD'], 5000); return true; } catch { return false; }
  },
  commit: (dir, message) => {
    // Match snapshotProject() style: use a local identity so this works on a
    // fresh Mac with no git user.email configured. Track 1's commit-identity
    // hook will override this on subsequent commits.
    git(dir, ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@local', 'commit', '-q', '--allow-empty', '-m', message.slice(0, 200)]);
  },
  setRemote: (dir, remote, url) => {
    const existing = (() => { try { return git(dir, ['remote', 'get-url', remote], 5000) || null; } catch { return null; } })();
    if (existing) git(dir, ['remote', 'set-url', remote, url]);
    else git(dir, ['remote', 'add', remote, url]);
  },
  currentBranch: (dir) => {
    try {
      const b = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
      return b && b !== 'HEAD' ? b : null;
    } catch { return null; }
  },
  push: (dir, remote, branch) => {
    // -u so subsequent pushes/pulls work without arguments.
    // GIT_TERMINAL_PROMPT=0 mirrors git.ts/cloneRepo: fail fast instead of
    // hanging on a missing credential prompt.
    const bin = resolveGit();
    if (!bin) throw new Error('git is not installed');
    try {
      execFileSync(bin, ['-C', dir, 'push', '-u', remote, branch], {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string };
      const tail = (err.stderr ? String(err.stderr) : err.message ?? '').trim().split('\n').pop() ?? 'push failed';
      throw Object.assign(new Error(`git push failed: ${tail}`), { statusCode: 500 });
    }
  },
};

/** Read the existing `origin` URL (or null) without ceremony — used by the
    adopt-folder path so we can decide between "leave alone" / "add a GitHub
    repo for this orphan folder". */
export function readOriginRemote(dir: string): string | null {
  return realGit.getRemoteUrl(dir, 'origin');
}

/** Read a file's contents if it exists; used by adopt-folder to surface the
    operator's existing README into the renderer's preview (future hook). */
export function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
