/* shadowController — Phase 3C1 renderer view-model for the desktop "Controllers"
   Settings pane. Pure (no React, no IO): it maps the RAW `shadowHost*` wire shapes
   (from `MacOS/brain/shadow-host-dispatch.ts` + `shadow-enrollment-host.ts`) into a
   strict, allowlisted view model the UI renders.

   TRUTH CONTRACT (enforced by tests):
   - The mappers pick ONLY safe fields. Crypto material that rides on the wire —
     signing/agreement public keys, nonce, transcript hash — and internal ids
     (grantId, keyId, keyRotationId, fingerprint, epoch) are NEVER copied into the
     view model, so they can never reach a rendered surface.
   - Capability membership + order come from the authoritative shared vocabulary
     (`@maestro/realtime/shadowCapabilities`). Human labels are a LOCAL map, but the
     set of controls is derived only from the request's `requestedCapabilities`
     (never a static/global granted array).
   - Enrolled controllers carry no "online"/"last-seen" field on the wire, so the
     view model has none — the UI can never derive presence from render time.
   - Errors are mapped to a small bounded, generic vocabulary; a raw host error
     string is never surfaced. */

import {
  SHADOW_CAPABILITIES, isKnownCapability, type ShadowCapability,
} from '@maestro/realtime/shadowCapabilities';

/** The read floor every enrolled controller retains (host protocol). */
export const CONTROLLER_CAPABILITY_FLOOR: ShadowCapability = 'account.read';

const CANONICAL_INDEX = new Map<ShadowCapability, number>(
  SHADOW_CAPABILITIES.map((c, i) => [c, i] as const),
);

/** Human, product-native labels. Membership is decorative only — the authoritative
    capability set is always the wire data; an unknown token is dropped, never shown. */
export const CAPABILITY_LABEL: Record<ShadowCapability, string> = {
  'account.read': 'Read your projects & activity',
  'session.message': 'Send messages in a session',
  'job.start': 'Start jobs',
  'job.cancel': 'Cancel jobs',
  'approval.respond': 'Respond to approvals',
  'question.answer': 'Answer questions',
  'session.autopilot.set': 'Change session autopilot',
  'screen.view': 'View this Mac’s screen (view only · no audio)',
};

export function capabilityLabel(cap: ShadowCapability): string {
  return CAPABILITY_LABEL[cap] ?? cap;
}

/** Filter an arbitrary capability list to known tokens in canonical (signing) order. */
export function orderCapabilities(caps: readonly unknown[] | undefined): ShadowCapability[] {
  if (!Array.isArray(caps)) return [];
  const seen = new Set<ShadowCapability>();
  for (const c of caps) if (isKnownCapability(c)) seen.add(c);
  return [...seen].sort((a, b) => (CANONICAL_INDEX.get(a)! - CANONICAL_INDEX.get(b)!));
}

// ── RAW wire shapes (what the shadowHost* RPC returns) ────────────────────────

export interface ShadowHostStatusWire {
  signedIn: boolean;
  state: string;
  hostDeviceId: string | null;
  fingerprint: string | null;
  vaultAvailable: boolean;
  registered: boolean;
  epoch: number | null;
  activeSessions: number;
  controllers: number;
  lastError?: string;
  recoveryAvailable?: boolean;
}

export interface PendingRequestWire {
  sessionId: string;
  controllerDeviceId: string;
  signingPublicKey?: string;
  agreementPublicKey?: string;
  nonce?: string;
  requestedAt: number;
  transcriptHash?: string;
  authString: string;
  sessionExpiresAt: number;
  requestedCapabilities?: string[];
}

export interface ControllerWire {
  controllerDeviceId: string;
  grantId?: string;
  keyId?: string;
  status: string;
  expiresAt: number;
}

export interface ApproveGrantWire {
  grantId?: string;
  keyId?: string;
  controllerDeviceId: string;
  expiresAt: number;
  capabilities?: string[];
}

export interface RevokeReceiptWire {
  keyRotationId?: string;
  alreadyRevoked: boolean;
}

/** Phase 3D1 view-only screen-share status (metadata only — no frames/keys). */
export interface ScreenShareStatusWire {
  active: boolean;
  deviceLabel: string;
  sourceLabel: string;
  startedAtMs: number;
}

/** RAW result of `shadowHostCreateSession` (mirrors brain `CreateSessionResult`). The
    `qr` is the versioned `maestro-shadow://enroll?…` bootstrap carrying the one-time
    secret — NEVER log, persist, copy, or render it as text. */
export interface CreateSessionWire {
  sessionId: string;
  qr: string;
  expiresAt: number;
  hostFingerprint: string;
  hostAuthString: string;
}

// ── SAFE view models (what the UI renders) ────────────────────────────────────

export interface ControllerStatusView {
  signedIn: boolean;
  /** Host lifecycle: 'running' | 'starting' | 'stopped' | … — exact enum, no gloss. */
  state: string;
  online: boolean;
  hostDeviceId: string | null;
  registered: boolean;
  vaultAvailable: boolean;
  activeRequests: number;
  enrolledControllers: number;
  recoveryAvailable: boolean;
}

