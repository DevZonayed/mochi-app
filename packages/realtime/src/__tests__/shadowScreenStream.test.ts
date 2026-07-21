import { describe, expect, it, beforeAll } from 'vitest';
import { nodeShadowCrypto } from '../shadowCryptoNode';
import type { ShadowCryptoBackend, ShadowKeyPair } from '../shadowCrypto';
import {
  SHADOW_SCREEN_STREAM_VERSION,
  SHADOW_SCREEN_HOST_CONFIGURED_SOURCE,
  SHADOW_SCREEN_STREAM_MAX_TTL_MS,
  SHADOW_SCREEN_FRAME_MAX_BYTES,
  SHADOW_SCREEN_MAX_DIMENSION,
  ScreenFrameSender,
  ScreenFrameReceiver,
  decideScreenStart,
  decodeScreenControl,
  deriveScreenStreamKey,
  parseScreenFrameHeader,
  sealScreenFrame,
  freshStreamNonce,
  decodeStreamNonce,
  signScreenControl,
  verifyScreenControl,
  isRelayTeardownControl,
  SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID,
  type ScreenAuthoritySnapshot,
  type ScreenStartRequest,
  type ScreenStreamBinding,
  type ScreenControlBinding,
  type ScreenControlMessage,
} from '../shadowScreenStream';
import type { Fence } from '../shadowProtocol';

const backend: ShadowCryptoBackend = nodeShadowCrypto;

const FENCE: Fence = { accountId: 'acc_1', scopeId: 'scope_1', hostDeviceId: 'host_1', epoch: 3, leaseId: 'lease_1' };

const BINDING: ScreenStreamBinding = {
  streamId: 'stream_abc',
  accountId: 'acc_1',
  hostDeviceId: 'host_1',
  controllerDeviceId: 'ctrl_1',
  grantId: 'grant_1',
  scopeId: 'scope_1',
  epoch: 3,
  leaseId: 'lease_1',
  leaseExpiresAt: 10 ** 15,
  sourcePolicyId: 'src_main',
  codec: 'jpeg',
  width: 1280,
  height: 720,
};

let hostAgree: ShadowKeyPair;
let ctrlAgree: ShadowKeyPair;
let hostNonce: Uint8Array;
let ctrlNonce: Uint8Array;

async function bothKeys(keyEpoch = 1) {
  const hostKey = await deriveScreenStreamKey({
    backend, selfAgreementPrivate: hostAgree.privateKey, peerAgreementPublic: ctrlAgree.publicKey,
    hostNonce, controllerNonce: ctrlNonce, binding: BINDING, keyEpoch,
  });
  const ctrlKey = await deriveScreenStreamKey({
    backend, selfAgreementPrivate: ctrlAgree.privateKey, peerAgreementPublic: hostAgree.publicKey,
    hostNonce, controllerNonce: ctrlNonce, binding: BINDING, keyEpoch,
  });
  return { hostKey, ctrlKey };
}

// deterministic synthetic JPEG-ish frame (SOI..EOI markers + payload); opaque bytes.
function fakeFrame(seq: number, size = 4096): Uint8Array {
  const b = new Uint8Array(size);
  b[0] = 0xff; b[1] = 0xd8; // JPEG SOI
  for (let i = 2; i < size - 2; i += 1) b[i] = (seq * 31 + i) & 0xff;
  b[size - 2] = 0xff; b[size - 1] = 0xd9; // JPEG EOI
  return b;
}

beforeAll(async () => {
  hostAgree = await backend.generateAgreementKeyPair();
  ctrlAgree = await backend.generateAgreementKeyPair();
  hostNonce = freshStreamNonce(backend).bytes;
  ctrlNonce = freshStreamNonce(backend).bytes;
});

