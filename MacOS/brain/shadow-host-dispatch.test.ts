/**
 * Dispatch allowlist tests for the trusted `shadowHost*` surface. A fake runtime
 * records calls; proves the exact allowlist, not-signed-in behavior, no
 * auto-approval, QR only from create, and that no secret/private bytes leak.
 */
import { describe, it, expect, vi } from 'vitest';
import { createShadowHostDispatch, SHADOW_HOST_METHODS, isShadowHostMethod } from './shadow-host-dispatch.ts';
import type { ShadowHostEnrollmentRuntime } from './shadow-enrollment-host.ts';

function fakeRuntime() {
  const calls: string[] = [];
  const rt = {
    status: vi.fn(() => ({ state: 'running', hostDeviceId: 'h', fingerprint: 'fp', vaultAvailable: true, registered: true, epoch: 1, activeSessions: 0, controllers: 0 })),
    createEnrollmentSession: vi.fn(async () => { calls.push('create'); return { sessionId: 'es', qr: 'maestro-shadow://enroll?sec=SECRET', expiresAt: 1, hostFingerprint: 'fp', hostAuthString: 'a-b-c' }; }),
    listPendingRequests: vi.fn(async () => { calls.push('listPending'); return [{ sessionId: 'es', controllerDeviceId: 'c', signingPublicKey: 'p', agreementPublicKey: 'a', nonce: 'n', requestedAt: 1, transcriptHash: 't', authString: 'x-y', sessionExpiresAt: 2 }]; }),
    approve: vi.fn(async () => { calls.push('approve'); return { grantId: 'g', controllerDeviceId: 'c', keyId: 'wk', expiresAt: 2 }; }),
    deny: vi.fn(async () => { calls.push('deny'); }),
    cancel: vi.fn(async () => { calls.push('cancel'); }),
    listControllers: vi.fn(async () => { calls.push('listControllers'); return [{ controllerDeviceId: 'c', grantId: 'g', keyId: 'wk', status: 'active', expiresAt: 2 }]; }),
    listControllersForRecovery: vi.fn(async () => { calls.push('listControllersForRecovery'); return [{ controllerDeviceId: 'c', grantId: 'g', keyId: 'wk', status: 'active', expiresAt: 2 }]; }),
    revoke: vi.fn(async () => { calls.push('revoke'); return { keyRotationId: 'kr_x', alreadyRevoked: false }; }),
    recoverExpiredLeaseController: vi.fn(async () => { calls.push('recoverExpiredLeaseController'); return { keyRotationId: 'kr_recovery', alreadyRevoked: false, leaseReacquired: true }; }),
  } as unknown as ShadowHostEnrollmentRuntime;
  return { rt, calls };
}

function makeDispatch(signedIn = true) {
  const { rt, calls } = fakeRuntime();
  const ensureStarted = vi.fn(async () => {});
  const dispatch = createShadowHostDispatch({
    signedIn: () => signedIn,
    hostDeviceId: () => 'deck-1',
    vaultAvailable: () => true,
    getRuntime: async () => rt,
    ensureStarted,
  });
  return { dispatch, rt, calls, ensureStarted };
}

