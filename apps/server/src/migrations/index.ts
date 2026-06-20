import type { Kysely } from 'kysely';
import * as m0001 from './0001_devices.js';

/** A migration applied idempotently on boot (see db.runMigrations). */
export interface Migration {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (db: Kysely<any>) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down?: (db: Kysely<any>) => Promise<void>;
}

/** Name→migration map (names sort lexicographically). */
export const migrations: Record<string, Migration> = {
  '0001_devices': m0001,
};
