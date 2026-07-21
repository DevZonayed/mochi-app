import { describe, test, expect, vi, beforeEach } from 'vitest';

/* Electron's safeStorage is faked. encryptString marks output with the MS1
   header so a migrated cipher is recognized as MS1 on re-read; decryptString
   returns the controllable `decrypted.value` so a test can drive "what an MS1
   blob decrypts to" (a clean key or U+FFFD mojibake). */
const decrypted = { value: '' };
const encryptAvailable = { value: true };
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptAvailable.value,
    decryptString: () => decrypted.value,
    encryptString: (s: string) => Buffer.concat([Buffer.from('MS1'), Buffer.from(s, 'utf8')]),
  },
}));

/* github-auth's gh CLI fallback is faked so we control the clean token that
   should win once the corrupt cipher is rejected. */
const cli = { token: null as string | null };
vi.mock('./github-auth.js', () => ({
  ghCliToken: () => cli.token,
  ghLoggedIn: () => cli.token != null,
}));

/* Keep the REAL v10 decrypt + service resolver; only the Keychain password
   fetch is stubbed so the legacy-migration path is deterministic offline. */
const legacyPw = { value: undefined as string | undefined };
vi.mock('./legacy-safe-storage.js', async (orig) => {
  const actual = await orig<typeof import('./legacy-safe-storage.js')>();
  return { ...actual, fetchLegacySafeStoragePassword: () => legacyPw.value };
});

import { Providers, isCleanGithubToken, isHeaderSafeSecret } from './providers.js';

/** A base64 cipher whose decoded bytes start with the MS1 marker, so the store
    routes it through safeStorage.decryptString (→ `decrypted.value`). */
const MS1_CIPHER = Buffer.concat([Buffer.from('MS1'), Buffer.from('x'.repeat(28))]).toString('base64');
/** The deterministic legacy v10 KAT vector (see legacy-safe-storage.test.ts):
    pw="peanuts" → "fal-abcdef0123456789abcdef01234567". */
const V10_KAT_B64 = 'djEwoz83pTbeWGHYNJEVdRUEGuxeitQe6xAO1t436amA4qkMP7RAdfOXabhNEi/vomhD';
const V10_KAT_PLAINTEXT = 'fal-abcdef0123456789abcdef01234567';

describe('isHeaderSafeSecret — the shared ByteString guard (all code units <= 0xFF)', () => {
  test('accepts printable ASCII API keys', () => {
    expect(isHeaderSafeSecret('fal_' + 'a1B2'.repeat(8))).toBe(true);
  });
  test('accepts Latin-1 up to 0xFF, rejects anything above (U+FFFD, U+0100…)', () => {
    expect(isHeaderSafeSecret('keyÿ')).toBe(true);   // 0xFF — a valid ByteString unit
    expect(isHeaderSafeSecret('key�')).toBe(false);  // U+FFFD 65533 — the crash source
    expect(isHeaderSafeSecret('kĀey')).toBe(false);  // U+0100 256 > 255
  });
  test('rejects empty / nullish', () => {
    expect(isHeaderSafeSecret('')).toBe(false);
    expect(isHeaderSafeSecret(undefined)).toBe(false);
    expect(isHeaderSafeSecret(null)).toBe(false);
  });
  test('rejects NUL / CR / LF (undici throws a DIFFERENT native "Invalid header value" TypeError for these)', () => {
    expect(isHeaderSafeSecret('fal_key\nmore')).toBe(false); // interior LF
    expect(isHeaderSafeSecret('fal_key\rmore')).toBe(false); // interior CR
    expect(isHeaderSafeSecret('fal_key\x00more')).toBe(false); // interior NUL
    expect(isHeaderSafeSecret('fal_key\ttab')).toBe(true);   // TAB is a legal header-value byte
  });
});

