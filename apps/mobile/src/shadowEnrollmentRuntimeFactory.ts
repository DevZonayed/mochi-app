/**
 * shadowEnrollmentRuntimeFactory — Phase 3A2a PRODUCTION wiring that assembles a
 * real `ShadowMobileEnrollmentRuntime` from concrete Expo-backed dependencies:
 *
 *  - crypto: `shadowCryptoNoble` seeded by `expo-crypto`'s secure CSPRNG
 *    (`getRandomBytes`) — never Math.random / no insecure fallback.
 *  - private storage: `ExpoSecureStoreAdapter` (device-only Keychain).
 *  - public metadata: `SQLiteEnrollmentMetaStore` over Expo SQLite.
 *  - identity: the app's authenticated session token + device id (auth.ts), with
 *    the account id resolved from the relay's Better Auth `get-session`.
 *  - transport: real `fetch`, HTTPS relay origin allowlist ([API_BASE]).
 *
 * Importing this module does NOT open the network or auto-start enrollment; the
 * runtime is lazily constructed and 3A2b drives its lifecycle. All native module
 * imports are top-level so Metro resolves the full production graph.
 */
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { API_BASE, getSessionToken, getDeviceId, rotateDeviceId, setActiveHost } from './auth';
import { getStr, setStr } from './storage';
import { nobleShadowCrypto } from './shadowCryptoNoble';
import { ExpoSecureStoreAdapter } from './shadowSecureStore';
import { SQLiteEnrollmentMetaStore, type SQLiteMetaDatabase } from './shadowEnrollmentMetaStore';
import { ShadowMobileEnrollmentRuntime, type MobileSessionProvider } from './shadowEnrollmentClient';
import { createExpoSQLiteShadowStore, type ExpoSQLiteShadowStore } from './shadowClient';
import { ShadowPurgeGate, runShadowPurgeStages } from './shadowPurgeGate';
import type { ShadowControllerService } from './shadowControllerService';

const META_DB_NAME = 'maestro-shadow-enroll.db';
const SHADOW_DB_NAME = 'maestro-shadow.db';
const SESSION_LOOKUP_TIMEOUT_MS = 15_000;
const CACHED_ACCOUNT_ID_KEY = 'maestro.shadow.cachedAccountId';

/** Secure CSPRNG from expo-crypto (fails closed if the native module is absent). */
function expoRandomSource(length: number): Uint8Array {
  const bytes = Crypto.getRandomBytes(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('expo-crypto CSPRNG unavailable');
  return bytes;
}

async function openMetaDb(): Promise<SQLiteMetaDatabase> {
  const mod = SQLite as unknown as {
    openDatabaseAsync?: (name: string) => Promise<SQLiteMetaDatabase>;
    openDatabaseSync?: (name: string) => SQLiteMetaDatabase;
  };
  if (mod.openDatabaseAsync) return await mod.openDatabaseAsync(META_DB_NAME);
  if (mod.openDatabaseSync) return mod.openDatabaseSync(META_DB_NAME);
  throw new Error('expo-sqlite database opener unavailable');
}

let cachedAccount: { token: string; accountId: string } | null = null;

/**
 * Resolve the signed-in account id from Better Auth get-session.
 *
 * Uses a three-tier strategy for instant offline startup:
 *   1. In-memory cache (survives within the process)
 *   2. Persistent cache (AsyncStorage — survives cold boot)
 *   3. Network fetch (Better Auth get-session endpoint)
 *
 * On cold boot when the server is unreachable (Mac off), the persistent cache
 * returns the account id instantly instead of hanging for 15s. The network
 * fetch refreshes the cache in the background when connectivity returns.
 */
async function resolveAccountId(): Promise<string> {
  const token = getSessionToken();
  if (!token) throw Object.assign(new Error('not signed in'), { statusCode: 401 });
  // Tier 1: in-memory cache (fastest)
  if (cachedAccount && cachedAccount.token === token) return cachedAccount.accountId;
  // Tier 2: persistent cache (instant on cold boot, no network)
  const persisted = getStr(CACHED_ACCOUNT_ID_KEY);
  if (persisted) {
    // Use the persisted account id immediately; refresh in background.
    cachedAccount = { token, accountId: persisted };
    // Best-effort background refresh: if the server is reachable, update the
    // cache. If not, the persisted value is still valid (the enrollment grant
    // is bound to this account and won't change without a full sign-out).
    void resolveAccountIdFromNetwork(token).catch(() => { /* offline is fine */ });
    return persisted;
  }
  // Tier 3: network fetch (first-time enrollment or after cache clear)
  return resolveAccountIdFromNetwork(token);
}

/** Fetch the account id from the relay and persist it. */
async function resolveAccountIdFromNetwork(token: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SESSION_LOOKUP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw Object.assign(new Error('session lookup timed out'), { statusCode: 0 });
    }
    throw error;
  }
  clearTimeout(timer);
  if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'session expired' : `session lookup failed (${res.status})`), { statusCode: res.status });
  const data = (await res.json().catch(() => null)) as { user?: { id?: string } } | null;
  const id = data?.user?.id;
  if (!id) throw Object.assign(new Error('no account session'), { statusCode: 401 });
  cachedAccount = { token, accountId: id };
  setStr(CACHED_ACCOUNT_ID_KEY, id);
  return id;
}

