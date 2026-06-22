import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureNodeShim, codexPathEnv, codexSpawnEnv, bootstrapNodePath, _resetForTests,
} from './node-shim.js';

const isWin = process.platform === 'win32';
const SHIM_NAME = isWin ? 'node.cmd' : 'node';
const PATH_SEP = isWin ? ';' : ':';

describe('node-shim', () => {
  let root: string;
  let origPath: string | undefined;
  beforeEach(() => {
    _resetForTests();
    root = mkdtempSync(path.join(tmpdir(), 'node-shim-test-'));
    origPath = process.env.PATH;
  });
  afterEach(() => {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the shim directory + a node shim that wraps process.execPath', () => {
    const dir = ensureNodeShim(root);
    expect(dir).toBe(path.join(root, 'node-shim'));
    const shim = path.join(dir, SHIM_NAME);
    expect(existsSync(shim), 'shim file should exist').toBe(true);
    const body = readFileSync(shim, 'utf8');
    // The shim must reference Electron's exec (the node-bearing binary) and
    // set ELECTRON_RUN_AS_NODE so it actually behaves as plain node.
    expect(body).toContain(process.execPath);
    expect(body).toContain('ELECTRON_RUN_AS_NODE');
  });

  it('marks the POSIX shim executable (chmod +x)', () => {
    if (isWin) return;
    const dir = ensureNodeShim(root);
    const mode = statSync(path.join(dir, SHIM_NAME)).mode & 0o777;
    // At minimum the owner-execute bit must be set, otherwise PATH lookups
    // would find the file but fail to launch it.
    expect((mode & 0o100) !== 0, `mode=${mode.toString(8)} should be +x`).toBe(true);
  });

  it('is idempotent: calling twice returns the same dir without rewriting content', () => {
    const a = ensureNodeShim(root);
    const before = readFileSync(path.join(a, SHIM_NAME), 'utf8');
    const b = ensureNodeShim(root);
    const after = readFileSync(path.join(b, SHIM_NAME), 'utf8');
    expect(b).toBe(a);
    expect(after).toBe(before);
  });

  it('codexPathEnv puts the shim FIRST and preserves the existing PATH', () => {
    process.env.PATH = ['/usr/bin', '/bin'].join(PATH_SEP);
    const merged = codexPathEnv(root);
    const parts = merged.split(PATH_SEP);
    expect(parts[0]).toBe(path.join(root, 'node-shim'));
    expect(parts).toContain('/usr/bin');
    expect(parts).toContain('/bin');
  });

  it('codexPathEnv dedupes — running twice or with overlapping shell-PATH yields no duplicates', () => {
    process.env.PATH = ['/usr/bin', '/usr/bin', '/bin'].join(PATH_SEP);
    const parts = codexPathEnv(root).split(PATH_SEP);
    const dupes = parts.filter((p, i) => parts.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });

  it('codexSpawnEnv merges process.env, caller overrides, and the new PATH', () => {
    process.env.PATH = '/usr/bin';
    process.env.MAESTRO_TEST_KEEP = 'kept'; // a sentinel that must survive the merge
    const env = codexSpawnEnv(root, { OPENAI_API_KEY: 'sk-xyz' });
    expect(env.OPENAI_API_KEY).toBe('sk-xyz');
    expect(env.MAESTRO_TEST_KEEP).toBe('kept');
    expect(env.PATH!.split(PATH_SEP)[0]).toBe(path.join(root, 'node-shim'));
    delete process.env.MAESTRO_TEST_KEEP;
  });

  it('bootstrapNodePath mutates process.env.PATH in place and is idempotent', () => {
    process.env.PATH = '/usr/bin';
    bootstrapNodePath(root);
    const after1 = process.env.PATH;
    expect(after1!.split(PATH_SEP)[0]).toBe(path.join(root, 'node-shim'));
    bootstrapNodePath(root); // second call must not double-prepend
    expect(process.env.PATH).toBe(after1);
  });

  it('the POSIX shim actually behaves as a node interpreter when invoked', () => {
    // Skip on Windows (different harness for .cmd, and this Vitest doesn't run
    // there in CI for this monorepo) and when Electron's exec is plain node
    // (Vitest runs under plain node — that's fine, it satisfies the test).
    if (isWin) return;
    const dir = ensureNodeShim(root);
    const shim = path.join(dir, SHIM_NAME);
    // Use the shim to evaluate a trivial expression. If process.execPath is
    // an Electron binary, this exercises ELECTRON_RUN_AS_NODE; if it's plain
    // node (Vitest), it still must print "ok".
    const out = execFileSync(shim, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
    expect(out).toBe('ok');
  });
});
