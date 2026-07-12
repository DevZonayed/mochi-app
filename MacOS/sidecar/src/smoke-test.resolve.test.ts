// Unit tests for the smoke-test spawn-target resolver.
//
// `--app <path>` must smoke the EXACT packaged app: spawn
// <app>/Contents/Resources/sidecar/bin/node running
// <app>/Contents/Resources/sidecar/maestro-sidecar.mjs — never ambient node or
// the source dist. `--bundle` and the default source path keep working. Path/arg
// resolution is a PURE function so it's testable without spawning anything.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveSmokeTarget } from './smoke-test.mjs';

const HERE = '/repo/MacOS/sidecar/src';

describe('resolveSmokeTarget', () => {
  it('--app <abs> spawns the packaged app embedded node + sidecar', () => {
    const t = resolveSmokeTarget(['node', 'smoke', '--app', '/Applications/Mochlet.app'], HERE, '/cwd');
    expect(t.mode).toBe('app');
    expect(t.node).toBe('/Applications/Mochlet.app/Contents/Resources/sidecar/bin/node');
    expect(t.args).toEqual(['/Applications/Mochlet.app/Contents/Resources/sidecar/maestro-sidecar.mjs']);
  });

  it('--app <relative> resolves against cwd, not the source tree', () => {
    const t = resolveSmokeTarget(['node', 'smoke', '--app', 'dist/Mochlet.app'], HERE, '/cwd');
    expect(t.mode).toBe('app');
    expect(t.node).toBe('/cwd/dist/Mochlet.app/Contents/Resources/sidecar/bin/node');
    expect(t.args[0]).toBe('/cwd/dist/Mochlet.app/Contents/Resources/sidecar/maestro-sidecar.mjs');
  });

  it('--app with no path is a hard error', () => {
    expect(() => resolveSmokeTarget(['node', 'smoke', '--app'], HERE, '/cwd')).toThrow(/--app/);
  });

  it('--bundle keeps running the source dist bundle via ambient node', () => {
    const t = resolveSmokeTarget(['node', 'smoke', '--bundle'], HERE, '/cwd');
    expect(t.mode).toBe('bundle');
    expect(t.node).toBe('node');
    expect(t.args).toEqual([path.join(HERE, '..', 'dist', 'maestro-sidecar.mjs')]);
  });

  it('the default (no flag) runs the TS entry via the dev loader', () => {
    const t = resolveSmokeTarget(['node', 'smoke'], HERE, '/cwd');
    expect(t.mode).toBe('source');
    expect(t.node).toBe('node');
    expect(t.args).toEqual(['--import', path.join(HERE, 'register.mjs'), path.join(HERE, 'headless-main.ts')]);
  });
});
