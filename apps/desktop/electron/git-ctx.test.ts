/* git-ctx — pure shim. Uses a real Store + a fake GitService double, so no
   network and no git calls. Tests the AVAILABILITY gating + the per-method
   wiring (each method routes to the right gitService call, with the correct
   session). */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeTempRepo } from './test-helpers.js';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-gitctx-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import type { GitService } from './git-service.js';
import { makeGitCtx, nextActionFor } from './git-ctx.js';

const cleanupRepos: string[] = [];
afterEach(() => { for (const d of cleanupRepos.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

function repo(): string { const d = makeTempRepo(); cleanupRepos.push(d); return d; }

/** Build a GitService double whose methods we can spy on. The shape mirrors the
    real class for the methods git-ctx exercises. */
function fakeGitService() {
  return {
    fullStatus: vi.fn(async () => ({
      sessionId: 'sess', branch: 'mochi/lyon/lyon', base: 'main',
      local: { isRepo: true, ahead: 2, behind: 0, dirty: false, pushed: false },
      pr: null,
      state: 'ready-to-push' as const,
      lastCheckedAt: Date.now(),
    })),
    pushSession:         vi.fn(async () => ({ ok: true })),
    createPr:            vi.fn(async () => ({ ok: true, url: 'https://github.com/x/y/pull/1', number: 1 })),
    mergePr:             vi.fn(async () => ({ ok: true })),
    resolveSession:      vi.fn(async () => ({ ok: true, conflicts: [] as string[] })),
    renameSessionBranch: vi.fn(async () => ({ ok: true, unchanged: true })),
  } as unknown as GitService;
}

describe('makeGitCtx', () => {
  test('returns null if the session id is unknown', () => {
    const ctx = makeGitCtx(new Store(), fakeGitService(), 'no-such-session');
    expect(ctx).toBeNull();
  });

  test('available() is FALSE without a branch / worktree / GitHub remote', () => {
    const s = new Store();
    const proj = s.createProject({ name: 'p' });
    const sess = s.createSession(proj.id, 'first message', 'lyon');
    const ctx = makeGitCtx(s, fakeGitService(), sess.id);
    expect(ctx?.available()).toBe(false);
  });

  test('available() is TRUE on a real worktree + GitHub remote', () => {
    const s = new Store();
    const r = repo();
    execFileSync('git', ['-C', r, 'remote', 'add', 'origin', 'https://github.com/me/proj.git'], { encoding: 'utf8' });
    const proj = s.createProject({ name: 'p', path: r });
    const sess = s.createSession(proj.id, 'first', 'lyon');
    s.updateSession(sess.id, { branch: 'mochi/lyon/lyon', worktreePath: r, baseBranch: 'main' });
    const ctx = makeGitCtx(s, fakeGitService(), sess.id);
    expect(ctx?.available()).toBe(true);
  });

  test('push/createPr/mergePr/resolveConflicts/renameBranch each route to the right gitService call', async () => {
    const s = new Store();
    const r = repo();
    execFileSync('git', ['-C', r, 'remote', 'add', 'origin', 'https://github.com/me/proj.git'], { encoding: 'utf8' });
    const proj = s.createProject({ name: 'p', path: r });
    const sess = s.createSession(proj.id, 'first', 'lyon');
    s.updateSession(sess.id, { branch: 'mochi/lyon/lyon', worktreePath: r, baseBranch: 'main' });
    const gs = fakeGitService();
    const ctx = makeGitCtx(s, gs, sess.id)!;

    await ctx.push();
    expect(gs.pushSession).toHaveBeenCalledTimes(1);
    expect((gs.pushSession as ReturnType<typeof vi.fn>).mock.calls[0][0].id).toBe(sess.id);

    await ctx.createPr({ title: 't', body: 'b' });
    expect(gs.createPr).toHaveBeenCalledTimes(1);
    expect((gs.createPr as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ title: 't', body: 'b' });

    await ctx.mergePr({ method: 'squash' });
    expect(gs.mergePr).toHaveBeenCalledTimes(1);
    expect((gs.mergePr as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ method: 'squash' });

    await ctx.resolveConflicts();
    expect(gs.resolveSession).toHaveBeenCalledTimes(1);

    await ctx.renameBranch();
    expect(gs.renameSessionBranch).toHaveBeenCalledTimes(1);
  });

  test('status() flattens the SessionGitStatus + adds a next-action hint', async () => {
    const s = new Store();
    const r = repo();
    execFileSync('git', ['-C', r, 'remote', 'add', 'origin', 'https://github.com/me/proj.git'], { encoding: 'utf8' });
    const proj = s.createProject({ name: 'p', path: r });
    const sess = s.createSession(proj.id, 'first', 'lyon');
    s.updateSession(sess.id, { branch: 'mochi/lyon/lyon', worktreePath: r, baseBranch: 'main' });
    const ctx = makeGitCtx(s, fakeGitService(), sess.id)!;
    const st = await ctx.status();
    expect(st.state).toBe('ready-to-push');
    expect(st.branch).toBe('mochi/lyon/lyon');
    expect(st.ahead).toBe(2);
    expect(st.pr).toBeNull();
    expect(st.nextAction).toMatch(/git_push/);
  });
});

describe('nextActionFor', () => {
  test('maps every state to a string hint', () => {
    const states: Array<Parameters<typeof nextActionFor>[0]> = [
      'no-repo', 'clean', 'uncommitted', 'ready-to-push', 'ready-for-pr',
      'pr-mergeable', 'pr-conflicts', 'pr-blocked', 'pr-merged', 'pr-closed',
    ];
    for (const ss of states) {
      const t = nextActionFor(ss);
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });
  test('ready-to-push hint mentions git_push', () => {
    expect(nextActionFor('ready-to-push')).toMatch(/git_push/);
  });
  test('pr-mergeable hint mentions pr_merge', () => {
    expect(nextActionFor('pr-mergeable')).toMatch(/pr_merge/);
  });
  test('pr-conflicts hint mentions pr_resolve_conflicts', () => {
    expect(nextActionFor('pr-conflicts')).toMatch(/pr_resolve_conflicts/);
  });
});
