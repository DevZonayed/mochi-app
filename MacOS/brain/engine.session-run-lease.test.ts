/* ENGINE-LEVEL single-writer lease behavior — drives the real LocalEngine lease
   lifecycle wrapper (runWithSessionLease) with a FAKE turn body, so the concurrency
   contract is verified without spawning a real engine: same-session max concurrency
   1 + FIFO, cross-session concurrency, duplicate queued callers, startup throw
   releasing the lease, post-turn hold, and queued cancellation. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} }, clipboard: {}, nativeImage: {}, shell: {} }));

import { Store } from './store.js';
import { LocalEngine, type RunHandle } from './engine.js';
import type { Job } from './store.js';

type Deferred = { p: Promise<void>; resolve: () => void; reject: (e?: unknown) => void };
const deferred = (): Deferred => { let resolve!: () => void, reject!: (e?: unknown) => void; const p = new Promise<void>((res, rej) => { resolve = () => res(); reject = rej; }); return { p, resolve, reject }; };
const tick = async (): Promise<void> => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

describe('LocalEngine session run lease (engine-level)', () => {
  let store: Store;
  let engine: LocalEngine;
  let executes: Map<string, () => Promise<Job>>;
  let started: string[];
  let emitted: Array<{ name: string; data: unknown }>;

  const start = (jobId: string): Promise<Job> => {
    const sess = store.getJob(jobId)?.sessionId;
    const ex = executes.get(jobId) ?? (async () => store.updateJob(jobId, { status: 'done', phase: 'Done' }));
    return engine.__runWithSessionLeaseForTest(sess, jobId, async (_ac: AbortController, _h: RunHandle) => { started.push(jobId); return ex(); });
  };

  const mkJob = (sessionId: string, title: string): string => store.createJob('proj', title, title, undefined, sessionId).id;

  beforeEach(() => {
    hoisted.dir = mkdtempSync(path.join(tmpdir(), 'eng-lease-'));
    store = new Store();
    emitted = [];
    engine = new LocalEngine(store, (name, data) => { emitted.push({ name, data }); });
    executes = new Map();
    started = [];
    // Drained/recovered jobs run through the SAME fake-body seam.
    engine.__setDispatchForTest((jobId) => start(jobId));
  });
  afterEach(() => {
    engine.__disposeLeaseTimersForTest();
    vi.restoreAllMocks();
    rmSync(hoisted.dir, { recursive: true, force: true });
  });

  it('same session: max concurrency 1, strict FIFO drain', async () => {
    const s = store.createSession('proj', 'chat').id;
    const A = mkJob(s, 'A'), B = mkJob(s, 'B'), C = mkJob(s, 'C');
    const gA = deferred(), gB = deferred(), gC = deferred();
    executes.set(A, async () => { await gA.p; return store.updateJob(A, { status: 'done' }); });
    executes.set(B, async () => { await gB.p; return store.updateJob(B, { status: 'done' }); });
    executes.set(C, async () => { await gC.p; return store.updateJob(C, { status: 'done' }); });

    const pA = start(A), pB = start(B), pC = start(C);
    await tick();
    expect(store.sessionRunLease(s)).toMatchObject({ owner: A, waiters: [B, C] });
    expect(started).toEqual([A]);                 // only A running
    expect(store.getJob(B)!.status).toBe('pending'); // B/C truthfully queued, not "running"
    expect(store.getJob(B)!.phase).toBe('Queued');

    gA.resolve(); await pA; await tick();
    expect(store.sessionRunLease(s)).toMatchObject({ owner: B, waiters: [C] });
    expect(started).toEqual([A, B]);

    gB.resolve(); await pB; await tick();
    expect(started).toEqual([A, B, C]);
    gC.resolve(); await pC; await tick();
    expect(store.sessionRunLease(s)).toBeUndefined(); // fully drained
  });

  it('different sessions run concurrently', async () => {
    const s1 = store.createSession('proj', 'c1').id, s2 = store.createSession('proj', 'c2').id;
    const A = mkJob(s1, 'A'), X = mkJob(s2, 'X');
    const gA = deferred();
    executes.set(A, async () => { await gA.p; return store.updateJob(A, { status: 'done' }); });
    const pA = start(A); const pX = start(X);
    await tick();
    expect(started).toContain(A); // both started — X not blocked by A's session
    await pX;
    expect(started).toContain(X);
    gA.resolve(); await pA;
  });

  it('duplicate queued callers both settle; the job executes exactly once', async () => {
    const s = store.createSession('proj', 'chat').id;
    const A = mkJob(s, 'A'), B = mkJob(s, 'B');
    const gA = deferred();
    executes.set(A, async () => { await gA.p; return store.updateJob(A, { status: 'done' }); });
    let bRuns = 0;
    executes.set(B, async () => { bRuns++; return store.updateJob(B, { status: 'done' }); });
    start(A);
    const pB1 = start(B), pB2 = start(B); // two callers for the SAME queued job
    await tick();
    expect(store.sessionRunLease(s)!.waiters).toEqual([B]); // enqueued once
    gA.resolve(); await tick();
    const [rB1, rB2] = await Promise.all([pB1, pB2]);
    expect(bRuns).toBe(1);                       // executed once
    expect(rB1.status).toBe('done'); expect(rB2.status).toBe('done'); // both callers settled
  });

  it('a startup/execution throw releases the lease so the next turn can proceed', async () => {
    const s = store.createSession('proj', 'chat').id;
    const J = mkJob(s, 'J'), K = mkJob(s, 'K');
    executes.set(J, async () => { throw new Error('startup boom'); });
    executes.set(K, async () => store.updateJob(K, { status: 'done' }));
    await expect(start(J)).rejects.toThrow('startup boom');
    expect(store.sessionRunLease(s)).toBeUndefined(); // lease released despite the throw
    const rK = await start(K);                        // K can now own the session
    expect(rK.status).toBe('done');
  });

  it('actual run resolves immutable intent only after acquiring the session lease', async () => {
    const s = store.createSession('proj', 'chat').id;
    const J = store.createJob('proj', 'J', 'J', 'balanced', s, undefined, undefined, undefined, {
      effort: 'deep',
      engine: 'codex',
      model: 'gpt-5',
      plan: false,
    }).id;
    const observed: Array<{ owner?: string; waiters: string[] }> = [];
    const original = store.resolveJobIntent.bind(store);
    vi.spyOn(store, 'resolveJobIntent').mockImplementation((jobId, opts) => {
      const lease = store.sessionRunLease(s);
      observed.push({ owner: lease?.owner, waiters: lease?.waiters ?? [] });
      return original(jobId, opts);
    });

    await expect(engine.run(J, { effort: 'fast', engine: 'claude' })).rejects.toThrow(/intent conflict/i);

    expect(observed).toEqual([{ owner: J, waiters: [] }]);
    expect(store.sessionRunLease(s)).toBeUndefined();
    expect(store.getJob(J)?.intent).toMatchObject({ schemaVersion: 1, effort: 'deep', engine: 'codex', model: 'gpt-5', plan: false });
  });

  it('holds the lease for the WHOLE turn body (post-turn work) — next turn waits', async () => {
    const s = store.createSession('proj', 'chat').id;
    const A = mkJob(s, 'A'), B = mkJob(s, 'B');
    const postTurn = deferred();
    let bStarted = false;
    // A's body finishes its "engine" work but then does post-turn work (awaited).
    executes.set(A, async () => { await postTurn.p; return store.updateJob(A, { status: 'done' }); });
    executes.set(B, async () => { bStarted = true; return store.updateJob(B, { status: 'done' }); });
    const pA = start(A); const pB = start(B);
    await tick();
    expect(bStarted).toBe(false);           // B blocked until A's post-turn settles
    postTurn.resolve(); await pA; await pB;
    expect(bStarted).toBe(true);
  });

  it('queued cancellation settles all duplicate callers, leaves the owner running, keeps FIFO', async () => {
    const s = store.createSession('proj', 'chat').id;
    const A = mkJob(s, 'A'), B = mkJob(s, 'B'), C = mkJob(s, 'C');
    const gA = deferred();
    executes.set(A, async () => { await gA.p; return store.updateJob(A, { status: 'done' }); });
    let cRan = false, bRan = false;
    executes.set(B, async () => { bRan = true; return store.updateJob(B, { status: 'done' }); });
    executes.set(C, async () => { cRan = true; return store.updateJob(C, { status: 'done' }); });
    const pA = start(A);
    const pB1 = start(B), pB2 = start(B), pC = start(C);
    await tick();
    expect(store.sessionRunLease(s)).toMatchObject({ owner: A, waiters: [B, C] });

    const cancelled = engine.cancel(B);
    expect(cancelled?.status).toBe('cancelled');
    const [rB1, rB2] = await Promise.all([pB1, pB2]);   // both duplicate callers settle
    expect(rB1.status).toBe('cancelled'); expect(rB2.status).toBe('cancelled');
    expect(store.sessionRunLease(s)).toMatchObject({ owner: A, waiters: ['C'.length ? C : C] }); // A untouched, only B removed
    expect(store.sessionRunLease(s)!.waiters).toEqual([C]);

    gA.resolve(); await pA; await pC; await tick();
    expect(bRan).toBe(false);   // cancelled B never executed
    expect(cRan).toBe(true);    // C did (FIFO after B removed)
  });

  it('stale-owner reclaim dispatches the FIFO-promoted waiter before parking the newcomer', async () => {
    const s = store.createSession('proj', 'chat').id;
    const A = mkJob(s, 'A'), B = mkJob(s, 'B'), D = mkJob(s, 'D');
    const staleAt = Date.now() - 10 * 60_000;
    store.acquireSessionRun(s, A, staleAt);
    store.acquireSessionRun(s, B, staleAt + 1);
    let bRan = false, dRan = false;
    executes.set(B, async () => { bRan = true; return store.updateJob(B, { status: 'done' }); });
    executes.set(D, async () => { dRan = true; return store.updateJob(D, { status: 'done' }); });

    const pD = start(D);
    await tick();

    expect(started[0]).toBe(B);
    expect(bRan).toBe(true);
    const rD = await pD;
    expect(rD.status).toBe('done');
    expect(dRan).toBe(true);
    expect(started).toEqual([B, D]);
    expect(store.sessionRunLease(s)).toBeUndefined();
  });

  it('post-turn CLEANUP on the failure/cancel path is fenced — next turn waits for it (no shared-state race)', async () => {
    // Models run()'s catch path: the turn fails, then AWAITS its cleanup (browser close +
    // git refresh) INSIDE the lease before returning the terminal job. The next same-session
    // turn must not start until that cleanup settles.
    const s = store.createSession('proj', 'chat').id;
    const A = mkJob(s, 'A'), B = mkJob(s, 'B');
    const cleanup = deferred();
    let bStarted = false;
    executes.set(A, async () => {
      // The engine turn failed; the catch now awaits browser-close + git-refresh.
      await cleanup.p;                                   // <- fenced cleanup
      return store.updateJob(A, { status: 'failed', error: 'boom' });
    });
    executes.set(B, async () => { bStarted = true; return store.updateJob(B, { status: 'done' }); });
    const pA = start(A); const pB = start(B);
    await tick();
    expect(bStarted).toBe(false);   // B blocked while A's post-failure cleanup is in flight
    cleanup.resolve(); await pA; await pB;
    expect(bStarted).toBe(true);    // only after cleanup settled does B proceed
  });

  it('a release CAS that fails N times then succeeds still promotes + settles the next turn (fail-closed retry)', async () => {
    engine.__setLeaseReleaseTuningForTest({ backoff: [0, 5, 10, 20, 40], recoveryBase: 10 });
    const s = store.createSession('proj', 'chat').id;
    const A = mkJob(s, 'A'), B = mkJob(s, 'B');
    const gA = deferred();
    executes.set(A, async () => { await gA.p; return store.updateJob(A, { status: 'done' }); });
    executes.set(B, async () => store.updateJob(B, { status: 'done' }));
    const pA = start(A); const pB = start(B);
    await tick();
    expect(store.sessionRunLease(s)).toMatchObject({ owner: A, waiters: [B] });

    // Make the release CAS throw its first two attempts (transient lock contention).
    const orig = store.releaseSessionRun.bind(store);
    let calls = 0;
    vi.spyOn(store, 'releaseSessionRun').mockImplementation((sess: string, job: string, at?: number) => {
      if (calls++ < 2) throw Object.assign(new Error('lease-lock-timeout'), { code: 'lease-lock-timeout' });
      return orig(sess, job, at);
    });

    gA.resolve();
    const rB = await pB;                 // B still runs — the release retried until it took
    await pA;
    expect(calls).toBeGreaterThanOrEqual(3);   // failed twice, succeeded after
    expect(started).toEqual([A, B]);           // exactly-once, in order — no double dispatch
    expect(rB.status).toBe('done');
  });

  it('a PERSISTENTLY failing release fails closed → logs truthfully + durable recovery settles the waiter', async () => {
    engine.__setLeaseReleaseTuningForTest({ backoff: [0, 2, 4], recoveryBase: 5 });
    const s = store.createSession('proj', 'chat').id;
    const A = mkJob(s, 'A'), B = mkJob(s, 'B');
    const gA = deferred();
    executes.set(A, async () => { await gA.p; return store.updateJob(A, { status: 'done' }); });
    executes.set(B, async () => store.updateJob(B, { status: 'done' }));
    const pA = start(A); const pB = start(B);
    await tick();

    // releaseSessionRun ALWAYS throws — the CAS can never take the queue lock.
    vi.spyOn(store, 'releaseSessionRun').mockImplementation(() => { throw Object.assign(new Error('wedged'), { code: 'lease-lock-timeout' }); });

    gA.resolve();
    await pA;   // A's finally exhausts the retries, stops the heartbeat, arms recovery

    // The failure is reported truthfully — NEVER swallowed into a fake success.
    const err = emitted.find(e => e.name === 'log' && (e.data as { level?: string }).level === 'error' && String((e.data as { msg?: string }).msg ?? '').includes('release session'));
    expect(err).toBeTruthy();

    // The durable recovery (recoverSessionRuns via the queue CAS — not the broken
    // releaseSessionRun) promotes the FIFO-next waiter and settles its parked caller.
    const rB = await pB;
    expect(rB.status).toBe('done');
    expect(started).toContain(B);   // the waiter is NOT stranded
  });

  it('lease recovery keeps retrying past the old attempt cap after transient recovery failures', async () => {
    vi.useFakeTimers();
    try {
      engine.__setLeaseReleaseTuningForTest({ recoveryBase: 1 });
      let recoverAttempts = 0;
      vi.spyOn(engine, 'recoverSessionRuns').mockImplementation(() => {
        recoverAttempts++;
        throw new Error('recovery lock still contended');
      });

      (engine as unknown as { scheduleReleaseRecovery(attempt: number): void }).scheduleReleaseRecovery(0);
      for (let i = 0; i < 12; i++) await vi.runOnlyPendingTimersAsync();

      expect(recoverAttempts).toBeGreaterThan(10);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
