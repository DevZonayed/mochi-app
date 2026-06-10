// Provider-agnostic engine seam (mirrors packages/core/src/engine).
// EchoEngine needs no API keys — deterministic, good for the live demo slice.
// A real Claude/OpenAI adapter slots in here behind the same interface.

export interface EngineRequest {
  prompt: string;
  projectInstructions?: string;
  effort?: string;
}
export interface EngineResult {
  output: string;
  model: string;
}
export interface EngineAdapter {
  readonly id: string;
  run(req: EngineRequest): Promise<EngineResult>;
}

export class EchoEngine implements EngineAdapter {
  readonly id = 'echo';
  async run(req: EngineRequest): Promise<EngineResult> {
    const effort = req.effort ?? 'balanced';
    // simulate a little work so clients can observe the "running" state
    await new Promise((r) => setTimeout(r, 600));
    const ctx = req.projectInstructions ? ` (ctx: ${req.projectInstructions})` : '';
    return { output: `[echo:${effort}]${ctx} ${req.prompt}`, model: 'echo' };
  }
}
