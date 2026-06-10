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
