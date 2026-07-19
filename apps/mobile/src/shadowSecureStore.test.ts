/**
 * ExpoSecureStoreAdapter tests. The ONLY thing mocked is the `expo-secure-store`
 * native module; the adapter logic (key mapping, options, size cap, fail-closed)
 * is real. Plus a static-source proof that it imports `expo-secure-store` with the
 * device-only accessibility option and has NO AsyncStorage path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const calls: Array<{ op: string; key: string; value?: string; options?: unknown }> = [];
const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: vi.fn(async (key: string, options?: unknown) => { calls.push({ op: 'get', key, options }); return store.get(key) ?? null; }),
  setItemAsync: vi.fn(async (key: string, value: string, options?: unknown) => { calls.push({ op: 'set', key, value, options }); store.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string, options?: unknown) => { calls.push({ op: 'delete', key, options }); store.delete(key); }),
}));

const { ExpoSecureStoreAdapter, __physicalKeyForTest } = await import('./shadowSecureStore');

beforeEach(() => { calls.length = 0; store.clear(); });

describe('ExpoSecureStoreAdapter', () => {
  it('round-trips and always passes the device-only accessibility option', async () => {
    const a = new ExpoSecureStoreAdapter();
    await a.setItemAsync('maestro.shadow.scopeKey.dev-1.account:acc', 'value-1');
    expect(await a.getItemAsync('maestro.shadow.scopeKey.dev-1.account:acc')).toBe('value-1');
    for (const c of calls) {
      expect((c.options as { keychainAccessible?: string })?.keychainAccessible).toBe('afterFirstUnlockThisDeviceOnly');
    }
  });

  it('maps disallowed key characters (":") to a SecureStore-legal physical key', () => {
    const phys = __physicalKeyForTest('maestro.shadow.scopeKey.dev-1.account:acc');
    expect(phys).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(phys).not.toContain(':');
    // Deterministic + distinct per logical key.
    expect(__physicalKeyForTest('a')).not.toBe(__physicalKeyForTest('b'));
    expect(__physicalKeyForTest('same')).toBe(__physicalKeyForTest('same'));
  });

  it('caps value size (fails closed)', async () => {
    const a = new ExpoSecureStoreAdapter();
    await expect(a.setItemAsync('k', 'x'.repeat(2049))).rejects.toThrow(/bytes/);
  });

  it('propagates native errors (no silent fallback)', async () => {
    const mod = await import('expo-secure-store');
    (mod.getItemAsync as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error('keychain error'));
    const a = new ExpoSecureStoreAdapter();
    await expect(a.getItemAsync('k')).rejects.toThrow(/keychain error/);
  });

  it('deletes only the given key', async () => {
    const a = new ExpoSecureStoreAdapter();
    await a.setItemAsync('k1', 'v1');
    await a.setItemAsync('k2', 'v2');
    await a.deleteItemAsync('k1');
    expect(await a.getItemAsync('k1')).toBeNull();
    expect(await a.getItemAsync('k2')).toBe('v2');
  });
});

describe('ExpoSecureStoreAdapter source contract', () => {
  it('imports expo-secure-store with device-only accessibility and never uses AsyncStorage', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'shadowSecureStore.ts'), 'utf8');
    expect(src).toContain("from 'expo-secure-store'");
    expect(src).toContain('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
    // No AsyncStorage IMPORT (the word may appear in the fail-closed comment).
    expect(src).not.toMatch(/from ['"]@react-native-async-storage/);
    expect(src).not.toMatch(/require\(['"]@react-native-async-storage/);
  });
});