describe('credential boundary protects EVERY provider (fal/anthropic/openai), not just github', () => {
  // A present cipher is an MS1 blob → routed through safeStorage.decryptString.
  const mkStore = (cipher?: string) => ({
    getProviderKeyCipher: (_p: string) => cipher,
    providerKeyMeta: (_p: string) => (cipher ? { last4: 'abcd', createdAt: 1 } : undefined),
    setProviderKey: () => {},
    deleteProviderKey: () => {},
  });
  beforeEach(() => { decrypted.value = ''; cli.token = null; legacyPw.value = undefined; encryptAvailable.value = true; });

  test('getLocalKey(fal): a mojibake (U+FFFD) MS1 decrypt is REJECTED → undefined (never reaches a header)', () => {
    decrypted.value = 'fal�badkey';
    expect(new Providers(mkStore(MS1_CIPHER) as never).getLocalKey('fal')).toBeUndefined();
  });
  test('getLocalKey(fal): a clean ASCII key round-trips unchanged', () => {
    decrypted.value = 'fal_' + 'a'.repeat(40);
    expect(new Providers(mkStore(MS1_CIPHER) as never).getLocalKey('fal')).toBe(decrypted.value);
  });
  test('getRawKey: a mojibake secret is rejected → undefined', () => {
    decrypted.value = 'x�y';
    expect(new Providers(mkStore(MS1_CIPHER) as never).getRawKey('telegram')).toBeUndefined();
  });
  test('keyState(fal): ok / missing / corrupt are distinguishable', () => {
    decrypted.value = 'fal_' + 'a'.repeat(40);
    expect(new Providers(mkStore(MS1_CIPHER) as never).keyState('fal')).toBe('ok');
    expect(new Providers(mkStore(undefined) as never).keyState('fal')).toBe('missing');
    decrypted.value = 'fal�bad';
    expect(new Providers(mkStore(MS1_CIPHER) as never).keyState('fal')).toBe('corrupt');
  });
  test('list(): a CORRUPT stored fal key is shown RECONNECT — present but NOT connected', () => {
    decrypted.value = 'fal�bad';
    const row = new Providers(mkStore(MS1_CIPHER) as never).list().find(c => c.provider === 'fal');
    expect(row).toBeDefined();
    expect(row?.status).toBe('reconnect');
    expect(row?.detail ?? '').not.toContain('fal�bad'); // never leaks the secret
  });
  test('list(): a CLEAN stored fal key IS reported connected', () => {
    decrypted.value = 'fal_' + 'a'.repeat(40);
    const row = new Providers(mkStore(MS1_CIPHER) as never).list().find(c => c.provider === 'fal');
    expect(row?.status).toBe('connected');
  });
  test('list(): an UNMARKED plaintext row is NOT trusted → reconnect (security wins)', () => {
    const plaintextCipher = Buffer.from('fal_' + 'a'.repeat(40)).toString('base64'); // no MS1/v10 marker
    const row = new Providers(mkStore(plaintextCipher) as never).list().find(c => c.provider === 'fal');
    expect(row?.status).toBe('reconnect');
  });
});

describe('connect() enforces the STRICT printable-ASCII credential policy', () => {
  const recordingStore = () => {
    const stored: string[][] = [];
    return {
      store: { setProviderKey: (p: string, c: string, l: string) => stored.push([p, c, l]), providerKeyMeta: () => ({ last4: 'xxxx', createdAt: 1 }), getProviderKeyCipher: () => undefined, deleteProviderKey: () => {} },
      stored,
    };
  };
  beforeEach(() => { encryptAvailable.value = true; });

  test('rejects U+FFFD / extended Latin-1 (ÿ) / TAB / interior space / DEL / control / non-ASCII BEFORE validate+store', async () => {
    for (const bad of ['fal_�badkey', 'fal_keyÿ', 'fal_key\tx', 'fal_key with space', 'fal_key\x7f', 'fal_key\x01', 'fal_héllo']) {
      const { store, stored } = recordingStore();
      await expect(new Providers(store as never).connect('fal', bad)).rejects.toThrow(/invalid character/i);
      expect(stored).toHaveLength(0); // never validated, never stored
    }
  });

  test('trims OUTER BOM + whitespace on a valid ASCII key and stores it (interior never mutated)', async () => {
    const { store, stored } = recordingStore();
    const p = new Providers(store as never);
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200 } as Response);
    try {
      await p.connect('fal', '﻿  fal_cleankey_ABC123  \n');
      expect(stored).toHaveLength(1);
      // stored under the strict, outer-trimmed key → last4 from 'ABC123'
      expect(stored[0][2]).toBe('C123');
      // and the persisted cipher is the MS1 envelope, never plaintext
      expect(Buffer.from(stored[0][1], 'base64').subarray(0, 3).toString('latin1')).toBe('MS1');
    } finally { (globalThis as { fetch: unknown }).fetch = orig; }
  });
});

