/* PostgreSQL access for the account/device model. Better Auth owns its own
   tables (user/session/account/verification) via its CLI migration; we own the
   `device` table via the Kysely migrator below. */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, type ColumnType, type JSONColumnType } from 'kysely';
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
export interface ShadowLeaseTable {
  account_id: string;
  scope_id: string;
  host_device_id: string;
  epoch: number;
  lease_id: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}
export interface ShadowRevokedControllerTable {
  account_id: string;
  scope_id: string;
  controller_device_id: string;
  revoked_at: Date;
  key_rotation_effective_seq: number;
}
export interface ShadowEventTable {
  account_id: string;
  scope_id: string;
  host_device_id: string;
  epoch: number;
  lease_id: string;
  seq: number;
  prev_seq: number;
  event_id: string;
  collection: string;
  op: 'upsert' | 'delete' | 'patch' | 'checkpoint';
  entity_id: string;
  revision: number;
  command_id: string | null;
  payload_ciphertext: string;
  payload_digest: string;
  key_id: string;
  signature: string;
  canonical_digest: string | null;
  created_at_ms: number;
  stored_at: Date;
}
export interface ShadowCursorTable {
  account_id: string;
  scope_id: string;
  controller_device_id: string;
  host_device_id: string;
  epoch: number;
  lease_id: string;
  last_seq: number;
  last_event_id: string | null;
  last_digest: string | null;
  updated_at: Date;
}
export interface ShadowSnapshotTable {
  account_id: string;
  scope_id: string;
  host_device_id: string;
  epoch: number;
  lease_id: string;
  snapshot_id: string;
  base_seq: number;
  manifest_ciphertext: string;
  manifest_digest: string;
  key_id: string;
  published_at: Date;
  expires_at: Date | null;
}
export interface ShadowChunkTable {
  account_id: string;
  scope_id: string;
  host_device_id: string;
  epoch: number;
  lease_id: string;
  content_id: string;
  snapshot_id: string | null;
  collection: string | null;
  page_key: string | null;
  byte_length: number;
  ciphertext: Buffer;
  plaintext_digest: string;
  ciphertext_digest: string;
  key_id: string;
  created_at: Date;
  expires_at: Date | null;
}
export interface ShadowBlobTable {
  account_id: string;
  scope_id: string;
  host_device_id: string;
  epoch: number;
  lease_id: string;
  content_id: string;
  variant: string;
  byte_length: number;
  ciphertext: Buffer;
  plaintext_digest: string;
  ciphertext_digest: string;
  key_id: string;
  capability_expires_at: Date | null;
  created_at: Date;
}
export interface ShadowBlobCapabilityTable {
  account_id: string;
  scope_id: string;
  controller_device_id: string;
  host_device_id: string;
  epoch: number;
  lease_id: string;
  content_id: string;
  variant: string;
  capability_id: string;
  permissions: string[];
  expires_at: Date;
  revoked_at: Date | null;
  signature: string;
  canonical_digest: string;
  capability_json: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Date;
}
export interface ShadowCommandTable {
  account_id: string;
  scope_id: string;
  host_device_id: string;
  controller_device_id: string;
  command_id: string;
  idempotency_key: string;
  fence: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  envelope_ciphertext: string;
  payload_digest: string;
  status: 'queued' | 'delivered' | 'acked';
  ack_ciphertext: string | null;
  ack_digest: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}
