import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  webcryptoShadowCrypto,
  type ShadowCryptoBackend,
} from '../shadowCrypto';
import { nodeShadowCrypto, nodeWebCryptoInstance } from '../shadowCryptoNode';
import {
  SHADOW_ENROLLMENT_SESSION_MAX_TTL_MS,
  acceptEnrollmentGrant,
  approveEnrollment,
  buildEnrollmentRequest,
  createEnrollmentSession,
  decodeEnrollmentBootstrap,
  encodeEnrollmentBootstrap,
  enrollmentTranscriptHash,
  generateShadowIdentity,
  makeEnrollmentSecretVerifier,
  rotateScopeKeyForControllers,
  signDeviceRevocation,
  signKeyRotation,
  verifyDeviceRevocation,
  verifyEnrollmentRequest,
  verifyEnrollmentSecret,
  verifyKeyRotation,
  type EnrollmentServerRecord,
  type ShadowIdentity,
} from '../shadowEnrollment';
import { decodeShadowMessage, type Fence } from '../shadowProtocol';

const web = webcryptoShadowCrypto(nodeWebCryptoInstance);
const NOW = 1_700_000_000_000;
const RELAY = 'https://api.nexalance.cloud';

function fenceFor(host: ShadowIdentity, epoch = 1): Fence {
  return { accountId: 'acct_main', scopeId: 'scope_default', hostDeviceId: host.deviceId, epoch, leaseId: 'lease_1' };
}

/**
 * Minimal in-test account relay: consumes an enrollment session exactly once and
 * verifies the presented one-time secret against the stored peppered verifier.
 */
function makeServer(pepper: Uint8Array) {
  const sessions = new Map<string, EnrollmentServerRecord & { consumed: boolean; denied: boolean }>();
  return {
    put(record: EnrollmentServerRecord) {
      sessions.set(record.sessionId, { ...record, consumed: false, denied: false });
    },
    async consume(input: { sessionId: string; accountId: string; presentedSecret: Uint8Array; nowMs: number }): Promise<{ ok: true } | { ok: false; reason: string }> {
      const s = sessions.get(input.sessionId);
      if (!s) return { ok: false, reason: 'no-session' };
      if (s.denied) return { ok: false, reason: 'denied' };
      if (s.consumed) return { ok: false, reason: 'already-consumed' };
      if (input.nowMs >= s.expiresAt) return { ok: false, reason: 'expired' };
      if (input.accountId !== s.accountId) return { ok: false, reason: 'account-mismatch' };
      const good = await verifyEnrollmentSecret(nodeShadowCrypto, { sessionId: input.sessionId, accountId: input.accountId, presentedSecret: input.presentedSecret, stored: s.secretVerifier, pepper });
      if (!good) return { ok: false, reason: 'bad-secret' };
      s.consumed = true; // atomic single-use consume
      return { ok: true };
    },
  };
}

