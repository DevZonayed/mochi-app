import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  orderCapabilities, approvalCapabilities, capabilityLabel, isFloorCapability,
  mapPendingRequest, mapController, mapApproveReceipt, statusView, statusPhase,
  genericMutationError, genericLoadError, CONTROLLER_CAPABILITY_FLOOR,
  type PendingRequestWire, type ControllerWire, type ApproveGrantWire, type ShadowHostStatusWire,
} from './shadowController';
import { createShadowHostDispatch } from '../../brain/shadow-host-dispatch';
import { SHADOW_HOST_METHODS } from '../../brain/shadow-host-dispatch';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';

const here = dirname(fileURLToPath(import.meta.url));

// Distinctive canary values that MUST NEVER survive into a view model / render.
const SIGNING_KEY = 'CANARY-SIGNING-PUBLIC-KEY-zzz';
const AGREEMENT_KEY = 'CANARY-AGREEMENT-PUBLIC-KEY-zzz';
const NONCE = 'CANARY-NONCE-zzz';
const TRANSCRIPT = 'CANARY-TRANSCRIPT-HASH-zzz';
const GRANT_ID = 'CANARY-GRANT-ID-zzz';
const KEY_ID = 'CANARY-KEY-ID-zzz';
const ROTATION_ID = 'CANARY-KEY-ROTATION-zzz';

function pendingWire(over: Partial<PendingRequestWire> = {}): PendingRequestWire {
  return {
    sessionId: 'sess-1',
    controllerDeviceId: 'ctrl-device-42',
    signingPublicKey: SIGNING_KEY,
    agreementPublicKey: AGREEMENT_KEY,
    nonce: NONCE,
    transcriptHash: TRANSCRIPT,
    requestedAt: 1_784_000_000_000,
    authString: 'brave-otter-9',
    sessionExpiresAt: 1_784_000_600_000,
    requestedCapabilities: ['job.start', 'account.read', 'session.message'],
    ...over,
  };
}

describe('shadowController capability model', () => {
  test('orderCapabilities dedupes, drops unknowns, and sorts canonically', () => {
    const out = orderCapabilities(['session.message', 'account.read', 'job.start', 'account.read', 'not-a-cap', 42 as unknown]);
    expect(out).toEqual(['account.read', 'session.message', 'job.start']);
  });

  test('approvalCapabilities returns only a subset of the request + retains floor; never widens', () => {
    const requested: ShadowCapability[] = ['account.read', 'session.message', 'job.start'];
    // Operator selected only job.start (+ tried to sneak in job.cancel which was NOT requested).
    const selected = new Set<ShadowCapability>(['job.start', 'job.cancel']);
    const payload = approvalCapabilities(requested, selected);
    expect(payload).toEqual(['account.read', 'job.start']); // floor retained, job.cancel dropped (not requested)
    expect(payload).not.toContain('job.cancel');
    expect(payload).not.toContain('session.message');
  });

  test('approvalCapabilities does not force the floor when it was not requested', () => {
    const requested: ShadowCapability[] = ['session.message', 'job.start'];
    const payload = approvalCapabilities(requested, new Set<ShadowCapability>(['session.message']));
    expect(payload).toEqual(['session.message']);
    expect(payload).not.toContain(CONTROLLER_CAPABILITY_FLOOR);
  });

  test('floor + labels are stable and non-empty', () => {
    expect(isFloorCapability('account.read')).toBe(true);
    expect(isFloorCapability('job.start')).toBe(false);
    expect(capabilityLabel('session.autopilot.set')).toBeTruthy();
  });
});

describe('shadowController mappers strip sensitive material', () => {
  test('mapPendingRequest keeps only safe fields; crypto material never survives', () => {
    const view = mapPendingRequest(pendingWire());
    expect(Object.keys(view).sort()).toEqual(
      ['authString', 'controllerDeviceId', 'requestedAt', 'requestedCapabilities', 'sessionExpiresAt', 'sessionId'].sort(),
    );
    expect(view.requestedCapabilities).toEqual(['account.read', 'session.message', 'job.start']);
    const blob = JSON.stringify(view);
    for (const canary of [SIGNING_KEY, AGREEMENT_KEY, NONCE, TRANSCRIPT]) {
      expect(blob).not.toContain(canary);
    }
  });

  test('mapController exposes only device id, exact status, expiry — no ids, no presence field', () => {
    const wire: ControllerWire = { controllerDeviceId: 'ctrl-9', grantId: GRANT_ID, keyId: KEY_ID, status: 'active', expiresAt: 123 };
    const view = mapController(wire);
    expect(Object.keys(view).sort()).toEqual(['controllerDeviceId', 'expiresAt', 'status']);
    // No presence/last-seen key exists on the view model at all.
    expect(view as Record<string, unknown>).not.toHaveProperty('online');
    expect(view as Record<string, unknown>).not.toHaveProperty('lastSeen');
    const blob = JSON.stringify(view);
    expect(blob).not.toContain(GRANT_ID);
    expect(blob).not.toContain(KEY_ID);
  });

  test('mapApproveReceipt drops grant/key ids and canonicalises granted caps', () => {
    const wire: ApproveGrantWire = { grantId: GRANT_ID, keyId: KEY_ID, controllerDeviceId: 'ctrl-9', expiresAt: 999, capabilities: ['job.start', 'account.read'] };
    const view = mapApproveReceipt(wire);
    expect(view.capabilities).toEqual(['account.read', 'job.start']);
    const blob = JSON.stringify(view);
    expect(blob).not.toContain(GRANT_ID);
    expect(blob).not.toContain(KEY_ID);
  });
});

