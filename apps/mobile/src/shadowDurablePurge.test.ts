/**
 * Phase 3B0 NOTE-1 — durable purge primitives. Proves that the reset/teardown
 * contract actually ERASES prior-account state at rest, not just in memory:
 *
 *   - `ExpoSQLiteShadowStore.reset()` deletes every decrypted host-entity row AND
 *     scrubs the plaintext from the file (VACUUM), so a reopen finds exact absence
 *     and the raw file no longer contains the secret.
 *   - `ShadowMobileEnrollmentRuntime.purgeDurable()` deletes the SecureStore scope
 *     key AND clears the persisted grant metadata, is idempotent, and fails closed
 *     (rejects) if the durable clear throws — so the caller blocks reactivation.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import { ExpoSQLiteShadowStore } from './shadowClient';
import { ShadowMobileEnrollmentRuntime, type SecureStoreAdapter, type EnrollmentMetaStore, type StoredGrantMeta } from './shadowEnrollmentClient';

// ── Minimal real node:sqlite adapter (mirrors shadowClient.test.ts) ──
type RawDb = { exec(sql: string): void; close(): void; prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): unknown; get(...p: unknown[]): Record<string, unknown> | undefined } };
class RealSQLiteDatabase {
  constructor(private readonly db: RawDb) {}
  async execAsync(sql: string) { this.db.exec(sql); }
  async runAsync(sql: string, ...p: unknown[]) { this.db.prepare(sql).run(...p); }
  async getAllAsync<T = Record<string, unknown>>(sql: string, ...p: unknown[]) { return this.db.prepare(sql).all(...p) as T[]; }
  async withTransactionAsync<T>(t: () => Promise<T>) { return this.withExclusiveTransactionAsync(t); }
  async withExclusiveTransactionAsync<T>(t: () => Promise<T>) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = await t(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
async function openRealSQLite(path: string): Promise<{ db: RealSQLiteDatabase; raw: RawDb }> {
  const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync?: new (p: string) => RawDb };
  if (!sqlite.DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new sqlite.DatabaseSync(path);
  return { db: new RealSQLiteDatabase(raw), raw };
}

const fence = { accountId: 'acct_p', scopeId: 'scope_p', hostDeviceId: 'host_p', epoch: 1, leaseId: 'lease_p' };
const expectedAuthority = { fence, controllerDeviceId: 'ctrl_p', leaseExpiresAt: 2_000_000_000_000 };
const SECRET = 'TOP-SECRET-PRIOR-ACCOUNT-CONTENT';

/** Scan the DB file and every journal sidecar for a canary. */
function scanAllFilesFor(path: string, needle: Buffer): { file: string; hit: boolean }[] {
  return ['', '-wal', '-shm', '-journal'].map((suffix) => {
    const p = `${path}${suffix}`;
    if (!existsSync(p)) return { file: p, hit: false };
    return { file: p, hit: readFileSync(p).includes(needle) };
  });
}

describe('NOTE-1 — ExpoSQLiteShadowStore.reset durably erases the decrypted cache', () => {
  it('deletes entity rows and scrubs the plaintext from the file; a reopen finds exact absence', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shadow-purge-')), 'maestro-shadow.db');
    const { db, raw } = await openRealSQLite(path);
    const store = new ExpoSQLiteShadowStore(db as never, 'ctrl_p', 'host_p', expectedAuthority);
    await store.reset(); // materializes the schema

    // Write a sensitive DECRYPTED entity (the exact at-rest exposure NOTE-1 flags).
    raw.prepare('INSERT INTO shadow_entities(collection,entity_id,revision,updated_at,deleted,payload_digest,data_json) VALUES(?,?,?,?,?,?,?)')
      .run('project', 'p1', 1, 1, 0, 'sha256:x', JSON.stringify({ secret: SECRET }));
    expect((raw.prepare('SELECT COUNT(*) c FROM shadow_entities').get() as { c: number }).c).toBe(1);
    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(true);

    await store.reset();

    expect((raw.prepare('SELECT COUNT(*) c FROM shadow_entities').get() as { c: number }).c).toBe(0);
    // VACUUM rebuilt the file → the freed-page plaintext is gone from the raw bytes.
    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false);
    raw.close();

    // Reopen a fresh store on the same file → exact absence after a "crash/restart".
    const { db: db2 } = await openRealSQLite(path);
    const store2 = new ExpoSQLiteShadowStore(db2 as never, 'ctrl_p', 'host_p', expectedAuthority);
    const state = await store2.load();
    expect(state.entities.length).toBe(0);
  });

  it('O-2: leaves NO canary in main or any -wal/-shm/-journal sidecar, even in WAL mode while OPEN', async () => {
    for (const mode of ['WAL', 'DELETE'] as const) {
      const path = join(mkdtempSync(join(tmpdir(), `shadow-${mode.toLowerCase()}-`)), 'maestro-shadow.db');
      const { db, raw } = await openRealSQLite(path);
      const store = new ExpoSQLiteShadowStore(db as never, 'ctrl_p', 'host_p', expectedAuthority);
      await store.reset();
      raw.exec(`PRAGMA journal_mode=${mode}`);
      const canary = Buffer.from(`${mode}-CANARY-${'X'.repeat(400)}`); // padded high-entropy-ish
      // Write the canary + padding rows to force multiple pages / a populated WAL.
      for (let i = 0; i < 200; i++) {
        raw.prepare('INSERT INTO shadow_entities(collection,entity_id,revision,updated_at,deleted,payload_digest,data_json) VALUES(?,?,?,?,?,?,?)')
          .run('project', `p${i}`, 1, 1, 0, 'sha256:x', canary.toString('utf8'));
      }
      expect(scanAllFilesFor(path, canary).some((f) => f.hit), `${mode} pre-reset should contain canary`).toBe(true);

      await store.reset(); // production reset while the store/connection stays OPEN

      // Zero canary in main AND every sidecar, WHILE STILL OPEN.
      const scan = scanAllFilesFor(path, canary);
      expect(scan.filter((f) => f.hit).map((f) => f.file), `${mode} residue`).toEqual([]);
      expect((raw.prepare('SELECT COUNT(*) c FROM shadow_entities').get() as { c: number }).c).toBe(0);
      raw.close();
      // And after close/reopen.
      expect(scanAllFilesFor(path, canary).some((f) => f.hit), `${mode} post-close residue`).toBe(false);
    }
  });

  it('is safe/idempotent on an empty (partially-initialized) DB', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shadow-purge2-')), 'maestro-shadow.db');
    const { db } = await openRealSQLite(path);
    const store = new ExpoSQLiteShadowStore(db as never, 'ctrl_p', 'host_p', expectedAuthority);
    await store.reset();
    await store.reset(); // duplicate reset is a cheap no-op, never throws
    const state = await store.load();
    expect(state.entities.length).toBe(0);
  });
});