export interface ShadowAuthorityTransitionTable {
  account_id: string;
  scope_id: string;
  host_device_id: string;
  controller_device_id: string;
  transition_id: string;
  nonce: string;
  kind: string;
  grant: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  status: 'queued' | 'consumed';
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}
export interface ShadowLeaseRenewalReceiptTable {
  account_id: string;
  scope_id: string;
  renewal_id: string;
  host_device_id: string;
  fence: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  expires_at_ms: string; // bigint ms (string in kysely)
  request_digest: string;
  committed_at: Date;
}
export interface ShadowTransportTable {
  account_id: string;
  scope_id: string;
  controller_device_id: string;
  host_device_id: string;
  transport: string;
  state: string;
  updated_at: Date;
}
// ── Phase 3A1: enrollment / signed-request auth / revocation ──────────────
export interface ShadowHostIdentityTable {
  account_id: string;
  host_device_id: string;
  signing_key_id: string;
  signing_public_key: string;
  agreement_key_id: string;
  agreement_public_key: string;
  fingerprint: string;
  status: 'active' | 'revoked';
  rotated_from_key_id: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface ShadowRegisteredKeyTable {
  account_id: string;
  key_id: string;
  device_id: string;
  role: 'host' | 'controller';
  purpose: 'sign' | 'agree';
  public_key: string;
  status: 'active' | 'revoked';
  created_at: Date;
  revoked_at: Date | null;
}
export interface ShadowEnrollmentSessionTable {
  account_id: string;
  session_id: string;
  host_device_id: string;
  host_signing_key_id: string;
  relay_origin: string;
  secret_salt: string;
  secret_verifier: string;
  expected_fingerprint: string | null;
  status: 'pending' | 'consumed' | 'approved' | 'denied' | 'cancelled';
  created_at_ms: number;
  expires_at_ms: number;
  created_at: Date;
  updated_at: Date;
}
export interface ShadowEnrollmentRequestTable {
  account_id: string;
  session_id: string;
  controller_device_id: string;
  controller_signing_key_id: string;
  controller_agreement_key_id: string;
  signing_public_key: string;
  agreement_public_key: string;
  nonce: string;
  requested_at_ms: number;
  transcript_hash: string;
  signature: string;
  status: 'pending' | 'approved' | 'denied';
  /** Controller-signed requested capability set (jsonb array). Insert a JSON string; read as array. */
  requested_capabilities: ColumnType<string[], string | undefined, string>;
  created_at: Date;
  updated_at: Date;
}
export interface ShadowEnrollmentGrantTable {
  account_id: string;
  grant_id: string;
  scope_id: string;
  session_id: string;
  controller_device_id: string;
  host_device_id: string;
  epoch: number;
  lease_id: string;
  key_id: string;
  expires_at_ms: number;
  signed_at_ms: number;
  grant_signature: string;
  wrap_nonce: string;
  wrapped_scope_key: string;
  transcript_hash: string;
  status: 'active' | 'revoked';
  key_rotation_id: string | null;
  revoked_at_ms: number | null;
  /** Host-approved capability set bound in the signed grant (jsonb array; public audit).
      NULL = grant signed WITHOUT a capability field (legacy → account.read). */
  approved_capabilities: ColumnType<string[] | null, string | null | undefined, string | null>;
  created_at: Date;
  updated_at: Date;
}
export interface ShadowRequestNonceTable {
  account_id: string;
  device_id: string;
  nonce: string;
  expires_at_ms: number;
  created_at: Date;
}
export interface ShadowRevocationRecordTable {
  account_id: string;
  scope_id: string;
  controller_device_id: string;
  key_rotation_id: string;
  revoked_at_ms: number;
  effective_seq: number;
  revocation_signature: string;
  host_device_id: string;
  request_digest: string | null;
  created_at: Date;
}
export interface DB {
  device: DeviceTable;
  shadow_lease: ShadowLeaseTable;
  shadow_revoked_controller: ShadowRevokedControllerTable;
  shadow_event: ShadowEventTable;
  shadow_cursor: ShadowCursorTable;
  shadow_snapshot: ShadowSnapshotTable;
  shadow_chunk: ShadowChunkTable;
  shadow_blob: ShadowBlobTable;
  shadow_blob_capability: ShadowBlobCapabilityTable;
  shadow_command: ShadowCommandTable;
  shadow_transport: ShadowTransportTable;
  shadow_host_identity: ShadowHostIdentityTable;
  shadow_registered_key: ShadowRegisteredKeyTable;
  shadow_enrollment_session: ShadowEnrollmentSessionTable;
  shadow_enrollment_request: ShadowEnrollmentRequestTable;
  shadow_enrollment_grant: ShadowEnrollmentGrantTable;
  shadow_request_nonce: ShadowRequestNonceTable;
  shadow_revocation_record: ShadowRevocationRecordTable;
  shadow_authority_transition: ShadowAuthorityTransitionTable;
  shadow_lease_renewal_receipt: ShadowLeaseRenewalReceiptTable;
}

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
