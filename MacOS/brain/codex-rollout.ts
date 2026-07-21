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

import { readFileSync, readdirSync, rmSync, realpathSync, lstatSync, openSync, readSync, closeSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const defaultSessionsRoot = () => path.join(homedir(), '.codex', 'sessions');
const defaultGeneratedImagesRoot = () => path.join(homedir(), '.codex', 'generated_images');

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
  // Cleanup ONLY after a SUCCESSFUL harvest. A rollout that yielded zero images is
  // the sole on-disk record of WHY the built-in tool produced nothing (e.g. codex
  // ≥0.144 writes the PNG to generated_images and nothing to the rollout) — deleting
  // it would destroy the only diagnostic. Preserve it for inspection instead.
  if (cleanup && out.length) { try { rmSync(file, { force: true }); } catch { /* best effort */ } }
  return out;
}

/** A raster format Codex's built-in image_gen can emit, identified by CONTENT. */
export type DetectedImageFormat = 'png' | 'jpeg' | 'webp';

/** Identify a raster by its MAGIC bytes — NOT its filename or extension — so the
    collector survives any future Codex filename/extension change. Needs ≤12 bytes.
    (Keeps parity with `looksLikeImage`, which the rollout-byte path still uses.) */
export function detectImageFormat(buf: Buffer): DetectedImageFormat | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

/** Read a file's leading bytes and return the detected raster format, or null.
    Reads at most 12 bytes; never throws. */
function fileImageFormat(fp: string): DetectedImageFormat | null {
  let fd: number | undefined;
  try {
    fd = openSync(fp, 'r');
    const head = Buffer.alloc(12);
    const n = readSync(fd, head, 0, 12, 0);
    return detectImageFormat(head.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* noop */ } }
  }
}

/* Traversal + acceptance BOUNDS for the generated-images collector. Small,
   explicit, and overridable per-call (tests). A run's images are a handful of
   files in one thread dir, so these are generous but hard caps that keep a
   hostile/huge dir from being walked unbounded. */
const GEN_MAX_DEPTH = 4;                    // thread dir = depth 0; allow a little nesting
const GEN_MAX_ENTRIES = 4096;              // total dirents visited across the walk
const GEN_MAX_BYTES = 64 * 1024 * 1024;    // 64 MB — well above any real generated image

/** A collected Codex output: its canonical on-disk path + the raster format the
    caller MUST use to name a trusted copy (never trust the source filename). */
export interface CollectedCodexImage {
  path: string;
  format: DetectedImageFormat;
}

/**
 * Collect the image files Codex's built-in `image_gen` tool wrote under
 * `~/.codex/generated_images` for this run — the PRIMARY on-disk harvest for
 * codex ≥0.144, which puts the raster on disk and NOTHING in the rollout (so the
 * rollout-byte path finds nothing).
 *
 * DURABLE, filename/extension-INDEPENDENT design — acceptance is by PROVENANCE +
 * CONTENT, never a filename or extension pattern (so a future Codex naming change
 * can't silently break collection):
 *  - THREAD-REQUIRED and FAIL-CLOSED: always scoped to exactly one thread dir
 *    `<root>/<threadId>/`. An absent, blank, or malformed `threadId` (anything but a
 *    bare `[A-Za-z0-9_-]+` id — so no `.`/`..`/`/` traversal), or a non-existent
 *    thread dir, returns []. NEVER globally scans other threads (cross-run leak).
 *  - CONFINED: the resolved thread dir must sit STRICTLY inside the realpath'd
 *    `generated_images` root; every visited subdirectory is re-confined.
 *  - BOUNDED recursive walk: at most `maxDepth` levels and `maxEntries` total
 *    dirents; symlinked dirs are never followed.
 *  - A file is accepted ONLY when it is a regular, NON-symlink file (lstat), with
 *    size in `(0, maxBytes]`, mtime ≥ `since` (this run), AND whose leading bytes
 *    carry a PNG/JPEG/WebP MAGIC signature. Name/extension are irrelevant.
 *  - Returns `{ path, format }` oldest→newest, capped at `limit` (default 6).
 */
