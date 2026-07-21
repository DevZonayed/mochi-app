/* Legacy Electron/Chromium macOS "v10" Safe Storage decrypt — deterministic
   known-answer vectors + fail-closed behavior + channel service isolation.

   The vector was produced with the exact macOS OSCrypt scheme
   (PBKDF2-HMAC-SHA1(pw,"saltysalt",1003,16) → AES-128-CBC, IV=16×0x20, PKCS7):
     pw="peanuts", plaintext="fal-abcdef0123456789abcdef01234567"
   Its 3-byte prefix is `v10` (hex 763130) — the SAME shape the production FAL
   cipher was proven to have. */
import { describe, it, expect } from 'vitest';
import {
  decryptElectronV10,
  isElectronV10,
  legacyServiceForChannel,
  fetchLegacySafeStoragePassword,
} from './legacy-safe-storage.js';

const KAT_PW = 'peanuts';
const KAT_PLAINTEXT = 'fal-abcdef0123456789abcdef01234567';
const KAT_BLOB_B64 = 'djEwoz83pTbeWGHYNJEVdRUEGuxeitQe6xAO1t436amA4qkMP7RAdfOXabhNEi/vomhD';
const blob = () => Buffer.from(KAT_BLOB_B64, 'base64');

describe('isElectronV10', () => {
  it('recognizes the v10 marker (763130) and rejects others', () => {
    expect(isElectronV10(blob())).toBe(true);
    expect(isElectronV10(Buffer.from('MS1abc'))).toBe(false);
    expect(isElectronV10(Buffer.from('fal_plainkey'))).toBe(false);
    expect(isElectronV10(Buffer.alloc(0))).toBe(false);
    expect(isElectronV10(Buffer.from('v1'))).toBe(false);
  });
});

describe('decryptElectronV10 — deterministic known-answer', () => {
  it('decrypts the KAT vector to the exact plaintext', () => {
    expect(decryptElectronV10(blob(), KAT_PW).toString('utf8')).toBe(KAT_PLAINTEXT);
  });
  it('fails CLOSED on the wrong master password (bad PKCS7 padding → throw)', () => {
    expect(() => decryptElectronV10(blob(), 'not-the-password')).toThrow();
  });
  it('fails CLOSED on a tampered ciphertext byte', () => {
    const b = blob(); b[b.length - 1] ^= 0xff;
    expect(() => decryptElectronV10(b, KAT_PW)).toThrow();
  });
  it('rejects a non-v10 blob', () => {
    expect(() => decryptElectronV10(Buffer.from('MS1xxxxxxxxxxxxxxxx'), KAT_PW)).toThrow();
  });
  it('rejects a ciphertext whose length is not a CBC block multiple', () => {
    expect(() => decryptElectronV10(Buffer.concat([Buffer.from('v10'), Buffer.alloc(15)]), KAT_PW)).toThrow();
  });
});

describe('legacyServiceForChannel — production reads the real Electron service; others are isolated', () => {
  it('production resolves to EXACTLY "@maestro/desktop Safe Storage"', () => {
    expect(legacyServiceForChannel('production', {})).toBe('@maestro/desktop Safe Storage');
    expect(legacyServiceForChannel(undefined, {})).toBe('@maestro/desktop Safe Storage');
  });
  it('preview/development get their OWN (nonexistent) service — never production', () => {
    expect(legacyServiceForChannel('preview', {})).toBe('@maestro/desktop-preview Safe Storage');
    expect(legacyServiceForChannel('development', {})).toBe('@maestro/desktop-development Safe Storage');
    expect(legacyServiceForChannel('preview', {})).not.toBe('@maestro/desktop Safe Storage');
  });
  it('an explicit test-only override wins (so a Preview proof can target production)', () => {
    expect(legacyServiceForChannel('preview', { MAESTRO_LEGACY_SAFE_STORAGE_SERVICE: '@maestro/desktop Safe Storage' }))
      .toBe('@maestro/desktop Safe Storage');
  });
});

describe('fetchLegacySafeStoragePassword — safe, non-throwing, no leak', () => {
  it('returns undefined for a service that certainly does not exist (never throws)', () => {
    const svc = 'maestro-nonexistent-service-' + 'zzzqx'.repeat(3);
    expect(fetchLegacySafeStoragePassword(svc)).toBeUndefined();
  });
  it('honors a bounded timeout arg (an unanswered ACL prompt cannot hang the event loop forever)', () => {
    // A tiny timeout must still return undefined (not throw, not hang) — this is
    // the guard that keeps a v10 Keychain prompt from freezing every RPC.
    const svc = 'maestro-nonexistent-service-' + 'qzxwv'.repeat(3);
    const t0 = process.hrtime.bigint();
    expect(fetchLegacySafeStoragePassword(svc, 200)).toBeUndefined();
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(elapsedMs).toBeLessThan(5000); // returns promptly, never wedges
  });
});
