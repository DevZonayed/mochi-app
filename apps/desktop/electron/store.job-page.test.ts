/* Store.listJobPage — lazy chat history pagination for large transcripts.
   The UI renders oldest-to-newest within the visible page, while pagination
   asks for "newer page first, then older page by cursor". */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-job-page-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

describe('Store.listJobPage', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  function seedStore() {
    const s = new Store();
    const project = s.createProject({ name: 'Repo' });
    const sessionA = s.createSession(project.id, 'A');
    const sessionB = s.createSession(project.id, 'B');
    const base = 1_700_000_000_000;
    const make = (i: number, sessionId = sessionA.id) => {
      const job = s.createJob(project.id, `turn-${i}`, `turn-${i}`, undefined, sessionId);
      job.createdAt = base + i * 1000;
      job.updatedAt = job.createdAt + 1;
      return job;
    };
    for (let i = 1; i <= 7; i += 1) make(i);
    make(99, sessionB.id);
    return { s, sessionA, sessionB };
  }

  it('returns the newest page in chronological display order', () => {
    const { s, sessionA } = seedStore();
    const page = s.listJobPage({ sessionId: sessionA.id, limit: 3 });
    expect(page.jobs.map(j => j.title)).toEqual(['turn-5', 'turn-6', 'turn-7']);
    expect(page.total).toBe(7);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe(page.jobs[0].createdAt);
    expect(page.nextCursor).toBeTypeOf('string');
  });

  it('uses nextBefore to load older pages without crossing session boundaries', () => {
    const { s, sessionA, sessionB } = seedStore();
    const first = s.listJobPage({ sessionId: sessionA.id, limit: 3 });
    const second = s.listJobPage({ sessionId: sessionA.id, before: first.nextBefore, limit: 3 });
    expect(second.jobs.map(j => j.title)).toEqual(['turn-2', 'turn-3', 'turn-4']);
    expect(second.hasMore).toBe(true);

    const third = s.listJobPage({ sessionId: sessionA.id, before: second.nextBefore, limit: 3 });
    expect(third.jobs.map(j => j.title)).toEqual(['turn-1']);
    expect(third.hasMore).toBe(false);

    const other = s.listJobPage({ sessionId: sessionB.id, limit: 5 });
    expect(other.jobs.map(j => j.title)).toEqual(['turn-99']);
    expect(other.total).toBe(1);
  });

  it('uses the stable cursor so identical createdAt values do not skip turns', () => {
    const s = new Store();
    const project = s.createProject({ name: 'Repo' });
    const session = s.createSession(project.id, 'A');
    const base = 1_700_000_000_000;
    for (let i = 1; i <= 5; i += 1) {
      const job = s.createJob(project.id, `turn-${i}`, `turn-${i}`, undefined, session.id);
      job.id = `job-${i}`;
      job.createdAt = base;
      job.updatedAt = base;
    }

    const first = s.listJobPage({ sessionId: session.id, limit: 2 });
    expect(first.jobs.map(j => j.title)).toEqual(['turn-4', 'turn-5']);

    const second = s.listJobPage({ sessionId: session.id, cursor: first.nextCursor ?? undefined, limit: 2 });
    expect(second.jobs.map(j => j.title)).toEqual(['turn-2', 'turn-3']);

    const third = s.listJobPage({ sessionId: session.id, cursor: second.nextCursor ?? undefined, limit: 2 });
    expect(third.jobs.map(j => j.title)).toEqual(['turn-1']);
    expect(third.hasMore).toBe(false);
  });
});
