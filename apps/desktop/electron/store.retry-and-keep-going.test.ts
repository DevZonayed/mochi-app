/* Store.upsertKeepGoingForSession + Store.upsertRetryRunForKey +
   recordRetryAttempt / resetRetryCounter / keepGoingCountFor.

   The contract these test:
   - keep-going coalesces per session (no duplicate rows on rapid re-emit) and
     respects the per-session cap, returning { capped:true } past it.
   - retry-run coalesces per source job + advances attempt counter linearly
     (1 → 2 → … → 10), and the counter RESETS on success for the same key
     (image_ni4jn.png: "if one is going well then reset the schedule
     increment mechanism").

   Only `app.getPath` is mocked so the Store reads/writes a tmp dir. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-retry-kg-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { RETRY_MAX_ATTEMPTS } from './retry-backoff.js';

const KEEP_GOING_PROMPT = '[Auto-continue]: continue from your outlined next steps.';
const future = (offsetMs: number) => Date.now() + offsetMs;

describe('Store.upsertKeepGoingForSession', () => {
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

  it('the FIRST call creates a row + bumps the per-session counter to 1', () => {
    const res = s.upsertKeepGoingForSession({
      sessionId, projectId, prompt: KEEP_GOING_PROMPT,
      fireAt: future(5 * 60_000), maxPerSession: 20,
    });
    expect(res.created).toBe(true);
    expect(res.capped).toBe(false);
    expect(res.attempt).toBe(1);
    expect(res.schedule!.kind).toBe('keep-going');
    expect(s.keepGoingCountFor(sessionId)).toBe(1);
  });

  it('a SECOND call within the wait window REUSES the row (does not double-bump)', () => {
    const a = s.upsertKeepGoingForSession({ sessionId, projectId, prompt: KEEP_GOING_PROMPT, fireAt: future(5 * 60_000), maxPerSession: 20 });
    const b = s.upsertKeepGoingForSession({ sessionId, projectId, prompt: KEEP_GOING_PROMPT, fireAt: future(5 * 60_000), maxPerSession: 20 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.schedule!.id).toBe(a.schedule!.id);
    // Counter stays at 1 — repeat re-emits inside the window are NOT new attempts.
    expect(s.keepGoingCountFor(sessionId)).toBe(1);
  });

  it('only ever bumps fireAt FORWARD on re-arm', () => {
    const early = future(60_000);
    const later = future(5 * 60_000);
    s.upsertKeepGoingForSession({ sessionId, projectId, prompt: KEEP_GOING_PROMPT, fireAt: later, maxPerSession: 20 });
    const r = s.upsertKeepGoingForSession({ sessionId, projectId, prompt: KEEP_GOING_PROMPT, fireAt: early, maxPerSession: 20 });
    expect(r.schedule!.fireAt).toBe(later);
  });

  it('refreshes the prompt to the latest organized form on re-arm', () => {
    s.upsertKeepGoingForSession({ sessionId, projectId, prompt: KEEP_GOING_PROMPT, fireAt: future(60_000), maxPerSession: 20 });
    const next = '[Auto-continue]: now with the bolded sprints captured.';
    const r = s.upsertKeepGoingForSession({ sessionId, projectId, prompt: next, fireAt: future(60_000), maxPerSession: 20 });
    expect(r.schedule!.prompt).toBe(next);
  });

  it('returns { capped: true } once the per-session cap is reached', () => {
    // Burn through 3 attempts (cap=3 in this test) — each FIRES inside the
    // engine path (we simulate that by disabling the row after creation so a
    // new arming creates a new one, just like cron disables one-shots).
    const max = 3;
    for (let i = 0; i < max; i++) {
      const r = s.upsertKeepGoingForSession({
        sessionId, projectId, prompt: KEEP_GOING_PROMPT,
        fireAt: future(5 * 60_000 * (i + 1)), maxPerSession: max,
      });
      expect(r.capped).toBe(false);
      s.setScheduleEnabled(r.schedule!.id, false); // simulate the cron firing + disabling it
    }
    const capped = s.upsertKeepGoingForSession({
      sessionId, projectId, prompt: KEEP_GOING_PROMPT,
      fireAt: future(60 * 60_000), maxPerSession: max,
    });
    expect(capped.capped).toBe(true);
    expect(capped.schedule).toBeNull();
  });

  it('resetKeepGoingCounter clears the streak (a real user reply landed)', () => {
    for (let i = 0; i < 3; i++) {
      const r = s.upsertKeepGoingForSession({
        sessionId, projectId, prompt: KEEP_GOING_PROMPT,
        fireAt: future(5 * 60_000 * (i + 1)), maxPerSession: 20,
      });
      s.setScheduleEnabled(r.schedule!.id, false);
    }
    expect(s.keepGoingCountFor(sessionId)).toBe(3);
    s.resetKeepGoingCounter(sessionId);
    expect(s.keepGoingCountFor(sessionId)).toBe(0);
  });

  it('DIFFERENT sessions each get their own keep-going row', () => {
    const second = s.createSession(projectId, 'Chat 2');
    s.upsertKeepGoingForSession({ sessionId, projectId, prompt: KEEP_GOING_PROMPT, fireAt: future(5 * 60_000), maxPerSession: 20 });
    s.upsertKeepGoingForSession({ sessionId: second.id, projectId, prompt: KEEP_GOING_PROMPT, fireAt: future(5 * 60_000), maxPerSession: 20 });
    expect(s.listSchedules().filter(x => x.kind === 'keep-going')).toHaveLength(2);
  });
});

describe('Store retry counter', () => {
  let s: Store;
  beforeEach(() => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    s = new Store();
  });

  it('recordRetryAttempt returns 1, 2, 3, … linearly', () => {
    expect(s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS)).toBe(1);
    expect(s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS)).toBe(2);
    expect(s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS)).toBe(3);
    expect(s.retryCountFor('session:abc')).toBe(3);
  });

  it('returns null once it would exceed the cap', () => {
    for (let i = 0; i < RETRY_MAX_ATTEMPTS; i++) {
      expect(s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS)).toBe(i + 1);
    }
    expect(s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS)).toBeNull();
    // Counter stays clamped at MAX (does not silently exceed).
    expect(s.retryCountFor('session:abc')).toBe(RETRY_MAX_ATTEMPTS);
  });

  it('resetRetryCounter restarts the streak from 1 (success path)', () => {
    s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS);
    s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS);
    s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS);
    s.resetRetryCounter('session:abc');
    expect(s.retryCountFor('session:abc')).toBe(0);
    expect(s.recordRetryAttempt('session:abc', RETRY_MAX_ATTEMPTS)).toBe(1);
  });

  it('counters are isolated per key (session A does NOT bleed into session B)', () => {
    s.recordRetryAttempt('session:A', RETRY_MAX_ATTEMPTS);
    s.recordRetryAttempt('session:A', RETRY_MAX_ATTEMPTS);
    expect(s.retryCountFor('session:B')).toBe(0);
    expect(s.recordRetryAttempt('session:B', RETRY_MAX_ATTEMPTS)).toBe(1);
  });
});

describe('Store.upsertRetryRunForKey', () => {
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

  it('creates a retry-run schedule wired to the source job', () => {
    const res = s.upsertRetryRunForKey({
      key: `session:${sessionId}`,
      sessionId,
      projectId,
      sourceJobId: 'job-failed-1',
      title: 'Auto-retry (1/10) in 1 min',
      prompt: 'original user prompt that failed',
      fireAt: future(60_000),
      attempt: 1,
    });
    expect(res.created).toBe(true);
    expect(res.schedule.kind).toBe('retry-run');
    expect(res.schedule.sourceJobId).toBe('job-failed-1');
    expect(res.schedule.retryAttempt).toBe(1);
    expect(res.schedule.sessionId).toBe(sessionId);
  });

  it('coalesces a second arm for the same source job (no duplicate rows)', () => {
    const a = s.upsertRetryRunForKey({ key: `session:${sessionId}`, sessionId, projectId, sourceJobId: 'job-1', title: 't', prompt: 'p', fireAt: future(60_000), attempt: 1 });
    const b = s.upsertRetryRunForKey({ key: `session:${sessionId}`, sessionId, projectId, sourceJobId: 'job-1', title: 't', prompt: 'p', fireAt: future(120_000), attempt: 2 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.schedule.id).toBe(a.schedule.id);
    // Later fireAt wins; attempt updated.
    expect(b.schedule.fireAt).toBe(b.schedule.fireAt);
    expect(b.schedule.retryAttempt).toBe(2);
    expect(s.listSchedules().filter(x => x.kind === 'retry-run')).toHaveLength(1);
  });

  it('the cron disabling the row lets a NEW retry be scheduled (after the previous fires)', () => {
    const a = s.upsertRetryRunForKey({ key: `session:${sessionId}`, sessionId, projectId, sourceJobId: 'job-1', title: 't', prompt: 'p', fireAt: future(60_000), attempt: 1 });
    s.setScheduleEnabled(a.schedule.id, false); // simulate the fire
    const b = s.upsertRetryRunForKey({ key: `session:${sessionId}`, sessionId, projectId, sourceJobId: 'job-1', title: 't', prompt: 'p', fireAt: future(120_000), attempt: 2 });
    expect(b.created).toBe(true);
    expect(b.schedule.id).not.toBe(a.schedule.id);
  });
});
