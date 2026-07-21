/**
 * shadow-action-receipt — Phase 3A2b1 Section C durable, Store-adjacent receipt for
 * capability-gated controller ACTIONS. A receipt binds the controller command to its
 * exact product effect so replay is exactly-once at the PRODUCT level:
 *
 *   key = (scopeId, controllerDeviceId, idempotencyKey)
 *   bound = { accountId, method, canonicalPayloadDigest }
 *   result = bounded public completion (target entity/collection/revision) — no secrets.
 *
 * Contract:
 *   - identical replay (same key + same method + same payload digest) returns the SAME
 *     stored completion WITHOUT re-applying;
 *   - a CONFLICTING replay (same key, different method / payload digest / controller /
 *     account) is rejected with `conflict`;
 *   - concurrent duplicates are serialized by SQLite (the receipt row is a single-writer
 *     INSERT; a WHERE-guarded commit), so two hosts/pollers converge on one receipt.
 *
 * Every registered action's underlying product op is itself idempotent (a state
 * transition to a fixed target, or `Store.claimIdempotentJob`), so a crash BETWEEN the
 * product commit and the receipt insert is safe: replay re-derives the same target state
 * and records the receipt. The receipt therefore never claims "done" before the durable
 * product commit.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ShadowCollection } from '@maestro/realtime';

export interface ActionReceiptCompletion {
  collection: ShadowCollection;
  op: 'upsert' | 'delete';
  entityId: string;
  revision: number;
  payload: unknown;
}

export interface ActionReceiptBinding {
  accountId: string;
  scopeId: string;
  controllerDeviceId: string;
  idempotencyKey: string;
  method: string;
  canonicalPayloadDigest: string;
}

export type ActionReceiptLookup =
  | { status: 'hit'; completion: ActionReceiptCompletion }
  | { status: 'conflict'; reason: string }
  | { status: 'miss' };

/** Result of a receipt commit. A cross-process CONFLICTING commit is surfaced, never masked. */
export type ActionReceiptCommit =
  | { status: 'ok'; completion: ActionReceiptCompletion }
  | { status: 'conflict'; reason: string };

function digest(b: ActionReceiptBinding): string {
  return createHash('sha256').update(JSON.stringify([b.accountId, b.scopeId, b.controllerDeviceId, b.idempotencyKey, b.method, b.canonicalPayloadDigest]), 'utf8').digest('hex');
}

/** Durable receipt store (better-sqlite3, same binding as ShadowHostCore). */
export class ShadowActionReceiptStore {
  private readonly db: Database.Database;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, 'controller-action-receipts.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS action_receipt(
      scope_id TEXT NOT NULL, controller_device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      account_id TEXT NOT NULL, method TEXT NOT NULL, payload_digest TEXT NOT NULL,
      binding_digest TEXT NOT NULL, completion_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(scope_id, controller_device_id, idempotency_key))`);
  }

  /** Look up a prior receipt for this binding. `hit` → replay; `conflict` → rejected replay. */
  lookup(b: ActionReceiptBinding): ActionReceiptLookup {
    const row = this.db.prepare('SELECT account_id,method,payload_digest,binding_digest,completion_json FROM action_receipt WHERE scope_id=? AND controller_device_id=? AND idempotency_key=? LIMIT 1')
      .get(b.scopeId, b.controllerDeviceId, b.idempotencyKey) as { account_id: string; method: string; payload_digest: string; binding_digest: string; completion_json: string } | undefined;
    if (!row) return { status: 'miss' };
    if (row.binding_digest !== digest(b)) {
      const why = row.account_id !== b.accountId ? 'account' : row.method !== b.method ? 'method' : row.payload_digest !== b.canonicalPayloadDigest ? 'payload' : 'binding';
      return { status: 'conflict', reason: `receipt-conflict-${why}` };
    }
    return { status: 'hit', completion: JSON.parse(row.completion_json) as ActionReceiptCompletion };
  }

  /**
   * Commit a receipt for a just-applied idempotent product effect. First-writer-wins:
   * a concurrent poller that already committed the SAME binding is a no-op (→ `ok` with the
   * winner's completion). A concurrent committer of a CONFLICTING binding (same key, different
   * account/method/payload) is surfaced as an explicit `conflict` — NEVER masked by returning
   * the caller's own completion as success (LOW-fix). The caller must reject without projecting.
   */
  commit(b: ActionReceiptBinding, completion: ActionReceiptCompletion, now: number): ActionReceiptCommit {
    this.db.prepare(`INSERT OR IGNORE INTO action_receipt(scope_id,controller_device_id,idempotency_key,account_id,method,payload_digest,binding_digest,completion_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(b.scopeId, b.controllerDeviceId, b.idempotencyKey, b.accountId, b.method, b.canonicalPayloadDigest, digest(b), JSON.stringify(completion), now);
    const after = this.lookup(b);
    if (after.status === 'hit') return { status: 'ok', completion: after.completion };
    if (after.status === 'conflict') return { status: 'conflict', reason: after.reason };
    // A `miss` immediately after our own INSERT OR IGNORE is impossible in practice; treat it
    // as our own successful write rather than inventing a conflict.
    return { status: 'ok', completion };
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}
