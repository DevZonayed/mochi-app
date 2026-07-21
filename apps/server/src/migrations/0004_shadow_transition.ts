import { type Kysely, sql } from 'kysely';

/**
 * Phase 3A2a — durable host→controller authority-transition outbox. The host
 * uploads a signed `lease-renewal` (or handoff/lease-rotation) grant per active
 * controller; the exact controller fetches + consumes only its own transitions.
 * The relay only stores/forwards the host-signed grant JSON — the HOST signature is
 * the trust boundary, so a controller whose local lease has expired may still fetch
 * its renewal. Rows live until consumed or expired (pruned by retention).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('shadow_authority_transition')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('controller_device_id', 'text', (c) => c.notNull())
    .addColumn('transition_id', 'text', (c) => c.notNull())
    .addColumn('nonce', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('grant', 'jsonb', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('shadow_authority_transition_pk', ['account_id', 'scope_id', 'transition_id'])
    .execute();
  await db.schema
    .createIndex('shadow_authority_transition_nonce_idx')
    .ifNotExists()
    .on('shadow_authority_transition')
    .columns(['account_id', 'scope_id', 'nonce'])
    .unique()
    .execute();
  await db.schema
    .createIndex('shadow_authority_transition_fetch_idx')
    .ifNotExists()
    .on('shadow_authority_transition')
    .columns(['account_id', 'scope_id', 'controller_device_id', 'status', 'created_at'])
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('shadow_authority_transition').ifExists().execute();
}
