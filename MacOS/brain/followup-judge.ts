/* Autopilot follow-up JUDGE — a small, focused Claude Sonnet call that decides
   whether the agent's last turn warrants an automatic 1-minute "[Auto-continue]:"
   follow-up, OR genuinely needs the human, OR is already finished.

   Why a model instead of just the regex (keep-going.ts: detectKeepGoing): the
   regex matches phrases like "next up" or "ready when you are" but can't tell
   the difference between (a) "ready when you are — say which to ship" (the
   model is BLOCKED on a user decision) and (b) "all green; next up I'll wire
   the toggle" (the model is just narrating its next move and will continue
   autonomously). The regex called both "fire auto-continue", which is exactly
   the false-positive that caused the operator's complaint.

   Architecture choice — RAW FETCH, not the Anthropic SDK:
   1. The desktop's deps already lean small (the engine bundle is shipped via
      electron-builder; every new package widens the asarUnpack list).
   2. The call is a one-shot /v1/messages with two cache breakpoints — no
      streaming, no tool use, no agent loop — so the SDK's higher-level
      ergonomics buy nothing.
   3. The existing codebase uses raw fetch for every other external API
      (relay, fal.ai, providers) — staying consistent.
   4. Per claude-api SKILL.md, raw HTTP is acceptable when the language has
      a one-shot use without SDK features needed. This is that.

   Prompt-caching layout (per shared/prompt-caching.md):
   - tools=[]
   - system: [{ text: FROZEN_SYSTEM, cache_control: { type: 'ephemeral' } }]
     -> stable byte-for-byte across every call so the cache is HOT after the
     first invocation. ~1100 tokens — comfortably above the 1024 minimum.
   - messages: [user message with the variable context]
     -> NOT cached: per-call context (transcript tail, goal mode, last text).

   Output: structured JSON {verdict, reason, items?}. We constrain by asking
   for JSON in the system prompt and parsing defensively (the model can wrap
   it in code fences; we strip those before JSON.parse). On any failure the
   caller's regex fallback fires — so an unreachable API never breaks the
   autopilot, just removes its smartness. */

/** The model decision shape: one of four verdicts + a short reason. */
export type JudgeVerdict =
  /** The agent ended on an autonomous-continuation cue ("next up", "want me
      to keep going", "ready when you are") AND nothing genuinely needs the
      human. Arm the 1-min auto-continue. */
  | 'continue'
  /** The agent asked the user a real question / needs a decision only the
      user can make / is blocked on creds. Do NOT auto-fire — wait for the
      user. (AskUserQuestion auto-answer is a SEPARATE path; this is for the
      "blocked on you" plain-text tail.) */
  | 'wait-for-user'
  /** The agent emitted a hard pause (usage limit, max turns, cancellation).
      Nothing for autopilot to do — the existing handlers cover those. */
  | 'paused'
  /** The agent delivered a real result and is genuinely done — no
      continuation cue, no question, no hard pause. Don't fire. */
  | 'done';

export interface JudgeResult {
  verdict: JudgeVerdict;
  /** One sentence why the model chose this verdict, surfaced in logs and
      the schedule chip subtitle so operators can audit/trust the autopilot. */
  reason: string;
  /** Optional list of the agent's outlined next moves, if the model spotted
      any. Used to enrich the [Auto-continue]: prompt with the items the
      agent itself proposed (same role as extractNextItems in keep-going.ts,
      but informed by full context). */
  items?: string[];
}

export interface JudgeInput {
  /** The last assistant text block (full text — the judge sees it whole,
      not just the trailing 1500-char slice the regex uses). */
  lastAssistantText: string;
  /** Optional: a few prior user/assistant turns for context, freshest last.
      Empty array is fine — the judge degrades gracefully. */
  contextTurns?: { role: 'user' | 'assistant'; text: string }[];
  /** Goal-mode flag from the session: when true, the bias is toward
      'continue' (autonomous execution is what goal mode is for). */
  goalMode?: boolean;
  /** Operator's original goal (first user message in a goal-mode session)
      so the judge can sanity-check whether the agent's still pursuing it. */
  originalGoal?: string;
  /** Anthropic API key from the Mac's Keychain (providers.getLocalKey).
      Missing key → caller falls back to regex. */
  apiKey: string;
  /** Override model — defaults to Claude Sonnet 4.6 per the operator's ask
      ("use sonet"). Kept overridable for unit tests + future re-tuning. */
  model?: string;
  /** Override the fetch implementation — unit tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Soft timeout (ms). Default 8s — the judge runs in the engine's
      post-turn path, so a slow call blocks the next user message's
      schedule arming. */
  timeoutMs?: number;
}

