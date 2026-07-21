import { type Kysely, sql } from 'kysely';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('shadow_lease')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull())
    .addColumn('lease_id', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_lease_pk', ['account_id', 'scope_id'])
    .execute();

  await db.schema
    .createTable('shadow_revoked_controller')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('key_rotation_effective_seq', 'integer', (c) => c.notNull())
    .addPrimaryKeyConstraint('shadow_revoked_controller_pk', ['account_id', 'scope_id', 'controller_device_id'])
    .execute();

  await db.schema
    .createTable('shadow_event')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull())
    .addColumn('lease_id', 'text', (c) => c.notNull())
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('prev_seq', 'integer', (c) => c.notNull())
    .addColumn('event_id', 'text', (c) => c.notNull())
    .addColumn('collection', 'text', (c) => c.notNull())
    .addColumn('op', 'text', (c) => c.notNull())
    .addColumn('entity_id', 'text', (c) => c.notNull())
    .addColumn('revision', 'integer', (c) => c.notNull())
    .addColumn('command_id', 'text')
    .addColumn('payload_ciphertext', 'text', (c) => c.notNull())
    .addColumn('payload_digest', 'text', (c) => c.notNull())
    .addColumn('key_id', 'text', (c) => c.notNull())
    .addColumn('signature', 'text', (c) => c.notNull())
    .addColumn('canonical_digest', 'text', (c) => c.notNull())
    .addColumn('created_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('stored_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_event_pk', ['account_id', 'scope_id', 'epoch', 'seq'])
    .execute();
  await db.schema.createIndex('shadow_event_event_id_idx').ifNotExists().on('shadow_event').columns(['account_id', 'scope_id', 'epoch', 'event_id']).unique().execute();
  await db.schema.createIndex('shadow_event_tail_idx').ifNotExists().on('shadow_event').columns(['account_id', 'scope_id', 'host_device_id', 'epoch', 'seq']).execute();

  await db.schema
    .createTable('shadow_cursor')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull())
    .addColumn('lease_id', 'text', (c) => c.notNull())
    .addColumn('last_seq', 'integer', (c) => c.notNull())
    .addColumn('last_event_id', 'text')
    .addColumn('last_digest', 'text')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_cursor_pk', ['account_id', 'scope_id', 'controller_device_id'])
    .execute();

  await db.schema
    .createTable('shadow_snapshot')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull())
    .addColumn('lease_id', 'text', (c) => c.notNull())
    .addColumn('snapshot_id', 'text', (c) => c.notNull())
    .addColumn('base_seq', 'integer', (c) => c.notNull())
    .addColumn('manifest_ciphertext', 'text', (c) => c.notNull())
    .addColumn('manifest_digest', 'text', (c) => c.notNull())
    .addColumn('key_id', 'text', (c) => c.notNull())
    .addColumn('published_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz')
    .addPrimaryKeyConstraint('shadow_snapshot_pk', ['account_id', 'scope_id', 'snapshot_id'])
    .execute();
  await db.schema.createIndex('shadow_snapshot_latest_idx').ifNotExists().on('shadow_snapshot').columns(['account_id', 'scope_id', 'epoch', 'base_seq']).execute();

  await db.schema
    .createTable('shadow_chunk')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull())
    .addColumn('lease_id', 'text', (c) => c.notNull())
    .addColumn('content_id', 'text', (c) => c.notNull())
    .addColumn('snapshot_id', 'text')
    .addColumn('collection', 'text')
    .addColumn('page_key', 'text')
    .addColumn('byte_length', 'integer', (c) => c.notNull())
    .addColumn('ciphertext', 'bytea', (c) => c.notNull())
    .addColumn('plaintext_digest', 'text', (c) => c.notNull())
    .addColumn('ciphertext_digest', 'text', (c) => c.notNull())
    .addColumn('key_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz')
    .addPrimaryKeyConstraint('shadow_chunk_pk', ['account_id', 'scope_id', 'content_id'])
    .execute();

  await db.schema
    .createTable('shadow_blob')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull())
    .addColumn('lease_id', 'text', (c) => c.notNull())
    .addColumn('content_id', 'text', (c) => c.notNull())
    .addColumn('variant', 'text', (c) => c.notNull())
    .addColumn('byte_length', 'integer', (c) => c.notNull())
    .addColumn('ciphertext', 'bytea', (c) => c.notNull())
    .addColumn('plaintext_digest', 'text', (c) => c.notNull())
    .addColumn('ciphertext_digest', 'text', (c) => c.notNull())
    .addColumn('key_id', 'text', (c) => c.notNull())
    .addColumn('capability_expires_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_blob_pk', ['account_id', 'scope_id', 'content_id', 'variant'])
    .execute();

  await db.schema
    .createTable('shadow_blob_capability')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull())
    .addColumn('lease_id', 'text', (c) => c.notNull())
    .addColumn('content_id', 'text', (c) => c.notNull())
    .addColumn('variant', 'text', (c) => c.notNull())
    .addColumn('capability_id', 'text', (c) => c.notNull())
    .addColumn('permissions', sql`text[]`, (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('signature', 'text', (c) => c.notNull())
    .addColumn('canonical_digest', 'text', (c) => c.notNull())
    .addColumn('capability_json', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_blob_capability_pk', ['account_id', 'scope_id', 'capability_id'])
    .execute();
  await db.schema.createIndex('shadow_blob_capability_lookup_idx').ifNotExists().on('shadow_blob_capability').columns(['account_id', 'scope_id', 'controller_device_id', 'content_id', 'variant']).execute();

  await db.schema
    .createTable('shadow_command')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('command_id', 'text', (c) => c.notNull())
    .addColumn('idempotency_key', 'text', (c) => c.notNull())
    .addColumn('fence', 'jsonb', (c) => c.notNull())
    .addColumn('envelope_ciphertext', 'text', (c) => c.notNull())
    .addColumn('payload_digest', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('ack_ciphertext', 'text')
    .addColumn('ack_digest', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('shadow_command_pk', ['account_id', 'scope_id', 'command_id'])
    .execute();
  await db.schema.createIndex('shadow_command_idempotency_idx').ifNotExists().on('shadow_command').columns(['account_id', 'scope_id', 'controller_device_id', 'idempotency_key']).unique().execute();
  await db.schema.createIndex('shadow_command_host_queue_idx').ifNotExists().on('shadow_command').columns(['account_id', 'scope_id', 'host_device_id', 'status', 'created_at']).execute();

  await db.schema
    .createTable('shadow_transport')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('transport', 'text', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_transport_pk', ['account_id', 'scope_id', 'controller_device_id', 'transport'])
    .execute();

  await sql`alter table shadow_event add column if not exists canonical_digest text`.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('shadow_transport').ifExists().execute();
  await db.schema.dropTable('shadow_command').ifExists().execute();
  await db.schema.dropTable('shadow_blob_capability').ifExists().execute();
  await db.schema.dropTable('shadow_blob').ifExists().execute();
  await db.schema.dropTable('shadow_chunk').ifExists().execute();
  await db.schema.dropTable('shadow_snapshot').ifExists().execute();
  await db.schema.dropTable('shadow_cursor').ifExists().execute();
  await db.schema.dropTable('shadow_event').ifExists().execute();
  await db.schema.dropTable('shadow_revoked_controller').ifExists().execute();
  await db.schema.dropTable('shadow_lease').ifExists().execute();
}
