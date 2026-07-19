/**
 * shadowCapabilities — Phase 3A2b1 versioned, canonical controller capability
 * model (Section A). An enrolled controller is granted the LEAST privilege the
 * host explicitly approves; the approved set is canonicalised, bounded, and bound
 * into the host-signed enrollment grant transcript (see `shadowEnrollment.ts`) so
 * any tamper / downgrade / extra / unknown capability breaks the grant signature
 * and fails closed.
 *
 * Trust rules enforced here:
 *   - A controller may only ever REQUEST capabilities; the HOST chooses/subsets
 *     the approved set. `intersectApprovedCapabilities` guarantees the approved
 *     set is a subset of what was requested — a controller can never self-grant.
 *   - The default / legacy capability set is `account.read` ONLY. A grant that
 *     carries no capability field is treated as `account.read` at the check layer.
 *   - Canonicalisation is deterministic (dedupe + fixed canonical order), so the
 *     signed byte string is stable regardless of caller ordering, and bounded
 *     (known-enum only, count + string-length limits) so a malformed/oversized
 *     set is rejected before it can be bound or checked.
 *
 * This module is pure (no ambient time/RNG/IO) and shared by host, server and
 * mobile so all three tiers agree on the exact canonical form and bounds.
 */

/** Bump when the canonical capability vocabulary changes shape. */
export const SHADOW_CAPABILITY_VERSION = 1 as const;

/**
 * The complete, ordered canonical capability vocabulary. Order here IS the
 * canonical sort order used for signing/binding — never reorder or remove without
 * a version bump. APPENDING a new capability at the end is signature-compatible
 * (the canonical string for any set that excludes the new token is byte-identical
 * to before, so previously-signed grants still verify), which is why
 * {@link SHADOW_CAPABILITY_VERSION} stays at 1 across the `screen.view` addition.
 *
 * `account.read` is the read floor. The six MUTATING action families
 * (`session.message` … `session.autopilot.set`) each map onto exactly one
 * controller method (see {@link CONTROLLER_METHOD_CAPABILITY}). `screen.view`
 * (Phase 3D1) is a SEPARATE, non-action grant capability: it gates ephemeral,
 * view-only live screen streaming (a distinct E2EE stream protocol) and is
 * deliberately NOT part of {@link CONTROLLER_METHOD_CAPABILITY} nor any durable
 * command method — no controller method maps to it, so it can never be dispatched
 * as a durable action. It still flows through the exact same host-signed enrollment
 * request/approve subset machinery so a tampered/self-granted `screen.view` breaks
 * the grant signature and fails closed.
 */
export const SHADOW_CAPABILITIES = [
  'account.read',
  'session.message',
  'job.start',
  'job.cancel',
  'approval.respond',
  'question.answer',
  'session.autopilot.set',
  'screen.view',
] as const;

export type ShadowCapability = (typeof SHADOW_CAPABILITIES)[number];

/** The default / legacy capability set: read-only, least privilege. */
export const SHADOW_DEFAULT_CAPABILITIES: readonly ShadowCapability[] = ['account.read'];

/**
 * The six MUTATING durable action-family capabilities (everything except the
 * `account.read` read floor and the non-action `screen.view`). This is the exact
 * set that maps 1:1 onto {@link CONTROLLER_METHOD_CAPABILITY}; consumers that need
 * "just the durable actions" must use this, never the whole vocabulary.
 */
export const SHADOW_ACTION_CAPABILITIES: readonly ShadowCapability[] = [
  'session.message',
  'job.start',
  'job.cancel',
  'approval.respond',
  'question.answer',
  'session.autopilot.set',
];

/**
 * The single capability that gates ephemeral view-only live screen streaming
 * (Phase 3D1). NOT an action family, NOT in {@link CONTROLLER_METHOD_CAPABILITY}.
 */
export const SHADOW_SCREEN_VIEW_CAPABILITY = 'screen.view' as const satisfies ShadowCapability;

/** True iff `cap` is the (non-action) screen-view grant capability. */
export function isScreenViewCapability(cap: unknown): cap is 'screen.view' {
  return cap === SHADOW_SCREEN_VIEW_CAPABILITY;
}

/**
 * True iff `caps` (a canonical granted set) authorises view-only screen streaming.
 * This is the sole gate the host coordinator consults at stream-start time; it is
 * intentionally independent of {@link methodPermittedBy} (the durable-action gate).
 */
export function screenViewPermittedBy(caps: readonly ShadowCapability[]): boolean {
  return caps.includes(SHADOW_SCREEN_VIEW_CAPABILITY);
}

/** Hard upper bound on how many capabilities a grant may carry (the whole vocabulary). */
export const SHADOW_MAX_CAPABILITIES = SHADOW_CAPABILITIES.length;

/** Hard upper bound on any single capability token length (defensive parse bound). */
export const SHADOW_MAX_CAPABILITY_STRING_LEN = 64;

const CANONICAL_INDEX: ReadonlyMap<string, number> = new Map(
  SHADOW_CAPABILITIES.map((cap, i) => [cap, i] as const),
);

const KNOWN: ReadonlySet<string> = new Set(SHADOW_CAPABILITIES);

/** Type guard: is `value` one of the known canonical capabilities. */
export function isKnownCapability(value: unknown): value is ShadowCapability {
  return typeof value === 'string' && KNOWN.has(value);
}

