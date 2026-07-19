import { type Kysely, sql } from 'kysely';

/**
 * Phase 3A2b1 §1-B — persist the controller-signed REQUESTED capability set on the
 * pending enrollment request, and the host-APPROVED capability set on the controller
 * grant (public audit metadata; never a secret). Both are `jsonb` arrays defaulting
 * to the legacy floor `["account.read"]`, with CHECK constraints bounding them to a
 * non-empty array within the canonical vocabulary size (7). App-level validation
 * (canonicalizeCapabilities) remains authoritative for known-enum + canonical sort.
 *
 * IDEMPOTENT: `runMigrations` re-runs every `up()` on each boot with no tracking
 * table, so every statement is `IF NOT EXISTS` / guarded — safe on fresh + reopen.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // requested_capabilities: NON-NULL (the controller-signed verified set; legacy → ["account.read"]).
  await sql`ALTER TABLE shadow_enrollment_request ADD COLUMN IF NOT EXISTS requested_capabilities jsonb NOT NULL DEFAULT '["account.read"]'::jsonb`.execute(db);
  // approved_capabilities: NULLABLE — NULL means the grant was signed WITHOUT a capability
  // field (legacy, treated as account.read). A non-null value is the canonical bound set.
  // This preserves the byte-additive grant signature on `pollEnrollment` reconstruction.
  await sql`ALTER TABLE shadow_enrollment_grant ADD COLUMN IF NOT EXISTS approved_capabilities jsonb`.execute(db);
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shadow_req_caps_shape') THEN
      ALTER TABLE shadow_enrollment_request ADD CONSTRAINT shadow_req_caps_shape
        CHECK (jsonb_typeof(requested_capabilities) = 'array' AND jsonb_array_length(requested_capabilities) BETWEEN 1 AND 7);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shadow_grant_caps_shape') THEN
      ALTER TABLE shadow_enrollment_grant ADD CONSTRAINT shadow_grant_caps_shape
        CHECK (approved_capabilities IS NULL OR (jsonb_typeof(approved_capabilities) = 'array' AND jsonb_array_length(approved_capabilities) BETWEEN 1 AND 7));
    END IF;
  END $$`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE shadow_enrollment_request DROP CONSTRAINT IF EXISTS shadow_req_caps_shape`.execute(db);
  await sql`ALTER TABLE shadow_enrollment_grant DROP CONSTRAINT IF EXISTS shadow_grant_caps_shape`.execute(db);
  await sql`ALTER TABLE shadow_enrollment_request DROP COLUMN IF EXISTS requested_capabilities`.execute(db);
  await sql`ALTER TABLE shadow_enrollment_grant DROP COLUMN IF EXISTS approved_capabilities`.execute(db);
}
