import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShadowHostDataLifecycle, type ShadowAuthoritySource } from './shadow-host-data-lifecycle.js';

type Authority = NonNullable<ReturnType<ShadowAuthoritySource['liveAuthority']>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeAuthority(label: string): Authority {
  return {
    fence: { accountId: 'acct', scopeId: 'account:acct', hostDeviceId: 'host', epoch: label, leaseId: `lease-${label}` },
    leaseExpiresAt: 1_000,
    revokedControllerDeviceIds: label === 'revoked' ? ['ctrl-a'] : [],
    scopeKeyId: `scope-${label}`,
  };
}

function makeRuntime(authority: Authority, opts: { resume?: Promise<unknown>; renew?: Promise<unknown> } = {}): ShadowAuthoritySource {
  return {
    liveAuthority: vi.fn(() => authority),
    resumePendingRenewal: vi.fn(() => opts.resume ?? Promise.resolve(false)),
    renewLease: vi.fn(() => opts.renew ?? Promise.resolve(true)),
  };
}

function makePlane(id: string) {
  return {
    id,
    setAuthority: vi.fn(),
    close: vi.fn(),
    publishAllPending: vi.fn(() => Promise.resolve(0)),
    pollAndExecuteCommands: vi.fn(() => Promise.resolve(0)),
  };
}

function makeProjection(id: string) {
  return { id, close: vi.fn(), setFence: vi.fn() };
}

function flushMicrotasks() {
  return Promise.resolve();
}

describe('ShadowHostDataLifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops a delayed stale renewal after revoke closes planeA and rebuilds planeB; fresh generation renewal applies only to B', async () => {
    const delayedRenew = deferred<unknown>();
    const planeA = makePlane('A');
    const projectionA = makeProjection('A');
    const planeB = makePlane('B');
    const projectionB = makeProjection('B');
    const rtA = makeRuntime(makeAuthority('A'), { renew: delayedRenew.promise });
    const rtRevoked = makeRuntime(makeAuthority('revoked'));
    const rtB = makeRuntime(makeAuthority('B'));
    const built = [planeA, planeB];
    const projections = [projectionA, projectionB];
    let runtime = rtA;
    let accountId = 'acct';

    const coordinator = new ShadowHostDataLifecycle({
      renewBeforeMs: 2_000,
      intervalMs: 15_000,
      getAccountId: async () => accountId,
      getRuntime: async () => runtime,
      ensureStarted: async () => {},
      dataPlaneUnavailableReason: () => null,
      buildPlane: () => {
        const svc = built.shift()!;
        return { accountId, svc, projection: projections.shift()! };
      },
      bindProjection: () => {},
      unbindProjection: () => {},
      onLoopService: async (svc) => {
        await svc.publishAllPending();
        await svc.pollAndExecuteCommands();
      },
      warn: vi.fn(),
      now: () => 0,
    });

    await coordinator.getService();
    const staleRenew = coordinator.renewLease();
    await vi.waitFor(() => expect(rtA.renewLease).toHaveBeenCalledTimes(1));

    await coordinator.onRevoked(rtRevoked);
    expect(planeA.setAuthority).toHaveBeenCalledTimes(1);
    expect(planeA.close).toHaveBeenCalledTimes(1);

    runtime = rtB;
    await coordinator.getService();

    delayedRenew.resolve(true);
    await staleRenew;
    expect(planeA.setAuthority).toHaveBeenCalledTimes(1);
    expect(planeB.setAuthority).toHaveBeenCalledTimes(0);
    expect(planeA.publishAllPending).toHaveBeenCalledTimes(0);
    expect(planeB.publishAllPending).toHaveBeenCalledTimes(0);

    await coordinator.renewLease();
    expect(planeB.setAuthority).toHaveBeenCalledTimes(1);
    expect(planeB.setAuthority.mock.calls[0][3]).toBe('scope-B');
  });

  it('serializes revoke behind an in-flight rebuild and closes the built plane before the next rebuild', async () => {
    const gate = deferred<void>();
    const planeA = makePlane('A');
    const planeB = makePlane('B');
    let buildCount = 0;
    const rtActive = makeRuntime(makeAuthority('A'));
    const rtRevoked = makeRuntime(makeAuthority('revoked'));

    const coordinator = new ShadowHostDataLifecycle({
      renewBeforeMs: 2_000,
      intervalMs: 15_000,
      getAccountId: async () => 'acct',
      getRuntime: async () => rtActive,
      ensureStarted: () => buildCount === 0 ? gate.promise : Promise.resolve(),
      dataPlaneUnavailableReason: () => null,
      buildPlane: () => ({ accountId: 'acct', svc: buildCount++ === 0 ? planeA : planeB, projection: null }),
      bindProjection: () => {},
      unbindProjection: () => {},
      onLoopService: async () => {},
      warn: vi.fn(),
      now: () => 0,
    });

    const buildA = coordinator.getService();
    const revoke = coordinator.onRevoked(rtRevoked);
    await flushMicrotasks();
    expect(planeA.close).toHaveBeenCalledTimes(0);

    gate.resolve();
    await buildA;
    await revoke;
    expect(planeA.setAuthority).toHaveBeenCalledTimes(1);
    expect(planeA.close).toHaveBeenCalledTimes(1);

    await coordinator.getService();
    expect(planeB.close).toHaveBeenCalledTimes(0);
    expect(coordinator.currentPlaneForTest()?.svc).toBe(planeB);
  });

  it('keeps the lease timer on final revoke, but stops it for account close or switch', async () => {
    const planeA = makePlane('A');
    const rt = makeRuntime(makeAuthority('A'));
    const coordinator = new ShadowHostDataLifecycle({
      renewBeforeMs: 2_000,
      intervalMs: 15_000,
      getAccountId: async () => 'acct',
      getRuntime: async () => rt,
      ensureStarted: async () => {},
      dataPlaneUnavailableReason: () => null,
      buildPlane: () => ({ accountId: 'acct', svc: planeA, projection: null }),
      bindProjection: () => {},
      unbindProjection: () => {},
      onLoopService: async () => {},
      warn: vi.fn(),
      now: () => 0,
    });

    coordinator.startLoop(() => true);
    await coordinator.getService();
    await coordinator.stop({ stopTimer: false });
    expect(coordinator.isTimerRunningForTest()).toBe(true);
    expect(planeA.close).toHaveBeenCalledTimes(1);

    await coordinator.stop();
    expect(coordinator.isTimerRunningForTest()).toBe(false);
  });
});