/** True iff `cap` is present in the canonical set `caps`. */
export function hasCapability(caps: readonly ShadowCapability[], cap: ShadowCapability): boolean {
  return caps.includes(cap);
}

export type CanonicalizeResult =
  | { ok: true; capabilities: ShadowCapability[] }
  | { ok: false; reason: string };

/**
 * Validate + canonicalise an arbitrary requested/approved capability input into a
 * deduped, canonically-sorted, bounded set of known capabilities.
 *
 *   - `undefined` / `null` / empty  → the default set (`account.read`), UNLESS
 *     `allowEmptyDefault` is `false` (then empty is a hard error).
 *   - Non-array, non-string element, over-length token, unknown token, or a set
 *     exceeding {@link SHADOW_MAX_CAPABILITIES} → `{ ok: false }` (fail closed).
 *
 * Output order is the fixed canonical vocabulary order, so the resulting set is a
 * stable, replay-safe basis for signing.
 */
export function canonicalizeCapabilities(
  input: unknown,
  opts?: { allowEmptyDefault?: boolean },
): CanonicalizeResult {
  const allowEmptyDefault = opts?.allowEmptyDefault ?? true;
  if (input === undefined || input === null) {
    if (!allowEmptyDefault) return { ok: false, reason: 'empty' };
    return { ok: true, capabilities: [...SHADOW_DEFAULT_CAPABILITIES] };
  }
  if (!Array.isArray(input)) return { ok: false, reason: 'not-array' };
  if (input.length > SHADOW_MAX_CAPABILITIES) return { ok: false, reason: 'too-many' };
  const seen = new Set<ShadowCapability>();
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, reason: 'non-string' };
    if (raw.length === 0 || raw.length > SHADOW_MAX_CAPABILITY_STRING_LEN) return { ok: false, reason: 'bad-length' };
    if (!KNOWN.has(raw)) return { ok: false, reason: `unknown:${raw.slice(0, SHADOW_MAX_CAPABILITY_STRING_LEN)}` };
    seen.add(raw as ShadowCapability);
  }
  if (seen.size === 0) {
    if (!allowEmptyDefault) return { ok: false, reason: 'empty' };
    return { ok: true, capabilities: [...SHADOW_DEFAULT_CAPABILITIES] };
  }
  const capabilities = [...seen].sort((a, b) => (CANONICAL_INDEX.get(a)! - CANONICAL_INDEX.get(b)!));
  return { ok: true, capabilities };
}

/**
 * Host approval step: choose the approved capability set as a SUBSET of what the
 * controller requested. The result is `canonicalize(hostApproved) ∩ canonicalize(requested)`,
 * canonically sorted. Because the intersection can only ever REMOVE capabilities
 * relative to the request, a controller can never obtain a capability it did not
 * request, and the host can only ever narrow — never silently widen. `account.read`
 * is always retained (the read floor) so every enrolled controller can at least
 * read the projection.
 *
 * Returns `{ ok:false }` if either input is malformed/oversized/unknown.
 */
export function intersectApprovedCapabilities(
  requested: unknown,
  hostApproved: unknown,
): CanonicalizeResult {
  const req = canonicalizeCapabilities(requested);
  if (!req.ok) return req;
  const host = canonicalizeCapabilities(hostApproved);
  if (!host.ok) return host;
  const reqSet = new Set(req.capabilities);
  const chosen = new Set<ShadowCapability>(['account.read']);
  for (const cap of host.capabilities) {
    if (reqSet.has(cap)) chosen.add(cap);
  }
  const capabilities = [...chosen].sort((a, b) => (CANONICAL_INDEX.get(a)! - CANONICAL_INDEX.get(b)!));
  return { ok: true, capabilities };
}

/**
 * Deterministic canonical string for signing/binding a capability set, e.g.
 * `capv1:account.read,job.start`. Input MUST already be canonical (from
 * {@link canonicalizeCapabilities}); this only joins with the version prefix.
 */
export function capabilitiesCanonicalString(capabilities: readonly ShadowCapability[]): string {
  return `capv${SHADOW_CAPABILITY_VERSION}:${capabilities.join(',')}`;
}

/**
 * The canonical controller ACTION methods (Section C) and the single capability
 * each requires. Read-only listing/health require only `account.read`. This map is
 * the authoritative method→capability contract checked host-side before any
 * decrypt-time execution.
 */
export const CONTROLLER_METHOD_CAPABILITY = {
  'controller.account.list': 'account.read',
  'controller.health': 'account.read',
  'controller.session.message': 'session.message',
  'controller.job.start': 'job.start',
  'controller.job.cancel': 'job.cancel',
  'controller.approval.respond': 'approval.respond',
  'controller.question.answer': 'question.answer',
  'controller.session.autopilot.set': 'session.autopilot.set',
} as const satisfies Record<string, ShadowCapability>;

export type ControllerActionMethod = keyof typeof CONTROLLER_METHOD_CAPABILITY;

/**
 * The capability required to invoke `method`, or `null` if `method` is not a known
 * controller action (unknown methods are always rejected before dispatch).
 */
export function requiredCapabilityForMethod(method: string): ShadowCapability | null {
  return (CONTROLLER_METHOD_CAPABILITY as Record<string, ShadowCapability>)[method] ?? null;
}

/** True iff a controller holding `caps` is permitted to invoke `method`. */
export function methodPermittedBy(method: string, caps: readonly ShadowCapability[]): boolean {
  const required = requiredCapabilityForMethod(method);
  if (required === null) return false;
  return caps.includes(required);
}