// ── purgeDurable() — SecureStore scope key + grant meta ──
class MemSecureStore implements SecureStoreAdapter {
  readonly m = new Map<string, string>();
  async getItemAsync(k: string) { return this.m.get(k) ?? null; }
  async setItemAsync(k: string, v: string) { this.m.set(k, v); }
  async deleteItemAsync(k: string) { this.m.delete(k); }
}
class MemMeta implements EnrollmentMetaStore {
  g: StoredGrantMeta | null = null;
  clearThrows = false;
  async loadGrant() { return this.g; }
  async saveGrant(m: StoredGrantMeta) { this.g = m; }
  async clearGrant() { if (this.clearThrows) throw new Error('meta clear failed'); this.g = null; }
}

const grantMeta: StoredGrantMeta = {
  grantId: 'grant_p', controllerDeviceId: 'ctrl_p', scopeKeyId: 'wk_p', status: 'active',
  fence, leaseExpiresAt: 2_000_000_000_000, hostSigningPublicKey: 'aa', hostSigningKeyId: 'hk',
} as unknown as StoredGrantMeta;

function scopeKey(m: StoredGrantMeta): string { return `maestro.shadow.scopeKey.${m.controllerDeviceId}.${m.fence.scopeId}`; }

function seededRuntime() {
  const secureStore = new MemSecureStore();
  const metaStore = new MemMeta();
  metaStore.g = grantMeta;
  secureStore.m.set(scopeKey(grantMeta), 'c2NvcGVfa2V5'); // base64url scope key bytes
  const rt = new ShadowMobileEnrollmentRuntime({
    backend, secureStore, metaStore,
    session: { get: async () => ({ accountId: 'acct_p', controllerDeviceId: 'ctrl_p', sessionToken: 't', relayOrigin: 'https://relay.test' }) },
    transport: { fetch: (async () => ({ status: 404, ok: false, text: async () => '{}' })) as never },
    allowedOrigins: ['https://relay.test'], now: () => 1_700_000_000_000,
  });
  return { rt, secureStore, metaStore };
}

describe('NOTE-1 — runtime.purgeDurable erases the SecureStore scope key + grant meta', () => {
  it('deletes the scope key and clears the persisted grant (exact absence)', async () => {
    const { rt, secureStore, metaStore } = seededRuntime();
    expect(secureStore.m.has(scopeKey(grantMeta))).toBe(true);
    expect(await metaStore.loadGrant()).not.toBeNull();

    await rt.purgeDurable();

    expect(secureStore.m.has(scopeKey(grantMeta))).toBe(false);
    expect(await metaStore.loadGrant()).toBeNull();
    // A restore after the purge finds NOTHING to rehydrate (stays idle, no scope key).
    const status = await rt.restore();
    expect(status.state).toBe('idle');
    expect(status.scopeKeyId).toBeNull();
  });

  it('is idempotent — a second purge is a clean no-op', async () => {
    const { rt, secureStore, metaStore } = seededRuntime();
    await rt.purgeDurable();
    await expect(rt.purgeDurable()).resolves.toBeUndefined();
    expect(secureStore.m.size).toBe(0);
    expect(await metaStore.loadGrant()).toBeNull();
  });

  it('fails closed — a grant-clear failure rejects so the caller blocks reactivation', async () => {
    const { rt, metaStore } = seededRuntime();
    metaStore.clearThrows = true;
    await expect(rt.purgeDurable()).rejects.toThrow(/meta clear failed/);
  });
});
