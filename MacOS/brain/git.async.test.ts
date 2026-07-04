import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTempRepo } from './test-helpers.js';
import {
  aheadBehind, aheadBehindAsync,
  isDirty, isDirtyAsync,
  dirtyFileCount, dirtyFileCountAsync,
  lastCommitInfo, lastCommitInfoAsync,
  resolveBaseBranch, resolveBaseBranchAsync,
  localRefExists, localRefExistsAsync,
  execGitAsync, _activeGitCount,
  ensureMaestroExcludes,
} from './git.js';

/* The async git helpers are the new hot path (file-watcher recompute + overview
   lazy-fetch + the gentle reconcile run them instead of the synchronous twins,
   so a slow git call can't freeze the Node event loop). We drive real temp
   repos — same style as git.worktree/git.branches tests — and assert the async
   results MATCH their sync twins, plus that the concurrency semaphore actually
   bounds in-flight git processes. */

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

describe('async git helpers match their sync twins', () => {
  test('clean repo: ahead/behind, dirty, count, last commit, base, ref', async () => {
    const r = repo();
    expect(await aheadBehindAsync(r, 'main')).toEqual(aheadBehind(r, 'main'));
    expect(await isDirtyAsync(r)).toBe(isDirty(r));
    expect(await isDirtyAsync(r)).toBe(false);
    expect(await dirtyFileCountAsync(r)).toBe(dirtyFileCount(r));
    expect(await lastCommitInfoAsync(r)).toEqual(lastCommitInfo(r));
    expect(await resolveBaseBranchAsync(r)).toBe(resolveBaseBranch(r));
    expect(await localRefExistsAsync(r, 'main')).toBe(localRefExists(r, 'main'));
    expect(await localRefExistsAsync(r, 'no-such-ref')).toBe(false);
  });

  test('dirty + ahead repo: counts agree with sync twins', async () => {
    const r = repo();
    // One commit ahead of main's start, plus an uncommitted change.
    git(r, 'checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(r, 'a.txt'), 'one\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'feature commit');
    writeFileSync(path.join(r, 'b.txt'), 'uncommitted\n');

    expect(await aheadBehindAsync(r, 'main')).toEqual(aheadBehind(r, 'main'));
    expect((await aheadBehindAsync(r, 'main')).ahead).toBe(1);
    expect(await isDirtyAsync(r)).toBe(true);
    expect(await dirtyFileCountAsync(r)).toBe(dirtyFileCount(r));
    expect(await dirtyFileCountAsync(r)).toBeGreaterThan(0);
    expect((await lastCommitInfoAsync(r)).subject).toBe('feature commit');
  });

  test('non-repo path: async helpers degrade to safe defaults', async () => {
    const missing = '/this/path/does/not/exist/maestro-async-xyz';
    expect(await aheadBehindAsync(missing, 'main')).toEqual({ ahead: 0, behind: 0 });
    expect(await isDirtyAsync(missing)).toBe(false);
    expect(await dirtyFileCountAsync(missing)).toBe(0);
    expect(await lastCommitInfoAsync(missing)).toEqual({ subject: null, at: null });
    expect(await localRefExistsAsync(missing, 'main')).toBe(false);
  });
});

describe('ensureMaestroExcludes — the app\'s own droppings never read as dirty', () => {
  test('.continuum/.maestro stop counting toward dirty; real changes still do', async () => {
    const r = repo();
    // The app writes its per-project memory + design state — untracked.
    mkdirSync(path.join(r, '.continuum'), { recursive: true });
    writeFileSync(path.join(r, '.continuum', 'STATE.md'), 'memory\n');
    mkdirSync(path.join(r, '.maestro', 'design'), { recursive: true });
    writeFileSync(path.join(r, '.maestro', 'design', 'state.json'), '{}\n');
    expect(await isDirtyAsync(r)).toBe(true); // the pre-fix false "Uncommitted"

    await ensureMaestroExcludes(r);
    expect(await isDirtyAsync(r)).toBe(false);
    expect(await dirtyFileCountAsync(r)).toBe(0);

    // A REAL change must still register — the exclude hides only our folders.
    writeFileSync(path.join(r, 'work.txt'), 'real work\n');
    expect(await isDirtyAsync(r)).toBe(true);
    expect(await dirtyFileCountAsync(r)).toBe(1);
  });

  test('idempotent: a second run appends nothing', async () => {
    const r = repo();
    await ensureMaestroExcludes(r);
    const file = path.join(r, '.git', 'info', 'exclude');
    const once = readFileSync(file, 'utf8');
    await ensureMaestroExcludes(r);
    expect(readFileSync(file, 'utf8')).toBe(once);
    expect((once.match(/^\.continuum$/gm) ?? []).length).toBe(1);
  });

  test('worktree + SYMLINK (the reported shape): a dir-only `.continuum/` entry is not enough', async () => {
    // Session worktrees hold `.continuum` as a symlink to the project's folder.
    // A trailing-slash gitignore pattern matches DIRECTORIES only — so the
    // pre-existing `.continuum/` exclude line left the chip on "Uncommitted".
    const r = repo();
    const wt = path.join(tmpdir(), `maestro-excl-wt-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cleanup.push(wt);
    git(r, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
    mkdirSync(path.join(r, '.continuum'), { recursive: true });
    writeFileSync(path.join(r, '.continuum', 'STATE.md'), 'memory\n');
    symlinkSync(path.join(r, '.continuum'), path.join(wt, '.continuum'));
    // Seed the OLD dir-only entry — proves it does NOT cover the symlink.
    mkdirSync(path.join(r, '.git', 'info'), { recursive: true });
    writeFileSync(path.join(r, '.git', 'info', 'exclude'), '.continuum/\n');
    expect(await isDirtyAsync(wt)).toBe(true); // the bug: still "Uncommitted"

    // `--git-path info/exclude` resolves to the COMMON dir → one write covers all.
    await ensureMaestroExcludes(wt);
    expect(await isDirtyAsync(wt)).toBe(false);
    expect(await isDirtyAsync(r)).toBe(false);
  });

  test('non-repo path: no throw, no effect', async () => {
    await expect(ensureMaestroExcludes('/this/path/does/not/exist/maestro-excl-xyz')).resolves.toBeUndefined();
  });
});

describe('execGitAsync concurrency semaphore', () => {
  test('never exceeds the in-flight cap under a burst, and all calls resolve', async () => {
    const r = repo();
    let peak = 0;
    const sampler = setInterval(() => { peak = Math.max(peak, _activeGitCount()); }, 1);

    // Fire far more concurrent git reads than the cap; the semaphore must queue
    // the overflow so the live count never crosses MAX_CONCURRENT_GIT (8).
    const calls = Array.from({ length: 40 }, () =>
      execGitAsync(['-C', r, 'rev-parse', 'HEAD']),
    );
    const results = await Promise.all(calls);
    clearInterval(sampler);

    expect(results.every(x => x.ok)).toBe(true);
    expect(peak).toBeLessThanOrEqual(8);
    // The semaphore must fully drain once the burst settles.
    expect(_activeGitCount()).toBe(0);
  });
});
