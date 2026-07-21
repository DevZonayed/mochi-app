/**
 * shadowActionCapabilities — Phase 3C3 canonical map of the SIX controllable action
 * families to their shared capability + controller method. This is the SINGLE source the
 * enrollment "Control actions" chooser and the action UI derive from — every entry is the
 * exact canonical capability/method from the shared `@maestro/realtime/shadowCapabilities`
 * contract (`CONTROLLER_METHOD_CAPABILITY`); there are NO aliases and NO invented commands.
 *
 * NOTE on schedules: the accepted host command allowlist exposes NO schedule mutation
 * command (only these six controller methods). Per "omit unsupported variants rather than
 * invent", schedules remain READ-ONLY in the UI — the sixth controllable family is
 * `session.autopilot.set` ("continue / autopilot" for a session). See ACTION_CONTRACT.md.
 */
import { CONTROLLER_METHOD_CAPABILITY, type ShadowCapability, type ControllerActionMethod } from '@maestro/realtime/shadowCapabilities';

export type ActionFamilyKey =
  | 'start-job' | 'cancel-job' | 'respond-approval' | 'answer-question' | 'send-message' | 'set-autopilot';

export interface ActionFamily {
  key: ActionFamilyKey;
  /** Canonical capability (must be one the host can grant). */
  capability: ShadowCapability;
  /** Canonical controller method invoked (from CONTROLLER_METHOD_CAPABILITY). */
  method: ControllerActionMethod;
  /** Human, product-native label for the grant chooser + granted list. */
  label: string;
  /** One-line description shown next to the capability in the chooser. */
  description: string;
}

/** The six controllable action families, in canonical capability order. */
export const ACTION_FAMILIES: readonly ActionFamily[] = [
  { key: 'send-message', capability: 'session.message', method: 'controller.session.message', label: 'Send messages', description: 'Send a message or continue work in a session' },
  { key: 'start-job', capability: 'job.start', method: 'controller.job.start', label: 'Start jobs', description: 'Start a new job in a project' },
  { key: 'cancel-job', capability: 'job.cancel', method: 'controller.job.cancel', label: 'Cancel jobs', description: 'Cancel a running job' },
  { key: 'respond-approval', capability: 'approval.respond', method: 'controller.approval.respond', label: 'Respond to approvals', description: 'Approve or deny a pending approval' },
  { key: 'answer-question', capability: 'question.answer', method: 'controller.question.answer', label: 'Answer questions', description: 'Answer a pending question' },
  { key: 'set-autopilot', capability: 'session.autopilot.set', method: 'controller.session.autopilot.set', label: 'Change autopilot', description: 'Turn a session’s autopilot on or off' },
] as const;

// Compile-time guard: every family's (method → capability) matches the shared contract.
const _contractCheck: Record<ControllerActionMethod, ShadowCapability> = CONTROLLER_METHOD_CAPABILITY;
for (const f of ACTION_FAMILIES) {
  if (_contractCheck[f.method] !== f.capability) throw new Error(`action family ${f.key} desyncs from CONTROLLER_METHOD_CAPABILITY`);
}

/** The read floor every enrolled controller retains, always required + locked-on. */
export const READ_FLOOR: ShadowCapability = 'account.read';

/** The separate (non-action) screen-view grant capability, offered under its own
 * "Screen access" group in the enrollment chooser. Never one of the six actions. */
export const SCREEN_VIEW_CAP: ShadowCapability = 'screen.view';

const CAP_BY_KEY = new Map<ActionFamilyKey, ShadowCapability>(ACTION_FAMILIES.map((f) => [f.key, f.capability]));

/**
 * Build the EXACT requested capability set from the user's chooser selection: always the
 * read floor + the capability of each selected action family, deduped. `mode==='view'`
 * → only the read floor. The result is deduped and includes no unknown/duplicate tokens
 * (the runtime re-canonicalises before signing).
 */
export function requestedCapabilitiesFor(mode: 'view' | 'control', selected: readonly ActionFamilyKey[], screenView = false): ShadowCapability[] {
  const set = new Set<ShadowCapability>([READ_FLOOR]);
  if (mode === 'control') for (const k of selected) { const c = CAP_BY_KEY.get(k); if (c) set.add(c); }
  // `screen.view` is an independent, opt-in grant — orthogonal to view/control mode.
  if (screenView) set.add(SCREEN_VIEW_CAP);
  return [...set];
}

/** The action families the CURRENT verified grant actually permits (never a requested/static list). */
export function grantedActionFamilies(granted: readonly ShadowCapability[] | null): ActionFamily[] {
  if (!granted) return [];
  const g = new Set(granted);
  return ACTION_FAMILIES.filter((f) => g.has(f.capability));
}

/** True iff the current grant permits this family (used to render/omit each control). */
export function grantAllows(granted: readonly ShadowCapability[] | null, key: ActionFamilyKey): boolean {
  if (!granted) return false;
  const cap = CAP_BY_KEY.get(key);
  return !!cap && granted.includes(cap);
}
