import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Mock the native/Expo edges so the PURE factory memoization logic can be exercised in
// node. None of these open a network; the runtime is constructed but not connected.
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n).fill(7) }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: async () => ({ execAsync: async () => {}, getAllAsync: async () => [], runAsync: async () => ({}), getFirstAsync: async () => null }) }));
vi.mock('./shadowSecureStore', () => ({ ExpoSecureStoreAdapter: class { async getItemAsync() { return null; } async setItemAsync() {} async deleteItemAsync() {} } }));
vi.mock('./shadowEnrollmentMetaStore', () => ({ SQLiteEnrollmentMetaStore: class { async loadGrant() { return null; } async saveGrant() {} async clearGrant() {} } }));
vi.mock('./auth', () => ({ API_BASE: 'https://relay.example', getSessionToken: () => 'tok', getDeviceId: () => 'ctrl_1', rotateDeviceId: () => 'ctrl_2' }));

describe('getShadowMobileEnrollmentRuntime (B1-R1) — promise-memoized singleton', () => {
  it('concurrent callers await the SAME in-flight construction and get the identical instance', async () => {
    const mod = await import('./shadowEnrollmentRuntimeFactory');
    // Fire many callers at once BEFORE the first construction resolves.
    const results = await Promise.all(Array.from({ length: 8 }, () => mod.getShadowMobileEnrollmentRuntime()));
    const first = results[0];
    for (const r of results) expect(r).toBe(first); // one instance, shared by all racing callers
    // A later call still returns the same memoized instance.
    expect(await mod.getShadowMobileEnrollmentRuntime()).toBe(first);
  });
});

describe('getShadowMobileEnrollmentRuntime (B1-R1) — source contract', () => {
  it('memoizes the factory PROMISE (not just the resolved value) and clears it on reset', () => {
    const SRC = readFileSync(new URL('./shadowEnrollmentRuntimeFactory.ts', import.meta.url).pathname, 'utf8');
    expect(SRC).toContain('singletonPromise');
    // the memo is cleared on construction error (retryable) and on durable reset
    expect(SRC).toMatch(/singletonPromise\s*=\s*null/);
  });
});
