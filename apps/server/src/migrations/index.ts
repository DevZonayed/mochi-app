import type { Kysely } from 'kysely';
import * as m0001 from './0001_devices.js';
import * as m0002 from './0002_shadow_relay.js';
import * as m0003 from './0003_shadow_enrollment.js';
import * as m0004 from './0004_shadow_transition.js';
import * as m0005 from './0005_shadow_lease_renewal_receipt.js';
import * as m0006 from './0006_shadow_capabilities.js';

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
  '0002_shadow_relay': m0002,
  '0003_shadow_enrollment': m0003,
  '0004_shadow_transition': m0004,
  '0005_shadow_lease_renewal_receipt': m0005,
  '0006_shadow_capabilities': m0006,
};
