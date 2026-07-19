/**
 * shadowCrypto — platform-agnostic cryptographic core for the native controller
 * secure enrollment / revocation transport.
 *
 * This module is imported by BOTH the Node tiers (desktop host, account relay,
 * tests) and the React Native / Expo mobile tier, so it MUST NOT statically
 * import `node:crypto` or any platform module. All primitive operations are
 * provided through an injected {@link ShadowCryptoBackend}:
 *   - Node tiers inject `nodeShadowCrypto` from `./shadowCryptoNode`.
 *   - The mobile tier injects an Expo/WebCrypto-backed backend.
 *   - {@link webcryptoShadowCrypto} works anywhere a compliant WebCrypto
 *     `SubtleCrypto` with Ed25519 + X25519 is available (used for cross-backend
 *     known-answer validation in tests).
 *
 * The higher-level enrollment/grant/revocation logic lives in
 * `./shadowEnrollment` and is written purely against this interface.
 */

export type ShadowKeyAlgorithm = 'Ed25519' | 'X25519';

export interface ShadowKeyPair {
  /** Raw 32-byte public key. */
  readonly publicKey: Uint8Array;
  /** Raw 32-byte private key (secret material — never serialize to the wire). */
  readonly privateKey: Uint8Array;
}

/**
 * Minimal, algorithm-fixed cryptographic backend. Every method is async so the
 * same interface can be satisfied by synchronous (`node:crypto`) and
 * asynchronous (`SubtleCrypto`, `expo-crypto`) implementations.
 *
 * Algorithms are fixed by contract (no negotiation): Ed25519 signatures,
 * X25519 agreement, HKDF-SHA256, HMAC-SHA256, SHA-256, AES-256-GCM.
 */
export interface ShadowCryptoBackend {
  readonly name: string;
  /** CSPRNG. Synchronous by design — both getRandomValues and randomBytes are. */
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array>;
  generateSigningKeyPair(): Promise<ShadowKeyPair>;
  sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
  generateAgreementKeyPair(): Promise<ShadowKeyPair>;
  /** X25519 ECDH → 32-byte shared secret. */
  deriveSharedSecret(privateKey: Uint8Array, peerPublicKey: Uint8Array): Promise<Uint8Array>;
  /** AES-256-GCM. Returns ciphertext WITH the 16-byte tag appended. */
  aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  /** AES-256-GCM open. Returns plaintext, or `null` on any authentication failure. */
  aesGcmOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null>;
}

export const SHADOW_AES_GCM_NONCE_BYTES = 12 as const;
export const SHADOW_AES_GCM_TAG_BYTES = 16 as const;
export const SHADOW_AES_KEY_BYTES = 32 as const;
export const SHADOW_ENROLLMENT_SECRET_BYTES = 32 as const;
export const SHADOW_SCOPE_KEY_BYTES = 32 as const;

// ---------------------------------------------------------------------------
// Byte / text helpers (pure, allocation-safe, no platform dependency)
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64URL_ALPHABET.length; i += 1) B64URL_LOOKUP[B64URL_ALPHABET[i]!] = i;

export function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? utf8Encode(input) : input;
}

export function utf8Encode(text: string): Uint8Array {
  // TextEncoder is available in Node, browsers, RN Hermes.
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL_ALPHABET[(n >>> 18) & 63]! + B64URL_ALPHABET[(n >>> 12) & 63]! + B64URL_ALPHABET[(n >>> 6) & 63]! + B64URL_ALPHABET[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64URL_ALPHABET[(n >>> 18) & 63]! + B64URL_ALPHABET[(n >>> 12) & 63]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL_ALPHABET[(n >>> 18) & 63]! + B64URL_ALPHABET[(n >>> 12) & 63]! + B64URL_ALPHABET[(n >>> 6) & 63]!;
  }
  return out;
}

