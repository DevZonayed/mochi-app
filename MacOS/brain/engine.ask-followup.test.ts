import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-engine-ask-followup-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' }, shell: {} }));

import { Store, type TranscriptItem } from './store.js';
import { LocalEngine } from './engine.js';
import { createDispatch } from './localApi.js';
import { ANSWER_PREFIX } from './ask-question.js';

const ASK = JSON.stringify({
  questions: [{ question: 'Choose?', options: [{ label: 'Recommended' }, { label: 'Manual' }] }],
});

function setup() {
  const store = new Store();
  const project = store.createProject({ name: 'Proj' });
  const session = store.createSession(project.id, 'Chat');
  store.updateSession(session.id, { autoPilot: true });
  const emit = vi.fn();
  const engine = new LocalEngine(store, emit);
  return { store, project, session: store.getSession(session.id)!, engine, emit };
}

describe('LocalEngine AskUserQuestion follow-up arming', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('preserves multiple enabled same-session questions keyed by exact source job', () => {
    const { store, project, session, engine } = setup();
    const first = store.createJob(project.id, 'first', 'First', undefined, session.id, undefined, undefined, undefined, { effort: 'deep', goal: true });
    const second = store.createJob(project.id, 'second', 'Second', undefined, session.id, undefined, undefined, undefined, { effort: 'fast', browser: true });
    const items: TranscriptItem[] = [{ kind: 'ask', text: '', ask: ASK }];

    const arm = (engine as unknown as {
      armAskFollowup: (sessionId: string, projectId: string, sourceJobId: string, items: TranscriptItem[], effort: string, intent?: unknown) => boolean;
    }).armAskFollowup.bind(engine);

    expect(arm(session.id, project.id, first.id, items, first.effort, first.intent)).toBe(true);
    expect(arm(session.id, project.id, second.id, items, second.effort, second.intent)).toBe(true);

    const pending = store.listSchedules().filter(row => row.kind === 'auto-answer' && row.sessionId === session.id && row.enabled);
    expect(pending).toHaveLength(2);
    expect(pending.map(row => row.sourceJobId).sort()).toEqual([first.id, second.id].sort());
    expect(pending.find(row => row.sourceJobId === first.id)?.intent).toEqual(first.intent);
    expect(pending.find(row => row.sourceJobId === second.id)?.intent).toEqual(second.intent);
  });

  it('uses sourceJobId as a one-unresolved-question-per-source invariant', () => {
    const { store, project, session, engine } = setup();
    const source = store.createJob(project.id, 'ask', 'Ask', undefined, session.id, undefined, undefined, undefined, { effort: 'deep', goal: true });
    const items: TranscriptItem[] = [{ kind: 'ask', text: '', ask: ASK }];
    const arm = (engine as unknown as {
      armAskFollowup: (sessionId: string, projectId: string, sourceJobId: string, items: TranscriptItem[], effort: string, intent?: unknown) => boolean;
    }).armAskFollowup.bind(engine);

    expect(arm(session.id, project.id, source.id, items, source.effort, source.intent)).toBe(true);
    const first = store.listSchedules().find(row => row.kind === 'auto-answer' && row.sourceJobId === source.id)!;
    expect(arm(session.id, project.id, source.id, items, source.effort, source.intent)).toBe(true);

    const pending = store.listSchedules().filter(row => row.kind === 'auto-answer' && row.sessionId === session.id && row.enabled);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(first.id);
    expect(pending[0].sourceJobId).toBe(source.id);
    expect(pending[0].questionAsk).toBe(ASK);
  });

  it('proves A answer creates distinct B and B can own the next unresolved question lifecycle', async () => {
    const { store, project, session, engine, emit } = setup();
    const arm = (engine as unknown as {
      armAskFollowup: (sessionId: string, projectId: string, sourceJobId: string, items: TranscriptItem[], effort: string, intent?: unknown) => boolean;
    }).armAskFollowup.bind(engine);
    const items: TranscriptItem[] = [{ kind: 'ask', text: '', ask: ASK }];
    const sourceA = store.createJob(project.id, 'ask A', 'Ask A', undefined, session.id, undefined, undefined, undefined, { effort: 'deep', goal: true });

    expect(arm(session.id, project.id, sourceA.id, items, sourceA.effort, sourceA.intent)).toBe(true);
    const scheduleA = store.listSchedules().find(row => row.kind === 'auto-answer' && row.sourceJobId === sourceA.id)!;
    expect(scheduleA.questionAsk).toBe(ASK);
    expect(arm(session.id, project.id, sourceA.id, items, sourceA.effort, sourceA.intent)).toBe(true);
    expect(store.listSchedules().filter(row => row.kind === 'auto-answer' && row.sourceJobId === sourceA.id && row.enabled)).toHaveLength(1);

    const runSpy = vi.spyOn(engine, 'run').mockImplementation(async (jobId: string) => {
      const job = store.updateJob(jobId, { status: 'running' });
      return job;
    });
    vi.spyOn(engine, 'isRunning').mockReturnValue(false);
    const stub = {} as never;
    const dispatch = createDispatch(store, engine, stub, stub, stub, stub, stub, stub, emit);

    const sourceB = await dispatch('answerQuestion', { sessionId: session.id, sourceJobId: sourceA.id, answer: 'answer A' }) as { id: string; input: string };

    expect(sourceB.id).not.toBe(sourceA.id);
    expect(sourceB.input).toBe(`${ANSWER_PREFIX} answer A`);
    expect(store.getJob(sourceB.id)?.intent).toEqual(sourceA.intent);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(sourceB.id, {});
    expect(store.listSchedules().find(row => row.id === scheduleA.id)?.enabled).toBe(false);

    const jobB = store.getJob(sourceB.id)!;
    expect(arm(session.id, project.id, jobB.id, items, jobB.effort, jobB.intent)).toBe(true);
    expect(arm(session.id, project.id, jobB.id, items, jobB.effort, jobB.intent)).toBe(true);
    const pendingB = store.listSchedules().filter(row => row.kind === 'auto-answer' && row.sourceJobId === jobB.id && row.enabled);
    expect(pendingB).toHaveLength(1);
    expect(pendingB[0].sourceJobId).toBe(jobB.id);
    expect(pendingB[0].questionAsk).toBe(ASK);

    const reloaded = new Store();
    const reloadedPending = reloaded.listSchedules().filter(row => row.kind === 'auto-answer' && row.sessionId === session.id && row.enabled);
    expect(reloadedPending.map(row => row.sourceJobId)).toEqual([jobB.id]);
    expect(reloadedPending[0].questionAsk).toBe(ASK);
  });
});
