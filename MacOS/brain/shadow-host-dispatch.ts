/**
 * shadow-host-dispatch — Phase 3A2a trusted local dispatch allowlist for the
 * desktop host enrollment runtime. The sidecar bootstrap (`headless-main.ts`)
 * resolves the per-account runtime singleton and delegates every `shadowHost*`
 * method through this exact allowlist, so the surface 3A2b calls is the real,
 * tested one (not a disconnected helper). No auto-approval; the QR is returned
 * only from the explicit create call; no private/scope/verifier bytes are ever
 * returned.
 */
import type { ShadowHostEnrollmentRuntime } from './shadow-enrollment-host.js';
import type { ScreenShareStatus } from './shadow-screen-registry.js';

export const SHADOW_HOST_METHODS = [
  'shadowHostStatus',
  'shadowHostCreateSession',
  'shadowHostListPending',
  'shadowHostApprove',
  'shadowHostDeny',
  'shadowHostCancel',
  'shadowHostListControllers',
  'shadowHostRevoke',
  'shadowHostRecoverExpiredController',
  'shadowHostPurgeServerOrphans',
  // Phase 3D1 view-only screen share — read-only status + local Stop. NOT enrollment
  // methods; they read/act on the in-process screen-share registry (metadata only).
  'shadowHostScreenStatus',
  'shadowHostScreenStop',
] as const;

export type ShadowHostMethod = (typeof SHADOW_HOST_METHODS)[number];

export interface ShadowHostDispatchDeps {
  /** Whether an account session token is currently present. */
  signedIn(): boolean;
  /** Stable per-Mac device id (deck) for the not-signed-in status shape. */
  hostDeviceId(): string;
  /** Whether the OS secure vault is currently available. */
  vaultAvailable(): boolean;
  /** Resolve the lifecycle-managed runtime for the signed-in account. */
  getRuntime(): Promise<ShadowHostEnrollmentRuntime>;
  /** Best-effort start (idempotent) before a mutating/reading op. */
  ensureStarted(rt: ShadowHostEnrollmentRuntime): Promise<void>;
  /**
   * Phase 3B0 NOTE-2: invoked AFTER a successful controller revoke so the live
   * data plane can immediately deny the revoked controller and rebuild under the
   * rotated scope key. Best-effort; a hook failure never fails the revoke result.
   */
  afterRevoke?(rt: ShadowHostEnrollmentRuntime): Promise<void> | void;
  /**
   * Invoked AFTER a successful controller approval so the live data plane is
   * rebuilt/resumed immediately when the prior plane was absent or closed.
   */
  afterApprove?(rt: ShadowHostEnrollmentRuntime): Promise<void> | void;
  /** Phase 3D1: the current view-only screen-share status (metadata only). */
  screenShareStatus?(): ScreenShareStatus;
  /** Phase 3D1: operator-initiated local "Stop sharing" (tears the stream down). */
  screenShareStop?(): Promise<{ ok: true }>;
}

function fail(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function isShadowHostMethod(method: string): method is ShadowHostMethod {
  return (SHADOW_HOST_METHODS as readonly string[]).includes(method);
}

/**
 * Build the `shadowHost*` dispatch handler. Unknown `shadowHost*` methods are
 * rejected with 404 (strict allowlist).
 */
export function createShadowHostDispatch(deps: ShadowHostDispatchDeps) {
  return async function shadowHostDispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!isShadowHostMethod(method)) throw fail('unknown shadowHost method', 404);

    // Phase 3D1 screen-share status/stop are registry-backed (independent of the
    // enrollment runtime) and always safe to serve: status is metadata-only and Stop
    // is a local teardown. Handled before the signed-in gate so the desktop UI can
    // poll them without a session dependency.
    if (method === 'shadowHostScreenStatus') {
      return deps.screenShareStatus ? deps.screenShareStatus() : { active: false, deviceLabel: '', sourceLabel: '', startedAtMs: 0 };
    }
    if (method === 'shadowHostScreenStop') {
      return deps.screenShareStop ? await deps.screenShareStop() : { ok: true };
    }

    // Status is readable while signed out (reports not-signed-in + vault state).
    if (method === 'shadowHostStatus' && !deps.signedIn()) {
      return {
        signedIn: false, state: 'stopped', hostDeviceId: deps.hostDeviceId(), fingerprint: null,
        vaultAvailable: deps.vaultAvailable(), registered: false, epoch: null, activeSessions: 0, controllers: 0,
      };
    }
    if (!deps.signedIn()) throw fail('not signed in', 401);

    const rt = await deps.getRuntime();
    switch (method) {
      case 'shadowHostStatus':
        await deps.ensureStarted(rt);
        return { signedIn: true, ...rt.status() };
      case 'shadowHostCreateSession':
        await deps.ensureStarted(rt);
        // The ONLY method returning the QR/deep-link (with the one-time secret).
        return await rt.createEnrollmentSession({ ttlMs: typeof params.ttlMs === 'number' ? params.ttlMs : undefined });
      case 'shadowHostListPending':
        await deps.ensureStarted(rt);
        return { requests: await rt.listPendingRequests() };
      case 'shadowHostApprove':
        await deps.ensureStarted(rt);
        {
          const result = await rt.approve({
          sessionId: String(params.sessionId ?? ''),
          controllerName: params.controllerName != null ? String(params.controllerName) : undefined,
          controllerPlatform: params.controllerPlatform != null ? String(params.controllerPlatform) : undefined,
          // Host-selected approved capability set (least privilege); undefined = legacy read-only.
          capabilities: Array.isArray(params.capabilities) ? (params.capabilities as string[]).filter((c): c is import('@maestro/realtime/shadowCapabilities').ShadowCapability => typeof c === 'string') : undefined,
          });
          try { await deps.afterApprove?.(rt); } catch { /* live-plane resume is best-effort */ }
          return result;
        }
      case 'shadowHostDeny':
        await deps.ensureStarted(rt);
        await rt.deny({ sessionId: String(params.sessionId ?? '') });
        return { ok: true };
      case 'shadowHostCancel':
        await deps.ensureStarted(rt);
        await rt.cancel({ sessionId: String(params.sessionId ?? '') });
        return { ok: true };
      case 'shadowHostListControllers':
        await deps.ensureStarted(rt);
        if (rt.status().state === 'running') return { controllers: await rt.listControllers() };
        if (rt.status().recoveryAvailable) return { controllers: await rt.listControllersForRecovery() };
        return { controllers: [] };
      case 'shadowHostRevoke': {
        await deps.ensureStarted(rt);
        const result = await rt.revoke({ controllerDeviceId: String(params.controllerDeviceId ?? '') });
        // Phase 3B0 NOTE-2: propagate the revocation + scope-key rotation to the live
        // data plane immediately (best-effort; never fails the revoke response).
        try { await deps.afterRevoke?.(rt); } catch { /* live-plane refresh is best-effort */ }
        return result;
      }
      case 'shadowHostPurgeServerOrphans': {
        await deps.ensureStarted(rt);
        const result = await rt.purgeServerOrphans();
        try { await deps.afterRevoke?.(rt); } catch { /* live-plane refresh is best-effort */ }
        return result;
      }
      case 'shadowHostRecoverExpiredController': {
        const result = await rt.recoverExpiredLeaseController({ controllerDeviceId: String(params.controllerDeviceId ?? '') });
        try { await deps.afterRevoke?.(rt); } catch { /* live-plane refresh is best-effort */ }
        return result;
      }
      default:
        throw fail('unknown shadowHost method', 404);
    }
  };
}