export function base64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('bad-base64url');
  const len = text.length;
  const fullGroups = Math.floor(len / 4);
  const rem = len - fullGroups * 4;
  if (rem === 1) throw new Error('bad-base64url-length');
  const outLen = fullGroups * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    const n = (B64URL_LOOKUP[text[i]!]! << 18) | (B64URL_LOOKUP[text[i + 1]!]! << 12) | (B64URL_LOOKUP[text[i + 2]!]! << 6) | B64URL_LOOKUP[text[i + 3]!]!;
    out[o++] = (n >>> 16) & 0xff;
    out[o++] = (n >>> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (rem === 2) {
    const n = (B64URL_LOOKUP[text[i]!]! << 18) | (B64URL_LOOKUP[text[i + 1]!]! << 12);
    out[o++] = (n >>> 16) & 0xff;
  } else if (rem === 3) {
    const n = (B64URL_LOOKUP[text[i]!]! << 18) | (B64URL_LOOKUP[text[i + 1]!]! << 12) | (B64URL_LOOKUP[text[i + 2]!]! << 6);
    out[o++] = (n >>> 16) & 0xff;
    out[o++] = (n >>> 8) & 0xff;
  }
  return out;
}

export function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Constant-time equality for secret-proof comparisons. Runs in time dependent
 * only on the length of `a`, never short-circuiting on the first difference.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Length is not secret; a length mismatch is still resolved without early
  // content comparison. We fold b against a fixed-length walk of `a`.
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ (i < b.length ? b[i]! : 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Canonical, domain-separated, length-prefixed structured encoding.
// Used to build unambiguous transcripts and digest inputs so that no two
// distinct field tuples can ever produce the same signed/hashed bytes.
// ---------------------------------------------------------------------------

export type StructuredPart = Uint8Array | string | number | boolean;

function u32be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('bad-length-prefix');
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function u64be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n)) throw new Error('bad-u64');
  const out = new Uint8Array(8);
  let v = n;
  const negative = v < 0;
  if (negative) v = -v;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  // encode sign in a leading domain byte via caller; here always non-negative in use.
  if (negative) throw new Error('negative-not-supported');
  return out;
}

const TAG_BYTES = 0x01;
const TAG_STRING = 0x02;
const TAG_UINT = 0x03;
const TAG_BOOL = 0x04;

/**
 * Encode a domain-tagged, length-prefixed, unambiguous byte string over a list
 * of parts. Each part is prefixed with a 1-byte type tag and (for variable-len
 * parts) a 4-byte big-endian length. The domain string is itself length-tagged
 * as the first element, guaranteeing cross-domain separation.
 */
export function structuredEncode(domain: string, parts: readonly StructuredPart[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const domainBytes = utf8Encode(domain);
  chunks.push(new Uint8Array([TAG_STRING]), u32be(domainBytes.length), domainBytes);
  chunks.push(u32be(parts.length));
  for (const part of parts) {
    if (part instanceof Uint8Array) {
      chunks.push(new Uint8Array([TAG_BYTES]), u32be(part.length), part);
    } else if (typeof part === 'string') {
      const b = utf8Encode(part);
      chunks.push(new Uint8Array([TAG_STRING]), u32be(b.length), b);
    } else if (typeof part === 'number') {
      chunks.push(new Uint8Array([TAG_UINT]), u64be(part));
    } else if (typeof part === 'boolean') {
      chunks.push(new Uint8Array([TAG_BOOL, part ? 1 : 0]));
    } else {
      throw new Error('bad-structured-part');
    }
  }
  return concatBytes(...chunks);
}

export async function structuredDigest(
  backend: ShadowCryptoBackend,
  domain: string,
  parts: readonly StructuredPart[],
): Promise<Uint8Array> {
  return backend.sha256(structuredEncode(domain, parts));
}

/**
 * Deterministic public-key fingerprint / key id: SHA-256 over the canonical raw
 * public key bytes, domain-separated by algorithm+purpose, rendered as a
 * base64url token with a short human prefix. The output matches the shared
 * protocol id grammar (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`).
 */
export async function keyFingerprint(
  backend: ShadowCryptoBackend,
  purpose: 'sign' | 'agree',
  publicKey: Uint8Array,
): Promise<string> {
  const digest = await structuredDigest(backend, 'maestro.shadow.keyid.v1', [purpose, publicKey]);
  const prefix = purpose === 'sign' ? 'sk_' : 'ak_';
  return prefix + base64urlEncode(digest);
}

/** Short human-verifiable phrase derived from a fingerprint (for QR/UX confirm). */
export async function humanVerificationPhrase(
  backend: ShadowCryptoBackend,
  hostFingerprint: string,
  words = 6,
): Promise<string> {
  const digest = await structuredDigest(backend, 'maestro.shadow.verify-phrase.v1', [hostFingerprint]);
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) {
    const idx = (digest[i]! << 8 | digest[(i + words) % digest.length]!) % PHRASE_WORDS.length;
    out.push(PHRASE_WORDS[idx]!);
  }
  return out.join('-');
}

