/* Tests for the openProject lifecycle: pull memory + verify symlinks +
   debounced commit/push watcher on STATE changes. Real fs is used because
   the symlink + watcher behaviour we care about IS the OS-level behaviour.
   Git + the watcher start function are stubbed so the suite doesn't shell
   out and isn't flaky. */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openProjectMemory, closeMemoryWatcher, _resetWatchersForTesting,
} from './project-lifecycle.js';
import type { GitRunner } from './memory-repo.js';

function makeGit(opts: { fail?: { argsContain: string; throwMsg: string } } = {}): GitRunner & { calls: Array<{ dir: string; args: string[] }> } {
  const calls: Array<{ dir: string; args: string[] }> = [];
  return {
    calls,
    run: (dir, args) => {
      calls.push({ dir, args });
      if (opts.fail && args.some(a => a.includes(opts.fail!.argsContain))) throw new Error(opts.fail.throwMsg);
      return '';
    },
    clone: () => { /* not used */ },
  };
}

let scratch = '';
beforeEach(() => {
  scratch = path.join(tmpdir(), `maestro-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(scratch, { recursive: true });
  _resetWatchersForTesting();
});
afterEach(() => {
  _resetWatchersForTesting();
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* */ }
  vi.useRealTimers();
});

/** Seed a memory clone the way bootstrapProject would have. */
function seedClone(ud: string, slug: string): string {
  const memDir = path.join(ud, 'memory', slug);
  mkdirSync(path.join(memDir, '.git'), { recursive: true });
  mkdirSync(path.join(memDir, 'continuum'), { recursive: true });
  mkdirSync(path.join(memDir, 'claude', 'skills'), { recursive: true });
  writeFileSync(path.join(memDir, 'continuum', 'STATE.md'), '# init\n');
  writeFileSync(path.join(memDir, 'claude', 'CLAUDE.md'), '# c\n');
  writeFileSync(path.join(memDir, 'claude', 'settings.json'), '{}\n');
  return memDir;
}

describe('openProjectMemory', () => {
  test('first open: pulls, links the 4 symlinks, starts a watcher', async () => {
    seedClone(scratch, 'foo');
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    const git = makeGit();
    const started: string[] = [];
    const r = await openProjectMemory({
      slug: 'foo', projectPath: proj, gitRunner: git, userDataDir: scratch,
      startWatcher: (p) => { started.push(p); return { close: () => { /* */ } }; },
    });
    expect(r).toEqual({ pulled: true, conflictsResolved: 0, linked: true, watching: true });
    // Pull was run.
    expect(git.calls.some(c => c.args[0] === 'pull')).toBe(true);
    // Symlinks landed.
    expect(existsSync(path.join(proj, '.continuum'))).toBe(true);
    // The watcher was started on the EXPECTED STATE.md path inside userData.
    expect(started[0]).toBe(path.join(scratch, 'memory', 'foo', 'continuum', 'STATE.md'));
  });

  test('idempotent: re-opening the same project reuses the watcher', async () => {
    seedClone(scratch, 'foo');
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    let starts = 0;
    const startWatcher = () => { starts++; return { close: () => { /* */ } }; };
    await openProjectMemory({ slug: 'foo', projectPath: proj, gitRunner: makeGit(), userDataDir: scratch, startWatcher });
    await openProjectMemory({ slug: 'foo', projectPath: proj, gitRunner: makeGit(), userDataDir: scratch, startWatcher });
    expect(starts).toBe(1);
  });

  test('STATE change debounces 5s then commits + pushes (only once for bursts)', async () => {
    vi.useFakeTimers();
    seedClone(scratch, 'foo');
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    let captured: () => void = () => { /* */ };
    let commits = 0;
    await openProjectMemory({
      slug: 'foo', projectPath: proj, gitRunner: makeGit(), userDataDir: scratch,
      startWatcher: (_p, cb) => { captured = cb; return { close: () => { /* */ } }; },
      commitAndPush: async () => { commits++; return { pushed: true, sha: 'abc' }; },
    });
    // simulate a burst of STATE.md change notifications
    captured(); captured(); captured();
    // Hasn't fired yet (still inside the debounce window).
    expect(commits).toBe(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(commits).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(commits).toBe(1);
  });

  test('closeMemoryWatcher stops the watcher (and tears down its debounce timer)', async () => {
    seedClone(scratch, 'foo');
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    let closes = 0;
    await openProjectMemory({
      slug: 'foo', projectPath: proj, gitRunner: makeGit(), userDataDir: scratch,
      startWatcher: () => ({ close: () => { closes++; } }),
    });
    closeMemoryWatcher('foo');
    expect(closes).toBe(1);
    // re-opening should produce a fresh watcher
    let secondStarts = 0;
    await openProjectMemory({
      slug: 'foo', projectPath: proj, gitRunner: makeGit(), userDataDir: scratch,
      startWatcher: () => { secondStarts++; return { close: () => { /* */ } }; },
    });
    expect(secondStarts).toBe(1);
  });

  test('soft-fails pull errors so a flaky network doesn\'t block project open', async () => {
    seedClone(scratch, 'foo');
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    const git = makeGit({ fail: { argsContain: 'pull', throwMsg: 'fatal: unable to access — network down' } });
    const r = await openProjectMemory({
      slug: 'foo', projectPath: proj, gitRunner: git, userDataDir: scratch,
      startWatcher: () => ({ close: () => { /* */ } }),
    });
    // Pull failed but we still linked + started watching.
    expect(r.pulled).toBe(false);
    expect(r.linked).toBe(true);
    expect(r.watching).toBe(true);
  });

  test('symlink clobber → throws (project open MUST fail loud rather than lose data)', async () => {
    seedClone(scratch, 'foo');
    const proj = path.join(scratch, 'proj');
    mkdirSync(proj, { recursive: true });
    // pre-existing wrong symlink at .continuum
    const stray = path.join(scratch, 'stray');
    mkdirSync(stray, { recursive: true });
    symlinkSync(stray, path.join(proj, '.continuum'), 'dir');
    await expect(openProjectMemory({
      slug: 'foo', projectPath: proj, gitRunner: makeGit(), userDataDir: scratch,
      startWatcher: () => ({ close: () => { /* */ } }),
    })).rejects.toThrow(/symlink/i);
  });
});
