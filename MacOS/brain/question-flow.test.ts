/* AskUserQuestion follow-up — integration through the REAL localApi dispatch +
   Store. Only `electron` and the engine are mocked; answerQuestion / extendQuestion
   run the production code paths the UI buttons hit. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-question-flow-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';
import { createDispatch } from './localApi.js';
import { ANSWER_PREFIX } from './ask-question.js';
import type { LocalEngine } from './engine.js';

function setup() {
  const s = new Store();
  const project = s.createProject({ name: 'Proj' });
  const session = s.createSession(project.id, 'Chat');
  const run = vi.fn().mockResolvedValue(undefined);
  // Overlap guard (image_hx5ow.png): answerQuestion now checks whether the asking
  // turn is STILL live and steers into it instead of spawning a parallel run.
  const isRunning = vi.fn().mockReturnValue(false);
  const steer = vi.fn().mockResolvedValue({ steered: true });
  const cancel = vi.fn().mockReturnValue(null);
  const engine = { run, isRunning, steer, cancel } as unknown as LocalEngine;
  const emit = vi.fn();
  // media/research/publishing/telegram/whatsapp/providers aren't touched by these cases.
  const stub = {} as never;
  const dispatch = createDispatch(s, engine, stub, stub, stub, stub, stub, stub, emit);
  return { s, project, session, run, isRunning, steer, cancel, emit, dispatch };
}

/** Mirror what engine.armAskFollowup does after a turn ends on an unanswered ask. */
function armAuto(s: Store, projectId: string, sessionId: string) {
  const now = Date.now();
  return s.createSchedule({
    projectId, sessionId, kind: 'auto-answer',
    title: 'Auto-answer question', prompt: `${ANSWER_PREFIX} Use a recommended default`,
    fireAt: now + 5 * 60_000, armedAt: now, extends: 0,
  });
}

describe('question flow — answer/extend via real dispatch', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('answerQuestion sends the prefixed answer, cancels the countdown, runs the engine', async () => {
    const { s, project, session, run, dispatch } = setup();
    armAuto(s, project.id, session.id);

    const job = await dispatch('answerQuestion', { sessionId: session.id, answer: 'Pick a stack now' }) as { input: string; sessionId?: string };

    expect(job.input).toBe(`${ANSWER_PREFIX} Pick a stack now`);
    expect(job.sessionId).toBe(session.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.listSchedules().some(x => x.kind === 'auto-answer')).toBe(false); // countdown cancelled
  });

  it('extendQuestion escalates +5 then +10, then pauses past the 30-min cap', async () => {
    const { s, project, session, dispatch } = setup();
    const armed = armAuto(s, project.id, session.id);
    const armedAt = armed.armedAt!;

    const e1 = await dispatch('extendQuestion', { sessionId: session.id }) as { extends: number; fireAt: number };
    expect(e1.extends).toBe(1);
    // Base shifted 5min → 1min in the 2026 autopilot redesign; +5min step
    // unchanged. So 1st extend = base(1) + 5 = 6 min from armedAt.
    expect(e1.fireAt - armedAt).toBe(6 * 60_000);

    const e2 = await dispatch('extendQuestion', { sessionId: session.id }) as { extends: number; fireAt: number };
    expect(e2.extends).toBe(2);
    // 2nd extend = base(1) + 5 + 10 = 16 min
    expect(e2.fireAt - armedAt).toBe(16 * 60_000);

    const e3 = await dispatch('extendQuestion', { sessionId: session.id }) as { paused?: boolean };
    expect(e3.paused).toBe(true);                    // + 15 would be 35m > 30m cap → graceful pause
  });

  it('a paused question can no longer be extended', async () => {
    const { s, project, session, dispatch } = setup();
    const armed = armAuto(s, project.id, session.id);
    s.updateSchedule(armed.id, { paused: true });
    await expect(dispatch('extendQuestion', { sessionId: session.id })).rejects.toThrow();
  });

  it('answerQuestion STEERS into a still-live asking turn instead of spawning a parallel run', async () => {
    const { s, project, session, run, isRunning, steer, dispatch } = setup();
    armAuto(s, project.id, session.id);
    // The asking turn is still generating (the SDK dismissed the AskUserQuestion
    // and the model kept thinking) — the reported overlap scenario.
    const asking = s.createJob(project.id, 'build a portfolio', 'build a portfolio', undefined, session.id);
    s.updateJob(asking.id, { status: 'running' });
    isRunning.mockImplementation((id: string) => id === asking.id);

    const jobsBefore = s.listJobs(undefined, session.id).length;
    const out = await dispatch('answerQuestion', { sessionId: session.id, answer: 'Full multipage' }) as { id: string };

    expect(steer).toHaveBeenCalledWith(asking.id, `${ANSWER_PREFIX} Full multipage`, { interrupt: false });
    expect(out.id).toBe(asking.id);                                   // the LIVE turn is the answer's home
    expect(run).not.toHaveBeenCalled();                               // NO second concurrent run
    expect(s.listJobs(undefined, session.id).length).toBe(jobsBefore); // no extra job row
    expect(s.listSchedules().some(x => x.kind === 'auto-answer')).toBe(false); // countdown still cancelled
  });

  it('answerQuestion cancels a live-but-unsteerable turn before running the answer (no overlap)', async () => {
    const { s, project, session, run, isRunning, steer, cancel, dispatch } = setup();
    const asking = s.createJob(project.id, 'ask', 'ask', undefined, session.id);
    s.updateJob(asking.id, { status: 'running' });
    isRunning.mockImplementation((id: string) => id === asking.id);
    steer.mockResolvedValue({ steered: false }); // codex / plan-mode: no steer channel

    const out = await dispatch('answerQuestion', { sessionId: session.id, answer: 'Option B' }) as { id: string; input: string };

    expect(cancel).toHaveBeenCalledWith(asking.id);   // stale turn stopped first…
    expect(out.id).not.toBe(asking.id);               // …then the answer runs as its own turn
    expect(out.input).toBe(`${ANSWER_PREFIX} Option B`);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answerQuestion rejects an empty answer or unknown session', async () => {
    const { session, dispatch } = setup();
    await expect(dispatch('answerQuestion', { sessionId: session.id, answer: '   ' })).rejects.toThrow();
    await expect(dispatch('answerQuestion', { sessionId: 'nope', answer: 'x' })).rejects.toThrow();
  });
});