describe('shadowController status + errors', () => {
  const base: ShadowHostStatusWire = {
    signedIn: true, state: 'running', hostDeviceId: 'mac-1', fingerprint: 'FP-secret', vaultAvailable: true,
    registered: true, epoch: 7, activeSessions: 2, controllers: 3,
  };
  test('online only when signed in AND running/starting', () => {
    expect(statusView(base).online).toBe(true);
    expect(statusView({ ...base, state: 'starting' }).online).toBe(true);
    expect(statusView({ ...base, state: 'stopped' }).online).toBe(false);
    expect(statusView({ ...base, signedIn: false }).online).toBe(false);
    expect(statusPhase({ ...base, signedIn: false })).toBe('signed-out');
    expect(statusPhase({ ...base, state: 'stopped' })).toBe('offline');
    expect(statusPhase(base)).toBe('ready');
  });
  test('statusView never leaks fingerprint/epoch/lastError', () => {
    const blob = JSON.stringify(statusView({ ...base, lastError: 'RAW-HOST-ERROR-secret' }));
    expect(blob).not.toContain('FP-secret');
    expect(blob).not.toContain('RAW-HOST-ERROR-secret');
    expect(blob).not.toContain('"epoch"');
  });
  test('generic errors are bounded and never echo a raw host string', () => {
    const raw = { status: 500, message: 'RAW-HOST-STACKTRACE-/Users/secret/path' };
    const msg = genericMutationError(raw);
    expect(msg).not.toContain('RAW-HOST-STACKTRACE');
    expect(msg).not.toContain('/Users/secret');
    expect(genericMutationError({ status: 401 })).toMatch(/sign in/i);
    expect(genericMutationError({ status: 409 })).toMatch(/no longer available/i);
    expect(genericLoadError()).toBeTruthy();
  });
});

