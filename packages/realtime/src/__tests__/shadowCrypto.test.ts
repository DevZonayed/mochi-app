import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  constantTimeEqual,
  hexEncode,
  keyFingerprint,
  structuredEncode,
  structuredDigest,
  utf8Encode,
  webcryptoShadowCrypto,
  type ShadowCryptoBackend,
} from '../shadowCrypto';
import { nodeShadowCrypto, nodeWebCryptoInstance } from '../shadowCryptoNode';

const web = webcryptoShadowCrypto(nodeWebCryptoInstance);
const backends: Array<[string, ShadowCryptoBackend]> = [
  ['node', nodeShadowCrypto],
  ['webcrypto', web],
];

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('shadowCrypto byte/text helpers', () => {
  it('base64url round-trips arbitrary byte lengths', () => {
    for (let len = 0; len < 64; len += 1) {
      const bytes = nodeShadowCrypto.randomBytes(len);
      const encoded = base64urlEncode(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect([...base64urlDecode(encoded)]).toEqual([...bytes]);
    }
  });

  it('base64url rejects padding and non-url-safe alphabet', () => {
    expect(() => base64urlDecode('QQ==')).toThrow();
    expect(() => base64urlDecode('a/b+')).toThrow();
    expect(() => base64urlDecode('A')).toThrow(); // length 1 mod 4 is impossible
  });

  it('constantTimeEqual matches only identical byte strings', () => {
    const a = hexToBytes('00112233445566778899aabbccddeeff');
    expect(constantTimeEqual(a, a.slice())).toBe(true);
    const b = a.slice();
    b[7] ^= 1;
    expect(constantTimeEqual(a, b)).toBe(false);
    expect(constantTimeEqual(a, a.slice(0, 15))).toBe(false);
  });

  it('structuredEncode is unambiguous across field boundaries', () => {
    // ['ab','c'] must not collide with ['a','bc'] — length prefixing prevents it.
    expect([...structuredEncode('d', ['ab', 'c'])]).not.toEqual([...structuredEncode('d', ['a', 'bc'])]);
    // domain separation
    expect([...structuredEncode('d1', ['x'])]).not.toEqual([...structuredEncode('d2', ['x'])]);
    // byte vs string of same content must differ (type tag)
    expect([...structuredEncode('d', [utf8Encode('x')])]).not.toEqual([...structuredEncode('d', ['x'])]);
  });
});

describe('shadowCrypto known-answer vectors (both backends)', () => {
  it.each(backends)('%s SHA-256("abc") matches FIPS-180 vector', async (_name, backend) => {
    const d = await backend.sha256(utf8Encode('abc'));
    expect(hexEncode(d)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it.each(backends)('%s HKDF-SHA256 matches RFC 5869 Test Case 1', async (_name, backend) => {
    const ikm = hexToBytes('0b'.repeat(22));
    const salt = hexToBytes('000102030405060708090a0b0c');
    const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9');
    const okm = await backend.hkdfSha256(ikm, salt, info, 42);
    expect(hexEncode(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  });

  it.each(backends)('%s AES-256-GCM matches NIST zero-key/zero-iv/empty vector', async (_name, backend) => {
    const key = new Uint8Array(32);
    const nonce = new Uint8Array(12);
    const ct = await backend.aesGcmSeal(key, nonce, new Uint8Array(0), new Uint8Array(0));
    expect(hexEncode(ct)).toBe('530f8afbc74536b9a963b4f1c4cb738b');
    const pt = await backend.aesGcmOpen(key, nonce, ct, new Uint8Array(0));
    expect(pt).not.toBeNull();
    expect(pt!.length).toBe(0);
  });

  it.each(backends)('%s HMAC-SHA256 matches RFC 4231 Test Case 2', async (_name, backend) => {
    const key = utf8Encode('Jefe');
    const data = utf8Encode('what do ya want for nothing?');
    const mac = await backend.hmacSha256(key, data);
    expect(hexEncode(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

describe('shadowCrypto Ed25519 signatures', () => {
  it.each(backends)('%s sign/verify round-trips and rejects tamper', async (_name, backend) => {
    const { publicKey, privateKey } = await backend.generateSigningKeyPair();
    expect(publicKey.length).toBe(32);
    expect(privateKey.length).toBe(32);
    const msg = utf8Encode('enrollment-transcript');
    const sig = await backend.sign(privateKey, msg);
    expect(sig.length).toBe(64);
    expect(await backend.verify(publicKey, msg, sig)).toBe(true);
    const tampered = msg.slice();
    tampered[0] ^= 1;
    expect(await backend.verify(publicKey, tampered, sig)).toBe(false);
    const badSig = sig.slice();
    badSig[10] ^= 1;
    expect(await backend.verify(publicKey, msg, badSig)).toBe(false);
  });

  it('is deterministic and interoperable across node and webcrypto backends', async () => {
    // Ed25519 is deterministic: same seed + msg → identical signature in any impl.
    const { publicKey, privateKey } = await nodeShadowCrypto.generateSigningKeyPair();
    const msg = utf8Encode('cross-backend');
    const sigNode = await nodeShadowCrypto.sign(privateKey, msg);
    const sigWeb = await web.sign(privateKey, msg);
    expect([...sigWeb]).toEqual([...sigNode]);
    // cross-verify
    expect(await web.verify(publicKey, msg, sigNode)).toBe(true);
    expect(await nodeShadowCrypto.verify(publicKey, msg, sigWeb)).toBe(true);
  });
});

describe('shadowCrypto X25519 agreement', () => {
  it.each(backends)('%s derives a matching shared secret both directions', async (_name, backend) => {
    const a = await backend.generateAgreementKeyPair();
    const b = await backend.generateAgreementKeyPair();
    const s1 = await backend.deriveSharedSecret(a.privateKey, b.publicKey);
    const s2 = await backend.deriveSharedSecret(b.privateKey, a.publicKey);
    expect(s1.length).toBe(32);
    expect([...s1]).toEqual([...s2]);
  });

  it('agrees across node and webcrypto backends', async () => {
    const a = await nodeShadowCrypto.generateAgreementKeyPair();
    const b = await web.generateAgreementKeyPair();
    const s1 = await nodeShadowCrypto.deriveSharedSecret(a.privateKey, b.publicKey);
    const s2 = await web.deriveSharedSecret(b.privateKey, a.publicKey);
    expect([...s1]).toEqual([...s2]);
  });
});

describe('shadowCrypto AES-256-GCM AEAD', () => {
  it.each(backends)('%s seals/opens with AAD and rejects tampered ct/nonce/aad', async (_name, backend) => {
    const key = backend.randomBytes(32);
    const nonce = backend.randomBytes(12);
    const aad = utf8Encode('transcript-binding');
    const pt = utf8Encode('super-secret-scope-key-material');
    const ct = await backend.aesGcmSeal(key, nonce, pt, aad);
    expect(ct.length).toBe(pt.length + 16);
    expect([...(await backend.aesGcmOpen(key, nonce, ct, aad))!]).toEqual([...pt]);
    // tampered ciphertext
    const badCt = ct.slice();
    badCt[0] ^= 1;
    expect(await backend.aesGcmOpen(key, nonce, badCt, aad)).toBeNull();
    // tampered aad
    expect(await backend.aesGcmOpen(key, nonce, ct, utf8Encode('other-binding'))).toBeNull();
    // wrong nonce
    const badNonce = nonce.slice();
    badNonce[0] ^= 1;
    expect(await backend.aesGcmOpen(key, badNonce, ct, aad)).toBeNull();
    // wrong key
    expect(await backend.aesGcmOpen(backend.randomBytes(32), nonce, ct, aad)).toBeNull();
  });

  it('AEAD is interoperable across backends', async () => {
    const key = nodeShadowCrypto.randomBytes(32);
    const nonce = nodeShadowCrypto.randomBytes(12);
    const aad = utf8Encode('aad');
    const pt = utf8Encode('interop-plaintext');
    const ctNode = await nodeShadowCrypto.aesGcmSeal(key, nonce, pt, aad);
    expect([...(await web.aesGcmOpen(key, nonce, ctNode, aad))!]).toEqual([...pt]);
    const ctWeb = await web.aesGcmSeal(key, nonce, pt, aad);
    expect([...(await nodeShadowCrypto.aesGcmOpen(key, nonce, ctWeb, aad))!]).toEqual([...pt]);
  });
});

describe('shadowCrypto key fingerprints', () => {
  it('are deterministic, purpose-separated, and grammar-valid', async () => {
    const pub = nodeShadowCrypto.randomBytes(32);
    const signId = await keyFingerprint(nodeShadowCrypto, 'sign', pub);
    const agreeId = await keyFingerprint(nodeShadowCrypto, 'agree', pub);
    expect(signId).toMatch(/^sk_[A-Za-z0-9_-]+$/);
    expect(agreeId).toMatch(/^ak_[A-Za-z0-9_-]+$/);
    expect(signId).not.toBe(agreeId); // purpose separation
    expect(signId).toBe(await keyFingerprint(web, 'sign', pub)); // cross-backend determinism
    // matches shared protocol id grammar
    expect(signId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
  });

  it('structuredDigest changes when any bound field changes', async () => {
    const a = await structuredDigest(nodeShadowCrypto, 'd', ['x', 1, concatBytes(utf8Encode('y'))]);
    const b = await structuredDigest(nodeShadowCrypto, 'd', ['x', 2, concatBytes(utf8Encode('y'))]);
    expect(hexEncode(a)).not.toBe(hexEncode(b));
  });
});
