/**
 * shadowCryptoNode — `node:crypto` implementation of {@link ShadowCryptoBackend}.
 *
 * This file statically imports `node:crypto` and therefore MUST ONLY be imported
 * by Node tiers (desktop host, account relay, tests). The React Native / Expo
 * mobile tier must never import it; it is intentionally kept out of the package
 * root index and exposed only through the `@maestro/realtime/shadowCryptoNode`
 * subpath.
 */
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  webcrypto as nodeWebcrypto,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import {
  ed25519Pkcs8,
  x25519Pkcs8,
  seedFromPkcs8,
  type ShadowCryptoBackend,
  type ShadowKeyPair,
  type WebCryptoLike,
} from './shadowCrypto.js';

function toU8(buf: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function toBuf(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function rawPublicFromSpki(spkiDer: Buffer): Uint8Array {
  // Ed25519/X25519 SPKI is a fixed 44-byte structure; the raw 32-byte key is the
  // trailing 32 bytes.
  return toU8(spkiDer.subarray(spkiDer.length - 32));
}

/** Real Node.js CSPRNG + Ed25519/X25519/HKDF/HMAC/AES-256-GCM backend. */
export const nodeShadowCrypto: ShadowCryptoBackend = {
  name: 'node',
  randomBytes(length: number): Uint8Array {
    return toU8(nodeRandomBytes(length));
  },
  async sha256(data) {
    return toU8(createHash('sha256').update(toBuf(data)).digest());
  },
  async hmacSha256(key, data) {
    return toU8(createHmac('sha256', toBuf(key)).update(toBuf(data)).digest());
  },
  async hkdfSha256(ikm, salt, info, length) {
    const derived = hkdfSync('sha256', toBuf(ikm), toBuf(salt), toBuf(info), length);
    return new Uint8Array(derived);
  },
  async generateSigningKeyPair(): Promise<ShadowKeyPair> {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = rawPublicFromSpki(publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
    const seed = seedFromPkcs8(toU8(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer));
    return { publicKey: pub, privateKey: seed };
  },
  async sign(privateKey, message) {
    const key = createPrivateKey({ key: toBuf(ed25519Pkcs8(privateKey)), format: 'der', type: 'pkcs8' });
    return toU8(nodeSign(null, toBuf(message), key));
  },
  async verify(publicKey, message, signature) {
    try {
      const key = createPublicKey({ key: spkiFromRaw(publicKey, 'ed25519'), format: 'der', type: 'spki' });
      return nodeVerify(null, toBuf(message), key, toBuf(signature));
    } catch {
      return false;
    }
  },
  async generateAgreementKeyPair(): Promise<ShadowKeyPair> {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const pub = rawPublicFromSpki(publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
    const seed = seedFromPkcs8(toU8(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer));
    return { publicKey: pub, privateKey: seed };
  },
  async deriveSharedSecret(privateKey, peerPublicKey) {
    const priv = createPrivateKey({ key: toBuf(x25519Pkcs8(privateKey)), format: 'der', type: 'pkcs8' });
    const pub = createPublicKey({ key: spkiFromRaw(peerPublicKey, 'x25519'), format: 'der', type: 'spki' });
    return toU8(diffieHellman({ privateKey: priv, publicKey: pub }));
  },
  async aesGcmSeal(key, nonce, plaintext, aad) {
    const cipher = createCipheriv('aes-256-gcm', toBuf(key), toBuf(nonce), { authTagLength: 16 });
    if (aad.length > 0) cipher.setAAD(toBuf(aad));
    const body = Buffer.concat([cipher.update(toBuf(plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return toU8(Buffer.concat([body, tag]));
  },
  async aesGcmOpen(key, nonce, ciphertext, aad) {
    if (ciphertext.length < 16) return null;
    const body = toBuf(ciphertext.subarray(0, ciphertext.length - 16));
    const tag = toBuf(ciphertext.subarray(ciphertext.length - 16));
    try {
      const decipher = createDecipheriv('aes-256-gcm', toBuf(key), toBuf(nonce), { authTagLength: 16 });
      if (aad.length > 0) decipher.setAAD(toBuf(aad));
      decipher.setAuthTag(tag);
      return toU8(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      return null;
    }
  },
};

// SPKI DER prefixes for raw public key import.
const ED25519_SPKI_PREFIX = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const X25519_SPKI_PREFIX = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

function spkiFromRaw(raw: Uint8Array, alg: 'ed25519' | 'x25519'): Buffer {
  if (raw.length !== 32) throw new Error('bad-raw-public');
  return Buffer.concat([alg === 'ed25519' ? ED25519_SPKI_PREFIX : X25519_SPKI_PREFIX, toBuf(raw)]);
}

/** Node WebCrypto instance, exposed so tests can build the WebCrypto backend without a global. */
export const nodeWebCryptoInstance = nodeWebcrypto as unknown as WebCryptoLike;

/** Constant-time compare backed by Node's timingSafeEqual (length-guarded). */
export function nodeTimingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(toBuf(a), toBuf(b));
}
