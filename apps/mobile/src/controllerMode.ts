/**
 * controllerMode — Phase 3C2 (corrected F2) persisted TOP-LEVEL secure-controller
 * authority mode. A minimal, NON-SECRET, account-scoped marker (AsyncStorage via
 * storage.ts) that decides the ROOT navigation tree: the legacy remote app vs. the
 * secure controller shell.
 *
 * Independence (the whole point): this marker is INDEPENDENT of the shadow grant /
 * scope key / SQLite cache — the durable shadow purge NEVER clears it. So a revoked /
 * expired / repair / purge-pending controller stays in the secure tree (locked /
 * re-enroll), never the legacy direct-API app. It is reset only by an explicit
 * deactivate (allowed before enrollment begins) or by sign-out (after the shadow
 * lifecycle's synchronous lock + durable purge). It holds NO key/grant/QR/secret.
 *
 * Account-scoped: the persisted value is a `{ [accountId]: true }` map, so account A's
 * mode never leaks to account B. `restoreControllerMode()` resolves the current
 * account id (get-session) BEFORE the root navigator chooses a tree; while the restore
 * is pending the app shows a neutral splash, never the legacy tabs.
 */
import { getStr, setStr } from './storage';
import { API_BASE, getSessionToken, isAuthed } from './auth';
import { sha256Hex } from './shadowClientCore';

/** Persisted map `{ [accountId]: true }`. Non-secret; survives the shadow purge. */
export const CONTROLLER_MODE_KEY = 'maestro.mobile.controllerMode';
const CONTROLLER_MODE_LAST_ACCOUNT_KEY = 'maestro.mobile.controllerModeLastAccount';
const CONTROLLER_MODE_LAST_TOKEN_BINDING_KEY = 'maestro.mobile.controllerModeLastTokenBinding';
const CONTROLLER_MODE_RESTORE_TIMEOUT_MS = 15_000;

function readMap(): Record<string, boolean> {
  try { const raw = getStr(CONTROLLER_MODE_KEY); return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}; }
  catch { return {}; }
}
function writeMap(m: Record<string, boolean>): void { setStr(CONTROLLER_MODE_KEY, JSON.stringify(m)); }
function readLastAccountId(): string | null {
  const raw = getStr(CONTROLLER_MODE_LAST_ACCOUNT_KEY);
  return raw || null;
}
function writeLastAccountId(accountId: string | null): void { setStr(CONTROLLER_MODE_LAST_ACCOUNT_KEY, accountId ?? ''); }
function readLastTokenBinding(): { accountId: string; digest: string } | null {
  try {
    const raw = getStr(CONTROLLER_MODE_LAST_TOKEN_BINDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { accountId?: unknown; digest?: unknown } | null;
    if (!parsed || typeof parsed.accountId !== 'string' || typeof parsed.digest !== 'string' || !parsed.accountId || !parsed.digest) return null;
    return { accountId: parsed.accountId, digest: parsed.digest };
  } catch { return null; }
}
function writeLastTokenBinding(binding: { accountId: string; digest: string } | null): void {
  setStr(CONTROLLER_MODE_LAST_TOKEN_BINDING_KEY, binding ? JSON.stringify(binding) : '');
}
async function tokenBindingDigest(token: string): Promise<string> {
  return sha256Hex(`controller-mode-token:v1:${token}`);
}

export type ControllerModeSnapshot =
  | { kind: 'pending' }
  | { kind: 'signed-out' }
  | { kind: 'inactive'; accountResolved: true }
  | { kind: 'active'; accountId: string }
  | { kind: 'resolution-error'; error: string };

let snapshot: ControllerModeSnapshot = { kind: 'pending' };
/** The account id for which secure-controller mode is currently active, else null. */
let activeAccountId: string | null = null;
let restoreGeneration = 0;
const subs = new Set<() => void>();
function notify(): void { for (const cb of [...subs]) { try { cb(); } catch { /* isolate */ } } }

export function subscribeControllerMode(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }
export function getControllerModeSnapshot(): ControllerModeSnapshot { return snapshot; }
export function isControllerModeRestored(): boolean { return snapshot.kind !== 'pending'; }
export function isControllerModeActive(): boolean { return snapshot.kind === 'active'; }
export function controllerModeNeedsResolutionRetry(): boolean { return snapshot.kind === 'resolution-error'; }
export function controllerModeResolutionError(): string | null {
  return snapshot.kind === 'resolution-error' ? snapshot.error : null;
}

let cachedAccount: { token: string; accountId: string } | null = null;
/** Resolve the signed-in account id from Better Auth get-session (cached per token). */
async function currentAccountId(): Promise<{ accountId: string | null; error: string | null }> {
  const token = getSessionToken();
  if (!token) return { accountId: null, error: null };
  if (cachedAccount && cachedAccount.token === token) return { accountId: cachedAccount.accountId, error: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CONTROLLER_MODE_RESTORE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    if (!res.ok) return { accountId: null, error: res.status === 401 ? null : `Network error (${res.status}) while verifying this account.` };
    const data = (await res.json().catch(() => null)) as { user?: { id?: string } } | null;
    const id = data?.user?.id ?? null;
    if (id) cachedAccount = { token, accountId: id };
    return { accountId: id, error: id ? null : 'Network error while verifying this account.' };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { accountId: null, error: 'Network timeout while verifying this account.' };
    }
    return { accountId: null, error: 'Network error while verifying this account.' };
  }
  finally { clearTimeout(timer); }
}

