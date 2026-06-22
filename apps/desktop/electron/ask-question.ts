/* AskUserQuestion follow-up logic — pure + dependency-free so it unit-tests
   without Electron or the SDK.

   The Claude binary surfaces AskUserQuestion as a `request_user_dialog`; with no
   host dialog handler it auto-dismisses ("the confirmation prompt was dismissed").
   Rather than fight the opaque dialog protocol, we answer through the channel the
   model is TRAINED on: a normal follow-up message prefixed `[User answered
   AskUserQuestion]:` (verbatim from the binary's own system prompt). So when the
   user picks an option — or, on timeout, we pick the recommended one — we resume
   the session with that prefixed message.

   This module: parses the tool input, picks the recommended option, formats the
   prefixed answer, and computes the escalating-extend deadlines + 30-min cap. */

/** The exact prefix the model treats as a direct answer to its question. */
export const ANSWER_PREFIX = '[User answered AskUserQuestion]:';

/** Base wait before auto-answering, and the hard cap on total wait. Tunable.
    Tightened to 1 minute alongside the autopilot opt-in (matches KEEP_GOING_BASE_MS
    so the operator only has one "the timer" mental model). The cap stays at
    30 min so a genuinely long-form answer the user is composing isn't auto-resolved. */
export const ASK_BASE_MS = 60_000;       // 1 minute
export const ASK_CAP_MS = 30 * 60_000;   // 30 minutes total, then graceful pause
const ASK_STEP_MS = 5 * 60_000;          // extend increment unit (+5, +10, +15 …)

export interface AskOption { label: string; description?: string }
export interface AskQuestion { question: string; header?: string; options: AskOption[]; multiSelect?: boolean }

/** Parse the AskUserQuestion tool input (already JSON-parsed or a JSON string) into
    a flat list of questions. Tolerant of shape drift; returns [] on anything odd. */
export function parseAsk(input: unknown): AskQuestion[] {
  let obj: unknown = input;
  if (typeof input === 'string') { try { obj = JSON.parse(input); } catch { return []; } }
  const qs = (obj as { questions?: unknown })?.questions;
  if (!Array.isArray(qs)) return [];
  const out: AskQuestion[] = [];
  for (const q of qs) {
    const opts = (q as { options?: unknown })?.options;
    if (!q || typeof (q as { question?: unknown }).question !== 'string' || !Array.isArray(opts)) continue;
    const options: AskOption[] = [];
    for (const o of opts) {
      const label = (o as { label?: unknown })?.label;
      if (typeof label === 'string' && label.trim()) {
        options.push({ label: label.trim(), description: typeof (o as { description?: unknown }).description === 'string' ? (o as { description: string }).description : undefined });
      }
    }
    if (options.length) out.push({ question: (q as { question: string }).question, header: typeof (q as { header?: unknown }).header === 'string' ? (q as { header: string }).header : undefined, options, multiSelect: (q as { multiSelect?: unknown }).multiSelect === true });
  }
  return out;
}

const RECO_RE = /\b(recommend|recommended|default|suggested|suggest|preferred)\b/i;

/** The option to auto-pick on timeout for ONE question: the one whose label or
    description signals it's the recommendation, else the first option. */
export function pickRecommended(q: AskQuestion): AskOption | null {
  if (!q.options.length) return null;
  return q.options.find(o => RECO_RE.test(o.label) || (o.description ? RECO_RE.test(o.description) : false)) ?? q.options[0];
}

/** The recommended answer text across all questions (one line each). Empty when
    there's nothing parseable — caller then falls back to a generic instruction. */
export function recommendedAnswer(questions: AskQuestion[]): string {
  const parts: string[] = [];
  for (const q of questions) {
    const pick = pickRecommended(q);
    if (pick) parts.push(`${q.header ? q.header + ': ' : ''}${pick.label}`);
  }
  return parts.join('\n');
}

/** Format a user answer as the model-recognized prefixed message. */
export function answerMessage(answer: string): string {
  return `${ANSWER_PREFIX} ${answer.trim()}`.trim();
}

/** The instruction sent on timeout when no clear recommendation exists. */
export function timeoutAnswer(questions: AskQuestion[]): string {
  const reco = recommendedAnswer(questions);
  return reco
    ? answerMessage(`${reco}\n\n(No response in time — proceeding with the recommended option above. Continue without asking again.)`)
    : answerMessage('No response in time — proceed with your recommended default and continue without asking again.');
}

/** The graceful pause posted to the user once they extend past the cap. */
export const GRACEFUL_PAUSE_NOTE =
  '⏸ Paused — I’ll hold this question for you. Reply whenever you get a moment and I’ll pick up right from here.';

/** Total wait offset (ms from armed) after `extends` extensions:
    base + step*1 + step*2 + … + step*extends. */
export function offsetForExtends(extendsCount: number): number {
  const n = Math.max(0, Math.floor(extendsCount));
  return ASK_BASE_MS + ASK_STEP_MS * (n * (n + 1) / 2);
}

export interface ExtendOutcome {
  /** True when this extend would push total wait past the cap → graceful pause instead. */
  capped: boolean;
  /** The next extension count (only meaningful when !capped). */
  extends: number;
  /** Absolute new deadline ms (only when !capped). */
  deadline: number;
  /** ms added by this extension (only when !capped). */
  addedMs: number;
}

/** Compute the next escalating extend. The (k+1)-th extend adds step*(k+1); if the
    resulting total wait exceeds the cap, signal a graceful pause instead. */
export function nextExtend(armedAt: number, extendsSoFar: number): ExtendOutcome {
  const k = Math.max(0, Math.floor(extendsSoFar));
  const curOffset = offsetForExtends(k);
  const newOffset = offsetForExtends(k + 1);
  if (newOffset > ASK_CAP_MS) return { capped: true, extends: k, deadline: armedAt + curOffset, addedMs: 0 };
  return { capped: false, extends: k + 1, deadline: armedAt + newOffset, addedMs: newOffset - curOffset };
}
