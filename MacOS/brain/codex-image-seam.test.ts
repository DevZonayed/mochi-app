/* Behavioral-seam regression: an arbitrary-named / extensionless Codex output must
   be MATERIALIZED into a trusted image copy that registers as an `image`. This drives
   the EXACT production helper `materializeCodexImage` that engine.ts uses (NOT a copy
   of its logic), plus the REAL collector (content + provenance) and the REAL
   PublishingEngine extension→kind classifier. If the production materialization
   helper is removed or its contract broken, this test fails. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// publishing.ts pulls electron for clipboard/nativeImage/shell at module load; stub
// it (we only touch the pure kindFromExt classifier). We do NOT mock the collector
// or the materialization helper.
vi.mock('electron', () => ({ clipboard: {}, nativeImage: {}, shell: {}, app: { getPath: () => '/tmp' } }));

import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectCodexGeneratedImages, materializeCodexImage } from './codex-rollout.js';
import { kindFromExt } from './publishing.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WEBP_HEAD = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const T = '019f66eb-642a-7e02-9c44-9972491a1362';
const SINCE = 1_700_000_000_000;

describe('Codex image materialization seam (collect → materialize → kind)', () => {
  let gen: string;
  let dest: string;
  const put = (name: string, bytes: Buffer): void => {
    const dir = path.join(gen, T);
    mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, name);
    writeFileSync(fp, bytes);
    utimesSync(fp, (SINCE + 5_000) / 1000, (SINCE + 5_000) / 1000);
  };

  beforeEach(() => {
    gen = mkdtempSync(path.join(tmpdir(), 'codex-seam-gen-'));
    dest = mkdtempSync(path.join(tmpdir(), 'codex-seam-dest-'));
  });
  afterEach(() => { rmSync(gen, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); });

  it('materializes an ARBITRARY-named .bin PNG into a trusted image copy classified as image', () => {
    put('artifact-v9.bin', PNG_BYTES);
    const [img] = collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen });
    expect(img.format).toBe('png');
    // The RAW source name would classify as NON-image → why materialization is required.
    expect(kindFromExt(img.path)).toBe('other');

    // The PRODUCTION helper (the same one engine.ts calls) does the normalize+copy.
    const out = materializeCodexImage(img, dest);
    expect(existsSync(out)).toBe(true);
    expect(realpathSync(out).startsWith(realpathSync(dest) + path.sep)).toBe(true); // inside trusted dest
    expect(path.basename(out)).toMatch(/^generated-.+\.png$/);                       // extension from DETECTED format
    expect(readFileSync(out).equals(PNG_BYTES)).toBe(true);                          // bytes preserved
    expect(kindFromExt(out)).toBe('image');                                          // now classifies as image
  });

  it('materializes an EXTENSIONLESS WebP source with the detected .webp extension', () => {
    put('output-no-extension', WEBP_HEAD);
    const [img] = collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen });
    expect(img.format).toBe('webp');
    const out = materializeCodexImage(img, dest);
    expect(path.basename(out)).toMatch(/^generated-.+\.webp$/);
    expect(readFileSync(out).equals(WEBP_HEAD)).toBe(true);
    expect(kindFromExt(out)).toBe('image');
  });

  it('disambiguates multiple outputs via seq (no collision)', () => {
    put('a.bin', PNG_BYTES);
    const [img] = collectCodexGeneratedImages({ threadId: T, since: SINCE, root: gen });
    const a = materializeCodexImage(img, dest, 0);
    const b = materializeCodexImage(img, dest, 1);
    expect(a).not.toBe(b);
    expect(existsSync(a) && existsSync(b)).toBe(true);
  });

  it('re-validates source magic at copy time — throws if the source is no longer a raster (TOCTOU)', () => {
    // Forge a collected record pointing at a non-raster; the helper must refuse.
    const bad = path.join(gen, T); mkdirSync(bad, { recursive: true });
    const badFile = path.join(bad, 'swapped.bin'); writeFileSync(badFile, Buffer.from('not an image at all'));
    expect(() => materializeCodexImage({ path: badFile, format: 'png' }, dest)).toThrow();
  });
});
