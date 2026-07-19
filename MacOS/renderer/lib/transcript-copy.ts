/* Tab transcript-copy orchestration — the logic behind the chat tab's
   "Copy concise transcript" / "Copy full transcript" context-menu items and the
   ⌘⌥C shortcut.

   Native WebKit rejects `navigator.clipboard.writeText` outright, so a direct
   clipboard write there fails silently and the UI mis-reports "Copied". This
   helper keeps the copy path pure + injectable: the caller supplies a job
   loader, a formatter, and a copy function (the native pasteboard bridge with a
   browser fallback — see `copyTextWith`). It returns a discriminated result so
   the UI can distinguish "nothing to copy" / "couldn't load" / "couldn't
   format" / "clipboard failed" and only ever flash success on a confirmed
   `{ ok: true }`.

   Two boundaries here are UNTYPED at runtime and must be treated defensively:
     • `format` can THROW on a malformed/legacy job shape — we must not let that
       escape as an unhandled rejection or (worse) reach `copy`.
     • `copy`'s resolved value crosses the native-bridge / injected-fn boundary,
       so `undefined` / `null` / `{ ok:'true' }` are all possible and must NEVER
       be read as success (that is the production `?? { ok:true }` bug). */

import type { Job } from './api';

export interface TranscriptCopyDeps {
  /** Whether the tab has a real session yet (nothing to copy before the first send). */
  hasSession: boolean;
  /** Load the complete set of turns to render (copy is an explicit action, so no paging). */
  loadJobs: () => Promise<Job[]>;
  /** Render the loaded jobs to the exact clipboard text (e.g. formatTranscript). May throw. */
  format: (jobs: Job[]) => string;
  /** Write text to the clipboard — resolves { ok } (native pasteboard or browser fallback). */
  copy: (text: string) => Promise<{ ok: boolean; error?: string }>;
}

export type TranscriptCopyReason = 'no-session' | 'load-failed' | 'empty' | 'format-failed' | 'copy-failed';

export type TranscriptCopyOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: TranscriptCopyReason; message: string; error?: string };

function errMessage(e: unknown): string | undefined {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return undefined;
}

/** Strict success test for an `{ ok, error? }` envelope that crossed an untyped
    boundary (native bridge / injected fn). ONLY a literal `ok === true` counts;
    `undefined`, `null`, `{}`, `{ ok:'true' }`, `{ ok:1 }` are all failures and
    never throw. */
function isCopyOk(res: unknown): boolean {
  return typeof res === 'object' && res !== null && (res as { ok?: unknown }).ok === true;
}

/** Best-effort error string from a malformed/failed copy envelope. */
function copyErrorOf(res: unknown): string | undefined {
  if (typeof res === 'object' && res !== null) {
    const e = (res as { error?: unknown }).error;
    if (typeof e === 'string') return e;
  }
  return undefined;
}

/** Orchestrate a single transcript copy. NEVER throws — every failure mode maps
    to a distinct, truthful `{ ok:false, reason }`; success only after a
    confirmed `{ ok:true }` from `copy`. */
export async function runTranscriptCopy(deps: TranscriptCopyDeps): Promise<TranscriptCopyOutcome> {
  if (!deps.hasSession) {
    return { ok: false, reason: 'no-session', message: 'Send a message first' };
  }

  let jobs: Job[];
  try {
    jobs = await deps.loadJobs();
  } catch (e) {
    return { ok: false, reason: 'load-failed', message: "Couldn't load transcript", error: errMessage(e) };
  }

  if (!jobs.length) {
    return { ok: false, reason: 'empty', message: 'Nothing to copy yet' };
  }

  // The formatter walks arbitrary (possibly legacy/malformed) job shapes and can
  // throw. Contain it here so a bad job never surfaces as "Copy failed" (wrong
  // cause) and never reaches the clipboard.
  let text: string;
  try {
    text = deps.format(jobs);
  } catch (e) {
    return { ok: false, reason: 'format-failed', message: "Couldn't format transcript", error: errMessage(e) };
  }
  if (typeof text !== 'string') {
    return { ok: false, reason: 'format-failed', message: "Couldn't format transcript" };
  }

  let res: unknown;
  try {
    res = await deps.copy(text);
  } catch (e) {
    return { ok: false, reason: 'copy-failed', message: 'Copy failed', error: errMessage(e) };
  }

  if (!isCopyOk(res)) {
    return { ok: false, reason: 'copy-failed', message: 'Copy failed', error: copyErrorOf(res) };
  }
  return { ok: true, text };
}

/* ── Clipboard strategy: native pasteboard first, browser clipboard fallback ── */

export interface CopyTextOptions {
  /** The native pasteboard bridge (WebKit `window.maestro.copyText`), if present. */
  native?: (text: string) => Promise<{ ok: boolean; error?: string }>;
  /** The browser Clipboard API, used only when there is no native bridge. */
  clipboard?: { writeText(text: string): Promise<void> } | null;
}

/** Copy `text` using the native pasteboard bridge when available, else the
    browser clipboard. Always resolves an `{ ok, error? }` envelope (never
    throws) so callers can report a truthful outcome. The native result is
    validated STRICTLY — a missing/malformed response is a failure, and we do
    NOT silently fall back to the browser clipboard (which WebKit rejects
    anyway) on the native path. */
export async function copyTextWith(text: string, opts: CopyTextOptions): Promise<{ ok: boolean; error?: string }> {
  if (opts.native) {
    try {
      const res: unknown = await opts.native(text);
      if (isCopyOk(res)) return { ok: true };
      return { ok: false, error: copyErrorOf(res) ?? 'native copy failed' };
    } catch (e) {
      return { ok: false, error: errMessage(e) ?? 'native copy failed' };
    }
  }
  const clip = opts.clipboard;
  if (clip?.writeText) {
    try {
      await clip.writeText(text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMessage(e) ?? 'clipboard write failed' };
    }
  }
  return { ok: false, error: 'clipboard unavailable' };
}
