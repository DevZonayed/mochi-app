/* MS1 envelope crypto — authenticated AES-256-GCM under a 32-byte master key.
   This REPLACES the old plaintext UTF-8 passthrough shim. Must: round-trip,
   randomize ciphertext (fresh nonce), never embed plaintext, and FAIL CLOSED on
   a wrong key or any tamper. Pure Node crypto — no Electron, no env, no I/O. */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  loadMasterKey,
  isMS1,
  encryptWithKey,
  decryptWithKey,
  SAFE_STORAGE_KEY_LEN,
} from './safe-storage-crypto.ts';

const key = () => randomBytes(SAFE_STORAGE_KEY_LEN);

describe('loadMasterKey — strict 32-byte base64 from env', () => {
  it('accepts a valid 32-byte base64 key', () => {
    const k = randomBytes(32).toString('base64');
    expect(loadMasterKey({ MAESTRO_SAFE_STORAGE_KEY: k })?.length).toBe(32);
  });
  it('rejects missing / wrong-length / garbage keys (→ null = unavailable)', () => {
    expect(loadMasterKey({})).toBeNull();
    expect(loadMasterKey({ MAESTRO_SAFE_STORAGE_KEY: '' })).toBeNull();
    expect(loadMasterKey({ MAESTRO_SAFE_STORAGE_KEY: randomBytes(16).toString('base64') })).toBeNull(); // too short
    expect(loadMasterKey({ MAESTRO_SAFE_STORAGE_KEY: randomBytes(48).toString('base64') })).toBeNull(); // too long
  });
  it('rejects NON-CANONICAL base64 even when it decodes to 32 bytes (lenient decode is not trusted)', () => {
    const canonical = randomBytes(32).toString('base64');
    // Stray whitespace/newline inside — Buffer.from(...,base64) ignores these and
    // still yields 32 bytes, but the value is not canonical → must be rejected.
    expect(loadMasterKey({ MAESTRO_SAFE_STORAGE_KEY: canonical.slice(0, 4) + '\n' + canonical.slice(4) })).toBeNull();
    expect(loadMasterKey({ MAESTRO_SAFE_STORAGE_KEY: ' ' + canonical })).toBeNull();
    expect(loadMasterKey({ MAESTRO_SAFE_STORAGE_KEY: canonical + '===' })).toBeNull(); // over-padded
    // A pristine canonical value still round-trips and is accepted.
    expect(loadMasterKey({ MAESTRO_SAFE_STORAGE_KEY: canonical })?.length).toBe(32);
  });
});

describe('encrypt/decrypt round-trip + authenticity', () => {
  it('round-trips arbitrary UTF-8 including Unicode', () => {
    const k = key();
    for (const s of ['fal_abc123', 'a', 'x'.repeat(500), 'café 🚀 日本庭園']) {
      expect(decryptWithKey(k, encryptWithKey(k, s))).toBe(s);
    }
  });
  it('blob carries the MS1 marker and is NOT plaintext (no secret bytes visible)', () => {
    const k = key();
    const secret = 'fal_SUPERSECRETVALUE_9876';
    const blob = encryptWithKey(k, secret);
    expect(isMS1(blob)).toBe(true);
    expect(blob.subarray(0, 3).toString('latin1')).toBe('MS1');
    expect(blob.toString('latin1')).not.toContain(secret);
    expect(blob.toString('utf8')).not.toContain(secret);
    expect(blob.toString('base64')).not.toContain(Buffer.from(secret).toString('base64').replace(/=+$/, ''));
  });
  it('is randomized — same key+plaintext yields different ciphertext each time (fresh nonce)', () => {
    const k = key();
    const a = encryptWithKey(k, 'same-input');
    const b = encryptWithKey(k, 'same-input');
    expect(a.equals(b)).toBe(false);
    expect(decryptWithKey(k, a)).toBe('same-input');
    expect(decryptWithKey(k, b)).toBe('same-input');
  });
});

describe('fail-closed', () => {
  it('throws on a DIFFERENT key (wrong channel / wrong device)', () => {
    const blob = encryptWithKey(key(), 'secret');
    expect(() => decryptWithKey(key(), blob)).toThrow();
  });
  it('throws on a flipped ciphertext byte (GCM auth tag mismatch)', () => {
    const k = key();
    const blob = encryptWithKey(k, 'secret-value-here');
    blob[blob.length - 1] ^= 0x01;
    expect(() => decryptWithKey(k, blob)).toThrow();
  });
  it('throws on a flipped auth-tag / nonce byte', () => {
    const k = key();
    const blob = encryptWithKey(k, 'secret-value-here');
    blob[5] ^= 0x01; // inside nonce/tag region
    expect(() => decryptWithKey(k, blob)).toThrow();
  });
  it('throws on a non-MS1 blob (e.g. a legacy v10 or plaintext row)', () => {
    expect(() => decryptWithKey(key(), Buffer.from('v10garbagebytesxxxxxxxxxxxxxxxxxxxx'))).toThrow();
    expect(() => decryptWithKey(key(), Buffer.from('fal_plaintext_row'))).toThrow();
  });
  it('rejects a wrong-length key argument', () => {
    expect(() => encryptWithKey(randomBytes(16), 'x')).toThrow();
    expect(() => decryptWithKey(randomBytes(16), encryptWithKey(key(), 'x'))).toThrow();
  });
});
