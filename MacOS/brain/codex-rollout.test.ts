import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync, utimesSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexRolloutPath, harvestCodexRolloutImages, collectCodexGeneratedImages } from './codex-rollout.js';

/* A real minimal PNG (1×1 transparent pixel) — must pass the magic-byte check. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(TINY_PNG_B64, 'base64');
/* A real minimal JPEG (SOI + APP0 header bytes) — enough for the magic check. */
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
/* A real minimal WEBP header ("RIFF"...."WEBP"). */
const WEBP_HEAD = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

const THREAD = '019f0000-dead-beef-cafe-0123456789ab';

let root: string;

function shardDir(when = new Date()): string {
  return path.join(
    root,
    String(when.getFullYear()),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
  );
}

function writeRollout(lines: string[], when = new Date()): string {
  const dir = shardDir(when);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-03T00-00-00-${THREAD}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function imgLine(id: string, result: string | null): string {
  return JSON.stringify({
    type: 'response_item',
    payload: { type: 'image_generation_call', id, status: 'generating', result },
  });
}

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'codex-rollout-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('codexRolloutPath', () => {
  it('finds the rollout in today\'s shard by thread-id suffix', () => {
    const file = writeRollout([imgLine('ig_1', TINY_PNG_B64)]);
    expect(codexRolloutPath(THREAD, root)).toBe(file);
  });

  it('finds a rollout written yesterday (midnight crossing)', () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const file = writeRollout([imgLine('ig_1', TINY_PNG_B64)], yesterday);
    expect(codexRolloutPath(THREAD, root)).toBe(file);
  });

  it('returns undefined for an unknown thread', () => {
    writeRollout([imgLine('ig_1', TINY_PNG_B64)]);
    expect(codexRolloutPath('not-a-thread', root)).toBeUndefined();
  });
});

