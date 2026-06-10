import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export const id = (): string => randomUUID();
export const now = (): number => Date.now();

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}
export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  template: string;
  instructions: string;
  createdAt: number;
}
export interface Job {
  id: string;
  projectId: string;
  title: string;
  status: JobStatus;
  input: string;
  output: string | null;
  error: string | null;
  effort: Effort;
  createdAt: number;
  updatedAt: number;
}

export class Repositories {
  constructor(private db: Db) {}

  createWorkspace(name: string): Workspace {
    const w: Workspace = { id: id(), name, createdAt: now() };
    this.db.prepare('INSERT INTO workspaces (id,name,createdAt) VALUES (?,?,?)').run(w.id, w.name, w.createdAt);
    return w;
  }
  listWorkspaces(): Workspace[] {
    return this.db.prepare('SELECT id,name,createdAt FROM workspaces ORDER BY createdAt').all() as unknown as Workspace[];
  }

  createProject(args: { workspaceId: string; name: string; template?: string; instructions?: string }): Project {
    const p: Project = {
      id: id(),
      workspaceId: args.workspaceId,
      name: args.name,
      template: args.template ?? 'claude-code',
      instructions: args.instructions ?? '',
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO projects (id,workspaceId,name,template,instructions,createdAt) VALUES (?,?,?,?,?,?)')
      .run(p.id, p.workspaceId, p.name, p.template, p.instructions, p.createdAt);
    return p;
  }
  listProjects(workspaceId: string): Project[] {
    return this.db
      .prepare('SELECT id,workspaceId,name,template,instructions,createdAt FROM projects WHERE workspaceId=? ORDER BY createdAt')
      .all(workspaceId) as unknown as Project[];
  }
  getProject(projectId: string): Project | undefined {
    return this.db
      .prepare('SELECT id,workspaceId,name,template,instructions,createdAt FROM projects WHERE id=?')
      .get(projectId) as Project | undefined;
  }

  createJob(projectId: string, input: string, title = '', effort: Effort = 'balanced'): Job {
    const t = now();
    const j: Job = { id: id(), projectId, title: title || input.slice(0, 60), status: 'pending', input, output: null, error: null, effort, createdAt: t, updatedAt: t };
    this.db
      .prepare('INSERT INTO jobs (id,projectId,title,status,input,output,error,effort,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(j.id, j.projectId, j.title, j.status, j.input, j.output, j.error, j.effort, j.createdAt, j.updatedAt);
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
  updateJob(jobId: string, patch: Partial<Pick<Job, 'status' | 'output' | 'error'>>): Job {
    const cur = this.getJob(jobId);
    if (!cur) throw new Error(`job not found: ${jobId}`);
    const next: Job = { ...cur, ...patch, updatedAt: now() };
    this.db.prepare('UPDATE jobs SET status=?, output=?, error=?, updatedAt=? WHERE id=?').run(next.status, next.output, next.error, next.updatedAt, next.id);
    return next;
  }
}
