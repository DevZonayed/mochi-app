/**
 * shadowUiModel — Phase 3C2 PURE mobile controller UI view-model (NO react-native /
 * expo imports, so it runs under Node in vitest exactly like the accepted
 * `shadowProjectionSelectors` / `shadowProductionControllerCore`). The Expo-backed
 * observable wiring (runtime + production controller + auth lifecycle) lives in
 * `shadowUiController.ts`, which feeds this a plain snapshot.
 *
 * Responsibilities (and ONLY these — it never opens the network or touches storage):
 *   1. Collapse the REAL enrollment state machine (`EnrollmentStatus.state` from
 *      `ShadowMobileEnrollmentRuntime`) + the REAL durable controller authority
 *      (`ControllerServiceStatus` from `ShadowControllerService`) + auth/purge
 *      lifecycle flags into ONE truthful `ShadowUiPhase`. Locked/terminal authority
 *      ALWAYS wins over any cached content (zero stale flash).
 *   2. Decide, per phase, whether read-only projection content may render at all
 *      (`projectionVisible`). Content is surfaced ONLY when the authority is live
 *      (`online`/`offline`) — a revoke/expiry/mismatch/purge synchronously blanks it.
 *   3. Map ONLY safe, authoritative fields into the enrollment/pending display
 *      (short device id, host fingerprint, verification phrase + expiry WHEN the real
 *      contract supplies them, capability LABELS). Never crypto/nonce/transcript/raw.
 *
 * No fabricated fields: an absent optional is omitted (never 0 / "now" / a fake
 * count/percent/timer). The capability label map is DECORATIVE — the authoritative
 * grant is always the verified wire set (`verifiedApprovedCapabilities`).
 */
import type { EnrollmentState, EnrollmentStatus } from './shadowEnrollmentClient';
import type { ControllerServiceStatus } from './shadowControllerService';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';

/** The clock skew the durable service itself uses before it treats a lease as lapsed. */
export const UI_LEASE_SKEW_MS = 1_000;

/**
 * The user-visible controller phase. Driven entirely from real authority — never a
 * local component boolean. `repair` is the fail-closed integrity lock (a tampered /
 * unusable persisted grant); recovery is re-enrollment after purge.
 */
export type ShadowUiPhase =
  | 'loading'      // hydrating / building / a durable purge is in flight → render nothing sensitive
  | 'unenrolled'   // signed in but no controller grant yet → offer to enroll
  | 'confirming'   // bootstrap parsed; operator confirms the host fingerprint before requesting
  | 'requesting'   // signed request in flight to the relay
  | 'pending'      // awaiting desktop approval (truthful wait — no fake progress)
  | 'approving'    // grant accepted; bootstrapping the encrypted local shadow
  | 'online'       // live authority + connected → read-only content is current
  | 'offline'      // live authority, not connected → last verified shadow (stale marker)
  | 'denied'       // host denied the request (recoverable: start over)
  | 'expired'      // enrollment session expired before approval (recoverable: start over)
  | 'revoked'      // host revoked / authority lost (locked; re-enroll after purge)
  | 'repair';      // persisted grant integrity lock (locked; re-enroll after purge)

/** Phases where the authority is LIVE and read-only projection content may render. */
const CONTENT_PHASES: ReadonlySet<ShadowUiPhase> = new Set<ShadowUiPhase>(['online', 'offline']);
/** Phases that are hard-locked (no content, recovery only through re-enrollment/purge). */
const LOCKED_PHASES: ReadonlySet<ShadowUiPhase> = new Set<ShadowUiPhase>(['revoked', 'repair']);
/** Terminal enrollment outcomes the operator can retry from a clean idle. */
const RETRYABLE_PHASES: ReadonlySet<ShadowUiPhase> = new Set<ShadowUiPhase>(['denied', 'expired']);

export function projectionVisible(phase: ShadowUiPhase): boolean { return CONTENT_PHASES.has(phase); }
export function isLockedPhase(phase: ShadowUiPhase): boolean { return LOCKED_PHASES.has(phase); }
export function isRetryablePhase(phase: ShadowUiPhase): boolean { return RETRYABLE_PHASES.has(phase); }

