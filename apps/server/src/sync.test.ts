import { describe, it, expect } from 'vitest';
import { buildJobPage, buildSyncDelta, type Snapshot } from './server.js';

/** Tiny snapshot factory — only fills what each test needs. */
function snap(p: Partial<Snapshot>): Snapshot { return { at: 1000, ...p }; }

describe('buildSyncDelta', () => {
  it('since=0 returns the entire snapshot', () => {
    const s = snap({
      projects: [{ id: 'p1', updatedAt: 500 }, { id: 'p2', updatedAt: 800 }],
      sessions: [{ id: 's1', updatedAt: 600 }],
      jobs:     [{ id: 'j1', updatedAt: 700 }],
      approvals:[{ id: 'a1', updatedAt: 800 }],
      assets:   [{ id: 'as1', updatedAt: 900 }],
      events:   [{ id: 'e1', ts: 450 }],
    });
    const d = buildSyncDelta(s, 0, true);
    expect(d.changed.projects).toHaveLength(2);
    expect(d.changed.sessions).toHaveLength(1);
    expect(d.changed.jobs).toHaveLength(1);
    expect(d.changed.approvals).toHaveLength(1);
    expect(d.changed.assets).toHaveLength(1);
    expect(d.changed.events).toHaveLength(1);
    expect(d.deleted).toEqual({ projects: [], sessions: [], jobs: [], approvals: [], assets: [] });
    expect(d.host.online).toBe(true);
    expect(d.at).toBe(1000);
  });

  it('returns only entities whose updatedAt > since', () => {
    const s = snap({
      projects: [{ id: 'old', updatedAt: 200 }, { id: 'new', updatedAt: 800 }],
      sessions: [{ id: 'stale', updatedAt: 300 }, { id: 'fresh', updatedAt: 900 }],
      events:   [{ id: 'past', ts: 100 }, { id: 'recent', ts: 850 }],
    });
    const d = buildSyncDelta(s, 500, true);
    expect(d.changed.projects?.map((p) => p.id)).toEqual(['new']);
    expect(d.changed.sessions?.map((p) => p.id)).toEqual(['fresh']);
    expect(d.changed.events?.map((e) => e.id)).toEqual(['recent']);
  });

  it('treats `since === updatedAt` as already-seen (strict greater-than)', () => {
    const s = snap({ projects: [{ id: 'p1', updatedAt: 500 }] });
    expect(buildSyncDelta(s, 500, true).changed.projects).toEqual([]);
    expect(buildSyncDelta(s, 499, true).changed.projects).toHaveLength(1);
  });

  it('includes tombstones whose ts > since, partitioned by kind', () => {
    const s = snap({
      tombstones: [
        { kind: 'project', id: 'p-gone', ts: 600 },
        { kind: 'session', id: 's-gone', ts: 700 },
        { kind: 'job',     id: 'j-gone', ts: 800 },
        { kind: 'asset',   id: 'a-gone', ts: 900 },
        { kind: 'approval',id: 'ap-gone',ts: 950 },
        { kind: 'project', id: 'p-old',  ts: 100 }, // older than since
      ],
    });
    const d = buildSyncDelta(s, 500, true);
    expect(d.deleted.projects).toEqual(['p-gone']);
    expect(d.deleted.sessions).toEqual(['s-gone']);
    expect(d.deleted.jobs).toEqual(['j-gone']);
    expect(d.deleted.assets).toEqual(['a-gone']);
    expect(d.deleted.approvals).toEqual(['ap-gone']);
  });

  it('absent collections are returned as empty arrays', () => {
    const d = buildSyncDelta(snap({}), 0, false);
    expect(d.changed).toEqual({
      projects: [], sessions: [], jobs: [], approvals: [], assets: [], events: [],
    });
    expect(d.deleted).toEqual({ projects: [], sessions: [], jobs: [], approvals: [], assets: [] });
    expect(d.host.online).toBe(false);
  });

  it('an entity missing updatedAt is treated as updatedAt=0 (always seen on cold start)', () => {
    const s = snap({ projects: [{ id: 'legacy' }] });
    expect(buildSyncDelta(s, 0, true).changed.projects).toEqual([]);
    // Confirms backfill is real-on-the-Mac (load() path) — sync alone won't recover legacy rows.
  });

  it('a sync immediately after the previous pull returns nothing', () => {
    const s = snap({
      at: 1000,
      projects: [{ id: 'p1', updatedAt: 900 }],
      events:   [{ id: 'e1', ts: 900 }],
    });
    const first = buildSyncDelta(s, 0, true);
    const second = buildSyncDelta(s, first.at, true);
    expect(second.changed.projects).toEqual([]);
    expect(second.changed.events).toEqual([]);
    expect(second.deleted.projects).toEqual([]);
  });
});

describe('buildJobPage', () => {
  it('returns newest jobs in chronological display order', () => {
    const jobs = Array.from({ length: 5 }, (_, idx) => ({
      id: `j${idx + 1}`,
      projectId: 'p1',
      sessionId: 's1',
      createdAt: 1_700_000_000_000 + idx,
      updatedAt: 1_700_000_000_000 + idx,
    }));
    const page = buildJobPage(jobs, { sessionId: 's1', limit: 2 });
    expect(page.jobs.map(j => j.id)).toEqual(['j4', 'j5']);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTypeOf('string');
  });

  it('pages duplicate createdAt jobs without losing the tie group', () => {
    const jobs = Array.from({ length: 5 }, (_, idx) => ({
      id: `job-${idx + 1}`,
      projectId: 'p1',
      sessionId: 's1',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }));
    const first = buildJobPage(jobs, { sessionId: 's1', limit: 2 });
    const second = buildJobPage(jobs, { sessionId: 's1', cursor: first.nextCursor, limit: 2 });
    const third = buildJobPage(jobs, { sessionId: 's1', cursor: second.nextCursor, limit: 2 });

    expect(first.jobs.map(j => j.id)).toEqual(['job-4', 'job-5']);
    expect(second.jobs.map(j => j.id)).toEqual(['job-2', 'job-3']);
    expect(third.jobs.map(j => j.id)).toEqual(['job-1']);
    expect(third.hasMore).toBe(false);
  });
});
