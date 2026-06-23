/* Keep-going follow-up logic — pure + dependency-free so it unit-tests
   without Electron, the SDK, or the store.

   The scenario this guards (image_0ss8f.png): the agent finishes a chunk of
   work and ends ON an open offer — "Want me to keep going? Natural next waves:
   Sprint 4b … or Sprint 5 …. I'll just pick one and ship unless you redirect."
   On goal-mode runs (and any session where the user wants autonomous
   execution) that's a HALT they shouldn't have to babysit. The fix here is a
   sibling to the AskUserQuestion follow-up:

   1. Detect the "want me to keep going?" / "next wave?" / "ready when you are"
      tail in the model's last text — but NOT confuse it with a genuine
      branching decision (those go through AskUserQuestion, which has its own
      follow-up countdown) or a hard pause we already auto-cover (usage-limit
      reset, max-turns continue).
   2. Build an ORGANIZED continue prompt that echoes the model's own outlined
      next items back to it as a bulleted list — so the resumed turn knows
      exactly what's on the table and can pick the highest-impact one.
   3. The caller (engine.armChatFollowup) arms a one-shot 'keep-going' schedule
      that fires that prompt into the SAME session after KEEP_GOING_BASE_MS,
      and the cron runner runs it like any other scheduled message. A real
      blocker (auth, missing creds, irreversible external action) is signalled
      by the model in plain text — the prompt instructs it to surface that and
      pause rather than spin.

   Module is intentionally pure and testable; the wiring lives in engine.ts. */

/** Prefix the auto-sent continue carries so it's distinguishable from a
    user-typed "continue" in the transcript (the desktop UI dims it, and any
    log scraper can recognize an auto-sent turn). */
export const KEEP_GOING_PREFIX = '[Auto-continue]:';

/** Default wait before auto-continuing, matching the AskUserQuestion follow-up
    cadence so the operator has a single mental model for "the timer".
    Tightened from 5 → 1 minute alongside the autopilot opt-in: now that the
    feature only runs when the user explicitly enabled it for THIS chat, a
    long wait window is wasted — the operator wanted snappy continuation. */
export const KEEP_GOING_BASE_MS = 60_000; // 1 minute
/** Safety cap on consecutive auto-continues per session, so a stuck agent
    can't burn the user's tokens forever. Past this we post a graceful pause
    note and wait for a real reply. Generous because the per-run turn budget
    is already bounded inside each individual run. */
export const KEEP_GOING_MAX_PER_SESSION = 20;

/* ── Detection ───────────────────────────────────────────────────────── */

/** "Want me to / shall I / should I / would you like me to … continue / keep going / proceed / press on / move on / tackle". */
const OFFER_TO_CONTINUE_RE = /\b(want me to|shall i|should i|would you like me to|let me know if you want me to|would you like to|happy to|i can)\s+(keep\s+going|keep\s+pushing|continue|proceed|carry on|carry forward|move on|press on|push on|tackle|take on|pick that up|pick one up)\b/i;
/** "Next wave / next sprint / next up / on deck / coming up / I'll just pick one". */
const NEXT_OFFER_RE = /\b(next\s+(up|step|steps|wave|waves|sprint|task|tasks|item|items|move|moves)|i'?ll\s+(just\s+)?pick\s+one|on\s+deck|coming\s+up|natural\s+next)\b/i;
/** "Ready when you are / say the word / good to go / all yours". */
const READY_RE = /\b(ready\s+(when|whenever)\s+you\s+(are|want|say|signal)|(just\s+)?say\s+the\s+word|good\s+to\s+go|all\s+yours)\b/i;

/** Explicit blocker phrasing the model uses when it CAN'T continue without us
    — auth/creds/decisions only the human can make. Suppress auto-continue so
    we don't keep firing a prompt that can't move forward. */
const EXPLICIT_BLOCKER_RE = /\b(blocked\s+on\s+(you|the\s+user)|need(s)?\s+your\s+(decision|input|approval|review|sign-?off)|i\s+can'?t\s+(do|continue|proceed|move\s+on)\s+(?:without|until)|i\s+don'?t\s+have\s+(access|the\s+(credentials|api\s+key|token))|please\s+(provide|share|give\s+me)\s+(?:the\s+)?(credentials|api\s+key|token|password)|requires?\s+(?:human|manual)\s+(?:input|action))\b/i;

/** Already-paused tails: the existing handlers cover these (usage-limit reset
    auto-continue, max-turns auto-continue, cancellation). Don't double-arm. */
const ALREADY_PAUSED_RE = /(⏸|Claude\s+usage\s+limit|Paused\s+at\s+the\s+turn\s+limit|Reached\s+maximum\s+number\s+of\s+turns|usage\s+limit\s+reached)/i;

/** Reasonable signal that the LAST chunk of text was an offer to continue
    rather than a definitive deliverable. We look at the tail of the text
    (last ~1500 chars) so a long body that ends on "want me to keep going?"
    still triggers, but a body that mentions "keep going" in the middle and
    ends with a real deliverable does not. Returns the matched phrase (for the
    schedule title) or null. */
export function detectKeepGoing(text: string | undefined | null): string | null {
  if (!text) return null;
  const tail = text.slice(-1500);
  if (ALREADY_PAUSED_RE.test(tail)) return null;
  if (EXPLICIT_BLOCKER_RE.test(tail)) return null;
  const candidates: RegExp[] = [OFFER_TO_CONTINUE_RE, NEXT_OFFER_RE, READY_RE];
  for (const re of candidates) {
    const m = re.exec(tail);
    if (m) return m[0].trim();
  }
  return null;
}

/* ── Organizing the continue prompt ──────────────────────────────────── */

/** Strip inline markdown emphasis (bold/italic) from an extracted item so the
    auto-continue prompt — which renders into the USER-SIDE chat bubble (no
    markdown parser there) — doesn't show literal `**Sprint 10b**` stars to
    the operator. The agent still understands the plain text fine. Backticks
    are preserved (inline code reads OK as ``code`` in plain text). */
function stripEmphasis(s: string): string {
  return s
    // **bold** / __bold__
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/__([^_\n]+?)__/g, '$1')
    // *italic* / _italic_ — only when bracketed with whitespace on both
    // outer sides so we don't eat "5*3" or "snake_case".
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .trim();
}

