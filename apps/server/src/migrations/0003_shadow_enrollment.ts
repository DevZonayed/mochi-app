import { type Kysely, sql } from 'kysely';

/**
 * Phase 3A1 — native controller secure enrollment / signed-request auth /
 * atomic revocation schema. All tables are account-scoped and created with
 * `ifNotExists`, so this migration is idempotent and restart-safe (it may be
 * applied on every boot alongside 0001/0002). No secret-bearing column exists:
 * one-time secrets are stored only as a peppered verifier + salt, private keys
 * and plaintext scope keys never reach the relay.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // Registered host identity (TOFU): the host device's long-lived public
  // signing + agreement keys. Replacement requires a signed rotation or an
  // explicit revoke/re-enroll — never a silent overwrite (enforced in service).
  await db.schema
    .createTable('shadow_host_identity')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('signing_key_id', 'text', (c) => c.notNull())
    .addColumn('signing_public_key', 'text', (c) => c.notNull())
    .addColumn('agreement_key_id', 'text', (c) => c.notNull())
    .addColumn('agreement_public_key', 'text', (c) => c.notNull())
    .addColumn('fingerprint', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('active','revoked')`))
    .addColumn('rotated_from_key_id', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_host_identity_pk', ['account_id', 'host_device_id'])
    .execute();
  await db.schema
    .createIndex('shadow_host_identity_key_idx')
    .ifNotExists()
    .on('shadow_host_identity')
    .columns(['account_id', 'signing_key_id'])
    .unique()
    .execute();

  // Every active public signing/agreement key for a device, the authority for
  // signed-request auth. Revocation flips status='revoked' so live requests
  // signed by a once-valid key fail immediately.
  await db.schema
    .createTable('shadow_registered_key')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('key_id', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull().check(sql`role in ('host','controller')`))
    .addColumn('purpose', 'text', (c) => c.notNull().check(sql`purpose in ('sign','agree')`))
    .addColumn('public_key', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('active','revoked')`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('revoked_at', 'timestamptz')
    .addPrimaryKeyConstraint('shadow_registered_key_pk', ['account_id', 'key_id'])
    .execute();
  await db.schema
    .createIndex('shadow_registered_key_device_idx')
    .ifNotExists()
    .on('shadow_registered_key')
    .columns(['account_id', 'device_id', 'purpose', 'status'])
    .execute();

  // Single-use enrollment sessions. Stores only the peppered verifier + salt —
  // never the plaintext one-time secret, never any private/scope key.
  await db.schema
    .createTable('shadow_enrollment_session')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('session_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('host_signing_key_id', 'text', (c) => c.notNull())
    .addColumn('relay_origin', 'text', (c) => c.notNull())
    .addColumn('secret_salt', 'text', (c) => c.notNull())
    .addColumn('secret_verifier', 'text', (c) => c.notNull())
    .addColumn('expected_fingerprint', 'text')
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('pending','consumed','approved','denied','cancelled')`))
    .addColumn('created_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('expires_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_enrollment_session_pk', ['account_id', 'session_id'])
    .execute();
  await db.schema
    .createIndex('shadow_enrollment_session_host_idx')
    .ifNotExists()
    .on('shadow_enrollment_session')
    .columns(['account_id', 'host_device_id', 'status'])
    .execute();

  // Controller enrollment requests. One request row per session (PK on
  // session), so the first accepted request atomically consumes the session.
  await db.schema
    .createTable('shadow_enrollment_request')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('session_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('controller_signing_key_id', 'text', (c) => c.notNull())
    .addColumn('controller_agreement_key_id', 'text', (c) => c.notNull())
    .addColumn('signing_public_key', 'text', (c) => c.notNull())
    .addColumn('agreement_public_key', 'text', (c) => c.notNull())
    .addColumn('nonce', 'text', (c) => c.notNull())
    .addColumn('requested_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('transcript_hash', 'text', (c) => c.notNull())
    .addColumn('signature', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('pending','approved','denied')`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_enrollment_request_pk', ['account_id', 'session_id'])
    .execute();
  await db.schema
    .createIndex('shadow_enrollment_request_controller_idx')
    .ifNotExists()
    .on('shadow_enrollment_request')
    .columns(['account_id', 'controller_device_id', 'status'])
    .execute();

  // Approved grants: signed grant + wrapped scope-key ciphertext + public
  // metadata only. The relay can never decrypt the wrapped scope key.
  await db.schema
    .createTable('shadow_enrollment_grant')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('grant_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('session_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull())
    .addColumn('lease_id', 'text', (c) => c.notNull())
    .addColumn('key_id', 'text', (c) => c.notNull())
    .addColumn('expires_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('signed_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('grant_signature', 'text', (c) => c.notNull())
    .addColumn('wrap_nonce', 'text', (c) => c.notNull())
    .addColumn('wrapped_scope_key', 'text', (c) => c.notNull())
    .addColumn('transcript_hash', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('active','revoked')`))
    .addColumn('key_rotation_id', 'text')
    .addColumn('revoked_at_ms', 'bigint')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_enrollment_grant_pk', ['account_id', 'grant_id'])
    .execute();
  await db.schema
    .createIndex('shadow_enrollment_grant_controller_idx')
    .ifNotExists()
    .on('shadow_enrollment_grant')
    .columns(['account_id', 'scope_id', 'controller_device_id'])
    .unique()
    .execute();

  // Signed-request nonce replay protection. Bounded by expires_at_ms; a
  // duplicate insert (same account/device/nonce) fails the PK, rejecting replay.
  await db.schema
    .createTable('shadow_request_nonce')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('nonce', 'text', (c) => c.notNull())
    .addColumn('expires_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_request_nonce_pk', ['account_id', 'device_id', 'nonce'])
    .execute();
  await db.schema
    .createIndex('shadow_request_nonce_expiry_idx')
    .ifNotExists()
    .on('shadow_request_nonce')
    .columns(['expires_at_ms'])
    .execute();

  // Signed revocation + key-rotation records for atomic denial + idempotent
  // replay. One active revocation per (account, scope, controller).
  await db.schema
    .createTable('shadow_revocation_record')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('key_rotation_id', 'text', (c) => c.notNull())
    .addColumn('revoked_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('effective_seq', 'integer', (c) => c.notNull())
    .addColumn('revocation_signature', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    // Canonical SHA-256 of the full revocation request (identity + payload +
    // signature + normalized rotations) so an exact replay is distinguishable
    // from a conflicting second revocation for the same (account,scope,controller).
    // NOT NULL on a fresh table: every server-written record carries a digest.
    .addColumn('request_digest', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_revocation_record_pk', ['account_id', 'scope_id', 'controller_device_id'])
    .execute();
  // Restart-safe on a table created by an earlier variant of this migration that
  // lacked the column: add it NULLABLE (a NOT NULL add would fail on legacy rows).
  // Such a legacy null-digest row is treated as UNVERIFIABLE and fails closed in
  // the service (never idempotent, never backfilled). The TS type stays nullable.
  await sql`alter table shadow_revocation_record add column if not exists request_digest text`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('shadow_revocation_record').ifExists().execute();
  await db.schema.dropTable('shadow_request_nonce').ifExists().execute();
  await db.schema.dropTable('shadow_enrollment_grant').ifExists().execute();
  await db.schema.dropTable('shadow_enrollment_request').ifExists().execute();
  await db.schema.dropTable('shadow_enrollment_session').ifExists().execute();
  await db.schema.dropTable('shadow_registered_key').ifExists().execute();
  await db.schema.dropTable('shadow_host_identity').ifExists().execute();
}