describe('legacy Electron v10 → MS1 migration (lazy, one row, fail-closed)', () => {
  // last4 mirrors how a REAL row is stored: derived from the plaintext key at
  // save time (NOT from the cipher bytes). Defaults to the KAT plaintext's last4.
  const migStore = (initialCipher: string, initialLast4: string = V10_KAT_PLAINTEXT.slice(-4)) => {
    let cipher = initialCipher;
    let last4 = initialLast4;
    const sets: Array<[string, string, string]> = [];
    return {
      getProviderKeyCipher: (_p: string) => cipher || undefined,
      providerKeyMeta: (_p: string) => (cipher ? { last4, createdAt: 1 } : undefined),
      setProviderKey: (p: string, c: string, l: string) => { cipher = c; last4 = l; sets.push([p, c, l]); },
      deleteProviderKey: () => { cipher = ''; },
      _sets: () => sets,
    };
  };
  beforeEach(() => { decrypted.value = ''; cli.token = null; legacyPw.value = undefined; encryptAvailable.value = true; });

  test('correct master password: decrypts the real v10 blob, returns the key, re-encrypts ONE row as MS1', () => {
    legacyPw.value = 'peanuts';
    const store = migStore(V10_KAT_B64);
    const key = new Providers(store as never).getLocalKey('fal');
    expect(key).toBe(V10_KAT_PLAINTEXT);
    const sets = store._sets();
    expect(sets).toHaveLength(1);                                   // exactly one row rewritten
    expect(sets[0][0]).toBe('fal');
    expect(sets[0][2]).toBe(V10_KAT_PLAINTEXT.slice(-4));           // last4 preserved from the real key
    expect(Buffer.from(sets[0][1], 'base64').subarray(0, 3).toString('latin1')).toBe('MS1'); // now MS1, not v10/plaintext
  });

  test('reports the migrated key WITHOUT ever logging/returning the plaintext in metadata', () => {
    legacyPw.value = 'peanuts';
    const store = migStore(V10_KAT_B64);
    const conns = new Providers(store as never).list();
    const fal = conns.find(c => c.provider === 'fal');
    expect(fal?.status).toBe('connected');
    expect(JSON.stringify(conns)).not.toContain(V10_KAT_PLAINTEXT); // last4 only, never the secret
  });

  test('wrong master password: fails CLOSED → reconnect, original ciphertext left UNTOUCHED', () => {
    legacyPw.value = 'not-the-password';
    const store = migStore(V10_KAT_B64);
    const p = new Providers(store as never);
    expect(p.getLocalKey('fal')).toBeUndefined();
    expect(store._sets()).toHaveLength(0);            // never rewrote the row
    expect(p.providerState('fal')).toBe('reconnect');
  });

  test('legacy password absent: reconnect (no crash, nothing stored)', () => {
    legacyPw.value = undefined;
    const store = migStore(V10_KAT_B64);
    const p = new Providers(store as never);
    expect(p.getLocalKey('fal')).toBeUndefined();
    expect(store._sets()).toHaveLength(0);
    expect(p.keyState('fal')).toBe('corrupt');
  });

  test('decrypted plaintext must MATCH the stored last4 — v10 has no auth tag, so a mismatch fails CLOSED', () => {
    // Even with the "correct" password producing valid-padding printable bytes,
    // if the plaintext's last4 does not match the recorded metadata (as a
    // tampered/wrong-password decrypt would), refuse to migrate/serve it.
    legacyPw.value = 'peanuts';
    const store = migStore(V10_KAT_B64, 'ZZZZ'); // stored last4 deliberately != '4567'
    const p = new Providers(store as never);
    expect(p.getLocalKey('fal')).toBeUndefined();
    expect(store._sets()).toHaveLength(0);
    expect(p.providerState('fal')).toBe('reconnect');
  });

  test('encryption unavailable: still USABLE this run but not persisted (no reversible fallback written)', () => {
    legacyPw.value = 'peanuts';
    encryptAvailable.value = false;
    const store = migStore(V10_KAT_B64);
    const key = new Providers(store as never).getLocalKey('fal');
    expect(key).toBe(V10_KAT_PLAINTEXT);      // decrypts + serves in-memory
    expect(store._sets()).toHaveLength(0);    // but writes NO plaintext/v10 back
  });
});

