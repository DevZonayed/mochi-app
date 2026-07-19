import type { Effort, EngineId, RoleChoice } from './store.js';

export interface RunIntent {
  schemaVersion: 1;
  effort: Effort;
  engine?: EngineId;
  model?: string;
  reviewer?: RoleChoice | 'off';
  plan?: boolean;
  goal?: boolean;
  browser?: boolean;
}

export type RunIntentInput = Partial<Omit<RunIntent, 'schemaVersion'>>;
export type RunIntentEvidence = { schemaVersion: 1 } & RunIntentInput;
export type PersistedRunIntent = RunIntent | RunIntentEvidence;

const EFFORTS = new Set<Effort>(['fast', 'balanced', 'deep', 'max']);
const ENGINES = new Set<EngineId>(['claude', 'codex']);

function validEffort(v: unknown): v is Effort {
  return typeof v === 'string' && EFFORTS.has(v as Effort);
}

function validEngine(v: unknown): v is EngineId {
  return typeof v === 'string' && ENGINES.has(v as EngineId);
}

function validReviewer(v: unknown): v is RoleChoice | 'off' {
  if (v === 'off') return true;
  if (!v || typeof v !== 'object') return false;
  const r = v as { engine?: unknown; model?: unknown };
  return validEngine(r.engine) && (r.model === undefined || typeof r.model === 'string');
}

export function normalizeRunIntent(input: RunIntentInput | undefined, fallbackEffort: Effort): RunIntent {
  const src = (input ?? {}) as Record<string, unknown>;
  const safeFallback = validEffort(fallbackEffort) ? fallbackEffort : 'balanced';
  const out: RunIntent = {
    schemaVersion: 1,
    effort: validEffort(src.effort) ? src.effort : safeFallback,
  };
  if (validEngine(src.engine)) out.engine = src.engine;
  if (typeof src.model === 'string' && src.model.length > 0) out.model = src.model;
  if (validReviewer(src.reviewer)) out.reviewer = src.reviewer;
  if (typeof src.plan === 'boolean') out.plan = src.plan;
  if (typeof src.goal === 'boolean') out.goal = src.goal;
  if (typeof src.browser === 'boolean') out.browser = src.browser;
  return out;
}

export function mergeRunIntent(base: RunIntent | undefined, patch: RunIntentInput | undefined, fallbackEffort: Effort): RunIntent {
  const normalizedBase = normalizeRunIntent(base, fallbackEffort);
  const out: RunIntent = { ...normalizedBase };
  if (!patch) return out;
  if (patch.effort !== undefined) out.effort = patch.effort;
  if (patch.engine !== undefined) out.engine = patch.engine;
  if (patch.model !== undefined) out.model = patch.model;
  if (patch.reviewer !== undefined) out.reviewer = patch.reviewer;
  if (patch.plan !== undefined) out.plan = patch.plan;
  if (patch.goal !== undefined) out.goal = patch.goal;
  if (patch.browser !== undefined) out.browser = patch.browser;
  return normalizeRunIntent(out, fallbackEffort);
}

export function sameRunIntent(a: PersistedRunIntent | undefined, b: PersistedRunIntent | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function assertRunIntentCompatible(locked: RunIntent, patch: RunIntentInput | undefined, fallbackEffort: Effort): void {
  if (!patch || Object.values(patch).every(v => v === undefined)) return;
  const candidate = mergeRunIntent(locked, patch, fallbackEffort);
  if (sameRunIntent(locked, candidate)) return;
  const err = new Error('run intent conflict: existing job intent is immutable; create a new job for different mode settings');
  throw Object.assign(err, { statusCode: 409 });
}

export function legacyIntentFromJob(job: { effort: Effort; engine?: EngineId; model?: string; goal?: boolean }): RunIntent {
  const partial: RunIntentInput = {
    effort: job.effort,
    engine: job.engine,
    model: job.model,
  };
  if (job.goal !== undefined) partial.goal = job.goal;
  return normalizeRunIntent(partial, job.effort);
}

export function legacyIntentEvidenceFromSchedule(schedule: {
  effort?: Effort;
  engine?: EngineId;
  model?: string;
  reviewer?: RoleChoice | 'off';
  plan?: boolean;
  goal?: boolean;
  browser?: boolean;
}): RunIntentEvidence | undefined {
  const evidence: RunIntentEvidence = { schemaVersion: 1 };
  if (schedule.effort !== undefined) evidence.effort = schedule.effort;
  if (schedule.engine !== undefined) evidence.engine = schedule.engine;
  if (schedule.model !== undefined) evidence.model = schedule.model;
  if (schedule.reviewer !== undefined) evidence.reviewer = schedule.reviewer;
  if (schedule.plan !== undefined) evidence.plan = schedule.plan;
  if (schedule.goal !== undefined) evidence.goal = schedule.goal;
  if (schedule.browser !== undefined) evidence.browser = schedule.browser;
  return Object.keys(evidence).length > 1 ? evidence : undefined;
}

export function intentMirrors(intent: RunIntent): {
  effort: Effort;
  engine?: EngineId;
  model?: string;
  goal?: boolean;
} {
  return {
    effort: intent.effort,
    ...(intent.engine ? { engine: intent.engine } : {}),
    ...(intent.model ? { model: intent.model } : {}),
    ...(intent.goal !== undefined ? { goal: intent.goal } : {}),
  };
}