/** Extract the model's own outlined next items from its last text so we can
    echo them back as bullets. Captures numbered lists, dashed bullets, and
    bold-headed alternatives ("**Sprint 4b — paywall** , Sprint 8 …"). Dedups
    and caps at 8 to keep the resumed prompt tight. Markdown emphasis is
    stripped (see stripEmphasis) so the resulting prompt reads cleanly in the
    USER-side chat bubble, which has no markdown renderer. */
export function extractNextItems(text: string | undefined | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  const push = (raw: string) => {
    const s = stripEmphasis(raw);
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t || t.length < 3 || t.length > 240) return;
    if (out.includes(t)) return;
    out.push(t);
  };
  // numbered list ("1. X" / "1) X")
  for (const m of text.matchAll(/^\s*\d+[.)]\s+(.+?)\s*$/gm)) push(m[1]);
  // bullets ("- X" / "• X" / "* X")
  for (const m of text.matchAll(/^\s*[-•*]\s+(.+?)\s*$/gm)) push(m[1]);
  // bold-headed alternatives with a descriptor separator —
  // "**Sprint 4b — paywall**: …" / "**Sprint 4b** — paywall enforcement".
  for (const m of text.matchAll(/\*\*([^*\n]{2,80}?)\*\*\s*(?:—|–|-|:)\s*([^.\n*]+)/g)) push(`${m[1].trim()} — ${m[2].trim()}`);
  // Bold-headed alternatives WITHOUT a separator — the screenshot tail uses
  // "**Sprint 4b live entitlement check** (paywall enforcement)" with a
  // trailing parenthetical, and sometimes there's no parenthetical at all.
  // Capture every `**X**` ≤80 chars; the parenthetical (if any) is folded
  // into the same item so the resumed turn sees the full alternative.
  for (const m of text.matchAll(/\*\*([^*\n]{2,80}?)\*\*\s*(?:\(([^)\n]{1,160})\))?/g)) {
    const head = m[1].trim();
    const paren = m[2]?.trim();
    push(paren ? `${head} (${paren})` : head);
  }
  return out.slice(0, 8);
}

/** Build the ORGANIZED continue prompt that fires at timeout. Echoes the
    model's outlined next items back to it (so it picks one and ships) and
    explicitly authorizes autonomy + names what counts as a real blocker. */
export function organizedContinuePrompt(opts: {
  lastText: string;
  goalMode?: boolean;
  originalGoal?: string;
  attempt?: number;
  maxAttempts?: number;
}): string {
  const items = extractNextItems(opts.lastText);
  const lines: string[] = [];
  lines.push('No response in the wait window — proceed autonomously.');
  if (opts.goalMode && opts.originalGoal) {
    lines.push('');
    lines.push(`Goal: ${opts.originalGoal.slice(0, 800).trim()}`);
  }
  if (items.length) {
    lines.push('');
    lines.push('You outlined these next moves:');
    for (const it of items) lines.push(`- ${it}`);
    lines.push('');
    lines.push(
      'Pick the highest-impact one yourself and ship it, then move on to the next. ' +
      'Do not stop to confirm routine steps — keep going until the goal is met or you ' +
      'hit a REAL blocker (a credential/token you don\'t have, an irreversible external ' +
      'action that needs human approval, or a decision only the user can make). For a real ' +
      'blocker, state precisely what you need and pause; otherwise keep working.',
    );
  } else {
    lines.push('');
    lines.push(
      'Continue exactly where you left off and finish the task. Pick the highest-impact ' +
      'next action you had in mind, ship it, then keep going with the next one. Do not stop ' +
      'to ask routine confirmation — proceed until the goal is met or you hit a REAL blocker ' +
      '(a credential/token you don\'t have, an irreversible external action that needs human ' +
      'approval, or a decision only the user can make). For a real blocker, state precisely ' +
      'what you need and pause.',
    );
  }
  if (opts.attempt && opts.maxAttempts) {
    lines.push('');
    lines.push(`(Auto-continue ${opts.attempt}/${opts.maxAttempts} for this chat.)`);
  }
  return `${KEEP_GOING_PREFIX} ${lines.join('\n')}`.trim();
}

/** The graceful pause note posted into the chat when the per-session
    auto-continue cap is hit — better than a silent halt. */
export const KEEP_GOING_CAP_NOTE =
  `⏸ Auto-continue paused after ${KEEP_GOING_MAX_PER_SESSION} consecutive turns — ` +
  `nothing has been lost. Send a quick "keep going" and I'll pick up exactly where this left off.`;
