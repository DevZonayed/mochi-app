/* AI session naming — a tiny, focused model call that turns the first
   exchange of a chat into (a) a clean session TITLE for the rail and
   (b) a standard git BRANCH SLUG, so `mochi/<city>/<slug>` and the chat
   name stay perfectly in sync from the first turn.

   Same architecture as followup-judge.ts: raw fetch (no SDK), a frozen
   cached system prompt, defensive JSON parsing, and a hard rule that a
   failure NEVER breaks the turn — callers fall back to the deterministic
   `branchSlug(firstMessage)` path that existed before. */

export interface SessionName { title: string; slug: string }

export interface NamingInput {
  /** The user's first message in the session (the task ask). */
  userMessage: string;
  /** The assistant's reply tail — helps the model name what actually happened. */
  assistantText?: string;
  /** Anthropic API key from the Keychain; missing → caller falls back. */
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_NAMING_MODEL = 'claude-haiku-4-5';

/** Frozen system prompt (byte-stable for prompt caching). */
export const NAMING_SYSTEM_PROMPT = `You are the SESSION NAMER for a coding-agent desktop app. Given the first user message of a chat (and optionally the assistant's reply), produce a name for the session and a git branch slug.

Output EXACTLY one JSON object — no prose, no code fences:

{"title": "<3-7 word Title Case name of the task>", "slug": "<kebab-case-branch-slug>"}

RULES:
- "title": 3-7 words, Title Case, describes the TASK (what is being built/fixed), never a greeting or a question restatement. Max 48 characters. No trailing punctuation. Examples: "Fix Auth Token Refresh", "Dark Mode Settings Toggle", "Onboarding Flow Redesign".
- "slug": the same task in kebab-case, [a-z0-9-] only, 2-5 words, max 32 characters. Standard branch-name style: starts with a verb or the feature noun. Examples: "fix-auth-token-refresh", "dark-mode-toggle", "onboarding-redesign".
- The slug MUST be derivable from the title (same words, lowercased and dashed, possibly shortened).
- If the message is trivial small talk with no task, still name what the conversation is about.
- Output the JSON object and NOTHING else.`;

/** Strict slug normalizer — the model's slug is re-normalized so the branch
    is git-safe no matter what came back. */
export function normalizeSlug(raw: string): string {
  const s = (raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  return s;
}

/** Parse the model reply into a SessionName, or null when unusable. */
export function parseNamingReply(raw: string): SessionName | null {
  if (!raw) return null;
  const fenced = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const first = fenced.indexOf('{');
  const last = fenced.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  let obj: unknown;
  try { obj = JSON.parse(fenced.slice(first, last + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const t = (obj as { title?: unknown }).title;
  const s = (obj as { slug?: unknown }).slug;
  const title = typeof t === 'string' ? t.trim().replace(/[.!?\s]+$/, '').slice(0, 48) : '';
  const slug = normalizeSlug(typeof s === 'string' ? s : title);
  if (!title || title.length < 3 || !slug || slug.length < 3) return null;
  return { title, slug };
}

/** Ask the model for {title, slug}. Null on ANY failure — callers keep the
    deterministic fallback. Soft timeout so the post-turn path never hangs. */
export async function generateSessionName(input: NamingInput): Promise<SessionName | null> {
  if (!input.apiKey || !input.userMessage?.trim()) return null;
  const fetcher = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, input.timeoutMs ?? 8000));
  const parts = [
    'First user message of the session:',
    '---',
    input.userMessage.slice(0, 2400),
    '---',
  ];
  if (input.assistantText?.trim()) {
    parts.push('', 'Assistant reply (tail, for context):', '---', input.assistantText.trim().slice(-1600), '---');
  }
  parts.push('', 'Output exactly one JSON object: {"title", "slug"}. Nothing else.');
  try {
    const res = await fetcher('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model ?? DEFAULT_NAMING_MODEL,
        max_tokens: 160,
        system: [{ type: 'text', text: NAMING_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: parts.join('\n') }] }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const txt = (json.content ?? []).find(c => c.type === 'text')?.text ?? '';
    return parseNamingReply(txt);
  } catch {
    return null; // naming is an enrichment, never a dependency
  } finally {
    clearTimeout(timeout);
  }
}
