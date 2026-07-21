import { type Kysely, sql } from 'kysely';

/**
 * Phase 3A2b3 — at most one PENDING enrollment request per
 * (account, controller device), independent of host/session.
 *
 * Canonical cleanup rule for pre-existing duplicate pending rows:
 * keep the original request, defined deterministically as the earliest
 * (created_at, requested_at_ms, session_id) row for each account/controller.
 * All other pending duplicates are denied, and their enrollment sessions are
 * cancelled when still non-terminal. No row is granted or deleted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    WITH ranked AS (
      SELECT
        account_id,
        session_id,
        controller_device_id,
        row_number() OVER (
          PARTITION BY account_id, controller_device_id
          ORDER BY created_at ASC, requested_at_ms ASC, session_id ASC
        ) AS rn
      FROM shadow_enrollment_request
      WHERE status = 'pending'
    ),
    duplicates AS (
      SELECT account_id, session_id
      FROM ranked
      WHERE rn > 1
    ),
    denied AS (
      UPDATE shadow_enrollment_request r
      SET status = 'denied', updated_at = now()
      FROM duplicates d
      WHERE r.account_id = d.account_id
        AND r.session_id = d.session_id
        AND r.status = 'pending'
      RETURNING r.account_id, r.session_id
    )
    UPDATE shadow_enrollment_session s
    SET status = 'cancelled', updated_at = now()
    FROM denied d
    WHERE s.account_id = d.account_id
      AND s.session_id = d.session_id
      AND s.status IN ('pending', 'consumed')
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS shadow_enrollment_one_pending_controller_idx
    ON shadow_enrollment_request (account_id, controller_device_id)
    WHERE status = 'pending'
  `.execute(db);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS shadow_enrollment_one_pending_controller_idx`.execute(db);
}
