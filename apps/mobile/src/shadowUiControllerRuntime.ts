/**
 * shadowUiControllerRuntime — Phase 3C2 production wiring of the `ShadowUiController`
 * observable store to the accepted app graph, plus the React hooks the screens use.
 * Mirrors the accepted core/view split: the pure store + view-model are node-tested
 * (`shadowUiController.ts` / `shadowUiModel.ts`); the Expo/graph binding lives here.
 *
 * Every dependency is the ALREADY-ACCEPTED production seam — no new cache, no direct
 * server product read:
 *   - runtime  : `getShadowMobileEnrollmentRuntime()` (real enrollment state machine)
 *   - grant    : `getProductionShadowController()` / `bootstrap…` / `reset…` / `awaitIdle`
 *   - identity : `subscribeSession` / `subscribeActiveHost` (auth.ts)
 * The durable purge gate + generation guards live inside those factory functions.
 */
import { useSyncExternalStore } from 'react';
import { isAuthed, subscribeSession, subscribeActiveHost } from './auth';
import { getShadowMobileEnrollmentRuntime } from './shadowEnrollmentRuntimeFactory';
import {
  getProductionShadowController,
  bootstrapShadowProductionController,
  resetProductionShadowController,
  awaitShadowControllerIdle,
} from './shadowProductionController';
import { ShadowUiController, type EnrollmentRuntimeLike } from './shadowUiController';
import type { ShadowUiState } from './shadowUiModel';

let singleton: ShadowUiController | null = null;

/** The one production controller-UI store (started lazily, once signed-in flows begin). */
export function getShadowUiController(): ShadowUiController {
  if (singleton) return singleton;
  singleton = new ShadowUiController({
    isAuthed,
    getRuntime: async () => (await getShadowMobileEnrollmentRuntime()) as unknown as EnrollmentRuntimeLike,
    getController: () => getProductionShadowController(),
    bootstrapController: bootstrapShadowProductionController,
    resetController: resetProductionShadowController,
    awaitIdle: awaitShadowControllerIdle,
    subscribeSession,
    subscribeActiveHost,
    now: Date.now,
  });
  singleton.start();
  return singleton;
}

/** React subscription to the current truthful controller-UI state. */
export function useShadowUi(): ShadowUiState {
  const store = getShadowUiController();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The store instance (for imperative gate actions from screens). */
export function useShadowUiController(): ShadowUiController {
  return getShadowUiController();
}