async function runFullEnrollment(hostBackend: ShadowCryptoBackend, controllerBackend: ShadowCryptoBackend) {
  const pepper = hostBackend.randomBytes(32);
  const server = makeServer(pepper);
  const host = await generateShadowIdentity(hostBackend, 'host_mac_1');
  const controller = await generateShadowIdentity(controllerBackend, 'ctrl_phone_1');

  const creation = await createEnrollmentSession(hostBackend, { host, accountId: 'acct_main', relayOrigin: RELAY, nowMs: NOW, serverPepper: pepper });
  server.put(creation.serverRecord);

  const link = encodeEnrollmentBootstrap(creation.bootstrap);
  const decoded = decodeEnrollmentBootstrap(link, { allowedOrigins: [RELAY], nowMs: NOW + 1000 });
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error('bootstrap');

  const { request, presentedSecret } = await buildEnrollmentRequest(controllerBackend, { controller, bootstrap: decoded.value, nowMs: NOW + 2000 });

  // server checks secret possession + consumes atomically
  const consume = await server.consume({ sessionId: request.sessionId, accountId: request.accountId, presentedSecret, nowMs: NOW + 2500 });
  expect(consume).toEqual({ ok: true });

  // host verifies request + operator approves
  const verified = await verifyEnrollmentRequest(hostBackend, { request, bootstrap: creation.bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.reason);

  const fence = fenceFor(host);
  const approval = await approveEnrollment(hostBackend, {
    host, fence, controllerDeviceId: controller.deviceId,
    controllerAgreementPublicKey: verified.controllerAgreementPublicKey,
    transcriptHash: verified.transcriptHash, sessionId: request.sessionId, nowMs: NOW + 3500,
  });

  // controller unwraps
  const accepted = await acceptEnrollmentGrant(controllerBackend, {
    controller, bootstrap: decoded.value, grant: approval.grant, keyMaterial: approval.keyMaterial,
    transcriptHash: verified.transcriptHash, nowMs: NOW + 4000,
  });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(accepted.reason);

  return { host, controller, creation, decoded: decoded.value, request, presentedSecret, verified, approval, accepted, fence, server, pepper };
}

describe('enrollment bootstrap (QR / deep link)', () => {
  it('encodes/decodes and enforces origin allowlist + TTL', async () => {
    const host = await generateShadowIdentity(nodeShadowCrypto, 'host_mac_1');
    const pepper = nodeShadowCrypto.randomBytes(32);
    const creation = await createEnrollmentSession(nodeShadowCrypto, { host, accountId: 'acct_main', relayOrigin: RELAY, nowMs: NOW, serverPepper: pepper });
    const link = encodeEnrollmentBootstrap(creation.bootstrap);
    expect(link.startsWith('maestro-shadow://enroll?')).toBe(true);

    expect(decodeEnrollmentBootstrap(link, { allowedOrigins: ['https://evil.example'], nowMs: NOW }).ok).toBe(false);
    expect(decodeEnrollmentBootstrap(link, { allowedOrigins: [RELAY], nowMs: creation.bootstrap.expiresAt }).ok).toBe(false); // expired
    const ok = decodeEnrollmentBootstrap(link, { allowedOrigins: [RELAY], nowMs: NOW });
    expect(ok.ok).toBe(true);
  });

  it('caps session TTL at 5 minutes', async () => {
    const host = await generateShadowIdentity(nodeShadowCrypto, 'host_mac_1');
    const creation = await createEnrollmentSession(nodeShadowCrypto, { host, accountId: 'acct_main', relayOrigin: RELAY, nowMs: NOW, ttlMs: 60 * 60_000, serverPepper: nodeShadowCrypto.randomBytes(32) });
    expect(creation.bootstrap.expiresAt - NOW).toBe(SHADOW_ENROLLMENT_SESSION_MAX_TTL_MS);
  });
});

describe('one-time secret verifier', () => {
  it('verifies the correct secret and rejects wrong secret / wrong pepper', async () => {
    const pepper = nodeShadowCrypto.randomBytes(32);
    const secret = nodeShadowCrypto.randomBytes(32);
    const salt = nodeShadowCrypto.randomBytes(16);
    const stored = await makeEnrollmentSecretVerifier(nodeShadowCrypto, { sessionId: 'es_1', accountId: 'acct_main', secret, salt, pepper });
    expect(await verifyEnrollmentSecret(nodeShadowCrypto, { sessionId: 'es_1', accountId: 'acct_main', presentedSecret: secret, stored, pepper })).toBe(true);
    const wrong = secret.slice(); wrong[0] ^= 1;
    expect(await verifyEnrollmentSecret(nodeShadowCrypto, { sessionId: 'es_1', accountId: 'acct_main', presentedSecret: wrong, stored, pepper })).toBe(false);
    expect(await verifyEnrollmentSecret(nodeShadowCrypto, { sessionId: 'es_1', accountId: 'acct_main', presentedSecret: secret, stored, pepper: nodeShadowCrypto.randomBytes(32) })).toBe(false);
    // account binding
    expect(await verifyEnrollmentSecret(nodeShadowCrypto, { sessionId: 'es_1', accountId: 'acct_other', presentedSecret: secret, stored, pepper })).toBe(false);
  });
});

describe('full enrollment round-trip (real crypto)', () => {
  it('host + controller derive the SAME scope key end to end', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, nodeShadowCrypto);
    expect(base64urlEncode(r.accepted.ok ? r.accepted.scopeKey : new Uint8Array())).toBe(base64urlEncode(r.approval.scopeKey));
    expect(r.accepted.ok && r.accepted.scopeKeyId).toBe(r.approval.scopeKeyId);
  });

  it('the enrollment grant is a protocol-valid wire message', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, nodeShadowCrypto);
    const decoded = decodeShadowMessage(r.approval.grant, { nowMs: NOW + 3600 });
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.value.family).toBe('enrollment-grant');
  });

  it('interoperates with a webcrypto controller against a node host', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, web);
    expect(r.accepted.ok).toBe(true);
    if (r.accepted.ok) expect(base64urlEncode(r.accepted.scopeKey)).toBe(base64urlEncode(r.approval.scopeKey));
  });

  it('a second enrollment attempt on the consumed session is rejected', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, nodeShadowCrypto);
    const again = await r.server.consume({ sessionId: r.request.sessionId, accountId: 'acct_main', presentedSecret: r.presentedSecret, nowMs: NOW + 5000 });
    expect(again).toEqual({ ok: false, reason: 'already-consumed' });
  });
});

