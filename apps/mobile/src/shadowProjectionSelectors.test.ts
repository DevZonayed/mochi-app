import { describe, expect, it } from 'vitest';
import type { ShadowEntity } from './shadowClientCore';
import type { ControllerServiceStatus } from './shadowControllerService';
import {
  listProjects, getProject, listProjectSessions, listProjectJobs, getSession, getJob,
  listPendingApprovals, listPendingQuestions, listSchedules, connectionOf, projectionSnapshot,
  ShadowProjectionView, SHADOW_PROJECTION_SCHEMA_VERSION, type ProjectionSource,
} from './shadowProjectionSelectors';

const V = SHADOW_PROJECTION_SCHEMA_VERSION;
function ent(collection: ShadowEntity['collection'], id: string, data: Record<string, unknown>, opts: Partial<ShadowEntity> = {}): ShadowEntity {
  return { id, collection, revision: 1, updatedAt: 1, deleted: false, payloadDigest: 'd', data: { v: V, id, ...data }, ...opts };
}

const entities: ShadowEntity[] = [
  ent('project', 'p1', { name: 'Alpha', lastActivity: 200 }),
  ent('project', 'p2', { name: 'Beta', lastActivity: 100 }),
  ent('project', 'pDead', { name: 'Gone' }, { deleted: true }), // tombstone
  ent('session', 's1', { projectId: 'p1', title: 'chat', engine: 'claude', lastActivity: 50 }),
  ent('job', 'j1', { projectId: 'p1', sessionId: 's1', title: 'Build', status: 'running', progress: 0.5 }),
  ent('approval', 'a1', { projectId: 'p1', tool: 'merge', status: 'pending', title: 'Merge' }),
  ent('approval', 'a2', { projectId: 'p1', tool: 'budget', status: 'approved', title: 'Budget' }),
  ent('question', 'q1', { sessionId: 's1', question: 'Pick?', choices: ['A', 'B'], status: 'pending', createdAt: 5 }),
  ent('schedule', 'sc1', { projectId: 'p1', title: 'daily', enabled: true }),
  // malformed rows — must be quarantined (skipped), not poison the rest:
  { id: 'bad1', collection: 'project', revision: 1, updatedAt: 1, deleted: false, payloadDigest: 'd', data: { v: 999, id: 'bad1', name: 'WrongVersion' } },
  { id: 'bad2', collection: 'project', revision: 1, updatedAt: 1, deleted: false, payloadDigest: 'd', data: null },
  { id: 'bad3', collection: 'session', revision: 1, updatedAt: 1, deleted: false, payloadDigest: 'd', data: { v: V, id: 'bad3' } }, // missing projectId
];

describe('shadowProjectionSelectors', () => {
  it('lists live projects, excludes tombstones + malformed, stable ordering', () => {
    const projects = listProjects(entities);
    expect(projects.map((p) => p.id)).toEqual(['p1', 'p2']); // pDead(tombstone)+bad1/bad2 excluded; ordered by lastActivity desc
    expect(getProject(entities, 'p1')?.name).toBe('Alpha');
    expect(getProject(entities, 'pDead')).toBeUndefined();
    expect(getProject(entities, 'bad1')).toBeUndefined();
  });

  it('scopes sessions/jobs by project and resolves single entities', () => {
    expect(listProjectSessions(entities, 'p1').map((s) => s.id)).toEqual(['s1']);
    expect(listProjectSessions(entities, 'p2')).toEqual([]);
    expect(listProjectJobs(entities, 'p1').map((j) => j.id)).toEqual(['j1']);
    expect(getSession(entities, 's1')?.engine).toBe('claude');
    expect(getJob(entities, 'j1')?.progress).toBe(0.5);
    expect(getSession(entities, 'bad3')).toBeUndefined();
  });

  it('filters pending approvals + questions only', () => {
    expect(listPendingApprovals(entities).map((a) => a.id)).toEqual(['a1']); // a2 approved excluded
    expect(listPendingQuestions(entities).map((q) => q.id)).toEqual(['q1']);
    expect(listPendingQuestions(entities)[0].choices).toEqual(['A', 'B']);
  });

  it('lists schedules', () => {
    expect(listSchedules(entities).map((s) => s.id)).toEqual(['sc1']);
  });

  it('returns immutable (frozen) snapshots', () => {
    const projects = listProjects(entities);
    expect(Object.isFrozen(projects)).toBe(true);
    expect(Object.isFrozen(projects[0])).toBe(true);
    expect(() => { (projects as unknown as unknown[]).push({}); }).toThrow();
  });

  it('derives truthful connectivity (offline read-only / locked)', () => {
    const online: ControllerServiceStatus = { state: 'online', online: true, lastSeq: 9, entities: 5, locked: false, leaseExpiresAt: 123 };
    expect(connectionOf(online)).toMatchObject({ online: true, offlineReadonly: false, locked: false, lastSeq: 9 });
    const offline: ControllerServiceStatus = { state: 'offline', online: false, lastSeq: 9, entities: 5, locked: false, leaseExpiresAt: 123 };
    expect(connectionOf(offline)).toMatchObject({ online: false, offlineReadonly: true, locked: false });
    const locked: ControllerServiceStatus = { state: 'locked', online: false, lastSeq: null, entities: 0, locked: true, leaseExpiresAt: 0 };
    expect(connectionOf(locked)).toMatchObject({ locked: true, offlineReadonly: false });
  });

  it('ShadowProjectionView wraps a source + subscribe/unsubscribe works', () => {
    let listener: (() => void) | null = null;
    let status: ControllerServiceStatus = { state: 'online', online: true, lastSeq: 1, entities: entities.length, locked: false, leaseExpiresAt: 1 };
    const source: ProjectionSource = {
      readEntities: () => entities,
      status: () => status,
      onProjectionChange: (fn) => { listener = fn; return () => { listener = null; }; },
    };
    const view = new ShadowProjectionView(source);
    expect(view.listProjects().map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(view.snapshot().connection.online).toBe(true);

    let fired = 0;
    const unsub = view.subscribe(() => { fired++; });
    expect(listener).not.toBeNull();
    listener!();
    expect(fired).toBe(1);
    unsub();
    expect(listener).toBeNull();

    // offline cache remains readable
    status = { state: 'offline', online: false, lastSeq: 1, entities: entities.length, locked: false, leaseExpiresAt: 1 };
    expect(view.listProjects().length).toBe(2);
    expect(view.connection().offlineReadonly).toBe(true);
  });

  it('projectionSnapshot is frozen top-to-bottom', () => {
    const status: ControllerServiceStatus = { state: 'online', online: true, lastSeq: 1, entities: 0, locked: false, leaseExpiresAt: 1 };
    const snap = projectionSnapshot(entities, status);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.projects)).toBe(true);
    expect(Object.isFrozen(snap.connection)).toBe(true);
  });
});
