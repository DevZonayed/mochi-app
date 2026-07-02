import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  platformPkg, binaryRelPath, requiredVersion, managedBinary, engineState,
  setEnginesRoot, enginesRoot, downloadSpec, type EngineId,
} from './engines.js';

const SUPPORTED = platformPkg('codex') !== null; // this host has a prebuilt codex/claude

describe('platform mapping', () => {
  it('codex binary path ends in the codex executable', () => {
    const rel = binaryRelPath('codex');
    expect(rel).toMatch(/codex(\.exe)?$/);
    expect(rel).toContain('vendor');
  });
  it('claude binary path is the claude executable at the package root', () => {
    expect(binaryRelPath('claude')).toMatch(/^claude(\.exe)?$/);
  });
  it('maps codex/claude to the scoped per-platform packages on supported hosts', () => {
    if (!SUPPORTED) return;
    expect(platformPkg('codex')).toMatch(/^@openai\/codex-/);
    expect(platformPkg('claude')).toMatch(/^@anthropic-ai\/claude-agent-sdk-/);
  });
});

describe('requiredVersion (read from the bundled meta package)', () => {
  it('resolves a concrete version for each engine from node_modules', () => {
    // Deps are installed in CI/dev — the meta packages pin the platform binary,
    // which is the version we download. This guards the "no hardcoded version" design.
    for (const id of ['codex', 'claude'] as EngineId[]) {
      const v = requiredVersion(id);
      expect(v, `${id} version`).toBeTruthy();
      expect(v!).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe('downloadSpec (real npm package shapes)', () => {
  it('parses Codex npm: alias → real registry package + platform version', () => {
    if (!SUPPORTED) return;
    const spec = downloadSpec('codex')!;
    expect(spec).toBeTruthy();
    // Codex aliases @openai/codex-<plat> → npm:@openai/codex@<ver>-<plat>.
    expect(spec.registryPkg).toBe('@openai/codex');
    expect(spec.version).toMatch(new RegExp(`-${process.platform}-${process.arch}$`));
  });
  it('reads the Agent SDK platform package + plain version (exports-safe)', () => {
    if (!SUPPORTED) return;
    const spec = downloadSpec('claude')!;
    expect(spec).toBeTruthy();
    expect(spec.registryPkg).toMatch(/^@anthropic-ai\/claude-agent-sdk-/);
    expect(spec.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('managedBinary — version-pinned resolution', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'eng-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function lay(id: EngineId, version: string, withOk = true) {
    const dir = path.join(root, id, version);
    const bin = path.join(dir, binaryRelPath(id));
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\n');
    if (withOk) writeFileSync(path.join(dir, '.ok'), JSON.stringify({ version }));
  }

  it('returns null when nothing is installed', () => {
    if (!SUPPORTED) return;
    expect(managedBinary(root, 'codex')).toBeNull();
  });

  it('returns the binary for the pinned version when present + marked ok', () => {
    if (!SUPPORTED) return;
    const v = requiredVersion('codex')!;
    lay('codex', v);
    expect(managedBinary(root, 'codex')).toBe(path.join(root, 'codex', v, binaryRelPath('codex')));
  });

  it('ignores an install missing the .ok marker (interrupted download)', () => {
    if (!SUPPORTED) return;
    lay('codex', requiredVersion('codex')!, /* withOk */ false);
    expect(managedBinary(root, 'codex')).toBeNull();
  });

  it('ignores a stale version dir (only the pinned version resolves)', () => {
    if (!SUPPORTED) return;
    lay('claude', '0.0.1-old'); // some other version
    expect(managedBinary(root, 'claude')).toBeNull();
  });
});

describe('engineState', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'eng-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reports not-installed when nothing resolves', () => {
    const s = engineState(root, 'codex', null);
    expect(s.installed).toBe(false);
    expect(s.source).toBe('none');
  });

  it('labels a non-managed resolved path as a system install', () => {
    const s = engineState(root, 'codex', '/usr/local/bin/codex');
    expect(s.installed).toBe(true);
    expect(s.source).toBe('system');
    expect(s.path).toBe('/usr/local/bin/codex');
  });

  it('labels the managed copy as managed', () => {
    if (!SUPPORTED) return;
    const v = requiredVersion('codex')!;
    const bin = path.join(root, 'codex', v, binaryRelPath('codex'));
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\n');
    writeFileSync(path.join(root, 'codex', v, '.ok'), '{}');
    expect(engineState(root, 'codex', bin).source).toBe('managed');
  });
});

describe('enginesRoot override', () => {
  it('honors setEnginesRoot', () => {
    setEnginesRoot('/tmp/custom-engines');
    expect(enginesRoot()).toBe('/tmp/custom-engines');
  });
});
