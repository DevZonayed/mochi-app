/* Persistent push-token store.
 *
 * Why this exists: the relay used to keep Expo push tokens in an in-memory Map,
 * so every Dokploy redeploy wiped the entire device list. A closed phone (the
 * exact scenario push exists for) never re-registered until the user opened the
 * app, defeating the closed-app notification path.
 *
 * Design: a tiny store with a Postgres-portable surface (`upsert/remove/list/
 * prune/size`) backed by better-sqlite3 today. When we set up the chat+memory
 * Postgres mirror later, this swaps to a `push_tokens` table behind the same
 * interface — call sites in server.ts don't change.
 *
 * Failure mode: the constructor never throws. If the DB path isn't writable we
 * fall back to in-memory and log a warning — push tokens still work in-process,
 * they just don't survive a restart (i.e. the old behaviour, but loud about it).
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PushTokenUpsert {
  deviceId?: string | null;
  deviceName?: string | null;
  now?: number;
}

export interface PushTokenStore {
  upsert(token: string, opts?: PushTokenUpsert): void;
  remove(token: string): void;
  /** Returns every active token. Cheap — push fan-out reads this on every event. */
  list(): string[];
  /** Drop the given tokens (used after Expo reports `DeviceNotRegistered`). */
  prune(tokens: string[]): void;
  size(): number;
  close(): void;
}

interface PushTokenRow { token: string; last_seen: number }

const DEFAULT_DB = process.env.NODE_ENV === 'production'
  ? '/data/maestro-push.sqlite'
  : join(process.cwd(), 'registry', 'maestro-push.sqlite');

export interface CreatePushTokenStoreOptions {
  /** Absolute path; ':memory:' for tests. Defaults to MAESTRO_PUSH_DB env / DEFAULT_DB. */
  dbPath?: string;
  /** Inject a logger; otherwise console.warn. */
  warn?: (msg: string) => void;
}

/* The in-memory fallback. Kept identical-shape so server.ts can't tell the
   difference between persisted and in-process modes. */
function inMemoryStore(): PushTokenStore {
  const map = new Map<string, number>();
  return {
    upsert(token, opts) {
      const t = token.trim();
      if (!t) return;
      map.set(t, opts?.now ?? Date.now());
    },
    remove(token) { map.delete(token.trim()); },
    list() { return [...map.keys()]; },
    prune(tokens) { for (const t of tokens) map.delete(t); },
    size() { return map.size; },
    close() { map.clear(); },
  };
}

export function createPushTokenStore(opts: CreatePushTokenStoreOptions = {}): PushTokenStore {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const dbPath = opts.dbPath ?? process.env.MAESTRO_PUSH_DB ?? DEFAULT_DB;

  let db: DatabaseType;
  try {
    if (dbPath !== ':memory:') {
      try { mkdirSync(dirname(dbPath), { recursive: true }); } catch { /* exists or permission, surfaces below */ }
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        token TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        device_id TEXT,
        device_name TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_push_tokens_last_seen ON push_tokens(last_seen);
    `);
  } catch (e) {
    warn(`[push-store] sqlite unavailable at ${dbPath} (${e instanceof Error ? e.message : e}); using in-memory fallback`);
    return inMemoryStore();
  }

  // Prepared statements (re-used per call — better-sqlite3 is synchronous).
  const upsertStmt = db.prepare(`
    INSERT INTO push_tokens (token, created_at, last_seen, device_id, device_name)
    VALUES (@token, @ts, @ts, @deviceId, @deviceName)
    ON CONFLICT(token) DO UPDATE SET
      last_seen = @ts,
      device_id = COALESCE(@deviceId, push_tokens.device_id),
      device_name = COALESCE(@deviceName, push_tokens.device_name)
  `);
  const removeStmt = db.prepare(`DELETE FROM push_tokens WHERE token = ?`);
  const listStmt = db.prepare<[], PushTokenRow>(`SELECT token, last_seen FROM push_tokens ORDER BY last_seen DESC`);
  const sizeStmt = db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM push_tokens`);
  const pruneStmt = db.transaction((tokens: string[]) => {
    for (const t of tokens) removeStmt.run(t);
  });

  return {
    upsert(token, opts2) {
      const t = token.trim();
      if (!t) return;
      try {
        upsertStmt.run({
          token: t,
          ts: opts2?.now ?? Date.now(),
          deviceId: opts2?.deviceId ?? null,
          deviceName: opts2?.deviceName ?? null,
        });
      } catch (e) {
        warn(`[push-store] upsert failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    remove(token) {
      const t = token.trim();
      if (!t) return;
      try { removeStmt.run(t); } catch (e) { warn(`[push-store] remove failed: ${e instanceof Error ? e.message : e}`); }
    },
    list() {
      try { return listStmt.all().map((r) => r.token); } catch { return []; }
    },
    prune(tokens) {
      if (!tokens.length) return;
      try { pruneStmt(tokens); } catch (e) { warn(`[push-store] prune failed: ${e instanceof Error ? e.message : e}`); }
    },
    size() {
      try { return sizeStmt.get()?.c ?? 0; } catch { return 0; }
    },
    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}
