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
import { WhatsAppClient } from '../whatsapp.js';
import type { LocalEngine } from '../engine.js';

const settings = normalizeSettings({ ...defaultExternalMcpSettings(), enabled: true });

function setup(opts: { whatsapp?: WhatsAppClient } = {}) {
  const s = new Store();
  const emit = vi.fn();
  const engine = { run: vi.fn(async () => ({})), isRunning: vi.fn(() => false), cancel: vi.fn(() => false) } as unknown as LocalEngine;
  const stub = {} as never;
  const dispatch = createDispatch(s, engine, stub, stub, stub, stub, (opts.whatsapp ?? stub) as never, stub, emit, '');
  const project = s.createProject({ name: 'Guards', path: `${hoisted.dir}/proj` });
  const session = s.createSession(project.id, 'A session', 'lyon');
  // A tools/call routed through the SAME core an external client hits.
  const call = (name: string, args: Record<string, unknown>) =>
    handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { dispatch, settings });
  return { s, session, call, emit };
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

  it('reconnectWhatsApp through external MCP fails truthfully when WhatsApp is unlinked', async () => {
    const s = new Store();
    const emit = vi.fn();
    const makeSocket = vi.fn(async () => ({
      ev: { on: vi.fn() },
      user: { id: '15551234567@s.whatsapp.net' },
      end: vi.fn(),
    }));
    const whatsapp = new WhatsAppClient(s, emit, { makeSocket });
    const engine = { run: vi.fn(async () => ({})), isRunning: vi.fn(() => false), cancel: vi.fn(() => false) } as unknown as LocalEngine;
    const stub = {} as never;
    const dispatch = createDispatch(s, engine, stub, stub, stub, stub, whatsapp, stub, emit, '');
    const beforeState = s.whatsappState();

    const r = unwrap(await handleJsonRpc(
      { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'reconnectWhatsApp', arguments: {} } },
      { dispatch, settings },
    ));

    expect(r.isError).toBe(true);
    expect(r.text).toContain('WhatsApp is not linked');
    expect(r.text).not.toContain('{ ok: true }');
    expect(r.structured).not.toMatchObject({ ok: true });
    expect(r.structured).toEqual({
      error: {
        code: 'WA_NOT_LINKED',
        statusCode: 409,
        message: 'WhatsApp is not linked',
      },
    });
    expect(makeSocket).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(s.whatsappState()).toEqual(beforeState);
    expect(r.text).not.toMatch(/\/whatsapp\/|auth|creds|credential|stack|at WhatsAppClient/i);
    expect(JSON.stringify(r.structured)).not.toMatch(/\/whatsapp\/|auth|creds|credential|stack|at WhatsAppClient|ok/i);
  });

  it('does not expose structured internals for unmarked 4xx or 5xx errors', async () => {
    const callThrowing = async (err: unknown) => {
      const dispatch = vi.fn(async () => { throw err; });
      return unwrap(await handleJsonRpc(
        { jsonrpc: '2.0', id: 88, method: 'tools/call', params: { name: 'listProjects', arguments: {} } },
        { dispatch, settings },
      ));
    };

    const unmarked4xx = Object.assign(new Error('Do not leak private auth state'), {
      code: 'WA_NOT_LINKED',
      statusCode: 409,
      privateField: 'credentials',
    });
    const marked5xx = Object.assign(new Error('Internal WhatsApp failure'), {
      mcpPublic: true,
      code: 'WA_INTERNAL',
      statusCode: 500,
      privateField: 'credentials',
    });
    const unmarked5xx = Object.assign(new Error('Internal WhatsApp failure'), {
      code: 'WA_INTERNAL',
      statusCode: 500,
      privateField: 'credentials',
    });

    for (const r of [await callThrowing(unmarked4xx), await callThrowing(marked5xx), await callThrowing(unmarked5xx)]) {
      expect(r.isError).toBe(true);
      expect(r.structured).toEqual({});
      expect(JSON.stringify(r.structured)).not.toMatch(/credential|privateField|WA_INTERNAL|500/i);
    }
  });
});
