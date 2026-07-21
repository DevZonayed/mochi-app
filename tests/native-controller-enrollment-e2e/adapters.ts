/**
 * In-memory TEST adapters for the cross-tier enrollment E2E. Real AES-256-GCM
 * vault semantics (fail-closed when "locked"), plus durable-simulating
 * persistence / SecureStore / meta stores. No production secret ever lands in
 * plaintext: the vault encrypts, SecureStore holds only what the runtime puts
 * there, and the DB no-plaintext scan is asserted by the test itself.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { SecureVault, HostEnrollmentPersistence, HostEnrollmentRecord } from '../../MacOS/brain/shadow-enrollment-host.ts';
import type { SecureStoreAdapter, EnrollmentMetaStore, StoredGrantMeta } from '../../apps/mobile/src/shadowEnrollmentClient.ts';

/** Real AES-256-GCM in-memory vault mirroring the safeStorage MS1 boundary. */
export class TestVault implements SecureVault {
  available = true;
  private readonly key = randomBytes(32);
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plaintext: string): Uint8Array {
    if (!this.available) throw new Error('vault locked');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return new Uint8Array(Buffer.concat([iv, tag, ct]));
  }
  decryptString(ciphertext: Uint8Array): string {
    if (!this.available) throw new Error('vault locked');
    const buf = Buffer.from(ciphertext);
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
}

/** Durable-simulating host persistence (deep-cloned like a JSON file/Store). */
export class TestHostPersistence implements HostEnrollmentPersistence {
  raw: string | null = null;
  load(): HostEnrollmentRecord | null {
    return this.raw ? (JSON.parse(this.raw) as HostEnrollmentRecord) : null;
  }
  save(record: HostEnrollmentRecord): void {
    this.raw = JSON.stringify(record);
  }
}

export class TestSecureStore implements SecureStoreAdapter {
  readonly m = new Map<string, string>();
  async getItemAsync(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async setItemAsync(key: string, value: string): Promise<void> {
    this.m.set(key, value);
  }
  async deleteItemAsync(key: string): Promise<void> {
    this.m.delete(key);
  }
}

export class TestMetaStore implements EnrollmentMetaStore {
  raw: string | null = null;
  async loadGrant(): Promise<StoredGrantMeta | null> {
    return this.raw ? (JSON.parse(this.raw) as StoredGrantMeta) : null;
  }
  async saveGrant(meta: StoredGrantMeta): Promise<void> {
    this.raw = JSON.stringify(meta);
  }
  async clearGrant(): Promise<void> {
    this.raw = null;
  }
}

/** node:sqlite adapter implementing the ExpoSQLiteShadowStore SQLiteDatabase seam. */
export type NodeSqliteDatabaseSync = {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown };
};

export class RealSQLiteDatabase {
  constructor(private readonly db: NodeSqliteDatabaseSync) {}
  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  async runAsync(sql: string, ...params: unknown[]): Promise<void> {
    this.db.prepare(sql).run(...params);
  }
  async getAllAsync<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }
  async withTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
    return this.withExclusiveTransactionAsync(task);
  }
  async withExclusiveTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await task();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export async function openRealSQLite(path: string): Promise<{ db: RealSQLiteDatabase; raw: NodeSqliteDatabaseSync }> {
  const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync?: new (path: string) => NodeSqliteDatabaseSync };
  if (!sqlite.DatabaseSync) throw new Error('node:sqlite DatabaseSync unavailable');
  const raw = new sqlite.DatabaseSync(path);
  return { db: new RealSQLiteDatabase(raw), raw };
}
