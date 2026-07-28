import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-run-intent-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

describe('Store RunIntent persistence', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('normalizes the legacy Opus 4.8 default role to Claude Code current Opus alias', () => {
    const s = new Store();
    s.setRouting({ roles: { primary: { engine: 'claude', model: 'claude-opus-4-8' }, reviewer: 'off' } });
    expect(s.getRoles().primary).toEqual({ engine: 'claude', model: 'opus' });
    expect(s.routing().roles?.primary).toEqual({ engine: 'claude', model: 'opus' });
  });

  it('persists full job intent before run admission and keeps legacy mirrors truthful', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Proj' });
    const session = s.createSession(project.id, 'Chat');

    const job = s.createJob(project.id, 'do it', 'Do it', 'balanced', session.id, undefined, undefined, undefined, {
      effort: 'fast',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: 'off',
      plan: false,
      goal: true,
      browser: false,
    });

    expect(job.intent).toEqual({
      schemaVersion: 1,
      effort: 'fast',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: 'off',
      plan: false,
      goal: true,
      browser: false,
    });
    expect(job.effort).toBe('fast');
    expect(job.engine).toBe('codex');
    expect(job.model).toBe('gpt-5');
    expect(job.goal).toBe(true);
  });

  it('empty-opts re-dispatch resolves exact queued job intent', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Proj' });
    const job = s.createJob(project.id, 'goal', 'Goal', 'balanced', undefined, undefined, undefined, undefined, {
      effort: 'deep',
      reviewer: { engine: 'claude', model: 'claude-sonnet-4-5' },
      plan: false,
      goal: true,
      browser: true,
    });

    expect(s.resolveJobIntent(job.id, {})).toEqual(job.intent);
  });

  it('duplicate same-job intent fails closed on conflicting runtime opts before queue admission', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Proj' });
    const job = s.createJob(project.id, 'first', 'First', 'balanced', undefined, undefined, undefined, undefined, {
      effort: 'deep',
      engine: 'claude',
      goal: true,
    });

    expect(s.resolveJobIntent(job.id, {})).toEqual(job.intent);
    expect(s.resolveJobIntent(job.id, { effort: 'deep', engine: 'claude', goal: true })).toEqual(job.intent);
    expect(() => s.resolveJobIntent(job.id, { effort: 'fast', engine: 'codex', goal: false })).toThrow(/intent conflict/i);
    expect(s.getJob(job.id)?.intent).toEqual(job.intent);
  });

  it('migrates legacy jobs idempotently from only persisted evidence', () => {
    mkdirSync(hoisted.dir, { recursive: true });
    const file = join(hoisted.dir, 'maestro-store.json');
    const legacy = {
      deckId: 'd',
      deckSecret: 's',
      accessToken: 'a',
      extensionToken: 'e',
      routing: { master: 'claude', reviewer: 'off', image: 'codex', video: 'codex' },
      settings: { defaultEffort: 'balanced', defaultEngine: 'auto', openAtLogin: false, rescanCadence: 'onchange' },
      workspace: null,
      projects: [],
      jobs: [{ id: 'j1', projectId: 'p1', title: 't', status: 'done', phase: '', progress: 100, input: 'x', output: null, error: null, effort: 'max', cost: 0, tokens: 0, stage: '', engine: 'codex', model: 'gpt-5', goal: true, createdAt: 1, updatedAt: 1 }],
      sessions: [],
      approvals: [],
      schedules: [],
      browserWatches: [],
      skills: [],
      templates: [],
      assets: [],
      publishDrafts: [],
      publishLedger: [],
      briefs: [],
      researchRuns: [],
      events: [],
      tombstones: [],
      chatBindings: [],
      pendingChats: [],
      commEvents: [],
      feedback: [],
      telegram: { offset: 0, botUsername: null, connectedAt: null },
      whatsapp: { connected: false, jid: null, name: null, linkedAt: null, sendApproved: false, pendingSummaries: [] },
      waChats: {},
    };
    writeFileSync(file, JSON.stringify(legacy, null, 2));

    const first = new Store();
    expect(first.getJob('j1')?.intent).toEqual({ schemaVersion: 1, effort: 'max', engine: 'codex', model: 'gpt-5', goal: true });
    const once = readFileSync(file, 'utf8');
    const second = new Store();
    expect(second.getJob('j1')?.intent).toEqual(first.getJob('j1')?.intent);
    expect(JSON.parse(readFileSync(file, 'utf8')).jobs[0].intent).toEqual(JSON.parse(once).jobs[0].intent);
  });

  it('continuation schedules persist full nested intent and truthful legacy mirrors', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Proj' });
    const session = s.createSession(project.id, 'Chat');
    const intent = {
      effort: 'deep' as const,
      engine: 'codex' as const,
      model: 'gpt-5',
      reviewer: 'off' as const,
      plan: true,
      goal: false,
      browser: true,
    };

    const auto = s.upsertAutoContinueForSession({
      projectId: project.id,
      sessionId: session.id,
      prompt: 'continue',
      fireAt: Date.now() + 60_000,
      intent,
    }).schedule;
    const retry = s.upsertRetryRunForKey({
      key: 'session:s1',
      projectId: project.id,
      sessionId: session.id,
      sourceJobId: 'job-1',
      title: 'Retry',
      prompt: 'again',
      fireAt: Date.now() + 120_000,
      attempt: 1,
      intent,
    }).schedule;

    for (const sched of [auto, retry]) {
      expect(sched.intent).toEqual({ schemaVersion: 1, ...intent });
      expect(sched.effort).toBe('deep');
      expect(sched.engine).toBe('codex');
      expect(sched.model).toBe('gpt-5');
      expect(sched.reviewer).toBe('off');
      expect(sched.plan).toBe(true);
      expect(sched.goal).toBe(false);
      expect(sched.browser).toBe(true);
    }
  });

  it('migrates legacy schedules as evidence-only and preserves absent vs explicit false', () => {
    mkdirSync(hoisted.dir, { recursive: true });
    const file = join(hoisted.dir, 'maestro-store.json');
    const base = {
      deckId: 'd',
      deckSecret: 's',
      accessToken: 'a',
      extensionToken: 'e',
      routing: { master: 'claude', reviewer: 'off', image: 'codex', video: 'codex' },
      settings: { defaultEffort: 'balanced', defaultEngine: 'auto', openAtLogin: false, rescanCadence: 'onchange' },
      workspace: null,
      projects: [],
      jobs: [],
      sessions: [],
      approvals: [],
      schedules: [
        { id: 'blank', projectId: 'p', title: 'blank', time: '', cadence: 'once', enabled: true, nextRun: null, createdAt: 1 },
        { id: 'falsey', projectId: 'p', title: 'falsey', time: '', cadence: 'once', enabled: true, nextRun: null, createdAt: 2, effort: 'fast', plan: false, goal: false, browser: false, reviewer: 'off' },
      ],
      browserWatches: [],
      skills: [],
      templates: [],
      assets: [],
      publishDrafts: [],
      publishLedger: [],
      briefs: [],
      researchRuns: [],
      events: [],
      tombstones: [],
      chatBindings: [],
      pendingChats: [],
      commEvents: [],
      feedback: [],
      telegram: { offset: 0, botUsername: null, connectedAt: null },
      whatsapp: { connected: false, jid: null, name: null, linkedAt: null, sendApproved: false, pendingSummaries: [] },
      waChats: {},
    };
    writeFileSync(file, JSON.stringify(base, null, 2));

    const s = new Store();
    const blank = s.listSchedules().find(x => x.id === 'blank')!;
    const falsey = s.listSchedules().find(x => x.id === 'falsey')!;

    expect(blank.intent).toBeUndefined();
    expect(falsey.intent).toEqual({ schemaVersion: 1, effort: 'fast', reviewer: 'off', plan: false, goal: false, browser: false });
  });

  it('schedule updates merge legacy mirror patches back into canonical intent', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Proj' });
    const sched = s.createSchedule({
      projectId: project.id,
      title: 'Later',
      prompt: 'go',
      fireAt: Date.now() + 60_000,
      kind: 'message',
      intent: { effort: 'balanced', goal: true, browser: true },
    });

    const updated = s.updateSchedule(sched.id, { effort: 'max', goal: false, plan: true });

    expect(updated.intent).toEqual({
      schemaVersion: 1,
      effort: 'max',
      goal: false,
      browser: true,
      plan: true,
    });
    expect(updated.effort).toBe('max');
    expect(updated.goal).toBe(false);
    expect(updated.browser).toBe(true);
    expect(updated.plan).toBe(true);
  });

  it('upserts auto-answer schedules by exact source job without replacing same-session questions', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Proj' });
    const session = s.createSession(project.id, 'Chat');
    const first = s.createJob(project.id, 'ask a', 'Ask A', undefined, session.id, undefined, undefined, undefined, { effort: 'deep', goal: true });
    const second = s.createJob(project.id, 'ask b', 'Ask B', undefined, session.id, undefined, undefined, undefined, { effort: 'fast', browser: true });
    const t0 = Date.now();

    const a = s.upsertAutoAnswerForSource({
      projectId: project.id,
      sessionId: session.id,
      sourceJobId: first.id,
      title: 'Auto-answer A',
      prompt: 'answer A',
      questionAsk: '{"questions":[{"question":"A?","options":[{"label":"Yes"}]}]}',
      fireAt: t0 + 60_000,
      armedAt: t0,
      effort: first.effort,
      intent: first.intent,
    });
    const b = s.upsertAutoAnswerForSource({
      projectId: project.id,
      sessionId: session.id,
      sourceJobId: second.id,
      title: 'Auto-answer B',
      prompt: 'answer B',
      questionAsk: '{"questions":[{"question":"B?","options":[{"label":"Yes"}]}]}',
      fireAt: t0 + 120_000,
      armedAt: t0,
      effort: second.effort,
      intent: second.intent,
    });
    const aAgain = s.upsertAutoAnswerForSource({
      projectId: project.id,
      sessionId: session.id,
      sourceJobId: first.id,
      title: 'Auto-answer A updated',
      prompt: 'answer A updated',
      questionAsk: '{"questions":[{"question":"A updated?","options":[{"label":"Yes"}]}]}',
      fireAt: t0 + 180_000,
      armedAt: t0 + 1,
      effort: first.effort,
      intent: first.intent,
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(aAgain.created).toBe(false);
    expect(aAgain.schedule.id).toBe(a.schedule.id);
    expect(aAgain.schedule.questionAsk).toContain('A updated?');
    expect(s.listSchedules().filter(row => row.kind === 'auto-answer' && row.sessionId === session.id && row.enabled)).toHaveLength(2);
    expect(s.listSchedules().find(row => row.id === b.schedule.id)?.prompt).toBe('answer B');

    const reloaded = new Store();
    const pending = reloaded.listSchedules().filter(row => row.kind === 'auto-answer' && row.sessionId === session.id && row.enabled);
    expect(pending.map(row => row.sourceJobId).sort()).toEqual([first.id, second.id].sort());
  });

  it('settleOrphanedRuns disables only auto-answer rows whose exact source job was orphaned', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Proj' });
    const session = s.createSession(project.id, 'Chat');
    const terminal = s.createJob(project.id, 'done ask', 'Done ask', undefined, session.id);
    const orphan = s.createJob(project.id, 'running ask', 'Running ask', undefined, session.id);
    s.updateJob(terminal.id, { status: 'done' });
    s.updateJob(orphan.id, { status: 'running' });
    const now = Date.now();
    const scheduleA = s.upsertAutoAnswerForSource({
      projectId: project.id,
      sessionId: session.id,
      sourceJobId: terminal.id,
      title: 'Auto-answer A',
      prompt: 'answer A',
      questionAsk: '{"questions":[{"question":"A?"}]}',
      fireAt: now + 60_000,
      armedAt: now,
      intent: terminal.intent,
    }).schedule;
    const scheduleB = s.upsertAutoAnswerForSource({
      projectId: project.id,
      sessionId: session.id,
      sourceJobId: orphan.id,
      title: 'Auto-answer B',
      prompt: 'answer B',
      questionAsk: '{"questions":[{"question":"B?"}]}',
      fireAt: now + 60_000,
      armedAt: now,
      intent: orphan.intent,
    }).schedule;
    const legacy = s.createSchedule({
      projectId: project.id,
      sessionId: session.id,
      kind: 'auto-answer',
      title: 'Legacy',
      prompt: 'legacy',
      fireAt: now + 60_000,
      armedAt: now,
    });

    const orphans = s.settleOrphanedRuns().failed;

    expect(orphans.map(j => j.id)).toEqual([orphan.id]);
    expect(s.getJob(orphan.id)?.status).toBe('failed');
    expect(s.listSchedules().find(row => row.id === scheduleA.id)?.enabled).toBe(true);
    expect(s.listSchedules().find(row => row.id === scheduleB.id)?.enabled).toBe(false);
    expect(s.listSchedules().find(row => row.id === legacy.id)?.enabled).toBe(true);
  });

  it('settleOrphanedRuns is idempotent across reloads and durable against stale schedule writers', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Proj' });
    const session = s.createSession(project.id, 'Chat');
    const orphan = s.createJob(project.id, 'running ask', 'Running ask', undefined, session.id);
    s.updateJob(orphan.id, { status: 'running' });
    const now = Date.now();
    const schedule = s.upsertAutoAnswerForSource({
      projectId: project.id,
      sessionId: session.id,
      sourceJobId: orphan.id,
      title: 'Auto-answer orphan',
      prompt: 'answer orphan',
      questionAsk: '{"questions":[{"question":"B?"}]}',
      fireAt: now + 60_000,
      armedAt: now,
      intent: orphan.intent,
    }).schedule;
    const staleWriter = new Store();

    expect(s.settleOrphanedRuns().failed).toHaveLength(1);
    expect(s.settleOrphanedRuns().failed).toHaveLength(0);
    expect(new Store().listSchedules().find(row => row.id === schedule.id)?.enabled).toBe(false);

    staleWriter.createProject({ name: 'Stale writer unrelated save' });
    const afterStaleSave = new Store().listSchedules().find(row => row.id === schedule.id);
    expect(afterStaleSave?.enabled).toBe(false);
    expect(afterStaleSave?.updatedAt).toBeGreaterThan(schedule.createdAt);
  });

  it('startup recovery preserves recoverable queued job question state while cleaning true orphan source schedules', () => {
    const s = new Store();
    const project = s.createProject({ name: 'P' });
    const session = s.createSession(project.id, 'Chat');
    const owner = s.createJob(project.id, 'owner ask', 'Owner', undefined, session.id);
    const waiter = s.createJob(project.id, 'waiter ask', 'Waiter', undefined, session.id);
    s.updateJob(owner.id, { status: 'running' });
    s.acquireSessionRun(session.id, owner.id);
    s.acquireSessionRun(session.id, waiter.id);
    const t = Date.now();
    const ownerQuestion = s.upsertAutoAnswerForSource({
      projectId: project.id, sessionId: session.id, sourceJobId: owner.id,
      title: 'Owner Q', prompt: 'owner answer', questionAsk: 'owner?', fireAt: t + 60_000, armedAt: t,
    }).schedule;
    const waiterQuestion = s.upsertAutoAnswerForSource({
      projectId: project.id, sessionId: session.id, sourceJobId: waiter.id,
      title: 'Waiter Q', prompt: 'waiter answer', questionAsk: 'waiter?', fireAt: t + 60_000, armedAt: t,
    }).schedule;

    const settled = s.settleOrphanedRuns();

    expect(settled.failed.map(j => j.id)).toEqual([owner.id]);
    expect(settled.recoverable.map(j => j.id)).toEqual([waiter.id]);
    expect(s.listSchedules().find(row => row.id === ownerQuestion.id)?.enabled).toBe(false);
    expect(s.listSchedules().find(row => row.id === waiterQuestion.id)?.enabled).toBe(true);
  });
});