/** Safe, authoritative-only enrollment display fields for the gate screens. */
export interface EnrollmentDisplay {
  /** Truncated controller (this device) id — decorative, never a security signal. */
  controllerDeviceIdShort: string | null;
  /** Truncated host signing fingerprint the operator can compare — safe public id. */
  hostFingerprintShort: string | null;
  /** The signed-in account id (public) or null. */
  accountId: string | null;
  /** Human capability labels for what THIS controller requested (read-only slice: read). */
  requestedCapabilityLabels: string[];
  /** Phase 3C3: the CURRENT verified GRANTED capabilities (never requested/static). Drives
      which action controls render + the "granted permissions" list. Empty when no grant. */
  grantedCapabilities: ShadowCapability[];
  /** Human labels for the granted capabilities (the read floor + any granted action families). */
  grantedCapabilityLabels: string[];
  /** A bounded, generic reason for a terminal/error phase (never raw diagnostics). */
  errorReason: string | null;
}

/** Connectivity snapshot mirrored from the durable service (truthful offline/locked). */
export interface ShadowUiConnection {
  online: boolean;
  locked: boolean;
  /** Last applied host sequence (authoritative), or null if none yet. */
  lastSeq: number | null;
  /**
   * Authoritative stored activity timestamp to show beside an offline marker, or null
   * when unknown. NEVER `now`/0 — an unknown last-updated is omitted, not fabricated.
   */
  lastActivityAt: number | null;
}

export interface ShadowUiState {
  phase: ShadowUiPhase;
  /** True while a request/approval/bootstrap is genuinely in flight (truthful, no timer). */
  busy: boolean;
  /** True iff read-only projection content may render in this phase. */
  contentVisible: boolean;
  /** True iff the phase is hard-locked (re-enroll only). */
  locked: boolean;
  /** True iff a terminal enrollment outcome the operator may retry (denied/expired). */
  retryable: boolean;
  enrollment: EnrollmentDisplay;
  connection: ShadowUiConnection;
}

/** The plain, serializable snapshot the observable controller feeds the pure derive. */
export interface ShadowUiInputs {
  /** Whether the account session is present (the gate only appears after auth). */
  authed: boolean;
  /** A durable purge tombstone is set / being drained → fail closed to `loading`. */
  purgePending: boolean;
  /** `ShadowMobileEnrollmentRuntime.status()`, or null before the runtime is built. */
  enrollment: EnrollmentStatus | null;
  /** `ShadowControllerService.status()`, or null before a grant/service exists. */
  service: ControllerServiceStatus | null;
  /** Max authoritative entity activity timestamp (for the offline marker), or null. */
  lastActivityAt: number | null;
  /** Phase 3C3: the CURRENT verified granted capabilities (from the runtime), or null. */
  granted?: ShadowCapability[] | null;
  /** Monotonic wall clock (injected for testability). */
  now: number;
}

// ── capability labels (decorative mirror of the desktop CAPABILITY_LABEL) ────────

const CAPABILITY_LABEL: Record<ShadowCapability, string> = {
  'account.read': 'Read your projects & activity',
  'session.message': 'Send messages in a session',
  'job.start': 'Start jobs',
  'job.cancel': 'Cancel jobs',
  'approval.respond': 'Respond to approvals',
  'question.answer': 'Answer questions',
  'session.autopilot.set': 'Change session autopilot',
  'screen.view': 'View your Mac screen (view only · no audio)',
};
export function capabilityLabel(cap: ShadowCapability): string { return CAPABILITY_LABEL[cap] ?? cap; }

/** Truncate a long opaque id for display (never a security decision). */
export function shortId(id: string | null | undefined): string | null {
  if (!id || typeof id !== 'string') return null;
  return id.length > 22 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id;
}

/**
 * A generic, bounded reason string for a terminal/error phase. NEVER surfaces raw
 * runtime diagnostics (paths, tokens, stack) — maps known families to product copy
 * and collapses everything else to one neutral sentence.
 */
export function genericEnrollmentError(reason: string | undefined, phase: ShadowUiPhase): string | null {
  if (phase === 'denied') return 'This Mac declined the request.';
  if (phase === 'expired') return 'The enrollment window expired before it was approved.';
  if (phase === 'revoked') return 'Access was revoked from your Mac.';
  if (phase === 'repair') return 'This device’s saved access is no longer valid.';
  if (!reason) return null;
  // Any residual runtime reason is intentionally NOT shown verbatim.
  return 'Something went wrong. Please try again.';
}

