/* memory-repo — the operator's per-project "brain" lives in its own GitHub
   repo (private, always under the user's personal account, NEVER an org), is
   cloned into Electron's userData, and is symlinked into the project tree so
   the agent reads/writes it as if it were `${projectPath}/.continuum/...` and
   `${projectPath}/.claude/...`.

   The four symlinks (all relative to projectPath):
     .continuum               → ${memoryClone}/continuum
     .claude/skills           → ${memoryClone}/claude/skills
     .claude/CLAUDE.md        → ${memoryClone}/claude/CLAUDE.md
     .claude/settings.json    → ${memoryClone}/claude/settings.json

   The project's .gitignore keeps ignoring .claude/ + .continuum/, so the
   symlinks never enter the code repo — clients see a clean tree. The
   memory repo carries the operator's STATE.md, skills, settings and
   CLAUDE.md across machines via a normal `git pull`.

   Conflict policy: last-writer-wins. On openProject we run a
   `git pull --rebase --autostash`; if it fails with conflicts, we
   `git checkout --theirs .` then `git rebase --continue` (capped retries).
   STATE.md is mostly append/replace so this is almost always safe. */

import { ghRequest } from './github.js';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readlinkSync, rmSync } from 'node:fs';

type FetchImpl = typeof fetch;

/** Minimal git surface — every method takes the cwd it runs in. Tests pass a
    spy. Mirrors the bootstrap's GitLike but only the bits the memory-repo
    flows actually use (plus clone/pullRebase/checkoutTheirs/status). */
export interface GitRunner {
  /** Run `git ${args}` in `dir`. Throws on non-zero with the stderr-tail. */
  run(dir: string, args: string[]): string;
  /** Spawn `git clone <url> <dest>` (special-cased because it has no cwd). */
  clone(url: string, dest: string): void;
}

/* ── userData path resolution ──────────────────────────────────────────────
   The memory clone lives at  ${userData}/memory/${slug}/. Tests pass an
   explicit `userDataDir`; production reads it from Electron's `app.getPath`
   (lazy-imported so vitest never has to mock electron). */

function defaultUserDataDir(): string {
  // Electron's `app` is only available inside the main process; import is
  // lazy so this module loads cleanly under vitest.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as { app?: { getPath?: (k: string) => string } };
  const ud = electron.app?.getPath?.('userData');
  if (!ud) throw new Error('memory-repo: Electron userData path not available (only the main process can call this)');
  return ud;
}

/** Where does the memory clone for `${slug}` live on disk? */
export function memoryClonePath(slug: string, userDataDir?: string): string {
  const safe = String(slug || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  if (!safe) throw new Error('memory-repo: slug is empty after sanitisation');
  return path.join(userDataDir ?? defaultUserDataDir(), 'memory', safe);
}

/* ── GitHub: discover + create the memory repo ─────────────────────────────
   The repo is ALWAYS named `${slug}-memory` and ALWAYS under the user's own
   personal account (kind:'user') — never an org. That keeps the operator's
   brain private to them even when the code repo lives in a client's org. */

function memoryRepoName(slug: string): string {
  return `${slug}-memory`;
}

/** Does `${user}/${slug}-memory` already exist on GitHub? Used by the
    adopt-folder flow: a project being adopted may have a companion memory
    repo from a previous machine that we just need to clone, not recreate. */
export async function discoverMemoryRepo(token: string, user: string, slug: string, fetchImpl?: FetchImpl): Promise<{ exists: boolean; cloneUrl: string | null }> {
  if (!user) throw new Error('memory-repo: user is required to look up the companion repo');
  try {
    const r = await ghRequest<{ clone_url: string }>({ token, path: `/repos/${user}/${memoryRepoName(slug)}`, fetchImpl });
    return { exists: true, cloneUrl: r.data?.clone_url ?? null };
  } catch (e) {
    // 404 = doesn't exist (the common case). Any other status is also "we
    // can't see it" from our perspective — bubble through, callers fall back.
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
      return { exists: false, cloneUrl: null };
    }
    return { exists: false, cloneUrl: null };
  }
}

