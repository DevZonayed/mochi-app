/* End-to-end regression for the dispatch-level guards that MUST hold because the
   External MCP transport forwards `tools/call` arguments straight to dispatch
   WITHOUT Ajv-validating them against the advertised inputSchema. A generic MCP
   client can therefore send anything; the honest contract has to be enforced in
   the dispatch case itself.

   These drive the REAL localApi dispatch through the REAL handleJsonRpc core
   (only the engine/gitService are stubbed) so a missing/non-boolean toggle can't
   silently "succeed" by disabling the flag. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-mcp-guards-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { handleJsonRpc, normalizeSettings, defaultExternalMcpSettings } from './external-mcp.ts';
import { Store } from '../store.js';
import { createDispatch } from '../localApi.js';
import type { LocalEngine } from '../engine.js';

const settings = normalizeSettings({ ...defaultExternalMcpSettings(), enabled: true });

function setup() {
  const s = new Store();
  const emit = vi.fn();
  const engine = { run: vi.fn(async () => ({})), isRunning: vi.fn(() => false), cancel: vi.fn(() => false) } as unknown as LocalEngine;
  const stub = {} as never;
  const dispatch = createDispatch(s, engine, stub, stub, stub, stub, stub, stub, emit, '');
  const project = s.createProject({ name: 'Guards', path: `${hoisted.dir}/proj` });
  const session = s.createSession(project.id, 'A session', 'lyon');
  // A tools/call routed through the SAME core an external client hits.
  const call = (name: string, args: Record<string, unknown>) =>
    handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { dispatch, settings });
  return { s, session, call };
}

/** Extract {isError, text, structured} from a tools/call JSON-RPC response. */
function unwrap(res: Awaited<ReturnType<ReturnType<typeof setup>['call']>>) {
  const r = (res as { result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown> } }).result;
  return { isError: !!r?.isError, text: r?.content?.[0]?.text ?? '', structured: r?.structuredContent ?? {} };
}

describe('External MCP dispatch guards (unvalidated transport)', () => {
  beforeEach(() => rmSync(hoisted.dir, { recursive: true, force: true }));

  it('setSessionAutopilot {sessionId, on:true} enables (autoPilot:true)', async () => {
    const { session, call } = setup();
    const r = unwrap(await call('setSessionAutopilot', { sessionId: session.id, on: true }));
    expect(r.isError).toBe(false);
    expect(r.structured.autoPilot).toBe(true);
  });

  it('setSessionAutopilot {sessionId} (no flag) is REJECTED, not a silent disable', async () => {
    const { session, call } = setup();
    const r = unwrap(await call('setSessionAutopilot', { sessionId: session.id }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/boolean/i);
  });

  it('setSessionAutopilot {sessionId, on:"true"} (string) is REJECTED, not coerced to false', async () => {
    const { session, call } = setup();
    const r = unwrap(await call('setSessionAutopilot', { sessionId: session.id, on: 'true' as unknown as boolean }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/boolean/i);
  });

  it('a rejected autopilot call does NOT mutate the session', async () => {
    const { s, session, call } = setup();
    expect(s.getSession(session.id)?.autoPilot).toBeUndefined();
    await call('setSessionAutopilot', { sessionId: session.id, on: 'true' as unknown as boolean });
    expect(s.getSession(session.id)?.autoPilot).toBeUndefined(); // unchanged
  });

  it('setSessionReviewer {sessionId, enabled:"true"} (string) is REJECTED, not coerced to false', async () => {
    const { session, call } = setup();
    const r = unwrap(await call('setSessionReviewer', { sessionId: session.id, enabled: 'true' as unknown as boolean }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/boolean/i);
  });

  it('setSessionReviewer {sessionId, on:true} still enables the pass', async () => {
    const { session, call } = setup();
    const r = unwrap(await call('setSessionReviewer', { sessionId: session.id, on: true }));
    expect(r.isError).toBe(false);
    expect(r.structured.reviewerEnabled).toBe(true);
  });
});