describe('shadowScreenStream — key derivation', () => {
  it('host and controller derive the SAME per-stream key (X25519 symmetric)', async () => {
    const { hostKey, ctrlKey } = await bothKeys();
    expect(hostKey.length).toBe(32);
    expect(Buffer.from(hostKey).equals(Buffer.from(ctrlKey))).toBe(true);
  });

  it('different nonces → different key (per-stream separation)', async () => {
    const { hostKey } = await bothKeys();
    const otherNonce = freshStreamNonce(backend).bytes;
    const k2 = await deriveScreenStreamKey({
      backend, selfAgreementPrivate: hostAgree.privateKey, peerAgreementPublic: ctrlAgree.publicKey,
      hostNonce: otherNonce, controllerNonce: ctrlNonce, binding: BINDING, keyEpoch: 1,
    });
    expect(Buffer.from(hostKey).equals(Buffer.from(k2))).toBe(false);
  });

  it('different key epoch → different key (rotation separation)', async () => {
    const { hostKey } = await bothKeys(1);
    const k2 = await deriveScreenStreamKey({
      backend, selfAgreementPrivate: hostAgree.privateKey, peerAgreementPublic: ctrlAgree.publicKey,
      hostNonce, controllerNonce: ctrlNonce, binding: BINDING, keyEpoch: 2,
    });
    expect(Buffer.from(hostKey).equals(Buffer.from(k2))).toBe(false);
  });

  it('different binding (streamId/source/dims) → different key', async () => {
    const { hostKey } = await bothKeys();
    for (const mutate of [
      { ...BINDING, streamId: 'stream_other' },
      { ...BINDING, sourcePolicyId: 'src_other' },
      { ...BINDING, width: 960 },
      { ...BINDING, grantId: 'grant_other' },
      { ...BINDING, epoch: 4 },
    ] as ScreenStreamBinding[]) {
      const k = await deriveScreenStreamKey({
        backend, selfAgreementPrivate: hostAgree.privateKey, peerAgreementPublic: ctrlAgree.publicKey,
        hostNonce, controllerNonce: ctrlNonce, binding: mutate, keyEpoch: 1,
      });
      expect(Buffer.from(hostKey).equals(Buffer.from(k))).toBe(false);
    }
  });

  it('rejects wrong-length nonces', async () => {
    await expect(deriveScreenStreamKey({
      backend, selfAgreementPrivate: hostAgree.privateKey, peerAgreementPublic: ctrlAgree.publicKey,
      hostNonce: new Uint8Array(8), controllerNonce: ctrlNonce, binding: BINDING, keyEpoch: 1,
    })).rejects.toThrow();
  });
});

describe('shadowScreenStream — frame seal/open round-trip', () => {
  it('a sealed frame decrypts to the exact bytes on the controller', async () => {
    const { hostKey, ctrlKey } = await bothKeys();
    const sender = new ScreenFrameSender(backend, hostKey, BINDING, 1);
    const receiver = new ScreenFrameReceiver(backend, ctrlKey, BINDING, 1, { expiresAtMs: 10 ** 15 });
    const frame = fakeFrame(1);
    const env = await sender.seal(frame, 1_000);
    const parsed = parseScreenFrameHeader(env);
    expect(parsed.ok).toBe(true);
    const res = await receiver.accept(env, 1_050);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Buffer.from(res.frameBytes).equals(Buffer.from(frame))).toBe(true);
      expect(res.meta.seq).toBe(1);
      expect(res.meta.width).toBe(1280);
      expect(res.meta.codec).toBe('jpeg');
    }
  });

  it('streams many frames in-order with strictly increasing seq', async () => {
    const { hostKey, ctrlKey } = await bothKeys();
    const sender = new ScreenFrameSender(backend, hostKey, BINDING, 1);
    const receiver = new ScreenFrameReceiver(backend, ctrlKey, BINDING, 1, { expiresAtMs: 10 ** 15 });
    for (let i = 1; i <= 15; i += 1) {
      const env = await sender.seal(fakeFrame(i), 1000 + i);
      const res = await receiver.accept(env, 1000 + i + 1);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.meta.seq).toBe(i);
    }
    expect(receiver.lastAcceptedSeq()).toBe(15);
  });
});

