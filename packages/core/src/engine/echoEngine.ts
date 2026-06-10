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
