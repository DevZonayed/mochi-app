import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export const id = (): string => randomUUID();
export const now = (): number => Date.now();

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Workspace {
  id: string;
  name: string;
  budgetCap: number;
  createdAt: number;
}
export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  template: string;
  instructions: string;
  color: string;
  createdAt: number;
}
export interface Job {
  id: string;
  projectId: string;
  title: string;
  status: JobStatus;
  phase: string;
  progress: number;
  input: string;
  output: string | null;
  error: string | null;
  effort: Effort;
  cost: number;
  tokens: number;
  stage: string;
  createdAt: number;
  updatedAt: number;
}
export interface Approval {
  id: string;
  projectId: string | null;
  kind: ApprovalKind;
  title: string;
  subtitle: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
}
export interface Schedule {
  id: string;
  projectId: string | null;
  title: string;
  time: string;
  cadence: string;
  enabled: boolean;
  nextRun: number | null;
  createdAt: number;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: string;
  version: string;
  enabled: boolean;
  createdAt: number;
}
export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  engine: string;
  createdAt: number;
}

export interface DashboardData {
  workspace: Workspace | null;
  greetingProjects: { id: string; name: string; color: string }[];
  gates: Approval[];
  activeJobs: Job[];
  recentlyCompleted: Job[];
  schedule: Schedule[];
  budget: { cap: number; spent: number; byProject: { projectId: string; name: string; color: string; spent: number }[] };
}

export class Repositories {
  constructor(private db: Db) {}

  // ── Workspaces ──────────────────────────────────────────────────────
  createWorkspace(name: string, budgetCap = 200): Workspace {
    const w: Workspace = { id: id(), name, budgetCap, createdAt: now() };
    this.db.prepare('INSERT INTO workspaces (id,name,budgetCap,createdAt) VALUES (?,?,?,?)').run(w.id, w.name, w.budgetCap, w.createdAt);
    return w;
  }
  listWorkspaces(): Workspace[] {
    return this.db.prepare('SELECT id,name,budgetCap,createdAt FROM workspaces ORDER BY createdAt').all() as unknown as Workspace[];
  }
  defaultWorkspace(): Workspace | undefined {
    return this.listWorkspaces()[0];
  }
  setBudgetCap(workspaceId: string, cap: number): void {
    this.db.prepare('UPDATE workspaces SET budgetCap=? WHERE id=?').run(cap, workspaceId);
  }

