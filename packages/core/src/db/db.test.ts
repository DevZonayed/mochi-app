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
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });
});
