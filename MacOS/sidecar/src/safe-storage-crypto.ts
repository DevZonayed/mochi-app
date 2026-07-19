/* MS1 — authenticated envelope encryption for the sidecar's safeStorage.

   The old shim stored secrets as plaintext UTF-8 base64 (reversible with zero
   key). This replaces it with AES-256-GCM under a 32-byte master key that the
   Swift host provisions in the macOS Keychain (channel-scoped,
   AfterFirstUnlockThisDeviceOnly) and injects via the MAESTRO_SAFE_STORAGE_KEY
   env var — never argv/logs/store/renderer.

   Blob layout (all binary, then base64'd by the store):
     "MS1" (3) │ nonce (12) │ GCM auth tag (16) │ ciphertext (n)
   A fresh random nonce per encryption makes ciphertext non-deterministic; the
   auth tag makes tampering / a wrong (wrong-channel / wrong-device) key fail
   CLOSED — decrypt throws rather than returning garbage. Pure Node crypto so it
   unit-tests without Electron or the Keychain. */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const MARKER = Buffer.from('MS1', 'utf8'); // 0x4D 0x53 0x31
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export const SAFE_STORAGE_MARKER = MARKER;
export const SAFE_STORAGE_KEY_LEN = KEY_LEN;

/** Decode + validate the base64 master key from the environment. Returns the
    raw 32-byte key, or null when absent/malformed/wrong-length (→ encryption is
    "unavailable" and the app stays usable without stored keys). */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const b64 = env.MAESTRO_SAFE_STORAGE_KEY;
  if (!b64) return null;
  // `Buffer.from(x, 'base64')` is lenient — it silently ignores stray/invalid
  // characters and truncates at bad padding. Require the value to be CANONICAL
  // base64 of exactly 32 bytes: decode, then confirm a byte-for-byte re-encode
  // matches the input. A malformed/non-canonical env value is rejected (→ null =
  // encryption unavailable) rather than accepted as a silently-mangled key.
  let raw: Buffer;
  try { raw = Buffer.from(b64, 'base64'); } catch { return null; }
  if (raw.length !== KEY_LEN) return null;
  if (raw.toString('base64') !== b64) return null;
  return raw;
}

/** True when `blob` is a well-formed MS1 envelope (marker + enough bytes for a
    nonce, tag, and at least an empty ciphertext). */
export function isMS1(blob: Buffer): boolean {
  return blob.length >= MARKER.length + NONCE_LEN + TAG_LEN
    && blob.subarray(0, MARKER.length).equals(MARKER);
}

/** Encrypt a UTF-8 string → an MS1 envelope Buffer. Throws on a bad key length. */
export function encryptWithKey(key: Buffer, plaintext: string): Buffer {
  if (key.length !== KEY_LEN) throw new Error('master key must be 32 bytes');
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MARKER, nonce, tag, ct]);
}

/** Decrypt an MS1 envelope → UTF-8 string. FAILS CLOSED: throws on a bad key
    length, a non-MS1 blob, or any authentication failure (wrong key / tamper). */
export function decryptWithKey(key: Buffer, blob: Buffer): string {
  if (key.length !== KEY_LEN) throw new Error('master key must be 32 bytes');
  if (!isMS1(blob)) throw new Error('not an MS1 envelope');
  const nonce = blob.subarray(MARKER.length, MARKER.length + NONCE_LEN);
  const tag = blob.subarray(MARKER.length + NONCE_LEN, MARKER.length + NONCE_LEN + TAG_LEN);
  const ct = blob.subarray(MARKER.length + NONCE_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
