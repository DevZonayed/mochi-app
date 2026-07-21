/**
 * shadowProjectionSelectors — Phase 3A2b1 Section B mobile read model (NO UI).
 *
 * Pure, typed selectors over the durable `ShadowEntity[]` the controller applies
 * into SQLite (`ShadowControllerService.readEntities()`), plus a narrow, coalesced
 * subscription surface for a future UI layer. Selectors:
 *   - validate each entity's projection schema VERSION + required ids; a malformed
 *     entity is quarantined (skipped) WITHOUT poisoning the rest;
 *   - exclude tombstoned (deleted) entities;
 *   - return stable, deterministically-ordered, immutable (frozen) snapshots.
 *
 * These mirror the host `shadow-projection-schema.ts` v1 output shapes. They never
 * trust the payload blindly — only known fields of the expected types survive.
 */
import type { ShadowEntity } from './shadowClientCore';
import type { ControllerServiceStatus } from './shadowControllerService';

export const SHADOW_PROJECTION_SCHEMA_VERSION = 1 as const;

export interface ProjectView { id: string; name?: string; kind?: string; color?: string; hidden?: boolean; repoHost?: string; repoPath?: string; createdAt?: number; lastActivity?: number }
export interface SessionView { id: string; projectId: string; title?: string; engine?: string; model?: string; autopilot?: boolean; reviewerEnabled?: boolean; reviewer?: string; branch?: string; codename?: string; archived?: boolean; createdAt?: number; lastActivity?: number }
// HIGH-1: no raw error/output diagnostics cross the boundary; only bounded job state.
export interface JobView { id: string; projectId: string; sessionId?: string; title?: string; status?: string; phase?: string; stage?: string; progress?: number; engine?: string; model?: string; cost?: number; createdAt?: number; lastActivity?: number }
export interface ApprovalView { id: string; projectId?: string; jobId?: string; tool?: string; status?: string; title?: string; summary?: string; createdAt?: number; lastActivity?: number }
export interface QuestionView { id: string; sessionId: string; sourceJobId?: string; question?: string; choices?: string[]; deadline?: number; status?: string; createdAt?: number }
export interface ScheduleView { id: string; projectId?: string; title?: string; time?: string; cadence?: string; kind?: string; enabled?: boolean; nextRun?: number; createdAt?: number; lastActivity?: number }

export interface ProjectionConnection {
  online: boolean;
  locked: boolean;
  lastSeq: number | null;
  offlineReadonly: boolean;
  leaseExpiresAt: number;
}

// ── validation ────────────────────────────────────────────────────────────────

function rec(data: unknown): Record<string, unknown> | null {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}
function versioned(d: Record<string, unknown>): boolean {
  return d.v === SHADOW_PROJECTION_SCHEMA_VERSION;
}
function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
function bool(v: unknown): boolean | undefined { return typeof v === 'boolean' ? v : undefined; }
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/** Live (non-deleted), schema-valid entities of one collection. */
function liveOf(entities: readonly ShadowEntity[], collection: string): ShadowEntity[] {
  return entities.filter((e) => e && e.collection === collection && !e.deleted && rec(e.data) && versioned(rec(e.data)!));
}

function byActivityThenId<T extends { lastActivity?: number; createdAt?: number; id: string }>(a: T, b: T): number {
  const ax = a.lastActivity ?? a.createdAt ?? 0;
  const bx = b.lastActivity ?? b.createdAt ?? 0;
  return (bx - ax) || a.id.localeCompare(b.id);
}

// ── mappers ───────────────────────────────────────────────────────────────────

function toProject(e: ShadowEntity): ProjectView | null {
  const d = rec(e.data)!; const id = str(d.id); if (!id) return null;
  return Object.freeze({ id, name: str(d.name), kind: str(d.kind), color: str(d.color), hidden: bool(d.hidden), repoHost: str(d.repoHost), repoPath: str(d.repoPath), createdAt: num(d.createdAt), lastActivity: num(d.lastActivity) });
}
function toSession(e: ShadowEntity): SessionView | null {
  const d = rec(e.data)!; const id = str(d.id); const projectId = str(d.projectId); if (!id || !projectId) return null;
  return Object.freeze({ id, projectId, title: str(d.title), engine: str(d.engine), model: str(d.model), autopilot: bool(d.autopilot), reviewerEnabled: bool(d.reviewerEnabled), reviewer: str(d.reviewer), branch: str(d.branch), codename: str(d.codename), archived: bool(d.archived), createdAt: num(d.createdAt), lastActivity: num(d.lastActivity) });
}
function toJob(e: ShadowEntity): JobView | null {
  const d = rec(e.data)!; const id = str(d.id); const projectId = str(d.projectId); if (!id || !projectId) return null;
  return Object.freeze({ id, projectId, sessionId: str(d.sessionId), title: str(d.title), status: str(d.status), phase: str(d.phase), stage: str(d.stage), progress: num(d.progress), engine: str(d.engine), model: str(d.model), cost: num(d.cost), createdAt: num(d.createdAt), lastActivity: num(d.lastActivity) });
}
function toApproval(e: ShadowEntity): ApprovalView | null {
  const d = rec(e.data)!; const id = str(d.id); if (!id) return null;
  return Object.freeze({ id, projectId: str(d.projectId), jobId: str(d.jobId), tool: str(d.tool), status: str(d.status), title: str(d.title), summary: str(d.summary), createdAt: num(d.createdAt), lastActivity: num(d.lastActivity) });
}
function toQuestion(e: ShadowEntity): QuestionView | null {
  const d = rec(e.data)!; const id = str(d.id); const sessionId = str(d.sessionId); if (!id || !sessionId) return null;
  const choices = strArr(d.choices);
  return Object.freeze({ id, sessionId, sourceJobId: str(d.sourceJobId), question: str(d.question), choices: choices ? Object.freeze(choices) as string[] : undefined, deadline: num(d.deadline), status: str(d.status), createdAt: num(d.createdAt) });
}
function toSchedule(e: ShadowEntity): ScheduleView | null {
  const d = rec(e.data)!; const id = str(d.id); if (!id) return null;
  return Object.freeze({ id, projectId: str(d.projectId), title: str(d.title), time: str(d.time), cadence: str(d.cadence), kind: str(d.kind), enabled: bool(d.enabled), nextRun: num(d.nextRun), createdAt: num(d.createdAt), lastActivity: num(d.lastActivity) });
}