  // ── Projects ────────────────────────────────────────────────────────
  createProject(args: { workspaceId: string; name: string; template?: string; instructions?: string; color?: string }): Project {
    const p: Project = {
      id: id(),
      workspaceId: args.workspaceId,
      name: args.name,
      template: args.template ?? 'claude-code',
      instructions: args.instructions ?? '',
      color: args.color ?? 'blue',
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO projects (id,workspaceId,name,template,instructions,color,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(p.id, p.workspaceId, p.name, p.template, p.instructions, p.color, p.createdAt);
    return p;
  }
  listProjects(workspaceId: string): Project[] {
    return this.db
      .prepare('SELECT id,workspaceId,name,template,instructions,color,createdAt FROM projects WHERE workspaceId=? ORDER BY createdAt')
      .all(workspaceId) as unknown as Project[];
  }
  getProject(projectId: string): Project | undefined {
    return this.db
      .prepare('SELECT id,workspaceId,name,template,instructions,color,createdAt FROM projects WHERE id=?')
      .get(projectId) as Project | undefined;
  }

  // ── Jobs ────────────────────────────────────────────────────────────
  createJob(projectId: string, input: string, title = '', effort: Effort = 'balanced'): Job {
    const t = now();
    const j: Job = {
      id: id(), projectId, title: title || input.slice(0, 60), status: 'pending', phase: 'Queued', progress: 0,
      input, output: null, error: null, effort, cost: 0, tokens: 0, stage: '', createdAt: t, updatedAt: t,
    };
    this.db
      .prepare('INSERT INTO jobs (id,projectId,title,status,phase,progress,input,output,error,effort,cost,tokens,stage,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(j.id, j.projectId, j.title, j.status, j.phase, j.progress, j.input, j.output, j.error, j.effort, j.cost, j.tokens, j.stage, j.createdAt, j.updatedAt);
    return j;
  }
  listJobs(projectId?: string): Job[] {
    if (projectId) {
      return this.db.prepare('SELECT * FROM jobs WHERE projectId=? ORDER BY updatedAt DESC').all(projectId) as unknown as Job[];
    }
    return this.db.prepare('SELECT * FROM jobs ORDER BY updatedAt DESC LIMIT 200').all() as unknown as Job[];
  }
  getJob(jobId: string): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as Job | undefined;
  }
  updateJob(jobId: string, patch: Partial<Pick<Job, 'status' | 'phase' | 'progress' | 'output' | 'error' | 'cost' | 'tokens' | 'stage'>>): Job {
    const cur = this.getJob(jobId);
    if (!cur) throw new Error(`job not found: ${jobId}`);
    const next: Job = { ...cur, ...patch, updatedAt: now() };
    this.db
      .prepare('UPDATE jobs SET status=?, phase=?, progress=?, output=?, error=?, cost=?, tokens=?, stage=?, updatedAt=? WHERE id=?')
      .run(next.status, next.phase, next.progress, next.output, next.error, next.cost, next.tokens, next.stage, next.updatedAt, next.id);
    return next;
  }

  // ── Approvals ───────────────────────────────────────────────────────
  createApproval(a: { projectId?: string | null; kind?: ApprovalKind; title: string; subtitle?: string; detail?: string }): Approval {
    const rec: Approval = {
      id: id(), projectId: a.projectId ?? null, kind: a.kind ?? 'review', title: a.title,
      subtitle: a.subtitle ?? '', detail: a.detail ?? '', status: 'pending', createdAt: now(), resolvedAt: null,
    };
    this.db
      .prepare('INSERT INTO approvals (id,projectId,kind,title,subtitle,detail,status,createdAt,resolvedAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(rec.id, rec.projectId, rec.kind, rec.title, rec.subtitle, rec.detail, rec.status, rec.createdAt, rec.resolvedAt);
    return rec;
  }
  listApprovals(status?: ApprovalStatus): Approval[] {
    if (status) return this.db.prepare('SELECT * FROM approvals WHERE status=? ORDER BY createdAt DESC').all(status) as unknown as Approval[];
    return this.db.prepare('SELECT * FROM approvals ORDER BY createdAt DESC LIMIT 200').all() as unknown as Approval[];
  }
  getApproval(approvalId: string): Approval | undefined {
    return this.db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as Approval | undefined;
  }
  resolveApproval(approvalId: string, status: 'approved' | 'denied'): Approval {
    const cur = this.getApproval(approvalId);
    if (!cur) throw new Error(`approval not found: ${approvalId}`);
    const next: Approval = { ...cur, status, resolvedAt: now() };
    this.db.prepare('UPDATE approvals SET status=?, resolvedAt=? WHERE id=?').run(next.status, next.resolvedAt, next.id);
    return next;
  }

  // ── Schedules ───────────────────────────────────────────────────────
  createSchedule(s: { projectId?: string | null; title: string; time?: string; cadence?: string; nextRun?: number | null }): Schedule {
    const rec: Schedule = {
      id: id(), projectId: s.projectId ?? null, title: s.title, time: s.time ?? '', cadence: s.cadence ?? 'daily',
      enabled: true, nextRun: s.nextRun ?? null, createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO schedules (id,projectId,title,time,cadence,enabled,nextRun,createdAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(rec.id, rec.projectId, rec.title, rec.time, rec.cadence, 1, rec.nextRun, rec.createdAt);
    return rec;
  }
  listSchedules(): Schedule[] {
    type Row = Omit<Schedule, 'enabled'> & { enabled: number };
    const rows = this.db.prepare('SELECT * FROM schedules ORDER BY time').all() as unknown as Row[];
    return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
  }
  setScheduleEnabled(scheduleId: string, enabled: boolean): void {
    this.db.prepare('UPDATE schedules SET enabled=? WHERE id=?').run(enabled ? 1 : 0, scheduleId);
  }

  // ── Skills ──────────────────────────────────────────────────────────
  createSkill(s: { name: string; description?: string; category?: string; kind?: string; version?: string; enabled?: boolean }): Skill {
    const rec: Skill = {
      id: id(), name: s.name, description: s.description ?? '', category: s.category ?? 'General',
      kind: s.kind ?? 'builtin', version: s.version ?? '1.0.0', enabled: s.enabled ?? true, createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO skills (id,name,description,category,kind,version,enabled,createdAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(rec.id, rec.name, rec.description, rec.category, rec.kind, rec.version, rec.enabled ? 1 : 0, rec.createdAt);
    return rec;
  }
  listSkills(): Skill[] {
    type Row = Omit<Skill, 'enabled'> & { enabled: number };
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY category, name').all() as unknown as Row[];
    return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
  }
  toggleSkill(skillId: string): Skill | undefined {
    type Row = Omit<Skill, 'enabled'> & { enabled: number };
    const row = this.db.prepare('SELECT * FROM skills WHERE id=?').get(skillId) as Row | undefined;
    if (!row) return undefined;
    const enabled = row.enabled ? 0 : 1;
    this.db.prepare('UPDATE skills SET enabled=? WHERE id=?').run(enabled, skillId);
    return { ...row, enabled: !!enabled };
  }

  // ── Templates ───────────────────────────────────────────────────────
  createTemplate(t: { name: string; description?: string; category?: string; icon?: string; engine?: string }): Template {
    const rec: Template = {
      id: id(), name: t.name, description: t.description ?? '', category: t.category ?? 'General',
      icon: t.icon ?? 'spark', engine: t.engine ?? 'claude-code', createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO templates (id,name,description,category,icon,engine,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(rec.id, rec.name, rec.description, rec.category, rec.icon, rec.engine, rec.createdAt);
    return rec;
  }
  listTemplates(): Template[] {
    return this.db.prepare('SELECT * FROM templates ORDER BY category, name').all() as unknown as Template[];
  }

  // ── Budget / Dashboard aggregates ───────────────────────────────────
  budget(workspaceId: string): DashboardData['budget'] {
    const ws = this.listWorkspaces().find((w) => w.id === workspaceId);
    const projects = this.listProjects(workspaceId);
    const byProject = projects.map((p) => {
      const row = this.db.prepare('SELECT COALESCE(SUM(cost),0) AS s FROM jobs WHERE projectId=?').get(p.id) as { s: number };
      return { projectId: p.id, name: p.name, color: p.color, spent: Math.round((row.s ?? 0) * 100) / 100 };
    });
    const spent = Math.round(byProject.reduce((a, b) => a + b.spent, 0) * 100) / 100;
    return { cap: ws?.budgetCap ?? 200, spent, byProject };
  }

  dashboard(workspaceId: string): DashboardData {
    const ws = this.listWorkspaces().find((w) => w.id === workspaceId) ?? null;
    const projects = this.listProjects(workspaceId);
    const projectIds = new Set(projects.map((p) => p.id));
    const allJobs = this.listJobs().filter((j) => projectIds.has(j.projectId));
    const activeJobs = allJobs.filter((j) => j.status === 'running' || j.status === 'pending').slice(0, 8);
    const recentlyCompleted = allJobs.filter((j) => j.status === 'done').slice(0, 6);
    const gates = this.listApprovals('pending').filter((a) => a.projectId === null || projectIds.has(a.projectId));
    return {
      workspace: ws,
      greetingProjects: projects.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      gates,
      activeJobs,
      recentlyCompleted,
      schedule: this.listSchedules(),
      budget: this.budget(workspaceId),
    };
  }
}
