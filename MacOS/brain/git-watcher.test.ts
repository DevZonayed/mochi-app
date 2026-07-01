/* GitWatcher — mocked `fs.watch` + faked GitService so the test is hermetic
   (no real watchers, no real git). Verifies: attach is idempotent, the four
   tracked files are watched, a burst of events coalesces into ONE
   `fullStatus` call after the debounce, branch change triggers re-attach,
   and detach closes every FSWatcher. */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';

import { makeTempRepo } from './test-helpers.js';
import { GitWatcher, resolveGitDir, commonGitDir, trackedFiles, type WatchFn } from './git-watcher.js';
import type { GitService } from './git-service.js';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-git-watcher-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

/** A fake fs.watch that records every file path it's asked to watch and lets
    tests trigger callbacks at will. Each watch returns a tiny EventEmitter-shaped
    object with a working close(). */
interface FakeWatch {
  watch: WatchFn;
  triggers: Map<string, () => void>;
  closed: Set<string>;
}
function fakeWatch(): FakeWatch {
  const triggers = new Map<string, () => void>();
  const closed = new Set<string>();
  const watch: WatchFn = (filename, listener) => {
    triggers.set(filename, () => listener('change', filename));
    const w = {
      close: () => { closed.add(filename); },
      on: () => w,
    } as unknown as FSWatcher;
    return w;
  };
  return { watch, triggers, closed };
}

function fakeGitService() {
  return {
    fullStatus: vi.fn(async () => ({
      sessionId: 'x', branch: null, base: null,
      local: { isRepo: true, ahead: 0, behind: 0, dirty: false, pushed: false },
      pr: null, state: 'clean' as const, lastCheckedAt: 0,
    })),
  } as unknown as GitService;
}

