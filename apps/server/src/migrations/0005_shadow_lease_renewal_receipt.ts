import { type Kysely, sql } from 'kysely';

/**
 * Phase 3A2a — durable lease-renewal receipt. Records that a specific `renewalId`
 * committed (idempotency key), so an atomic renew-and-store-transitions request can
 * be replayed safely after a host crash: identical body → returns the committed
 * fence/expiry, mismatched body → 409. The lease UPDATE + transition INSERTs +
 * this receipt INSERT all happen in ONE transaction, so no partial (lease-only)
 * commit is possible.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('shadow_lease_renewal_receipt')
    .ifNotExists()
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('scope_id', 'text', (c) => c.notNull())
    .addColumn('renewal_id', 'text', (c) => c.notNull())
    .addColumn('host_device_id', 'text', (c) => c.notNull())
    .addColumn('fence', 'jsonb', (c) => c.notNull())
    .addColumn('expires_at_ms', 'bigint', (c) => c.notNull())
    .addColumn('request_digest', 'text', (c) => c.notNull())
    .addColumn('committed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('shadow_lease_renewal_receipt_pk', ['account_id', 'scope_id', 'renewal_id'])
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('shadow_lease_renewal_receipt').ifExists().execute();
}
