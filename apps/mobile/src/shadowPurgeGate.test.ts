/**
 * Phase 3B0 O-1 — durable fail-closed purge gate + aggregate stage orchestration.
 * Proves the reset contract can NEVER be mistaken for "clear" on a failure path:
 * the tombstone is established first, every destructive stage is attempted, and it
 * is cleared only after all stages succeed + verification reads empty — with retry
 * and identity/generation (token) fencing.
 */
import { describe, it, expect } from 'vitest';
import type { SecureStoreAdapter } from './shadowEnrollmentClient';
import {
  ShadowPurgeGate,
  runShadowPurgeStages,
  ShadowPurgeIncompleteError,
  SHADOW_PURGE_TOMBSTONE_KEY,
  type ShadowPurgeStages,
} from './shadowPurgeGate';

class MemSecureStore implements SecureStoreAdapter {
  readonly m = new Map<string, string>();
  failGet = false; failSet = false; failDelete = false;
  async getItemAsync(k: string) { if (this.failGet) throw new Error('keychain read fault'); return this.m.get(k) ?? null; }
  async setItemAsync(k: string, v: string) { if (this.failSet) throw new Error('keychain write fault'); this.m.set(k, v); }
  async deleteItemAsync(k: string) { if (this.failDelete) throw new Error('keychain delete fault'); this.m.delete(k); }
}

/** A fake purge target with per-stage injectable failures + a mutable "empty" state. */
function fakeStages(over: Partial<ShadowPurgeStages> & { keyDeleted?: string[]; grantCleared?: { v: boolean }; cacheReset?: { v: boolean } } = {}): ShadowPurgeStages & { deleted: string[]; grantCleared: boolean; cacheReset: boolean } {
  const state = { deleted: [] as string[], grantCleared: false, cacheReset: false };
  return {
    scopeKeyHandles: over.scopeKeyHandles ?? ['maestro.shadow.scopeKey.ctrl.scope'],
    deleteSecureItem: over.deleteSecureItem ?? (async (k) => { state.deleted.push(k); }),
    clearGrant: over.clearGrant ?? (async () => { state.grantCleared = true; }),
    resetCache: over.resetCache ?? (async () => { state.cacheReset = true; }),
    verifyEmpty: over.verifyEmpty ?? (async () => true),
    get deleted() { return state.deleted; },
    get grantCleared() { return state.grantCleared; },
    get cacheReset() { return state.cacheReset; },
  } as ShadowPurgeStages & { deleted: string[]; grantCleared: boolean; cacheReset: boolean };
}

describe('ShadowPurgeGate — durable tombstone', () => {
  it('require writes a durable tombstone; read/isRequired report it; clearIfToken(matching) removes it', async () => {
    const s = new MemSecureStore();
    const g = new ShadowPurgeGate(s);
    await g.require('tok1', ['h1'], 111);
    expect(s.m.has(SHADOW_PURGE_TOMBSTONE_KEY)).toBe(true);
    expect(await g.isRequired()).toBe(true);
    expect((await g.read())?.token).toBe('tok1');
    await g.clearIfToken('tok1');
    expect(await g.isRequired()).toBe(false);
  });

  it('a corrupt tombstone value fails CLOSED (still "purge required", never null)', async () => {
    const s = new MemSecureStore();
    s.m.set(SHADOW_PURGE_TOMBSTONE_KEY, '{not json');
    const g = new ShadowPurgeGate(s);
    expect(await g.isRequired()).toBe(true);
    expect(await g.read()).not.toBeNull();
  });

  it('isRequired fails CLOSED (true) when the keychain read itself throws', async () => {
    const s = new MemSecureStore(); s.failGet = true;
    expect(await new ShadowPurgeGate(s).isRequired()).toBe(true);
  });

  it('a require write failure REJECTS (fail closed — no unmarked destroy)', async () => {
    const s = new MemSecureStore(); s.failSet = true;
    await expect(new ShadowPurgeGate(s).require('t', [], 1)).rejects.toThrow(/write fault/);
  });

  it('clearIfToken(stale token) does NOT clear a newer reset tombstone (identity/generation fence)', async () => {
    const s = new MemSecureStore();
    const g = new ShadowPurgeGate(s);
    await g.require('OLD', ['h'], 1);
    await g.require('NEW', ['h'], 2);          // a newer reset overwrote it
    await g.clearIfToken('OLD');                // stale callback tries to clear
    expect(await g.isRequired()).toBe(true);    // still set — NEW owns it
    expect((await g.read())?.token).toBe('NEW');
    await g.clearIfToken('NEW');
    expect(await g.isRequired()).toBe(false);
  });
});

