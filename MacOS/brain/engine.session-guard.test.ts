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
  sessionRuns: { isParked(id: string): boolean };
  drainSessionRuns(sessionId?: string | null): void;
  available(engine: string): boolean;
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

    // Simulate A being live (in the engine's running map, as a real run would).
    internals.running.set(A.id, { ac: new AbortController() });
    store.updateJob(A.id, { status: 'running', phase: 'Working' });

    // A second run() for the SAME session must PARK B, not start it.
    const parked = await engine.run(B.id, { effort: 'deep' });
    expect(parked.status).toBe('pending');
    expect(parked.phase).toBe('Queued');
    expect(internals.sessionRuns.isParked(B.id)).toBe(true);
    expect(internals.running.has(B.id)).toBe(false); // never became a concurrent live turn

    // A finishes → draining releases B (it then attempts to run; with no engine
    // available in the test env it fails fast — the point is it LEFT the queue
    // and is no longer parked/pending-queued).
    internals.running.delete(A.id);
    internals.drainSessionRuns(sessionId);
    expect(internals.sessionRuns.isParked(B.id)).toBe(false);
    expect(store.getJob(B.id)?.status).not.toBe('pending');
  });

  it('does NOT park a job whose session is idle', async () => {
    const store = new Store();
    const engine = makeEngine(store);
    const internals = engine as unknown as EngineInternals;
    const job = store.createJob('proj-1', 'hello', 'solo', 'balanced', 'sess-solo');
    await engine.run(job.id, {}); // no other live turn → not parked (proceeds; fails fast on no engine)
    expect(internals.sessionRuns.isParked(job.id)).toBe(false);
    expect(store.getJob(job.id)?.status).not.toBe('pending');
  });

  it('cancel() removes a job that was parked (never ran)', async () => {
    const store = new Store();
    const engine = makeEngine(store);
    const internals = engine as unknown as EngineInternals;
    const sessionId = 'sess-2';
    const A = store.createJob('proj-1', 'live', 'A', 'balanced', sessionId);
    const B = store.createJob('proj-1', 'monitor', 'B', 'balanced', sessionId);
    internals.running.set(A.id, { ac: new AbortController() });
    store.updateJob(A.id, { status: 'running' });
    await engine.run(B.id, {});
    expect(internals.sessionRuns.isParked(B.id)).toBe(true);

    const cancelled = engine.cancel(B.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(internals.sessionRuns.isParked(B.id)).toBe(false);
  });
});
