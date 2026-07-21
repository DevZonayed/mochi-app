/**
 * shadowEnrollmentMetaStore — Phase 3A2a PRODUCTION persistence for the mobile
 * enrollment runtime's PUBLIC grant metadata, backed by Expo SQLite (the same
 * `SQLiteDatabase` structural seam `ExpoSQLiteShadowStore` uses, so it is driven
 * by a Node `node:sqlite` adapter in tests). NO private seed or scope key is ever
 * stored here — those live only in `expo-secure-store`. Writes are transactional
 * and restart-safe; a malformed/oversized row fails closed to `null` with a
 * bounded typed evidence row (never a crash, never a silent bad grant).
 */
import type { EnrollmentMetaStore, StoredGrantMeta } from './shadowEnrollmentClient';

/** The subset of the expo-sqlite database interface this store needs. */
export interface SQLiteMetaDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<unknown>;
  getAllAsync<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  withTransactionAsync<T>(task: () => Promise<T>): Promise<T>;
  withExclusiveTransactionAsync?<T>(task: () => Promise<T>): Promise<T>;
}

const SCHEMA_VERSION = 1;
const MAX_GRANT_JSON_BYTES = 8 * 1024;
/** Fields that must NEVER appear in the public metadata row (defense in depth). */
const FORBIDDEN_KEYS = ['scopeKey', 'privateKey', 'signingSeed', 'agreementSeed', 'secret', 'wrappedScopeKey'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shadow_enroll_meta (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL,
  grant_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shadow_enroll_meta_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL
);`;

function assertPublicOnly(meta: StoredGrantMeta): string {
  const json = JSON.stringify(meta);
  // Match exact JSON property names (`"scopeKey":`) so the public `scopeKeyId`
  // digest is not a false positive for the secret `scopeKey`.
  for (const k of FORBIDDEN_KEYS) {
    if (json.includes(`"${k}":`)) throw new Error(`enrollment meta must be public-only (contains ${k})`);
  }
  if (new TextEncoder().encode(json).length > MAX_GRANT_JSON_BYTES) throw new Error('enrollment meta exceeds size bound');
  return json;
}

export class SQLiteEnrollmentMetaStore implements EnrollmentMetaStore {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: SQLiteMetaDatabase) {}

  private async ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.db.execAsync(SCHEMA);
        await this.db.runAsync(
          `INSERT INTO shadow_enroll_meta_evidence (id, reason, detail) VALUES ('schema', 'version', ?) ` +
          `ON CONFLICT(id) DO UPDATE SET detail = excluded.detail`,
          String(SCHEMA_VERSION),
        );
      })();
    }
    return this.ready;
  }

  async loadGrant(): Promise<StoredGrantMeta | null> {
    await this.ensureSchema();
    const rows = await this.db.getAllAsync<{ grant_json: string }>(`SELECT grant_json FROM shadow_enroll_meta WHERE id = 'current'`);
    if (rows.length === 0) return null;
    const raw = rows[0].grant_json;
    try {
      const parsed = JSON.parse(raw) as StoredGrantMeta;
      if (!parsed || typeof parsed.grantId !== 'string' || typeof parsed.controllerDeviceId !== 'string' || !parsed.fence || typeof parsed.fence.scopeId !== 'string') {
        await this.recordEvidence('malformed', 'shape');
        return null;
      }
      return parsed;
    } catch {
      await this.recordEvidence('malformed', 'json');
      return null;
    }
  }

  async saveGrant(meta: StoredGrantMeta): Promise<void> {
    await this.ensureSchema();
    const json = assertPublicOnly(meta);
    const tx = this.db.withExclusiveTransactionAsync ?? this.db.withTransactionAsync;
    await tx.call(this.db, async () => {
      await this.db.runAsync(
        `INSERT INTO shadow_enroll_meta (id, version, grant_json) VALUES ('current', ?, ?) ` +
        `ON CONFLICT(id) DO UPDATE SET version = excluded.version, grant_json = excluded.grant_json`,
        SCHEMA_VERSION, json,
      );
    });
  }

  async clearGrant(): Promise<void> {
    await this.ensureSchema();
    await this.db.runAsync(`DELETE FROM shadow_enroll_meta WHERE id = 'current'`);
  }

  private async recordEvidence(reason: string, detail: string): Promise<void> {
    try {
      await this.db.runAsync(
        `INSERT INTO shadow_enroll_meta_evidence (id, reason, detail) VALUES ('current', ?, ?) ` +
        `ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail`,
        reason, detail.slice(0, 256),
      );
      // A malformed current row is removed so a fresh grant can be written.
      await this.db.runAsync(`DELETE FROM shadow_enroll_meta WHERE id = 'current'`);
    } catch {
      /* best-effort evidence; never throw from the read path */
    }
  }
}