describe('relay cannot decrypt scope key; artifacts carry no secrets', () => {
  it('an attacker with all relay-visible material but no controller private key cannot unwrap', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, nodeShadowCrypto);
    // Attacker controls a different device identity but sees grant + keyMaterial + bootstrap public keys.
    const attacker = await generateShadowIdentity(nodeShadowCrypto, 'ctrl_phone_1'); // same deviceId, different keys
    const stolen = await acceptEnrollmentGrant(nodeShadowCrypto, {
      controller: attacker, bootstrap: r.decoded, grant: r.approval.grant, keyMaterial: r.approval.keyMaterial,
      transcriptHash: r.verified.transcriptHash, nowMs: NOW + 4000,
    });
    expect(stolen.ok).toBe(false);
  });

  it('relay-visible records (grant, keyMaterial, serverRecord, request) contain no private/secret/scope material', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, nodeShadowCrypto);
    const forbidden = [
      base64urlEncode(r.host.keys.signing.privateKey),
      base64urlEncode(r.host.keys.agreement.privateKey),
      base64urlEncode(r.controller.keys.signing.privateKey),
      base64urlEncode(r.controller.keys.agreement.privateKey),
      base64urlEncode(r.approval.scopeKey),
      base64urlEncode(r.presentedSecret),
      base64urlEncode(r.pepper),
    ];
    const relayVisible = JSON.stringify([r.approval.grant, r.approval.keyMaterial, r.creation.serverRecord, r.request]);
    for (const secret of forbidden) {
      expect(secret.length).toBeGreaterThan(20);
      expect(relayVisible.includes(secret)).toBe(false);
    }
  });
});

