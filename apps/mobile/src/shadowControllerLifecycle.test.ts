/**
 * Phase 3B0 NOTE-1 — the reset/bootstrap lifecycle serialization + generation
 * guard (the fire-and-forget race fix). The factory durable primitives are mocked
 * so we can assert ORDERING deterministically:
 *
 *   - a bootstrap enqueued after a reset never begins building until the durable
 *     purge has fully resolved (no read/send against a mid-purge cache);
 *   - a read (`getProductionShadowController`) waits behind a pending purge;
 *   - a controller built while a reset bumped the generation is discarded + closed;
 *   - a purge that REJECTS keeps the chain alive (fail-closed, next op still runs).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => {
  const events: string[] = [];
  const closeSpy = vi.fn(() => { events.push('controller-close'); });
  let gen = 0;
  let resetImpl: () => Promise<void> = async () => { gen += 1; };
  let loadGate: Promise<void> = Promise.resolve();
  let authed = true;
  return {
    events, closeSpy,
    get gen() { return gen; },
    set gen(v: number) { gen = v; },
    bumpGen() { gen += 1; },
    setReset(fn: () => Promise<void>) { resetImpl = fn; },
    runReset() { return resetImpl(); },
    setLoadGate(p: Promise<void>) { loadGate = p; },
    loadGate: () => loadGate,
    setAuthed(v: boolean) { authed = v; },
    isAuthed: () => authed,
    purgePending: false,
  };
});

vi.mock('./auth', () => ({ isAuthed: () => H.isAuthed() }));
vi.mock('./shadowProductionControllerCore', () => ({
  assembleProductionShadowController: () => { H.events.push('assemble'); return { close: H.closeSpy } as unknown; },
}));
vi.mock('./shadowEnrollmentRuntimeFactory', () => ({
  getShadowMobileEnrollmentRuntime: async () => ({}),
  getShadowMobileControllerService: async () => {
    H.events.push('build-service');
    await H.loadGate();
    return { load: async () => { H.events.push('service-load'); } };
  },
  // O-1 bootstrap gate: throws while a durable purge is pending/failing → build blocked.
  ensureNoPendingPurge: async () => { H.events.push('purge-check'); if (H.purgePending) throw new Error('purge required'); },
  resetShadowMobileEnrollmentRuntimeDurable: async () => { H.events.push('reset-start'); await H.runReset(); H.events.push('reset-end'); },
  shadowControllerResetGeneration: () => H.gen,
}));

import {
  bootstrapShadowProductionController,
  resetProductionShadowController,
  getProductionShadowController,
  awaitShadowControllerIdle,
} from './shadowProductionController';

/** Flush several microtask turns so a queued chain step (build/reset) can run. */
async function flush(turns = 6): Promise<void> { for (let i = 0; i < turns; i++) await Promise.resolve(); }

beforeEach(async () => {
  H.setAuthed(true);
  H.setLoadGate(Promise.resolve());
  H.purgePending = false;
  H.setReset(async () => { H.bumpGen(); });
  // Bring the module's serial chain to a known-idle baseline (controllerPromise=null,
  // chain settled) so a prior test's state never leaks into this one.
  resetProductionShadowController();
  await awaitShadowControllerIdle();
  H.events.length = 0;
  H.closeSpy.mockClear();
  H.gen = 0;
});

describe('NOTE-1 — lifecycle serialization', () => {
  it('a bootstrap after a reset builds ONLY after the durable purge completes (no race)', async () => {
    let releaseReset!: () => void;
    H.setReset(() => new Promise<void>((r) => { releaseReset = () => { H.bumpGen(); r(); }; }));

    resetProductionShadowController();     // React calls these two synchronously, in order
    bootstrapShadowProductionController();

    // Give microtasks a chance: the reset has started but not finished; the build
    // must NOT have begun yet.
    await flush();
    expect(H.events).toEqual(['reset-start']);
    expect(H.events).not.toContain('build-service');

    releaseReset();
    await awaitShadowControllerIdle();
    // Build strictly follows the completed purge.
    expect(H.events.indexOf('build-service')).toBeGreaterThan(H.events.indexOf('reset-end'));
  });

  it('a read waits behind a pending purge, then rebuilds fresh', async () => {
    let releaseReset!: () => void;
    H.setReset(() => new Promise<void>((r) => { releaseReset = () => { H.bumpGen(); r(); }; }));
    resetProductionShadowController();
    const readP = getProductionShadowController();
    await flush();
    expect(H.events).not.toContain('build-service'); // read is blocked by the purge
    releaseReset();
    await readP;
    expect(H.events.indexOf('build-service')).toBeGreaterThan(H.events.indexOf('reset-end'));
  });

  it('discards + closes a controller built while a reset bumped the generation', async () => {
    // Gate the service build so a reset can bump the generation mid-build.
    let releaseLoad!: () => void;
    H.setLoadGate(new Promise<void>((r) => { releaseLoad = r; }));
    const p = getProductionShadowController(); // starts a build at gen 0
    await flush();
    expect(H.events).toContain('build-service');
    H.bumpGen();          // a concurrent reset invalidates the in-flight build's generation
    releaseLoad();
    const controller = await p;
    expect(controller).toBeNull();          // stale build discarded
    expect(H.closeSpy).toHaveBeenCalled();  // and its resources closed
  });

  it('a purge that REJECTS keeps the chain operable for RETRY but BLOCKS bootstrap (fail-closed)', async () => {
    // The durable reset fails → the tombstone remains → ensureNoPendingPurge throws.
    H.setReset(async () => { H.bumpGen(); throw new Error('durable wipe failed'); });
    resetProductionShadowController();
    await awaitShadowControllerIdle();      // chain stays operable (not poisoned)
    H.purgePending = true;                   // tombstone still set (purge did not complete)
    bootstrapShadowProductionController();
    await awaitShadowControllerIdle();
    // The build is REFUSED: the purge gate runs but the controller service is never
    // constructed (no rebuild from surviving grant/cache).
    expect(H.events).toContain('purge-check');
    expect(H.events).not.toContain('build-service');
    const c = await getProductionShadowController();
    expect(c).toBeNull();                    // locked
  });

  it('once the pending purge clears, a later bootstrap builds fresh', async () => {
    H.purgePending = true;
    bootstrapShadowProductionController();
    await awaitShadowControllerIdle();
    expect(H.events).not.toContain('build-service'); // blocked while pending
    H.purgePending = false;                            // retry succeeded elsewhere
    H.events.length = 0;
    bootstrapShadowProductionController();
    await awaitShadowControllerIdle();
    expect(H.events).toContain('build-service');       // now permitted
  });

  it('bootstrap is a no-op when signed out', async () => {
    H.setAuthed(false);
    bootstrapShadowProductionController();
    await awaitShadowControllerIdle();
    expect(H.events).not.toContain('build-service');
  });
});
