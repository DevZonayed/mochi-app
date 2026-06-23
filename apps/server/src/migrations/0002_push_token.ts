/* Add per-device Expo push token. Stored on the device row so it follows the
   device across sign-ins and is naturally scoped to its owner account. Nullable
   (the column is empty until the remote registers a token). Idempotent: a
   re-run of this migration on an existing column is a no-op. */
import { type Kysely, sql } from 'kysely';

// Kysely migrations operate on an untyped schema builder by convention.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // `ADD COLUMN IF NOT EXISTS` is supported by Postgres 9.6+; treats a repeat
  // run as a no-op so re-deploys never fail on a column that's already there.
  await sql`ALTER TABLE device ADD COLUMN IF NOT EXISTS push_token text`.execute(db);
  // Cheap lookup index: maybePush() reads "give me every push_token for this
  // account's remote devices" on every host event, so we want this hot.
  await sql`CREATE INDEX IF NOT EXISTS device_user_pushtoken_idx ON device (user_id) WHERE push_token IS NOT NULL`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS device_user_pushtoken_idx`.execute(db);
  await sql`ALTER TABLE device DROP COLUMN IF EXISTS push_token`.execute(db);
}
