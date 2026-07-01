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
import { makeGitCtx, nextActionFor, isNeedsConfirm } from './git-ctx.js';

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
    previewMergePr:      vi.fn(async () => ({
      ok: true as const,
      preview: {
        prNumber: 42, prTitle: 'feat: x', prUrl: 'https://github.com/x/y/pull/42',
        mergeMethod: 'squash' as const, headSha: 'abc1234',
        mergeable: true, mergeableState: 'clean' as const, checks: [],
      },
    })),
    previewResolveSession: vi.fn(async () => ({
      ok: true as const,
      preview: {
        prNumber: 42, prTitle: 'feat: x', prUrl: 'https://github.com/x/y/pull/42',
        base: 'main', branch: 'mochi/lyon/lyon', conflictedFiles: [] as string[],
      },
    })),
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

  test('push/createPr route to the right gitService call', async () => {
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

    await ctx.renameBranch();
    expect(gs.renameSessionBranch).toHaveBeenCalledTimes(1);
  });

  /* ── HUMAN-CONFIRM GATE + TRIPWIRE — pr_merge + pr_resolve_conflicts ─────
     The contract: GitCtx (the agent surface) ALWAYS returns a preview and
     NEVER calls the destructive gitService method. Even if a `confirmed:
     true` flag arrives — which only the renderer should ever set, and the
     renderer bypasses GitCtx entirely via the IPC handler — we strip + log
     + fall through to preview. This is the defense-in-depth check that
     stops the "agent invented `confirmed:true` and squash-merged 11 PRs"
     incident from being repeatable. */
  function setupRepoCtx() {
    const s = new Store();
    const r = repo();
    execFileSync('git', ['-C', r, 'remote', 'add', 'origin', 'https://github.com/me/proj.git'], { encoding: 'utf8' });
    const proj = s.createProject({ name: 'p', path: r });
    const sess = s.createSession(proj.id, 'first', 'lyon');
    s.updateSession(sess.id, { branch: 'mochi/lyon/lyon', worktreePath: r, baseBranch: 'main' });
    const gs = fakeGitService();
    const ctx = makeGitCtx(s, gs, sess.id)!;
    return { gs, ctx };
  }

  test('mergePr WITHOUT confirmed → returns needsConfirm + does NOT call GitHub', async () => {
    const { gs, ctx } = setupRepoCtx();
    const r = await ctx.mergePr({ method: 'squash' });
    expect(isNeedsConfirm(r)).toBe(true);
    if (isNeedsConfirm(r)) {
      expect(r.action).toBe('pr_merge');
      expect(r.preview.prNumber).toBe(42);
      expect(r.preview.mergeMethod).toBe('squash');
    }
    expect(gs.previewMergePr).toHaveBeenCalledTimes(1);
    expect(gs.mergePr).not.toHaveBeenCalled();
  });

  test('TRIPWIRE: mergePr WITH confirmed:true is REFUSED — never lands the merge', async () => {
    // The agent might invent `confirmed:true` (the model has seen the schema).
    // Even then we strip it, log a warning, and fall through to the preview
    // gate. The destructive `gs.mergePr` must NEVER be called from GitCtx —
    // only the renderer's IPC handler in localApi.ts may invoke it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { gs, ctx } = setupRepoCtx();
      const r = await ctx.mergePr({ method: 'squash', confirmed: true });
      // Behaves exactly like an agent call WITHOUT the flag — preview + needsConfirm.
      expect(isNeedsConfirm(r)).toBe(true);
      if (isNeedsConfirm(r)) {
        expect(r.action).toBe('pr_merge');
        expect(r.preview.mergeMethod).toBe('squash');
      }
      expect(gs.previewMergePr).toHaveBeenCalledTimes(1);
      expect(gs.mergePr).not.toHaveBeenCalled();
      // Tripwire surfaced a loud warning naming the offending flag.
      expect(warn).toHaveBeenCalled();
      const msg = warn.mock.calls[0]?.[0] as string | undefined;
      expect(msg).toMatch(/TRIPWIRE/);
      expect(msg).toMatch(/confirmed:true/);
    } finally {
      warn.mockRestore();
    }
  });

  test('resolveConflicts WITHOUT confirmed → returns needsConfirm + does NOT touch worktree', async () => {
    const { gs, ctx } = setupRepoCtx();
    const r = await ctx.resolveConflicts();
    expect(isNeedsConfirm(r)).toBe(true);
    if (isNeedsConfirm(r)) {
      expect(r.action).toBe('pr_resolve_conflicts');
      expect(r.preview.branch).toBe('mochi/lyon/lyon');
    }
    expect(gs.previewResolveSession).toHaveBeenCalledTimes(1);
    expect(gs.resolveSession).not.toHaveBeenCalled();
  });

  test('TRIPWIRE: resolveConflicts WITH confirmed:true is REFUSED — never touches worktree', async () => {
    // Same shape as the mergePr tripwire — agent surface never executes,
    // even when the flag is set.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { gs, ctx } = setupRepoCtx();
      const r = await ctx.resolveConflicts({ confirmed: true });
      expect(isNeedsConfirm(r)).toBe(true);
      expect(gs.previewResolveSession).toHaveBeenCalledTimes(1);
      expect(gs.resolveSession).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls[0]?.[0]).toMatch(/TRIPWIRE/);
    } finally {
      warn.mockRestore();
    }
  });

  test('preview failure surfaces as ok:false with the reason (no GitHub call)', async () => {
    const s = new Store();
    const r = repo();
    execFileSync('git', ['-C', r, 'remote', 'add', 'origin', 'https://github.com/me/proj.git'], { encoding: 'utf8' });
    const proj = s.createProject({ name: 'p', path: r });
    const sess = s.createSession(proj.id, 'first', 'lyon');
    s.updateSession(sess.id, { branch: 'mochi/lyon/lyon', worktreePath: r, baseBranch: 'main' });
    const gs = fakeGitService();
    (gs.previewMergePr as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, reason: 'no open PR for this session' });
    const ctx = makeGitCtx(s, gs, sess.id)!;
    const res = await ctx.mergePr();
    expect(isNeedsConfirm(res)).toBe(false);
    if (!isNeedsConfirm(res)) {
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('no open PR for this session');
    }
    expect(gs.mergePr).not.toHaveBeenCalled();
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
  test('pr-merged hint explains the squash-merge cleanup path', () => {
    // The bug we fixed: after squash-merge the branch shows "ahead" with
    // different SHAs and the user wonders what to do. The hint must
    // mention BOTH the reset path and the archive path so the agent (and
    // a human reading the message) has actionable next steps.
    const hint = nextActionFor('pr-merged');
    expect(hint).toMatch(/reset/i);
    expect(hint).toMatch(/archive/i);
    expect(hint).toMatch(/squash/i); // mentions the underlying mechanism
  });
});