// ── the pure derive ──────────────────────────────────────────────────────────

function phaseFromEnrollment(state: EnrollmentState): ShadowUiPhase | null {
  switch (state) {
    case 'idle': case 'cancelled': case 'error': return 'unenrolled';
    case 'parsing': case 'confirming': return 'confirming';
    case 'requesting': return 'requesting';
    case 'awaiting-host': return 'pending';
    // `accepted` and `online` are BOTH grant-live: the durable SERVICE authority
    // decides online/offline/locked. (`accepted` shows a transient `approving` only
    // until the controller connects — handled in deriveShadowUiPhase.)
    case 'accepted': return null;
    case 'denied': return 'denied';
    case 'expired': return 'expired';
    case 'revoked': return 'revoked';
    case 'locked': return 'repair';
    case 'online': return null; // grant is live — the durable SERVICE authority decides online/offline
    default: return null;
  }
}

/**
 * Collapse the real runtime + service + lifecycle snapshot into one truthful phase.
 * PRECEDENCE (fail closed): unauthenticated → purge-in-flight → a locked SERVICE
 * (host revoke / 401 / 403) → the enrollment state machine → the live service
 * connection. A locked/terminal authority ALWAYS beats cached content.
 */
export function deriveShadowUiPhase(inp: ShadowUiInputs): ShadowUiPhase {
  if (!inp.authed) return 'unenrolled';
  if (inp.purgePending) return 'loading';
  // The durable service locks ONLY on an observed revoke / 401 / 403 — it beats any
  // cached projection so a revoked device can never flash old projects.
  if (inp.service?.locked) return 'revoked';

  const e = inp.enrollment;
  if (e) {
    const mapped = phaseFromEnrollment(e.state);
    if (mapped) return mapped;
    // e.state === 'online' (grant active) → defer to the durable service authority.
  } else {
    // No runtime yet: hydrating.
    return 'loading';
  }

  const svc = inp.service;
  if (svc) {
    if (svc.locked) return 'revoked';
    // A lapsed renewable lease is truthful OFFLINE read-only (the service auto-reconciles
    // host-signed renewals); it is NOT a terminal re-enroll. Enrollment-session expiry is
    // the terminal `expired` above.
    return svc.online ? 'online' : 'offline';
  }
  // No durable service yet: a freshly `accepted` grant is still bootstrapping the
  // encrypted local shadow (`approving`); a restored `online` grant is last-verified
  // offline read-only until a connect. Never 'online' without a live service.
  return e?.state === 'accepted' ? 'approving' : 'offline';
}

export function deriveShadowUiState(inp: ShadowUiInputs): ShadowUiState {
  const phase = deriveShadowUiPhase(inp);
  const e = inp.enrollment;
  const svc = inp.service;
  const busy = phase === 'requesting' || phase === 'approving' || phase === 'loading';
  // The CURRENT verified granted set (never a requested/static list). Only surfaced when the
  // grant is live (online/offline) — a locked/terminal authority shows no granted actions.
  const granted = (phase === 'online' || phase === 'offline') && Array.isArray(inp.granted) ? inp.granted : [];
  const enrollment: EnrollmentDisplay = {
    controllerDeviceIdShort: shortId(e?.controllerDeviceId ?? null),
    hostFingerprintShort: shortId(e?.hostFingerprint ?? null),
    accountId: e?.accountId ?? null,
    // Read-only slice floor: every controller at least requests read access.
    requestedCapabilityLabels: [capabilityLabel('account.read')],
    grantedCapabilities: granted,
    grantedCapabilityLabels: granted.map(capabilityLabel),
    errorReason: genericEnrollmentError(e?.lastError, phase),
  };
  const connection: ShadowUiConnection = {
    online: phase === 'online',
    locked: isLockedPhase(phase) || !!svc?.locked,
    lastSeq: svc?.lastSeq ?? null,
    // Only an authoritative, positive stored timestamp — otherwise omitted (null).
    lastActivityAt: typeof inp.lastActivityAt === 'number' && inp.lastActivityAt > 0 ? inp.lastActivityAt : null,
  };
  return {
    phase,
    busy,
    contentVisible: projectionVisible(phase),
    locked: isLockedPhase(phase),
    retryable: isRetryablePhase(phase),
    enrollment,
    connection,
  };
}
