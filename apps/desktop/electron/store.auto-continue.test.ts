/* Store.upsertAutoContinueForSession — keeps a SINGLE pending auto-continue
   per session so a chat with 4 queued messages that all hit the Claude
   usage limit doesn't end up with 4 collision-firing schedules at reset
   (see image_5zcze.png — exact bug we're guarding against here).

   Only `app.getPath` is mocked; the Store is real. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-autoct-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

const CONTINUE = 'Continues this chat when the limit resets';
const future = (offsetMs: number) => Date.now() + offsetMs;

describe('Store.upsertAutoContinueForSession', () => {
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

  it('the FIRST call creates a row and reports created=true', () => {
    const fireAt = future(60_000);
    const res = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt });
    expect(res.created).toBe(true);
    expect(res.schedule.kind).toBe('auto-continue');
    expect(res.schedule.sessionId).toBe(sessionId);
    expect(res.schedule.fireAt).toBe(fireAt);
    expect(s.listSchedules()).toHaveLength(1);
  });

  it('a SECOND call for the same session reuses the same row (created=false)', () => {
    // This is the exact image_5zcze.png bug: 4 queued messages each hit the
    // limit and each used to spawn its own row. Now they all coalesce.
    const fireAt = future(60_000);
    const a = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt });
    const b = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt });
    const c = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(c.created).toBe(false);
    expect(b.schedule.id).toBe(a.schedule.id);
    expect(c.schedule.id).toBe(a.schedule.id);
    expect(s.listSchedules()).toHaveLength(1);
  });

  it('bumps fireAt FORWARD when Claude reports a later reset', () => {
    // Sometimes the rate-limit reset shifts: a re-attempt comes back with a
    // bigger remaining window. We honor the LATER timestamp so we don't fire
    // prematurely and immediately re-hit.
    const early = future(60_000);
    const later = future(120_000);
    s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: early });
    const res = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: later });
    expect(res.schedule.fireAt).toBe(later);
    expect(res.schedule.nextRun).toBe(later);
  });

  it('does NOT pull fireAt backwards if a re-emit reports an earlier reset', () => {
    // Symmetric guard against a stale earlier reset overriding the later one.
    const early = future(60_000);
    const later = future(120_000);
    s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: later });
    const res = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: early });
    expect(res.schedule.fireAt).toBe(later);
  });

  it('DIFFERENT sessions each get their own schedule (no cross-session collision)', () => {
    const second = s.createSession(projectId, 'Chat 2');
    s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: future(60_000) });
    s.upsertAutoContinueForSession({ sessionId: second.id, projectId, prompt: CONTINUE, fireAt: future(60_000) });
    expect(s.listSchedules()).toHaveLength(2);
  });

  it('after the existing schedule already FIRED (in the past), creates a fresh row', () => {
    // The "still pending" guard is based on fireAt > now; once it's run, the
    // next limit-hit should be allowed to schedule a new continue.
    const old = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: future(60_000) });
    // Simulate that the prior schedule's fireAt has been bumped into the past
    // (the cron runner would have already fired it).
    s.updateSchedule(old.schedule.id, { fireAt: Date.now() - 10_000 });
    const next = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: future(60_000) });
    expect(next.created).toBe(true);
    expect(next.schedule.id).not.toBe(old.schedule.id);
  });

  it('a DISABLED auto-continue does not block a fresh one (user cancelled the old)', () => {
    const first = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: future(60_000) });
    s.setScheduleEnabled(first.schedule.id, false);
    const next = s.upsertAutoContinueForSession({ sessionId, projectId, prompt: CONTINUE, fireAt: future(60_000) });
    expect(next.created).toBe(true);
    expect(next.schedule.id).not.toBe(first.schedule.id);
  });
});