describe('runShadowPurgeStages — aggregate + fail-closed', () => {
  it('all stages succeed + verify empty → resolves (caller then clears tombstone)', async () => {
    const st = fakeStages();
    await expect(runShadowPurgeStages(st)).resolves.toBeUndefined();
    expect(st.deleted).toEqual(['maestro.shadow.scopeKey.ctrl.scope']);
    expect(st.grantCleared).toBe(true);
    expect(st.cacheReset).toBe(true);
  });

  it('a cache-reset failure REJECTS but authority material is STILL purged (aggregate, not skip-after-first)', async () => {
    const st = fakeStages({ resetCache: async () => { throw new Error('corrupt DB'); } });
    await expect(runShadowPurgeStages(st)).rejects.toBeInstanceOf(ShadowPurgeIncompleteError);
    expect(st.deleted.length).toBe(1);   // scope key erased despite the later cache failure
    expect(st.grantCleared).toBe(true);  // grant cleared despite the later cache failure
  });

  it('a scope-key delete failure REJECTS yet grant + cache stages still run', async () => {
    const st = fakeStages({ deleteSecureItem: async () => { throw new Error('key delete fault'); } });
    await expect(runShadowPurgeStages(st)).rejects.toBeInstanceOf(ShadowPurgeIncompleteError);
    expect(st.grantCleared).toBe(true);
    expect(st.cacheReset).toBe(true);
  });

  it('a non-empty verification REJECTS even when every stage "succeeded"', async () => {
    const st = fakeStages({ verifyEmpty: async () => false });
    await expect(runShadowPurgeStages(st)).rejects.toBeInstanceOf(ShadowPurgeIncompleteError);
  });

  it('collects MULTIPLE stage failures into one error', async () => {
    const st = fakeStages({
      clearGrant: async () => { throw new Error('grant fault'); },
      resetCache: async () => { throw new Error('cache fault'); },
      verifyEmpty: async () => false,
    });
    const err = await runShadowPurgeStages(st).then(() => null, (e: unknown) => e as ShadowPurgeIncompleteError);
    expect(err).toBeInstanceOf(ShadowPurgeIncompleteError);
    if (!err) throw new Error('expected rejection');
    expect(err.reasons.some((r) => r.includes('grant'))).toBe(true);
    expect(err.reasons.some((r) => r.includes('cache'))).toBe(true);
    expect(err.verifiedEmpty).toBe(false);
  });
});

describe('O-1 end-to-end — tombstone survives a failed purge and a retry clears it', () => {
  it('failed reset leaves the tombstone; a later successful retry clears it', async () => {
    const s = new MemSecureStore();
    const gate = new ShadowPurgeGate(s);
    const token = 'reset-1';
    // Reset: mark tombstone, then a purge whose cache-reset fails.
    await gate.require(token, ['h'], 1);
    let cacheHealthy = false;
    const stages = (): ShadowPurgeStages => ({
      scopeKeyHandles: ['h'],
      deleteSecureItem: async () => { /* ok */ },
      clearGrant: async () => { /* ok */ },
      resetCache: async () => { if (!cacheHealthy) throw new Error('DB locked'); },
      verifyEmpty: async () => cacheHealthy,
    });
    // The purge REJECTS → the reset rethrows BEFORE reaching clearIfToken, so the
    // tombstone remains and any later bootstrap is blocked until a retry succeeds.
    await expect(runShadowPurgeStages(stages())).rejects.toBeInstanceOf(ShadowPurgeIncompleteError);
    expect(await gate.isRequired()).toBe(true);
    // A later retry (DB now healthy) completes and clears the tombstone.
    cacheHealthy = true;
    await expect(runShadowPurgeStages(stages())).resolves.toBeUndefined();
    await gate.clearIfToken(token);
    expect(await gate.isRequired()).toBe(false);
  });
});
