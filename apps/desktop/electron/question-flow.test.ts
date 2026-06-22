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
  const engine = { run } as unknown as LocalEngine;
  const emit = vi.fn();
  // media/research/publishing/telegram/whatsapp/providers aren't touched by these cases.
  const stub = {} as never;
  const dispatch = createDispatch(s, engine, stub, stub, stub, stub, stub, stub, emit);
  return { s, project, session, run, emit, dispatch };
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

  it('answerQuestion rejects an empty answer or unknown session', async () => {
    const { session, dispatch } = setup();
    await expect(dispatch('answerQuestion', { sessionId: session.id, answer: '   ' })).rejects.toThrow();
    await expect(dispatch('answerQuestion', { sessionId: 'nope', answer: 'x' })).rejects.toThrow();
  });
});