export function collectCodexGeneratedImages(opts: {
  since: number;
  threadId?: string;
  root?: string;
  limit?: number;
  maxDepth?: number;
  maxEntries?: number;
  maxBytes?: number;
}): CollectedCodexImage[] {
  const limit = opts.limit ?? 6;
  const maxDepth = opts.maxDepth ?? GEN_MAX_DEPTH;
  const maxEntries = opts.maxEntries ?? GEN_MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? GEN_MAX_BYTES;

  // THREAD-REQUIRED: a valid, traversal-free thread id is mandatory — fail closed
  // otherwise. `[A-Za-z0-9_-]+` (no dots/slashes) excludes '.', '..', 'a/b', etc.
  const threadId = opts.threadId;
  if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) return [];

  let rootReal: string;
  try { rootReal = realpathSync(opts.root ?? defaultGeneratedImagesRoot()); } catch { return []; }
  // Resolve ONLY the exact thread dir; a non-existent thread → [].
  let baseReal: string;
  try { baseReal = realpathSync(path.join(rootReal, threadId)); } catch { return []; }
  // Confinement: the thread dir must live STRICTLY inside the root (never the root
  // itself, never escaped via a symlink).
  if (!baseReal.startsWith(rootReal + path.sep)) return [];

  const found: Array<{ fp: string; mtime: number; format: DetectedImageFormat }> = [];
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || scanned >= maxEntries) return;
    let ents: import('node:fs').Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (scanned >= maxEntries) return;
      scanned++;
      const fp = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;       // never follow a symlinked dir OR file
      if (d.isDirectory()) {
        // Re-confine every descended directory (belt-and-suspenders vs a swapped dir).
        let sub: string;
        try { sub = realpathSync(fp); } catch { continue; }
        if (sub !== baseReal && !sub.startsWith(baseReal + path.sep)) continue;
        walk(sub, depth + 1);
        continue;
      }
      if (!d.isFile()) continue;
      let st;
      try { st = lstatSync(fp); } catch { continue; }
      if (!st.isFile()) continue;                       // race guard (regular file only)
      if (st.size <= 0 || st.size > maxBytes) continue; // empty / oversized → reject
      if (st.mtimeMs < opts.since) continue;            // written before this run → reject
      const format = fileImageFormat(fp);               // CONTENT check — name is irrelevant
      if (!format) continue;
      found.push({ fp, mtime: st.mtimeMs, format });
    }
  };
  walk(baseReal, 0);

  found.sort((a, b) => a.mtime - b.mtime);
  return found.slice(0, limit).map(({ fp, format }) => ({ path: fp, format }));
}

/** Extension for a detected raster format (the ONLY names importAsset treats as an
    image without ambiguity). Derived from CONTENT, never a source filename. */
function extForFormat(format: DetectedImageFormat): 'png' | 'jpg' | 'webp' {
  return format === 'jpeg' ? 'jpg' : format;
}

/**
 * Materialize a collected Codex output into a TRUSTED copy inside `destDir`, and
 * return the copy's absolute path. This is the SINGLE production normalization the
 * engine uses so an arbitrary/extensionless Codex source is registered as an image:
 *  - The copy is named `generated-<ts>[-<seq>].<png|jpg|webp>` where the extension
 *    is derived SOLELY from the content-detected magic `format` — NEVER the source
 *    name — so PublishingEngine.importAsset classifies it as `image`, not `other`.
 *    The name is fully synthesized (no source component), so there is no path
 *    traversal / unsafe destination naming from an attacker-chosen filename.
 *  - Source magic is RE-VALIDATED here (re-read + re-detect): this closes the
 *    collect→copy TOCTOU race (a file swapped between collection and copy) and makes
 *    the helper FAIL (throw) rather than silently materialize a misclassified file.
 *  - Bytes are copied verbatim (no re-encode).
 */
export function materializeCodexImage(img: CollectedCodexImage, destDir: string, seq = 0): string {
  // Re-validate the source is STILL exactly the detected raster at copy time.
  const actual = fileImageFormat(img.path);
  if (!actual || actual !== img.format) {
    throw new Error(`codex image is not a valid ${img.format} at copy time (detected ${actual ?? 'none'})`);
  }
  mkdirSync(destDir, { recursive: true });
  const name = `generated-${Date.now().toString(36)}${seq ? `-${seq}` : ''}.${extForFormat(img.format)}`;
  const dest = path.join(destDir, name);
  copyFileSync(img.path, dest);
  return dest;
}
