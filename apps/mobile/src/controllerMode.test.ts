/**
 * controllerMode.test.ts — Phase 3C2 (corrected F2) persisted top-level authority-mode
 * marker. Proves: restore-pending → resolved; activate persists + survives a cold reopen;
 * account-scoping (account A's mode never leaks to B); deactivate; invalidate → pending;
 * the marker is INDEPENDENT of the shadow purge (a shadow-cache/key wipe never clears it);
 * `requireShadowController` gates the legacy screens.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory storage backing (mock AsyncStorage-fronted storage.ts so no react-native import).
const store = new Map<string, string>();
vi.mock('./storage', () => ({
  getStr: (k: string) => store.get(k) ?? '',
  setStr: (k: string, v: string) => { store.set(k, v); },
}));

let token = 'tok-A';
let accountId = 'acct-A';
vi.mock('./auth', () => ({
  API_BASE: 'https://api.test',
  getSessionToken: () => token,
  isAuthed: () => token !== '',
}));

// get-session resolver → { user: { id: accountId } }.
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ user: { id: accountId } }) }));
(globalThis as { fetch: unknown }).fetch = fetchMock as unknown as typeof fetch;

import {
  CONTROLLER_MODE_KEY,
  restoreControllerMode, activateControllerMode, deactivateControllerMode, invalidateControllerMode,
  isControllerModeActive, isControllerModeRestored, requireShadowController, getControllerModeSnapshot,
} from './controllerMode';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  store.clear();
  token = 'tok-A'; accountId = 'acct-A';
  fetchMock.mockClear();
  invalidateControllerMode(); // reset in-memory (restored=false, no active, no cached account)
});

describe('restore lifecycle', () => {
  it('starts unrestored (pending) → resolves on restore; signed-out is inactive', async () => {
    expect(isControllerModeRestored()).toBe(false);
    token = ''; // signed out
    await restoreControllerMode();
    expect(isControllerModeRestored()).toBe(true);
    expect(isControllerModeActive()).toBe(false);
  });

  it('signed-in with no persisted marker restores to INACTIVE', async () => {
    await restoreControllerMode();
    expect(isControllerModeRestored()).toBe(true);
    expect(isControllerModeActive()).toBe(false);
    expect(getControllerModeSnapshot()).toEqual({ kind: 'inactive', accountResolved: true });
  });

  it('bounded get-session failure stays in the neutral secure retry gate, not legacy or account A', async () => {
    await activateControllerMode();
    invalidateControllerMode();
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new Error('Request timed out'), { name: 'AbortError' }); });
    await restoreControllerMode();
    expect(isControllerModeRestored()).toBe(true);
    expect(isControllerModeActive()).toBe(false);
    expect(getControllerModeSnapshot()).toEqual({ kind: 'resolution-error', error: 'Network timeout while verifying this account.' });
  });

  it('bounded get-session failure after token/account switch does not reactivate the previous account', async () => {
    await activateControllerMode();
    token = 'tok-B'; accountId = 'acct-B';
    invalidateControllerMode();
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new Error('Request timed out'), { name: 'AbortError' }); });
    await restoreControllerMode();
    expect(isControllerModeRestored()).toBe(true);
    expect(isControllerModeActive()).toBe(false);
    expect(getControllerModeSnapshot()).toEqual({ kind: 'resolution-error', error: 'Network timeout while verifying this account.' });
  });

  it('bounded get-session failure for the same token still requires a fresh retry', async () => {
    await activateControllerMode();
    invalidateControllerMode();
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new Error('Request timed out'), { name: 'AbortError' }); });
    await restoreControllerMode();
    expect(isControllerModeRestored()).toBe(true);
    expect(isControllerModeActive()).toBe(false);
    expect(getControllerModeSnapshot()).toEqual({ kind: 'resolution-error', error: 'Network timeout while verifying this account.' });
  });

  it('sign-out never uses the cached binding fallback', async () => {
    await activateControllerMode();
    token = '';
    invalidateControllerMode();
    await restoreControllerMode();
    expect(isControllerModeRestored()).toBe(true);
    expect(isControllerModeActive()).toBe(false);
    expect(getControllerModeSnapshot()).toEqual({ kind: 'signed-out' });
  });

  it('malformed binding storage is ignored and does not activate or crash', async () => {
    store.set('maestro.mobile.controllerModeLastAccount', 'acct-A');
    store.set('maestro.mobile.controllerModeLastTokenBinding', '{"accountId":42,"digest":true}');
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new Error('Request timed out'), { name: 'AbortError' }); });
    await restoreControllerMode();
    expect(isControllerModeActive()).toBe(false);
    expect(getControllerModeSnapshot()).toEqual({ kind: 'resolution-error', error: 'Network timeout while verifying this account.' });
  });

  it('late restore A completion cannot overwrite newer restore B after token switch', async () => {
    const gateA = deferred<{ ok: boolean; json: () => Promise<{ user: { id: string } }> }>();
    const gateB = deferred<{ ok: boolean; json: () => Promise<{ user: { id: string } }> }>();
    fetchMock.mockImplementationOnce(() => gateA.promise);
    const restoreA = restoreControllerMode();
    token = 'tok-B';
    accountId = 'acct-B';
    invalidateControllerMode();
    fetchMock.mockImplementationOnce(() => gateB.promise);
    const restoreB = restoreControllerMode();
    gateB.resolve({ ok: true, json: async () => ({ user: { id: 'acct-B' } }) });
    await restoreB;
    expect(getControllerModeSnapshot()).toEqual({ kind: 'inactive', accountResolved: true });
    gateA.resolve({ ok: true, json: async () => ({ user: { id: 'acct-A' } }) });
    await restoreA;
    expect(getControllerModeSnapshot()).toEqual({ kind: 'inactive', accountResolved: true });
    expect(isControllerModeActive()).toBe(false);
  });
});

describe('activate / persist / cold reopen', () => {
  it('activate persists the marker and flips active', async () => {
    expect(await activateControllerMode()).toBe(true);
    expect(isControllerModeActive()).toBe(true);
    expect(store.get(CONTROLLER_MODE_KEY)).toContain('acct-A');
  });

  it('survives a cold reopen (invalidate → restore reads the persisted marker)', async () => {
    await activateControllerMode();
    invalidateControllerMode();                 // simulate app restart (fresh module state)
    expect(isControllerModeActive()).toBe(false); // pending until restore
    await restoreControllerMode();
    expect(isControllerModeActive()).toBe(true);  // restored from persisted map
  });
});

describe('account scoping', () => {
  it('account A active does NOT make account B active', async () => {
    await activateControllerMode();               // account A active
    expect(isControllerModeActive()).toBe(true);
    // Switch to account B (new token/id) → re-resolve.
    token = 'tok-B'; accountId = 'acct-B';
    invalidateControllerMode();
    await restoreControllerMode();
    expect(isControllerModeActive()).toBe(false); // B never opted in
    // Switching back to A restores active.
    token = 'tok-A'; accountId = 'acct-A';
    invalidateControllerMode();
    await restoreControllerMode();
    expect(isControllerModeActive()).toBe(true);
  });
});

describe('deactivate + gate', () => {
  it('deactivate clears the marker and flips inactive', async () => {
    await activateControllerMode();
    await deactivateControllerMode();
    expect(isControllerModeActive()).toBe(false);
    // Persisted cleared for this account → a cold reopen stays inactive.
    invalidateControllerMode();
    await restoreControllerMode();
    expect(isControllerModeActive()).toBe(false);
  });

  it('requireShadowController mirrors the active flag (legacy screens gate on it)', async () => {
    expect(requireShadowController()).toBe(false);
    await activateControllerMode();
    expect(requireShadowController()).toBe(true);
    await deactivateControllerMode();
    expect(requireShadowController()).toBe(false);
  });
});

describe('legacy-screen containment contract', () => {
  // The legacy screens (SessionChat / Approvals) wrap their body exactly as:
  //   if (requireShadowController()) return <SecureControllerBlocked/>;  // no api call
  //   return <RealScreen/>;                                              // calls api.*
  // This reproduces that gate with a spy standing in for the direct-server mutation.
  function guardedLegacyRender(realRender: () => string): string | 'BLOCKED' {
    return requireShadowController() ? 'BLOCKED' : realRender();
  }

  it('while active, the legacy direct-server mutation is NEVER invoked (spy stays 0)', async () => {
    const sendChatSpy = vi.fn(() => 'sent');
    await activateControllerMode();
    const out = guardedLegacyRender(() => sendChatSpy());
    expect(out).toBe('BLOCKED');
    expect(sendChatSpy).toHaveBeenCalledTimes(0); // no api.sendChat / approveApproval while enrolled
  });

  it('after deactivate (e.g. sign-out), the legacy screen renders + can call its api again', async () => {
    const approveSpy = vi.fn(() => 'approved');
    await activateControllerMode();
    await deactivateControllerMode();
    const out = guardedLegacyRender(() => approveSpy());
    expect(out).toBe('approved');
    expect(approveSpy).toHaveBeenCalledTimes(1);
  });

  it('a revoked/purge-pending controller (mode still active) keeps legacy blocked', async () => {
    await activateControllerMode();
    // Simulate a failed/partial shadow purge: shadow keys wiped, mode marker untouched.
    for (const k of [...store.keys()]) if (k.includes('shadow')) store.delete(k);
    invalidateControllerMode();
    await restoreControllerMode();
    const spy = vi.fn(() => 'sent');
    expect(guardedLegacyRender(() => spy())).toBe('BLOCKED');
    expect(spy).toHaveBeenCalledTimes(0);
  });
});

describe('independence from the shadow purge', () => {
  it('is NOT cleared when the shadow cache/keys are wiped (separate key namespace)', async () => {
    await activateControllerMode();
    // Simulate the durable shadow purge: it wipes shadow.* / cache.* keys, never the mode marker.
    store.set('maestro.shadow.scopeKey.dev.acct-A', 'KEY');
    store.set('maestro.mobile.cache.projects', '[...]');
    for (const k of [...store.keys()]) if (k.includes('shadow.scopeKey') || k.includes('.cache.')) store.delete(k);
    // The mode marker survives the purge.
    expect(store.get(CONTROLLER_MODE_KEY)).toContain('acct-A');
    invalidateControllerMode();
    await restoreControllerMode();
    expect(isControllerModeActive()).toBe(true); // revoked/purged controller stays in the secure tree
  });
});
