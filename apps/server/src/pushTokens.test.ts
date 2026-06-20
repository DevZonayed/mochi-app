import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPushTokenStore, type PushTokenStore } from './pushTokens.js';

describe('PushTokenStore (in-memory)', () => {
  let store: PushTokenStore;
  beforeEach(() => { store = createPushTokenStore({ dbPath: ':memory:' }); });
  afterEach(() => { store.close(); });

  it('upserts a token and lists it', () => {
    store.upsert('ExponentPushToken[aaa]');
    expect(store.list()).toEqual(['ExponentPushToken[aaa]']);
    expect(store.size()).toBe(1);
  });

  it('upsert is idempotent on the same token (no duplicate row)', () => {
    store.upsert('tok-1', { now: 1000 });
    store.upsert('tok-1', { now: 2000 });
    expect(store.size()).toBe(1);
    expect(store.list()).toEqual(['tok-1']);
  });

  it('lists most-recently-seen first (stable ordering for push fan-out)', () => {
    store.upsert('older', { now: 100 });
    store.upsert('newer', { now: 200 });
    expect(store.list()).toEqual(['newer', 'older']);
    store.upsert('older', { now: 300 }); // touch
    expect(store.list()).toEqual(['older', 'newer']);
  });

  it('trims whitespace on upsert and ignores blank tokens', () => {
    store.upsert('  trimmed  ');
    store.upsert('');
    store.upsert('   ');
    expect(store.list()).toEqual(['trimmed']);
    expect(store.size()).toBe(1);
  });

  it('removes a single token', () => {
    store.upsert('keep');
    store.upsert('drop');
    store.remove('drop');
    expect(store.list()).toEqual(['keep']);
  });

  it('prune() drops every supplied token (used after DeviceNotRegistered)', () => {
    store.upsert('a'); store.upsert('b'); store.upsert('c');
    store.prune(['a', 'c']);
    expect(store.list()).toEqual(['b']);
  });

  it('prune([]) is a no-op', () => {
    store.upsert('a');
    store.prune([]);
    expect(store.list()).toEqual(['a']);
  });

  it('upsert with deviceId/deviceName does not break list()', () => {
    store.upsert('tok', { deviceId: 'dev-1', deviceName: 'iPhone 17 Pro' });
    expect(store.list()).toEqual(['tok']);
  });

  it('remove on a missing token is a silent no-op', () => {
    store.remove('never-registered');
    expect(store.size()).toBe(0);
  });
});

describe('PushTokenStore (on-disk persistence)', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maestro-push-test-'));
    dbPath = join(dir, 'push.sqlite');
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('survives a "redeploy" — token added in one process is visible to the next', () => {
    const a = createPushTokenStore({ dbPath });
    a.upsert('persisted-token', { now: 1000 });
    a.close();

    const b = createPushTokenStore({ dbPath });
    expect(b.list()).toEqual(['persisted-token']);
    b.close();
  });

  it('falls back to in-memory + warns when the path is unwritable', () => {
    const warnings: string[] = [];
    const store = createPushTokenStore({ dbPath: '/dev/null/nope/maestro-push.sqlite', warn: (m) => warnings.push(m) });
    expect(warnings.some((w) => w.includes('sqlite unavailable'))).toBe(true);
    // Fallback still functions:
    store.upsert('still-works');
    expect(store.list()).toEqual(['still-works']);
    store.close();
  });
});
