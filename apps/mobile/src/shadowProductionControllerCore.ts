/**
 * shadowProductionControllerCore — Phase 3A2b1 §4 PURE assembly of the production
 * controller surface (NO react-native / expo / auth imports, so it is unit-testable in
 * node). The Expo-backed lazy wiring (singleton + bootstrap + account-switch reset) lives
 * in `shadowProductionController.ts`, which re-exports this. This mirrors the accepted
 * `shadowClientCore` ↔ `shadowClient` split.
 */
import type { CommandLifecycleState } from '@maestro/realtime';
import { ShadowProjectionView, type ProjectionSnapshot } from './shadowProjectionSelectors';
import { VerifiedShadowActionApi, type VerifiedCapabilityProvider } from './shadowActionBuilders';
import type { ShadowControllerService, ControllerServiceStatus } from './shadowControllerService';

export interface ProductionShadowController {
  /** Read-model view (immutable snapshots + typed lists); fail-closed read-only. */
  readonly projection: ShadowProjectionView;
  /** Dynamic, capability-verified action API (no snapshot; re-checks on each call). */
  readonly actions: VerifiedShadowActionApi;
  /** Current service status (connection/lock/lease). */
  status(): ControllerServiceStatus;
  /** Immutable projection snapshot (projects + connection). */
  snapshot(): ProjectionSnapshot;
  /** Durable command lifecycle by id (survives restart). */
  commandStatus(commandId: string): CommandLifecycleState | undefined;
  /** Subscribe to coalesced projection/status changes; returns an unsubscribe fn. */
  onChange(fn: () => void): () => void;
  /**
   * Phase 3C2: bring the durable read authority online — reconcile the server lease,
   * pull + durably apply the host event delta, then poll ACKs. Read-only in this slice
   * (no command send). Returns the number of events applied. Safe to call repeatedly;
   * on a locked/denied authority it fails closed (the service throws / stays offline).
   */
  connect(): Promise<number>;
  /** Tear down: dispose every subscription handed out + stop the renewal timer. */
  close(): void;
}

/**
 * Assemble the surface from an already-constructed durable service and a VERIFIED
 * capability provider. This factory never takes a capability array, so no caller can
 * hand it an elevated snapshot — the action API always derives authorization from the
 * provider on each call.
 */
export function assembleProductionShadowController(
  service: ShadowControllerService,
  provider: VerifiedCapabilityProvider,
): ProductionShadowController {
  const subs = new Set<() => void>();
  let closed = false;
  const projection = new ShadowProjectionView(service);
  // TRUTHFUL gate: the action API is authorized ONLY when BOTH (a) the runtime's verified
  // signed grant still yields the capability AND (b) the controller SERVICE authority is
  // usable (not locked by a host revoke / 401 / 403, and the lease has not expired). The
  // service is the actively-driven signal (its auto-reconcile locks on revocation), so a
  // host revoke / lease-expiry flips the gate to "unavailable" on the next call — no restart.
  const gatedProvider: VerifiedCapabilityProvider = {
    verifiedApprovedCapabilities: async () => {
      if (service.isLocked() || service.leaseExpired()) return null;
      return provider.verifiedApprovedCapabilities();
    },
  };
  const actions = new VerifiedShadowActionApi(
    { sendCommand: (method, params) => service.sendCommand(method, params) },
    gatedProvider,
  );
  // Drive the service's authority reconcile so a host revoke actually reaches the local gate.
  try { service.startAutoReconcile(); } catch { /* fake/offline service — gate still fail-closed */ }
  return {
    projection,
    actions,
    status: () => service.status(),
    snapshot: () => projection.snapshot(),
    commandStatus: (commandId) => service.getCommand(commandId),
    connect: async () => {
      if (closed) return 0;
      // The service fails closed on a locked/denied authority; the caller treats a
      // throw as "stay offline read-only" (never fabricates online).
      return service.connect();
    },
    onChange: (fn) => {
      if (closed) return () => { /* already closed */ };
      const un = service.onProjectionChange(fn);
      subs.add(un);
      return () => { if (subs.delete(un)) un(); };
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const un of [...subs]) { try { un(); } catch { /* isolate listener disposal */ } }
      subs.clear();
      try { service.stopAutoReconcile(); } catch { /* best-effort */ }
      // Fully release authority: lock + wipe the in-memory scope key + HKDF rings so no key
      // survives a sign-out / account switch (belt-and-braces with resetShadowMobileEnrollmentRuntimeDurable).
      try { service.lock('controller-closed'); } catch { /* best-effort */ }
    },
  };
}
