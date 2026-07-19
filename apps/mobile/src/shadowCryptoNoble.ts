/**
 * shadowCryptoNoble — Phase 3A2a pure-JS ShadowCryptoBackend for React Native /
 * Hermes, where WebCrypto lacks Ed25519 + X25519. Backed by the audited @noble
 * suite (curves/hashes/ciphers), so the exact same primitives (Ed25519, X25519,
 * SHA-256, HMAC-SHA256, HKDF-SHA256, AES-256-GCM) the Node backend uses are
 * available in the app bundle with no native module, no `eval`, no remote WASM
 * fetch, and no Node import. Byte-for-byte interoperability with `nodeShadowCrypto`
 * is proven by the known-answer test `shadowCryptoNoble.kat.test.ts`.
 *
 * CSPRNG: RN must provide a secure `getRandomValues` (via `react-native-get-random-values`
 * or `expo-crypto`). We read `globalThis.crypto.getRandomValues` by default and
 * allow an explicit source to be injected (tests / custom polyfills). We do NOT
 * fall back to a non-secure RNG — if no CSPRNG is present we throw (fail closed).
 */
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { hmac as nobleHmac } from '@noble/hashes/hmac';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf';
import { gcm } from '@noble/ciphers/aes';
import type { ShadowCryptoBackend, ShadowKeyPair } from '@maestro/realtime/shadowCrypto';

export type RandomSource = (length: number) => Uint8Array;

function defaultRandomSource(): RandomSource {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const gr = g.crypto.getRandomValues.bind(g.crypto);
    return (length: number) => gr(new Uint8Array(length));
  }
  throw new Error('no secure CSPRNG available — install react-native-get-random-values or expo-crypto');
}

/**
 * Construct the RN/Hermes crypto backend. `randomSource` defaults to
 * `globalThis.crypto.getRandomValues`; inject one for deterministic tests or a
 * custom polyfill.
 */
export function nobleShadowCrypto(randomSource: RandomSource = defaultRandomSource()): ShadowCryptoBackend {
  const randomBytes = (length: number): Uint8Array => {
    const out = randomSource(length);
    if (!(out instanceof Uint8Array) || out.length !== length) throw new Error('bad random source output');
    return out;
  };
  return {
    name: 'noble',
    randomBytes,
    async sha256(data: Uint8Array): Promise<Uint8Array> {
      return nobleSha256(data);
    },
    async hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
      return nobleHmac(nobleSha256, key, data);
    },
    async hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
      return nobleHkdf(nobleSha256, ikm, salt, info, length);
    },
    async generateSigningKeyPair(): Promise<ShadowKeyPair> {
      const privateKey = randomBytes(32);
      const publicKey = ed25519.getPublicKey(privateKey);
      return { publicKey, privateKey };
    },
    async sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
      return ed25519.sign(message, privateKey);
    },
    async verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
      try {
        return ed25519.verify(signature, message, publicKey);
      } catch {
        return false;
      }
    },
    async generateAgreementKeyPair(): Promise<ShadowKeyPair> {
      const privateKey = randomBytes(32);
      const publicKey = x25519.getPublicKey(privateKey);
      return { publicKey, privateKey };
    },
    async deriveSharedSecret(privateKey: Uint8Array, peerPublicKey: Uint8Array): Promise<Uint8Array> {
      return x25519.getSharedSecret(privateKey, peerPublicKey);
    },
    async aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
      // noble gcm.encrypt returns ciphertext WITH the 16-byte tag appended — the
      // same layout the Node backend uses.
      return gcm(key, nonce, aad).encrypt(plaintext);
    },
    async aesGcmOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
      if (ciphertext.length < 16) return null;
      try {
        return gcm(key, nonce, aad).decrypt(ciphertext);
      } catch {
        return null;
      }
    },
  };
}
