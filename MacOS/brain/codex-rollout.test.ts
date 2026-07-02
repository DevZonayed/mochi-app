import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexRolloutPath, harvestCodexRolloutImages } from './codex-rollout.js';

/* A real minimal PNG (1×1 transparent pixel) — must pass the magic-byte check. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
});