const PHRASE_WORDS = [
  'amber', 'anchor', 'basil', 'beacon', 'birch', 'canyon', 'cedar', 'cobalt',
  'copper', 'coral', 'delta', 'dune', 'ember', 'fable', 'falcon', 'fern',
  'flint', 'garnet', 'glacier', 'harbor', 'hazel', 'ivory', 'jade', 'juniper',
  'kelp', 'lagoon', 'lark', 'linen', 'maple', 'meadow', 'mica', 'nectar',
  'nimbus', 'oak', 'onyx', 'opal', 'orchid', 'pebble', 'pine', 'quartz',
  'quill', 'raven', 'reef', 'saffron', 'sage', 'slate', 'spruce', 'tansy',
  'thistle', 'topaz', 'umber', 'vale', 'velvet', 'willow', 'zephyr', 'zinc',
] as const;

// ---------------------------------------------------------------------------
// PKCS8 seed wrapping. Ed25519 and X25519 private keys are 32-byte seeds; the
// standard PKCS8 DER envelope for each is a fixed 48-byte structure with the
// seed at offset 16. Wrapping raw seeds lets every backend import private keys
// portably (WebCrypto `pkcs8`, `node:crypto` `createPrivateKey`) while the
// stored/persisted secret stays a compact raw 32-byte scalar.
// ---------------------------------------------------------------------------

// SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 (Ed25519) }, OCTET STRING { OCTET STRING seed } }
const ED25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
// same but OID 1.3.101.110 (X25519)
const X25519_PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
const PKCS8_SEED_OFFSET = 16;

export function ed25519Pkcs8(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error('bad-ed25519-seed');
  return concatBytes(ED25519_PKCS8_PREFIX, seed);
}

export function x25519Pkcs8(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error('bad-x25519-seed');
  return concatBytes(X25519_PKCS8_PREFIX, seed);
}

export function seedFromPkcs8(pkcs8: Uint8Array): Uint8Array {
  if (pkcs8.length < PKCS8_SEED_OFFSET + 32) throw new Error('bad-pkcs8');
  return pkcs8.slice(PKCS8_SEED_OFFSET, PKCS8_SEED_OFFSET + 32);
}

// ---------------------------------------------------------------------------
// WebCrypto backend — usable in Node 20+/24 (globalThis.crypto.subtle) and any
// runtime that provides SubtleCrypto with Ed25519 + X25519 support.
// ---------------------------------------------------------------------------

// Local structural types so this module compiles under BOTH the package's
// Bundler+DOM tsconfig and a Node consumer's NodeNext (no DOM lib) tsconfig.
type CryptoBinary = ArrayBufferView | ArrayBuffer;
type CryptoJwk = object;