describe('harvestCodexRolloutImages', () => {
  it('decodes a valid image_generation_call result', () => {
    writeRollout([
      JSON.stringify({ type: 'session_meta', payload: { id: THREAD } }),
      imgLine('ig_1', TINY_PNG_B64),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
    ]);
    const imgs = harvestCodexRolloutImages(THREAD, false, root);
    expect(imgs).toHaveLength(1);
    // PNG magic
    expect(imgs[0][0]).toBe(0x89);
    expect(imgs[0][1]).toBe(0x50);
  });

  it('dedupes by call id (response_item + event_msg carry the same result)', () => {
    writeRollout([imgLine('ig_1', TINY_PNG_B64), imgLine('ig_1', TINY_PNG_B64)]);
    expect(harvestCodexRolloutImages(THREAD, false, root)).toHaveLength(1);
  });

  it('collects multiple distinct calls', () => {
    writeRollout([imgLine('ig_1', TINY_PNG_B64), imgLine('ig_2', TINY_PNG_B64)]);
    expect(harvestCodexRolloutImages(THREAD, false, root)).toHaveLength(2);
  });

  it('skips result-less items, non-image base64, and junk lines', () => {
    writeRollout([
      imgLine('ig_none', null),
      imgLine('ig_text', Buffer.from('definitely not an image').toString('base64')),
      '{"broken json "image_generation_call"',
      'plain text mentioning "image_generation_call"',
      imgLine('ig_ok', TINY_PNG_B64),
    ]);
    expect(harvestCodexRolloutImages(THREAD, false, root)).toHaveLength(1);
  });

  it('cleanup=true deletes the rollout file afterwards', () => {
    const file = writeRollout([imgLine('ig_1', TINY_PNG_B64)]);
    expect(harvestCodexRolloutImages(THREAD, true, root)).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  it('cleanup=false keeps the rollout file', () => {
    const file = writeRollout([imgLine('ig_1', TINY_PNG_B64)]);
    harvestCodexRolloutImages(THREAD, false, root);
    expect(existsSync(file)).toBe(true);
  });

  it('returns [] when no rollout exists for the thread', () => {
    expect(harvestCodexRolloutImages(THREAD, true, root)).toEqual([]);
  });

  // Diagnostics: a rollout with ZERO harvestable images is the ONLY on-disk
  // evidence of WHY the built-in tool produced nothing — never destroy it, even
  // when cleanup was requested. Cleanup is for SUCCESSFUL harvests only.
  it('cleanup=true PRESERVES the rollout when zero images are harvested', () => {
    const file = writeRollout([
      imgLine('ig_none', null),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
    ]);
    expect(harvestCodexRolloutImages(THREAD, true, root)).toEqual([]);
    expect(existsSync(file)).toBe(true); // preserved for diagnostics
  });
});

describe('collectCodexGeneratedImages', () => {
  let gen: string;
  const T = '019f66eb-642a-7e02-9c44-9972491a1362';
  const OTHER = '019f0000-1111-2222-3333-444444444444';
  const SINCE = 1_700_000_000_000; // fixed baseline ms

  const stamp = (fp: string, ms: number) => utimesSync(fp, ms / 1000, ms / 1000);
  function put(threadId: string, name: string, bytes: Buffer, mtimeMs = SINCE + 5_000): string {
    const dir = path.join(gen, threadId);
    mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, name);
    writeFileSync(fp, bytes);
    stamp(fp, mtimeMs);
    // The helper returns canonical (realpath'd) paths as part of its symlink-safety
    // contract; compare against the same so macOS /var→/private/var doesn't spoof a diff.
    return realpathSync(fp);
  }

  // The collector returns { path, format } objects; most tests only care about paths.
  const paths = (r: Array<{ path: string }>): string[] => r.map((x) => x.path);

  beforeEach(() => { gen = mkdtempSync(path.join(tmpdir(), 'codex-genimg-')); });
  afterEach(() => { rmSync(gen, { recursive: true, force: true }); });

  // ── Durable, filename/extension-INDEPENDENT contract (content + provenance) ──
  it('collects valid rasters with ARBITRARY names/extensions (future-proof, magic-based)', () => {
    const a = put(T, 'artifact-v3.bin', PNG_BYTES);
    const b = put(T, 'output-with-no-extension', JPEG_HEAD, SINCE + 6_000);
    expect(paths(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen }))).toEqual([a, b]);
  });

  it('reports the format detected by MAGIC bytes regardless of name', () => {
    put(T, 'weird.dat', WEBP_HEAD);
    const r = collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen });
    expect(r).toHaveLength(1);
    expect(r[0].format).toBe('webp');
  });

  it('collects a raster in a bounded NESTED subdirectory', () => {
    const dir = path.join(gen, T, 'a', 'b'); mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, 'img.dat'); writeFileSync(fp, PNG_BYTES); stamp(fp, SINCE + 5_000);
    expect(paths(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen }))).toEqual([realpathSync(fp)]);
  });

  it('bounds traversal DEPTH — a raster nested too deep is not collected', () => {
    const deep = path.join(gen, T, 'l1', 'l2', 'l3'); mkdirSync(deep, { recursive: true });
    const fp = path.join(deep, 'img.dat'); writeFileSync(fp, PNG_BYTES); stamp(fp, SINCE + 5_000);
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen, maxDepth: 1 })).toEqual([]);
  });

  it('bounds the number of directory entries scanned', () => {
    for (let i = 0; i < 20; i++) put(T, `noise-${i}.txt`, Buffer.from('x'));
    put(T, 'zzz-late.png', PNG_BYTES, SINCE + 9_000);
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen, maxEntries: 3 }).length).toBeLessThanOrEqual(1);
  });

  it('rejects a file larger than the max size cap (even a valid raster)', () => {
    put(T, 'exec-huge.png', Buffer.concat([PNG_BYTES, Buffer.alloc(4096)]));
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen, maxBytes: 64 })).toEqual([]);
  });

  it('rejects a non-raster even when the name looks like an image', () => {
    put(T, 'exec-fake.png', Buffer.from('not an image, just text bytes here'));
    put(T, 'notes.txt', Buffer.from('hello'));
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen })).toEqual([]);
  });

  it('collects a fresh exec-<uuid>.png from the thread dir (codex ≥0.144 layout)', () => {
    const fp = put(T, 'exec-48279406-e8de-436b-8eb7-18355235c404.png', PNG_BYTES);
    expect(paths(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen }))).toEqual([fp]);
  });

  it('still supports the legacy ig_*.png name', () => {
    const fp = put(T, 'ig_1.png', PNG_BYTES);
    expect(paths(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen }))).toEqual([fp]);
  });

  it('accepts JPEG and WebP magic too', () => {
    const j = put(T, 'exec-a.jpg', JPEG_HEAD);
    const w = put(T, 'exec-b.webp', WEBP_HEAD, SINCE + 6_000);
    expect(paths(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen }))).toEqual([j, w]);
  });

  it('is thread-isolated: never returns another thread\'s images', () => {
    put(OTHER, 'exec-other.png', PNG_BYTES);
    const mine = put(T, 'exec-mine.png', PNG_BYTES);
    expect(paths(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen }))).toEqual([mine]);
  });

  it('skips stale files written before `since`', () => {
    put(T, 'exec-old.png', PNG_BYTES, SINCE - 10_000);
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen })).toEqual([]);
  });

  it('skips symlinks (never follows a link out to an arbitrary file)', () => {
    const outside = path.join(gen, 'secret.png');
    writeFileSync(outside, PNG_BYTES); stamp(outside, SINCE + 5_000);
    const dir = path.join(gen, T); mkdirSync(dir, { recursive: true });
    symlinkSync(outside, path.join(dir, 'exec-link.png'));
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen })).toEqual([]);
  });

  it('skips files whose bytes are not a real raster (wrong magic)', () => {
    put(T, 'exec-fake.png', Buffer.from('this is not a PNG at all, just text'));
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen })).toEqual([]);
  });

  it('skips zero-byte files', () => {
    put(T, 'exec-empty.png', Buffer.alloc(0));
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen })).toEqual([]);
  });

  it('returns [] when the thread dir does not exist', () => {
    expect(collectCodexGeneratedImages({ threadId: 'nope', since: SINCE, root: gen })).toEqual([]);
  });

  it('caps the number of returned images at `limit`', () => {
    for (let i = 0; i < 8; i++) put(T, `exec-${i}.png`, PNG_BYTES, SINCE + 1_000 + i * 100);
    expect(collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen, limit: 3 })).toHaveLength(3);
  });

  // THREAD-REQUIRED: harvesting is ALWAYS scoped to exactly one thread dir. An
  // absent / blank / malformed threadId must FAIL CLOSED ([]) — never a global
  // scan (that leaks a concurrent run's images) and never a scan of the root or
  // anything outside the confined thread directory.
  it('is THREAD-REQUIRED: absent threadId returns [] (never globally scans other threads)', () => {
    put(OTHER, 'exec-other.png', PNG_BYTES);
    expect(collectCodexGeneratedImages({ since: SINCE, root: gen })).toEqual([]);
  });

  it('is THREAD-REQUIRED: blank threadId returns [] (never globally scans)', () => {
    put(OTHER, 'exec-other.png', PNG_BYTES);
    expect(collectCodexGeneratedImages({ since: SINCE, root: gen, threadId: '' })).toEqual([]);
  });

  it('fails closed for a malformed threadId (dot / traversal) — never scans the root or outside', () => {
    // A fresh valid image sitting DIRECTLY in the root must never be reachable
    // via '.', and another thread's image must never leak via '..'/traversal.
    const rootImg = path.join(gen, 'exec-root.png');
    writeFileSync(rootImg, PNG_BYTES); stamp(rootImg, SINCE + 5_000);
    put(OTHER, 'exec-other.png', PNG_BYTES);
    for (const bad of ['.', '..', 'a/b', '../evil', 'x/../y', '.hidden']) {
      expect(collectCodexGeneratedImages({ since: SINCE, root: gen, threadId: bad })).toEqual([]);
    }
  });
});
