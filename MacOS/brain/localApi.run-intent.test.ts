import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-localapi-run-intent-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class Anthropic {} }), { virtual: true });

import { Store } from './store.js';
import { createDispatch } from './localApi.js';
import { handleJsonRpc, normalizeSettings, defaultExternalMcpSettings } from './mcp/external-mcp.js';
import type { LocalEngine } from './engine.js';
import type { MediaEngine } from './media-engine.js';
import type { ResearchEngine } from './research-engine.js';
import type { PublishingEngine } from './publishing.js';
import type { TelegramBot } from './telegram.js';
import type { WhatsAppClient } from './whatsapp.js';
import type { Providers } from './providers.js';

const mcpSettings = normalizeSettings({ ...defaultExternalMcpSettings(), enabled: true });

function makeDispatch(store: Store, run = vi.fn().mockResolvedValue(undefined), activeJobIds: string[] = []) {
  const steer = vi.fn().mockResolvedValue({ steered: true });
  const active = new Set(activeJobIds);
  const engine = {
    run,
    steer,
    isRunning: vi.fn((id: string) => active.has(id)),
    cancel: vi.fn((id: string) => active.delete(id)),
  } as unknown as LocalEngine;
  return {
    dispatch: createDispatch(
      store,
      engine,
      {} as MediaEngine,
      {} as ResearchEngine,
      {} as PublishingEngine,
      {} as TelegramBot,
      {} as WhatsAppClient,
      {} as Providers,
      vi.fn(),
    ),
    run,
    steer,
    engine,
  };
}

async function mcpCall(dispatch: ReturnType<typeof createDispatch>, name: string, args: Record<string, unknown>) {
  const res = await handleJsonRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { dispatch, settings: mcpSettings },
  );
  const result = (res as { result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown> } }).result;
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'MCP call failed');
  return result?.structuredContent ?? {};
}