/**
 * Restore the marker for the CURRENT account before the root navigator chooses a tree.
 * Signed-out → inactive (restored). Signed-in → active iff the persisted map has this
 * account. A resolve failure fails to INACTIVE (never strands a user in a tree they
 * can't leave) but only after `restored` flips, so the splash clears.
 */
export async function restoreControllerMode(): Promise<void> {
  const myGeneration = ++restoreGeneration;
  const tokenAtStart = getSessionToken();
  if (!isAuthed() || !tokenAtStart) {
    activeAccountId = null;
    snapshot = { kind: 'signed-out' };
    notify();
    return;
  }
  const map = readMap();
  const fallbackId = readLastAccountId();
  const fallbackBinding = readLastTokenBinding();
  const { accountId: id, error } = await currentAccountId();
  const tokenNow = getSessionToken();
  if (myGeneration !== restoreGeneration || tokenNow !== tokenAtStart || !isAuthed()) return;
  if (id && map[id]) {
    activeAccountId = id;
    snapshot = { kind: 'active', accountId: id };
    const digest = await tokenBindingDigest(tokenAtStart);
    if (myGeneration !== restoreGeneration || getSessionToken() !== tokenAtStart || !isAuthed()) return;
    writeLastAccountId(id);
    writeLastTokenBinding({ accountId: id, digest });
  } else if (!id && error) {
    activeAccountId = null;
    snapshot = { kind: 'resolution-error', error };
  } else {
    activeAccountId = null;
    snapshot = { kind: 'inactive', accountResolved: true };
  }
  notify();
}

/** Activate secure-controller mode for the current account. Persists BEFORE navigation. */
export async function activateControllerMode(): Promise<boolean> {
  const token = getSessionToken();
  const { accountId: id } = await currentAccountId();
  if (!id) return false;
  const map = readMap(); map[id] = true; writeMap(map);
  writeLastAccountId(id);
  if (token) writeLastTokenBinding({ accountId: id, digest: await tokenBindingDigest(token) });
  activeAccountId = id;
  snapshot = { kind: 'active', accountId: id };
  notify();
  return true;
}

/**
 * Deactivate for the current account. Allowed ONLY before enrollment has begun (the
 * controller shell gates this) or as part of sign-out after the durable purge. Persists
 * the cleared marker so a cold restart lands on the legacy tree for this account.
 */
export async function deactivateControllerMode(): Promise<void> {
  const id = activeAccountId ?? (await currentAccountId()).accountId;
  if (id) { const map = readMap(); delete map[id]; writeMap(map); }
  if (id && readLastAccountId() === id) writeLastAccountId(null);
  if (id && readLastTokenBinding()?.accountId === id) writeLastTokenBinding(null);
  activeAccountId = null;
  snapshot = isAuthed() ? { kind: 'inactive', accountResolved: true } : { kind: 'signed-out' };
  notify();
}

/**
 * R1: the account id whose secure-controller mode is active RIGHT NOW (or null). Captured
 * BEFORE sign-out so its marker can be cleared afterwards (once the token — and thus the
 * account resolver — is gone). Never publishes state.
 */
export function activeControllerAccountId(): string | null { return activeAccountId; }

/**
 * R1: clear the persisted marker for a SPECIFIC account id (no session token required).
 * Called AFTER sign-out (auth already false), so its `notify()` only recomputes the root
 * to `auth`/`splash`, never `legacy`. A null id is a no-op clear (marker stays, fail-closed)
 * but still publishes the (auth-false) state.
 */
export function deactivateControllerModeForAccount(accountId: string | null): void {
  if (accountId) { const map = readMap(); delete map[accountId]; writeMap(map); }
  if (accountId && readLastAccountId() === accountId) writeLastAccountId(null);
  if (accountId && readLastTokenBinding()?.accountId === accountId) writeLastTokenBinding(null);
  activeAccountId = null;
  snapshot = isAuthed() ? { kind: 'inactive', accountResolved: true } : { kind: 'signed-out' };
  notify();
}

/**
 * Invalidate the in-memory view on an identity change (sign-in/out / account / host
 * switch) so the next `restoreControllerMode()` re-resolves against the new account.
 * Flips `restored` to false so the root navigator shows the neutral splash (never a
 * one-frame legacy flash) until the re-resolve completes.
 */
export function invalidateControllerMode(): void {
  restoreGeneration += 1;
  snapshot = { kind: 'pending' };
  activeAccountId = null;
  cachedAccount = null;
  notify();
}

/**
 * Defense-in-depth gate for the legacy direct-server screens. TRUE while secure-
 * controller mode is active for the current account. The ROOT navigator already
 * unmounts the entire legacy tree in active mode (so these screens never mount), but
 * any legacy screen that reads/mutates the account server directly ALSO calls this and
 * refuses to render/mutate when true — so a stray navigation / deep-link / cached route
 * can never bypass the shadow authority (an enrolled OR revoked/expired controller is
 * held here, never granted legacy mutation power). Named to make the intent explicit at
 * every call site: `requireShadowController` — legacy access is blocked when it holds.
 */
export function requireShadowController(): boolean { return isControllerModeActive(); }