describe('isCleanGithubToken', () => {
  test('accepts real GitHub token shapes', () => {
    expect(isCleanGithubToken('gho_' + 'a'.repeat(36))).toBe(true);
    expect(isCleanGithubToken('github_pat_' + 'A1b2'.repeat(10))).toBe(true);
  });
  test('rejects empty / short / nullish', () => {
    expect(isCleanGithubToken(undefined)).toBe(false);
    expect(isCleanGithubToken(null)).toBe(false);
    expect(isCleanGithubToken('short')).toBe(false);
  });
  test('rejects mojibake with the U+FFFD replacement char', () => {
    expect(isCleanGithubToken('gho_�bad�tokenxxxxxxxxxxxxx')).toBe(false);
  });
  test('rejects any non-ASCII / control chars', () => {
    expect(isCleanGithubToken('gho_héllotokenxxxxxxxxxxxxxxx')).toBe(false);
    expect(isCleanGithubToken('gho_bad\ttoken\nxxxxxxxxxxxxxxx')).toBe(false);
  });
});

describe('getLocalKey(github) is entirely gh-CLI based', () => {
  let deleted: string[] = [];
  // `hasCipher` toggles whether a legacy Keychain entry is still on disk.
  const fakeStore = (hasCipher: boolean) => ({
    getProviderKeyCipher: (_p: string) => (hasCipher ? 'cipher-b64' : undefined),
    deleteProviderKey: (p: string) => { deleted.push(p); },
  });
  beforeEach(() => { deleted = []; cli.token = null; decrypted.value = ''; });

  test('borrows the gh CLI token and purges any legacy cipher', () => {
    cli.token = 'gho_' + 'z'.repeat(36);
    const p = new Providers(fakeStore(true) as never);
    expect(p.getLocalKey('github')).toBe(cli.token);
    expect(deleted).toContain('github');
  });

  test('a stored cipher is NEVER decrypted/trusted — gh CLI always wins', () => {
    // Even a clean-looking stored token must be ignored: the Keychain path is
    // the exact wrong-signature-mojibake source we removed for GitHub.
    decrypted.value = 'gho_' + 'y'.repeat(36);
    cli.token = 'gho_' + 'z'.repeat(36);
    const p = new Providers(fakeStore(true) as never);
    expect(p.getLocalKey('github')).toBe(cli.token);
    expect(deleted).toContain('github');
  });

  test('no cipher on disk → returns the gh token, deletes nothing', () => {
    cli.token = 'gho_' + 'z'.repeat(36);
    const p = new Providers(fakeStore(false) as never);
    expect(p.getLocalKey('github')).toBe(cli.token);
    expect(deleted).toHaveLength(0);
  });

  test('gh CLI not authenticated → undefined (never a stored token)', () => {
    decrypted.value = 'gho_' + 'y'.repeat(36); // present but must be ignored
    cli.token = null;
    const p = new Providers(fakeStore(true) as never);
    expect(p.getLocalKey('github')).toBeUndefined();
  });
});
