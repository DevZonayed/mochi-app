/* Multi-writer durability — the exact failure that erased a freshly-created
   design project and its chat sessions.

   The store is one JSON file loaded once into memory; every mutation rewrites
   the whole file. When TWO Store instances point at the same file (a second
   app instance, or this-chat's engine host running alongside the dev app), a
   naive whole-file overwrite is last-writer-wins: the writer holding an older
   in-memory snapshot silently erases rows the other one added.

   save() now detects that the file changed since we last touched it and MERGES
   the foreign copy in before writing (union by id, newest-write-wins, deletes
   propagate via tombstones), so two writers CONVERGE instead of clobber. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync, writeFileSync, existsSync, statSync, chmodSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-multiwriter-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

const STOREFILE = join(hoisted.dir, 'maestro-store.json');
const LOCK = join(hoisted.dir, 'maestro-store.json.lock');
const mode = (f: string) => statSync(f).mode & 0o777;

describe('Store — concurrent writers do not clobber each other', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('a stale writer absorbs the other process\'s new project + sessions instead of erasing them', () => {
    // Process A boots and creates a project with a chat session.
    const A = new Store();
    const p1 = A.createProject({ name: 'Alpha' });
    A.createSession(p1.id, 'alpha chat');

    // Process B boots (loads the same file → sees Alpha), then the USER creates
    // a brand-new project + chat in B. B writes the file with Alpha + Beta.
    const B = new Store();
    const p2 = B.createProject({ name: 'Beta' });          // the "vanishing" project
    B.createSession(p2.id, 'beta chat');

    // Process A is still holding its OLD in-memory snapshot (only Alpha). It now
    // saves again (any mutation). Pre-fix, this overwrote the file and Beta +
    // its session were gone forever. Post-fix, A merges Beta in first.
    const p3 = A.createProject({ name: 'Gamma' });

    // A fresh reader sees ALL THREE projects and ALL sessions — nothing lost.
    const C = new Store();
    const names = C.listProjects().map(p => p.name).sort();
    expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(C.listSessions(p1.id)).toHaveLength(1);
    expect(C.listSessions(p2.id)).toHaveLength(1);   // Beta's chat survived
    expect(C.listSessions(p3.id)).toHaveLength(0);
  });

  it('newest write wins on a shared row id', () => {
    const A = new Store();
    const p = A.createProject({ name: 'Shared' });

    const B = new Store();                 // sees Shared
    B.updateProject(p.id, { name: 'Renamed-by-B' }); // older write

    // A renames the same project later (newer updatedAt) and saves.
    const later = A.updateProject(p.id, { name: 'Renamed-by-A' });
    expect(later.name).toBe('Renamed-by-A');

    const C = new Store();
    expect(C.getProject(p.id)?.name).toBe('Renamed-by-A');
  });

  it('a delete in one process is not resurrected by a stale writer', () => {
    const A = new Store();
    const keep = A.createProject({ name: 'Keep' });
    const doomed = A.createProject({ name: 'Doomed' });

    // B boots (sees both), deletes Doomed (records a tombstone), writes.
    const B = new Store();
    B.deleteProject(doomed.id);

    // A (stale — still thinks Doomed exists) saves again. The delete must win:
    // A absorbs B's tombstone and does not write Doomed back to life.
    A.updateProject(keep.id, { color: 'blue' });

    const C = new Store();
    const names = C.listProjects().map(p => p.name).sort();
    expect(names).toEqual(['Keep']);
    expect(C.getProject(doomed.id)).toBeUndefined();
  });
});

describe('Store — write lock keeps the critical section serial without wedging', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('releases the lockfile after every save (no leak)', () => {
    const A = new Store();
    A.createProject({ name: 'Alpha' });
    // A well-behaved writer must not leave its lockfile behind, or the next
    // writer would have to wait out the whole steal timeout on every save.
    expect(existsSync(LOCK)).toBe(false);
    A.createProject({ name: 'Beta' });
    expect(existsSync(LOCK)).toBe(false);
  });

  it('reclaims a STALE lock left by a crashed writer and still persists', () => {
    const A = new Store();
    const p = A.createProject({ name: 'Alpha' });

    // Simulate a writer that crashed mid-save: a lockfile that nobody will ever
    // release, with an mtime well past LOCK_STALE_MS (10s).
    writeFileSync(LOCK, '999999:0');
    const old = Date.now() / 1000 - 60; // 60s ago
    utimesSync(LOCK, old, old);

    // The next save must steal the stale lock rather than block forever.
    A.updateProject(p.id, { color: 'blue' });

    const C = new Store();
    expect(C.getProject(p.id)?.color).toBe('blue');
    expect(existsSync(LOCK)).toBe(false); // stolen + released
  });

  it('a FRESH foreign lock is waited out, then save DEFERS (fail-closed — never writes lockless, never freezes)', () => {
    const A = new Store();
    const p = A.createProject({ name: 'Alpha' }); // persisted before the foreign lock

    // A concurrent writer holds a fresh lock (mtime = now).
    writeFileSync(LOCK, `${process.pid + 1}:${Date.now()}`);
    statSync(LOCK); // fresh

    const started = Date.now();
    A.updateProject(p.id, { name: 'Renamed' }); // in-memory Renamed; the DISK save must DEFER (not write lockless)
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(2_000); // actually waited on the lock
    expect(elapsed).toBeLessThan(5_000);           // but gave up before wedging
    expect(A.getProject(p.id)?.name).toBe('Renamed'); // in-memory state is intact

    // CRITICAL (finding: no lockless overwrite): while the foreign lock was held the
    // save did NOT write — the on-disk store is untouched, so a concurrent writer's
    // rows can never be clobbered.
    const D = new Store();
    expect(D.getProject(p.id)?.name).toBe('Alpha');

    // Once the foreign holder releases, a subsequent save lands cleanly under the lock.
    rmSync(LOCK, { force: true });
    A.updateProject(p.id, { name: 'Renamed' }); // clears the deferred timer + writes now that the lock is free
    const C = new Store();
    expect(C.getProject(p.id)?.name).toBe('Renamed');
  }, 10_000);
});

describe('Store — startup temp sweep respects a live writer (no lost-write race)', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('does not delete a live writer\'s in-flight temp (fresh lock), but hardens it; reaps it once the lock is stale', () => {
    // Stabilise the on-disk store: the FIRST reload applies a one-time migration
    // and re-saves, later reloads don't. Construct twice up front so the sweep
    // constructions below trigger NO save → they never wait on the fresh lock
    // (avoiding the ~3s acquire timeout).
    new Store();
    new Store();

    // A concurrent writer is mid-save: it created its unique temp and holds a
    // FRESH lock; the rename hasn't happened yet.
    const liveTemp = `${STOREFILE}.tmp-${process.pid + 1}-abc123`;
    writeFileSync(liveTemp, 'in-flight store payload');
    chmodSync(liveTemp, 0o644);
    writeFileSync(LOCK, `${process.pid + 1}:${Date.now()}`); // fresh lock (mtime = now)

    // Another process boots. Its startup sweep MUST NOT delete the live temp —
    // doing so would ENOENT the writer's pending rename and silently lose the save.
    new Store();
    expect(existsSync(liveTemp)).toBe(true);   // (a) live temp preserved
    expect(mode(liveTemp)).toBe(0o600);        // (b) still hardened (no secret left 0644)

    // The writer finishes/crashes; its lock goes stale (> LOCK_STALE_MS = 10s old).
    const stale = Date.now() / 1000 - 30;
    utimesSync(LOCK, stale, stale);

    // A later boot now safely reaps the orphaned temp.
    new Store();
    expect(existsSync(liveTemp)).toBe(false);  // (c) stale-era temp removed
  });
});
