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
