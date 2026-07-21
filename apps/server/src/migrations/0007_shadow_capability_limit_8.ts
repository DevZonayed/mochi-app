import { type Kysely, sql } from 'kysely';

const SHADOW_CAPABILITY_LIMIT_0007 = 8;

/**
 * Explicit additive capability-count migration for the current 8-capability
 * vocabulary. This intentionally uses a migration-local constant so later
 * vocabulary additions cannot silently widen persisted DB constraints.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    ALTER TABLE shadow_enrollment_request DROP CONSTRAINT IF EXISTS shadow_req_caps_shape;
    ALTER TABLE shadow_enrollment_request ADD CONSTRAINT shadow_req_caps_shape
      CHECK (jsonb_typeof(requested_capabilities) = 'array' AND jsonb_array_length(requested_capabilities) BETWEEN 1 AND ${sql.lit(SHADOW_CAPABILITY_LIMIT_0007)});
    ALTER TABLE shadow_enrollment_grant DROP CONSTRAINT IF EXISTS shadow_grant_caps_shape;
    ALTER TABLE shadow_enrollment_grant ADD CONSTRAINT shadow_grant_caps_shape
      CHECK (approved_capabilities IS NULL OR (jsonb_typeof(approved_capabilities) = 'array' AND jsonb_array_length(approved_capabilities) BETWEEN 1 AND ${sql.lit(SHADOW_CAPABILITY_LIMIT_0007)}));
  END $$`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE shadow_enrollment_request DROP CONSTRAINT IF EXISTS shadow_req_caps_shape`.execute(db);
  await sql`ALTER TABLE shadow_enrollment_grant DROP CONSTRAINT IF EXISTS shadow_grant_caps_shape`.execute(db);
}