describe('resolveGitDir + trackedFiles', () => {
  test('main checkout: .git is a directory → returns it', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const gd = resolveGitDir(repo);
    expect(gd).toBe(path.join(repo, '.git'));
  });

  test('linked worktree: .git is a `gitdir: …` file → follows the pointer', () => {
    const wt = path.join('/tmp', `mst-fake-wt-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cleanup.push(wt);
    mkdirSync(wt, { recursive: true });
    const realGit = '/tmp/some/abs/.git/worktrees/wt1';
    writeFileSync(path.join(wt, '.git'), `gitdir: ${realGit}\n`);
    expect(resolveGitDir(wt)).toBe(realGit);
  });

  test('trackedFiles: HEAD + index + ORIG_HEAD + FETCH_HEAD + per-branch ref', () => {
    const files = trackedFiles('/.git', 'mochi/lyon/lyon');
    expect(files).toEqual([
      '/.git/HEAD', '/.git/index', '/.git/ORIG_HEAD', '/.git/FETCH_HEAD',
      '/.git/refs/heads/mochi/lyon/lyon',
    ]);
  });

  test('trackedFiles: no branch → skips the per-branch watcher', () => {
    expect(trackedFiles('/.git', null)).toEqual([
      '/.git/HEAD', '/.git/index', '/.git/ORIG_HEAD', '/.git/FETCH_HEAD',
    ]);
  });

  test('trackedFiles: WITH base → also watches refs/remotes/origin/<base>', () => {
    // *** The fix for "merge happened elsewhere, dock still says No changes" ***
    // origin/master moving (because another chat's PR merged, or the operator
    // merged via the browser) must trigger a recompute so the session's
    // `local.behind` updates without waiting for the 30-60s PR poller.
    const files = trackedFiles('/.git', 'mochi/lyon/lyon', 'master');
    expect(files).toContain('/.git/refs/remotes/origin/master');
  });

  test('trackedFiles: WITH base + commonDir → remote ref lives in commonDir', () => {
    // Linked worktrees share their refdb with the main repo via `commondir`.
    // The per-worktree gitdir does NOT carry refs/remotes — they live in the
    // common (main) gitdir. We must watch THERE, not in the worktree gitdir.
    const files = trackedFiles('/main/.git/worktrees/wt1', 'feat', 'master', '/main/.git');
    expect(files).toContain('/main/.git/refs/remotes/origin/master');
    // The per-worktree files (HEAD, index, FETCH_HEAD, per-branch ref) still
    // live in the per-worktree gitdir.
    expect(files).toContain('/main/.git/worktrees/wt1/HEAD');
    expect(files).toContain('/main/.git/worktrees/wt1/FETCH_HEAD');
    expect(files).toContain('/main/.git/worktrees/wt1/refs/heads/feat');
  });
});

describe('commonGitDir', () => {
  test('main checkout: no commondir file → returns the gitDir itself', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const gd = resolveGitDir(repo)!;
    expect(commonGitDir(gd)).toBe(gd);
  });

  test('linked worktree: reads commondir and resolves relative to gitDir', () => {
    // Fake a worktree gitdir layout: `<gitdir>/commondir` → relative path to
    // the main gitdir. This is exactly how `git worktree add` lays it out.
    const fakeGit = path.join('/tmp', `mst-wt-gitdir-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cleanup.push(fakeGit);
    mkdirSync(fakeGit, { recursive: true });
    writeFileSync(path.join(fakeGit, 'commondir'), '../..\n');
    expect(commonGitDir(fakeGit)).toBe(path.resolve(fakeGit, '../..'));
  });

  test('linked worktree (absolute commondir): respects the absolute path', () => {
    const fakeGit = path.join('/tmp', `mst-wt-gitdir-abs-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cleanup.push(fakeGit);
    mkdirSync(fakeGit, { recursive: true });
    writeFileSync(path.join(fakeGit, 'commondir'), '/srv/main/.git\n');
    expect(commonGitDir(fakeGit)).toBe('/srv/main/.git');
  });
});

describe('GitWatcher.attach', () => {
  test('no-op without a session', () => {
    const s = new Store();
    const fw = fakeWatch();
    const gs = fakeGitService();
    const w = new GitWatcher(s, gs, { watch: fw.watch });
    w.attach('nope');
    expect(w.size()).toBe(0);
    expect(fw.triggers.size).toBe(0);
  });

  test('no-op without a worktree path', () => {
    const s = new Store();
    const proj = s.createProject({ name: 'R' });
    const sess = s.createSession(proj.id, 'untitled');
    const fw = fakeWatch();
    const gs = fakeGitService();
    const w = new GitWatcher(s, gs, { watch: fw.watch });
    w.attach(sess.id);
    expect(w.size()).toBe(0);
  });

  test('attaches all four tracked files for a live worktree', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'main' });
    const fw = fakeWatch();
    const gs = fakeGitService();
    const w = new GitWatcher(s, gs, { watch: fw.watch });
    w.attach(sess.id);
    expect(w.size()).toBe(1);
    const want = trackedFiles(path.join(repo, '.git'), 'main');
    for (const f of want) expect(fw.triggers.has(f)).toBe(true);
  });

  test('idempotent: same branch/worktree → no extra watchers', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'main' });
    const fw = fakeWatch();
    const gs = fakeGitService();
    const w = new GitWatcher(s, gs, { watch: fw.watch });
    w.attach(sess.id);
    const before = fw.triggers.size;
    w.attach(sess.id);
    expect(fw.triggers.size).toBe(before);
    expect(w.size()).toBe(1);
  });

  test('branch change → re-attaches against the new ref path', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'main' });
    const fw = fakeWatch();
    const w = new GitWatcher(s, fakeGitService(), { watch: fw.watch });
    w.attach(sess.id);

    s.updateSession(sess.id, { branch: 'mochi/lyon/lyon' });
    w.attach(sess.id);
    expect(fw.triggers.has(path.join(repo, '.git', 'refs', 'heads', 'mochi/lyon/lyon'))).toBe(true);
    // The old per-branch ref watcher should be closed.
    expect(fw.closed.has(path.join(repo, '.git', 'refs', 'heads', 'main'))).toBe(true);
  });
});

describe('GitWatcher debounce + recompute', () => {
  test('a burst of file events coalesces into ONE fullStatus call', async () => {
    vi.useFakeTimers();
    try {
      const repo = makeTempRepo(); cleanup.push(repo);
      const s = new Store();
      const proj = s.createProject({ name: 'R', path: repo });
      const sess = s.createSession(proj.id, 'untitled');
      s.updateSession(sess.id, { worktreePath: repo, branch: 'main' });
      const fw = fakeWatch();
      const gs = fakeGitService();
      const w = new GitWatcher(s, gs, { watch: fw.watch, debounceMs: 50 });
      w.attach(sess.id);

      // Simulate a `git commit`: HEAD + index + refs all touched in <50ms.
      const gdir = path.join(repo, '.git');
      fw.triggers.get(path.join(gdir, 'HEAD'))?.();
      fw.triggers.get(path.join(gdir, 'index'))?.();
      fw.triggers.get(path.join(gdir, 'refs', 'heads', 'main'))?.();
      // Before the debounce fires: nothing yet.
      expect(gs.fullStatus).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60);
      expect(gs.fullStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('events split across the debounce window → TWO recomputes', async () => {
    vi.useFakeTimers();
    try {
      const repo = makeTempRepo(); cleanup.push(repo);
      const s = new Store();
      const proj = s.createProject({ name: 'R', path: repo });
      const sess = s.createSession(proj.id, 'untitled');
      s.updateSession(sess.id, { worktreePath: repo, branch: 'main' });
      const fw = fakeWatch();
      const gs = fakeGitService();
      const w = new GitWatcher(s, gs, { watch: fw.watch, debounceMs: 50 });
      w.attach(sess.id);

      fw.triggers.get(path.join(repo, '.git', 'HEAD'))?.();
      await vi.advanceTimersByTimeAsync(60);
      fw.triggers.get(path.join(repo, '.git', 'index'))?.();
      await vi.advanceTimersByTimeAsync(60);
      expect(gs.fullStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a recompute that throws does not kill the watcher', async () => {
    vi.useFakeTimers();
    try {
      const repo = makeTempRepo(); cleanup.push(repo);
      const s = new Store();
      const proj = s.createProject({ name: 'R', path: repo });
      const sess = s.createSession(proj.id, 'untitled');
      s.updateSession(sess.id, { worktreePath: repo, branch: 'main' });
      const fw = fakeWatch();
      const gs = { fullStatus: vi.fn(async () => { throw new Error('boom'); }) } as unknown as GitService;
      const w = new GitWatcher(s, gs, { watch: fw.watch, debounceMs: 10 });
      w.attach(sess.id);
      fw.triggers.get(path.join(repo, '.git', 'HEAD'))?.();
      await vi.advanceTimersByTimeAsync(20);
      // Second burst still fires another recompute after the first one threw.
      fw.triggers.get(path.join(repo, '.git', 'HEAD'))?.();
      await vi.advanceTimersByTimeAsync(20);
      expect((gs.fullStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GitWatcher.detach', () => {
  test('closes every watcher and removes the attachment', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'main' });
    const fw = fakeWatch();
    const w = new GitWatcher(s, fakeGitService(), { watch: fw.watch });
    w.attach(sess.id);
    expect(w.size()).toBe(1);

    w.detach(sess.id);
    expect(w.size()).toBe(0);
    // All four tracked files should be in the closed set.
    for (const f of trackedFiles(path.join(repo, '.git'), 'main')) {
      expect(fw.closed.has(f)).toBe(true);
    }
  });

  test('detachAll closes everything', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const a = s.createSession(proj.id, 'a');
    const b = s.createSession(proj.id, 'b');
    s.updateSession(a.id, { worktreePath: repo, branch: 'main' });
    s.updateSession(b.id, { worktreePath: repo, branch: 'main' });
    const fw = fakeWatch();
    const w = new GitWatcher(s, fakeGitService(), { watch: fw.watch });
    w.attach(a.id); w.attach(b.id);
    expect(w.size()).toBe(2);
    w.detachAll();
    expect(w.size()).toBe(0);
  });

  test('detach is idempotent (no throw on unknown session)', () => {
    const s = new Store();
    const w = new GitWatcher(s, fakeGitService(), { watch: fakeWatch().watch });
    expect(() => w.detach('nope')).not.toThrow();
  });
});

/* ── origin/<base> watcher + background fetch ───────────────────────────────
   The big one: "merge happened elsewhere, dock still says No changes" was
   the operator's headline complaint. The fix is two-part:
     (1) when refs/remotes/origin/<base> ticks (because git fetch landed a
         merge that happened in the browser, in another chat, or via the
         operator's PrActionConfirmDialog on another session), a status
         recompute fires inside the debounce window — no waiting on the
         30-60s PR poller.
     (2) the watcher kicks its own `git fetch --prune origin` on a 5-minute
         interval so the local refs stay fresh even when the operator never
         pulls manually.
   These tests pin both contracts. */
describe('GitWatcher origin/<base> tracking', () => {
  test('attach: when baseBranch is set, watches refs/remotes/origin/<base>', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'mochi/lyon/lyon', baseBranch: 'master' });
    const fw = fakeWatch();
    const w = new GitWatcher(s, fakeGitService(), { watch: fw.watch, fetchIntervalMs: 0 });
    w.attach(sess.id);
    expect(fw.triggers.has(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'master'))).toBe(true);
  });

  test('a write to refs/remotes/origin/<base> fires fullStatus (debounced)', async () => {
    vi.useFakeTimers();
    try {
      const repo = makeTempRepo(); cleanup.push(repo);
      const s = new Store();
      const proj = s.createProject({ name: 'R', path: repo });
      const sess = s.createSession(proj.id, 'untitled');
      s.updateSession(sess.id, { worktreePath: repo, branch: 'mochi/lyon/lyon', baseBranch: 'master' });
      const fw = fakeWatch();
      const gs = fakeGitService();
      const w = new GitWatcher(s, gs, { watch: fw.watch, debounceMs: 30, fetchIntervalMs: 0 });
      w.attach(sess.id);

      // Simulate `git fetch` updating origin/master (e.g. operator merged via
      // browser; another session's PR landed; periodic fetch picked it up).
      fw.triggers.get(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'master'))?.();
      expect(gs.fullStatus).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40);
      expect(gs.fullStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a write to FETCH_HEAD ALSO fires fullStatus (covers pruned/legacy ref shapes)', async () => {
    // FETCH_HEAD is our fallback signal — every `git fetch` touches it, so
    // even if the per-base ref didn't change (e.g. only origin/HEAD did, or
    // pruned remote branches), the recompute still runs.
    vi.useFakeTimers();
    try {
      const repo = makeTempRepo(); cleanup.push(repo);
      const s = new Store();
      const proj = s.createProject({ name: 'R', path: repo });
      const sess = s.createSession(proj.id, 'untitled');
      s.updateSession(sess.id, { worktreePath: repo, branch: 'main', baseBranch: 'main' });
      const fw = fakeWatch();
      const gs = fakeGitService();
      const w = new GitWatcher(s, gs, { watch: fw.watch, debounceMs: 30, fetchIntervalMs: 0 });
      w.attach(sess.id);

      fw.triggers.get(path.join(repo, '.git', 'FETCH_HEAD'))?.();
      await vi.advanceTimersByTimeAsync(40);
      expect(gs.fullStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('base change → re-attaches against the new origin/<base> ref', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'feat', baseBranch: 'master' });
    const fw = fakeWatch();
    const w = new GitWatcher(s, fakeGitService(), { watch: fw.watch, fetchIntervalMs: 0 });
    w.attach(sess.id);
    expect(fw.triggers.has(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'master'))).toBe(true);

    s.updateSession(sess.id, { baseBranch: 'develop' });
    w.attach(sess.id);
    expect(fw.triggers.has(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'develop'))).toBe(true);
    expect(fw.closed.has(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'master'))).toBe(true);
  });

  test('null base → no remote ref watcher (back-compat)', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'main' });
    const fw = fakeWatch();
    const w = new GitWatcher(s, fakeGitService(), { watch: fw.watch, fetchIntervalMs: 0 });
    w.attach(sess.id);
    expect(fw.triggers.has(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'master'))).toBe(false);
  });
});

describe('GitWatcher background fetch', () => {
  test('runFetchNow calls the fetch fn with the worktree path', async () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'feat', baseBranch: 'master' });
    const fetch = vi.fn(async () => { /* fast-path */ });
    const w = new GitWatcher(s, fakeGitService(), { watch: fakeWatch().watch, fetch, fetchIntervalMs: 0 });
    w.attach(sess.id);
    const ran = await w.runFetchNow(sess.id);
    expect(ran).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(repo);
  });

  test('runFetchNow is throttled by fetchMinGapMs', async () => {
    // Two back-to-back calls run the fetcher exactly once: the second is
    // suppressed by the min-gap guard. Prevents storms when the operator is
    // already pushing/pulling and our watchers caught the change.
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'feat', baseBranch: 'master' });
    const fetch = vi.fn(async () => { /* fast */ });
    const w = new GitWatcher(s, fakeGitService(), { watch: fakeWatch().watch, fetch, fetchIntervalMs: 0, fetchMinGapMs: 60_000 });
    w.attach(sess.id);
    await w.runFetchNow(sess.id);
    const second = await w.runFetchNow(sess.id);
    expect(second).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('fetchIntervalMs:0 disables the timer entirely (no spawn in tests)', () => {
    const repo = makeTempRepo(); cleanup.push(repo);
    const s = new Store();
    const proj = s.createProject({ name: 'R', path: repo });
    const sess = s.createSession(proj.id, 'untitled');
    s.updateSession(sess.id, { worktreePath: repo, branch: 'feat', baseBranch: 'master' });
    const fetch = vi.fn(async () => {});
    // Whatever interval triggers happen on this test runtime, fetch must not
    // be called automatically when interval is 0.
    const w = new GitWatcher(s, fakeGitService(), { watch: fakeWatch().watch, fetch, fetchIntervalMs: 0 });
    w.attach(sess.id);
    expect(fetch).not.toHaveBeenCalled();
    // detach is still clean (no fetch timer to clear).
    expect(() => w.detach(sess.id)).not.toThrow();
  });
});
