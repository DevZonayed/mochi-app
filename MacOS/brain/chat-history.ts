/* Cross-engine chat handoff.

   When a chat turn CANNOT resume the engine's native session — Codex always
   (it has no resume wired up), and Claude on a fresh/first turn — the model must
   be re-seeded with prior context as plain text. The old approach stitched a
   flat [User]/[Assistant] transcript capped at a hardcoded ~12k chars, which
   (a) ignored the model's real context window and (b) threw away the STRUCTURED
   transcript (tool calls, file writes, decisions) that, for a coding agent,
   carries more signal than the final prose.

   This module fixes both:
   • `contextWindowFor(engine, model)` — the target model's approx token window.
   • `historyCharBudget(window)` — how many chars of recap we're willing to spend.
   • `handoffBrief(turns, budget)` — a high-signal recap that folds each turn's
     tool trail in alongside the user ask + final answer, newest turns fullest.

   All pure + deterministic (no disk, no clock) so it's unit-testable and cheap
   — no summarization LLM call on the hot path. */

import type { TranscriptItem } from './store.js';

/** Approx usable context window (TOKENS) for an engine/model. Conservative on
    purpose — this only sizes how much prior chat we replay on a non-resumed
    turn, so under-estimating just yields a slightly smaller (never oversized)
    brief. Unknown models fall back to a safe 200k. */
export function contextWindowFor(engine: string | undefined, model: string | undefined): number {
  const m = (model ?? '').toLowerCase();
  // Explicit 1M-context Claude (Sonnet long-context beta) — opt-in via the model id.
  if (m.includes('1m') || m.includes('[1m]')) return 1_000_000;
  if (engine === 'codex') return 250_000;       // GPT-5 / codex family.
  return 200_000;                                // Modern Claude (Opus/Sonnet/Haiku 4.x).
}

/** Turn a token window into a CHAR budget for the stitched recap. ~4 chars/token,
    and we only spend a FRACTION of the window on history so the actual task,
    tools, project memory, and generation headroom still fit comfortably. Floored
    at the legacy 12k so a tiny/unknown window never regresses below old behavior. */
export function historyCharBudget(windowTokens: number, fraction = 0.30): number {
  return Math.max(12_000, Math.floor(windowTokens * fraction * 4));
}

/** The minimal per-turn shape `handoffBrief` needs (a subset of `Job`). */
export interface BriefTurn {
  input: string;
  output: string | null;
  transcript?: TranscriptItem[];
  createdAt: number;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Compact the structured transcript into a short "what the assistant did" trail:
    the tool/skill calls and review verdicts, in order, deduped against trivial
    noise. Returns [] when there's nothing worth showing (pure-prose turn or a
    turn whose transcript was retention-stripped). */
function toolTrail(transcript: TranscriptItem[] | undefined, maxLines: number): string[] {
  if (!transcript?.length) return [];
  const lines: string[] = [];
  for (const it of transcript) {
    if (lines.length >= maxLines) break;
    if (it.kind === 'tool') {
      const name = oneLine(it.name || '');
      const label = oneLine(it.text || '');
      // Prefer "name: label", but drop the prefix when the label already IS the
      // name (or there's no distinct label) so we don't render "Bash: Bash".
      const shown = !label || label === name ? (name || label || 'tool')
        : name ? `${name}: ${label}` : label;
      lines.push(`· ${clip(shown, 140)}`);
    } else if (it.kind === 'review' && it.verdict) {
      lines.push(`· review: ${it.verdict}${it.resolved ? ' (resolved)' : ''}`);
    }
  }
  return lines;
}

/** Build a recap of prior chat turns for a fresh (non-resumed) run, within a char
    `budget`. Newest turns get priority: we walk newest→oldest accumulating whole
    turn blocks until the budget is spent, then render them back in chronological
    order. Each block is `[User] → what the assistant did → [Assistant]`. Returns
    '' when there's no prior context. */
export function handoffBrief(
  turns: readonly BriefTurn[],
  budget: number,
  opts: { maxTurns?: number; userCap?: number; outCap?: number; toolLines?: number } = {},
): string {
  if (!turns.length || budget <= 0) return '';
  const maxTurns = opts.maxTurns ?? 20;
  const userCap = opts.userCap ?? 2000;
  const outCap = opts.outCap ?? 4000;
  const toolLines = opts.toolLines ?? 16;

  const ordered = [...turns].sort((a, b) => a.createdAt - b.createdAt);
  const recent = ordered.slice(-maxTurns);

  const blocks: string[] = [];
  let total = 0;
  // Newest → oldest so the freshest turns are guaranteed room.
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i];
    const parts = [`[User]: ${clip(oneLine(t.input), userCap)}`];
    const trail = toolTrail(t.transcript, toolLines);
    if (trail.length) parts.push(`[Assistant did]:\n${trail.join('\n')}`);
    if (t.output) parts.push(`[Assistant]: ${clip(oneLine(t.output), outCap)}`);
    const block = parts.join('\n');
    if (total + block.length > budget && blocks.length) break; // keep at least the newest turn
    total += block.length;
    blocks.push(block);
  }
  return blocks.reverse().join('\n\n');
}
