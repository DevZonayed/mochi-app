/* sendChat trigger idempotency (finding 4) — an optional `idempotencyKey` makes a
   duplicate delivery resolve to the ORIGINAL job + session and run the agent EXACTLY
   ONCE, including across restart; different keys stay independent; keyless sends are
   unchanged. Verified through the REAL localApi dispatch (only the engine is stubbed). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-sendchat-idem-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' }, powerMonitor: { on: () => {} } }));

import { Store } from './store.js';
import { createDispatch } from './localApi.js';
import type { LocalEngine } from './engine.js';

type Dispatch = ReturnType<typeof createDispatch>;
type SendResult = { session?: { id: string }; job: { id: string } };

function makeDispatch(store: Store): { dispatch: Dispatch; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => ({}));
  const engine = { run: run as unknown as LocalEngine['run'], isRunning: () => false, cancel: () => false } as unknown as LocalEngine;
  const stub = {} as never;
  const dispatch = createDispatch(store, engine, stub, stub, stub, stub, stub, stub, vi.fn(), '');
  return { dispatch, run };
}

describe('sendChat idempotencyKey', () => {
  let store: Store;
  let projectId: string;
  beforeEach(() => {
    rmSync(hoisted.dir, { recursive: true, force: true });
    store = new Store();
    projectId = store.createProject({ name: 'Chat', path: `${hoisted.dir}/proj` }).id;
  });

  it('a duplicate key resolves to the ORIGINAL job + session and runs the agent exactly once', async () => {
    const { dispatch, run } = makeDispatch(store);
    const before = store.listSessions(projectId).length;
    const r1 = await dispatch('sendChat', { projectId, text: 'hello', idempotencyKey: 'msg-1' }) as SendResult;
    const r2 = await dispatch('sendChat', { projectId, text: 'hello (resend)', idempotencyKey: 'msg-1' }) as SendResult;
    expect(r2.job.id).toBe(r1.job.id);                       // same job
    expect(r2.session?.id).toBe(r1.session?.id);             // same session — no duplicate empty chat
    expect(store.listSessions(projectId).length).toBe(before + 1); // exactly one new session
    expect(run).toHaveBeenCalledTimes(1);                    // engine.run fired once
  });

  it('a duplicate key with conflicting mode returns the original job and cannot mutate canonical intent', async () => {
    const { dispatch, run } = makeDispatch(store);
    const r1 = await dispatch('sendChat', {
      projectId,
      text: 'hello',
      idempotencyKey: 'mode-1',
      effort: 'deep',
      engine: 'codex',
      model: 'gpt-5',
      plan: false,
      goal: true,
      browser: false,
    }) as SendResult;
    const originalIntent = store.getJob(r1.job.id)?.intent;

    const r2 = await dispatch('sendChat', {
      projectId,
      text: 'hello changed',
      idempotencyKey: 'mode-1',
      effort: 'fast',
      engine: 'claude',
      model: 'claude-opus-4-8',
      plan: true,
      goal: false,
      browser: true,
    }) as SendResult;

    expect(r2.job.id).toBe(r1.job.id);
    expect(store.getJob(r1.job.id)?.intent).toEqual(originalIntent);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is RESTART-SAFE: the same key after a reload resolves to the original job, no second run', async () => {
    const first = makeDispatch(store);
    const r1 = await first.dispatch('sendChat', { projectId, text: 'do it', idempotencyKey: 'k' }) as SendResult;

    // Process restart: a fresh Store over the same userData dir + a fresh engine stub.
    const restarted = new Store();
    const second = makeDispatch(restarted);
    const r2 = await second.dispatch('sendChat', { projectId, text: 'do it', idempotencyKey: 'k' }) as SendResult;
    expect(r2.job.id).toBe(r1.job.id);
    expect(second.run).not.toHaveBeenCalled();               // no second run across restart
  });

  it('a CRASH before the reservation does not spawn a second session on retry (deterministic session binding)', async () => {
    // Simulate the crash window: the lazy session + attachments were created, but the app
    // died BEFORE claimIdempotentJob recorded the reservation (no ledger entry yet).
    const crashed = makeDispatch(store);
    (crashed.dispatch as unknown as { __ignore?: boolean }); // no-op to keep types happy
    // Make the claim throw right after the session is created (before the reservation lands).
    const spy = vi.spyOn(store, 'claimIdempotentJob').mockImplementationOnce(() => { throw new Error('crash before reservation'); });
    await expect(crashed.dispatch('sendChat', { projectId, text: 'hello', idempotencyKey: 'k' })).rejects.toThrow(/crash/);
    spy.mockRestore();
    const sessionsAfterCrash = store.listSessions(projectId).length; // the orphan lazy session exists

    // Restart + retry the SAME key: it must re-derive the SAME session id (no second chat)
    // and run exactly once.
    const restarted = new Store();
    const retry = makeDispatch(restarted);
    const r = await retry.dispatch('sendChat', { projectId, text: 'hello', idempotencyKey: 'k' }) as SendResult;
    expect(restarted.listSessions(projectId).length).toBe(sessionsAfterCrash); // NO extra session
    expect(r.session?.id).toBeTruthy();
    expect(retry.run).toHaveBeenCalledTimes(1);
  });

  it('different keys stay independent (two jobs, two runs)', async () => {
    const { dispatch, run } = makeDispatch(store);
    const a = await dispatch('sendChat', { projectId, text: 'one', idempotencyKey: 'a' }) as SendResult;
    const b = await dispatch('sendChat', { projectId, text: 'two', idempotencyKey: 'b' }) as SendResult;
    expect(a.job.id).not.toBe(b.job.id);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keyless sends are unchanged — each distinct send is its own job + run', async () => {
    const { dispatch, run } = makeDispatch(store);
    const a = await dispatch('sendChat', { projectId, text: 'plain one' }) as SendResult;
    const b = await dispatch('sendChat', { projectId, text: 'plain two' }) as SendResult;
    expect(a.job.id).not.toBe(b.job.id);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