function mapLive<T extends { lastActivity?: number; createdAt?: number; id: string }>(entities: readonly ShadowEntity[], collection: string, map: (e: ShadowEntity) => T | null): T[] {
  return Object.freeze(liveOf(entities, collection).map(map).filter((x): x is T => x !== null).sort(byActivityThenId)) as T[];
}

// ── selectors ──────────────────────────────────────────────────────────────────

export function listProjects(entities: readonly ShadowEntity[]): ProjectView[] {
  return mapLive(entities, 'project', toProject);
}
export function getProject(entities: readonly ShadowEntity[], projectId: string): ProjectView | undefined {
  return listProjects(entities).find((p) => p.id === projectId);
}
export function listProjectSessions(entities: readonly ShadowEntity[], projectId: string): SessionView[] {
  return mapLive(entities, 'session', toSession).filter((s) => s.projectId === projectId);
}
export function listProjectJobs(entities: readonly ShadowEntity[], projectId: string): JobView[] {
  return mapLive(entities, 'job', toJob).filter((j) => j.projectId === projectId);
}
export function getSession(entities: readonly ShadowEntity[], sessionId: string): SessionView | undefined {
  return mapLive(entities, 'session', toSession).find((s) => s.id === sessionId);
}
export function getJob(entities: readonly ShadowEntity[], jobId: string): JobView | undefined {
  return mapLive(entities, 'job', toJob).find((j) => j.id === jobId);
}
export function listPendingApprovals(entities: readonly ShadowEntity[]): ApprovalView[] {
  return mapLive(entities, 'approval', toApproval).filter((a) => a.status === 'pending');
}
export function listPendingQuestions(entities: readonly ShadowEntity[]): QuestionView[] {
  return Object.freeze(liveOf(entities, 'question').map(toQuestion).filter((q): q is QuestionView => q !== null && (q.status ?? 'pending') === 'pending').sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))) as QuestionView[];
}
export function listSchedules(entities: readonly ShadowEntity[]): ScheduleView[] {
  return mapLive(entities, 'schedule', toSchedule);
}

/** Connectivity/lease snapshot derived from the service status (truthful offline/locked). */
export function connectionOf(status: ControllerServiceStatus): ProjectionConnection {
  return Object.freeze({
    online: !!status.online,
    locked: !!status.locked,
    lastSeq: status.lastSeq ?? null,
    offlineReadonly: !status.online && !status.locked,
    leaseExpiresAt: status.leaseExpiresAt ?? 0,
  });
}

export interface ProjectionSnapshot {
  projects: ProjectView[];
  connection: ProjectionConnection;
}

/** Immutable top-level snapshot (all projects + connectivity). */
export function projectionSnapshot(entities: readonly ShadowEntity[], status: ControllerServiceStatus): ProjectionSnapshot {
  return Object.freeze({ projects: listProjects(entities), connection: connectionOf(status) });
}

// ── subscription wrapper ────────────────────────────────────────────────────────

export interface ProjectionSource {
  readEntities(): ShadowEntity[];
  status(): ControllerServiceStatus;
  onProjectionChange(fn: () => void): () => void;
}

/**
 * A durable read-model view over a `ShadowControllerService`: `snapshot()` returns
 * an immutable current view; `subscribe(fn)` fires (coalesced by the service) after
 * a durable apply/authority/connection/lock change; the returned fn unsubscribes.
 */
export class ShadowProjectionView {
  constructor(private readonly source: ProjectionSource) {}
  entities(): ShadowEntity[] { return this.source.readEntities(); }
  snapshot(): ProjectionSnapshot { return projectionSnapshot(this.source.readEntities(), this.source.status()); }
  listProjects(): ProjectView[] { return listProjects(this.source.readEntities()); }
  projectSessions(projectId: string): SessionView[] { return listProjectSessions(this.source.readEntities(), projectId); }
  projectJobs(projectId: string): JobView[] { return listProjectJobs(this.source.readEntities(), projectId); }
  pendingApprovals(): ApprovalView[] { return listPendingApprovals(this.source.readEntities()); }
  pendingQuestions(): QuestionView[] { return listPendingQuestions(this.source.readEntities()); }
  schedules(): ScheduleView[] { return listSchedules(this.source.readEntities()); }
  connection(): ProjectionConnection { return connectionOf(this.source.status()); }
  subscribe(fn: () => void): () => void { return this.source.onProjectionChange(fn); }
}
