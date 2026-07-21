/**
 * shadowProductionController — Phase 3A2b1 §4 PRODUCTION controller runtime surface
 * (NO visual UI). Assembles the accepted, verified components into ONE headless surface
 * a future screen consumes:
 *
 *   - `projection`   — a `ShadowProjectionView` read-model over the durable
 *                      `ShadowControllerService` (fail-closed read-only; survives
 *                      restart/offline per the accepted store policy).
 *   - `actions`      — a `VerifiedShadowActionApi` whose capability authorization is
 *                      derived DYNAMICALLY from `ShadowMobileEnrollmentRuntime.
 *                      verifiedApprovedCapabilities()` on EVERY call. There is NO
 *                      capability array in the production path — a revoke / downgrade /
 *                      lock / expiry / re-enrollment is honored on the next action with
 *                      no app restart, and a missing/unavailable set fails closed
 *                      (sends nothing). Production callers CANNOT inject capabilities.
 *   - `commandStatus`— durable per-command lifecycle (survives restart via the store).
 *   - `onChange`     — coalesced change subscription; `close()` disposes every listener
 *                      it handed out and stops the UI-independent renewal timer.
 *
 * Nothing connects on import; construction is lazy and only prepared once signed in.
 */
import { isAuthed } from './auth';
import { assembleProductionShadowController, type ProductionShadowController } from './shadowProductionControllerCore';
import {
  getShadowMobileEnrollmentRuntime,
  getShadowMobileControllerService,
  resetShadowMobileEnrollmentRuntimeDurable,
  ensureNoPendingPurge,
  shadowControllerResetGeneration,
} from './shadowEnrollmentRuntimeFactory';

export { assembleProductionShadowController, type ProductionShadowController } from './shadowProductionControllerCore';

let controllerPromise: Promise<ProductionShadowController | null> | null = null;

/**
 * Phase 3B0 NOTE-1: ONE serial lifecycle chain. Every reset and bootstrap is
 * enqueued here, so a bootstrap (rebuild / read / send) can NEVER begin until a
 * previously-enqueued durable reset has fully completed — closing the
 * fire-and-forget race where a new account read the old cache mid-purge. React's
 * synchronous `reset(); bootstrap();` therefore orders as purge → rebuild.
 */
let lifecycleChain: Promise<void> = Promise.resolve();

async function buildProductionController(): Promise<ProductionShadowController | null> {
  const genAtStart = shadowControllerResetGeneration();
  // O-1: refuse to build while a durable purge is pending — drive it to completion
  // first; if the purge (retry) fails, return null (LOCKED) and build/read NOTHING
  // (fail closed; prior-account grant/cache is never reused).
  try { await ensureNoPendingPurge(); }
  catch { return null; }
  const runtime = await getShadowMobileEnrollmentRuntime();
  const service = await getShadowMobileControllerService();
  if (!service) return null; // not yet enrolled — no controller surface
  await service.load(); // rehydrate durable status (offline read-only is fine)
  // `runtime` (ShadowMobileEnrollmentRuntime) satisfies VerifiedCapabilityProvider.
  const controller = assembleProductionShadowController(service, runtime);
  // Generation guard: a durable reset during the build means this controller was
  // assembled for a signed-out / previous account/host — discard it, never expose.
  if (shadowControllerResetGeneration() !== genAtStart) {
    try { controller.close(); } catch { /* nothing to close */ }
    return null;
  }
  return controller;
}

/**
 * Lazily construct the one production controller surface (null until enrolled).
 * Serialized behind the lifecycle chain so a read never races an in-flight purge.
 */
export function getProductionShadowController(): Promise<ProductionShadowController | null> {
  return lifecycleChain.then(() => {
    if (!controllerPromise) controllerPromise = buildProductionController();
    return controllerPromise;
  });
}

/**
 * Real startup reach from the app graph (App.tsx). Prepares the surface lazily ONLY when
 * signed in; opens no network (the durable service connects on demand later). Errors are
 * swallowed so an un-enrolled / offline device simply has no controller yet. This is a
 * genuine call — not a marker-only dead import. Enqueued on the lifecycle chain so it
 * runs strictly AFTER any pending durable reset.
 */
export function bootstrapShadowProductionController(): void {
  if (!isAuthed()) return;
  lifecycleChain = lifecycleChain.then(async () => {
    if (!isAuthed()) return; // identity dropped while queued → nothing to build
    controllerPromise = buildProductionController();
    await controllerPromise.catch(() => { /* not enrolled / offline → stays null */ });
  });
}

/**
 * Drop + close the surface AND durably purge prior-account state on sign-out /
 * account / host switch. Enqueued on the lifecycle chain and awaits the durable
 * wipe (SQLite entity cache + SecureStore scope key + grant meta) so a subsequent
 * bootstrap cannot read or send against the old account's plaintext cache.
 */
export function resetProductionShadowController(): void {
  lifecycleChain = lifecycleChain.then(async () => {
    const pending = controllerPromise;
    controllerPromise = null;
    if (pending) { try { const c = await pending; c?.close(); } catch { /* nothing to close */ } }
    await resetShadowMobileEnrollmentRuntimeDurable();
  }).catch(() => { /* fail-closed: singletons already dropped; keep the chain alive */ });
}

/**
 * Test/diagnostic hook: resolves once every queued lifecycle op (reset + bootstrap)
 * has settled — so a test can `await` the durable purge instead of racing it.
 */
export function awaitShadowControllerIdle(): Promise<void> {
  return lifecycleChain.then(() => undefined, () => undefined);
}
