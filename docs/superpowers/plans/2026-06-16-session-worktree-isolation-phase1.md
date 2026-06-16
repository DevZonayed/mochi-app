# Session Worktree Isolation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Maestro chat session its own real `git worktree` directory (own working tree + HEAD + index), replacing the current in-place `git checkout` so sessions are truly isolated and can run in parallel.

**Architecture:** Pure, unit-tested git helpers in `electron/git.ts` + a thin orchestration module `electron/session-worktree.ts`. The Electron glue (engine cwd resolution, dispatch archive/delete, store fields) stays minimal and calls those tested functions. Worktrees live under `~/Maestro/worktrees/<projectId>/<sessionId>`; the project folder (`project.path`) is the shared "root" repo. Non-repo / failure falls back to today's behavior (non-breaking).

**Tech Stack:** TypeScript (ESNext, Bundler resolution, `.js` import specifiers), Electron main process, native `node:child_process` git, **Vitest** (new — idiomatic for this Vite app; repo currently has no test runner).

**Spec:** `docs/superpowers/specs/2026-06-16-session-worktree-pr-lifecycle-design.md` (Phase 1 = §15 first bullet). Phase 2 (PR lifecycle) is a separate later plan.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/desktop/vitest.config.ts` | Vitest config (node env, `.js`→`.ts` resolution) | Create |
| `apps/desktop/package.json` | add `vitest` devDep + `test` script | Modify |
| `apps/desktop/tsconfig.json` | exclude `*.test.ts` from app typecheck | Modify |
| `apps/desktop/electron/test-helpers.ts` | temp-git-repo fixtures for tests | Create |
| `apps/desktop/electron/git.ts` | `execGit` + worktree primitives (pure node) | Modify |
| `apps/desktop/electron/git.worktree.test.ts` | unit tests for the git primitives | Create |
| `apps/desktop/electron/session-worktree.ts` | `ensureSessionWorktree` / `pruneSessionWorktree` orchestration | Create |
| `apps/desktop/electron/session-worktree.test.ts` | unit tests for orchestration | Create |
| `apps/desktop/electron/store.ts` | new optional fields + widen `updateSession` | Modify |
| `apps/desktop/electron/engine.ts` | resolve session cwd to its worktree | Modify |
| `apps/desktop/electron/localApi.ts` | prune on `deleteSession`; add `archiveSession` | Modify |
| `apps/desktop/electron/main.ts` | relay denylist for `archiveSession` | Modify |

All terminal commands assume CWD `apps/desktop` unless noted.

---

### Task 1: Vitest test harness

**Files:**
- Create: `apps/desktop/vitest.config.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/electron/smoke.test.ts` (temporary)

- [ ] **Step 1: Install Vitest**

Run (in `apps/desktop`): `pnpm add -D vitest@^2`
Expected: `package.json` devDependencies gains `vitest`; lockfile updates.

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

// The electron sources import each other with `.js` specifiers (NodeNext style)
// while the files are `.ts`. extensionAlias makes Vite/Vitest resolve `./x.js`
// to `x.ts`, so tests can import exactly like the source does.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts'],
  },
  resolve: {
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
});
```

- [ ] **Step 3: Add the `test` script to `package.json`**

In `apps/desktop/package.json` `"scripts"`, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Keep tests out of the app typecheck**

