import { type Kysely, sql } from 'kysely';

/**
 * Phase 3A2b4 — grant uniqueness applies only to ACTIVE controller grants.
 *
 * Migration 0003 created a global unique index over
 * (account_id, scope_id, controller_device_id), which preserved one-row history
 * but made explicit revoke/re-enroll impossible: a new active grant conflicted
 * with the old revoked row. Keep immutable revoked history and enforce the real
 * invariant instead: at most one active grant for a controller in a scope.
 *
 * Existing-data safety: normal production old0003 cannot contain duplicate
 * active rows because of the global unique index. If a manually-mutated/legacy
 * database somehow does contain multiple active rows for the same controller,
 * fail closed before any DDL/DML. Operators must inspect and repair that
 * fixture externally; the migration must not silently revoke security state.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  const duplicateActive = await sql<{ duplicate_groups: string | number | bigint }>`
    SELECT count(*) AS duplicate_groups
    FROM (
      SELECT 1
      FROM shadow_enrollment_grant
      WHERE status = 'active'
      GROUP BY account_id, scope_id, controller_device_id
      HAVING count(*) > 1
    ) duplicate_active_grants
  `.execute(db);
  const duplicateGroups = Number(duplicateActive.rows[0]?.duplicate_groups ?? 0);
  if (duplicateGroups > 0) {
    throw new Error('migration 0009 blocked: duplicate active shadow enrollment grants');
  }

  await sql`DROP INDEX IF EXISTS shadow_enrollment_grant_controller_idx`.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS shadow_enrollment_active_grant_controller_idx
    ON shadow_enrollment_grant (account_id, scope_id, controller_device_id)
    WHERE status = 'active'
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS shadow_enrollment_active_grant_controller_idx`.execute(db);
}
