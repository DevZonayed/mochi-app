/* Integration: engine.run() enforces one active turn per session.

   Reproduces the injected-monitor scenario at the engine boundary — while a real
   agent job is live on a session, a second run() for the SAME session (a
   scheduled monitor/check, or any caller) must PARK rather than start a
   concurrent turn on the shared worktree/SDK session. When the active turn ends,
   the parked one is released. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-sessionguard-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';
import { LocalEngine } from './engine.js';

type EngineInternals = {
  running: Map<string, { ac: AbortController }>;
  available(engine: string): boolean;
  __setDispatchForTest(fn: (jobId: string) => Promise<ReturnType<Store['getJob']> extends infer J ? NonNullable<J> : never>): void;
  __runWithSessionLeaseForTest(sessionId: string | undefined, jobId: string, execute: (ac: AbortController, handle: { ac: AbortController }) => Promise<ReturnType<Store['getJob']> extends infer J ? NonNullable<J> : never>): Promise<ReturnType<Store['getJob']> extends infer J ? NonNullable<J> : never>;
};

/* Force the "no engine available" fast-fail path so a non-parked run() never
   spawns a real agent (this dev machine may have Claude/Codex logged in). The
   parking decision happens BEFORE the availability check, so this doesn't affect
   what we're testing — it just keeps run() deterministic + side-effect free. */
function makeEngine(store: Store) {
  const engine = new LocalEngine(store, vi.fn());
  (engine as unknown as EngineInternals).available = () => false;
  return engine;
}

describe('engine.run — one active turn per session', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('parks a second same-session job while one is live, then releases it', async () => {
    const store = new Store();
    const engine = makeEngine(store);
    const internals = engine as unknown as EngineInternals;

    const sessionId = 'sess-1';
    const A = store.createJob('proj-1', 'real agent task', 'A', 'balanced', sessionId);
    const B = store.createJob('proj-1', 'Monitor ONLY job A…', 'B (monitor)', 'balanced', sessionId);

    let finishA!: () => void;
    const finishAPromise = new Promise<void>((resolve) => { finishA = resolve; });
    internals.__setDispatchForTest((jobId: string) =>
      internals.__runWithSessionLeaseForTest(sessionId, jobId, async () =>
        store.updateJob(jobId, { status: 'failed', phase: 'Failed', error: 'no engine available' })
      )
    );
    const ownerPromise = internals.__runWithSessionLeaseForTest(sessionId, A.id, async () => {
      store.updateJob(A.id, { status: 'running', phase: 'Working' });
      await finishAPromise;
      return store.updateJob(A.id, { status: 'done', phase: 'Done' });
    });
    await Promise.resolve();
    expect(store.sessionRunLease(sessionId)).toMatchObject({ owner: A.id, waiters: [] });

    // A second run() for the SAME session must PARK B, not start it.
    const parkedPromise = engine.run(B.id, {});
    await Promise.resolve();
    const parked = store.getJob(B.id);
    expect(parked?.status).toBe('pending');
    expect(parked?.phase).toBe('Queued');
    expect(store.sessionRunLease(sessionId)).toMatchObject({ owner: A.id, waiters: [B.id] });
    expect(internals.running.has(B.id)).toBe(false); // never became a concurrent live turn

    // A finishes -> the real lease wrapper releases the durable lease, promotes B,
    // and the test dispatch runs it once. The point is it LEFT the queue and is no
    // longer pending-queued.
    finishA();
    await ownerPromise;
    const terminal = await parkedPromise;
    expect(terminal.status).toBe('failed');
    expect(store.sessionRunLease(sessionId)).toBeUndefined();
    expect(store.getJob(B.id)?.status).not.toBe('pending');
  });

  it('does NOT park a job whose session is idle', async () => {
    const store = new Store();
    const engine = makeEngine(store);
    const internals = engine as unknown as EngineInternals;
    const job = store.createJob('proj-1', 'hello', 'solo', 'balanced', 'sess-solo');
    await engine.run(job.id, {}); // no other live turn → not parked (proceeds; fails fast on no engine)
    expect(store.sessionRunLease('sess-solo')).toBeUndefined();
    expect(store.getJob(job.id)?.status).not.toBe('pending');
  });

  it('cancel() removes a job that was parked (never ran)', async () => {
    const store = new Store();
    const engine = makeEngine(store);
    const internals = engine as unknown as EngineInternals;
    const sessionId = 'sess-2';
    const A = store.createJob('proj-1', 'live', 'A', 'balanced', sessionId);
    const B = store.createJob('proj-1', 'monitor', 'B', 'balanced', sessionId);
    expect(store.acquireSessionRunDetailed(sessionId, A.id).outcome).toBe('acquired');
    internals.running.set(A.id, { ac: new AbortController() });
    store.updateJob(A.id, { status: 'running' });
    const parkedPromise = engine.run(B.id, {});
    await Promise.resolve();
    expect(store.sessionRunLease(sessionId)).toMatchObject({ owner: A.id, waiters: [B.id] });

    const cancelled = engine.cancel(B.id);
    expect(cancelled?.status).toBe('cancelled');
    await expect(parkedPromise).resolves.toMatchObject({ status: 'cancelled' });
    expect(store.sessionRunLease(sessionId)).toMatchObject({ owner: A.id, waiters: [] });
  });
});