In `apps/desktop/tsconfig.json`, add a sibling key to `compilerOptions` (top level of the JSON):
```json
"exclude": ["**/*.test.ts"]
```
(`tsc --noEmit` then won't require Vitest types in the app build.)

- [ ] **Step 5: Write a smoke test**

`apps/desktop/electron/smoke.test.ts`:
```ts
import { test, expect } from 'vitest';

test('vitest runs', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 6: Run it**

Run: `pnpm test`
Expected: 1 passed.

- [ ] **Step 7: Delete the smoke test, confirm typecheck still passes**

Run: `rm electron/smoke.test.ts && pnpm typecheck`
Expected: typecheck passes (no output / exit 0).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/vitest.config.ts apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/pnpm-lock.yaml pnpm-lock.yaml 2>/dev/null
git commit -m "test: add Vitest harness to desktop app"
```

---

### Task 2: Test fixtures + `execGit` + `resolveBaseBranch`

**Files:**
- Create: `apps/desktop/electron/test-helpers.ts`
- Modify: `apps/desktop/electron/git.ts`
- Create: `apps/desktop/electron/git.worktree.test.ts`

- [ ] **Step 1: Create the temp-repo fixture helper**

`apps/desktop/electron/test-helpers.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A temp git repo with one commit on `main`. Caller is responsible for cleanup. */
export function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mst-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** An empty temp dir. */
export function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'mst-'));
}
```

- [ ] **Step 2: Write the failing test for `resolveBaseBranch`**

`apps/desktop/electron/git.worktree.test.ts`:
```ts
import { describe, test, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { makeTempRepo, makeTempDir } from './test-helpers.js';
import { resolveBaseBranch } from './git.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function tmp(): string { const d = makeTempDir(); cleanup.push(d); return d; }

describe('resolveBaseBranch', () => {
  test('falls back to the current branch when there is no origin/HEAD', () => {
    expect(resolveBaseBranch(repo())).toBe('main');
  });
});
```
(`tmp` is used by later tasks in this file.)

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `resolveBaseBranch` is not exported from `./git.js`.

- [ ] **Step 4: Implement `execGit` + `resolveBaseBranch` in `git.ts`**

First extend the fs import at the top of `git.ts`:
```ts
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
```
Then append to `git.ts` (after `repoInfoAsync`):
```ts
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
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm test`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/test-helpers.ts apps/desktop/electron/git.ts apps/desktop/electron/git.worktree.test.ts
git commit -m "feat(git): execGit helper + resolveBaseBranch"
```

---

### Task 3: `addWorktree` + `listWorktrees`

**Files:**
- Modify: `apps/desktop/electron/git.ts`
- Modify: `apps/desktop/electron/git.worktree.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `git.worktree.test.ts` (and extend its import line to include the new symbols):
```ts
// extend the existing import:
//   import { resolveBaseBranch, addWorktree, listWorktrees } from './git.js';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('addWorktree / listWorktrees', () => {
  test('creates a new-branch worktree at the path and lists it', () => {
    const r = repo();
    const wt = path.join(tmp(), 'wt1');
    const res = addWorktree(r, wt, 'mochi/test-abcd', 'main');
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(wt, 'README.md'))).toBe(true);
    const entry = listWorktrees(r).find(w => path.resolve(w.path) === path.resolve(wt));
    expect(entry?.branch).toBe('mochi/test-abcd');
  });

  test('reuses an existing branch (no -b)', () => {
    const r = repo();
    execFileSync('git', ['-C', r, 'branch', 'mochi/existing'], { encoding: 'utf8' });
    const res = addWorktree(r, path.join(tmp(), 'wt'), 'mochi/existing', 'main');
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — `addWorktree`/`listWorktrees` not exported.

- [ ] **Step 3: Implement in `git.ts`**

Append:
```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/git.ts apps/desktop/electron/git.worktree.test.ts
git commit -m "feat(git): addWorktree + listWorktrees"
```

---

### Task 4: `removeWorktree`

**Files:**
- Modify: `apps/desktop/electron/git.ts`
- Modify: `apps/desktop/electron/git.worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `git.worktree.test.ts` (add `removeWorktree` to the `./git.js` import):
```ts
describe('removeWorktree', () => {
  test('removes the worktree dir and the branch when asked', () => {
    const r = repo();
    const wt = path.join(tmp(), 'wt');
    addWorktree(r, wt, 'mochi/gone', 'main');
    const res = removeWorktree(r, wt, { deleteBranch: 'mochi/gone' });
    expect(res.ok).toBe(true);
    expect(existsSync(wt)).toBe(false);
    const branches = execFileSync('git', ['-C', r, 'branch', '--list', 'mochi/gone'], { encoding: 'utf8' });
    expect(branches.trim()).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — `removeWorktree` not exported.

- [ ] **Step 3: Implement in `git.ts`**

Append:
```ts
/** Remove a worktree (force) + prune stale admin dirs; optionally delete its branch. */
export function removeWorktree(repoDir: string, wtPath: string, opts: { deleteBranch?: string } = {}): { ok: boolean; reason?: string } {
  const rm = execGit(['-C', repoDir, 'worktree', 'remove', '--force', wtPath]);
  execGit(['-C', repoDir, 'worktree', 'prune']);
  if (opts.deleteBranch) execGit(['-C', repoDir, 'branch', '-D', opts.deleteBranch]);
  if (!rm.ok && existsSync(wtPath)) return { ok: false, reason: rm.out.slice(0, 300) };
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/git.ts apps/desktop/electron/git.worktree.test.ts
git commit -m "feat(git): removeWorktree"
```

---

### Task 5: `copyGlobsInto`

**Files:**
- Modify: `apps/desktop/electron/git.ts`
- Modify: `apps/desktop/electron/git.worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Append (add `copyGlobsInto` to the import; add `writeFileSync, readFileSync` to the `node:fs` import in the test):
```ts
describe('copyGlobsInto', () => {
  test('copies matching gitignored files into the destination, skips non-matches', () => {
    const r = repo();
    const dest = tmp();
    writeFileSync(path.join(r, '.env'), 'SECRET=1\n');
    writeFileSync(path.join(r, '.env.local'), 'LOCAL=2\n');
    writeFileSync(path.join(r, 'keep.txt'), 'no\n');
    copyGlobsInto(r, dest, ['.env*']);
    expect(readFileSync(path.join(dest, '.env'), 'utf8')).toContain('SECRET=1');
    expect(readFileSync(path.join(dest, '.env.local'), 'utf8')).toContain('LOCAL=2');
    expect(existsSync(path.join(dest, 'keep.txt'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — `copyGlobsInto` not exported.

- [ ] **Step 3: Implement in `git.ts`**

Append:
```ts
/** Copy gitignored files (e.g. `.env*`, `config/*.local.json`) from a repo into a
    worktree. Last path segment may contain `*`. Best-effort; never throws. */
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
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/git.ts apps/desktop/electron/git.worktree.test.ts
git commit -m "feat(git): copyGlobsInto for gitignored files"
```

---

### Task 6: `ensureSessionWorktree`

**Files:**
- Create: `apps/desktop/electron/session-worktree.ts`
- Create: `apps/desktop/electron/session-worktree.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/electron/session-worktree.test.ts`:
```ts
import { describe, test, expect, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo, makeTempDir } from './test-helpers.js';
import { ensureSessionWorktree } from './session-worktree.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function tmp(): string { const d = makeTempDir(); cleanup.push(d); return d; }

describe('ensureSessionWorktree', () => {
  test('creates a worktree at root/projectId/sessionId and copies gitignored files', () => {
    const repoDir = repo(); const worktreeRoot = tmp();
    writeFileSync(path.join(repoDir, '.env'), 'X=1\n');
    const res = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12', copyGlobs: ['.env*'] });
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(res.cwd).toBe(path.join(worktreeRoot, 'p1', 's1'));
    expect(existsSync(path.join(res.cwd, 'README.md'))).toBe(true);
    expect(existsSync(path.join(res.cwd, '.env'))).toBe(true);
  });

  test('is idempotent — a second call resolves the same worktree without recreating', () => {
    const repoDir = repo(); const worktreeRoot = tmp();
    const first = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12' });
    const second = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.cwd).toBe(first.cwd);
  });

  test('runs the setup script when provided', () => {
    const repoDir = repo(); const worktreeRoot = tmp();
    const runSetup = vi.fn();
    ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's2', branch: 'mochi/foo-cd34', setupScript: 'echo hi', runSetup });
    expect(runSetup).toHaveBeenCalledOnce();
  });

  test('returns ok:false and falls back to the repo dir when the path is not a git repo', () => {
    const notRepo = tmp(); const worktreeRoot = tmp();
    const res = ensureSessionWorktree({ repoDir: notRepo, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/x-0000' });
    expect(res.ok).toBe(false);
    expect(res.cwd).toBe(notRepo);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — `./session-worktree.js` does not exist.

- [ ] **Step 3: Implement `session-worktree.ts`**

```ts
/* Per-session git worktree orchestration. Pure (git + fs only) so it unit-tests
   without Electron. The Electron caller (engine/dispatch) passes plain data and
   persists the resulting paths into the store. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { addWorktree, listWorktrees, removeWorktree, resolveBaseBranch, fetchOrigin, copyGlobsInto, isGitRepo } from './git.js';

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
  /** Injectable for tests; default runs the script in a login shell in the worktree. */
  runSetup?: (cwd: string, script: string) => void;
}

export interface EnsureWorktreeResult {
  ok: boolean;
  cwd: string;
  created: boolean;
  branch: string;
  base: string | null;
  reason?: string;
}

function defaultRunSetup(cwd: string, script: string): void {
  spawnSync('/bin/zsh', ['-lc', script], { cwd, stdio: 'ignore', timeout: 10 * 60 * 1000 });
}

/** Create-or-resolve this session's worktree. Idempotent. */
export function ensureSessionWorktree(opts: EnsureWorktreeOpts): EnsureWorktreeResult {
  const wtPath = path.join(opts.worktreeRoot, opts.projectId, opts.sessionId);

  // Already registered at that path → reuse it (no recreate).
  if (existsSync(wtPath) && listWorktrees(opts.repoDir).some(w => path.resolve(w.path) === path.resolve(wtPath))) {
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
  if (opts.copyGlobs?.length) copyGlobsInto(opts.repoDir, wtPath, opts.copyGlobs);
  if (opts.setupScript && opts.setupScript.trim()) (opts.runSetup ?? defaultRunSetup)(wtPath, opts.setupScript);

  return { ok: true, cwd: wtPath, created: true, branch: opts.branch, base };
}
```
(`fetchOrigin` is added in Task 6a below — implement it before running, or add now.)

- [ ] **Step 3a: Add `fetchOrigin` to `git.ts` (dependency of the orchestrator)**

Append to `git.ts`:
```ts
/** Best-effort `git fetch origin`. No-op (ok:false) when there's no origin remote. */
export function fetchOrigin(repoDir: string): { ok: boolean; reason?: string } {
  const remotes = execGit(['-C', repoDir, 'remote']);
  if (!remotes.ok || !remotes.out.split(/\s+/).includes('origin')) return { ok: false, reason: 'no origin remote' };
  const r = execGit(['-C', repoDir, 'fetch', '--prune', 'origin'], { timeout: 60_000 });
  return r.ok ? { ok: true } : { ok: false, reason: r.out.slice(0, 200) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS (all session-worktree tests + prior git tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/session-worktree.ts apps/desktop/electron/session-worktree.test.ts apps/desktop/electron/git.ts
git commit -m "feat: ensureSessionWorktree orchestration + fetchOrigin"
```

---

### Task 7: `pruneSessionWorktree`

**Files:**
- Modify: `apps/desktop/electron/session-worktree.ts`
- Modify: `apps/desktop/electron/session-worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Append (add `pruneSessionWorktree` to the import):
```ts
import { pruneSessionWorktree } from './session-worktree.js';

describe('pruneSessionWorktree', () => {
  test('removes the session worktree directory', () => {
    const repoDir = repo(); const worktreeRoot = tmp();
    const r = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12' });
    expect(existsSync(r.cwd)).toBe(true);
    const pr = pruneSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12', deleteBranch: true });
    expect(pr.ok).toBe(true);
    expect(existsSync(r.cwd)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — `pruneSessionWorktree` not exported.

- [ ] **Step 3: Implement in `session-worktree.ts`**

Append:
```ts
export function pruneSessionWorktree(opts: {
  repoDir: string; worktreeRoot: string; projectId: string; sessionId: string;
  branch?: string; deleteBranch?: boolean;
}): { ok: boolean; reason?: string } {
  const wtPath = path.join(opts.worktreeRoot, opts.projectId, opts.sessionId);
  return removeWorktree(opts.repoDir, wtPath, { deleteBranch: opts.deleteBranch ? opts.branch : undefined });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/session-worktree.ts apps/desktop/electron/session-worktree.test.ts
git commit -m "feat: pruneSessionWorktree"
```

---

### Task 8: Store data-model fields

**Files:**
- Modify: `apps/desktop/electron/store.ts`

- [ ] **Step 1: Add `Project` fields**

In `store.ts`, change the `Project` interface (currently ends `kind?: ProjectKind; path?: string; repoUrl?: string;`) to add:
```ts
  /** Worktree base branch override (else auto-detected from origin/HEAD). */
  defaultBaseBranch?: string;
  /** Shell script run once in each new session worktree (e.g. install deps). */
  setupScript?: string;
  /** Gitignored files copied into each new session worktree. Default ['.env*']. */
  copyGlobs?: string[];
```

- [ ] **Step 2: Add `ChatSession` fields**

In the `ChatSession` interface (after `branch?: string;`) add:
```ts
  /** Absolute path of this session's git worktree (Conductor-style isolation). */
  worktreePath?: string;
  /** The base branch this session's worktree was forked from. */
  baseBranch?: string;
  /** Set when the session's worktree has been pruned/archived. */
  archivedAt?: number;
```

- [ ] **Step 3: Widen `updateSession` to accept the new fields**

Change the `updateSession` signature (line ~674):
```ts
  updateSession(sessionId: string, patch: Partial<Pick<ChatSession, 'title' | 'sdkSessionId' | 'primary' | 'reviewer' | 'branch' | 'worktreePath' | 'baseBranch' | 'archivedAt'>>): ChatSession {
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: passes (exit 0).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/store.ts
git commit -m "feat(store): worktree + archive fields on Project/ChatSession"
```

---

### Task 9: Resolve a session's cwd to its worktree (engine)

**Files:**
- Modify: `apps/desktop/electron/engine.ts`

- [ ] **Step 1: Ensure imports**

In `engine.ts`, make sure these are imported (reconcile with the existing `./git.js` import line — `ensureBranch` is no longer needed here but stays exported for the fallback path):
```ts
import { branchSlug, isGitRepo } from './git.js';
import { ensureSessionWorktree, worktreeRootDir } from './session-worktree.js';
import type { ChatSession } from './store.js';
```
(If `ChatSession` is already imported, don't duplicate it.)

- [ ] **Step 2: Make `cwd` reassignable**

Change `const cwd = workDirFor(project);` (line ~1108) to:
```ts
let cwd = workDirFor(project);
```

- [ ] **Step 3: Replace the in-place branch block with worktree resolution**

Replace the existing block (lines ~1115–1122):
```ts
      // SP4 — branch-per-chat ... (the existing ensureBranch block)
      if (session && project?.path) {
        const want = session.branch ?? `mochi/${branchSlug(session.title)}-${session.id.slice(0, 4)}`;
        const res = ensureBranch(cwd, want);
        if (res.ok && session.branch !== want) { try { this.store.updateSession(session.id, { branch: want }); } catch { /* gone */ } }
      }
```
with:
```ts
      // Per-session worktree isolation (Conductor-style): each chat runs in its
      // OWN git worktree dir, so sessions are isolated and can run in parallel.
      // Best-effort — non-repo / failure falls back to the project folder.
      if (session && project?.path && isGitRepo(project.path)) {
        const branch = session.branch ?? `mochi/${branchSlug(session.title)}-${session.id.slice(0, 4)}`;
        const res = ensureSessionWorktree({
          repoDir: project.path,
          worktreeRoot: worktreeRootDir(),
          projectId: project.id,
          sessionId: session.id,
          branch,
          base: session.baseBranch,
          copyGlobs: project.copyGlobs,
          setupScript: project.setupScript,
          fetch: true,
        });
        if (res.ok) {
          cwd = res.cwd;
          const patch: Partial<Pick<ChatSession, 'branch' | 'worktreePath' | 'baseBranch'>> = {};
          if (session.branch !== branch) patch.branch = branch;
          if (session.worktreePath !== res.cwd) patch.worktreePath = res.cwd;
          if (res.base && session.baseBranch !== res.base) patch.baseBranch = res.base;
          if (Object.keys(patch).length) { try { this.store.updateSession(session.id, patch); } catch { /* gone */ } }
        }
      }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: passes. (If `ensureBranch` is now reported unused, remove it from the import.)

- [ ] **Step 5: Build (compiles the electron bundle via vite-plugin-electron)**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/engine.ts
git commit -m "feat(engine): run each chat session in its own git worktree"
```

---

### Task 10: Prune on delete + `archiveSession` dispatch + relay guard

**Files:**
- Modify: `apps/desktop/electron/localApi.ts`
- Modify: `apps/desktop/electron/main.ts`

- [ ] **Step 1: Import the orchestrator in `localApi.ts`**

Add near the other `./` imports:
```ts
import { pruneSessionWorktree, worktreeRootDir } from './session-worktree.js';
```

- [ ] **Step 2: Prune the worktree inside the existing `deleteSession` case**

Replace the current `case 'deleteSession':` block (lines ~256–260):
```ts
      case 'deleteSession': {
        store.deleteSession(String(p.id ?? ''));
        emit('session', { id: String(p.id ?? ''), deleted: true });
        return { ok: true };
      }
```
with:
```ts
      case 'deleteSession': {
        const s = store.getSession(String(p.id ?? ''));
        if (s?.worktreePath) {
          const proj = store.getProject(s.projectId);
          if (proj?.path) {
            try { pruneSessionWorktree({ repoDir: proj.path, worktreeRoot: worktreeRootDir(), projectId: proj.id, sessionId: s.id, branch: s.branch, deleteBranch: false }); } catch { /* best effort */ }
          }
        }
        store.deleteSession(String(p.id ?? ''));
        emit('session', { id: String(p.id ?? ''), deleted: true });
        return { ok: true };
      }
```

- [ ] **Step 3: Add the `archiveSession` case** (right after `pinSession`, line ~265):
```ts
      case 'archiveSession': {
        const s = store.getSession(String(p.sessionId ?? p.id ?? ''));
        if (!s) return bad('session not found', 404);
        const proj = store.getProject(s.projectId);
        if (proj?.path && s.worktreePath) {
          try { pruneSessionWorktree({ repoDir: proj.path, worktreeRoot: worktreeRootDir(), projectId: proj.id, sessionId: s.id, branch: s.branch, deleteBranch: p.deleteBranch === true }); } catch { /* best effort */ }
        }
        const updated = store.updateSession(s.id, { archivedAt: Date.now(), worktreePath: undefined });
        emit('session', updated);
        return updated;
      }
```

- [ ] **Step 4: Guard `archiveSession` from the relay**

In `main.ts`, in the `onCommand` denylist (the `if (method === 'getPairing' || …)` chain, ~line 356), add a clause:
```ts
        || method === 'archiveSession'
```
(It runs git on the Mac, like `snapshotProject` — desktop-only.)

- [ ] **Step 5: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/localApi.ts apps/desktop/electron/main.ts
git commit -m "feat(dispatch): prune worktree on delete + archiveSession (relay-guarded)"
```

---

### Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite**

Run: `pnpm test`
Expected: all tests pass (git.worktree + session-worktree).

- [ ] **Step 2: Typecheck + build the desktop app**

Run: `pnpm typecheck && pnpm build`
Expected: both succeed.

- [ ] **Step 3: Manual smoke (documented; requires the running app)**

Launch the desktop app, open a chat session inside a **git-repo** project, send one message. Verify:
- a directory appears at `~/Maestro/worktrees/<projectId>/<sessionId>` containing the repo's files;
- `git -C <project.path> worktree list` shows the new worktree on branch `mochi/<slug>-<id>`;
- the session's store entry has `worktreePath` + `baseBranch` set.
Then delete the session and confirm the worktree directory is gone.

- [ ] **Step 4: Final commit (if any docs/notes changed)**

```bash
git add -A && git commit -m "chore: phase 1 worktree isolation verified" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage (Phase 1 = spec §15 bullet 1):**
- Data-model fields (§4) → Task 8 ✓
- `git.ts` worktree functions (§5: addWorktree/removeWorktree/listWorktrees/resolveBaseBranch/fetchOrigin/copyGlobsInto) → Tasks 2–6 ✓ (aheadBehind/isDirty/pushBranch/parseGitHubRemote/mergeBase* are Phase 2, intentionally deferred)
- `ensureSessionWorktree` + engine hook (§8) → Tasks 6, 9 ✓
- Prune on `archiveSession` (§7 partial) + delete → Task 10 ✓
- Migration fallback (§10: non-repo / failure → project folder) → Task 9 (the `isGitRepo` guard + `res.ok` fallback) ✓
- Relay guard (§7) for `archiveSession` → Task 10 ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**3. Type consistency:** `ensureSessionWorktree`/`pruneSessionWorktree` signatures match between definition (Tasks 6–7) and call sites (Tasks 9–10). `worktreeRootDir()` defined in Task 6, used in Tasks 9–10. `updateSession` patch widened (Task 8) before new fields are written (Tasks 9–10). `WorktreeEntry`, `EnsureWorktreeResult` consistent. ✓

**Deferred to Phase 2 (not gaps):** PR detection/state machine, push/PR/merge/resolve dispatch + approval gate, `git-status` events + UI. The `GitService` class lands in Phase 2; Phase 1 deliberately uses standalone functions.

---

## Execution Handoff

Phase 1 is self-contained and shippable (true isolation, no PR features). Note: Task 1 introduces **Vitest** — flag if you'd prefer a different runner or none.
