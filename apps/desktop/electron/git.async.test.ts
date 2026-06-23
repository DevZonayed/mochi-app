import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
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
