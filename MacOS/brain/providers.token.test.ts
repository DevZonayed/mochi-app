import { describe, test, expect, vi, beforeEach } from 'vitest';

/* Electron's safeStorage is faked so we can drive the "decrypt succeeds but
   returns mojibake" path that a wrong-signature Keychain entry produces. */
const decrypted = { value: '' };
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: () => decrypted.value,
    encryptString: (s: string) => Buffer.from(s),
  },
}));

/* github-auth's gh CLI fallback is faked so we control the clean token that
   should win once the corrupt cipher is rejected. */
const cli = { token: null as string | null };
vi.mock('./github-auth.js', () => ({
  ghCliToken: () => cli.token,
  ghLoggedIn: () => cli.token != null,
}));

import { Providers, isCleanGithubToken } from './providers.js';

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
