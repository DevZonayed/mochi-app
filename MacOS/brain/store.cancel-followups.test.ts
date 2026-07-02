/* Tests for Store.cancelPendingFollowups — the cancel-on-user-reply path
   that fixes the "[Auto-continue]: fires even after I typed a real message"
   bug the operator hit.

   Before this fix, sendChat only called store.resetKeepGoingCounter(sessionId)
   — that ZEROED the streak counter but left the pending 'keep-going' row in
   the schedule list, fully armed. The cron runner then fired it anyway
   1-5 minutes later, even though the user had already replied. Operators
   saw "[Auto-continue] N/20" land AFTER their real message.

   The fix moves the disable-pending-followups call into the same point in
   sendChat where the counter resets, and this test pins the contract for it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-cancelflw-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

const PROMPT = '[Auto-continue]: keep going';
const ANSWER_PROMPT = '[User answered AskUserQuestion]: yes';
const future = (offsetMs: number) => Date.now() + offsetMs;

describe('Store.cancelPendingFollowups', () => {
  let s: Store;
  let projectId: string;
  let sessionId: string;
  beforeEach(() => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    s = new Store();
    const p = s.createProject({ name: 'Proj' });
    const sess = s.createSession(p.id, 'Chat');
    projectId = p.id; sessionId = sess.id;
  });

  it('returns [] when nothing is pending (no-op)', () => {
    expect(s.cancelPendingFollowups(sessionId)).toEqual([]);
  });

  it('disables a pending keep-going row and returns its id', () => {
    const armed = s.upsertKeepGoingForSession({
      sessionId, projectId, prompt: PROMPT,
      fireAt: future(60_000), maxPerSession: 20,
    });
    expect(armed.schedule!.enabled).toBe(true);
    const cancelled = s.cancelPendingFollowups(sessionId);
    expect(cancelled).toEqual([armed.schedule!.id]);
    // The row is still in the store (audit trail), just disabled — so the cron
    // runner skips it instead of firing.
    const after = s.listSchedules().find(x => x.id === armed.schedule!.id);
    expect(after?.enabled).toBe(false);
  });

  it('disables a pending auto-answer row too (both followup kinds)', () => {
    const sched = s.createSchedule({
      projectId, sessionId, kind: 'auto-answer',
      title: 'Auto-answer question', prompt: ANSWER_PROMPT,
      fireAt: future(60_000), armedAt: Date.now(), extends: 0,
    });
    const cancelled = s.cancelPendingFollowups(sessionId);
    expect(cancelled).toEqual([sched.id]);
    expect(s.listSchedules().find(x => x.id === sched.id)?.enabled).toBe(false);
  });

  it('disables BOTH a keep-going AND an auto-answer in a single call', () => {
    // Defense in depth: in practice the engine never arms both simultaneously
    // (armKeepGoing skips when armAsk fired), but the cancel function must
    // still clean the whole session — a stuck-row bug should be self-healing.
    const a = s.upsertKeepGoingForSession({
      sessionId, projectId, prompt: PROMPT,
      fireAt: future(60_000), maxPerSession: 20,
    });
    const b = s.createSchedule({
      projectId, sessionId, kind: 'auto-answer',
      title: 'Auto-answer question', prompt: ANSWER_PROMPT,
      fireAt: future(60_000), armedAt: Date.now(), extends: 0,
    });
    const cancelled = s.cancelPendingFollowups(sessionId);
    expect(new Set(cancelled)).toEqual(new Set([a.schedule!.id, b.id]));
  });

  it('does NOT touch followups from a DIFFERENT session', () => {
    const other = s.createSession(projectId, 'Other chat');
    const own = s.upsertKeepGoingForSession({
      sessionId, projectId, prompt: PROMPT,
      fireAt: future(60_000), maxPerSession: 20,
    });
    const theirs = s.upsertKeepGoingForSession({
      sessionId: other.id, projectId, prompt: PROMPT,
      fireAt: future(60_000), maxPerSession: 20,
    });
    s.cancelPendingFollowups(sessionId);
    // Ours is disabled
    expect(s.listSchedules().find(x => x.id === own.schedule!.id)?.enabled).toBe(false);
    // Theirs is untouched
    expect(s.listSchedules().find(x => x.id === theirs.schedule!.id)?.enabled).toBe(true);
  });

  it('does NOT touch user-authored "message" schedules or "retry-run" / "auto-continue"', () => {
    // Only the two AUTOPILOT followup kinds are cancelled. A user-scheduled
    // chat message, a usage-limit auto-continue, and a retry-run all stay
    // armed — those have their own lifecycle and the user reply doesn't
    // invalidate them.
    const userMsg = s.createSchedule({
      projectId, sessionId, kind: 'message',
      title: 'Send later', prompt: 'hello', fireAt: future(60_000),
    });
    const usageLimit = s.createSchedule({
      projectId, sessionId, kind: 'auto-continue',
      title: 'Continue when limit resets', prompt: 'continue', fireAt: future(60_000),
    });
    const retry = s.upsertRetryRunForKey({
      key: `session:${sessionId}`,
      sessionId, projectId, sourceJobId: 'j1', title: 'Auto-retry',
      prompt: 'p', fireAt: future(60_000), attempt: 1,
    });
    s.cancelPendingFollowups(sessionId);
    expect(s.listSchedules().find(x => x.id === userMsg.id)?.enabled).toBe(true);
    expect(s.listSchedules().find(x => x.id === usageLimit.id)?.enabled).toBe(true);
    expect(s.listSchedules().find(x => x.id === retry.schedule.id)?.enabled).toBe(true);
  });

  it('is idempotent — calling twice does not re-disable already-cancelled rows', () => {
    s.upsertKeepGoingForSession({
      sessionId, projectId, prompt: PROMPT,
      fireAt: future(60_000), maxPerSession: 20,
    });
    const first = s.cancelPendingFollowups(sessionId);
    expect(first.length).toBe(1);
    const second = s.cancelPendingFollowups(sessionId);
    // Second call sees no enabled rows -> returns empty without writing.
    expect(second).toEqual([]);
  });

  it('skips a followup row that already fired (lastRun set + fireAt in the past)', () => {
    // A genuine no-op: the schedule is conceptually "done", so disabling it
    // doesn't matter. We just don't want it cluttering the cancelled-id list.
    const sched = s.createSchedule({
      projectId, sessionId, kind: 'keep-going',
      title: 'Auto-continue', prompt: PROMPT,
      fireAt: Date.now() - 60_000, // 1 min ago
    });
    s.markScheduleRun(sched.id, Date.now() - 30_000, null);
    s.setScheduleEnabled(sched.id, false); // cron disables one-shots after firing
    expect(s.cancelPendingFollowups(sessionId)).toEqual([]);
  });
});

describe('Store.updateSession — autopilot + reviewerEnabled patches', () => {
  let s: Store;
  let sessionId: string;
  beforeEach(() => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    s = new Store();
    const p = s.createProject({ name: 'Proj' });
    sessionId = s.createSession(p.id, 'Chat').id;
  });

  it('persists autoPilot=true', () => {
    const updated = s.updateSession(sessionId, { autoPilot: true });
    expect(updated.autoPilot).toBe(true);
    // round-trip via a fresh read
    expect(s.getSession(sessionId)?.autoPilot).toBe(true);
  });

  it('persists reviewerEnabled=true', () => {
    const updated = s.updateSession(sessionId, { reviewerEnabled: true });
    expect(updated.reviewerEnabled).toBe(true);
    expect(s.getSession(sessionId)?.reviewerEnabled).toBe(true);
  });

  it('toggles are independent', () => {
    s.updateSession(sessionId, { autoPilot: true });
    expect(s.getSession(sessionId)?.reviewerEnabled).toBeUndefined();
    s.updateSession(sessionId, { reviewerEnabled: true });
    // setting reviewerEnabled does not clear autoPilot
    const ss = s.getSession(sessionId);
    expect(ss?.autoPilot).toBe(true);
    expect(ss?.reviewerEnabled).toBe(true);
  });
});
