import type { Db } from "./db.js";
import type { Workspace, Project, Job } from "@maestro/rpc-contract";
import { id, now } from "../ids.js";

export class Repositories {
  constructor(private db: Db) {}

  createWorkspace(name: string): Workspace {
    const w: Workspace = { id: id(), name, createdAt: now() };
    this.db.prepare("INSERT INTO workspaces (id,name,createdAt) VALUES (?,?,?)")
      .run(w.id, w.name, w.createdAt);
    return w;
  }

  createProject(args: { workspaceId: string; name: string; template?: string; instructions?: string }): Project {
    const p: Project = {
      id: id(),
      workspaceId: args.workspaceId,
      name: args.name,
      template: args.template ?? "claude-code",
      instructions: args.instructions ?? "",
      createdAt: now(),
    };
    this.db.prepare(
      "INSERT INTO projects (id,workspaceId,name,template,instructions,createdAt) VALUES (?,?,?,?,?,?)"
    ).run(p.id, p.workspaceId, p.name, p.template, p.instructions, p.createdAt);
    return p;
  }

  listProjects(workspaceId: string): Project[] {
    return this.db.prepare(
      "SELECT id,workspaceId,name,template,instructions,createdAt FROM projects WHERE workspaceId=? ORDER BY createdAt"
    ).all(workspaceId) as Project[];
  }

  getProject(projectId: string): Project {
    const row = this.db.prepare(
      "SELECT id,workspaceId,name,template,instructions,createdAt FROM projects WHERE id=?"
    ).get(projectId) as Project | undefined;
    if (!row) throw new Error(`project not found: ${projectId}`);
    return row;
  }

  createJob(projectId: string, input: string): Job {
    const t = now();
    const j: Job = {
      id: id(), projectId, status: "pending", input, output: null, error: null, createdAt: t, updatedAt: t,
    };
    this.db.prepare(
      "INSERT INTO jobs (id,projectId,status,input,output,error,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)"
    ).run(j.id, j.projectId, j.status, j.input, j.output, j.error, j.createdAt, j.updatedAt);
    return j;
  }

  getJob(jobId: string): Job {
    const row = this.db.prepare(
      "SELECT id,projectId,status,input,output,error,createdAt,updatedAt FROM jobs WHERE id=?"
    ).get(jobId) as Job | undefined;
    if (!row) throw new Error(`job not found: ${jobId}`);
    return row;
  }

  updateJob(jobId: string, patch: Partial<Pick<Job, "status" | "output" | "error">>): Job {
    const cur = this.getJob(jobId);
    const next: Job = { ...cur, ...patch, updatedAt: now() };
    this.db.prepare("UPDATE jobs SET status=?, output=?, error=?, updatedAt=? WHERE id=?")
      .run(next.status, next.output, next.error, next.updatedAt, next.id);
    return next;
  }
}
