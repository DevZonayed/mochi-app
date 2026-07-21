/**
 * shadowPurgeGate — Phase 3B0 O-1 durable fail-closed purge contract.
 *
 * The sign-out / account / host-switch reset must NEVER leave prior-account
 * plaintext (SQLite entity/command cache) or authority material (SecureStore
 * scope key + grant metadata) reusable — even if a destructive stage throws, even
 * across a process restart. The previous ordering (`store.reset()` THEN
 * `purgeDurable()`) meant a corrupt/locked DB reset skipped the key/grant purge
 * and a later bootstrap rebuilt from the survivors.
 *
 * The contract here:
 *   1. A DURABLE `purge-required` TOMBSTONE (in SecureStore — the store most
 *      independent of the SQLite DBs being wiped) is established BEFORE any
 *      destructive stage and records the exact SecureStore scope-key handles to
 *      erase, so a retry can target them even after the grant is gone / on a fresh
 *      process. Bootstrap/read/send/reconcile refuse while it is set.
 *   2. Destructive stages run with AGGREGATE error handling (every stage is
 *      attempted, not skipped after the first failure): authority material
 *      (scope keys + grant) is purged alongside the SQLite cache reset.
 *   3. The tombstone is held until ALL stages succeed AND a close/reopen
 *      verification reads empty; only then is it cleared LAST. Any stage failure
 *      (or non-empty verification, or a tombstone-storage error) fails closed —
 *      the tombstone + locked runtime survive and a retry is required.
 *   4. A per-reset token fences identity/generation: a stale callback can only
 *      clear the tombstone it wrote, never a newer reset's tombstone.
 */
import type { SecureStoreAdapter } from './shadowEnrollmentClient';

/** SecureStore key holding the durable purge tombstone (independent of the wiped DBs). */
export const SHADOW_PURGE_TOMBSTONE_KEY = 'maestro.shadow.purge-required';

export interface ShadowPurgeTombstone {
  v: 1;
  /** Per-reset nonce — only the reset that wrote it (or a retry that read it) may clear it. */
  token: string;
  /** Exact SecureStore scope-key handles to erase (captured before the grant is cleared). */
  scopeKeyHandles: string[];
  setAt: number;
}

/** Thrown when a purge did not fully complete — the tombstone remains set. */
export class ShadowPurgeIncompleteError extends Error {
  constructor(public readonly reasons: string[], public readonly verifiedEmpty: boolean) {
    super(`shadow purge incomplete (verifiedEmpty=${verifiedEmpty}): ${reasons.join('; ') || 'no stage error but verification failed'}`);
    this.name = 'ShadowPurgeIncompleteError';
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Durable tombstone over a SecureStore. Reads FAIL CLOSED: an unreadable /
 * corrupt tombstone is treated as "purge required" so a storage fault can never
 * be mistaken for "clear".
 */
export class ShadowPurgeGate {
  constructor(private readonly secureStore: SecureStoreAdapter, private readonly key = SHADOW_PURGE_TOMBSTONE_KEY) {}

  /** Establish the durable tombstone BEFORE any destructive stage. Throws (fail closed) if it cannot be written. */
  async require(token: string, scopeKeyHandles: string[], now: number): Promise<ShadowPurgeTombstone> {
    const t: ShadowPurgeTombstone = { v: 1, token, scopeKeyHandles: [...scopeKeyHandles], setAt: now };
    await this.secureStore.setItemAsync(this.key, JSON.stringify(t));
    return t;
  }

  /**
   * Read the tombstone. Returns the tombstone if a valid one is set, `null` if
   * definitively absent. A present-but-unparseable value fails closed to a
   * sentinel tombstone (purge required) rather than `null`.
   */
  async read(): Promise<ShadowPurgeTombstone | null> {
    const raw = await this.secureStore.getItemAsync(this.key); // a getItem throw propagates → caller fails closed
    if (raw == null) return null;
    try {
      const parsed = JSON.parse(raw) as ShadowPurgeTombstone;
      if (parsed && parsed.v === 1 && typeof parsed.token === 'string' && Array.isArray(parsed.scopeKeyHandles)) return parsed;
    } catch { /* fall through to fail-closed sentinel */ }
    return { v: 1, token: '', scopeKeyHandles: [], setAt: 0 }; // corrupt → still "purge required"
  }

  /** True if a purge is currently required. Fails closed (treats a read error as required). */
  async isRequired(): Promise<boolean> {
    try { return (await this.read()) !== null; }
    catch { return true; }
  }

  /** Clear the tombstone LAST — only if the current tombstone's token matches (identity/generation fence). */
  async clearIfToken(token: string): Promise<void> {
    let current: ShadowPurgeTombstone | null;
    try { current = await this.read(); } catch { return; } // unreadable → leave it (fail closed)
    if (!current || current.token !== token) return; // a newer reset owns it now → do not clear
    await this.secureStore.deleteItemAsync(this.key);
  }
}

export interface ShadowPurgeStages {
  /** SecureStore scope-key handles to erase. */
  scopeKeyHandles: string[];
  /** Erase one SecureStore scope-key handle. */
  deleteSecureItem(key: string): Promise<void>;
  /** Clear the durable public grant metadata. */
  clearGrant(): Promise<void>;
  /** WAL/journal-hardened reset of the SQLite entity/command/meta cache. */
  resetCache(): Promise<void>;
  /** Close/reopen verification: true iff cache rows == 0, grant == null, scope keys absent. */
  verifyEmpty(): Promise<boolean>;
}

/**
 * Run every destructive stage with AGGREGATE error handling, then a close/reopen
 * verification. Resolves ONLY when all stages succeed and verification reads
 * empty; otherwise throws {@link ShadowPurgeIncompleteError} (the caller keeps the
 * tombstone + locked runtime for retry). Idempotent — safe to re-run on retry.
 */
export async function runShadowPurgeStages(stages: ShadowPurgeStages): Promise<void> {
  const reasons: string[] = [];
  // Authority material FIRST + INDEPENDENTLY, so a cache-reset failure can never
  // leave a reusable scope key / grant. Every handle is attempted.
  for (const h of stages.scopeKeyHandles) {
    try { await stages.deleteSecureItem(h); } catch (e) { reasons.push(`scopeKey[${h}]: ${errText(e)}`); }
  }
  try { await stages.clearGrant(); } catch (e) { reasons.push(`grant: ${errText(e)}`); }
  // Cache reset is attempted regardless of an authority-stage failure.
  try { await stages.resetCache(); } catch (e) { reasons.push(`cache: ${errText(e)}`); }

  let verifiedEmpty = false;
  try { verifiedEmpty = await stages.verifyEmpty(); } catch (e) { reasons.push(`verify: ${errText(e)}`); }

  if (reasons.length > 0 || !verifiedEmpty) throw new ShadowPurgeIncompleteError(reasons, verifiedEmpty);
}
