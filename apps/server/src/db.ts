/* PostgreSQL access for the account/device model. Better Auth owns its own
   tables (user/session/account/verification) via its CLI migration; we own the
   `device` table via the Kysely migrator below. */
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { migrations } from './migrations/index.js';

export interface DeviceTable {
  id: string;
  user_id: string;
  role: 'host' | 'remote';
  name: string;
  platform: string;
  deck_id: string | null;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}
export interface DB { device: DeviceTable }

const url =
  process.env.DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5432/maestro';

let pool: Pool | null = null;
let db: Kysely<DB> | null = null;

export function getPool(): Pool {
  return (pool ??= new Pool({ connectionString: url }));
}
export function getDb(): Kysely<DB> {
  return (db ??= new Kysely<DB>({ dialect: new PostgresDialect({ pool: getPool() }) }));
}
/** Apply migrations in name order. Each migration's `up` is idempotent
    (`createTable ... ifNotExists`), so this is safe to run on every boot —
    no separate migration-tracking table needed for our small schema. */
export async function runMigrations(): Promise<void> {
  const db = getDb();
  for (const name of Object.keys(migrations).sort()) {
    await migrations[name].up(db);
  }
}
export async function closeDb(): Promise<void> {
  await db?.destroy();
  db = null;
  pool = null;
}