/** First-time setup for a memory repo: POST to GitHub (private, the user's
    own account), then `git clone` into userData/memory/${slug}/. If the
    repo already exists on GitHub (e.g. operator deleted local but never
    deleted the repo), we just clone the existing one. */
export async function ensureMemoryRepo(opts: {
  token: string;
  user: string;
  slug: string;
  /** Override userData (tests). */
  userDataDir?: string;
  gitRunner?: GitRunner;
  githubFetch?: FetchImpl;
}): Promise<{ memoryPath: string; htmlUrl: string }> {
  if (!opts.user) throw new Error('memory-repo: user is required to create the memory repo');
  const git = opts.gitRunner ?? realGitRunner;
  const dest = memoryClonePath(opts.slug, opts.userDataDir);
  const name = memoryRepoName(opts.slug);

  // If the directory already exists locally with a .git, treat it as already
  // cloned — re-using is idempotent. (We still try to discover the html_url.)
  const alreadyLocal = existsSync(path.join(dest, '.git'));
  const discovered = await discoverMemoryRepo(opts.token, opts.user, opts.slug, opts.githubFetch);

  let htmlUrl: string;
  let cloneUrl: string;
  if (discovered.exists) {
    cloneUrl = discovered.cloneUrl ?? `https://github.com/${opts.user}/${name}.git`;
    htmlUrl = `https://github.com/${opts.user}/${name}`;
  } else {
    // Create on GitHub (private, user's own account). We POST directly here
    // rather than reuse createGitHubRepo so the autoInit:true makes the
    // clone resolve to a valid (empty-tree) repo without needing a push.
    const r = await ghRequest<{ clone_url: string; html_url: string }>({
      token: opts.token, method: 'POST', path: '/user/repos',
      body: { name, private: true, auto_init: true, description: 'Maestro memory (per-project STATE.md + skills + settings)' },
      fetchImpl: opts.githubFetch,
    });
    cloneUrl = r.data.clone_url;
    htmlUrl = r.data.html_url;
  }

  if (!alreadyLocal) {
    mkdirSync(path.dirname(dest), { recursive: true });
    // Clean any stray empty directory so `git clone` doesn't refuse.
    if (existsSync(dest)) {
      try { rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    git.clone(cloneUrl, dest);
  }

  return { memoryPath: dest, htmlUrl };
}

/* ── Pull / commit / push ─────────────────────────────────────────────────
   The lifecycle: openProject → pullMemory (rebase-with-autostash); STATE.md
   changes → debounced commitAndPushMemory (the watcher lives in lifecycle).
   Last-writer-wins on rebase conflicts: `git checkout --theirs .`,
   `git add -A`, `git rebase --continue`, capped at 3 retries. */

const MAX_REBASE_RETRIES = 3;

/** `git pull --rebase --autostash`; last-writer-wins on conflicts. Idempotent
    when the clone is clean + already up-to-date (no work performed). Returns
    a small report so the caller can log "pulled X conflicts resolved Y". */
export async function pullMemory(slug: string, gitRunner?: GitRunner, userDataDir?: string): Promise<{ pulled: boolean; conflictsResolved: number }> {
  const git = gitRunner ?? realGitRunner;
  const dir = memoryClonePath(slug, userDataDir);
  if (!existsSync(path.join(dir, '.git'))) {
    // Nothing to pull from — caller should ensureMemoryRepo first. We DON'T
    // throw here: openProject lifecycle calls pullMemory unconditionally and
    // a fresh project hasn't ensureMemoryRepo'd on THIS machine yet.
    return { pulled: false, conflictsResolved: 0 };
  }
  let conflictsResolved = 0;
  for (let attempt = 0; attempt <= MAX_REBASE_RETRIES; attempt++) {
    try {
      git.run(dir, ['pull', '--rebase', '--autostash']);
      return { pulled: true, conflictsResolved };
    } catch (e) {
      // Rebase conflict — surface the file list, take theirs, continue. We
      // bail out if we hit the retry cap to avoid an infinite loop on a
      // pathological repo.
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      const isConflict = /conflict|merge|rebase/.test(msg);
      if (!isConflict || attempt === MAX_REBASE_RETRIES) {
        // Abort any in-progress rebase so the clone is left in a usable state.
        try { git.run(dir, ['rebase', '--abort']); } catch { /* not in a rebase */ }
        throw e;
      }
      // Last-writer-wins: take "their" version (the remote's) for every
      // conflicted file, stage everything, continue.
      try { git.run(dir, ['checkout', '--theirs', '.']); } catch { /* may error if nothing to checkout */ }
      try { git.run(dir, ['add', '-A']); } catch { /* nothing to add */ }
      try {
        git.run(dir, ['-c', 'core.editor=true', 'rebase', '--continue']);
        conflictsResolved++;
        return { pulled: true, conflictsResolved };
      } catch {
        // Loop again; we may have more conflicted patches in the rebase.
        conflictsResolved++;
      }
    }
  }
  return { pulled: true, conflictsResolved };
}

/** Stage everything, commit (no-op if nothing changed), push. Returns the
    pushed SHA so the caller can log it. */
export async function commitAndPushMemory(slug: string, reason: string, gitRunner?: GitRunner, userDataDir?: string): Promise<{ pushed: boolean; sha: string | null }> {
  const git = gitRunner ?? realGitRunner;
  const dir = memoryClonePath(slug, userDataDir);
  if (!existsSync(path.join(dir, '.git'))) return { pushed: false, sha: null };
  git.run(dir, ['add', '-A']);
  // commit will exit non-zero if there's nothing to commit; treat that as
  // a no-op (return null sha). Use a local identity (matches snapshotProject)
  // so a fresh Mac with no git user.email still produces a valid commit.
  try {
    git.run(dir, ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@local', 'commit', '-q', '-m', reason.slice(0, 200)]);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    if (/nothing to commit|no changes added/.test(msg)) return { pushed: false, sha: null };
    throw e;
  }
  const sha = (() => { try { return git.run(dir, ['rev-parse', 'HEAD']).trim() || null; } catch { return null; } })();
  // Push the current branch; the memory repo is single-branch so this is fine.
  git.run(dir, ['push']);
  return { pushed: true, sha };
}

/* ── Symlink projection ───────────────────────────────────────────────────
   The four symlinks that make the memory repo appear to live in the project
   tree. Idempotent: a correct existing symlink is left alone; a wrong one
   throws; a real file/dir at any of the targets throws ("would clobber"). */

const SYMLINKS: Array<{ target: string; from: string; type: 'dir' | 'file' }> = [
  { target: '.continuum',              from: 'continuum',            type: 'dir'  },
  { target: '.claude/skills',          from: 'claude/skills',        type: 'dir'  },
  { target: '.claude/CLAUDE.md',       from: 'claude/CLAUDE.md',     type: 'file' },
  { target: '.claude/settings.json',   from: 'claude/settings.json', type: 'file' },
];

/** Create (or verify) the four symlinks from `${projectPath}` into the memory
    clone for `${slug}`. Idempotent. Throws with a clear message if any target
    is a real file/dir (clobbering would lose the user's data) or a symlink
    pointing elsewhere (we'd be silently rewriting their layout). */
export async function linkMemoryIntoProject(slug: string, projectPath: string, userDataDir?: string): Promise<void> {
  if (!projectPath) throw new Error('memory-repo: projectPath is required');
  const memDir = memoryClonePath(slug, userDataDir);
  // Ensure the .claude dir exists in the project so we can write file
  // symlinks INSIDE it.
  mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
  for (const link of SYMLINKS) {
    const linkPath = path.join(projectPath, link.target);
    const sourcePath = path.join(memDir, link.from);
    // Make sure the source exists in the memory clone (a brand-new clone may
    // be missing claude/skills/ as a directory). Best-effort — for files, the
    // bootstrap seeds them, so if the source is missing for a *file* link we
    // surface a clearer error than fs.symlink's EEXIST/ENOENT.
    if (link.type === 'dir') {
      try { mkdirSync(sourcePath, { recursive: true }); } catch { /* best effort */ }
    }
    let existing: ReturnType<typeof lstatSync> | null = null;
    try { existing = lstatSync(linkPath); } catch { /* doesn't exist */ }
    if (existing) {
      if (existing.isSymbolicLink()) {
        const current = readlinkSync(linkPath);
        // node's readlink returns whatever was written; we always write the
        // absolute path, so compare absolutes.
        if (path.resolve(path.dirname(linkPath), current) === sourcePath) continue;
        throw new Error(`memory-repo: ${linkPath} is a symlink pointing to ${current}, expected ${sourcePath}. Refusing to overwrite — investigate manually.`);
      }
      // Real file or real directory — refuse to clobber. The operator must
      // resolve this (move their existing .continuum/.claude aside, or use
      // adopt-folder so the existing content seeds the memory repo).
      throw new Error(`memory-repo: ${linkPath} exists and is not a symlink. Refusing to clobber a real ${existing.isDirectory() ? 'directory' : 'file'} — move it aside before linking.`);
    }
    // Make sure parent dir exists (needed for files inside .claude that
    // mkdirp at top doesn't cover when projectPath has weird symlinks).
    mkdirSync(path.dirname(linkPath), { recursive: true });
    // Windows: 'dir' vs 'file' picks the junction-or-file kind. macOS/Linux
    // ignores the third arg; passing it costs nothing.
    symlinkSync(sourcePath, linkPath, link.type);
  }
}

/* ── Seed helpers (used by Step 6 bootstrap) ─────────────────────────────
   The memory clone starts with the four target files in their canonical
   places, so the first push to the memory repo carries an immediately-useful
   payload + the linkMemoryIntoProject symlinks don't dangle. */

/** Write the four canonical files into the memory clone (idempotent — won't
    overwrite the user's existing content). The maestro-commit skill body
    comes from the caller (Step 6 reads the template). */
export function seedMemoryClone(memoryPath: string, opts: { projectName: string; now: Date; maestroCommitSkill: string }): string[] {
  const written: string[] = [];
  const w = (p: string, body: string): void => {
    if (existsSync(p)) return;
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
    written.push(path.relative(memoryPath, p));
  };
  mkdirSync(path.join(memoryPath, 'continuum'), { recursive: true });
  mkdirSync(path.join(memoryPath, 'claude', 'skills', 'maestro-commit'), { recursive: true });
  w(path.join(memoryPath, 'continuum', 'STATE.md'), [
    `# ${opts.projectName}`,
    '',
    `Created: ${opts.now.toISOString()}`,
    '',
    '## Decisions',
    '',
    '_No decisions recorded yet._',
    '',
    '## Open questions',
    '',
    '_None._',
    '',
  ].join('\n'));
  w(path.join(memoryPath, 'claude', 'CLAUDE.md'), [
    `# ${opts.projectName}`,
    '',
    'Project memory lives in `.continuum/STATE.md`. Read it before acting.',
    '',
  ].join('\n'));
  w(path.join(memoryPath, 'claude', 'settings.json'), '{}\n');
  w(path.join(memoryPath, 'claude', 'skills', 'maestro-commit', 'SKILL.md'), opts.maestroCommitSkill);
  return written;
}

/* ── Real GitRunner (the operator's git via execFileSync) ─────────────── */

import { execFileSync } from 'node:child_process';
import { resolveGit } from './git.js';

export const realGitRunner: GitRunner = {
  run: (dir, args) => {
    const bin = resolveGit();
    if (!bin) throw new Error('git is not installed on this Mac. Install Xcode Command Line Tools (`xcode-select --install`).');
    try {
      return execFileSync(bin, ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 }).trim();
    } catch (e) {
      const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
      const stderrTail = (err.stderr ? String(err.stderr) : '').trim().split('\n').pop() ?? '';
      const stdoutTail = (err.stdout ? String(err.stdout) : '').trim().split('\n').pop() ?? '';
      const tail = stderrTail || stdoutTail || err.message || 'git failed';
      throw Object.assign(new Error(`git ${args[0]} failed: ${tail}`), { statusCode: 500 });
    }
  },
  clone: (url, dest) => {
    const bin = resolveGit();
    if (!bin) throw new Error('git is not installed');
    try {
      execFileSync(bin, ['clone', '--quiet', url, dest], {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string };
      const tail = (err.stderr ? String(err.stderr) : err.message ?? '').trim().split('\n').pop() ?? 'clone failed';
      throw Object.assign(new Error(`git clone failed: ${tail}`), { statusCode: 500 });
    }
  },
};
