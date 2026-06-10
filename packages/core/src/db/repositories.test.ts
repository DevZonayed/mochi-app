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
