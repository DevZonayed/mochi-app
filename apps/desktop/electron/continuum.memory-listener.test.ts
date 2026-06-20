/* onMemoryWrite — verify writeProjectState + appendCheckpoint fire the listener
   AFTER the disk write succeeds, and that a throwing listener doesn't break
   subsequent writes (the agent's run shouldn't fail if a mirror push errors). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeProjectState,
  appendCheckpoint,
  onMemoryWrite,
  type MemoryWriteEvent,
} from './continuum.js';

let root = '';

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'maestro-cont-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* fine */ } });

describe('onMemoryWrite — writeProjectState', () => {
  it('fires a state event after STATE.md is on disk', () => {
    const seen: MemoryWriteEvent[] = [];
    const unsub = onMemoryWrite((e) => seen.push(e));
    writeProjectState(root, 'first version');
    unsub();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ projectRoot: root, kind: 'state', content: 'first version' });
    // Listener observes the same content that landed on disk.
    expect(readFileSync(join(root, '.continuum', 'STATE.md'), 'utf8')).toBe('first version');
  });

  it('caps content the same way for disk and listener', () => {
    const seen: MemoryWriteEvent[] = [];
    const unsub = onMemoryWrite((e) => seen.push(e));
    const huge = 'x'.repeat(50_000);
    writeProjectState(root, huge);
    unsub();
    // STATE_CAP = 16_000 — listener content matches the truncated disk content.
    expect(seen[0].content.length).toBe(16_000);
    expect(readFileSync(join(root, '.continuum', 'STATE.md'), 'utf8').length).toBe(16_000);
  });

  it('unsubscribe stops further deliveries', () => {
    const seen: MemoryWriteEvent[] = [];
    const unsub = onMemoryWrite((e) => seen.push(e));
    writeProjectState(root, 'a');
    unsub();
    writeProjectState(root, 'b');
    expect(seen).toHaveLength(1);
  });

  it('a throwing listener doesn\'t break the write or other listeners', () => {
    const calls: string[] = [];
    const unsubBad = onMemoryWrite(() => { throw new Error('oops'); });
    const unsubGood = onMemoryWrite((e) => calls.push(e.content));
    writeProjectState(root, 'ok');
    unsubBad(); unsubGood();
    expect(calls).toEqual(['ok']);
    expect(existsSync(join(root, '.continuum', 'STATE.md'))).toBe(true);
  });
});

describe('onMemoryWrite — appendCheckpoint', () => {
  it('fires a checkpoint event with commit + tags', () => {
    const seen: MemoryWriteEvent[] = [];
    const unsub = onMemoryWrite((e) => seen.push(e));
    appendCheckpoint(root, { summary: 'first checkpoint', commit: 'abc123', tags: ['ship'] }, 1700_000_000_000);
    unsub();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      projectRoot: root,
      kind: 'checkpoint',
      content: 'first checkpoint',
      commitSha: 'abc123',
      tags: ['ship'],
    });
  });

  it('multiple checkpoints each fire their own event', () => {
    const seen: MemoryWriteEvent[] = [];
    const unsub = onMemoryWrite((e) => seen.push(e));
    appendCheckpoint(root, { summary: 'one', commit: 'a' }, 1);
    appendCheckpoint(root, { summary: 'two', commit: 'b' }, 2);
    unsub();
    expect(seen.map((e) => e.commitSha)).toEqual(['a', 'b']);
  });
});
