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
      template: "claude-code", instructions: "", createdAt: 1,
    });
    expect(p.name).toBe("Demo");
  });

  it("rejects a job with an invalid status", () => {
    expect(() => JobSchema.parse({
      id: "j1", projectId: "p1", status: "bogus",
      input: "hi", output: null, error: null, createdAt: 1, updatedAt: 1,
    })).toThrow();
  });
});