export interface PendingRequestView {
  sessionId: string;
  controllerDeviceId: string;
  requestedCapabilities: ShadowCapability[];
  requestedAt: number;
  sessionExpiresAt: number;
  authString: string;
}

export interface ControllerView {
  controllerDeviceId: string;
  /** Exact authority enum from the host record. */
  status: string;
  expiresAt: number;
}

export interface ApproveReceiptView {
  controllerDeviceId: string;
  capabilities: ShadowCapability[];
  expiresAt: number;
}

/**
 * SAFE enrollment-session view for the "Show enrollment code" sheet. `qr` is handed
 * ONLY to the LOCAL QR renderer (transient; never rendered/copied as text/aria/title/
 * logged); `sessionId` is retained solely to cancel the session and is NEVER displayed;
 * only `verificationPhrase` + `expiresAt` are shown to the operator. No fingerprint /
 * grant / key id is surfaced.
 */
export interface EnrollmentSessionView {
  sessionId: string;
  qr: string;
  expiresAt: number;
  verificationPhrase: string;
}

export function mapEnrollmentSession(w: CreateSessionWire): EnrollmentSessionView {
  return { sessionId: w.sessionId, qr: w.qr, expiresAt: w.expiresAt, verificationPhrase: w.hostAuthString };
}

/** UI phase derived truthfully from the host status. */
export type ControllerPhase = 'signed-out' | 'offline' | 'ready';

export function statusView(w: ShadowHostStatusWire): ControllerStatusView {
  const online = w.signedIn && (w.state === 'running' || w.state === 'starting');
  return {
    signedIn: w.signedIn,
    state: w.state,
    online,
    hostDeviceId: w.hostDeviceId,
    registered: w.registered,
    vaultAvailable: w.vaultAvailable,
    activeRequests: Number.isFinite(w.activeSessions) ? w.activeSessions : 0,
    enrolledControllers: Number.isFinite(w.controllers) ? w.controllers : 0,
    recoveryAvailable: w.recoveryAvailable === true,
  };
}

export function statusPhase(w: ShadowHostStatusWire): ControllerPhase {
  if (!w.signedIn) return 'signed-out';
  if (w.state !== 'running' && w.state !== 'starting') return 'offline';
  return 'ready';
}

/** Map a raw pending request → safe view. Crypto material + internal ids are dropped. */
export function mapPendingRequest(w: PendingRequestWire): PendingRequestView {
  return {
    sessionId: w.sessionId,
    controllerDeviceId: w.controllerDeviceId,
    requestedCapabilities: orderCapabilities(w.requestedCapabilities),
    requestedAt: w.requestedAt,
    sessionExpiresAt: w.sessionExpiresAt,
    authString: w.authString,
  };
}

/** Map a raw enrolled controller → safe view (no grantId/keyId; no online/last-seen). */
export function mapController(w: ControllerWire): ControllerView {
  return {
    controllerDeviceId: w.controllerDeviceId,
    status: w.status,
    expiresAt: w.expiresAt,
  };
}

export function mapApproveReceipt(w: ApproveGrantWire): ApproveReceiptView {
  return {
    controllerDeviceId: w.controllerDeviceId,
    capabilities: orderCapabilities(w.capabilities),
    expiresAt: w.expiresAt,
  };
}

/**
 * The exact `capabilities` payload for an approve call: the canonical-ordered subset
 * of THIS request's `requestedCapabilities` the operator selected, always retaining
 * the read floor when the controller requested it (the host re-intersects regardless).
 * Never widens beyond `requested`; never a static/global capability array.
 */
export function approvalCapabilities(
  requested: readonly ShadowCapability[],
  selected: ReadonlySet<ShadowCapability>,
): ShadowCapability[] {
  const req = orderCapabilities(requested);
  const reqSet = new Set(req);
  const chosen = new Set<ShadowCapability>();
  for (const c of req) if (selected.has(c)) chosen.add(c);
  if (reqSet.has(CONTROLLER_CAPABILITY_FLOOR)) chosen.add(CONTROLLER_CAPABILITY_FLOOR);
  return orderCapabilities([...chosen]);
}

/** True iff the capability is the mandatory read floor and was requested (→ locked-on). */
export function isFloorCapability(cap: ShadowCapability): boolean {
  return cap === CONTROLLER_CAPABILITY_FLOOR;
}

// ── bounded, generic error vocabulary (never a raw host string) ───────────────

export interface ApiErrorLike { status?: number; name?: string }

export function genericMutationError(e: unknown): string {
  const status = (e as ApiErrorLike | undefined)?.status;
  if (status === 401) return 'Your session ended. Sign in again to manage controllers.';
  if (status === 404 || status === 409 || status === 410) {
    return 'That request is no longer available — the list has been refreshed.';
  }
  return 'That action couldn’t be completed. Please try again.';
}

export function genericLoadError(): string {
  return 'Controllers are unavailable right now.';
}
