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
