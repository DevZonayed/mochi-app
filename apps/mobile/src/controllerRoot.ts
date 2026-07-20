/**
 * controllerRoot — Phase 3C2 residual (R1) pure root-tree decision + the race-free
 * secure sign-out orchestration. No react-native / expo imports, so `navigation.tsx`
 * uses `chooseRootTree` for its ROOT decision and `ShadowShell` uses
 * `signOutSecureController` with production deps, while both are unit-testable under Node.
 */

export type RootTree = 'auth' | 'splash' | 'controller' | 'legacy';

/**
 * The single source of truth for the ROOT navigation tree. `legacy` (the direct-server
 * tab app) is chosen ONLY when the user is authenticated, the controller-mode marker has
 * restored, and secure-controller mode is INACTIVE. Any sign-out / account-switch path
 * must therefore clear auth (or flip to `splash`) BEFORE `active` becomes false, or a
 * `legacy` commit leaks for one frame.
 */
export function chooseRootTree(authed: boolean, restored: boolean, active: boolean, indeterminate = false): RootTree {
  if (!authed) return 'auth';
  if (!restored || indeterminate) return 'splash';
  return active ? 'controller' : 'legacy';
}

export interface SecureSignOutDeps {
  /** Schedule the durable shadow lock + purge (marker-independent). */
  resetController: () => void;
  /** End the account session — clears the token SYNCHRONOUSLY before any network await. */
  signOut: () => Promise<void>;
  /** The account id whose secure-controller marker is active RIGHT NOW (captured while authed). */
  captureAccountId: () => string | null;
  /** Clear the persisted marker for a specific account id (no token needed). */
  deactivateForAccount: (accountId: string | null) => void;
}

/**
 * R1 fix — sign out of the secure controller WITHOUT ever committing the legacy tree.
 * Ordering:
 *   1. capture the active account id (while still authed — needed to clear its marker later);
 *   2. schedule the shadow lock + purge (does not touch auth or the marker);
 *   3. `await signOut()` — its FIRST synchronous act clears the session token, so every
 *      subsequent store notification computes `authed=false` → `chooseRootTree` returns
 *      `auth`/`splash`, NEVER `legacy` (the marker is still `active` at that point, but auth
 *      is already gone, so `active` is never observed while `authed`);
 *   4. clear the captured account's marker LAST (auth is already false → still no `legacy`).
 *
 * If `signOut()` rejects or hangs, step 4 is skipped → the marker stays set (fail-closed,
 * secure), and because the token was cleared synchronously in step 3 the root remains on
 * `splash`/`auth`, never `legacy`.
 */
export async function signOutSecureController(deps: SecureSignOutDeps): Promise<void> {
  const accountId = deps.captureAccountId();
  try { deps.resetController(); } catch { /* best-effort lock/purge */ }
  await deps.signOut();
  try { deps.deactivateForAccount(accountId); } catch { /* fail-closed: marker stays if cleanup can't complete */ }
}
