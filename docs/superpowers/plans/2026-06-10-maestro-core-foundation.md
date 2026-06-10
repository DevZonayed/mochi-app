# Maestro Core Foundation (Walking Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the headless spine of Maestro — a typed RPC core that creates projects and runs a job end-to-end through a swappable engine interface — with zero Claude API usage (stub engine), fully tested.

**Architecture:** A pnpm + Turborepo TypeScript monorepo. A `rpc-contract` package defines Zod-validated method schemas (the load-bearing seam, per ADR §1/§19). A `core` package implements a SQLite data layer (Workspace → Project → Job → Session, per PRD §3), a swappable `EngineAdapter` interface (PRD §4 / module E1) with an `EchoEngine` stub, a `JobRunner`, and an in-process RPC router/dispatcher exposed via `createCore()`. A small CLI smoke-tests the whole slice. Real engines (Claude Agent SDK), Electron shell, scheduler, skills, and comms are explicitly OUT of this plan and become later plans.

**Tech Stack:** Node 20+, TypeScript 5, pnpm workspaces, Turborepo, better-sqlite3, Zod, Vitest, tsx.

**Scope boundary (what this plan deliberately does NOT do):** no Claude/GPT calls, no Electron, no scheduler/cron, no skills/MCP, no comms, no auth/keychain. Those are tracked as follow-on plans. This plan must produce working, `pnpm test`-green software on its own.

---

## File Structure

```
atlanta/                              (repo root — already exists)
├── package.json                      (NEW — workspace root)
├── pnpm-workspace.yaml               (NEW)
├── turbo.json                        (NEW)
├── tsconfig.base.json                (NEW)
├── .gitignore                        (MODIFY — add node_modules, dist, *.db)
├── packages/
│   ├── rpc-contract/
│   │   ├── package.json              (NEW)
│   │   ├── tsconfig.json             (NEW)
│   │   ├── src/index.ts              (NEW — Zod schemas + MethodMap types)
│   │   └── src/index.test.ts         (NEW)
│   └── core/
│       ├── package.json              (NEW)
│       ├── tsconfig.json             (NEW)
│       ├── vitest.config.ts          (NEW)
│       ├── src/
│       │   ├── ids.ts                (NEW — id() helper)
│       │   ├── db/schema.sql         (NEW — DDL)
│       │   ├── db/db.ts              (NEW — open + migrate)
│       │   ├── db/repositories.ts    (NEW — workspace/project/job repos)
│       │   ├── engine/types.ts       (NEW — EngineAdapter interface)
│       │   ├── engine/echoEngine.ts  (NEW — stub engine)
│       │   ├── jobs/jobRunner.ts     (NEW — JobRunner)
│       │   ├── rpc/router.ts         (NEW — handlers)
│       │   ├── index.ts              (NEW — createCore())
│       │   └── cli.ts                (NEW — smoke CLI)
│       └── src/**/*.test.ts          (NEW — colocated tests)
```

Responsibilities: `rpc-contract` owns the wire types (no logic). `core/db` owns persistence. `core/engine` owns the model-abstraction seam. `core/jobs` owns execution. `core/rpc` wires handlers to deps. `core/index.ts` is the only public bootstrap. Files are small and single-responsibility so each is reviewable in isolation.

---

## Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create the workspace root `package.json`**

```json
{
  "name": "maestro",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 5: Append to `.gitignore`**

```
node_modules/
dist/
*.db
*.db-journal
.turbo/
```

- [ ] **Step 6: Install and verify the workspace resolves**

Run: `pnpm install`
Expected: completes without error; creates `pnpm-lock.yaml`.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold maestro pnpm/turborepo monorepo"
```

---

## Task 2: `rpc-contract` package (the typed seam)

**Files:**
- Create: `packages/rpc-contract/package.json`, `packages/rpc-contract/tsconfig.json`, `packages/rpc-contract/src/index.ts`, `packages/rpc-contract/src/index.test.ts`

- [ ] **Step 1: Create `packages/rpc-contract/package.json`**

```json
{
  "name": "@maestro/rpc-contract",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "vitest": "^2.1.0" }
}
```

- [ ] **Step 2: Create `packages/rpc-contract/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 3: Write the failing test `packages/rpc-contract/src/index.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { methods, ProjectSchema, JobSchema } from "./index.js";

