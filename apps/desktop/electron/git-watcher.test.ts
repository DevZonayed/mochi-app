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
import { GitWatcher, resolveGitDir, trackedFiles, type WatchFn } from './git-watcher.js';
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

  test('trackedFiles: HEAD + index + ORIG_HEAD + per-branch ref', () => {
    const files = trackedFiles('/.git', 'mochi/lyon/lyon');
    expect(files).toEqual([
      '/.git/HEAD', '/.git/index', '/.git/ORIG_HEAD', '/.git/refs/heads/mochi/lyon/lyon',
    ]);
  });

  test('trackedFiles: no branch → skips the per-branch watcher', () => {
    expect(trackedFiles('/.git', null)).toEqual(['/.git/HEAD', '/.git/index', '/.git/ORIG_HEAD']);
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