/** Default model — Sonnet, per the operator's instruction. Override via
    JudgeInput.model when calling from a test. */
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-6';

/** The frozen system prompt. NEVER edit this for per-call context —
    everything per-call goes in the user message. Editing this on every
    call would silently kill prompt caching (see shared/prompt-caching.md:
    "any byte change anywhere in the prefix invalidates everything after it").
    Kept ~1100 tokens — comfortably above the 1024 minimum for caching. */
export const JUDGE_SYSTEM_PROMPT = `You are the AUTOPILOT JUDGE for a coding agent harness on a Mac desktop. Your one job: given the agent's last turn (and a little context), decide whether to AUTOMATICALLY send a continuation message back to the agent on the user's behalf.

You output exactly one JSON object — no prose, no code fences, no preamble — matching this shape:

{
  "verdict": "continue" | "wait-for-user" | "paused" | "done",
  "reason": "<one tight sentence (<= 140 chars) saying why>",
  "items": ["<optional next move 1>", "<optional next move 2>", "..."]
}

VERDICTS — pick exactly one:

- "continue" — The agent ended on an OFFER TO CONTINUE its OWN work without needing the user. Cues: "want me to keep going?", "next up I'll ...", "ready when you are", "on deck:", "I'll just pick one and ship", "natural next wave", "shall I proceed with...", "let me know if you want me to continue", or a numbered/bulleted "Next steps" list with no question the user must answer. The agent is narrating its own next moves and can move forward without input.

- "wait-for-user" — The agent ASKED THE USER something that only the user can answer, OR is genuinely blocked on a credential/secret/access OR an irreversible external decision. Cues: "which do you prefer", "what's your account ID", "I need your decision on X before I can continue", "blocked on you", "please share the API key", "should I deploy to prod or staging" (a tradeoff the user owns), an AskUserQuestion-style multi-choice prompt the user hasn't answered.

- "paused" — A hard pause the harness already handles separately. Cues: a ⏸ pause emoji glyph at the top, "Claude usage limit reached", "Paused at the turn limit", "Reached maximum number of turns", "usage limit reached", "cancelled by user". The harness arms its own auto-recovery for these — autopilot must not double-fire.

- "done" — The agent delivered a complete result and is finished. No question, no continuation cue, no pause. Cues: a final deliverable + a closing line like "all set", "shipped", "PR is up", "tests passing — you're good to go", with no follow-on question and no "next up" tail. Don't auto-fire — the work is done.

CRITICAL TIE-BREAKING RULES (read these — they prevent the operator's common false positives):

1. The signal lives in the LAST PARAGRAPH, not the body. A long answer that mentioned "keep going" in the middle but ends with a real deliverable + no question is "done", not "continue". When in doubt, focus on the last 3-5 sentences.

2. If the agent is in GOAL MODE and ends on its own next moves (numbered list, "next:", "I'll tackle X"), default to "continue". Goal mode is exactly the case where we want autonomous execution.

3. A question to the user OUTWEIGHS a continuation cue. "I shipped X. Should I also do Y? Want me to keep going either way?" — the "should I also do Y?" is the user's call, so this is "wait-for-user", not "continue".

4. Mentioning a question or limitation that the agent itself ALREADY ANSWERED doesn't count. "I considered whether to also do Y; I went with N for reason Z. Next up: Z+1." — the agent already decided, so this is "continue", not "wait-for-user".

5. Distinguish a CONFIRMATION the agent doesn't strictly need from a real BLOCKER. "Want me to keep going?" framed as politeness while the agent is plainly going to keep going anyway = "continue". "I can't proceed until you give me the staging URL" = "wait-for-user".

6. If you cannot tell, prefer "wait-for-user" — the cost of an extra wait is small; the cost of an unwanted auto-fire is the operator typing a real message that races with our auto-continue.

ITEMS:

- Include "items" ONLY when "verdict" is "continue" AND the agent itself listed >= 2 next moves (numbered, bulleted, or **bolded** alternatives). Echo them back as short strings (drop the leading bullets/numbers). Cap at 6. Leave the field out entirely otherwise.

OUTPUT: exactly one JSON object, nothing else. Do not wrap in markdown. Do not add a preamble. Do not explain your reasoning outside the "reason" field.`;

/** Strip optional ```json … ``` fences (or stray prose) the model sometimes
    wraps the JSON in despite the system prompt. Returns the cleanest-looking
    JSON object substring. Defensive — bad outputs fall through to the
    caller's regex fallback. */
export function extractJson(raw: string): string | null {
  if (!raw) return null;
  // Drop a leading code fence (` ```json `, ` ``` `) and a trailing one.
  const fenced = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  // Find the outermost {...} block — robust to a stray leading word.
  const first = fenced.indexOf('{');
  const last = fenced.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  return fenced.slice(first, last + 1);
}

