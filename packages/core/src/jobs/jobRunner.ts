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
