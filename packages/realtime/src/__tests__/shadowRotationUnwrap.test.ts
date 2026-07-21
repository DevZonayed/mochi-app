import { describe, it, expect } from 'vitest';
import { nodeShadowCrypto as backend } from '../shadowCryptoNode.js';
import { base64urlEncode } from '../shadowCrypto.js';
import {
  generateShadowIdentity,
  approveEnrollment,
  acceptEnrollmentGrant,
  unwrapRotatedScopeKey,
  SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME,
  SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
  type EnrollmentBootstrap,
} from '../shadowEnrollment.js';
import type { Fence } from '../shadowProtocol.js';

/**
 * unwrapRotatedScopeKey models the post-revocation rotation the server performs:
 * the grant row's ciphertext (keyId/wrapNonce/wrappedScopeKey) rotates while the
 * stored Ed25519 grant signature stays STALE. acceptEnrollmentGrant (initial
 * enrollment) must reject the stale signature; unwrapRotatedScopeKey must still
 * unwrap via the authenticated AEAD path.
 */
describe('unwrapRotatedScopeKey', () => {
  it('unwraps a rotated key whose grant signature is stale, and the new key differs', async () => {
    const nowMs = 1_700_000_000_000;
    const host = await generateShadowIdentity(backend, 'host_rot');
    const controller = await generateShadowIdentity(backend, 'ctrl_rot');
    const accountId = 'acct_rot';
    const fence: Fence = { accountId, scopeId: `account:${accountId}`, hostDeviceId: host.deviceId, epoch: 1, leaseId: 'lease_rot' };
    const transcriptHash = await backend.sha256(new TextEncoder().encode('transcript-rot'));
    const bootstrap: EnrollmentBootstrap = {
      scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
      sessionId: 'es_rot', accountId, hostDeviceId: host.deviceId, hostSigningKeyId: host.signingKeyId,
      hostSigningPublicKey: base64urlEncode(host.signingPublicKey), hostAgreementPublicKey: base64urlEncode(host.agreementPublicKey),
      relayOrigin: 'https://relay.test', secret: base64urlEncode(new Uint8Array(32)), expiresAt: nowMs + 120_000,
    };

    const grantId = 'eg_stable';
    // Initial grant with scope key k1.
    const a1 = await approveEnrollment(backend, {
      host, fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: controller.agreementPublicKey,
      transcriptHash, sessionId: 'es_rot', nowMs, grantId,
    });
    const accepted = await acceptEnrollmentGrant(backend, { controller, bootstrap, grant: a1.grant, keyMaterial: a1.keyMaterial, transcriptHash, nowMs });
    expect(accepted.ok).toBe(true);

    // Rotation: same grantId, NEW scope key k2 → new keyId + wrapped material.
    const k2 = backend.randomBytes(32);
    const a2 = await approveEnrollment(backend, {
      host, fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: controller.agreementPublicKey,
      transcriptHash, sessionId: 'rotation', nowMs, grantId, scopeKey: k2,
    });
    expect(a2.grant.keyId).not.toBe(a1.grant.keyId);

    // Model the relay's stored grant after rotation: new ciphertext keyId, but
    // the STALE original signature/signedAt/expiresAt.
    const rotatedGrantAsStored = { ...a2.grant, signature: a1.grant.signature, signedAt: a1.grant.signedAt, expiresAt: a1.grant.expiresAt };

    // acceptEnrollmentGrant rejects the stale signature.
    const rejected = await acceptEnrollmentGrant(backend, { controller, bootstrap, grant: rotatedGrantAsStored, keyMaterial: a2.keyMaterial, transcriptHash, nowMs });
    expect(rejected).toEqual({ ok: false, reason: 'bad-signature' });

    // unwrapRotatedScopeKey unwraps the authenticated AEAD and yields k2.
    const rotated = await unwrapRotatedScopeKey(backend, { controller, bootstrap, grant: rotatedGrantAsStored, keyMaterial: a2.keyMaterial, transcriptHash, nowMs });
    expect(rotated.ok).toBe(true);
    expect(Buffer.from((rotated as { ok: true; scopeKey: Uint8Array }).scopeKey)).toEqual(Buffer.from(k2));
    expect((rotated as { ok: true; scopeKeyId: string }).scopeKeyId).toBe(a2.grant.keyId);
  });

  it('rejects a rotated key for the wrong controller or a bad transcript', async () => {
    const nowMs = 1_700_000_000_000;
    const host = await generateShadowIdentity(backend, 'host_rot2');
    const controller = await generateShadowIdentity(backend, 'ctrl_rot2');
    const other = await generateShadowIdentity(backend, 'ctrl_other');
    const accountId = 'acct_rot2';
    const fence: Fence = { accountId, scopeId: `account:${accountId}`, hostDeviceId: host.deviceId, epoch: 1, leaseId: 'l' };
    const transcriptHash = await backend.sha256(new TextEncoder().encode('t2'));
    const bootstrap: EnrollmentBootstrap = {
      scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
      sessionId: 'es', accountId, hostDeviceId: host.deviceId, hostSigningKeyId: host.signingKeyId,
      hostSigningPublicKey: base64urlEncode(host.signingPublicKey), hostAgreementPublicKey: base64urlEncode(host.agreementPublicKey),
      relayOrigin: 'https://relay.test', secret: base64urlEncode(new Uint8Array(32)), expiresAt: nowMs + 120_000,
    };
    const a = await approveEnrollment(backend, { host, fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: controller.agreementPublicKey, transcriptHash, sessionId: 'es', nowMs, grantId: 'eg' });
    // Wrong controller identity cannot unwrap.
    const wrong = await unwrapRotatedScopeKey(backend, { controller: other, bootstrap, grant: a.grant, keyMaterial: a.keyMaterial, transcriptHash, nowMs });
    expect(wrong.ok).toBe(false);
    // Bad transcript hash is rejected.
    const badT = await unwrapRotatedScopeKey(backend, { controller, bootstrap, grant: a.grant, keyMaterial: a.keyMaterial, transcriptHash: await backend.sha256(new TextEncoder().encode('nope')), nowMs });
    expect(badT.ok).toBe(false);
  });
});
