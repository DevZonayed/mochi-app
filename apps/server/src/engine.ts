// Provider-agnostic engine seam. EchoEngine needs no API keys (fallback, demo).
// AnthropicEngine / OpenAIEngine use the operator's own validated key to make
// REAL completions, so jobs actually run on their account and spend their budget.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

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

const EFFORT_MAX_TOKENS: Record<string, number> = { fast: 1024, balanced: 2048, deep: 4096, max: 8192 };
// Approximate $ per 1M tokens (for the budget rollup; real usage tokens are exact).
const RATES: Record<string, { in: number; out: number }> = {
  'claude-opus-4-8': { in: 15, out: 75 },
  'gpt-4o': { in: 2.5, out: 10 },
};
function priceFor(model: string, inTok: number, outTok: number): number {
  const r = RATES[model] ?? { in: 5, out: 15 };
  return Math.round(((inTok * r.in + outTok * r.out) / 1e6) * 100) / 100;
}

const ECHO_RATE: Record<string, number> = { fast: 0.0008, balanced: 0.0015, deep: 0.004, max: 0.009 };

export class EchoEngine implements EngineAdapter {
  readonly id = 'echo';
  async run(req: EngineRequest): Promise<EngineResult> {
    const effort = req.effort ?? 'balanced';
    await new Promise((r) => setTimeout(r, 600));
    const ctx = req.projectInstructions ? ` (ctx: ${req.projectInstructions})` : '';
    const tokens = Math.round((req.prompt.length + (req.projectInstructions?.length ?? 0)) * 1.6) + 800;
    const cost = Math.round(tokens * (ECHO_RATE[effort] ?? ECHO_RATE.balanced) * 100) / 100;
    return { output: `[echo:${effort}]${ctx} ${req.prompt}`, model: 'echo', tokens, cost };
  }
}

export class AnthropicEngine implements EngineAdapter {
  readonly id = 'anthropic';
  private model: string;
  constructor(private apiKey: string, model?: string) {
    this.model = model && model.trim() ? model : 'claude-opus-4-8';
  }
  async run(req: EngineRequest): Promise<EngineResult> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const maxTokens = EFFORT_MAX_TOKENS[req.effort ?? 'balanced'] ?? 2048;
    const res = await client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      ...(req.projectInstructions ? { system: req.projectInstructions } : {}),
      messages: [{ role: 'user', content: req.prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const inTok = res.usage?.input_tokens ?? 0;
    const outTok = res.usage?.output_tokens ?? 0;
    return { output: text || '(no text output)', model: this.model, tokens: inTok + outTok, cost: priceFor(this.model, inTok, outTok) };
  }
}

export class OpenAIEngine implements EngineAdapter {
  readonly id = 'openai';
  private model: string;
  constructor(private apiKey: string, model?: string) {
    this.model = model && model.trim() ? model : 'gpt-4o';
  }
  async run(req: EngineRequest): Promise<EngineResult> {
    const client = new OpenAI({ apiKey: this.apiKey });
    const maxTokens = EFFORT_MAX_TOKENS[req.effort ?? 'balanced'] ?? 2048;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (req.projectInstructions) messages.push({ role: 'system', content: req.projectInstructions });
    messages.push({ role: 'user', content: req.prompt });
    const res = await client.chat.completions.create({ model: this.model, messages, max_tokens: maxTokens });
    const text = res.choices[0]?.message?.content ?? '';
    const inTok = res.usage?.prompt_tokens ?? 0;
    const outTok = res.usage?.completion_tokens ?? 0;
    return { output: text || '(no text output)', model: this.model, tokens: inTok + outTok, cost: priceFor(this.model, inTok, outTok) };
  }
}
