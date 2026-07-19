/* ENGINE-LEVEL wiring regression: proves the REAL runCodex image path invokes
   `materializeCodexImage` (trusted normalize+copy) BEFORE PublishingEngine.importAsset.
   It executes production runCodex with a mocked `spawn` that emits a real `thread.started`
   JSONL then closes 0, and a fresh valid PNG with an ARBITRARY `.bin` name in that exact
   thread dir. If engine.ts reverts to `take(collected[i].path)` (raw source), importAsset
   would receive the `.bin` path OUTSIDE the trusted dest and this test FAILS.
   Touches only temp dirs (test-only ctx injection for the images root + asset dest). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  dir: '/tmp',
  spawnImpl: (..._a: unknown[]): unknown => { throw new Error('spawn impl not set'); },
}));

// engine.ts imports electron at load; stub it (established brain-test pattern).
vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} },
  clipboard: {}, nativeImage: {}, shell: {},
}));
// Mock spawn so no real codex runs; keep every other child_process export real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...a: unknown[]) => hoisted.spawnImpl(...a) };
});
// Make resolveCodex resolve to a fake binary (spawn is mocked) so the test is
// deterministic regardless of whether codex is installed on the host.
vi.mock('./engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engines.js')>();
  return { ...actual, systemBinary: (id: string) => (id === 'codex' ? '/tmp/fake-codex-bin' : (actual as { systemBinary: (i: string) => string | null }).systemBinary(id)) };
});

import { runCodex } from './engine.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('runCodex Codex generated-images wiring → materialize before importAsset', () => {
  let imagesRoot: string, destDir: string, cwd: string;
  beforeEach(() => {
    imagesRoot = mkdtempSync(path.join(tmpdir(), 'codex-eng-images-'));
    destDir = mkdtempSync(path.join(tmpdir(), 'codex-eng-dest-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'codex-eng-cwd-'));
  });
  afterEach(() => {
    for (const d of [imagesRoot, destDir, cwd]) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('materializes an arbitrary-named .bin PNG into a trusted .png inside the asset dest, then imports THAT', async () => {
    const THREAD = 'engine-thread-abc123';
    const importAsset = vi.fn((p: string) => ({ id: 'asset-xyz', localPath: p, width: 2, height: 2 }));
    const publishing = { importAsset } as unknown as import('./publishing.js').PublishingEngine;
    const store = { getProject: vi.fn(() => ({ name: 'proj' })) } as unknown as import('./store.js').Store;

    hoisted.spawnImpl = () => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      // Emit AFTER the current sync stack (so runStart is set + the test has created
      // the output file), then close 0.
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: THREAD }) + '\n');
        setImmediate(() => { child.stdout.end(); child.emit('close', 0, null); });
      });
      return child;
    };

    const p = runCodex('generate an image', cwd, {}, false, undefined,
      { store, projectId: null, publishing, imageIntent: true, codexImagesRoot: imagesRoot, assetsDir: destDir },
      undefined);

    // Create the codex output NOW (after runStart was captured inside the executor),
    // with an arbitrary `.bin` name — only production materialization turns it into
    // a trusted `.png` inside destDir.
    const threadDir = path.join(imagesRoot, THREAD);
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(path.join(threadDir, 'artifact-v9.bin'), PNG_BYTES);

    const run = await p;

    // The engine MUST have materialized before importing.
    expect(importAsset).toHaveBeenCalledTimes(1);
    const imported = importAsset.mock.calls[0][0] as string;
    expect(imported).not.toContain('artifact-v9.bin');                         // NOT the raw source
    expect(path.basename(imported)).toMatch(/^generated-.+\.png$/);            // normalized name + detected ext
    expect(realpathSync(imported).startsWith(realpathSync(destDir) + path.sep)).toBe(true); // inside trusted dest
    expect(readFileSync(imported).equals(PNG_BYTES)).toBe(true);              // bytes preserved
    expect(run.images).toHaveLength(1);
    expect(run.images![0].assetId).toBe('asset-xyz');
    expect(run.images![0].imagePath).toBe(imported);
  });
});
