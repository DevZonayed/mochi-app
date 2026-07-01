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

describe('getLocalKey(github) self-heals a corrupt Keychain entry', () => {
  let deleted: string[] = [];
  const fakeStore = () => ({
    getProviderKeyCipher: (_p: string) => 'cipher-b64',
    deleteProviderKey: (p: string) => { deleted.push(p); },
  });
  beforeEach(() => { deleted = []; cli.token = null; decrypted.value = ''; });

  test('mojibake decrypt is discarded, cipher deleted, gh CLI token used', () => {
    decrypted.value = 'gho_���garbage�xxxxxxxxxx';
    cli.token = 'gho_' + 'z'.repeat(36);
    const p = new Providers(fakeStore() as never);
    expect(p.getLocalKey('github')).toBe(cli.token);
    expect(deleted).toContain('github');
  });

  test('clean decrypt is returned as-is (no delete, no CLI needed)', () => {
    decrypted.value = 'gho_' + 'y'.repeat(36);
    cli.token = 'gho_should_not_be_used_xxxxxxxxxxxxxx';
    const p = new Providers(fakeStore() as never);
    expect(p.getLocalKey('github')).toBe('gho_' + 'y'.repeat(36));
    expect(deleted).toHaveLength(0);
  });

  test('corrupt cipher AND no gh CLI token → undefined (not the garbage)', () => {
    decrypted.value = '���������������������';
    cli.token = null;
    const p = new Providers(fakeStore() as never);
    expect(p.getLocalKey('github')).toBeUndefined();
  });
});
