/**
 * shadowActionRuntime — Phase 3C3 production wiring of the `ShadowActionController` to the
 * accepted controller-UI store + React hooks. The action controller drives the six canonical
 * actions through the store's live `ProductionShadowController` (verified capability-gated
 * `actions.*` → encrypted command → relay → host executor); it re-checks the fresh verified
 * grant on every action and resets its in-flight attempts whenever the authority is lost.
 */
import { useSyncExternalStore } from 'react';
import * as Crypto from 'expo-crypto';
import { getShadowUiController } from './shadowUiControllerRuntime';
import { ShadowActionController } from './shadowActionController';
import type { ActionIntent } from './shadowActionController';
import { deriveReceipt, type ActionReceipt } from './shadowActionModel';
import { newIdempotencyKey } from './shadowActionIdempotency';

let singleton: ShadowActionController | null = null;

/** Secure CSPRNG from expo-crypto (fails closed if the native module is absent). */
function expoRandom(length: number): Uint8Array {
  const bytes = Crypto.getRandomBytes(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('expo-crypto CSPRNG unavailable');
  return bytes;
}

export function getShadowActionController(): ShadowActionController {
  if (singleton) return singleton;
  const ui = getShadowUiController();
  const ctrl = new ShadowActionController({
    getController: () => ui.liveController(),
    getGranted: () => ui.grantedCapabilities(),
    isOnline: () => ui.isOnline(),
    isLocked: () => ui.isActionLocked(),
    // The attempt-stable idempotency key is minted from the SAME secure CSPRNG as enrollment.
    newIdempotencyKey: () => newIdempotencyKey(expoRandom),
  });
  // A revoke / expiry / purge / account+host switch → discard all in-flight attempts.
  ui.subscribe(() => { if (ui.isActionLocked()) ctrl.reset(); });
  singleton = ctrl;
  return ctrl;
}

/** React subscription to the receipt for one action target (re-renders on lifecycle/delta). */
export function useActionReceipt(intent: ActionIntent | null): ActionReceipt {
  const ctrl = getShadowActionController();
  return useSyncExternalStore(
    ctrl.subscribe,
    () => (intent ? ctrl.receiptFor(intent) : deriveReceipt(undefined)),
    () => deriveReceipt(undefined),
  );
}

export function useActionController(): ShadowActionController { return getShadowActionController(); }
