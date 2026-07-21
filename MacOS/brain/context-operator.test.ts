/* Context-operator pipeline — WA intake (triage → operator turn), operator
   quoted-reply routing, and the settle-once dispatch report. The engine is a
   spy; the triage is stubbed per test. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-ctx-operator-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} } }));

import { Store, type Project, type WaMessage } from './store.js';
import type { LocalEngine } from './engine.js';
import type { TriageResult } from './context-triage.js';
import {
  contextIntake,
  makeOperatorReplyHandler,
  reportDispatchIfAny,
  buildIntakePrompt,
  buildOperatorReplyPrompt,
  buildDispatchReportPrompt,
  linkedProjectNames,
  type ContextOperatorDeps,
} from './context-operator.js';

beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

const attention: TriageResult = { attention: true, kind: 'bug', reason: 'checkout 500', summary: 'Client reports a checkout error.' };
const chatter: TriageResult = { attention: false, kind: 'chatter', reason: 'greetings', summary: 'Small talk.' };

function msg(text: string, ts: number, fromMe = false): WaMessage {
  return { id: `m${ts}`, chatId: 'c1', fromMe, senderName: fromMe ? 'You' : 'Bob', text, ts };
}

function setup(triage?: ContextOperatorDeps['triage']) {
  const store = new Store();
  const ctx = store.createProject({ name: 'Acme Ops', kind: 'context' });
  const session = store.createSession(ctx.id, 'Operator');
  const engine = { run: vi.fn(async () => undefined) } as unknown as LocalEngine;
  const emit = vi.fn();
  const deps: ContextOperatorDeps = { store, engine, emit, ...(triage ? { triage } : {}) };
  return { store, ctx, session, engine, emit, deps };
}

describe('contextIntake', () => {
  const args = (project: Project) => ({
    project, chatId: 'c1', chatName: 'Acme Corp',
    msgs: [msg('hey', 1000), msg('checkout throws a 500', 2000)],
  });

  it('attention → fires ONE full-context turn into the primary operator session', async () => {
    const { store, ctx, session, engine, deps } = setup(async () => attention);
    const outcome = await contextIntake(deps, args(store.getProject(ctx.id)!));

    expect(outcome).toBe('dispatched');
    const jobs = store.listJobs(ctx.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sessionId).toBe(session.id);           // the single continuous conversation
    expect(jobs[0].title).toBe('WhatsApp: Acme Corp (bug)');
    expect(jobs[0].input).toContain('checkout throws a 500'); // transcript included
    expect(jobs[0].input).toContain('UNTRUSTED');             // fenced as third-party data
    expect(jobs[0].intent).toEqual({ schemaVersion: 1, effort: 'balanced', plan: false, goal: false, browser: false });
    expect((engine.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(jobs[0].id, {});
  });

  it('hands the triage the linked project names', async () => {
    const { store, ctx, deps } = setup();
    const linked = store.createProject({ name: 'acme-web', kind: 'coding' });
    store.updateProject(ctx.id, { linkedProjectIds: [linked.id] });
    const seen: string[][] = [];
    deps.triage = async (input) => { seen.push(input.linkedProjectNames ?? []); return chatter; };

    await contextIntake(deps, args(store.getProject(ctx.id)!));
    expect(seen).toEqual([['acme-web']]);
  });

  it("chatter → 'noted': no run, no job, watermark handled by the caller", async () => {
    const { store, ctx, engine, deps } = setup(async () => chatter);
    expect(await contextIntake(deps, args(store.getProject(ctx.id)!))).toBe('noted');
    expect(store.listJobs(ctx.id)).toHaveLength(0);
    expect(engine.run).not.toHaveBeenCalled();
  });

  it("triage unreachable / throwing / no session → 'fallback' (classic summarizer takes over)", async () => {
    const dead = setup(async () => null);
    expect(await contextIntake(dead.deps, args(dead.store.getProject(dead.ctx.id)!))).toBe('fallback');

    const boom = setup(async () => { throw new Error('kaput'); });
    expect(await contextIntake(boom.deps, args(boom.store.getProject(boom.ctx.id)!))).toBe('fallback');

    const bare = setup(async () => attention);
    bare.store.setSessionArchived(bare.session.id, true); // no live operator session
    expect(await contextIntake(bare.deps, args(bare.store.getProject(bare.ctx.id)!))).toBe('fallback');
  });
});

describe('operator quoted-reply routing', () => {
  it('matches the ring, fires the reply turn into the owning session, returns true', async () => {
    const { store, ctx, session, engine, deps } = setup();
    store.recordContextWaSend({ projectId: ctx.id, sessionId: session.id, chatId: 'me@s.whatsapp.net', text: 'Should I ship the checkout fix to staging?' });
    const handle = makeOperatorReplyHandler(deps);

    const ok = await handle({ chatId: 'me@s.whatsapp.net', quotedText: 'Should I ship the checkout fix', text: 'yes, go ahead' });

    expect(ok).toBe(true);
    const jobs = store.listJobs(ctx.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sessionId).toBe(session.id);
    expect(jobs[0].title).toBe('Operator reply (WhatsApp)');
    expect(jobs[0].input).toContain('yes, go ahead');
    expect(jobs[0].input).toContain('Should I ship the checkout fix'); // the quoted send, for context
    expect(jobs[0].intent).toEqual({ schemaVersion: 1, effort: 'balanced', plan: false, goal: false, browser: false });
    expect(engine.run).toHaveBeenCalledWith(jobs[0].id, {});
  });

  it('does not collapse distinct replies that share length and first 32 characters', async () => {
    const { store, ctx, session, engine, deps } = setup();
    store.recordContextWaSend({ projectId: ctx.id, sessionId: session.id, chatId: 'me@s.whatsapp.net', text: 'Should I ship the checkout fix to staging?' });
    const handle = makeOperatorReplyHandler(deps);
    const prefix = 'same first thirty-two characters';
    const a = `${prefix} A`;
    const b = `${prefix} B`;
    expect(a.length).toBe(b.length);
    expect(a.slice(0, 32)).toBe(b.slice(0, 32));

    expect(await handle({ chatId: 'me@s.whatsapp.net', quotedText: 'Should I ship the checkout fix', text: a })).toBe(true);
    expect(await handle({ chatId: 'me@s.whatsapp.net', quotedText: 'Should I ship the checkout fix', text: b })).toBe(true);

    const jobs = store.listJobs(ctx.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.map(j => j.input).join('\n')).toContain(a);
    expect(jobs.map(j => j.input).join('\n')).toContain(b);
    expect(engine.run).toHaveBeenCalledTimes(2);
  });

  it('returns false on no ring match, empty reply, or a non-context owner', async () => {
    const { store, ctx, session, engine, deps } = setup();
    const handle = makeOperatorReplyHandler(deps);
    expect(await handle({ chatId: 'me@s', quotedText: 'never sent this', text: 'reply' })).toBe(false);
    expect(await handle({ chatId: 'me@s', quotedText: '', text: 'reply' })).toBe(false);

    store.recordContextWaSend({ projectId: ctx.id, sessionId: session.id, chatId: 'me@s', text: 'ping from the agent' });
    expect(await handle({ chatId: 'me@s', quotedText: 'ping from the agent', text: '   ' })).toBe(false);

    store.updateProject(ctx.id, { kind: 'coding' }); // owner is not a context project anymore
    expect(await handle({ chatId: 'me@s', quotedText: 'ping from the agent', text: 'ok' })).toBe(false);
    expect(engine.run).not.toHaveBeenCalled();
  });

  it('matchContextWaSend: normalized prefix either direction, newest send wins', () => {
    const { store, ctx, session } = setup();
    store.recordContextWaSend({ projectId: ctx.id, sessionId: session.id, chatId: 'me@s', text: 'Deploy plan A tonight?' });
    store.recordContextWaSend({ projectId: ctx.id, sessionId: session.id, chatId: 'me@s', text: 'Deploy plan A tonight? (updated)' });

    // WhatsApp truncates long quotes — a quote that is a PREFIX of the send matches.
    const m = store.matchContextWaSend('me@s', 'deploy plan a');
    expect(m?.text).toBe('Deploy plan A tonight? (updated)'); // newest wins
    // …and whitespace/case differences are normalized away.
    expect(store.matchContextWaSend('me@s', '  DEPLOY   PLAN A TONIGHT?  ')?.text).toContain('Deploy plan A');
    // Other chats never match.
    expect(store.matchContextWaSend('other@s', 'deploy plan a')).toBeNull();
  });
});

describe('dispatch settle + report', () => {
  function withDispatch() {
    const base = setup();
    const target = base.store.createProject({ name: 'acme-web', kind: 'coding' });
    const tSession = base.store.createSession(target.id, 'Fix checkout');
    const tJob = base.store.createJob(target.id, 'investigate the 500', 'Investigate', undefined, tSession.id);
    const dispatch = base.store.recordContextDispatch({
      contextProjectId: base.ctx.id, contextSessionId: base.session.id,
      targetProjectId: target.id, targetSessionId: tSession.id,
      jobId: tJob.id, title: 'Investigate checkout 500',
    });
    return { ...base, target, tJob, dispatch };
  }

  it('fires the report turn into the operator session exactly once', () => {
    const { store, ctx, session, engine, deps, tJob } = withDispatch();

    reportDispatchIfAny(deps, tJob.id, 'done', 'Root cause: missing env var.');
    const jobs = store.listJobs(ctx.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sessionId).toBe(session.id);
    expect(jobs[0].title).toBe('Report: Investigate checkout 500');
    expect(jobs[0].input).toContain('DONE');
    expect(jobs[0].input).toContain('missing env var');
    expect(jobs[0].input).toContain('"acme-web"'); // target named for the agent
    expect(jobs[0].intent).toEqual({ schemaVersion: 1, effort: 'balanced', plan: false, goal: false, browser: false });
    expect(engine.run).toHaveBeenCalledTimes(1);

    // Settle-once: a duplicate post-turn (retry, double event) must NOT re-report.
    reportDispatchIfAny(deps, tJob.id, 'done', 'again');
    expect(store.listJobs(ctx.id)).toHaveLength(1);
  });

  it('records the failed status and caps a huge output to its tail', () => {
    const { store, ctx, deps, tJob } = withDispatch();
    reportDispatchIfAny(deps, tJob.id, 'failed', 'HEAD-'.repeat(3000) + 'TAIL-MARKER');
    const job = store.listJobs(ctx.id)[0];
    expect(job.input).toContain('FAILED');
    expect(job.input).toContain('TAIL-MARKER');
    expect(job.input).toContain('(earlier omitted)');
  });

  it('no-ops fast for a jobId that is not a dispatch, and never throws', () => {
    const { store, ctx, deps } = withDispatch();
    expect(() => reportDispatchIfAny(deps, 'not-a-dispatch-job', 'done', 'x')).not.toThrow();
    expect(store.listJobs(ctx.id)).toHaveLength(0);
  });

  it('settleContextDispatch stamps status/finishedAt and claims the one report slot', () => {
    const { store, tJob } = withDispatch();
    const first = store.settleContextDispatch(tJob.id, 'done');
    expect(first?.status).toBe('done');
    expect(first?.finishedAt).toBeTypeOf('number');
    expect(store.settleContextDispatch(tJob.id, 'done')).toBeNull(); // second claim refused
  });
});

describe('prompt builders', () => {
  it('buildIntakePrompt carries the triage verdict + the permission hard rule', () => {
    const p = buildIntakePrompt({ chatName: 'Acme', chatId: 'c1', triage: attention, transcript: '10:00 Bob: broken' });
    expect(p).toContain('kind=bug');
    expect(p).toContain('checkout 500');
    expect(p).toContain('NEVER apply fixes');
    expect(p).toContain('dispatch_to_project');
    expect(p).toContain('notify_operator');
  });
  it('buildOperatorReplyPrompt quotes the sent text (capped) and frames the reply', () => {
    const p = buildOperatorReplyPrompt({ sentText: 'S'.repeat(700), replyText: 'do it' });
    expect(p).toContain('> ' + 'S'.repeat(600) + '…');
    expect(p).toContain('"do it"');
    expect(p).toContain('permission');
  });
  it('buildDispatchReportPrompt survives empty output', () => {
    const { dispatch } = (() => {
      const s = setup();
      const d = s.store.recordContextDispatch({ contextProjectId: s.ctx.id, contextSessionId: s.session.id, targetProjectId: 'x', targetSessionId: 'y', jobId: 'j', title: 'T' });
      return { dispatch: d };
    })();
    const p = buildDispatchReportPrompt({ dispatch, targetProjectName: 'web', output: '' });
    expect(p).toContain('(no output captured)');
  });
  it('linkedProjectNames drops dangling ids', () => {
    const { store, ctx } = setup();
    const real = store.createProject({ name: 'real', kind: 'coding' });
    store.updateProject(ctx.id, { linkedProjectIds: [real.id, 'ghost'] });
    expect(linkedProjectNames(store, store.getProject(ctx.id)!)).toEqual(['real']);
  });
});
