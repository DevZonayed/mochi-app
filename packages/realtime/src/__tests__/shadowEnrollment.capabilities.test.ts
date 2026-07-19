import { describe, expect, it } from 'vitest';
import { nodeShadowCrypto } from '../shadowCryptoNode';
import { base64urlDecode } from '../shadowCrypto';
import {
  acceptEnrollmentGrant,
  approveEnrollment,
  buildEnrollmentRequest,
  createEnrollmentSession,
  decodeEnrollmentBootstrap,
  encodeEnrollmentBootstrap,
  generateShadowIdentity,
  rotateScopeKeyForControllers,
  unwrapRotatedScopeKey,
  verifyEnrollmentGrantSignature,
  verifyEnrollmentRequest,
  type EnrollmentGrantMessage,
  type ShadowIdentity,
} from '../shadowEnrollment';
import type { Fence } from '../shadowProtocol';
import type { ShadowCapability } from '../shadowCapabilities';

const backend = nodeShadowCrypto;
const NOW = 1_700_000_000_000;
const RELAY = 'https://api.nexalance.cloud';

function fenceFor(host: ShadowIdentity, epoch = 1): Fence {
  return { accountId: 'acct_main', scopeId: 'scope_default', hostDeviceId: host.deviceId, epoch, leaseId: 'lease_1' };
}

