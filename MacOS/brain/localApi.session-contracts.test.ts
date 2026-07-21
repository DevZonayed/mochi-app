/* Session-targeted MCP contracts — id/sessionId aliasing + honest param names,
   verified through the REAL localApi dispatch (only the engine/gitService are
   stubbed; the dispatch wiring is production code).

   These pin the live defects reported by an external MCP client:
     - setSessionAutopilot({sessionId, on}) must actually enable autopilot.
     - setSessionReviewer({sessionId, reviewer:{engine,model}}) must persist the
       reviewer role (and keep an explicit way to turn it off).
     - refreshSessionGitStatus must accept the `id` alias, not only `sessionId`.
     - createAndRunJob must return a job HANDLE promptly (async), not block the
       caller until the agent run completes. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-session-contracts-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';
import { createDispatch } from './localApi.js';
import type { LocalEngine } from './engine.js';
import type { GitService } from './git-service.js';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; settled: () => boolean };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let done = false;
  const promise = new Promise<T>((r) => { resolve = (v: T) => { done = true; r(v); }; });
  return { promise, resolve, settled: () => done };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(opts: {
  run?: LocalEngine['run'];
  gitService?: Partial<GitService>;
} = {}) {
  const s = new Store();
  const emit = vi.fn();
  const engine = {
    run: opts.run ?? (vi.fn(async () => ({})) as unknown as LocalEngine['run']),
    isRunning: vi.fn(() => false),
    cancel: vi.fn(() => false),
  } as unknown as LocalEngine;
  const stub = {} as never;
  const git = (opts.gitService ?? {}) as unknown as GitService;
  const dispatch = createDispatch(s, engine, stub, stub, stub, stub, stub, stub, emit, '', git);
  const project = s.createProject({ name: 'Contracts', path: `${hoisted.dir}/proj` });
  const session = s.createSession(project.id, 'A session', 'lyon');
  return { s, dispatch, emit, engine, project, session };
}

describe('setSessionAutopilot — id|sessionId + on|enabled aliases', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('enables via {sessionId, on:true} → autoPilot:true (was "session not found")', async () => {
    const { dispatch, session } = setup();
    const r = await dispatch('setSessionAutopilot', { sessionId: session.id, on: true });
    expect((r as { autoPilot?: boolean }).autoPilot).toBe(true);
  });

  it('enables via {id, enabled:true} → autoPilot:true (legacy renderer path still works)', async () => {
    const { dispatch, session } = setup();
    const r = await dispatch('setSessionAutopilot', { id: session.id, enabled: true });
    expect((r as { autoPilot?: boolean }).autoPilot).toBe(true);
  });

  it('disables via {sessionId, enabled:false} → autoPilot:false', async () => {
    const { dispatch, session } = setup();
    await dispatch('setSessionAutopilot', { id: session.id, enabled: true });
    const r = await dispatch('setSessionAutopilot', { sessionId: session.id, enabled: false });
    expect((r as { autoPilot?: boolean }).autoPilot).toBe(false);
  });
});

describe('setSessionReviewer — persists the reviewer role + boolean toggle', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('persists {sessionId, reviewer:{engine,model}} and turns the pass ON', async () => {
    const { dispatch, session } = setup();
    const r = await dispatch('setSessionReviewer', {
      sessionId: session.id, reviewer: { engine: 'codex', model: 'gpt-5.5' },
    }) as { reviewer?: unknown; reviewerEnabled?: boolean };
    expect(r.reviewer).toEqual({ engine: 'codex', model: 'gpt-5.5' });
    expect(r.reviewerEnabled).toBe(true);
  });

  it('turns the reviewer OFF via {sessionId, reviewer:"off"}', async () => {
    const { dispatch, session } = setup();
    await dispatch('setSessionReviewer', { sessionId: session.id, reviewer: { engine: 'codex', model: 'gpt-5.5' } });
    const r = await dispatch('setSessionReviewer', { sessionId: session.id, reviewer: 'off' }) as { reviewer?: unknown; reviewerEnabled?: boolean };
    expect(r.reviewer).toBe('off');
    expect(r.reviewerEnabled).toBe(false);
  });

  it('still honours the boolean {id, enabled} toggle (renderer path)', async () => {
    const { dispatch, session } = setup();
    const on = await dispatch('setSessionReviewer', { id: session.id, enabled: true }) as { reviewerEnabled?: boolean };
    expect(on.reviewerEnabled).toBe(true);
    const off = await dispatch('setSessionReviewer', { id: session.id, on: false }) as { reviewerEnabled?: boolean };
    expect(off.reviewerEnabled).toBe(false);
  });
});

describe('refreshSessionGitStatus — accepts the id alias', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('reaches gitService via {id} (was "session not found")', async () => {
    const fullStatus = vi.fn(() => ({ marker: 'ok' }));
    const { dispatch, session } = setup({ gitService: { fullStatus } as unknown as Partial<GitService> });
    const r = await dispatch('refreshSessionGitStatus', { id: session.id });
    expect(fullStatus).toHaveBeenCalledOnce();
    expect((r as { marker?: string }).marker).toBe('ok');
  });

  it('still accepts the canonical {sessionId}', async () => {
    const fullStatus = vi.fn(() => ({ marker: 'ok' }));
    const { dispatch, session } = setup({ gitService: { fullStatus } as unknown as Partial<GitService> });
    await dispatch('refreshSessionGitStatus', { sessionId: session.id });
    expect(fullStatus).toHaveBeenCalledOnce();
  });
});

describe('createAndRunJob — returns a job handle promptly (async run)', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('resolves with the created job BEFORE the agent run completes', async () => {
    const runDone = deferred<{ id: string }>();
    const run = vi.fn(() => runDone.promise) as unknown as LocalEngine['run'];
    const { dispatch, project } = setup({ run });

    const dispatchP = dispatch('createAndRunJob', { projectId: project.id, input: 'do the thing' });
    // The handle must come back without waiting on the (still-pending) run.
    const winner = await Promise.race([dispatchP.then(() => 'resolved'), tick(50).then(() => 'pending')]);
    expect(winner).toBe('resolved');

    const job = await dispatchP as { id?: string; status?: string };
    expect(job.id).toBeTruthy();
    expect(run).toHaveBeenCalledOnce();
    expect(runDone.settled()).toBe(false); // run is still executing — tracked via getJob/listJobs
    runDone.resolve({ id: job.id! });
  });

  it('the returned job id is findable via getJob (handle is real)', async () => {
    const runDone = deferred<{ id: string }>();
    const { dispatch, project } = setup({ run: (vi.fn(() => runDone.promise) as unknown as LocalEngine['run']) });
    const job = await dispatch('createAndRunJob', { projectId: project.id, input: 'x' }) as { id: string };
    const got = await dispatch('getJob', { id: job.id }) as { id?: string };
    expect(got.id).toBe(job.id);
    runDone.resolve({ id: job.id });
  });
});

describe('reconnectWhatsApp — explicit non-QR reconnect contract', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('dispatches to the WhatsApp reconnect method and returns only ok', async () => {
    const s = new Store();
    const emit = vi.fn();
    const whatsapp = { reconnect: vi.fn(async () => ({ ok: true })) };
    const stub = {} as never;
    const dispatch = createDispatch(s, stub, stub, stub, stub, stub, whatsapp as never, stub, emit);

    const r = await dispatch('reconnectWhatsApp', {});

    expect(whatsapp.reconnect).toHaveBeenCalledOnce();
    expect(r).toEqual({ ok: true });
  });

  it('surfaces typed reconnect failures without converting them to ok', async () => {
    const s = new Store();
    const emit = vi.fn();
    const err = Object.assign(new Error('WhatsApp is not linked'), { code: 'WA_NOT_LINKED', statusCode: 409 });
    const whatsapp = { reconnect: vi.fn(async () => { throw err; }) };
    const stub = {} as never;
    const dispatch = createDispatch(s, stub, stub, stub, stub, stub, whatsapp as never, stub, emit);

    await expect(dispatch('reconnectWhatsApp', {})).rejects.toMatchObject({ code: 'WA_NOT_LINKED', statusCode: 409 });
  });
});

describe('sendChat — prompt/message aliases for text', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('accepts {projectId, prompt} and routes it as the job input', async () => {
    const runDone = deferred<unknown>();
    const { dispatch, project } = setup({ run: (vi.fn(() => runDone.promise) as unknown as LocalEngine['run']) });
    const r = await dispatch('sendChat', { projectId: project.id, prompt: 'hello via prompt' }) as { job?: { input?: string } };
    expect(r.job?.input).toBe('hello via prompt');
    runDone.resolve(undefined);
  });

  it('accepts {projectId, message} too', async () => {
    const runDone = deferred<unknown>();
    const { dispatch, project } = setup({ run: (vi.fn(() => runDone.promise) as unknown as LocalEngine['run']) });
    const r = await dispatch('sendChat', { projectId: project.id, message: 'hello via message' }) as { job?: { input?: string } };
    expect(r.job?.input).toBe('hello via message');
    runDone.resolve(undefined);
  });

  it('prefers canonical `text` when both text and prompt are supplied', async () => {
    const runDone = deferred<unknown>();
    const { dispatch, project } = setup({ run: (vi.fn(() => runDone.promise) as unknown as LocalEngine['run']) });
    const r = await dispatch('sendChat', { projectId: project.id, text: 'canonical', prompt: 'alias' }) as { job?: { input?: string } };
    expect(r.job?.input).toBe('canonical');
    runDone.resolve(undefined);
  });
});

describe('runJob — returns the job handle promptly, runs the agent in the background', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('resolves with the job BEFORE the run completes, and actually invokes engine.run', async () => {
    const runDone = deferred<unknown>();
    const run = vi.fn(() => runDone.promise) as unknown as LocalEngine['run'];
    const { dispatch, s, project } = setup({ run });
    const job = s.createJob(project.id, 'input', 'title', 'balanced');

    const p = dispatch('runJob', { id: job.id });
    const winner = await Promise.race([p.then(() => 'resolved'), tick(50).then(() => 'pending')]);
    expect(winner).toBe('resolved');                       // did NOT block on the run
    const handle = await p as { id?: string };
    expect(handle.id).toBe(job.id);                        // real job handle back
    expect(run).toHaveBeenCalledOnce();
    expect(runDone.settled()).toBe(false);                 // run still executing (tracked via events)
    runDone.resolve(undefined);
  });

  it('404s a missing job id instead of firing a phantom run', async () => {
    const run = vi.fn(async () => ({}));
    const { dispatch } = setup({ run: run as unknown as LocalEngine['run'] });
    await expect(dispatch('runJob', { id: 'no-such-job' })).rejects.toThrow(/not found/i);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('session lifecycle tools accept both id and sessionId (real dispatch)', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('rename/pin/archive via the sessionId alias each mutate the same session', async () => {
    const { dispatch, session } = setup();
    const renamed = await dispatch('renameSession', { sessionId: session.id, title: 'Renamed via sessionId' }) as { title?: string };
    expect(renamed.title).toBe('Renamed via sessionId');
    const pinned = await dispatch('pinSession', { sessionId: session.id, pinned: true }) as { pinned?: boolean };
    expect(pinned.pinned).toBe(true);
    const archived = await dispatch('archiveSession', { sessionId: session.id, archived: true }) as { archived?: unknown };
    expect(archived.archived).toBeTruthy(); // archived is a timestamp
  });

  it('legacy renderer `{id, ...}` calls still work', async () => {
    const { dispatch, session } = setup();
    await dispatch('renameSession', { id: session.id, title: 'Renamed via id' });
    const r = await dispatch('pinSession', { id: session.id, pinned: true }) as { title?: string; pinned?: boolean };
    expect(r.title).toBe('Renamed via id');
    expect(r.pinned).toBe(true);
  });

  it('deleteSession works through either name', async () => {
    const { dispatch, s, project } = setup();
    const s1 = s.createSession(project.id, 'one', 'porto');
    const s2 = s.createSession(project.id, 'two', 'milan');
    await dispatch('deleteSession', { id: s1.id });
    await dispatch('deleteSession', { sessionId: s2.id });
    expect(s.getSession(s1.id)).toBeUndefined();
    expect(s.getSession(s2.id)).toBeUndefined();
  });
});

describe('setSessionReviewer — invalid values are REJECTED, never a silent success', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('an object with no known engine is rejected (not a no-op)', async () => {
    const { dispatch, session } = setup();
    await expect(dispatch('setSessionReviewer', { sessionId: session.id, reviewer: {} })).rejects.toThrow(/invalid reviewer/i);
    await expect(dispatch('setSessionReviewer', { sessionId: session.id, reviewer: { engine: 'not-an-engine' } })).rejects.toThrow(/invalid reviewer/i);
  });
  it('a junk string / number / null reviewer is rejected', async () => {
    const { dispatch, session } = setup();
    await expect(dispatch('setSessionReviewer', { sessionId: session.id, reviewer: 'on' })).rejects.toThrow(/invalid reviewer/i);
    await expect(dispatch('setSessionReviewer', { sessionId: session.id, reviewer: 123 })).rejects.toThrow(/invalid reviewer/i);
    await expect(dispatch('setSessionReviewer', { sessionId: session.id, reviewer: null })).rejects.toThrow(/invalid reviewer/i);
  });
  it('a call with neither reviewer nor a toggle is rejected (no misleading success)', async () => {
    const { dispatch, session } = setup();
    await expect(dispatch('setSessionReviewer', { sessionId: session.id })).rejects.toThrow(/needs/i);
  });
  it('a rejected invalid reviewer does NOT persist any change', async () => {
    const { dispatch, s, session } = setup();
    await dispatch('setSessionReviewer', { sessionId: session.id, reviewer: { engine: 'codex' } }); // valid → persisted
    const before = s.getSession(session.id)?.reviewer;
    await expect(dispatch('setSessionReviewer', { sessionId: session.id, reviewer: {} })).rejects.toThrow();
    expect(s.getSession(session.id)?.reviewer).toEqual(before); // unchanged by the rejected call
  });
});

describe('destructive PR tools reject the id alias (canonical sessionId only)', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('pushSession/mergeSessionPR reach gitService via {sessionId} but 404 via {id}', async () => {
    const pushSession = vi.fn(() => ({ ok: true }));
    const mergePr = vi.fn(() => ({ ok: true }));
    const { dispatch, session } = setup({ gitService: { pushSession, mergePr } as unknown as Partial<GitService> });
    await dispatch('pushSession', { sessionId: session.id });
    expect(pushSession).toHaveBeenCalledOnce();
    await expect(dispatch('pushSession', { id: session.id })).rejects.toThrow(/session not found/i);
    await dispatch('mergeSessionPR', { sessionId: session.id });
    expect(mergePr).toHaveBeenCalledOnce();
    await expect(dispatch('mergeSessionPR', { id: session.id })).rejects.toThrow(/session not found/i);
  });
});

describe('project tools accept canonical projectId + the legacy id alias (real dispatch)', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('getProject resolves via {projectId} (external MCP) AND {id} (legacy)', async () => {
    const { dispatch, project } = setup();
    const byProjectId = await dispatch('getProject', { projectId: project.id }) as { id?: string };
    expect(byProjectId.id).toBe(project.id);        // RED before fix: read only p.id → "project not found"
    const byId = await dispatch('getProject', { id: project.id }) as { id?: string };
    expect(byId.id).toBe(project.id);               // legacy renderer path still works
  });

  it('openProject finds the project via {projectId} AND {id} (was "project not found")', async () => {
    const { dispatch, project } = setup();
    const viaProjectId = await dispatch('openProject', { projectId: project.id }) as { ok?: boolean };
    expect(viaProjectId.ok).toBe(true);             // resolved (no 404 throw) — the reported blocker
    const viaId = await dispatch('openProject', { id: project.id }) as { ok?: boolean };
    expect(viaId.ok).toBe(true);
  });

  it('a genuinely-missing project still 404s (no false positive)', async () => {
    const { dispatch } = setup();
    await expect(dispatch('getProject', { projectId: 'no-such-project' })).rejects.toThrow(/not found/i);
    await expect(dispatch('openProject', { id: 'no-such-project' })).rejects.toThrow(/not found/i);
  });

  it('updateProject applies via {projectId} — representative read+write arm (no side effects)', async () => {
    const { dispatch, project } = setup();
    const updated = await dispatch('updateProject', { projectId: project.id, color: 'blue' }) as { id?: string; color?: string };
    expect(updated.id).toBe(project.id);
    expect(updated.color).toBe('blue');
  });
});