const productionSession: MobileSessionProvider = {
  get: async () => ({
    accountId: await resolveAccountId(),
    controllerDeviceId: getDeviceId(),
    sessionToken: getSessionToken(),
    relayOrigin: API_BASE,
  }),
  rotateDeviceId,
};

/** Construct a fresh production runtime (used by the singleton; overridable in tests). */
export async function createShadowMobileEnrollmentRuntime(): Promise<ShadowMobileEnrollmentRuntime> {
  const db = await openMetaDb();
  return new ShadowMobileEnrollmentRuntime({
    backend: nobleShadowCrypto(expoRandomSource),
    secureStore: new ExpoSecureStoreAdapter(),
    metaStore: new SQLiteEnrollmentMetaStore(db),
    session: productionSession,
    transport: { fetch: (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ConstructorParameters<typeof ShadowMobileEnrollmentRuntime>[0]['transport']['fetch']> },
    allowedOrigins: [API_BASE],
  });
}

let singleton: ShadowMobileEnrollmentRuntime | null = null;
let singletonPromise: Promise<ShadowMobileEnrollmentRuntime> | null = null;

/**
 * Lazily construct the ONE production runtime. B1-R1: this is PROMISE-memoized — the
 * factory Promise itself is cached, so concurrent callers (App bootstrap + the screen
 * runtime racing at boot) await the SAME in-flight construction and always receive the
 * identical instance (never two runtimes where one reads a grant the other populated).
 * The cache is cleared on construction error so a later call can retry, and on durable
 * reset (sign-out / account switch) so a fresh account never reuses a stale runtime.
 */
export async function getShadowMobileEnrollmentRuntime(): Promise<ShadowMobileEnrollmentRuntime> {
  if (!singletonPromise) {
    singletonPromise = createShadowMobileEnrollmentRuntime().then(
      (rt) => { singleton = rt; return rt; },
      (err) => { singletonPromise = null; throw err; }, // clear on error → retryable
    );
  }
  return singletonPromise;
}

let controllerSingleton: ShadowControllerService | null = null;
/**
 * Phase 3B0 NOTE-1: the durable SQLite store (plaintext host-entity cache) backing
 * the current controller service, retained so the reset/teardown contract can
 * DURABLY wipe `maestro-shadow.db` — not just drop the in-memory service.
 */
let controllerStore: ExpoSQLiteShadowStore | null = null;
/**
 * Phase 3B0 NOTE-1: monotonically increasing on every durable reset. A bootstrap
 * captures the generation before building and DISCARDS its result if a reset
 * bumped it meanwhile — so a controller built for a signed-out/previous
 * account/host is never cached or read.
 */
let resetGeneration = 0;
export function shadowControllerResetGeneration(): number { return resetGeneration; }

/**
 * Production DURABLE controller service: from the accepted enrollment grant +
 * SecureStore scope key, construct a real `ShadowControllerService` (→ a real
 * `ShadowMobileClient` over `ExpoSQLiteShadowStore`) that reads host state and
 * sends commands over the signed data routes. Lazy; nothing connects on import.
 * Returns null until a grant has been accepted.
 */
export async function createShadowMobileControllerService(): Promise<ShadowControllerService | null> {
  const runtime = await getShadowMobileEnrollmentRuntime();
  await runtime.restore(); // rehydrate the accepted grant + scope key from SecureStore
  const grant = runtime.grantSummary();
  if (!grant) return null;
  // Wire the host identity into the shared auth module so the screen runtime's
  // session() resolver (and any other consumer that reads getActiveHost()) can
  // construct the /ws/remote/screen WebSocket URL. Without this the screen
  // viewer store never attaches a ScreenStreamClient and the "View screen"
  // button is hidden.
  setActiveHost(grant.hostDeviceId);
  const store = await createExpoSQLiteShadowStore({
    databaseName: SHADOW_DB_NAME,
    controllerDeviceId: grant.controllerDeviceId,
    hostDeviceId: grant.hostDeviceId,
    expectedAuthority: { fence: grant.fence, controllerDeviceId: grant.controllerDeviceId, leaseExpiresAt: grant.leaseExpiresAt },
  });
  controllerStore = store; // retained for the durable reset contract
  return runtime.buildControllerService({
    store,
    session: () => productionSession.get(),
    transport: { fetch: (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ConstructorParameters<typeof ShadowMobileEnrollmentRuntime>[0]['transport']['fetch']> },
  });
}

/** Lazily construct the one production durable controller service. */
export async function getShadowMobileControllerService(): Promise<ShadowControllerService | null> {
  if (!controllerSingleton) controllerSingleton = await createShadowMobileControllerService();
  return controllerSingleton;
}

/** Open the shadow DB with placeholder authority — `reset()` / row-count use only SQL, not authority. */
async function openShadowStoreForPurge(): Promise<ExpoSQLiteShadowStore> {
  return createExpoSQLiteShadowStore({
    databaseName: SHADOW_DB_NAME,
    controllerDeviceId: 'purge', hostDeviceId: 'purge',
    expectedAuthority: { fence: { accountId: 'purge', scopeId: 'purge', hostDeviceId: 'purge', epoch: 0, leaseId: 'purge' }, controllerDeviceId: 'purge', leaseExpiresAt: 0 },
  });
}

/** Close/reopen verification: cache rows == 0 AND grant meta == null AND scope keys absent. */
async function verifyPurged(runtime: ShadowMobileEnrollmentRuntime, handles: string[]): Promise<boolean> {
  if (await runtime.loadGrantMeta()) return false;
  const secure = runtime.secureStoreRef();
  for (const h of handles) { if ((await secure.getItemAsync(h)) != null) return false; }
  const store = await openShadowStoreForPurge();
  return (await store.totalRowCountForPurgeVerification()) === 0;
}

/**
 * Phase 3B0 O-1: the DURABLE, FAIL-CLOSED reset/teardown contract for sign-out /
 * account / host switch. It establishes a durable purge tombstone (SecureStore,
 * independent of the wiped SQLite DBs) BEFORE any destructive stage, then purges —
 * with AGGREGATE error handling — the SecureStore scope key(s) + grant metadata
 * AND the SQLite entity/command cache, holds the tombstone until ALL stages
 * succeed and a close/reopen verification reads empty, and clears it LAST. Any
 * stage failure (or verification miss, or tombstone-storage error) leaves the
 * durable tombstone + locked runtime and REJECTS — a later bootstrap/read/send is
 * refused (see {@link ensureNoPendingPurge}) until a retry fully succeeds. No
 * fire-and-forget; no rebuild-from-survivors on the failure path.
 */
export async function resetShadowMobileEnrollmentRuntimeDurable(reason = 'account-switch'): Promise<void> {
  const service = controllerSingleton;
  let runtime = singleton;
  const store = controllerStore;
  resetGeneration += 1; // invalidate any in-flight bootstrap immediately
  const gen = resetGeneration;
  controllerSingleton = null;
  singleton = null;
  singletonPromise = null; // B1-R1: drop the memoized factory promise so a fresh account rebuilds
  controllerStore = null;
  cachedAccount = null;
  setStr(CACHED_ACCOUNT_ID_KEY, ''); // clear persistent account cache on sign-out / account switch
  // Stop timers/subscriptions + wipe in-memory scope key/rings up front.
  if (service) { try { service.stopAutoReconcile(); service.lock(reason); } catch { /* best-effort */ } }
  // Reach the durable secureStore/metaStore (build a runtime if none exists this process).
  if (!runtime) runtime = await createShadowMobileEnrollmentRuntime();
  const gate = new ShadowPurgeGate(runtime.secureStoreRef());
  const handles = await runtime.scopeKeyHandlesForPurge();
  const token = `t_${gen}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  // Durable tombstone BEFORE any destructive stage — a write failure fails closed.
  await gate.require(token, handles, Date.now());
  const cacheStore = store ?? await openShadowStoreForPurge();
  await runShadowPurgeStages({
    scopeKeyHandles: handles,
    deleteSecureItem: (k) => runtime!.deleteSecureItem(k),
    clearGrant: () => runtime!.clearGrantMeta(),
    resetCache: () => cacheStore.reset(),
    verifyEmpty: () => verifyPurged(runtime!, handles),
  });
  // All stages succeeded + verified empty → clear the tombstone LAST (token-fenced).
  await gate.clearIfToken(token);
}

/**
 * Phase 3B0 O-1: gate consulted BEFORE every bootstrap/read. If a durable purge
 * tombstone is set (this process OR a prior one that crashed mid-purge), it drives
 * the purge to completion (a RETRY, idempotent) and clears the tombstone; if the
 * retry still fails it REJECTS so the caller refuses to build/use any controller.
 * When no tombstone is set it is a cheap no-op. Fails closed on a tombstone read
 * error (treats it as required).
 */
export async function ensureNoPendingPurge(): Promise<void> {
  const runtime = await getShadowMobileEnrollmentRuntime();
  const gate = new ShadowPurgeGate(runtime.secureStoreRef());
  const t = await gate.read(); // a read throw propagates → caller fails closed
  if (!t) return;
  const handles = t.scopeKeyHandles.length ? t.scopeKeyHandles : await runtime.scopeKeyHandlesForPurge();
  const cacheStore = controllerStore ?? await openShadowStoreForPurge();
  await runShadowPurgeStages({
    scopeKeyHandles: handles,
    deleteSecureItem: (k) => runtime.deleteSecureItem(k),
    clearGrant: () => runtime.clearGrantMeta(),
    resetCache: () => cacheStore.reset(),
    verifyEmpty: () => verifyPurged(runtime, handles),
  });
  await gate.clearIfToken(t.token); // retry clears with the token it read (fence)
}
