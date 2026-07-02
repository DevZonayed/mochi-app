/* Codex rollout image harvest — the NATIVE no-API-key image path.

   Codex's built-in image_gen tool (rides the operator's ChatGPT sign-in) returns
   the finished PNG as a base64 `result` field on an `image_generation_call`
   response item. Under `codex exec` that item never reaches the --json stdout
   stream, and (as of codex 0.140) no file lands in ~/.codex/generated_images
   either — the ONLY place the bytes exist on disk is the session ROLLOUT file
   (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl), written by the
   codex core for every NON-ephemeral session. So image turns run without
   --ephemeral, thread_id is captured from the `thread.started` event, and the
   PNGs are decoded straight out of that rollout after the run. Proven live on
   the operator's ChatGPT subscription (2026-07-03), zero API keys involved. */

import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const defaultSessionsRoot = () => path.join(homedir(), '.codex', 'sessions');

/* Verify by MAGIC BYTES that a decoded payload really is an image — a truncated
   or non-base64 `result` must never be registered as an Asset. */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true; // WEBP
  return false;
}

/** Locate the rollout file for a thread. Rollouts are sharded by LOCAL date;
    an image turn is minutes old, so today + yesterday (midnight crossings)
    cover it. */
export function codexRolloutPath(threadId: string, sessionsRoot = defaultSessionsRoot()): string | undefined {
  for (const back of [0, 1]) {
    const day = new Date(Date.now() - back * 86_400_000);
    const dir = path.join(sessionsRoot, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    try {
      for (const f of readdirSync(dir)) if (f.endsWith(`-${threadId}.jsonl`)) return path.join(dir, f);
    } catch { /* day dir absent */ }
  }
  return undefined;
}

/** Decode every image_generation_call result in the thread's rollout, verified
    by image magic bytes and deduped by call id. `cleanup` deletes the rollout
    afterwards — Maestro turns are never `codex resume`d, and each image line is
    ~3 MB, so leaving them would pollute the user's session picker and disk. */
export function harvestCodexRolloutImages(threadId: string, cleanup: boolean, sessionsRoot = defaultSessionsRoot()): Buffer[] {
  const file = codexRolloutPath(threadId, sessionsRoot);
  if (!file) return [];
  const out: Buffer[] = [];
  const seen = new Set<string>();
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"image_generation_call"')) continue; // cheap pre-filter
      try {
        const d = JSON.parse(line) as { type?: string; payload?: { type?: string; id?: string; result?: string | null } };
        const p = d.payload;
        if (d.type !== 'response_item' || p?.type !== 'image_generation_call' || !p.result) continue;
        const key = p.id ?? `#${out.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const buf = Buffer.from(p.result.trim(), 'base64');
        if (looksLikeImage(buf)) out.push(buf);
        if (out.length >= 6) break;
      } catch { /* partial/foreign line */ }
    }
  } catch { return []; }
  if (cleanup) { try { rmSync(file, { force: true }); } catch { /* best effort */ } }
  return out;
}