/** Parse the model's reply into a JudgeResult, or return null when the
    shape is unusable. Permissive on extra fields, strict on the verdict
    enum. */
export function parseJudgeReply(raw: string): JudgeResult | null {
  const json = extractJson(raw);
  if (!json) return null;
  let obj: unknown;
  try { obj = JSON.parse(json); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const v = (obj as { verdict?: unknown }).verdict;
  const r = (obj as { reason?: unknown }).reason;
  if (v !== 'continue' && v !== 'wait-for-user' && v !== 'paused' && v !== 'done') return null;
  const reason = typeof r === 'string' && r.trim() ? r.trim().slice(0, 200) : '';
  const result: JudgeResult = { verdict: v, reason };
  const items = (obj as { items?: unknown }).items;
  if (Array.isArray(items)) {
    const cleaned = items
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((x) => x.length >= 3 && x.length <= 240)
      .slice(0, 6);
    if (cleaned.length) result.items = cleaned;
  }
  return result;
}

/** Build the variable USER message — small, per-call, NOT cached. Kept
    intentionally compact so the judge sees only what matters and the
    request is fast.

    Per shared/prompt-caching.md: keep stable content first (system
    prompt above), put per-call content (timestamps, varying text) in the
    user turn so the cache breakpoint on `system` stays hot. */
export function buildJudgeUserMessage(input: Pick<JudgeInput, 'lastAssistantText' | 'contextTurns' | 'goalMode' | 'originalGoal'>): string {
  const parts: string[] = [];
  if (input.goalMode) {
    parts.push('Mode: GOAL_MODE (the operator wants autonomous execution; bias toward "continue" when the agent is narrating its own next move).');
    if (input.originalGoal && input.originalGoal.trim()) {
      parts.push(`Original goal: ${input.originalGoal.slice(0, 600).trim()}`);
    }
  } else {
    parts.push('Mode: normal_chat (no goal-mode bias).');
  }
  const turns = (input.contextTurns ?? []).slice(-6); // last 3 user/assistant pairs at most
  if (turns.length) {
    parts.push('');
    parts.push('Recent turns (oldest first; for context only — do NOT judge these):');
    for (const t of turns) {
      const tag = t.role === 'user' ? 'USER' : 'ASSISTANT';
      const body = (t.text ?? '').slice(0, 1200);
      parts.push(`[${tag}] ${body}`);
    }
  }
  parts.push('');
  parts.push('Agent\'s LAST turn (THIS is the one you are judging):');
  parts.push('---');
  // Cap the last turn at 6000 chars — enough for a long answer, bounded so
  // a runaway turn doesn't blow input cost. The judge cares about the TAIL
  // anyway (per tie-breaking rule #1), so we keep the last 6000 chars when
  // the text is longer.
  const last = (input.lastAssistantText ?? '').trim();
  const slice = last.length > 6000 ? `… (earlier omitted) …\n${last.slice(-6000)}` : last;
  parts.push(slice);
  parts.push('---');
  parts.push('');
  parts.push('Output exactly one JSON object: {verdict, reason, items?}. No other text.');
  return parts.join('\n');
}

/** Run the judge. Returns a JudgeResult on a clean reply, null on any
    failure (caller falls back to regex). Never throws — autopilot must
    never break a chat turn.

    Implementation: POST /v1/messages with prompt caching on the system
    block. Uses AbortController to enforce a soft timeout so we don't
    block the engine's post-turn path forever. */
export async function judgeFollowup(input: JudgeInput): Promise<JudgeResult | null> {
  if (!input.apiKey || !input.lastAssistantText?.trim()) return null;
  const fetcher = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== 'function') return null;
  const model = input.model ?? DEFAULT_JUDGE_MODEL;
  const userMsg = buildJudgeUserMessage(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, input.timeoutMs ?? 8000));
  try {
    const res = await fetcher('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      // Tight budget: 320 output tokens is plenty for {verdict, reason, items}.
      // Adaptive thinking would be wasted on such a constrained decision.
      body: JSON.stringify({
        model,
        max_tokens: 320,
        system: [
          { type: 'text', text: JUDGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        messages: [
          { role: 'user', content: [{ type: 'text', text: userMsg }] },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const txt = (json.content ?? []).find((c) => c.type === 'text')?.text ?? '';
    return parseJudgeReply(txt);
  } catch {
    // Network failure, abort, malformed JSON — all benign here: the caller
    // falls back to the regex detector so autopilot still works (just less
    // smart). The judge is an enrichment, not a hard dependency.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
