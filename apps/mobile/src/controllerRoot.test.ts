/**
 * controllerRoot.test.ts — Phase 3C2 residual (R1) faithful sign-out render-timing
 * regression. Exercises the ACTUAL production state stores (real `auth` + real
 * `controllerMode`) and the ACTUAL root decision (`chooseRootTree`): it wires the exact
 * App.tsx session subscription (invalidate → restore) and records the root tree at EVERY
 * `controllerMode` notify — which is precisely when `RootNavigator`'s
 * `useSyncExternalStore` re-renders. A `legacy` entry in that commit history == a
 * one-frame legacy-tab mount while authenticated.
 *
 * Proves the FIXED `signOutSecureController` ordering never yields `legacy` — for a
 * resolved, delayed, rejected, or never-resolving sign-out — and that the DISCRIMINATOR
 * is valid (the old deactivate-first ordering DOES yield `legacy`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios } }));
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('./storage', () => ({
  getStr: (k: string) => store.get(k) ?? '',
  setStr: (k: string, v: string) => { store.set(k, v); },
  SESSION_TOKEN: 'maestro.mobile.sessionToken',
  ACTIVE_HOST: 'maestro.mobile.activeHost',
  DEVICE_ID: 'maestro.mobile.deviceId',
}));

let accountId = 'acct-A';
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ user: { id: accountId } }) }));
(globalThis as { fetch: unknown }).fetch = fetchMock as unknown as typeof fetch;

import { setSessionToken, isAuthed, subscribeSession, setActiveHost } from './auth';
import {
  activateControllerMode, restoreControllerMode, invalidateControllerMode,
  activeControllerAccountId, deactivateControllerModeForAccount,
  isControllerModeActive, isControllerModeRestored, subscribeControllerMode,
} from './controllerMode';
import { chooseRootTree, signOutSecureController, type SecureSignOutDeps, type RootTree } from './controllerRoot';

/** The root re-renders on each controllerMode notify → record the decided tree then. */
function decideNow(): RootTree {
  return chooseRootTree(isAuthed(), isControllerModeRestored(), isControllerModeActive());
}

async function setupActive(): Promise<void> {
  store.clear();
  accountId = 'acct-A';
  invalidateControllerMode();
  setActiveHost('');
  setSessionToken('tok-A');           // signed in
  await restoreControllerMode();
  await activateControllerMode();      // secure-controller mode ACTIVE for acct-A
  expect(decideNow()).toBe('controller');
}

/** Run `signOutSecureController(deps)`, recording the root tree at every store notify +
    a spy that fires whenever the tree is `legacy`. Wires the real App.tsx session sub. */
async function runSignout(deps: SecureSignOutDeps): Promise<{ commits: RootTree[]; legacyMounts: number }> {
  const commits: RootTree[] = [];
  let legacyMounts = 0;
  const record = () => { const t = decideNow(); commits.push(t); if (t === 'legacy') legacyMounts += 1; };
  // App.tsx session lifecycle: on auth change, invalidate (→ splash) then restore.
  const unSession = subscribeSession(() => { invalidateControllerMode(); void restoreControllerMode(); });
  const unMode = subscribeControllerMode(record);
  try {
    // Fire the orchestration WITHOUT blocking on completion: `signOut` clears the token
    // synchronously (firing the session sub → the notifies we record) BEFORE any await, so
    // a never-resolving sign-out still surfaces every commit. Give sync + microtasks time.
    void signOutSecureController(deps).catch(() => { /* rejected/hung sign-out is expected */ });
    await new Promise((r) => setTimeout(r, 20));
  } finally { unSession(); unMode(); }
  return { commits, legacyMounts };
}

/** A faithful `signOut` that clears the token SYNCHRONOUSLY (like the real auth.signOut)
    before an optional network phase — so we can model resolved/delayed/rejected/hung. */
function fakeSignOut(mode: 'resolve' | 'delay' | 'reject' | 'hang'): () => Promise<void> {
  return async () => {
    setSessionToken('');   // synchronous auth clear → fires the session sub
    setActiveHost('');
    if (mode === 'resolve') return;
    if (mode === 'delay') { await new Promise((r) => setTimeout(r, 5)); return; }
    if (mode === 'reject') { await new Promise((r) => setTimeout(r, 0)); throw new Error('network down'); }
    return new Promise<void>(() => { /* never resolves */ });
  };
}

function deps(signOutImpl: () => Promise<void>): SecureSignOutDeps {
  return {
    resetController: vi.fn(),
    signOut: signOutImpl,
    captureAccountId: activeControllerAccountId,
    deactivateForAccount: deactivateControllerModeForAccount,
  };
}

describe('R1 — secure sign-out never commits the legacy tree', () => {
  beforeEach(async () => { await setupActive(); });

  for (const mode of ['resolve', 'delay', 'reject', 'hang'] as const) {
    it(`no legacy commit for a ${mode} sign-out (legacy mount spy stays 0)`, async () => {
      const { commits, legacyMounts } = await runSignout(deps(fakeSignOut(mode)));
      expect(commits).not.toContain('legacy');
      expect(legacyMounts).toBe(0);
      // Every recorded commit is a neutral/auth tree (splash or auth), never the tab app.
      for (const t of commits) expect(['splash', 'auth', 'controller']).toContain(t);
      // The token is cleared (auth false) after sign-out for the terminating cases.
      if (mode !== 'hang') expect(isAuthed()).toBe(false);
    });
  }

  it('resolved sign-out clears the captured account marker (cold reopen → inactive)', async () => {
    await runSignout(deps(fakeSignOut('resolve')));
    // Re-sign-in to the same account and restore → NOT active (marker was cleared).
    setSessionToken('tok-A');
    invalidateControllerMode();
    await restoreControllerMode();
    expect(isControllerModeActive()).toBe(false);
  });

  it('a rejected sign-out leaves the marker fail-closed (still active on re-sign-in)', async () => {
    await runSignout(deps(fakeSignOut('reject')));
    setSessionToken('tok-A');
    invalidateControllerMode();
    await restoreControllerMode();
    expect(isControllerModeActive()).toBe(true); // fail-closed: never dropped mid-failure
  });
});

describe('R1 — discriminator: the OLD deactivate-first ordering DID race', () => {
  beforeEach(async () => { await setupActive(); });

  it('deactivate-before-signOut records a legacy commit (proves the test discriminates)', async () => {
    const commits: RootTree[] = [];
    const unSession = subscribeSession(() => { invalidateControllerMode(); void restoreControllerMode(); });
    const unMode = subscribeControllerMode(() => commits.push(decideNow()));
    try {
      // The BUGGY ordering the reviewer flagged: deactivate (active=false while authed) → signOut.
      deactivateControllerModeForAccount(activeControllerAccountId()); // active=false, authed STILL true
      await fakeSignOut('resolve')();
      await Promise.resolve();
    } finally { unSession(); unMode(); }
    expect(commits).toContain('legacy'); // RED reproduced with the old ordering
  });
});

describe('chooseRootTree — pure decision', () => {
  it('legacy ONLY when authed && restored && !active', () => {
    expect(chooseRootTree(true, true, false)).toBe('legacy');
    expect(chooseRootTree(true, true, true)).toBe('controller');
    expect(chooseRootTree(true, false, true)).toBe('splash');
    expect(chooseRootTree(false, true, false)).toBe('auth');
    expect(chooseRootTree(false, false, false)).toBe('auth');
  });
});