describe('enrollment request tamper / replay rejection', () => {
  async function setup() {
    const host = await generateShadowIdentity(nodeShadowCrypto, 'host_mac_1');
    const controller = await generateShadowIdentity(nodeShadowCrypto, 'ctrl_phone_1');
    const creation = await createEnrollmentSession(nodeShadowCrypto, { host, accountId: 'acct_main', relayOrigin: RELAY, nowMs: NOW, serverPepper: nodeShadowCrypto.randomBytes(32) });
    const { request } = await buildEnrollmentRequest(nodeShadowCrypto, { controller, bootstrap: creation.bootstrap, nowMs: NOW + 2000 });
    return { host, controller, creation, request };
  }

  it('accepts a well-formed request', async () => {
    const s = await setup();
    const v = await verifyEnrollmentRequest(nodeShadowCrypto, { request: s.request, bootstrap: s.creation.bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
    expect(v.ok).toBe(true);
  });

  it('rejects a swapped controller public key (key-id / transcript binding)', async () => {
    const s = await setup();
    const other = await generateShadowIdentity(nodeShadowCrypto, 'ctrl_phone_1');
    const tampered = { ...s.request, signingPublicKey: base64urlEncode(other.signingPublicKey) };
    const v = await verifyEnrollmentRequest(nodeShadowCrypto, { request: tampered, bootstrap: s.creation.bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
    expect(v.ok).toBe(false);
  });

  it('rejects account mismatch', async () => {
    const s = await setup();
    const v = await verifyEnrollmentRequest(nodeShadowCrypto, { request: s.request, bootstrap: s.creation.bootstrap, expectedAccountId: 'acct_other', nowMs: NOW + 3000 });
    expect(v.ok).toBe(false);
  });

  it('rejects a tampered transcript hash', async () => {
    const s = await setup();
    const badTranscript = base64urlDecode(s.request.transcriptHash); badTranscript[0] ^= 1;
    const tampered = { ...s.request, transcriptHash: base64urlEncode(badTranscript) };
    const v = await verifyEnrollmentRequest(nodeShadowCrypto, { request: tampered, bootstrap: s.creation.bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
    expect(v.ok).toBe(false);
  });

  it('rejects a forged signature', async () => {
    const s = await setup();
    const badSig = base64urlDecode(s.request.signature); badSig[5] ^= 1;
    const tampered = { ...s.request, signature: base64urlEncode(badSig) };
    const v = await verifyEnrollmentRequest(nodeShadowCrypto, { request: tampered, bootstrap: s.creation.bootstrap, expectedAccountId: 'acct_main', nowMs: NOW + 3000 });
    expect(v.ok).toBe(false);
  });

  it('rejects an expired bootstrap', async () => {
    const s = await setup();
    const v = await verifyEnrollmentRequest(nodeShadowCrypto, { request: s.request, bootstrap: s.creation.bootstrap, expectedAccountId: 'acct_main', nowMs: s.creation.bootstrap.expiresAt + 1 });
    expect(v.ok).toBe(false);
  });
});

describe('grant tamper rejection', () => {
  it('rejects a forged host signature', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, nodeShadowCrypto);
    const attackerHost = await generateShadowIdentity(nodeShadowCrypto, 'host_mac_1');
    const forged = await approveEnrollment(nodeShadowCrypto, {
      host: attackerHost, fence: r.fence, controllerDeviceId: r.controller.deviceId,
      controllerAgreementPublicKey: r.controller.agreementPublicKey, transcriptHash: r.verified.transcriptHash,
      sessionId: r.request.sessionId, nowMs: NOW + 3500,
    });
    // grant signed by attacker host but delivered under the real bootstrap host key
    const accepted = await acceptEnrollmentGrant(nodeShadowCrypto, {
      controller: r.controller, bootstrap: r.decoded, grant: { ...forged.grant, fence: r.fence }, keyMaterial: forged.keyMaterial,
      transcriptHash: r.verified.transcriptHash, nowMs: NOW + 4000,
    });
    expect(accepted.ok).toBe(false);
  });

  it('rejects tampered wrapped scope-key ciphertext', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, nodeShadowCrypto);
    const wrapped = base64urlDecode(r.approval.keyMaterial.wrappedScopeKey); wrapped[0] ^= 1;
    const accepted = await acceptEnrollmentGrant(nodeShadowCrypto, {
      controller: r.controller, bootstrap: r.decoded, grant: r.approval.grant,
      keyMaterial: { ...r.approval.keyMaterial, wrappedScopeKey: base64urlEncode(wrapped) },
      transcriptHash: r.verified.transcriptHash, nowMs: NOW + 4000,
    });
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.reason).toBe('unwrap-failed');
  });

  it('rejects an expired grant', async () => {
    const r = await runFullEnrollment(nodeShadowCrypto, nodeShadowCrypto);
    const accepted = await acceptEnrollmentGrant(nodeShadowCrypto, {
      controller: r.controller, bootstrap: r.decoded, grant: r.approval.grant, keyMaterial: r.approval.keyMaterial,
      transcriptHash: r.verified.transcriptHash, nowMs: r.approval.grant.expiresAt + 1,
    });
    expect(accepted.ok).toBe(false);
  });
});

describe('revocation + key rotation', () => {
  it('signs/verifies device-revocation and it decodes as a wire message', async () => {
    const host = await generateShadowIdentity(nodeShadowCrypto, 'host_mac_1');
    const fence = fenceFor(host, 2);
    const rev = await signDeviceRevocation(nodeShadowCrypto, host, { family: 'device-revocation', v: 1, fence, controllerDeviceId: 'ctrl_phone_1', revokedAt: NOW, keyRotationId: 'kr_1' });
    expect(await verifyDeviceRevocation(nodeShadowCrypto, host.signingPublicKey, rev)).toBe(true);
    const decoded = decodeShadowMessage(rev, { nowMs: NOW });
    expect(decoded.ok && decoded.value.family).toBe('device-revocation');
    // forged
    const badSig = base64urlDecode(rev.signature); badSig[0] ^= 1;
    expect(await verifyDeviceRevocation(nodeShadowCrypto, host.signingPublicKey, { ...rev, signature: base64urlEncode(badSig) })).toBe(false);
    // wrong host key
    const other = await generateShadowIdentity(nodeShadowCrypto, 'host_x');
    expect(await verifyDeviceRevocation(nodeShadowCrypto, other.signingPublicKey, rev)).toBe(false);
  });

  it('signs/verifies key-rotation and it decodes as a wire message', async () => {
    const host = await generateShadowIdentity(nodeShadowCrypto, 'host_mac_1');
    const fence = fenceFor(host, 3);
    const rot = await signKeyRotation(nodeShadowCrypto, host, { family: 'key-rotation', v: 1, fence, keyId: 'wk_new', previousKeyId: 'wk_old', effectiveSeq: 42, createdAt: NOW });
    expect(await verifyKeyRotation(nodeShadowCrypto, host.signingPublicKey, rot)).toBe(true);
    const decoded = decodeShadowMessage(rot, { nowMs: NOW });
    expect(decoded.ok && decoded.value.family).toBe('key-rotation');
  });

  it('rotates the scope key to remaining controllers and excludes the revoked one', async () => {
    const host = await generateShadowIdentity(nodeShadowCrypto, 'host_mac_1');
    // Enroll two controllers, capturing their transcripts + agreement keys.
    const controllers = await Promise.all([0, 1, 2].map((i) => generateShadowIdentity(nodeShadowCrypto, `ctrl_${i}`)));
    const oldFence = fenceFor(host, 1);
    const enrollments = await Promise.all(controllers.map(async (c) => {
      const nonce = nodeShadowCrypto.randomBytes(16);
      const transcriptHash = await enrollmentTranscriptHash(nodeShadowCrypto, {
        sessionId: 'es', accountId: 'acct_main', hostDeviceId: host.deviceId,
        hostSigningPublicKey: host.signingPublicKey, hostAgreementPublicKey: host.agreementPublicKey,
        controllerDeviceId: c.deviceId, controllerSigningPublicKey: c.signingPublicKey, controllerAgreementPublicKey: c.agreementPublicKey,
        relayOrigin: RELAY, nonce,
      });
      const approval = await approveEnrollment(nodeShadowCrypto, { host, fence: oldFence, controllerDeviceId: c.deviceId, controllerAgreementPublicKey: c.agreementPublicKey, transcriptHash, sessionId: 'es', nowMs: NOW });
      return { c, transcriptHash, oldScopeKey: approval.scopeKey };
    }));
    const oldScopeKey = enrollments[0]!.oldScopeKey;

    const revoked = controllers[2]!;
    const newFence = fenceFor(host, 2);
    const remaining = enrollments.filter((e) => e.c.deviceId !== revoked.deviceId).map((e) => ({ controllerDeviceId: e.c.deviceId, agreementPublicKey: e.c.agreementPublicKey, transcriptHash: e.transcriptHash }));
    const rotation = await rotateScopeKeyForControllers(nodeShadowCrypto, { host, fence: newFence, revokedControllerDeviceId: revoked.deviceId, remaining, nowMs: NOW });

    expect(rotation.perController).toHaveLength(2);
    expect(base64urlEncode(rotation.scopeKey)).not.toBe(base64urlEncode(oldScopeKey)); // new key
    // each remaining controller unwraps the SAME new scope key (no split brain)
    for (const approval of rotation.perController) {
      const c = controllers.find((x) => x.deviceId === approval.grant.controllerDeviceId)!;
      const enrollment = enrollments.find((e) => e.c.deviceId === c.deviceId)!;
      const wrapKeyOk = await acceptEnrollmentGrant(nodeShadowCrypto, {
        controller: c,
        bootstrap: { scheme: 'maestro-shadow', v: 1, sessionId: 'es', accountId: 'acct_main', hostDeviceId: host.deviceId, hostSigningKeyId: host.signingKeyId, hostSigningPublicKey: base64urlEncode(host.signingPublicKey), hostAgreementPublicKey: base64urlEncode(host.agreementPublicKey), relayOrigin: RELAY, secret: base64urlEncode(new Uint8Array(32)), expiresAt: NOW + 1000 },
        grant: approval.grant, keyMaterial: approval.keyMaterial, transcriptHash: enrollment.transcriptHash, nowMs: NOW + 100,
      });
      expect(wrapKeyOk.ok).toBe(true);
      if (wrapKeyOk.ok) expect(base64urlEncode(wrapKeyOk.scopeKey)).toBe(base64urlEncode(rotation.scopeKey));
    }
    // revoked controller was never issued new key material
    expect(rotation.perController.some((a) => a.grant.controllerDeviceId === revoked.deviceId)).toBe(false);
  });
});
