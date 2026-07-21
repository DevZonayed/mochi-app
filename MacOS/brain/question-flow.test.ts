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
function armAuto(s: Store, projectId: string, sessionId: string, sourceJobId?: string) {
  const now = Date.now();
  return s.createSchedule({
    projectId, sessionId, kind: 'auto-answer',
    title: 'Auto-answer question', prompt: `${ANSWER_PREFIX} Use a recommended default`,
    questionAsk: JSON.stringify({ questions: [{ question: 'Choose?', options: [{ label: 'Recommended' }, { label: 'Manual' }] }] }),
    fireAt: now + 5 * 60_000, armedAt: now, extends: 0,
    sourceJobId,
    ...(sourceJobId ? { intent: s.getJob(sourceJobId)?.intent } : {}),
  });
}

describe('question flow — answer/extend via real dispatch', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('answerQuestion sends the prefixed answer, cancels the countdown, runs the engine', async () => {
    const { s, project, session, run, dispatch } = setup();
    const asking = s.createJob(project.id, 'ask', 'ask', undefined, session.id, undefined, undefined, undefined, { effort: 'deep', goal: true, plan: false, browser: false, reviewer: 'off' });
    armAuto(s, project.id, session.id, asking.id);

    const job = await dispatch('answerQuestion', { sessionId: session.id, answer: 'Pick a stack now' }) as { input: string; sessionId?: string };

    expect(job.input).toBe(`${ANSWER_PREFIX} Pick a stack now`);
    expect(job.sessionId).toBe(session.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.any(String), {});
    expect(s.listSchedules().some(x => x.kind === 'auto-answer' && x.enabled)).toBe(false); // countdown cancelled
  });

  it('answerQuestion inherits only the exact source job intent', async () => {
    const { s, project, session, run, dispatch } = setup();
    const first = s.createJob(project.id, 'first ask', 'first ask', undefined, session.id, undefined, undefined, undefined, { effort: 'deep', goal: true, plan: false, browser: false, reviewer: 'off' });
    const second = s.createJob(project.id, 'second ask', 'second ask', undefined, session.id, undefined, undefined, undefined, { effort: 'fast', goal: false, plan: true, browser: true, reviewer: { engine: 'codex', model: 'gpt-5' } });
    armAuto(s, project.id, session.id, second.id);

    const answer = await dispatch('answerQuestion', { sessionId: session.id, answer: 'Answer second first' }) as { id: string };

    expect(s.getJob(answer.id)?.intent).toEqual(second.intent);
    expect(s.getJob(answer.id)?.intent).not.toEqual(first.intent);
    expect(run).toHaveBeenCalledWith(answer.id, {});
  });

  it('answers two same-session questions out of order by exact sourceJobId', async () => {
    const { s, project, session, run, dispatch } = setup();
    const first = s.createJob(project.id, 'first ask', 'first ask', undefined, session.id, undefined, undefined, undefined, { effort: 'deep', goal: true, plan: false, browser: false, reviewer: 'off' });
    const second = s.createJob(project.id, 'second ask', 'second ask', undefined, session.id, undefined, undefined, undefined, { effort: 'fast', goal: false, plan: true, browser: true, reviewer: { engine: 'codex', model: 'gpt-5' } });
    const firstQuestion = armAuto(s, project.id, session.id, first.id);
    const secondQuestion = armAuto(s, project.id, session.id, second.id);

    const answerB = await dispatch('answerQuestion', { sessionId: session.id, sourceJobId: second.id, answer: 'B first' }) as { id: string };

    expect(s.getJob(answerB.id)?.intent).toEqual(second.intent);
    expect(s.listSchedules().find(x => x.id === secondQuestion.id)?.enabled).toBe(false);
    expect(s.listSchedules().find(x => x.id === firstQuestion.id)?.enabled).toBe(true);

    const answerA = await dispatch('answerQuestion', { sessionId: session.id, sourceJobId: first.id, answer: 'A second' }) as { id: string };

    expect(s.getJob(answerA.id)?.intent).toEqual(first.intent);
    expect(s.listSchedules().some(x => x.kind === 'auto-answer' && x.sessionId === session.id && x.enabled)).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, answerB.id, {});
    expect(run).toHaveBeenNthCalledWith(2, answerA.id, {});
  });

  it('extendQuestion isolates the exact source question and session-only multiple is ambiguous', async () => {
    const { s, project, session, dispatch } = setup();
    const first = s.createJob(project.id, 'first ask', 'first ask', undefined, session.id);
    const second = s.createJob(project.id, 'second ask', 'second ask', undefined, session.id);
    const firstQuestion = armAuto(s, project.id, session.id, first.id);
    const secondQuestion = armAuto(s, project.id, session.id, second.id);

    await expect(dispatch('extendQuestion', { sessionId: session.id })).rejects.toMatchObject({ statusCode: 409 });

    const extendedFirst = await dispatch('extendQuestion', { sessionId: session.id, sourceJobId: first.id }) as { id: string; extends: number };

    expect(extendedFirst.id).toBe(firstQuestion.id);
    expect(extendedFirst.extends).toBe(1);
    expect(s.listSchedules().find(x => x.id === secondQuestion.id)?.extends ?? 0).toBe(0);
  });

  it('cancelQuestion isolates the exact source question and leaves siblings enabled', async () => {
    const { s, project, session, dispatch } = setup();
    const first = s.createJob(project.id, 'first ask', 'first ask', undefined, session.id);
    const second = s.createJob(project.id, 'second ask', 'second ask', undefined, session.id);
    const firstQuestion = armAuto(s, project.id, session.id, first.id);
    const secondQuestion = armAuto(s, project.id, session.id, second.id);

    await expect(dispatch('cancelQuestion', { sessionId: session.id })).rejects.toMatchObject({ statusCode: 409 });
    await expect(dispatch('cancelQuestion', { sessionId: session.id, sourceJobId: second.id })).resolves.toEqual({ ok: true });

    expect(s.listSchedules().find(x => x.id === secondQuestion.id)?.enabled).toBe(false);
    expect(s.listSchedules().find(x => x.id === firstQuestion.id)?.enabled).toBe(true);
  });

  it('answerQuestion keeps session-only compatibility for one exact pending question', async () => {
    const { s, project, session, dispatch } = setup();
    const asking = s.createJob(project.id, 'ask', 'ask', undefined, session.id, undefined, undefined, undefined, { effort: 'deep', goal: true, plan: false, browser: false, reviewer: 'off' });
    armAuto(s, project.id, session.id, asking.id);

    const answer = await dispatch('answerQuestion', { sessionId: session.id, answer: 'Only one' }) as { id: string };

    expect(s.getJob(answer.id)?.intent).toEqual(asking.intent);
  });

  it('answerQuestion rejects session-only when multiple exact questions are pending', async () => {
    const { s, project, session, run, dispatch } = setup();
    const first = s.createJob(project.id, 'first ask', 'first ask', undefined, session.id);
    const second = s.createJob(project.id, 'second ask', 'second ask', undefined, session.id);
    armAuto(s, project.id, session.id, first.id);
    armAuto(s, project.id, session.id, second.id);

    await expect(dispatch('answerQuestion', { sessionId: session.id, answer: 'guess' })).rejects.toMatchObject({ statusCode: 409 });

    expect(run).not.toHaveBeenCalled();
    expect(s.listSchedules().filter(x => x.kind === 'auto-answer' && x.sessionId === session.id)).toHaveLength(2);
  });

  it('answerQuestion fails closed for legacy pending questions without exact source', async () => {
    const { s, project, session, run, dispatch } = setup();
    armAuto(s, project.id, session.id);

    await expect(dispatch('answerQuestion', { sessionId: session.id, answer: 'A' })).rejects.toThrow(/exact source/i);

    expect(run).not.toHaveBeenCalled();
  });

  it('exact requests never match legacy source-less questions', async () => {
    const { s, project, session, run, dispatch } = setup();
    const asking = s.createJob(project.id, 'ask', 'ask', undefined, session.id);
    armAuto(s, project.id, session.id);

    await expect(dispatch('answerQuestion', { sessionId: session.id, sourceJobId: asking.id, answer: 'A' })).rejects.toMatchObject({ statusCode: 404 });

    expect(run).not.toHaveBeenCalled();
    expect(s.listSchedules().filter(x => x.kind === 'auto-answer' && x.sessionId === session.id)).toHaveLength(1);
  });

  it('duplicate exact answer cannot affect another pending question', async () => {
    const { s, project, session, run, dispatch } = setup();
    const first = s.createJob(project.id, 'first ask', 'first ask', undefined, session.id);
    const second = s.createJob(project.id, 'second ask', 'second ask', undefined, session.id);
    const firstQuestion = armAuto(s, project.id, session.id, first.id);
    armAuto(s, project.id, session.id, second.id);

    await dispatch('answerQuestion', { sessionId: session.id, sourceJobId: second.id, answer: 'B first' });
    await expect(dispatch('answerQuestion', { sessionId: session.id, sourceJobId: second.id, answer: 'B again' })).rejects.toMatchObject({ statusCode: 404 });

    expect(s.listSchedules().find(x => x.id === firstQuestion.id)?.enabled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answerQuestion and extendQuestion reject cross-session sourceJobId spoofing without mutations', async () => {
    const { s, project, session, run, dispatch } = setup();
    const otherSession = s.createSession(project.id, 'Other chat');
    const sourceA = s.createJob(project.id, 'ask a', 'ask a', undefined, session.id);
    const sourceB = s.createJob(project.id, 'ask b', 'ask b', undefined, otherSession.id);
    const scheduleA = armAuto(s, project.id, session.id, sourceA.id);
    const scheduleB = armAuto(s, project.id, otherSession.id, sourceB.id);

    await expect(dispatch('answerQuestion', { sessionId: session.id, sourceJobId: sourceB.id, answer: 'spoof' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(dispatch('extendQuestion', { sessionId: session.id, sourceJobId: sourceB.id })).rejects.toMatchObject({ statusCode: 404 });

    expect(run).not.toHaveBeenCalled();
    expect(s.listSchedules().find(x => x.id === scheduleA.id)?.enabled).toBe(true);
    expect(s.listSchedules().find(x => x.id === scheduleB.id)?.enabled).toBe(true);
    expect(s.listJobs(project.id, session.id)).toHaveLength(1);
    expect(s.listJobs(project.id, otherSession.id)).toHaveLength(1);
  });

  it('answerQuestion extendQuestion and cancelQuestion reject malformed same-session rows with foreign source jobs before side effects', async () => {
    const { s, project, session, run, steer, cancel, dispatch } = setup();
    const otherSession = s.createSession(project.id, 'Other chat');
    const foreignSource = s.createJob(project.id, 'foreign ask', 'foreign ask', undefined, otherSession.id, undefined, undefined, undefined, { effort: 'deep', goal: true });
    const malformed = s.createSchedule({
      projectId: project.id,
      sessionId: session.id,
      kind: 'auto-answer',
      sourceJobId: foreignSource.id,
      title: 'Malformed',
      prompt: `${ANSWER_PREFIX} malformed`,
      questionAsk: JSON.stringify({ questions: [{ question: 'Spoof?' }] }),
      fireAt: Date.now() + 60_000,
      armedAt: Date.now(),
      intent: foreignSource.intent,
    });

    await expect(dispatch('answerQuestion', { sessionId: session.id, sourceJobId: foreignSource.id, answer: 'spoof' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(dispatch('extendQuestion', { sessionId: session.id, sourceJobId: foreignSource.id })).rejects.toMatchObject({ statusCode: 409 });
    await expect(dispatch('cancelQuestion', { sessionId: session.id, sourceJobId: foreignSource.id })).rejects.toMatchObject({ statusCode: 409 });

    const stillMalformed = s.listSchedules().find(x => x.id === malformed.id);
    expect(stillMalformed?.enabled).toBe(true);
    expect(stillMalformed?.extends ?? 0).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(s.listJobs(project.id, session.id)).toHaveLength(0);
  });

  it('out-of-order exact answer never steers or cancels a different live asking job', async () => {
    const { s, project, session, run, isRunning, steer, cancel, dispatch } = setup();
    const first = s.createJob(project.id, 'first ask', 'first ask', undefined, session.id);
    const second = s.createJob(project.id, 'second ask', 'second ask', undefined, session.id, undefined, undefined, undefined, { effort: 'fast', goal: false, plan: true, browser: true });
    const firstQuestion = armAuto(s, project.id, session.id, first.id);
    armAuto(s, project.id, session.id, second.id);
    s.updateJob(first.id, { status: 'running' });
    isRunning.mockImplementation((id: string) => id === first.id);

    const answerB = await dispatch('answerQuestion', { sessionId: session.id, sourceJobId: second.id, answer: 'B first' }) as { id: string };

    expect(steer).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(s.listSchedules().find(x => x.id === firstQuestion.id)?.enabled).toBe(true);
    expect(s.getJob(answerB.id)?.intent).toEqual(second.intent);
    expect(run).toHaveBeenCalledWith(answerB.id, {});
  });

  it('extendQuestion escalates +5 then +10, then pauses past the 30-min cap', async () => {
    const { s, project, session, dispatch } = setup();
    const asking = s.createJob(project.id, 'ask', 'ask', undefined, session.id);
    const armed = armAuto(s, project.id, session.id, asking.id);
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
    const asking = s.createJob(project.id, 'ask', 'ask', undefined, session.id);
    const armed = armAuto(s, project.id, session.id, asking.id);
    s.updateSchedule(armed.id, { paused: true });
    await expect(dispatch('extendQuestion', { sessionId: session.id })).rejects.toThrow();
  });

  it('answerQuestion STEERS into a still-live asking turn instead of spawning a parallel run', async () => {
    const { s, project, session, run, isRunning, steer, dispatch } = setup();
    // The asking turn is still generating (the SDK dismissed the AskUserQuestion
    // and the model kept thinking) — the reported overlap scenario.
    const asking = s.createJob(project.id, 'build a portfolio', 'build a portfolio', undefined, session.id);
    armAuto(s, project.id, session.id, asking.id);
    s.updateJob(asking.id, { status: 'running' });
    isRunning.mockImplementation((id: string) => id === asking.id);

    const jobsBefore = s.listJobs(undefined, session.id).length;
    const out = await dispatch('answerQuestion', { sessionId: session.id, answer: 'Full multipage' }) as { id: string };

    expect(steer).toHaveBeenCalledWith(asking.id, `${ANSWER_PREFIX} Full multipage`, { interrupt: false });
    expect(out.id).toBe(asking.id);                                   // the LIVE turn is the answer's home
    expect(run).not.toHaveBeenCalled();                               // NO second concurrent run
    expect(s.listJobs(undefined, session.id).length).toBe(jobsBefore); // no extra job row
    expect(s.listSchedules().some(x => x.kind === 'auto-answer' && x.enabled)).toBe(false); // countdown still cancelled
  });

  it('answerQuestion cancels a live-but-unsteerable turn before running the answer (no overlap)', async () => {
    const { s, project, session, run, isRunning, steer, cancel, dispatch } = setup();
    const asking = s.createJob(project.id, 'ask', 'ask', undefined, session.id);
    armAuto(s, project.id, session.id, asking.id);
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
