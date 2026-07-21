/**
 * SQLiteEnrollmentMetaStore tests over the REAL Node 24 node:sqlite adapter
 * (the same seam used for ExpoSQLiteShadowStore). Proves transactional
 * round-trip, restart (close/reopen) persistence, malformed-row → null + typed
 * evidence, public-only enforcement, and clear.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteEnrollmentMetaStore, type SQLiteMetaDatabase } from './shadowEnrollmentMetaStore';
import type { StoredGrantMeta } from './shadowEnrollmentClient';

type NodeSqliteDatabaseSync = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; run(...p: unknown[]): unknown };
};

class NodeSqliteAdapter implements SQLiteMetaDatabase {
  constructor(private readonly db: NodeSqliteDatabaseSync) {}
  async execAsync(sql: string) { this.db.exec(sql); }
  async runAsync(sql: string, ...p: unknown[]) { this.db.prepare(sql).run(...p); }
  async getAllAsync<T = Record<string, unknown>>(sql: string, ...p: unknown[]) { return this.db.prepare(sql).all(...p) as T[]; }
  async withTransactionAsync<T>(task: () => Promise<T>): Promise<T> { return this.withExclusiveTransactionAsync(task); }
  async withExclusiveTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = await task(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

async function open(path: string): Promise<{ adapter: NodeSqliteAdapter; raw: NodeSqliteDatabaseSync }> {
  const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => NodeSqliteDatabaseSync };
  const raw = new sqlite.DatabaseSync(path);
  return { adapter: new NodeSqliteAdapter(raw), raw };
}

const meta: StoredGrantMeta = {
  sessionId: 'es_1', controllerDeviceId: 'dev-1', grantId: 'eg_1', keyId: 'wk_1', scopeKeyId: 'wk_1',
  fence: { accountId: 'acc', scopeId: 'account:acc', hostDeviceId: 'host', epoch: 1, leaseId: 'l' },
  expiresAt: 123, transcriptHash: 'th', hostSigningKeyId: 'sk_host', hostSigningPublicKey: 'aG9zdHB1Yg', leaseExpiresAt: 9_999_999, status: 'active',
};

function dbPath() { return join(mkdtempSync(join(tmpdir(), 'enroll-meta-')), 'meta.sqlite'); }

describe('SQLiteEnrollmentMetaStore', () => {
  it('round-trips a grant and survives close/reopen (restart)', async () => {
    const p = dbPath();
    const a = await open(p);
    const store = new SQLiteEnrollmentMetaStore(a.adapter);
    expect(await store.loadGrant()).toBeNull();
    await store.saveGrant(meta);
    expect(await store.loadGrant()).toEqual(meta);
    a.raw.close();
    // Reopen a fresh adapter over the same file.
    const b = await open(p);
    const store2 = new SQLiteEnrollmentMetaStore(b.adapter);
    expect(await store2.loadGrant()).toEqual(meta);
    b.raw.close();
  });

  it('fails closed on a malformed row and records evidence', async () => {
    const p = dbPath();
    const a = await open(p);
    const store = new SQLiteEnrollmentMetaStore(a.adapter);
    await store.saveGrant(meta); // ensures schema
    // Corrupt the current row directly.
    a.raw.prepare(`UPDATE shadow_enroll_meta SET grant_json = 'not-json' WHERE id = 'current'`).run();
    expect(await store.loadGrant()).toBeNull();
    const evidence = a.raw.prepare(`SELECT reason, detail FROM shadow_enroll_meta_evidence WHERE id = 'current'`).all() as Array<{ reason: string; detail: string }>;
    expect(evidence[0]?.reason).toBe('malformed');
    // The malformed row was removed, so a fresh save works.
    await store.saveGrant(meta);
    expect(await store.loadGrant()).toEqual(meta);
    a.raw.close();
  });

  it('rejects a grant carrying any forbidden secret field (public-only)', async () => {
    const p = dbPath();
    const a = await open(p);
    const store = new SQLiteEnrollmentMetaStore(a.adapter);
    const bad = { ...meta, scopeKey: 'AAAA' } as unknown as StoredGrantMeta;
    await expect(store.saveGrant(bad)).rejects.toThrow(/public-only/);
    a.raw.close();
  });

  it('clears the grant', async () => {
    const p = dbPath();
    const a = await open(p);
    const store = new SQLiteEnrollmentMetaStore(a.adapter);
    await store.saveGrant(meta);
    await store.clearGrant();
    expect(await store.loadGrant()).toBeNull();
    a.raw.close();
  });
});