describe('localApi RunIntent propagation', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('createAndRunJob persists full intent before engine admission', async () => {
    const store = new Store();
    const project = store.createProject({ name: 'Proj' });
    const { dispatch, run } = makeDispatch(store);

    const job = await dispatch('createAndRunJob', {
      projectId: project.id,
      input: 'ship it',
      effort: 'deep',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: 'off',
      plan: false,
      goal: true,
      browser: false,
    }) as { id: string };

    const persisted = store.getJob(job.id);
    expect(persisted?.intent).toEqual({
      schemaVersion: 1,
      effort: 'deep',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: 'off',
      plan: false,
      goal: true,
      browser: false,
    });
    expect(run).toHaveBeenCalledWith(job.id, {});
  });

  it('runJob allows same-value idempotent overrides but never mutates the locked intent', async () => {
    const store = new Store();
    const project = store.createProject({ name: 'Proj' });
    const job = store.createJob(project.id, 'again', 'Again', 'balanced', undefined, undefined, undefined, undefined, {
      effort: 'balanced',
      reviewer: { engine: 'claude', model: 'claude-sonnet-4-5' },
      plan: false,
      goal: false,
      browser: false,
    });
    const { dispatch, run } = makeDispatch(store);

    await dispatch('runJob', {
      id: job.id,
      effort: 'balanced',
      reviewer: { engine: 'claude', model: 'claude-sonnet-4-5' },
      plan: false,
      goal: false,
      browser: false,
    });

    expect(store.getJob(job.id)?.intent).toEqual({
      schemaVersion: 1,
      effort: 'balanced',
      reviewer: { engine: 'claude', model: 'claude-sonnet-4-5' },
      plan: false,
      goal: false,
      browser: false,
    });
    expect(run).toHaveBeenCalledWith(job.id, {});
  });

  it('runJob rejects conflicting duplicate mode overrides and preserves first intent', async () => {
    const store = new Store();
    const project = store.createProject({ name: 'Proj' });
    const job = store.createJob(project.id, 'again', 'Again', 'balanced', undefined, undefined, undefined, undefined, {
      effort: 'deep',
      engine: 'claude',
      reviewer: 'off',
      plan: false,
      goal: true,
      browser: false,
    });
    const original = store.getJob(job.id)?.intent;
    const { dispatch, run } = makeDispatch(store);

    await expect(dispatch('runJob', { id: job.id, effort: 'fast', engine: 'codex', goal: false })).rejects.toThrow(/intent conflict/i);

    expect(store.getJob(job.id)?.intent).toEqual(original);
    expect(run).not.toHaveBeenCalled();
  });

  it('external MCP sendChat for session B never steers or mutates genuinely active goal-mode session A', async () => {
    const store = new Store();
    const projectA = store.createProject({ name: 'Truthful UI', path: `${hoisted.dir}/a` });
    const projectB = store.createProject({ name: 'Release', path: `${hoisted.dir}/b` });
    const sessionA = store.createSession(projectA.id, 'Immediate Honesty Patch');
    const sessionB = store.createSession(projectB.id, 'RunIntent Integration');
    const jobA = store.createJob(
      projectA.id,
      'Correct every automatic-review finding for the Immediate Honesty Patch',
      'Immediate Honesty Patch',
      'deep',
      sessionA.id,
      undefined,
      undefined,
      'Latest automatic reviewer for job 50f49a60-3edb-425a-90cb-855befc00c63 is NEEDS WORK.',
      { effort: 'deep', goal: true, plan: false, browser: false },
    );
    store.updateJob(jobA.id, {
      status: 'running',
      transcript: [{ kind: 'text', text: 'Working on Immediate Honesty Patch only.', ts: 1784222800000 }],
    });
    const originalA = store.getJob(jobA.id)!;
    const { dispatch, run, steer, engine } = makeDispatch(store, vi.fn().mockResolvedValue(undefined), [jobA.id]);
    expect(engine.isRunning(jobA.id)).toBe(true);

    const res = await mcpCall(dispatch, 'sendChat', {
      projectId: projectB.id,
      sessionId: sessionB.id,
      text: 'Semantically integrate durable RunIntent + exact-question implementation.',
      effort: 'max',
      engine: 'codex',
      model: 'gpt-5',
      reviewerKey: 'off',
      plan: false,
      goal: true,
      browser: true,
    }) as { session: { id: string }; job: { id: string } };

    expect(res.session.id).toBe(sessionB.id);
    expect(res.job.id).not.toBe(jobA.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(res.job.id, expect.objectContaining({
      effort: 'max',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: 'off',
      plan: false,
      goal: true,
      browser: true,
    }));
    expect(steer).not.toHaveBeenCalled();
    expect(engine.isRunning).toHaveBeenCalledWith(jobA.id);

    const afterA = store.getJob(jobA.id)!;
    expect(afterA.input).toBe(originalA.input);
    expect(afterA.agentContext).toBe(originalA.agentContext);
    expect(afterA.intent).toEqual(originalA.intent);
    expect(afterA.transcript).toEqual(originalA.transcript);
    expect(JSON.stringify(afterA)).not.toContain('RunIntent');

    const jobB = store.getJob(res.job.id)!;
    expect(jobB.sessionId).toBe(sessionB.id);
    expect(jobB.projectId).toBe(projectB.id);
    expect(jobB.input).toContain('RunIntent');
    expect(jobB.intent).toEqual({
      schemaVersion: 1,
      effort: 'max',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: 'off',
      plan: false,
      goal: true,
      browser: true,
    });
    expect(sessionA.sdkSessionId).toBeUndefined();
    expect(store.getSession(sessionB.id)?.sdkSessionId).toBeUndefined();
  });

  it('external MCP sendChat for same-project session B does not steer or append to genuinely active session A', async () => {
    const store = new Store();
    const project = store.createProject({ name: 'Maestro', path: `${hoisted.dir}/same` });
    const sessionA = store.createSession(project.id, 'Active Goal A');
    const sessionB = store.createSession(project.id, 'Release Goal B');
    const jobA = store.createJob(project.id, 'Goal A prompt', 'Goal A', 'deep', sessionA.id, undefined, undefined, undefined, { effort: 'deep', goal: true });
    store.updateJob(jobA.id, { status: 'running', transcript: [{ kind: 'text', text: 'A is still running.', ts: 1 }] });
    const beforeA = store.getJob(jobA.id)!;
    const { dispatch, run, steer, engine } = makeDispatch(store, vi.fn().mockResolvedValue(undefined), [jobA.id]);
    expect(engine.isRunning(jobA.id)).toBe(true);

    const res = await mcpCall(dispatch, 'sendChat', {
      projectId: project.id,
      sessionId: sessionB.id,
      text: 'Release-only B prompt',
      effort: 'fast',
      goal: false,
      browser: false,
    }) as { session: { id: string }; job: { id: string } };

    expect(res.session.id).toBe(sessionB.id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(res.job.id, expect.any(Object));
    expect(steer).not.toHaveBeenCalled();
    expect(store.getJob(jobA.id)).toEqual(beforeA);
    expect(store.getJob(res.job.id)).toMatchObject({
      projectId: project.id,
      sessionId: sessionB.id,
      input: 'Release-only B prompt',
    });
    expect(store.getJob(res.job.id)?.intent).toMatchObject({ effort: 'fast', goal: false, browser: false });
  });

  it('explicit steerJob still targets the same active session job intentionally', async () => {
    const store = new Store();
    const project = store.createProject({ name: 'Maestro', path: `${hoisted.dir}/steer` });
    const sessionA = store.createSession(project.id, 'Active Goal A');
    const jobA = store.createJob(project.id, 'Goal A prompt', 'Goal A', 'deep', sessionA.id, undefined, undefined, undefined, { effort: 'deep', goal: true });
    store.updateJob(jobA.id, { status: 'running' });
    const { dispatch, run, steer, engine } = makeDispatch(store, vi.fn().mockResolvedValue(undefined), [jobA.id]);

    const result = await dispatch('steerJob', { id: jobA.id, text: 'same-session correction', interrupt: false });

    expect(engine.isRunning(jobA.id)).toBe(true);
    expect(result).toEqual({ steered: true });
    expect(steer).toHaveBeenCalledWith(jobA.id, 'same-session correction', { interrupt: false });
    expect(run).not.toHaveBeenCalled();
    expect(store.getJob(jobA.id)?.intent).toEqual({ schemaVersion: 1, effort: 'deep', goal: true });
  });
});