describe('shadowScreenStream — adversarial frame rejection', () => {
  async function ctx() {
    const { hostKey, ctrlKey } = await bothKeys();
    const sender = new ScreenFrameSender(backend, hostKey, BINDING, 1);
    const receiver = new ScreenFrameReceiver(backend, ctrlKey, BINDING, 1, { expiresAtMs: 10 ** 15 });
    return { sender, receiver };
  }

  it('rejects replay and duplicate (seq must strictly increase)', async () => {
    const { sender, receiver } = await ctx();
    const e1 = await sender.seal(fakeFrame(1), 1000);
    const e2 = await sender.seal(fakeFrame(2), 1001);
    expect((await receiver.accept(e1, 1002)).ok).toBe(true);
    expect((await receiver.accept(e2, 1003)).ok).toBe(true);
    // replay e1 (seq 1 <= lastSeq 2)
    expect(await receiver.accept(e1, 1004)).toMatchObject({ ok: false, reason: 'replay-or-reorder' });
    // duplicate e2
    expect(await receiver.accept(e2, 1005)).toMatchObject({ ok: false, reason: 'replay-or-reorder' });
  });

  it('rejects reorder (a later-seq frame accepted then an earlier one)', async () => {
    const { sender, receiver } = await ctx();
    const e1 = await sender.seal(fakeFrame(1), 1000);
    const e2 = await sender.seal(fakeFrame(2), 1001);
    const e3 = await sender.seal(fakeFrame(3), 1002);
    expect((await receiver.accept(e1, 1003)).ok).toBe(true);
    expect((await receiver.accept(e3, 1004)).ok).toBe(true); // jump ahead (dropped e2 is fine)
    // now e2 arrives late — must be rejected
    expect(await receiver.accept(e2, 1005)).toMatchObject({ ok: false, reason: 'replay-or-reorder' });
  });

  it('rejects a tampered ciphertext (bit flip)', async () => {
    const { sender, receiver } = await ctx();
    const env = await sender.seal(fakeFrame(1), 1000);
    env[env.length - 5] ^= 0x40;
    expect(await receiver.accept(env, 1001)).toMatchObject({ ok: false, reason: 'auth-failed' });
  });

  it('rejects a tampered header (seq bumped in header only)', async () => {
    const { sender, receiver } = await ctx();
    const env = await sender.seal(fakeFrame(1), 1000);
    env[17] = (env[17]! + 1) & 0xff; // last byte of seq field
    // header parses but AAD (seq) no longer matches → auth-failed
    expect(await receiver.accept(env, 1001)).toMatchObject({ ok: false, reason: 'auth-failed' });
  });

  it('rejects truncation and oversize and bad magic', async () => {
    const { sender, receiver } = await ctx();
    const env = await sender.seal(fakeFrame(1), 1000);
    expect(await receiver.accept(env.subarray(0, 10), 1001)).toMatchObject({ ok: false });
    const oversize = new Uint8Array(SHADOW_SCREEN_FRAME_MAX_BYTES + 200);
    expect(parseScreenFrameHeader(oversize)).toMatchObject({ ok: false, reason: 'oversize' });
    const badMagic = env.slice();
    badMagic[0] = 0; badMagic[1] = 0;
    expect(await receiver.accept(badMagic, 1001)).toMatchObject({ ok: false, reason: 'bad-magic' });
  });

  it('seal rejects a frame that exceeds the max size', async () => {
    const { hostKey } = await bothKeys();
    const sender = new ScreenFrameSender(backend, hostKey, BINDING, 1);
    await expect(sender.seal(new Uint8Array(SHADOW_SCREEN_FRAME_MAX_BYTES + 1), 1000)).rejects.toThrow();
  });

  it('rejects a frame sealed under a DIFFERENT stream key (wrong pair)', async () => {
    const { ctrlKey } = await bothKeys();
    const strangerHost = await backend.generateAgreementKeyPair();
    const strangerKey = await deriveScreenStreamKey({
      backend, selfAgreementPrivate: strangerHost.privateKey, peerAgreementPublic: ctrlAgree.publicKey,
      hostNonce, controllerNonce: ctrlNonce, binding: BINDING, keyEpoch: 1,
    });
    const strangerSender = new ScreenFrameSender(backend, strangerKey, BINDING, 1);
    const receiver = new ScreenFrameReceiver(backend, ctrlKey, BINDING, 1, { expiresAtMs: 10 ** 15 });
    const env = await strangerSender.seal(fakeFrame(1), 1000);
    expect(await receiver.accept(env, 1001)).toMatchObject({ ok: false, reason: 'auth-failed' });
  });

  it('rejects an expired frame', async () => {
    const { hostKey, ctrlKey } = await bothKeys();
    const sender = new ScreenFrameSender(backend, hostKey, BINDING, 1);
    const receiver = new ScreenFrameReceiver(backend, ctrlKey, BINDING, 1, { expiresAtMs: 2000 });
    const env = await sender.seal(fakeFrame(1), 1000);
    expect(await receiver.accept(env, 2001)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects a future capture timestamp beyond skew (clock-skew guard)', async () => {
    const { hostKey, ctrlKey } = await bothKeys();
    const sender = new ScreenFrameSender(backend, hostKey, BINDING, 1);
    const receiver = new ScreenFrameReceiver(backend, ctrlKey, BINDING, 1, { expiresAtMs: 10 ** 15 });
    const env = await sender.seal(fakeFrame(1), 10_000_000);
    expect(await receiver.accept(env, 1000)).toMatchObject({ ok: false, reason: 'clock-skew' });
  });

  it('rejects a frame from a different (older) key epoch (no in-stream rotation, M3)', async () => {
    // The receiver is bound to keyEpoch 2; a frame sealed under epoch 1 is rejected as
    // old-key. There is no rotate() API — a fresh stream/key is derived on reconnect.
    const { hostKey: hostKey1 } = await bothKeys(1);
    const h2 = freshStreamNonce(backend).bytes; const c2 = freshStreamNonce(backend).bytes;
    const hostKey2 = await deriveScreenStreamKey({ backend, selfAgreementPrivate: hostAgree.privateKey, peerAgreementPublic: ctrlAgree.publicKey, hostNonce: h2, controllerNonce: c2, binding: BINDING, keyEpoch: 2 });
    const ctrlKey2 = await deriveScreenStreamKey({ backend, selfAgreementPrivate: ctrlAgree.privateKey, peerAgreementPublic: hostAgree.publicKey, hostNonce: h2, controllerNonce: c2, binding: BINDING, keyEpoch: 2 });
    const oldSender = new ScreenFrameSender(backend, hostKey1.slice(), BINDING, 1);
    const receiver = new ScreenFrameReceiver(backend, ctrlKey2, BINDING, 2, { expiresAtMs: 10 ** 15 });
    const oldEnv = await oldSender.seal(fakeFrame(9), 1100);
    expect(await receiver.accept(oldEnv, 1101)).toMatchObject({ ok: false, reason: 'old-key' });
    const sender2 = new ScreenFrameSender(backend, hostKey2, BINDING, 2);
    const fresh = await sender2.seal(fakeFrame(1), 1200);
    expect((await receiver.accept(fresh, 1201)).ok).toBe(true);
  });

  it('disposed receiver rejects; disposed sender throws; keys are zeroed', async () => {
    const { hostKey, ctrlKey } = await bothKeys();
    const sender = new ScreenFrameSender(backend, hostKey, BINDING, 1);
    const receiver = new ScreenFrameReceiver(backend, ctrlKey, BINDING, 1, { expiresAtMs: 10 ** 15 });
    sender.dispose();
    receiver.dispose();
    await expect(sender.seal(fakeFrame(1), 1000)).rejects.toThrow();
    expect(await receiver.accept(new Uint8Array(SHADOW_SCREEN_FRAME_MAX_BYTES), 1000)).toMatchObject({ ok: false, reason: 'receiver-disposed' });
    expect(hostKey.every((b) => b === 0)).toBe(true);
    expect(ctrlKey.every((b) => b === 0)).toBe(true);
  });
});

describe('shadowScreenStream — control message decode', () => {
  const baseStart: ScreenStartRequest = {
    kind: 'screen-start', v: SHADOW_SCREEN_STREAM_VERSION, streamId: 'stream_abc', accountId: 'acc_1', hostDeviceId: 'host_1',
    controllerDeviceId: 'ctrl_1', grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', sourcePolicyId: 'src_main',
    requestedCodec: 'jpeg', requestedMaxDimension: 1280, requestedFps: 8, controllerNonce: freshStreamNonceB64(), requestedAt: 1000, expiresAt: 1000 + 60_000,
  };
  function freshStreamNonceB64() { return freshStreamNonce(backend).b64; }

  it('accepts a well-formed start', () => {
    expect(decodeScreenControl(baseStart, { nowMs: 1000 })).toMatchObject({ ok: true });
  });

  it('rejects bad version / unknown kind / non-object', () => {
    expect(decodeScreenControl({ ...baseStart, v: 2 })).toMatchObject({ ok: false, reason: 'bad-version' });
    expect(decodeScreenControl({ ...baseStart, kind: 'screen-input', v: 1 })).toMatchObject({ ok: false });
    expect(decodeScreenControl(null)).toMatchObject({ ok: false, reason: 'not-object' });
    expect(decodeScreenControl(42)).toMatchObject({ ok: false });
  });

  it('rejects out-of-band dimension / fps / ttl / expired', () => {
    expect(decodeScreenControl({ ...baseStart, requestedMaxDimension: SHADOW_SCREEN_MAX_DIMENSION + 1 })).toMatchObject({ ok: false, reason: 'bad-dimension' });
    expect(decodeScreenControl({ ...baseStart, requestedFps: 99 })).toMatchObject({ ok: false, reason: 'bad-fps' });
    expect(decodeScreenControl({ ...baseStart, expiresAt: baseStart.requestedAt + SHADOW_SCREEN_STREAM_MAX_TTL_MS + 1 })).toMatchObject({ ok: false, reason: 'bad-ttl' });
    expect(decodeScreenControl(baseStart, { nowMs: baseStart.expiresAt + 1 })).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects malformed ids and nonces', () => {
    expect(decodeScreenControl({ ...baseStart, streamId: 'bad id!' })).toMatchObject({ ok: false, reason: 'bad-id' });
    expect(decodeScreenControl({ ...baseStart, controllerNonce: 'short' })).toMatchObject({ ok: false, reason: 'bad-nonce' });
  });

  it('accepts/round-trips accept, status, stop', () => {
    expect(decodeScreenControl({ kind: 'screen-accept', v: 1, streamId: 'stream_abc', hostNonce: freshStreamNonce(backend).b64, codec: 'jpeg', width: 1280, height: 720, fps: 8, keyEpoch: 1, sourcePolicyId: 'src_main', sourceLabel: 'Built-in Display · 1512×982', acceptedAt: 1000, expiresAt: 61_000 })).toMatchObject({ ok: true });
    expect(decodeScreenControl({ kind: 'screen-status', v: 1, streamId: 'stream_abc', status: 'live', at: 1000 })).toMatchObject({ ok: true });
    // B2-R1/M-A: source-required is a first-class truthful status — the decoder MUST accept
    // it (a missing allowlist entry silently dropped the host's deny on the wire).
    expect(decodeScreenControl({ kind: 'screen-status', v: 1, streamId: 'stream_abc', status: 'source-required', at: 1000 })).toMatchObject({ ok: true });
    expect(decodeScreenControl({ kind: 'screen-status', v: 1, streamId: 'stream_abc', status: 'not-a-status', at: 1000 })).toMatchObject({ ok: false, reason: 'bad-status' });
    expect(decodeScreenControl({ kind: 'screen-stop', v: 1, streamId: 'stream_abc', reason: 'user stopped', at: 1000 })).toMatchObject({ ok: true });
  });

  it('nonce codec round-trips and rejects wrong length', () => {
    const { b64, bytes } = freshStreamNonce(backend);
    expect(Buffer.from(decodeStreamNonce(b64)).equals(Buffer.from(bytes))).toBe(true);
    expect(() => decodeStreamNonce('AAAA')).toThrow();
  });
});

describe('shadowScreenStream — decideScreenStart (consent gate, fail-closed)', () => {
  const req: ScreenStartRequest = {
    kind: 'screen-start', v: 1, streamId: 'stream_abc', accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1',
    grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', sourcePolicyId: 'src_main',
    requestedCodec: 'jpeg', requestedMaxDimension: 1280, requestedFps: 8, controllerNonce: freshStreamNonce(backend).b64, requestedAt: 1000, expiresAt: 61_000,
  };
  const authority: ScreenAuthoritySnapshot = {
    fence: FENCE, leaseExpiresAtMs: 10 ** 15, grantedCapabilities: ['account.read', 'screen.view'],
    revokedControllerDeviceIds: [], hostOnline: true, configuredSourcePolicyId: 'src_main', foreground: true,
  };
  const env = { nowMs: 2000, activeViewerDeviceId: null, permission: 'granted' as const, sourceAvailable: true };

  it('allows when everything lines up', () => {
    expect(decideScreenStart(req, authority, env)).toEqual({ ok: true });
  });

  it('denies without the screen.view capability (grant necessary but not sufficient)', () => {
    expect(decideScreenStart(req, { ...authority, grantedCapabilities: ['account.read'] }, env)).toMatchObject({ ok: false, status: 'permission-denied' });
    // even holding all six actions but not screen.view
    expect(decideScreenStart(req, { ...authority, grantedCapabilities: ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set'] }, env)).toMatchObject({ ok: false, status: 'permission-denied' });
  });

  it('denies on authority mismatch / offline / revoked / expired / wrong source / background', () => {
    expect(decideScreenStart({ ...req, epoch: 4 }, authority, env)).toMatchObject({ ok: false, status: 'error' });
    expect(decideScreenStart(req, { ...authority, hostOnline: false }, env)).toMatchObject({ ok: false, status: 'error' });
    expect(decideScreenStart(req, { ...authority, revokedControllerDeviceIds: ['ctrl_1'] }, env)).toMatchObject({ ok: false, status: 'revoked' });
    expect(decideScreenStart(req, { ...authority, leaseExpiresAtMs: 1000 }, env)).toMatchObject({ ok: false, status: 'expired' });
    // M-A/B2-R1: a concrete id ≠ the configured display = a remote trying to SELECT a
    // source it can't name → source-lost; no configured display at all → source-required.
    expect(decideScreenStart({ ...req, sourcePolicyId: 'src_evil' }, authority, env)).toMatchObject({ ok: false, status: 'source-lost' });
    expect(decideScreenStart(req, { ...authority, configuredSourcePolicyId: null }, env)).toMatchObject({ ok: false, status: 'source-required' });
    expect(decideScreenStart(req, { ...authority, foreground: false }, env)).toMatchObject({ ok: false, status: 'error' });
    // the deferral sentinel is accepted against ANY configured display (remote never picks)
    expect(decideScreenStart({ ...req, sourcePolicyId: SHADOW_SCREEN_HOST_CONFIGURED_SOURCE }, authority, env)).toEqual({ ok: true });
    expect(decideScreenStart({ ...req, sourcePolicyId: SHADOW_SCREEN_HOST_CONFIGURED_SOURCE }, { ...authority, configuredSourcePolicyId: 'display:7' }, env)).toEqual({ ok: true });
  });

  it('denies permission-required / denied and busy (second viewer never steals)', () => {
    expect(decideScreenStart(req, authority, { ...env, permission: 'undetermined' })).toMatchObject({ ok: false, status: 'permission-required' });
    expect(decideScreenStart(req, authority, { ...env, permission: 'denied' })).toMatchObject({ ok: false, status: 'permission-denied' });
    expect(decideScreenStart(req, authority, { ...env, activeViewerDeviceId: 'ctrl_other' })).toMatchObject({ ok: false, status: 'busy' });
    // the SAME device re-requesting its own active stream is allowed
    expect(decideScreenStart(req, authority, { ...env, activeViewerDeviceId: 'ctrl_1' })).toEqual({ ok: true });
  });

  it('denies source-lost', () => {
    expect(decideScreenStart(req, authority, { ...env, sourceAvailable: false })).toMatchObject({ ok: false, status: 'source-lost' });
  });
});

describe('shadowScreenStream — signed control plane (H1)', () => {
  const CONTROL_BINDING: ScreenControlBinding = {
    accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1',
    scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', leaseExpiresAt: 10 ** 15, streamId: 'stream_abc',
  };
  const START: ScreenStartRequest = {
    kind: 'screen-start', v: 1, streamId: 'stream_abc', accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1',
    grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', sourcePolicyId: 'src_main',
    requestedCodec: 'jpeg', requestedMaxDimension: 1280, requestedFps: 8, controllerNonce: freshStreamNonce(backend).b64,
    requestedAt: 1_000_000, expiresAt: 1_060_000,
  };

  async function ctrlKeys() {
    const kp = await backend.generateSigningKeyPair();
    return kp;
  }

  it('a controller-signed start verifies against the enrolled signing public key', async () => {
    const kp = await ctrlKeys();
    const signed = await signScreenControl(backend, kp.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: START, binding: CONTROL_BINDING });
    const seen = new Set<string>();
    expect(await verifyScreenControl(backend, kp.publicKey, 'controller', signed, CONTROL_BINDING, { nowMs: 1_000_001, seenControlNonces: seen })).toEqual({ ok: true });
  });

  it('rejects an UNSIGNED start (structurally valid but no signature) — never authorises capture', async () => {
    const seen = new Set<string>();
    const kp = await ctrlKeys();
    // a structurally valid start with NO signature envelope
    const r = await verifyScreenControl(backend, kp.publicKey, 'controller', START as ScreenControlMessage, CONTROL_BINDING, { nowMs: 1_000_001, seenControlNonces: seen });
    expect(r).toMatchObject({ ok: false });
  });

  it('rejects a forged start (signed by a DIFFERENT key)', async () => {
    const real = await ctrlKeys(); const attacker = await ctrlKeys();
    const signed = await signScreenControl(backend, attacker.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: START, binding: CONTROL_BINDING });
    const seen = new Set<string>();
    expect(await verifyScreenControl(backend, real.publicKey, 'controller', signed, CONTROL_BINDING, { nowMs: 1_000_001, seenControlNonces: seen })).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a replayed control nonce', async () => {
    const kp = await ctrlKeys();
    const nonce = freshStreamNonce(backend).b64;
    const signed = await signScreenControl(backend, kp.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: nonce, message: START, binding: CONTROL_BINDING });
    const seen = new Set<string>();
    expect(await verifyScreenControl(backend, kp.publicKey, 'controller', signed, CONTROL_BINDING, { nowMs: 1_000_001, seenControlNonces: seen })).toEqual({ ok: true });
    expect(await verifyScreenControl(backend, kp.publicKey, 'controller', signed, CONTROL_BINDING, { nowMs: 1_000_001, seenControlNonces: seen })).toMatchObject({ ok: false, reason: 'replay' });
  });

  it('rejects role reflection (host key presented for a controller-role message)', async () => {
    const kp = await ctrlKeys();
    const signed = await signScreenControl(backend, kp.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: START, binding: CONTROL_BINDING });
    const seen = new Set<string>();
    // verifier expects a HOST-role message → wrong-role
    expect(await verifyScreenControl(backend, kp.publicKey, 'host', signed, CONTROL_BINDING, { nowMs: 1_000_001, seenControlNonces: seen })).toMatchObject({ ok: false, reason: 'wrong-role' });
  });

  it('rejects a signature bound to a DIFFERENT stream / account / grant / epoch / lease', async () => {
    const kp = await ctrlKeys();
    const signed = await signScreenControl(backend, kp.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: START, binding: CONTROL_BINDING });
    for (const mutate of [
      { ...CONTROL_BINDING, streamId: 'stream_other' },
      { ...CONTROL_BINDING, accountId: 'acc_evil' },
      { ...CONTROL_BINDING, hostDeviceId: 'host_evil' },
      { ...CONTROL_BINDING, grantId: 'grant_evil' },
      { ...CONTROL_BINDING, epoch: 4 },
      { ...CONTROL_BINDING, leaseId: 'lease_evil' },
    ] as ScreenControlBinding[]) {
      const seen = new Set<string>();
      expect(await verifyScreenControl(backend, kp.publicKey, 'controller', signed, mutate, { nowMs: 1_000_001, seenControlNonces: seen })).toMatchObject({ ok: false, reason: 'bad-signature' });
    }
  });

  it('rejects clock-skew and an expired lease', async () => {
    const kp = await ctrlKeys();
    const signed = await signScreenControl(backend, kp.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: START, binding: CONTROL_BINDING });
    const seen = new Set<string>();
    // issuedAt (requestedAt=1_000_000) far from now
    expect(await verifyScreenControl(backend, kp.publicKey, 'controller', signed, CONTROL_BINDING, { nowMs: 2_000_000, seenControlNonces: seen })).toMatchObject({ ok: false, reason: 'clock-skew' });
    // expired lease
    expect(await verifyScreenControl(backend, kp.publicKey, 'controller', signed, { ...CONTROL_BINDING, leaseExpiresAt: 500_000 }, { nowMs: 1_000_001, seenControlNonces: new Set() })).toMatchObject({ ok: false, reason: 'lease-expired' });
  });

  it('rejects a tampered body (fps bumped after signing)', async () => {
    const kp = await ctrlKeys();
    const signed = await signScreenControl(backend, kp.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: START, binding: CONTROL_BINDING });
    const tampered = { ...signed, requestedFps: 10 };
    const seen = new Set<string>();
    expect(await verifyScreenControl(backend, kp.publicKey, 'controller', tampered, CONTROL_BINDING, { nowMs: 1_000_001, seenControlNonces: seen })).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('host-signed accept verifies; and the relay teardown is the ONLY unsigned control (stop-only)', async () => {
    const kp = await backend.generateSigningKeyPair();
    const accept: ScreenControlMessage = { kind: 'screen-accept', v: 1, streamId: 'stream_abc', hostNonce: freshStreamNonce(backend).b64, codec: 'jpeg', width: 1280, height: 720, fps: 8, keyEpoch: 1, sourcePolicyId: 'src_main', sourceLabel: 'Display', acceptedAt: 1_000_000, expiresAt: 1_060_000 };
    const signed = await signScreenControl(backend, kp.privateKey, { role: 'host', signerKeyId: 'sk_host', controlNonce: freshStreamNonce(backend).b64, message: accept, binding: CONTROL_BINDING });
    expect(await verifyScreenControl(backend, kp.publicKey, 'host', signed, CONTROL_BINDING, { nowMs: 1_000_001, seenControlNonces: new Set() })).toEqual({ ok: true });
    // relay teardown: unsigned, reserved streamId, stop-only
    expect(isRelayTeardownControl({ kind: 'screen-stop', v: 1, streamId: SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID, reason: 'peer gone', at: 1 })).toBe(true);
    expect(isRelayTeardownControl({ kind: 'screen-status', v: 1, streamId: SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID, status: 'stopped', at: 1 })).toBe(true);
    // a relay 'start'/'live' can NEVER be a teardown → must be signed like any peer control
    expect(isRelayTeardownControl({ ...accept, streamId: SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID } as ScreenControlMessage)).toBe(false);
    expect(isRelayTeardownControl({ kind: 'screen-status', v: 1, streamId: SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID, status: 'live', at: 1 })).toBe(false);
  });
});

describe('shadowScreenStream — L1 lease binding + M3 no-rekey', () => {
  it('a key/frame bound to lease_1 fails to decrypt under a different lease', async () => {
    const hostAgree2 = await backend.generateAgreementKeyPair();
    const ctrlAgree2 = await backend.generateAgreementKeyPair();
    const hn = freshStreamNonce(backend).bytes; const cn = freshStreamNonce(backend).bytes;
    const bindA: ScreenStreamBinding = { ...BINDING, leaseId: 'lease_A' };
    const bindB: ScreenStreamBinding = { ...BINDING, leaseId: 'lease_B' };
    const kA = await deriveScreenStreamKey({ backend, selfAgreementPrivate: hostAgree2.privateKey, peerAgreementPublic: ctrlAgree2.publicKey, hostNonce: hn, controllerNonce: cn, binding: bindA, keyEpoch: 1 });
    const kB = await deriveScreenStreamKey({ backend, selfAgreementPrivate: ctrlAgree2.privateKey, peerAgreementPublic: hostAgree2.publicKey, hostNonce: hn, controllerNonce: cn, binding: bindB, keyEpoch: 1 });
    // different lease → different key
    expect(Buffer.from(kA).equals(Buffer.from(kB))).toBe(false);
  });
});