describe("rpc-contract", () => {
  it("exposes the foundation method names", () => {
    expect(Object.keys(methods).sort()).toEqual(
      ["job.create", "job.get", "job.run", "project.create", "project.list", "workspace.init"].sort()
    );
  });

  it("validates a project shape", () => {
    const p = ProjectSchema.parse({
      id: "p1", workspaceId: "w1", name: "Demo",
      template: "claude-code", instructions: "", createdAt: 1
    });
    expect(p.name).toBe("Demo");
  });

  it("rejects a job with an invalid status", () => {
    expect(() => JobSchema.parse({
      id: "j1", projectId: "p1", status: "bogus",
      input: "hi", output: null, error: null, createdAt: 1, updatedAt: 1
    })).toThrow();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @maestro/rpc-contract test`
Expected: FAIL — cannot resolve `./index.js` (module not yet created).

- [ ] **Step 5: Implement `packages/rpc-contract/src/index.ts`**

```typescript
import { z } from "zod";

export const JobStatus = z.enum(["pending", "running", "done", "failed"]);
export const Effort = z.enum(["fast", "balanced", "deep", "max"]);

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  createdAt: z.number(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1),
  template: z.string().default("claude-code"),
  instructions: z.string().default(""),
  createdAt: z.number(),
});

export const JobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: JobStatus,
  input: z.string(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Job = z.infer<typeof JobSchema>;

// Each method declares its input and output schema. This object IS the contract.
export const methods = {
  "workspace.init": { input: z.object({ name: z.string().min(1) }), output: WorkspaceSchema },
  "project.create": {
    input: z.object({
      workspaceId: z.string(),
      name: z.string().min(1),
      template: z.string().optional(),
      instructions: z.string().optional(),
    }),
    output: ProjectSchema,
  },
  "project.list": { input: z.object({ workspaceId: z.string() }), output: z.array(ProjectSchema) },
  "job.create": {
    input: z.object({ projectId: z.string(), input: z.string() }),
    output: JobSchema,
  },
  "job.run": {
    input: z.object({ jobId: z.string(), effort: Effort.optional() }),
    output: JobSchema,
  },
  "job.get": { input: z.object({ jobId: z.string() }), output: JobSchema },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type Input<M extends MethodName> = z.infer<Methods[M]["input"]>;
export type Output<M extends MethodName> = z.infer<Methods[M]["output"]>;
```

- [ ] **Step 6: Build the package (the test imports `dist`-style `.js`; vitest resolves TS via its own pipeline, but build keeps types exportable)**

Run: `pnpm --filter @maestro/rpc-contract build`
Expected: PASS — emits `dist/index.js` and `dist/index.d.ts`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @maestro/rpc-contract test`
Expected: PASS — 3 tests green.

- [ ] **Step 8: Commit**

```bash
git add packages/rpc-contract pnpm-lock.yaml
git commit -m "feat(rpc-contract): typed Zod method contract for the foundation slice"
```

---

## Task 3: `core` package + SQLite migrations

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/ids.ts`, `packages/core/src/db/schema.sql`, `packages/core/src/db/db.ts`, `packages/core/src/db/db.test.ts`

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@maestro/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "cli": "tsx src/cli.ts"
  },
  "dependencies": {
    "@maestro/rpc-contract": "workspace:*",
    "better-sqlite3": "^11.3.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/core/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"], environment: "node" } });
```

- [ ] **Step 4: Create `packages/core/src/ids.ts`**

```typescript
import { randomUUID } from "node:crypto";
export const id = (): string => randomUUID();
export const now = (): number => Date.now();
```

- [ ] **Step 5: Create `packages/core/src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'claude-code',
  instructions TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(projectId);
```

- [ ] **Step 6: Write the failing test `packages/core/src/db/db.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { openDb } from "./db.js";

describe("openDb", () => {
  it("creates the three foundation tables on an in-memory db", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("workspaces");
    expect(tables).toContain("projects");
    expect(tables).toContain("jobs");
    db.close();
  });

  it("enforces foreign keys (pragma on)", () => {
    const db = openDb(":memory:");
    const fk = db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm --filter @maestro/core test`
Expected: FAIL — `./db.js` not found.

- [ ] **Step 8: Implement `packages/core/src/db/db.ts`**

```typescript
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ":memory:"): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}
```

- [ ] **Step 9: Ensure the SQL file is available at runtime — add a copy step to the build script in `packages/core/package.json`**

Replace the `build` script value with:

```json
"build": "tsc -p tsconfig.json && node -e \"require('fs').cpSync('src/db/schema.sql','dist/db/schema.sql')\"",
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `pnpm --filter @maestro/core test`
Expected: PASS — 2 tests green.

- [ ] **Step 11: Commit**

```bash
git add packages/core pnpm-lock.yaml
git commit -m "feat(core): sqlite db open + foundation schema with FK enforcement"
```

---

## Task 4: Repositories (workspace / project / job)

**Files:**
- Create: `packages/core/src/db/repositories.ts`, `packages/core/src/db/repositories.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/src/db/repositories.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { openDb } from "./db.js";
import { Repositories } from "./repositories.js";

function repos() { return new Repositories(openDb(":memory:")); }

describe("Repositories", () => {
  it("creates and lists projects under a workspace", () => {
    const r = repos();
    const w = r.createWorkspace("Home");
    const p = r.createProject({ workspaceId: w.id, name: "Site", template: "claude-code", instructions: "be terse" });
    expect(p.workspaceId).toBe(w.id);
    expect(p.instructions).toBe("be terse");
    const list = r.listProjects(w.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(p.id);
  });

  it("creates a pending job and updates it to done", () => {
    const r = repos();
    const w = r.createWorkspace("Home");
    const p = r.createProject({ workspaceId: w.id, name: "Site" });
    const j = r.createJob(p.id, "hello");
    expect(j.status).toBe("pending");
    const updated = r.updateJob(j.id, { status: "done", output: "world", error: null });
    expect(updated.status).toBe("done");
    expect(updated.output).toBe("world");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(j.updatedAt);
    expect(r.getJob(j.id).output).toBe("world");
  });

  it("throws when getting a missing job", () => {
    const r = repos();
    expect(() => r.getJob("nope")).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @maestro/core test repositories`
Expected: FAIL — `./repositories.js` not found.

- [ ] **Step 3: Implement `packages/core/src/db/repositories.ts`**

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @maestro/core test repositories`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/repositories.ts packages/core/src/db/repositories.test.ts
git commit -m "feat(core): workspace/project/job repositories"
```

---

## Task 5: Engine abstraction + EchoEngine stub

**Files:**
- Create: `packages/core/src/engine/types.ts`, `packages/core/src/engine/echoEngine.ts`, `packages/core/src/engine/echoEngine.test.ts`

- [ ] **Step 1: Create the interface `packages/core/src/engine/types.ts`**

```typescript
export type Effort = "fast" | "balanced" | "deep" | "max";

export interface EngineRequest {
  prompt: string;
  projectInstructions?: string;
  effort?: Effort;
}

export interface EngineResult {
  output: string;
  model: string;
}

/** The single seam every model engine implements (PRD §4 / module E1). */
export interface EngineAdapter {
  readonly id: string;
  run(req: EngineRequest): Promise<EngineResult>;
}
```

- [ ] **Step 2: Write the failing test `packages/core/src/engine/echoEngine.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { EchoEngine } from "./echoEngine.js";

describe("EchoEngine", () => {
  it("echoes the prompt with effort and instructions, no network", async () => {
    const e = new EchoEngine();
    expect(e.id).toBe("echo");
    const res = await e.run({ prompt: "build me a thing", projectInstructions: "be terse", effort: "deep" });
    expect(res.model).toBe("echo");
    expect(res.output).toContain("build me a thing");
    expect(res.output).toContain("deep");
    expect(res.output).toContain("be terse");
  });

  it("defaults effort to balanced", async () => {
    const res = await new EchoEngine().run({ prompt: "hi" });
    expect(res.output).toContain("balanced");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @maestro/core test echoEngine`
Expected: FAIL — `./echoEngine.js` not found.

- [ ] **Step 4: Implement `packages/core/src/engine/echoEngine.ts`**

```typescript
import type { EngineAdapter, EngineRequest, EngineResult } from "./types.js";

/** Deterministic stub engine — zero external calls. Used until the Claude Agent SDK engine lands. */
export class EchoEngine implements EngineAdapter {
  readonly id = "echo";

  async run(req: EngineRequest): Promise<EngineResult> {
    const effort = req.effort ?? "balanced";
    const ctx = req.projectInstructions ? ` (ctx: ${req.projectInstructions})` : "";
    return { output: `[echo:${effort}]${ctx} ${req.prompt}`, model: "echo" };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @maestro/core test echoEngine`
Expected: PASS — 2 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine
git commit -m "feat(core): EngineAdapter seam + EchoEngine stub"
```

---

## Task 6: JobRunner

**Files:**
- Create: `packages/core/src/jobs/jobRunner.ts`, `packages/core/src/jobs/jobRunner.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/src/jobs/jobRunner.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { openDb } from "../db/db.js";
import { Repositories } from "../db/repositories.js";
import { EchoEngine } from "../engine/echoEngine.js";
import { JobRunner } from "./jobRunner.js";
import type { EngineAdapter, EngineRequest, EngineResult } from "../engine/types.js";

function setup(engine: EngineAdapter) {
  const repos = new Repositories(openDb(":memory:"));
  const runner = new JobRunner(repos, engine);
  const w = repos.createWorkspace("Home");
  const p = repos.createProject({ workspaceId: w.id, name: "Site", instructions: "be terse" });
  return { repos, runner, p };
}

describe("JobRunner", () => {
  it("runs a pending job to done and stores engine output", async () => {
    const { repos, runner, p } = setup(new EchoEngine());
    const job = repos.createJob(p.id, "do the thing");
    const result = await runner.run(job.id, "fast");
    expect(result.status).toBe("done");
    expect(result.output).toContain("do the thing");
    expect(result.output).toContain("fast");
    expect(result.output).toContain("be terse");
    expect(repos.getJob(job.id).status).toBe("done");
  });

  it("marks a job failed and records the error when the engine throws", async () => {
    const boom: EngineAdapter = {
      id: "boom",
      async run(_req: EngineRequest): Promise<EngineResult> { throw new Error("kaboom"); },
    };
    const { repos, runner, p } = setup(boom);
    const job = repos.createJob(p.id, "x");
    const result = await runner.run(job.id);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("kaboom");
    expect(result.output).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @maestro/core test jobRunner`
Expected: FAIL — `./jobRunner.js` not found.

- [ ] **Step 3: Implement `packages/core/src/jobs/jobRunner.ts`**

```typescript
import type { Repositories } from "../db/repositories.js";
import type { EngineAdapter, Effort } from "../engine/types.js";
import type { Job } from "@maestro/rpc-contract";

export class JobRunner {
  constructor(private repos: Repositories, private engine: EngineAdapter) {}

  async run(jobId: string, effort: Effort = "balanced"): Promise<Job> {
    const job = this.repos.getJob(jobId);
    const project = this.repos
      .listProjects(this.workspaceIdOf(job.projectId))
      .find((p) => p.id === job.projectId);
    this.repos.updateJob(jobId, { status: "running", output: null, error: null });
    try {
      const result = await this.engine.run({
        prompt: job.input,
        projectInstructions: project?.instructions,
        effort,
      });
      return this.repos.updateJob(jobId, { status: "done", output: result.output, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.repos.updateJob(jobId, { status: "failed", output: null, error: message });
    }
  }

  // Minimal lookup helper for the walking skeleton: find the workspace owning a project.
  private workspaceIdOf(projectId: string): string {
    const row = (this.repos as unknown as { db: import("../db/db.js").Db }).db
      .prepare("SELECT workspaceId FROM projects WHERE id=?")
      .get(projectId) as { workspaceId: string } | undefined;
    if (!row) throw new Error(`project not found: ${projectId}`);
    return row.workspaceId;
  }
}
```

> Note: `JobRunner` reaches the project's instructions via the workspace. To avoid the private-field hack above, Task 6.5 adds a clean `getProject` accessor.

- [ ] **Step 4: Add a clean `getProject` to `Repositories` (replaces the hack)**

In `packages/core/src/db/repositories.ts`, add this method to the class:

```typescript
  getProject(projectId: string): import("@maestro/rpc-contract").Project {
    const row = this.db.prepare(
      "SELECT id,workspaceId,name,template,instructions,createdAt FROM projects WHERE id=?"
    ).get(projectId) as import("@maestro/rpc-contract").Project | undefined;
    if (!row) throw new Error(`project not found: ${projectId}`);
    return row;
  }
```

- [ ] **Step 5: Simplify `JobRunner.run` to use `getProject` and delete `workspaceIdOf`**

Replace the body of `run` and remove `workspaceIdOf` so the file reads:

```typescript
import type { Repositories } from "../db/repositories.js";
import type { EngineAdapter, Effort } from "../engine/types.js";
import type { Job } from "@maestro/rpc-contract";

export class JobRunner {
  constructor(private repos: Repositories, private engine: EngineAdapter) {}

  async run(jobId: string, effort: Effort = "balanced"): Promise<Job> {
    const job = this.repos.getJob(jobId);
    const project = this.repos.getProject(job.projectId);
    this.repos.updateJob(jobId, { status: "running", output: null, error: null });
    try {
      const result = await this.engine.run({
        prompt: job.input,
        projectInstructions: project.instructions,
        effort,
      });
      return this.repos.updateJob(jobId, { status: "done", output: result.output, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.repos.updateJob(jobId, { status: "failed", output: null, error: message });
    }
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @maestro/core test jobRunner`
Expected: PASS — 2 tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/jobs packages/core/src/db/repositories.ts
git commit -m "feat(core): JobRunner runs jobs through the engine seam with failure handling"
```

---

## Task 7: RPC router + `createCore()`

**Files:**
- Create: `packages/core/src/rpc/router.ts`, `packages/core/src/index.ts`, `packages/core/src/rpc/router.test.ts`

- [ ] **Step 1: Write the failing test `packages/core/src/rpc/router.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { createCore } from "../index.js";

describe("createCore RPC", () => {
  it("runs the full slice: init workspace -> create project -> create + run job", async () => {
    const core = createCore(":memory:");
    const ws = await core.call("workspace.init", { name: "Home" });
    const project = await core.call("project.create", {
      workspaceId: ws.id, name: "Site", instructions: "be terse",
    });
    const projects = await core.call("project.list", { workspaceId: ws.id });
    expect(projects.map((p) => p.id)).toContain(project.id);

    const job = await core.call("job.create", { projectId: project.id, input: "ship it" });
    expect(job.status).toBe("pending");
    const done = await core.call("job.run", { jobId: job.id, effort: "deep" });
    expect(done.status).toBe("done");
    expect(done.output).toContain("ship it");
    expect(done.output).toContain("deep");

    const fetched = await core.call("job.get", { jobId: job.id });
    expect(fetched.status).toBe("done");
    core.close();
  });

  it("rejects unknown methods and invalid input", async () => {
    const core = createCore(":memory:");
    // @ts-expect-error unknown method
    await expect(core.call("nope.method", {})).rejects.toThrow(/unknown method/);
    await expect(core.call("workspace.init", { name: "" })).rejects.toThrow();
    core.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @maestro/core test router`
Expected: FAIL — `../index.js` not found.

- [ ] **Step 3: Implement `packages/core/src/rpc/router.ts`**

```typescript
import { methods, type MethodName, type Input, type Output } from "@maestro/rpc-contract";
import type { Repositories } from "../db/repositories.js";
import type { JobRunner } from "../jobs/jobRunner.js";

export interface Deps {
  repos: Repositories;
  runner: JobRunner;
}

type Handlers = { [M in MethodName]: (input: Input<M>, deps: Deps) => Promise<Output<M>> | Output<M> };

export const handlers: Handlers = {
  "workspace.init": (input, { repos }) => repos.createWorkspace(input.name),
  "project.create": (input, { repos }) =>
    repos.createProject({
      workspaceId: input.workspaceId,
      name: input.name,
      template: input.template,
      instructions: input.instructions,
    }),
  "project.list": (input, { repos }) => repos.listProjects(input.workspaceId),
  "job.create": (input, { repos }) => repos.createJob(input.projectId, input.input),
  "job.run": (input, { runner }) => runner.run(input.jobId, input.effort),
  "job.get": (input, { repos }) => repos.getJob(input.jobId),
};

export async function dispatch<M extends MethodName>(method: M, rawInput: unknown, deps: Deps): Promise<Output<M>> {
  const def = methods[method];
  if (!def) throw new Error(`unknown method: ${String(method)}`);
  const input = def.input.parse(rawInput) as Input<M>;
  const result = await handlers[method](input, deps);
  return def.output.parse(result) as Output<M>;
}
```

- [ ] **Step 4: Implement `packages/core/src/index.ts`**

```typescript
import type { MethodName, Input, Output } from "@maestro/rpc-contract";
import { openDb, type Db } from "./db/db.js";
import { Repositories } from "./db/repositories.js";
import { EchoEngine } from "./engine/echoEngine.js";
import { JobRunner } from "./jobs/jobRunner.js";
import type { EngineAdapter } from "./engine/types.js";
import { dispatch, type Deps } from "./rpc/router.js";

export interface Core {
  call<M extends MethodName>(method: M, input: Input<M>): Promise<Output<M>>;
  db: Db;
  close(): void;
}

export function createCore(dbPath = ":memory:", engine: EngineAdapter = new EchoEngine()): Core {
  const db = openDb(dbPath);
  const repos = new Repositories(db);
  const runner = new JobRunner(repos, engine);
  const deps: Deps = { repos, runner };
  return {
    call: (method, input) => dispatch(method, input, deps),
    db,
    close: () => db.close(),
  };
}

export type { EngineAdapter } from "./engine/types.js";
export { EchoEngine } from "./engine/echoEngine.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @maestro/core test router`
Expected: PASS — 2 tests green.

- [ ] **Step 6: Run the whole core test suite + typecheck**

Run: `pnpm --filter @maestro/core test && pnpm --filter @maestro/core typecheck`
Expected: PASS — all tests green; no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/rpc packages/core/src/index.ts
git commit -m "feat(core): Zod-validated RPC dispatch + createCore bootstrap"
```

---

## Task 8: CLI smoke test (end-to-end, manual)

**Files:**
- Create: `packages/core/src/cli.ts`

- [ ] **Step 1: Implement `packages/core/src/cli.ts`**

```typescript
import { createCore } from "./index.js";

async function main(): Promise<void> {
  const core = createCore(":memory:");
  const ws = await core.call("workspace.init", { name: "Home" });
  const project = await core.call("project.create", {
    workspaceId: ws.id, name: "Demo", template: "claude-code", instructions: "be terse",
  });
  const job = await core.call("job.create", { projectId: project.id, input: "summarize the plan" });
  const done = await core.call("job.run", { jobId: job.id, effort: "deep" });
  console.log(JSON.stringify({ workspace: ws.name, project: project.name, status: done.status, output: done.output }, null, 2));
  core.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the CLI smoke test**

Run: `pnpm --filter @maestro/core cli`
Expected output (similar):

```json
{
  "workspace": "Home",
  "project": "Demo",
  "status": "done",
  "output": "[echo:deep] (ctx: be terse) summarize the plan"
}
```

- [ ] **Step 3: Run the full workspace build + test from the root**

Run: `pnpm build && pnpm test`
Expected: Turbo builds `rpc-contract` then `core`; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/cli.ts
git commit -m "feat(core): end-to-end CLI smoke test for the foundation slice"
```

---

## Self-Review

**1. Spec coverage (against PRD/ADR for THIS slice):**
- Typed RPC seam / `rpc-contract` as the load-bearing seam (ADR §1, §19) → Task 2. ✅
- Data model Workspace → Project → Job on SQLite (PRD §3, ADR §7) → Tasks 3–4. ✅
- `EngineAdapter` swappable seam with effort param (PRD §4–5, module E1) → Task 5. ✅
- Job execution through the engine with failure handling (PRD §9 minimal) → Task 6. ✅
- `createCore()` bootstrap + Zod-validated dispatch (ADR §1) → Task 7. ✅
- Zero Claude API usage (quota-safe) → EchoEngine throughout. ✅
- Out of scope (tracked elsewhere): real engine, Electron shell, scheduler, skills, comms, auth. ✅ (intentional)

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the command + expected result. ✅

**3. Type consistency:** `Workspace/Project/Job` come from `@maestro/rpc-contract` and are reused everywhere. `EngineAdapter.run` signature is identical in `types.ts`, `echoEngine.ts`, `jobRunner.ts`, and the failing-engine test. `createCore(dbPath, engine?)` matches its test usage. `dispatch(method, input, deps)` matches `core.call`. Effort enum (`fast|balanced|deep|max`) is consistent across the contract, engine, and runner. ✅
  - One deliberate refactor inside Task 6 (Steps 3→5) removes a private-field hack in favor of `Repositories.getProject`; the final state is clean and is what later tasks depend on.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-10-maestro-core-foundation.md`. Two execution options:**

**1. Subagent-Driven (recommended normally)** — a fresh subagent per task with review between tasks. ⚠️ **Currently blocked:** subagents hit the weekly Claude limit (resets **Jun 11, 8 pm Asia/Dhaka**).

**2. Inline Execution (recommended now)** — I execute the tasks in this session via `superpowers:executing-plans`. This is pure scaffolding (pnpm, SQLite, Zod, Vitest) with a **stub engine and no Claude API calls at runtime**, so it is **not** affected by the quota block — only my own main-loop generation is used.

**Which approach?**
