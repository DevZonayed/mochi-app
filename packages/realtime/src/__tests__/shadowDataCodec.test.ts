import { describe, it, expect } from 'vitest';
import { nodeShadowCrypto as node } from '../shadowCryptoNode.js';
import { base64urlDecode, base64urlEncode } from '../shadowCrypto.js';
import type { Fence, ShadowStateEvent, HostCommandAck } from '../shadowProtocol.js';
import {
  deriveScopeKeyring, SHADOW_DATA_CODEC_VERSION, type ScopeKeyring,
  sealEventPayload, openEventPayload,
  sealCommandEnvelope, openCommandEnvelope,
  sealCommandAck, openCommandAck, signCommandAck, verifyCommandAck,
} from '../shadowDataCodec.js';

const fence: Fence = { accountId: 'acct', scopeId: 'account:acct', hostDeviceId: 'host', epoch: 1, leaseId: 'lease' };
const eventBase: Pick<ShadowStateEvent, 'fence' | 'eventId' | 'seq' | 'keyId' | 'payloadDigest'> = { fence, eventId: 'shev_1', seq: 1, keyId: 'wk_1', payloadDigest: `sha256:${'a'.repeat(64)}` };
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** Derive a keyring for a scope key bound to (account, scope, keyId). */
function ring(scopeKey: Uint8Array, keyId = 'wk_1'): Promise<ScopeKeyring> {
  return deriveScopeKeyring(node, scopeKey, { accountId: fence.accountId, scopeId: fence.scopeId, keyId });
}

/** Extract the 12-byte nonce prefix from a sealed wire envelope. */
function nonceOf(ct: string): string {
  return base64urlEncode(base64urlDecode(ct).slice(0, 12));
}

describe('shadowDataCodec — event payloads', () => {
  it('host seals and controller opens the exact payload', async () => {
    const kr = await ring(node.randomBytes(32));
    const payload = { title: 'a project', n: 7, nested: { ok: true } };
    const ct = await sealEventPayload(node, kr, eventBase, enc(payload));
    const opened = await openEventPayload(node, kr, { ...eventBase, payloadCiphertext: ct });
    expect(opened).toEqual(payload);
  });

  it('nonce is deterministic → re-seal is byte-identical (idempotent re-publish)', async () => {
    const kr = await ring(node.randomBytes(32));
    const a = await sealEventPayload(node, kr, eventBase, enc({ x: 1 }));
    const b = await sealEventPayload(node, kr, eventBase, enc({ x: 1 }));
    expect(a).toBe(b);
  });

  it('the nonce changes when ANY authoritative binding field changes (no nonce reuse)', async () => {
    const scopeKey = node.randomBytes(32);
    const kr = await ring(scopeKey);
    const base = await sealEventPayload(node, kr, eventBase, enc({ x: 1 }));
    // keyId is part of the HKDF context, so a keyId change needs its own keyring.
    const krK2 = await ring(scopeKey, 'wk_2');
    const variants: Array<[ScopeKeyring, typeof eventBase]> = [
      [kr, { ...eventBase, eventId: 'shev_2' }],
      [kr, { ...eventBase, seq: 2 }],
      [krK2, { ...eventBase, keyId: 'wk_2' }],
      [kr, { ...eventBase, payloadDigest: `sha256:${'b'.repeat(64)}` }],
      [kr, { ...eventBase, fence: { ...fence, epoch: 2 } }],
      [kr, { ...eventBase, fence: { ...fence, leaseId: 'lease_2' } }],
    ];
    const nonces = new Set([nonceOf(base)]);
    for (const [k, v] of variants) nonces.add(nonceOf(await sealEventPayload(node, k, v, enc({ x: 1 }))));
    // Every distinct binding yields a distinct nonce.
    expect(nonces.size).toBe(variants.length + 1);
    // A different scope key also yields a different nonce for the same binding.
    expect(nonceOf(await sealEventPayload(node, await ring(node.randomBytes(32)), eventBase, enc({ x: 1 })))).not.toBe(nonceOf(base));
  });

  it('a wrong scope key fails closed (null)', async () => {
    const ct = await sealEventPayload(node, await ring(node.randomBytes(32)), eventBase, enc({ x: 1 }));
    expect(await openEventPayload(node, await ring(node.randomBytes(32)), { ...eventBase, payloadCiphertext: ct })).toBeNull();
  });

  it('AAD binds ciphertext to the event — moving it to a different eventId/digest/fence fails', async () => {
    const kr = await ring(node.randomBytes(32));
    const ct = await sealEventPayload(node, kr, eventBase, enc({ x: 1 }));
    expect(await openEventPayload(node, kr, { ...eventBase, eventId: 'shev_other', payloadCiphertext: ct })).toBeNull();
    expect(await openEventPayload(node, kr, { ...eventBase, payloadDigest: `sha256:${'c'.repeat(64)}`, payloadCiphertext: ct })).toBeNull();
    expect(await openEventPayload(node, kr, { ...eventBase, fence: { ...fence, epoch: 9 }, payloadCiphertext: ct })).toBeNull();
  });

  it('rejects a swapped nonce for the same binding (before GCM open)', async () => {
    const kr = await ring(node.randomBytes(32));
    const ct = await sealEventPayload(node, kr, eventBase, enc({ x: 1 }));
    const bytes = base64urlDecode(ct);
    bytes[0] ^= 0xff; // corrupt the nonce prefix only
    expect(await openEventPayload(node, kr, { ...eventBase, payloadCiphertext: base64urlEncode(bytes) })).toBeNull();
  });

  it('tampered ciphertext fails closed', async () => {
    const kr = await ring(node.randomBytes(32));
    const ct = await sealEventPayload(node, kr, eventBase, enc({ x: 1 }));
    const bytes = base64urlDecode(ct);
    bytes[bytes.length - 1] ^= 0xff;
    expect(await openEventPayload(node, kr, { ...eventBase, payloadCiphertext: base64urlEncode(bytes) })).toBeNull();
  });

  it('a keyring whose keyId does not match the event fails closed (no cross-keyId open)', async () => {
    const scopeKey = node.randomBytes(32);
    const kr = await ring(scopeKey, 'wk_1');
    const ct = await sealEventPayload(node, kr, eventBase, enc({ x: 1 }));
    // Same scope key, keyring derived for a different keyId → cannot open.
    const krOther = await ring(scopeKey, 'wk_9');
    expect(await openEventPayload(node, krOther, { ...eventBase, payloadCiphertext: ct })).toBeNull();
  });
});