describe('shadow host dispatch allowlist', () => {
  it('exposes exactly the intended method allowlist', () => {
    expect([...SHADOW_HOST_METHODS]).toEqual([
      'shadowHostStatus', 'shadowHostCreateSession', 'shadowHostListPending', 'shadowHostApprove',
      'shadowHostDeny', 'shadowHostCancel', 'shadowHostListControllers', 'shadowHostRevoke',
      'shadowHostRecoverExpiredController',
      // Phase 3D1 view-only screen share — read-only status + local Stop.
      'shadowHostScreenStatus', 'shadowHostScreenStop',
    ]);
    expect(isShadowHostMethod('shadowHostApprove')).toBe(true);
    expect(isShadowHostMethod('shadowHostNuke')).toBe(false);
    expect(isShadowHostMethod('shadowHostScreenStatus')).toBe(true);
    expect(isShadowHostMethod('shadowHostRecoverExpiredController')).toBe(true);
  });

  it('serves screen-share status/stop without a session (registry-backed, metadata only)', async () => {
    let stopped = 0;
    const dispatch = createShadowHostDispatch({
      signedIn: () => false,
      hostDeviceId: () => 'host_x',
      vaultAvailable: () => true,
      getRuntime: async () => { throw new Error('should not need runtime'); },
      ensureStarted: async () => {},
      screenShareStatus: () => ({ active: true, deviceLabel: 'Device abcd', sourceLabel: 'Built-in Display · 1512×982', startedAtMs: 1000 }),
      screenShareStop: async () => { stopped += 1; return { ok: true as const }; },
    });
    const st = await dispatch('shadowHostScreenStatus', {}) as { active: boolean; deviceLabel: string };
    expect(st.active).toBe(true);
    expect(st.deviceLabel).toBe('Device abcd');
    // status carries NO frame bytes / keys / stream ids
    expect(JSON.stringify(st)).not.toMatch(/frame|key|nonce|cipher/i);
    expect(await dispatch('shadowHostScreenStop', {})).toEqual({ ok: true });
    expect(stopped).toBe(1);
  });

  it('rejects an unknown shadowHost* method with 404', async () => {
    const { dispatch } = makeDispatch();
    await expect(dispatch('shadowHostNuke', {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns a not-signed-in status without a runtime and rejects ops with 401', async () => {
    const { dispatch, ensureStarted } = makeDispatch(false);
    const status = await dispatch('shadowHostStatus', {}) as { signedIn: boolean; state: string; vaultAvailable: boolean };
    expect(status).toMatchObject({ signedIn: false, state: 'stopped', vaultAvailable: true });
    expect(ensureStarted).not.toHaveBeenCalled();
    await expect(dispatch('shadowHostCreateSession', {})).rejects.toMatchObject({ statusCode: 401 });
    await expect(dispatch('shadowHostApprove', { sessionId: 'es' })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('never auto-approves — approve only runs on the explicit approve method', async () => {
    const { dispatch, rt } = makeDispatch();
    await dispatch('shadowHostStatus', {});
    await dispatch('shadowHostListPending', {});
    await dispatch('shadowHostCreateSession', {});
    expect((rt.approve as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    await dispatch('shadowHostApprove', { sessionId: 'es' });
    expect((rt.approve as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it('returns the QR only from create, and status/list carry no secret/private fields', async () => {
    const { dispatch } = makeDispatch();
    const created = await dispatch('shadowHostCreateSession', {}) as { qr: string };
    expect(created.qr).toContain('maestro-shadow://enroll');
    const status = await dispatch('shadowHostStatus', {}) as Record<string, unknown>;
    expect(JSON.stringify(status)).not.toContain('qr');
    expect(JSON.stringify(status)).not.toMatch(/secret|privateKey|scopeKey["']?\s*:/i);
    const pending = await dispatch('shadowHostListPending', {}) as { requests: Array<Record<string, unknown>> };
    for (const r of pending.requests) {
      expect(JSON.stringify(r)).not.toMatch(/secret|privateKey|wrappedScopeKey/i);
    }
  });

  it('delegates approve/deny/cancel/revoke/listControllers to the runtime', async () => {
    const { dispatch, calls } = makeDispatch();
    await dispatch('shadowHostApprove', { sessionId: 'es', controllerName: 'Phone' });
    await dispatch('shadowHostDeny', { sessionId: 'es' });
    await dispatch('shadowHostCancel', { sessionId: 'es' });
    await dispatch('shadowHostListControllers', {});
    const rev = await dispatch('shadowHostRevoke', { controllerDeviceId: 'c' }) as { keyRotationId: string };
    expect(rev.keyRotationId).toBe('kr_x');
    expect(calls).toContain('approve');
    expect(calls).toContain('deny');
    expect(calls).toContain('cancel');
    expect(calls).toContain('listControllers');
    expect(calls).toContain('revoke');
  });

  it('does not ensure-start for the explicit expired-lease recovery revoke', async () => {
    const { dispatch, calls, ensureStarted } = makeDispatch();
    const rev = await dispatch('shadowHostRecoverExpiredController', { controllerDeviceId: 'c' }) as { keyRotationId: string; leaseReacquired: boolean };
    expect(rev).toMatchObject({ keyRotationId: 'kr_recovery', leaseReacquired: true });
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(calls).toContain('recoverExpiredLeaseController');
  });

  it('lists controllers through the recovery reader when start fails into recovery state', async () => {
    const { rt, calls } = fakeRuntime();
    const ensureStarted = vi.fn(async () => {});
    (rt.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue?.({ state: 'error', hostDeviceId: 'h', fingerprint: 'fp', vaultAvailable: true, registered: true, epoch: 1, activeSessions: 0, controllers: 1, recoveryAvailable: true });
    const dispatch = createShadowHostDispatch({
      signedIn: () => true,
      hostDeviceId: () => 'deck-1',
      vaultAvailable: () => true,
      getRuntime: async () => rt,
      ensureStarted,
    });
    await dispatch('shadowHostListControllers', {});
    expect(calls).toContain('listControllersForRecovery');
    expect(calls).not.toContain('listControllers');
  });
});
