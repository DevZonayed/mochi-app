import { type Kysely, sql } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table shadow_revocation_record add column if not exists revocation_id text`.execute(db);
  await sql`alter table shadow_revocation_record add column if not exists grant_id text`.execute(db);

  await sql`
    UPDATE shadow_revocation_record r
    SET grant_id = g.grant_id,
        revocation_id = concat(g.grant_id, ':', r.key_rotation_id)
    FROM shadow_enrollment_grant g
    WHERE r.grant_id IS NULL
      AND r.revocation_id IS NULL
      AND g.account_id = r.account_id
      AND g.scope_id = r.scope_id
      AND g.controller_device_id = r.controller_device_id
      AND g.key_rotation_id = r.key_rotation_id
      AND g.status = 'revoked'
      AND g.revoked_at_ms = r.revoked_at_ms
  `.execute(db);

  await sql`alter table shadow_revocation_record drop constraint if exists shadow_revocation_record_pk`.execute(db);
  await sql`drop index if exists shadow_revocation_record_pk`.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS shadow_revocation_record_identity_idx
    ON shadow_revocation_record (account_id, scope_id, controller_device_id, key_rotation_id)
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS shadow_revocation_record_revocation_id_idx
    ON shadow_revocation_record (account_id, scope_id, revocation_id)
    WHERE revocation_id IS NOT NULL
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists shadow_revocation_record_revocation_id_idx`.execute(db);
  await sql`drop index if exists shadow_revocation_record_identity_idx`.execute(db);
  await sql`alter table shadow_revocation_record drop column if exists revocation_id`.execute(db);
  await sql`alter table shadow_revocation_record drop column if exists grant_id`.execute(db);
}
