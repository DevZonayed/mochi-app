import { type Kysely, sql } from 'kysely';

const HISTORICAL_INDEX = 'shadow_enrollment_grant_controller_idx';
const TRANSITIONAL_INDEX = 'shadow_enrollment_active_grant_controller_idx';
const GRANT_TABLE = 'shadow_enrollment_grant';
const GRANT_COLUMNS = ['account_id', 'scope_id', 'controller_device_id'];
const ACTIVE_PREDICATE = "(status = 'active'::text)";

type GrantIndexShape = {
  indexname: string;
  is_unique: boolean;
  columns: string[];
  predicate: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getGrantIndexShape(db: Kysely<any>, indexName: string): Promise<GrantIndexShape | null> {
  const result = await sql<{
    indexname: string;
    is_unique: boolean;
    columns: string[];
    predicate: string | null;
  }>`
    SELECT
      c.relname AS indexname,
      i.indisunique AS is_unique,
      array_agg(a.attname ORDER BY keys.ordinality)::text[] AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN unnest(i.indkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keys.attnum
    WHERE n.nspname = current_schema()
      AND t.relname = ${GRANT_TABLE}
      AND c.relname = ${indexName}
    GROUP BY c.relname, i.indisunique, i.indpred, i.indrelid
  `.execute(db);
  const row = result.rows[0];
  return row ? { ...row, columns: row.columns ?? [] } : null;
}

function isExpectedColumns(shape: GrantIndexShape): boolean {
  return shape.columns.length === GRANT_COLUMNS.length && GRANT_COLUMNS.every((col, idx) => shape.columns[idx] === col);
}

function isExactActivePartialGrantIndex(shape: GrantIndexShape | null): boolean {
  return !!shape && shape.is_unique && isExpectedColumns(shape) && shape.predicate === ACTIVE_PREDICATE;
}

function isExactHistoricalGlobalGrantIndex(shape: GrantIndexShape | null): boolean {
  return !!shape && shape.is_unique && isExpectedColumns(shape) && shape.predicate === null;
}

function assertNoMismatchedGrantIndex(shape: GrantIndexShape | null): void {
  if (shape && !isExactActivePartialGrantIndex(shape) && !isExactHistoricalGlobalGrantIndex(shape)) {
    throw new Error(`migration 0009 blocked: unexpected ${shape.indexname} definition`);
  }
}

/**
 * Phase 3A2b4 — grant uniqueness applies only to ACTIVE controller grants.
 *
 * Migration 0003 created a global unique index over
 * (account_id, scope_id, controller_device_id), which preserved one-row history
 * but made explicit revoke/re-enroll impossible: a new active grant conflicted
 * with the old revoked row. Keep immutable revoked history and enforce the real
 * invariant instead: at most one active grant for a controller in a scope.
 * The canonical final index keeps 0003's historical name so the boot-time
 * rerunnable 0003 `ifNotExists` path remains a no-op after this migration.
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

  const historical = await getGrantIndexShape(db, HISTORICAL_INDEX);
  const transitional = await getGrantIndexShape(db, TRANSITIONAL_INDEX);
  assertNoMismatchedGrantIndex(historical);
  assertNoMismatchedGrantIndex(transitional);

  if (isExactActivePartialGrantIndex(historical)) {
    if (transitional) {
      await sql`DROP INDEX ${sql.id(TRANSITIONAL_INDEX)}`.execute(db);
    }
    return;
  }

  if (!historical && isExactActivePartialGrantIndex(transitional)) {
    await sql`ALTER INDEX ${sql.id(TRANSITIONAL_INDEX)} RENAME TO ${sql.id(HISTORICAL_INDEX)}`.execute(db);
    return;
  }

  if (isExactHistoricalGlobalGrantIndex(historical)) {
    await sql`DROP INDEX ${sql.id(HISTORICAL_INDEX)}`.execute(db);
    if (transitional) {
      await sql`DROP INDEX ${sql.id(TRANSITIONAL_INDEX)}`.execute(db);
    }
    await sql`
      CREATE UNIQUE INDEX ${sql.id(HISTORICAL_INDEX)}
      ON shadow_enrollment_grant (account_id, scope_id, controller_device_id)
      WHERE status = 'active'
    `.execute(db);
    return;
  }

  await sql`
    CREATE UNIQUE INDEX ${sql.id(HISTORICAL_INDEX)}
    ON shadow_enrollment_grant (account_id, scope_id, controller_device_id)
    WHERE status = 'active'
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS shadow_enrollment_grant_controller_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS shadow_enrollment_active_grant_controller_idx`.execute(db);
}