describe('shadowDataCodec — command envelopes', () => {
  it('round-trips a command envelope bound to (commandId, fence)', async () => {
    const kr = await ring(node.randomBytes(32));
    const cmd = { method: 'shadowCommandPing', params: { echo: 'hi' } };
    const env = await sealCommandEnvelope(node, kr, fence, 'cmd_1', cmd);
    expect(await openCommandEnvelope(node, kr, fence, 'cmd_1', env)).toEqual(cmd);
    // Wrong commandId binding fails.
    expect(await openCommandEnvelope(node, kr, fence, 'cmd_other', env)).toBeNull();
  });
});

describe('shadowDataCodec — command ACKs', () => {
  it('signs, seals, opens and verifies an ACK; tamper fails verification', async () => {
    const kr = await ring(node.randomBytes(32));
    const unsigned: Omit<HostCommandAck, 'signature'> = { family: 'command-ack', v: 1, commandId: 'cmd_1', status: 'accepted', fence, acceptedSeq: 1, resultSeq: 2, signedAt: 123 };
    const signature = await signCommandAck(node, kr, unsigned);
    const ack: HostCommandAck = { ...unsigned, signature };
    const env = await sealCommandAck(node, kr, ack);
    const opened = await openCommandAck(node, kr, fence, 'cmd_1', env);
    expect(opened).toEqual(ack);
    expect(await verifyCommandAck(node, kr, opened!)).toBe(true);
    // Tampered status fails HMAC verification.
    expect(await verifyCommandAck(node, kr, { ...ack, status: 'rejected' })).toBe(false);
    // Wrong scope key fails to open.
    expect(await openCommandAck(node, await ring(node.randomBytes(32)), fence, 'cmd_1', env)).toBeNull();
  });
});

describe('shadowDataCodec — HKDF key separation (finding 3)', () => {
  it('derives five pairwise-distinct purpose subkeys (no cross-domain key reuse)', async () => {
    const kr = await ring(node.randomBytes(32));
    const subkeys = [kr.eventPayloadAead, kr.eventNoncePrf, kr.commandEnvelopeAead, kr.commandAckMac, kr.commandAckAead].map(base64urlEncode);
    expect(new Set(subkeys).size).toBe(5);
    // None equals the raw scope key material length aside, they are all independent.
    expect(kr.version).toBe(SHADOW_DATA_CODEC_VERSION);
  });

  it('derivation is deterministic for identical (key, context) and independent per keyId (rotation)', async () => {
    const scopeKey = node.randomBytes(32);
    const a = await ring(scopeKey, 'wk_1');
    const b = await ring(scopeKey, 'wk_1');
    expect(base64urlEncode(a.eventPayloadAead)).toBe(base64urlEncode(b.eventPayloadAead));
    expect(base64urlEncode(a.commandAckMac)).toBe(base64urlEncode(b.commandAckMac));
    // Rotation to a new keyId yields fully independent subkeys.
    const rotated = await ring(scopeKey, 'wk_2');
    for (const purpose of ['eventPayloadAead', 'eventNoncePrf', 'commandEnvelopeAead', 'commandAckMac', 'commandAckAead'] as const) {
      expect(base64urlEncode(rotated[purpose])).not.toBe(base64urlEncode(a[purpose]));
    }
  });

  it('a keyring derived for a different account/scope cannot open another scope’s command/ACK', async () => {
    const scopeKey = node.randomBytes(32);
    const kr = await deriveScopeKeyring(node, scopeKey, { accountId: 'acct', scopeId: 'account:acct', keyId: 'wk_1' });
    const foreign = await deriveScopeKeyring(node, scopeKey, { accountId: 'acct', scopeId: 'account:evil', keyId: 'wk_1' });
    const env = await sealCommandEnvelope(node, kr, fence, 'cmd_1', { method: 'x' });
    expect(await openCommandEnvelope(node, foreign, fence, 'cmd_1', env)).toBeNull();
    const unsigned: Omit<HostCommandAck, 'signature'> = { family: 'command-ack', v: 1, commandId: 'cmd_1', status: 'accepted', fence, signedAt: 1 };
    const ack: HostCommandAck = { ...unsigned, signature: await signCommandAck(node, kr, unsigned) };
    // Foreign ACK-MAC subkey rejects, and foreign ACK-AEAD subkey cannot open.
    expect(await verifyCommandAck(node, foreign, ack)).toBe(false);
    expect(await openCommandAck(node, foreign, fence, 'cmd_1', await sealCommandAck(node, kr, ack))).toBeNull();
  });

  it('dispose() zeroizes every derived subkey', async () => {
    const kr = await ring(node.randomBytes(32));
    kr.dispose();
    for (const purpose of ['eventPayloadAead', 'eventNoncePrf', 'commandEnvelopeAead', 'commandAckMac', 'commandAckAead'] as const) {
      expect(kr[purpose].every((b) => b === 0)).toBe(true);
    }
  });
});