/** Drive enrollment up to the verified request; returns everything approval needs. */
async function enrollUpToApproval(deviceId = 'ctrl_phone_1') {
  const pepper = backend.randomBytes(32);
  const host = await generateShadowIdentity(backend, 'host_mac_1');
  const controller = await generateShadowIdentity(backend, deviceId);
  const creation = await createEnrollmentSession(backend, { host, accountId: 'acct_main', relayOrigin: RELAY, nowMs: NOW, serverPepper: pepper });
  const decoded = decodeEnrollmentBootstrap(encodeEnrollmentBootstrap(creation.bootstrap), { allowedOrigins: [RELAY], nowMs: NOW + 1 });
  if (!decoded.ok) throw new Error('bootstrap');
  const { request } = await buildEnrollmentRequest(backend, { controller, bootstrap: decoded.value, nowMs: NOW + 2000 });
  const verified = await verifyEnrollmentRequest(backend, { request, bootstrap: creation.bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
  if (!verified.ok) throw new Error(verified.reason);
  return { host, controller, bootstrap: decoded.value, verified, fence: fenceFor(host), sessionId: request.sessionId };
}

describe('enrollment grant — capability binding', () => {
  it('binds host-approved capabilities and the controller reads back the exact set', async () => {
    const e = await enrollUpToApproval();
    const capabilities: ShadowCapability[] = ['account.read', 'session.message', 'job.start'];
    const approval = await approveEnrollment(backend, {
      host: e.host, fence: e.fence, controllerDeviceId: e.controller.deviceId,
      controllerAgreementPublicKey: e.verified.controllerAgreementPublicKey,
      transcriptHash: e.verified.transcriptHash, sessionId: e.sessionId, nowMs: NOW + 3500, capabilities,
    });
    expect(approval.grant.capabilities).toEqual(capabilities);
    expect(approval.capabilities).toEqual(capabilities);

    const accepted = await acceptEnrollmentGrant(backend, {
      controller: e.controller, bootstrap: e.bootstrap, grant: approval.grant,
      keyMaterial: approval.keyMaterial, transcriptHash: e.verified.transcriptHash, nowMs: NOW + 4000,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.capabilities).toEqual(capabilities);
  });

  it('legacy grant (no capability field) is accepted as account.read only', async () => {
    const e = await enrollUpToApproval();
    const approval = await approveEnrollment(backend, {
      host: e.host, fence: e.fence, controllerDeviceId: e.controller.deviceId,
      controllerAgreementPublicKey: e.verified.controllerAgreementPublicKey,
      transcriptHash: e.verified.transcriptHash, sessionId: e.sessionId, nowMs: NOW + 3500,
      // no capabilities → legacy grant
    });
    expect('capabilities' in approval.grant).toBe(false);
    const accepted = await acceptEnrollmentGrant(backend, {
      controller: e.controller, bootstrap: e.bootstrap, grant: approval.grant,
      keyMaterial: approval.keyMaterial, transcriptHash: e.verified.transcriptHash, nowMs: NOW + 4000,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.capabilities).toEqual(['account.read']);
  });

  it('is byte-additive: forging a capability field onto a legacy grant fails the signature', async () => {
    const e = await enrollUpToApproval();
    const legacy = await approveEnrollment(backend, {
      host: e.host, fence: e.fence, controllerDeviceId: e.controller.deviceId,
      controllerAgreementPublicKey: e.verified.controllerAgreementPublicKey,
      transcriptHash: e.verified.transcriptHash, sessionId: e.sessionId, nowMs: NOW + 3500,
    });
    // The legacy grant signature verifies against a host key with NO capability bytes.
    const hostSigningPub = base64urlDecode(e.bootstrap.hostSigningPublicKey);
    expect(await verifyEnrollmentGrantSignature(backend, hostSigningPub, legacy.grant, e.verified.transcriptHash)).toBe(true);
    // Attacker injects an elevated capability set the host never signed.
    const forged: EnrollmentGrantMessage = { ...legacy.grant, capabilities: ['account.read', 'job.start'] };
    expect(await verifyEnrollmentGrantSignature(backend, hostSigningPub, forged, e.verified.transcriptHash)).toBe(false);
    const accepted = await acceptEnrollmentGrant(backend, {
      controller: e.controller, bootstrap: e.bootstrap, grant: forged,
      keyMaterial: legacy.keyMaterial, transcriptHash: e.verified.transcriptHash, nowMs: NOW + 4000,
    });
    expect(accepted).toMatchObject({ ok: false });
  });

  it('rejects a downgraded and an escalated capability set (tamper)', async () => {
    const e = await enrollUpToApproval();
    const capabilities: ShadowCapability[] = ['account.read', 'session.message', 'job.start'];
    const approval = await approveEnrollment(backend, {
      host: e.host, fence: e.fence, controllerDeviceId: e.controller.deviceId,
      controllerAgreementPublicKey: e.verified.controllerAgreementPublicKey,
      transcriptHash: e.verified.transcriptHash, sessionId: e.sessionId, nowMs: NOW + 3500, capabilities,
    });
    const hostSigningPub = base64urlDecode(e.bootstrap.hostSigningPublicKey);
    const downgraded: EnrollmentGrantMessage = { ...approval.grant, capabilities: ['account.read'] };
    const escalated: EnrollmentGrantMessage = { ...approval.grant, capabilities: ['account.read', 'session.message', 'job.start', 'job.cancel'] };
    const unknownCap: EnrollmentGrantMessage = { ...approval.grant, capabilities: ['account.read', 'shell.exec' as ShadowCapability] };
    for (const tampered of [downgraded, escalated, unknownCap]) {
      expect(await verifyEnrollmentGrantSignature(backend, hostSigningPub, tampered, e.verified.transcriptHash)).toBe(false);
      const accepted = await acceptEnrollmentGrant(backend, {
        controller: e.controller, bootstrap: e.bootstrap, grant: tampered,
        keyMaterial: approval.keyMaterial, transcriptHash: e.verified.transcriptHash, nowMs: NOW + 4000,
      });
      expect(accepted).toMatchObject({ ok: false });
    }
  });

  it('reordering/duplicating capabilities is semantically equal (same set → still verifies)', async () => {
    const e = await enrollUpToApproval();
    const approval = await approveEnrollment(backend, {
      host: e.host, fence: e.fence, controllerDeviceId: e.controller.deviceId,
      controllerAgreementPublicKey: e.verified.controllerAgreementPublicKey,
      transcriptHash: e.verified.transcriptHash, sessionId: e.sessionId, nowMs: NOW + 3500,
      capabilities: ['account.read', 'job.start'],
    });
    const hostSigningPub = base64urlDecode(e.bootstrap.hostSigningPublicKey);
    // Same SET, different wire order + a duplicate — canonicalisation makes it equal.
    const reordered: EnrollmentGrantMessage = { ...approval.grant, capabilities: ['job.start', 'account.read', 'job.start'] };
    expect(await verifyEnrollmentGrantSignature(backend, hostSigningPub, reordered, e.verified.transcriptHash)).toBe(true);
  });

  it('approveEnrollment throws on an invalid capability set (host bug, no silent downgrade)', async () => {
    const e = await enrollUpToApproval();
    await expect(approveEnrollment(backend, {
      host: e.host, fence: e.fence, controllerDeviceId: e.controller.deviceId,
      controllerAgreementPublicKey: e.verified.controllerAgreementPublicKey,
      transcriptHash: e.verified.transcriptHash, sessionId: e.sessionId, nowMs: NOW + 3500,
      capabilities: ['account.read', 'nope' as ShadowCapability],
    })).rejects.toThrow(/invalid capabilities/);
  });

  it('key rotation preserves each controller capability set', async () => {
    const e = await enrollUpToApproval();
    const capabilities: ShadowCapability[] = ['account.read', 'approval.respond'];
    // initial grant with caps (establishes the controller's approved set)
    await approveEnrollment(backend, {
      host: e.host, fence: e.fence, controllerDeviceId: e.controller.deviceId,
      controllerAgreementPublicKey: e.verified.controllerAgreementPublicKey,
      transcriptHash: e.verified.transcriptHash, sessionId: e.sessionId, nowMs: NOW + 3500, capabilities,
    });
    // rotate scope key after some OTHER controller was revoked; this controller remains
    const rotatedFence = fenceFor(e.host, 2);
    const rotation = await rotateScopeKeyForControllers(backend, {
      host: e.host, fence: rotatedFence, revokedControllerDeviceId: 'ctrl_other',
      remaining: [{
        controllerDeviceId: e.controller.deviceId,
        agreementPublicKey: e.verified.controllerAgreementPublicKey,
        transcriptHash: e.verified.transcriptHash,
        capabilities,
      }],
      nowMs: NOW + 5000,
    });
    const perCtrl = rotation.perController[0];
    expect(perCtrl.grant.capabilities).toEqual(capabilities);
    const unwrapped = await unwrapRotatedScopeKey(backend, {
      controller: e.controller, bootstrap: e.bootstrap, grant: perCtrl.grant,
      keyMaterial: perCtrl.keyMaterial, transcriptHash: e.verified.transcriptHash, nowMs: NOW + 6000,
    });
    expect(unwrapped.ok).toBe(true);
    if (unwrapped.ok) expect(unwrapped.capabilities).toEqual(capabilities);
  });
});

describe('enrollment request — controller-signed requested capabilities (§1-A)', () => {
  async function buildReq(requestedCapabilities?: ShadowCapability[]) {
    const pepper = backend.randomBytes(32);
    const host = await generateShadowIdentity(backend, 'host_mac_1');
    const controller = await generateShadowIdentity(backend, 'ctrl_phone_1');
    const creation = await createEnrollmentSession(backend, { host, accountId: 'acct_main', relayOrigin: RELAY, nowMs: NOW, serverPepper: pepper });
    const decoded = decodeEnrollmentBootstrap(encodeEnrollmentBootstrap(creation.bootstrap), { allowedOrigins: [RELAY], nowMs: NOW + 1 });
    if (!decoded.ok) throw new Error('bootstrap');
    const { request } = await buildEnrollmentRequest(backend, { controller, bootstrap: decoded.value, nowMs: NOW + 2000, requestedCapabilities });
    return { host, controller, bootstrap: creation.bootstrap, request, fence: fenceFor(host) };
  }

  it('binds a requested set into the controller-signed request; verify returns the exact set', async () => {
    const requested: ShadowCapability[] = ['account.read', 'session.message', 'job.start'];
    const { bootstrap, request } = await buildReq(requested);
    expect(request.requestedCapabilities).toEqual(requested);
    const v = await verifyEnrollmentRequest(backend, { request, bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.requestedCapabilities).toEqual(requested);
  });

  it('legacy request (no field) verifies as account.read only', async () => {
    const { bootstrap, request } = await buildReq(undefined);
    expect('requestedCapabilities' in request).toBe(false);
    const v = await verifyEnrollmentRequest(backend, { request, bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.requestedCapabilities).toEqual(['account.read']);
  });

  it('tamper — strip / escalate / downgrade / unknown requested set breaks the request signature', async () => {
    const { bootstrap, request } = await buildReq(['account.read', 'session.message']);
    const strip = { ...request }; delete (strip as { requestedCapabilities?: unknown }).requestedCapabilities;
    const escalate = { ...request, requestedCapabilities: ['account.read', 'session.message', 'job.start'] as ShadowCapability[] };
    const downgrade = { ...request, requestedCapabilities: ['account.read'] as ShadowCapability[] };
    const unknown = { ...request, requestedCapabilities: ['account.read', 'shell.exec' as ShadowCapability] };
    // Deliberately-tampered request shapes for a negative test; coerce to the base
    // request type so the union (strip omits the optional field) stays assignable.
    for (const tampered of [strip, escalate, downgrade, unknown] as (typeof request)[]) {
      const v = await verifyEnrollmentRequest(backend, { request: tampered, bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
      expect(v.ok).toBe(false);
    }
  });

  it('reorder / duplicate requested set is semantically equal → still verifies', async () => {
    const { bootstrap, request } = await buildReq(['account.read', 'job.start']);
    const reordered = { ...request, requestedCapabilities: ['job.start', 'account.read', 'job.start'] as ShadowCapability[] };
    const v = await verifyEnrollmentRequest(backend, { request: reordered, bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
    expect(v.ok).toBe(true);
  });

  it('host CANNOT approve a capability outside the verified requested set (no self-escalation)', async () => {
    const requested: ShadowCapability[] = ['account.read', 'session.message'];
    const { host, controller, bootstrap, request, fence } = await buildReq(requested);
    const v = await verifyEnrollmentRequest(backend, { request, bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // Approving within the requested set (+ read floor) succeeds.
    const okApproval = await approveEnrollment(backend, {
      host, fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: v.controllerAgreementPublicKey,
      transcriptHash: v.transcriptHash, sessionId: request.sessionId, nowMs: NOW + 3500,
      capabilities: ['account.read', 'session.message'], requestedCapabilities: v.requestedCapabilities,
    });
    expect(okApproval.capabilities).toEqual(['account.read', 'session.message']);
    // Approving an UNREQUESTED elevated capability throws (host cannot self-escalate).
    await expect(approveEnrollment(backend, {
      host, fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: v.controllerAgreementPublicKey,
      transcriptHash: v.transcriptHash, sessionId: request.sessionId, nowMs: NOW + 3500,
      capabilities: ['account.read', 'job.start'], requestedCapabilities: v.requestedCapabilities,
    })).rejects.toThrow(/exceeds the verified requested set/);
  });
});
