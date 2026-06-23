/**
 * Choose the Claude Agent SDK `thinking` option for a run.
 *
 * Why this exists: the SDK only emits `thinking_delta` stream events (the live
 * reasoning we render as the purple "Thinking" block) when extended thinking
 * is actively on. For Opus 4.6+ that's implicit — `{type:'adaptive'}` is the
 * default — but Sonnet/Haiku stay silent unless we ask for it explicitly. Prior
 * to this helper Maestro never set `thinking`, so users on non-Opus models saw
 * no reasoning even though the capture/render path (PR #42) was wired
 * end-to-end. Conductor force-enables thinking the same way, which is why
 * Conductor showed reasoning regardless of model.
 *
 * Kept as a tiny pure module (no electron / SDK imports) so it's unit-testable
 * without booting the heavy engine bootstrap.
 */

/** Effort levels Maestro exposes to the run pipeline. Mirrors `Effort` in
    `store.ts`; redeclared here to keep this module dependency-free. */
export type ThinkingEffort = 'fast' | 'balanced' | 'deep' | 'max';

/** Per-effort fixed-budget for the `{type:'enabled'}` fallback used on
    non-Opus models. Picked to roughly mirror the `EFFORT_TURNS` curve in
    engine.ts — fast = quick replies, max = let the model really chew. */
export const EFFORT_THINKING_TOKENS: Record<ThinkingEffort, number> = {
  fast: 2000,
  balanced: 4000,
  deep: 8000,
  max: 16000,
};

/** SDK `thinking` option shape we emit. The full union in
    `@anthropic-ai/claude-agent-sdk` also includes `{type:'disabled'}`, but
    we never explicitly disable — silence is the SDK's natural default. */
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number };

/** Resolve the right `thinking` config for a Maestro run.
 *
 *  - Opus 4.6+ (or no model override → SDK default) → `adaptive`. The model
 *    decides depth from `effort`; this is what the SDK was already doing
 *    implicitly, but making it explicit locks in the behavior across SDK
 *    upgrades.
 *  - Sonnet / Haiku / anything else → `{type:'enabled', budgetTokens}` so the
 *    `thinking_delta` stream still fires. Older models don't support adaptive,
 *    so passing `{type:'adaptive'}` to them is undefined-behavior territory.
 *
 *  The model arg is whatever Maestro passes the SDK as `model` — a short slug
 *  (`'opus'` / `'sonnet'` / `'haiku'`) from the routing store, a full id like
 *  `claude-sonnet-4-5-…`, or `undefined` when there's no override. We
 *  match case-insensitively on the substring so both forms work.
 */
export function thinkingConfigFor(
  model: string | undefined,
  effort: string,
): ThinkingConfig {
  const m = (model ?? '').toLowerCase();
  // Empty → use SDK / Claude binary default (Opus 4.6+ today, adaptive-capable).
  if (m === '' || m.includes('opus')) return { type: 'adaptive' };
  const budget = (EFFORT_THINKING_TOKENS as Record<string, number | undefined>)[effort] ?? 4000;
  return { type: 'enabled', budgetTokens: budget };
}
