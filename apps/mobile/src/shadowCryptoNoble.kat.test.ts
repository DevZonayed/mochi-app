/**
 * Known-answer / interoperability test: the RN @noble backend must be
 * byte-for-byte interoperable with the Node backend for every primitive the
 * enrollment protocol uses, so a phone (noble) and a Mac (node) speak the exact
 * same crypto. Uses a deterministic injected CSPRNG for reproducibility.
 */
import { describe, it, expect } from 'vitest';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import {
  generateShadowIdentity,
  createEnrollmentSession,
  encodeEnrollmentBootstrap,
  decodeEnrollmentBootstrap,
  buildEnrollmentRequest,
  verifyEnrollmentRequest,
  approveEnrollment,
  acceptEnrollmentGrant,
} from '@maestro/realtime/shadowEnrollment';
import { nobleShadowCrypto } from './shadowCryptoNoble';

const node = nodeShadowCrypto;
const noble = nobleShadowCrypto((n) => {
  // Deterministic counter-based bytes — fine for KAT (not used for real secrets).
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 37 + 11) & 0xff;
  return out;
});

const enc = (s: string) => new TextEncoder().encode(s);

describe('noble ↔ node backend interoperability (KAT)', () => {
  it('sha256 / hmac / hkdf are byte-identical', async () => {
    const data = enc('maestro-shadow-kat');
    expect(Buffer.from(await noble.sha256(data))).toEqual(Buffer.from(await node.sha256(data)));
    const key = enc('k'.repeat(32));
    expect(Buffer.from(await noble.hmacSha256(key, data))).toEqual(Buffer.from(await node.hmacSha256(key, data)));
    const hk1 = await noble.hkdfSha256(data, enc('salt'), enc('info'), 32);
    const hk2 = await node.hkdfSha256(data, enc('salt'), enc('info'), 32);
    expect(Buffer.from(hk1)).toEqual(Buffer.from(hk2));
  });

  it('Ed25519 signatures cross-verify in both directions', async () => {
    const kp = await node.generateSigningKeyPair();
    const msg = enc('cross-verify');
    const nodeSig = await node.sign(kp.privateKey, msg);
    const nobleSig = await noble.sign(kp.privateKey, msg);
    // Ed25519 is deterministic → identical signatures.
    expect(Buffer.from(nobleSig)).toEqual(Buffer.from(nodeSig));
    expect(await noble.verify(kp.publicKey, msg, nodeSig)).toBe(true);
    expect(await node.verify(kp.publicKey, msg, nobleSig)).toBe(true);
    // A tampered message fails both.
    expect(await noble.verify(kp.publicKey, enc('tampered'), nodeSig)).toBe(false);
  });

  it('X25519 shared secrets match across backends', async () => {
    const a = await node.generateAgreementKeyPair();
    const b = await noble.generateAgreementKeyPair();
    const ab = await node.deriveSharedSecret(a.privateKey, b.publicKey);
    const ba = await noble.deriveSharedSecret(b.privateKey, a.publicKey);
    expect(Buffer.from(ab)).toEqual(Buffer.from(ba));
  });

  it('AES-256-GCM seals on one backend and opens on the other', async () => {
    const key = enc('0123456789abcdef0123456789abcdef');
    const nonce = new Uint8Array(12).fill(7);
    const aad = enc('aad-bytes');
    const pt = enc('the scope key would go here 32by');
    const sealedNode = await node.aesGcmSeal(key, nonce, pt, aad);
    const sealedNoble = await noble.aesGcmSeal(key, nonce, pt, aad);
    expect(Buffer.from(sealedNoble)).toEqual(Buffer.from(sealedNode));
    expect(Buffer.from((await noble.aesGcmOpen(key, nonce, sealedNode, aad))!)).toEqual(Buffer.from(pt));
    expect(Buffer.from((await node.aesGcmOpen(key, nonce, sealedNoble, aad))!)).toEqual(Buffer.from(pt));
    // Wrong AAD fails to open.
    expect(await noble.aesGcmOpen(key, nonce, sealedNode, enc('wrong'))).toBeNull();
  });

  it('full enrollment round-trip: node HOST ↔ noble CONTROLLER shares the scope key', async () => {
    const accountId = 'acct_kat';
    const relayOrigin = 'https://relay.test';
    const nowMs = 1_700_000_000_000;
    // Host on node backend.
    const host = await generateShadowIdentity(node, 'host_kat');
    const created = await createEnrollmentSession(node, {
      host, accountId, relayOrigin, nowMs, ttlMs: 120_000, serverPepper: enc('pepper'),
    });
    const link = encodeEnrollmentBootstrap(created.bootstrap);
    // Controller on noble backend parses + requests.
    const decoded = decodeEnrollmentBootstrap(link, { allowedOrigins: [relayOrigin], nowMs });
    expect(decoded.ok).toBe(true);
    const bootstrap = (decoded as { ok: true; value: typeof created.bootstrap }).value;
    const controller = await generateShadowIdentity(noble, 'ctrl_kat');
    const { request } = await buildEnrollmentRequest(noble, { controller, bootstrap, nowMs });
    // Host verifies the noble-signed request.
    const verified = await verifyEnrollmentRequest(node, { request, bootstrap: created.bootstrap, expectedAccountId: accountId, nowMs });
    expect(verified.ok).toBe(true);
    // Host approves (node) → controller accepts + unwraps (noble).
    const fence = { accountId, scopeId: `account:${accountId}`, hostDeviceId: host.deviceId, epoch: 1, leaseId: 'lease_kat' };
    const approval = await approveEnrollment(node, {
      host, fence, controllerDeviceId: controller.deviceId,
      controllerAgreementPublicKey: controller.agreementPublicKey,
      transcriptHash: (verified as { ok: true; transcriptHash: Uint8Array }).transcriptHash,
      sessionId: created.sessionId, nowMs, ttlMs: 120_000,
    });
    const accepted = await acceptEnrollmentGrant(noble, {
      controller, bootstrap, grant: approval.grant, keyMaterial: approval.keyMaterial,
      transcriptHash: (verified as { ok: true; transcriptHash: Uint8Array }).transcriptHash, nowMs,
    });
    expect(accepted.ok).toBe(true);
    // The scope key the noble controller unwrapped equals the node host's key.
    expect(Buffer.from((accepted as { ok: true; scopeKey: Uint8Array }).scopeKey)).toEqual(Buffer.from(approval.scopeKey));
  });
});