interface MinimalSubtle {
  digest(algorithm: string, data: CryptoBinary): Promise<ArrayBuffer>;
  importKey(format: string, keyData: CryptoBinary | CryptoJwk, algorithm: any, extractable: boolean, usages: readonly string[]): Promise<any>;
  exportKey(format: string, key: any): Promise<ArrayBuffer | CryptoJwk>;
  generateKey(algorithm: any, extractable: boolean, usages: readonly string[]): Promise<any>;
  sign(algorithm: any, key: any, data: CryptoBinary): Promise<ArrayBuffer>;
  verify(algorithm: any, key: any, signature: CryptoBinary, data: CryptoBinary): Promise<boolean>;
  deriveBits(algorithm: any, baseKey: any, length: number): Promise<ArrayBuffer>;
  encrypt(algorithm: any, key: any, data: CryptoBinary): Promise<ArrayBuffer>;
  decrypt(algorithm: any, key: any, data: CryptoBinary): Promise<ArrayBuffer>;
}

export interface WebCryptoLike {
  subtle: MinimalSubtle;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function u8(buf: ArrayBuffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

/** Wrap raw bytes into a fresh ArrayBuffer-backed view (avoids SAB / offset edge cases). */
function ab(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

export function webcryptoShadowCrypto(webcrypto: WebCryptoLike): ShadowCryptoBackend {
  const subtle = webcrypto.subtle;
  return {
    name: 'webcrypto',
    randomBytes(length: number): Uint8Array {
      return webcrypto.getRandomValues(new Uint8Array(length));
    },
    async sha256(data) {
      return u8(await subtle.digest('SHA-256', ab(data)));
    },
    async hmacSha256(key, data) {
      const k = await subtle.importKey('raw', ab(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return u8(await subtle.sign('HMAC', k, ab(data)));
    },
    async hkdfSha256(ikm, salt, info, length) {
      const k = await subtle.importKey('raw', ab(ikm), 'HKDF', false, ['deriveBits']);
      const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(info) }, k, length * 8);
      return u8(bits);
    },
    async generateSigningKeyPair() {
      const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const pub = u8(await subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
      const pkcs8 = u8(await subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
      return { publicKey: pub, privateKey: seedFromPkcs8(pkcs8) };
    },
    async sign(privateKey, message) {
      const key = await subtle.importKey('pkcs8', ab(ed25519Pkcs8(privateKey)), { name: 'Ed25519' }, false, ['sign']);
      return u8(await subtle.sign({ name: 'Ed25519' }, key, ab(message)));
    },
    async verify(publicKey, message, signature) {
      const key = await subtle.importKey('raw', ab(publicKey), { name: 'Ed25519' }, false, ['verify']);
      return subtle.verify({ name: 'Ed25519' }, key, ab(signature), ab(message));
    },
    async generateAgreementKeyPair() {
      const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      const pub = u8(await subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
      const pkcs8 = u8(await subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
      return { publicKey: pub, privateKey: seedFromPkcs8(pkcs8) };
    },
    async deriveSharedSecret(privateKey, peerPublicKey) {
      const priv = await subtle.importKey('pkcs8', ab(x25519Pkcs8(privateKey)), { name: 'X25519' }, false, ['deriveBits']);
      const pub = await subtle.importKey('raw', ab(peerPublicKey), { name: 'X25519' }, false, []);
      return u8(await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256));
    },
    async aesGcmSeal(key, nonce, plaintext, aad) {
      const k = await subtle.importKey('raw', ab(key), { name: 'AES-GCM' }, false, ['encrypt']);
      return u8(await subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aad), tagLength: 128 }, k, ab(plaintext)));
    },
    async aesGcmOpen(key, nonce, ciphertext, aad) {
      const k = await subtle.importKey('raw', ab(key), { name: 'AES-GCM' }, false, ['decrypt']);
      try {
        return u8(await subtle.decrypt({ name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aad), tagLength: 128 }, k, ab(ciphertext)));
      } catch {
        return null;
      }
    },
  };
}
