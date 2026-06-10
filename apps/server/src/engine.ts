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
  tokens: number;
  cost: number;
}
export interface EngineAdapter {
  readonly id: string;
  run(req: EngineRequest): Promise<EngineResult>;
}

const EFFORT_RATE: Record<string, number> = { fast: 0.0008, balanced: 0.0015, deep: 0.004, max: 0.009 };

export class EchoEngine implements EngineAdapter {
  readonly id = 'echo';
  async run(req: EngineRequest): Promise<EngineResult> {
    const effort = req.effort ?? 'balanced';
    // simulate a little work so clients can observe the "running" state
    await new Promise((r) => setTimeout(r, 600));
    const ctx = req.projectInstructions ? ` (ctx: ${req.projectInstructions})` : '';
    const tokens = Math.round((req.prompt.length + (req.projectInstructions?.length ?? 0)) * 1.6) + 800;
    const rate = EFFORT_RATE[effort] ?? EFFORT_RATE.balanced;
    const cost = Math.round(tokens * rate * 100) / 100;
    return { output: `[echo:${effort}]${ctx} ${req.prompt}`, model: 'echo', tokens, cost };
  }
}