// ── Real seam: renderer transport → shadow-host-dispatch (the live allowlist) ──
describe('renderer transport ↔ shadow-host-dispatch seam', () => {
  // The exact method names the renderer api wrappers call.
  const RENDERER_METHODS = ['shadowHostStatus', 'shadowHostListPending', 'shadowHostApprove', 'shadowHostDeny', 'shadowHostListControllers', 'shadowHostRevoke'];

  test('every renderer method is a real dispatch-allowlist method (no invented API)', () => {
    for (const m of RENDERER_METHODS) expect(SHADOW_HOST_METHODS).toContain(m);
  });

  function fakeRuntime() {
    const calls: Record<string, unknown[]> = {};
    const record = (k: string, v: unknown) => { (calls[k] ??= []).push(v); };
    return {
      calls,
      status: () => ({ state: 'running', hostDeviceId: 'mac-1', fingerprint: 'FP', vaultAvailable: true, registered: true, epoch: 1, activeSessions: 1, controllers: 1 }),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async listPendingRequests() { return [{ sessionId: 'sess-1', controllerDeviceId: 'ctrl-42', signingPublicKey: SIGNING_KEY, agreementPublicKey: AGREEMENT_KEY, nonce: NONCE, transcriptHash: TRANSCRIPT, requestedAt: 1, authString: 'x-y-z', sessionExpiresAt: 2, requestedCapabilities: ['account.read', 'job.start', 'session.message'] }]; },
      async approve(input: { sessionId: string; capabilities?: ShadowCapability[] }) { record('approve', input); return { grantId: GRANT_ID, keyId: KEY_ID, controllerDeviceId: 'ctrl-42', expiresAt: 3, capabilities: input.capabilities }; },
      async deny(input: unknown) { record('deny', input); },
      async listControllers() { return [{ controllerDeviceId: 'ctrl-42', grantId: GRANT_ID, keyId: KEY_ID, status: 'active', expiresAt: 4 }]; },
      async revoke(input: unknown) { record('revoke', input); return { keyRotationId: ROTATION_ID, alreadyRevoked: false }; },
    };
  }

  function makeTransport(rt: ReturnType<typeof fakeRuntime>) {
    // Real dispatch = the exact allowlist the sidecar routes shadowHost* through.
    const dispatch = createShadowHostDispatch({
      signedIn: () => true,
      hostDeviceId: () => 'mac-1',
      vaultAvailable: () => true,
      getRuntime: async () => rt as never,
      ensureStarted: async () => {},
    });
    // Mirror the renderer `call()` bridge contract: {ok,data}.
    return async (method: string, params: Record<string, unknown> = {}) => {
      const data = await dispatch(method, params);
      return { ok: true as const, data };
    };
  }

  test('list pending → view model carries no crypto material end-to-end', async () => {
    const rt = fakeRuntime();
    const transport = makeTransport(rt);
    const res = await transport('shadowHostListPending');
    const requests = (res.data as { requests: PendingRequestWire[] }).requests;
    const views = requests.map(mapPendingRequest);
    const blob = JSON.stringify(views);
    for (const canary of [SIGNING_KEY, AGREEMENT_KEY, NONCE, TRANSCRIPT]) expect(blob).not.toContain(canary);
    expect(views[0].requestedCapabilities).toEqual(['account.read', 'session.message', 'job.start']);
  });

  test('approve forwards exactly the selected capability subset to the host runtime', async () => {
    const rt = fakeRuntime();
    const transport = makeTransport(rt);
    const res = await transport('shadowHostApprove', { sessionId: 'sess-1', capabilities: ['account.read', 'job.start'] });
    // The real dispatch passed our subset straight to runtime.approve.
    expect(rt.calls.approve).toHaveLength(1);
    expect((rt.calls.approve[0] as { capabilities: string[] }).capabilities).toEqual(['account.read', 'job.start']);
    const receipt = mapApproveReceipt(res.data as ApproveGrantWire);
    expect(JSON.stringify(receipt)).not.toContain(GRANT_ID);
    expect(receipt.capabilities).toEqual(['account.read', 'job.start']);
  });

  test('list controllers → view model has exact status + no internal ids', async () => {
    const rt = fakeRuntime();
    const transport = makeTransport(rt);
    const res = await transport('shadowHostListControllers');
    const views = (res.data as { controllers: ControllerWire[] }).controllers.map(mapController);
    expect(views[0]).toEqual({ controllerDeviceId: 'ctrl-42', status: 'active', expiresAt: 4 });
    expect(JSON.stringify(views)).not.toContain(GRANT_ID);
  });

  test('revoke round-trips the idempotent flag without leaking the rotation id to the view', async () => {
    const rt = fakeRuntime();
    const transport = makeTransport(rt);
    const res = await transport('shadowHostRevoke', { controllerDeviceId: 'ctrl-42' });
    const wire = res.data as { alreadyRevoked: boolean };
    expect(wire.alreadyRevoked).toBe(false);
    expect(rt.calls.revoke).toHaveLength(1);
    // The renderer never surfaces keyRotationId; the pane only reads alreadyRevoked.
  });

  test('unknown shadowHost method is rejected by the real allowlist (no shortcut)', async () => {
    const rt = fakeRuntime();
    const transport = makeTransport(rt);
    await expect(transport('shadowHostNukeEverything')).rejects.toThrow();
  });
});

// ── Production-source negative scan (the rendered component) ───────────────────
describe('ControllersPane production source is truthful', () => {
  const src = readFileSync(join(here, '..', 'screens', 'ControllersPane.tsx'), 'utf8');
  test('never references crypto material or internal ids', () => {
    for (const forbidden of ['signingPublicKey', 'agreementPublicKey', 'transcriptHash', 'grantId', 'keyId', 'keyRotationId', 'fingerprint', 'epoch']) {
      expect(src).not.toContain(forbidden);
    }
  });
  test('no presence fabrication, no timers, no random activity', () => {
    for (const forbidden of ['lastSeen', 'last seen', 'Last seen', 'setInterval', 'setTimeout', 'Math.random', 'Date.now']) {
      expect(src).not.toContain(forbidden);
    }
  });
  test('no static/global granted capability array literal', () => {
    // Capability sets are always derived from wire data via the shared vocabulary,
    // never a hardcoded granted list in the component.
    expect(src).not.toMatch(/\[\s*'account\.read'\s*,\s*'session\.message'/);
  });
});
