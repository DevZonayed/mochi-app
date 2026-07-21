/**
 * shadow-host-service — Phase 3A2a production HOST data/command runtime. Composes
 * the enrolled scope key + authority fence with exactly one real `ShadowHostCore`
 * per account/scope and a signed-HTTP relay port, so the durable state + command
 * plane the reviewer required is actually driven by an enrolled controller:
 *
 *   - product state changes → `ShadowHostCore.appendEvent` (hash-chained, encrypted
 *     under the scope key) → published (ordered, idempotent) to `/api/shadow/events`
 *     as self-contained wire envelopes the controller can open (via shadowDataCodec).
 *   - controller commands → pulled from `/api/shadow/commands`, decrypted with the
 *     scope key, and driven EXACTLY ONCE across crash/kill/concurrency boundaries.
 *
 * EXACTLY-ONCE (3A2a re-review finding 1). Command execution is crash-safe:
 *   1. Each pulled command's encrypted envelope is persisted DURABLY in a local
 *      intake store BEFORE any processing, so recovery never depends on re-pulling
 *      an already-delivered relay command.
 *   2. A command is CLAIMED (owner + single-use token + bounded lease) via
 *      `ShadowHostCore.claimRetryableCommands` BEFORE the executor runs, so two
 *      pollers / process instances can never both execute it.
 *   3. The durable PRODUCT idempotency boundary is the `ShadowHostCore` command
 *      ledger row keyed by `(scopeId, commandId)` + its unique `idempotencyKey`:
 *      the command-bound completion state event is appended by `appendEvent`, which
 *      writes `result_event_id` + advances the ledger to `applied` in ONE SQLite
 *      transaction and is idempotent by the content-addressed `eventId`. On replay
 *      after an unknown crash the ledger already reads `applied`, so the prior
 *      bounded result is recovered and the side effect is never repeated.
 *   4. Only naturally-idempotent methods are allowlisted: read-only reads, or
 *      commands whose entire durable effect IS the idempotent completion state
 *      event. A method with a non-idempotent external side effect must NOT be
 *      allowlisted until it carries its own durable idempotency keyed by
 *      `commandId`. The executor contract is therefore a pure function of
 *      `(commandId, params)` that returns a deterministic completion receipt.
 *   5. A recovery worker resumes the state machine on start/every poll:
 *      claimed-not-run re-executes after the lease; effect-recorded returns the
 *      stored result; ack/event-recorded re-posts/republishes idempotently.
 *
 * `ShadowHostCore` is not modified. The relay sees ciphertext + digests only.
 */
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { ShadowHostCore, type ShadowHostRelayPort, type ShadowHostKeyProvider, type ClaimedCommand } from './shadow-host.js';
import type { Fence, ShadowStateEvent, HostCommandAck, ShadowCollection } from '@maestro/realtime';
import {
  ShadowRequestClient,
  type ShadowRequestSigner,
  type ShadowTransportConfig,
} from '@maestro/realtime/shadowRequestClient';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode, utf8Encode, type ShadowCryptoBackend } from '@maestro/realtime/shadowCrypto';
import { sanitizeAckErrorMessage } from '@maestro/realtime/shadowErrorSanitize';
import {
  deriveScopeKeyring, type ScopeKeyring,
  sealEventPayload,
  openCommandEnvelope,
  sealCommandAck,
  signCommandAck,
} from '@maestro/realtime/shadowDataCodec';
import {
  isKnownCapability, methodPermittedBy, requiredCapabilityForMethod,
  SHADOW_DEFAULT_CAPABILITIES, type ShadowCapability,
} from '@maestro/realtime/shadowCapabilities';
import { projectionDigest } from './shadow-projection-schema.js';
import { canonicalStringify } from './shadow-projection-redact.js';

const backendDefault = nodeShadowCrypto;

/** Command-claim lease: long enough to finish a poll, short enough to recover after a crash. */
const CLAIM_LEASE_MS = 30_000;
/** Back-off before a released (not-completed) command becomes reclaimable. */
const RECLAIM_DELAY_MS = 500;
const DEFAULT_PUBLISH_DRAIN_BATCHES = 20;
const MAX_PUBLISH_DRAIN_BATCHES = 100;
const DEFAULT_PUBLISH_BATCH_LIMIT = 100;
const MAX_PUBLISH_BATCH_LIMIT = 500;

function sha256Digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** True for the tagged error thrown by `ShadowHostCore.assertCurrentAuthority` (HIGH-2). */
function isAuthorityError(err: unknown): boolean {
  return !!(err && typeof err === 'object' && (err as { authorityError?: unknown }).authorityError === true);
}

/** True for the tagged authority error OR a raw `requireFence` throw (`fence-*` / `authority-*` / `scope-blocked-*`). */
function isFenceOrAuthorityError(err: unknown): boolean {
  if (isAuthorityError(err)) return true;
  const msg = err instanceof Error ? err.message : '';
  return /^(fence-|authority-|scope-blocked-)/.test(msg);
}

/** The plaintext of a controller command envelope. */
export interface ControllerCommand {
  method: string;
  params?: unknown;
  idempotencyKey?: string;
}

/** Result of executing an allowlisted controller command. */
export type HostCommandExecution =
  | { ok: true; completion: { collection: ShadowCollection; op: ShadowStateEvent['op']; entityId: string; revision: number; payload: unknown } }
  | { ok: false; code: string; message: string };

export type HostCommandExecutor = (input: { method: string; params: unknown; commandId: string; fence: Fence }) => Promise<HostCommandExecution>;

/**
 * The ONLY effect modes a remotely-invokable command may declare:
 *   - `read-only`  — the executor only READS product state; re-evaluation after an
 *     unknown crash is harmless (no external mutation).
 *   - `event-only` — the executor's SOLE durable effect IS the returned completion
 *     state event, applied idempotently by the content-addressed `eventId`.
 * A method with a non-idempotent EXTERNAL side effect is deliberately NOT
 * representable here and MUST NOT be registered until it carries product-level
 * ATOMIC idempotency (deferred to 3B). This is why the command bridge can honestly
 * bound its guarantee: the executor callback may be re-evaluated after a crash, but
 * it is constrained to no external non-idempotent side effect, so the durable,
 * externally-visible effect (the completion event/entity) is applied exactly once.
 */
export type ShadowCommandEffectMode = 'read-only' | 'event-only' | 'product-idempotent';

/**
 * Stable identity + digest a `product-idempotent` action adapter uses to key its
 * DURABLE product receipt. `idempotencyKey` is the controller's stable key (so a
 * duplicate submission maps to the same product effect); `canonicalPayloadDigest`
 * detects a conflicting replay (same command id / idempotency key, different payload).
 */
export interface ProductIdempotentActionInput {
  accountId: string;
  scopeId: string;
  controllerDeviceId: string;
  commandId: string;
  idempotencyKey: string;
  canonicalPayloadDigest: string;
  params: unknown;
  fence: Fence;
  now: number;
  /**
   * HIGH-2 TOCTOU guard, SUPPLIED BY THE PRODUCTION SERVICE (never the controller /
   * envelope / registry author). The adapter MUST call this synchronously immediately
   * before its FIRST durable Store mutation, with NO await/yield between the call and the
   * mutation, so a lease/fence/epoch/revoke invalidation committed before that instant
   * fails closed (throws) with zero product effect. It re-reads the authoritative host
   * authority row each call.
   */
  assertAuthority: () => void;
}

/**
 * A `product-idempotent` action adapter. Its `execute` performs the REAL product
 * state transition through a durable, atomic idempotency seam (or its own Store-owned
 * receipt) so that: an identical replay returns the SAME bounded completion without a
 * second external effect; a conflicting replay (different payload/method) is rejected;
 * and a crash between the durable product commit and the ACK recovers to the same
 * receipt. The returned completion references the resulting product entity so the host
 * can project it (carrying `commandId`) as the authoritative applied state.
 */
export interface ProductIdempotentActionAdapter {
  execute(input: ProductIdempotentActionInput): Promise<HostCommandExecution>;
}

export type ShadowCommandRegistryEntry =
  | { effectMode: 'read-only'; execute: HostCommandExecutor }
  | { effectMode: 'event-only'; execute: HostCommandExecutor }
  | {
      effectMode: 'product-idempotent';
      /** The capability the active enrolled controller must hold (checked host-side at execution). */
      requiredCapability: ShadowCapability;
      /** Strict schema/parser for the raw command payload (bounds ids/lengths/enums). */
      parse: (raw: unknown) => { ok: true; value: unknown } | { ok: false; reason: string };
      /** The durable, atomic product action. */
      adapter: ProductIdempotentActionAdapter;
    };

export type ShadowCommandRegistry = ReadonlyMap<string, ShadowCommandRegistryEntry>;

const ALLOWED_EFFECT_MODES: ReadonlySet<string> = new Set<ShadowCommandEffectMode>(['read-only', 'event-only', 'product-idempotent']);

/**
 * Build a command registry. Enforces the effect-mode contract at RUNTIME (not only
 * via the type union), so a mutating/non-idempotent entry can neither be typed nor
 * constructed. A `product-idempotent` entry additionally REQUIRES a known required
 * capability, a parser, and an adapter with an `execute` — a cast/malformed entry is
 * rejected. Duplicate method keys are rejected. The returned map is read-only.
 */
export function defineShadowCommandRegistry(entries: Record<string, ShadowCommandRegistryEntry>): ShadowCommandRegistry {
  const map = new Map<string, ShadowCommandRegistryEntry>();
  for (const [method, entry] of Object.entries(entries)) {
    if (typeof method !== 'string' || method.length === 0) throw new Error('shadow-command-registry: empty method name');
    if (map.has(method)) throw new Error(`shadow-command-registry: duplicate method ${method}`);
    const mode = (entry as { effectMode?: unknown }).effectMode;
    if (typeof mode !== 'string' || !ALLOWED_EFFECT_MODES.has(mode)) {
      throw new Error(`shadow-command-registry: method ${method} declares forbidden effectMode ${String(mode)} — only read-only/event-only/product-idempotent may be registered`);
    }
    if (mode === 'product-idempotent') {
      const e = entry as Extract<ShadowCommandRegistryEntry, { effectMode: 'product-idempotent' }>;
      if (!isKnownCapability(e.requiredCapability)) throw new Error(`shadow-command-registry: method ${method} product-idempotent entry has unknown requiredCapability`);
      if (typeof e.parse !== 'function') throw new Error(`shadow-command-registry: method ${method} product-idempotent entry has no parser`);
      if (!e.adapter || typeof e.adapter.execute !== 'function') throw new Error(`shadow-command-registry: method ${method} product-idempotent entry has no adapter.execute`);
    } else {
      if (typeof (entry as { execute?: unknown }).execute !== 'function') throw new Error(`shadow-command-registry: method ${method} has no executor`);
    }
    map.set(method, entry);
  }
  return map;
}

export interface HostSessionContext {
  accountId: string;
  hostDeviceId: string;
  sessionToken: string;
  relayOrigin: string;
}

export interface ShadowHostDataServiceOptions {
  host: ShadowHostCore;
  keys: ShadowHostKeyProvider;
  scopeKeyId: string;
  fence: Fence;
  leaseExpiresAt: number;
  /** Durable dir for the command intake store (defaults to the host root). */
  intakeDir?: string;
  revokedControllerDeviceIds?: readonly string[];
  session: () => Promise<HostSessionContext>;
  signer: ShadowRequestSigner;
  transport: Pick<ShadowTransportConfig, 'fetch'> & Partial<Pick<ShadowTransportConfig, 'allowInsecureLoopback' | 'timeoutMs' | 'maxResponseBytes' | 'randomNonce'>>;
  /** Typed registry of remotely-invokable commands (read-only / event-only / product-idempotent). */
  commandRegistry: ShadowCommandRegistry;
  /**
   * AUTHORITATIVE per-controller approved capability lookup (from the host enrollment
   * record), consulted at EXECUTION time for every mutating command. Returns the
   * canonical approved set, or `null`/undefined for an unknown controller (→ default
   * `account.read` only). Never trust the command envelope's declared capability.
   */
  capabilitiesFor?: (controllerDeviceId: string) => readonly ShadowCapability[] | null | undefined;
  backend?: ShadowCryptoBackend;
  now?: () => number;
  /** Stable owner id for command claims; a fresh random id per instance by default. */
  ownerId?: string;
}

interface QueuedCommandRow {
  commandId: string;
  controllerDeviceId: string;
  fence: Fence;
  envelopeCiphertext: string;
  payloadDigest: string;
}

interface IntakeRow {
  commandId: string;
  controllerDeviceId: string;
  fence: Fence;
  envelopeCiphertext: string;
  payloadDigest: string;
  ackCiphertext: string | null;
  ackDigest: string | null;
  completionJson: string | null;
}

/**
 * Durable intake/receipt store (better-sqlite3, same binding as `ShadowHostCore`).
 * Persists the ENCRYPTED command envelope so recovery can re-drive a command that
 * the relay has already marked delivered, plus the reproducible ACK ciphertext and
 * the bounded completion receipt — never any scope plaintext or secret.
 */
class ShadowCommandIntakeStore {
  private readonly db: Database.Database;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, 'command-intake.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS command_intake(
      scope_id TEXT NOT NULL, command_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      controller_device_id TEXT NOT NULL, fence_json TEXT NOT NULL,
      envelope_ciphertext TEXT NOT NULL, payload_digest TEXT NOT NULL,
      ack_ciphertext TEXT, ack_digest TEXT, completion_json TEXT,
      created_at INTEGER NOT NULL, PRIMARY KEY(scope_id, command_id))`);
  }
  put(scopeId: string, idempotencyKey: string, row: QueuedCommandRow, now: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO command_intake(scope_id,command_id,idempotency_key,controller_device_id,fence_json,envelope_ciphertext,payload_digest,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(scopeId, row.commandId, idempotencyKey, row.controllerDeviceId, JSON.stringify(row.fence), row.envelopeCiphertext, row.payloadDigest, now);
  }
  get(scopeId: string, commandId: string): IntakeRow | null {
    const r = this.db.prepare('SELECT * FROM command_intake WHERE scope_id=? AND command_id=? LIMIT 1').get(scopeId, commandId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      commandId: r.command_id as string, controllerDeviceId: r.controller_device_id as string,
      fence: JSON.parse(r.fence_json as string) as Fence, envelopeCiphertext: r.envelope_ciphertext as string,
      payloadDigest: r.payload_digest as string, ackCiphertext: (r.ack_ciphertext as string) ?? null,
      ackDigest: (r.ack_digest as string) ?? null, completionJson: (r.completion_json as string) ?? null,
    };
  }
  all(scopeId: string): IntakeRow[] {
    return (this.db.prepare('SELECT command_id FROM command_intake WHERE scope_id=? ORDER BY created_at ASC').all(scopeId) as Array<{ command_id: string }>)
      .map((x) => this.get(scopeId, x.command_id)!).filter(Boolean);
  }
  recordAck(scopeId: string, commandId: string, ackCiphertext: string, ackDigest: string): void {
    // First-writer-wins so the ACK is reproducible across crashes (relay dedupes by digest).
    this.db.prepare('UPDATE command_intake SET ack_ciphertext=COALESCE(ack_ciphertext,?), ack_digest=COALESCE(ack_digest,?) WHERE scope_id=? AND command_id=?')
      .run(ackCiphertext, ackDigest, scopeId, commandId);
  }
  recordCompletion(scopeId: string, commandId: string, completion: unknown): void {
    this.db.prepare('UPDATE command_intake SET completion_json=COALESCE(completion_json,?) WHERE scope_id=? AND command_id=?')
      .run(JSON.stringify(completion), scopeId, commandId);
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}

/**
 * Signed-HTTP implementation of `ShadowHostRelayPort`. `publishOrderedEvents`
 * RE-SEALS each event payload into a self-contained wire envelope (the host
 * journal keeps only ciphertext on the wire) using the HKDF ring for its keyId.
 */
class SignedHttpHostRelayPort implements ShadowHostRelayPort {
  constructor(
    private readonly deps: {
      backend: ShadowCryptoBackend;
      host: ShadowHostCore;
      keyring: (keyId: string) => Promise<ScopeKeyring>;
      client: () => Promise<{ client: ShadowRequestClient; session: HostSessionContext }>;
      signer: ShadowRequestSigner;
    },
  ) {}

  async publishOrderedEvents(_scopeId: string, _fence: Fence, events: ShadowStateEvent[]): Promise<void> {
    if (events.length === 0) return;
    const wire: unknown[] = [];
    for (const event of events) {
      const keyring = await this.deps.keyring(event.keyId);
      const plaintext = this.deps.host.decryptEventPayload(event.eventId);
      const payloadCiphertext = await sealEventPayload(this.deps.backend, keyring, event, utf8Encode(JSON.stringify(plaintext)));
      wire.push({ ...event, payloadCiphertext });
    }
    const { client, session } = await this.deps.client();
    const res = await client.requestEnrolled(
      { accountId: session.accountId, deviceId: session.hostDeviceId, sessionToken: session.sessionToken },
      this.deps.signer,
      { method: 'POST', path: '/api/shadow/events', body: { events: wire } },
    );
    if (!res.ok) throw Object.assign(new Error(res.error ?? 'publish events failed'), { statusCode: res.status });
  }

  publishSnapshotManifest(): void { /* snapshots unused in the command/event E2E path */ }
  publishSnapshotChunk(): void { /* unused */ }
  fetchCommands(): unknown[] { return []; /* commands pulled explicitly by the service */ }
  submitCommandAck(): void { /* acks submitted explicitly by the service */ }
  submitCursor(): void { /* controller owns its cursor */ }
}

export type HostDataServiceState = 'idle' | 'active' | 'closed';

/** Test-only crash points, exercised by the crash/fault-injection E2E. */
export type HostCommandCrashPoint =
  | 'after-intake-before-claim'
  | 'after-claim-before-execute'
  | 'after-execute-before-ack'
  | 'after-ack-before-append'
  | 'after-append-before-relay-ack'
  | 'after-relay-ack-before-publish';

/** Production host data/command runtime. */
export class ShadowHostDataService {
  private readonly backend: ShadowCryptoBackend;
  private readonly now: () => number;
  private readonly relay: SignedHttpHostRelayPort;
  private readonly intake: ShadowCommandIntakeStore;
  private readonly ownerId: string;
  private readonly keyrings = new Map<string, ScopeKeyring>();
  private scopeKeyId: string;
  private fence: Fence;
  private state: HostDataServiceState = 'idle';
  private crashPoint: HostCommandCrashPoint | null = null;
  private publishDrainInFlight: Promise<number> | null = null;

  constructor(private readonly opts: ShadowHostDataServiceOptions) {
    this.backend = opts.backend ?? backendDefault;
    this.now = opts.now ?? Date.now;
    this.fence = opts.fence;
    this.scopeKeyId = opts.scopeKeyId;
    this.ownerId = opts.ownerId ?? `host-${base64urlEncode(this.backend.randomBytes(8))}`;
    this.intake = new ShadowCommandIntakeStore(opts.intakeDir ?? dirname(opts.host.paths.sqlitePath));
    this.opts.host.setAuthority({
      accountId: opts.fence.accountId, scopeId: opts.fence.scopeId, hostDeviceId: opts.fence.hostDeviceId,
      epoch: opts.fence.epoch, leaseId: opts.fence.leaseId, leaseExpiresAt: opts.leaseExpiresAt,
      revokedControllerDeviceIds: opts.revokedControllerDeviceIds ?? [],
    });
    this.relay = new SignedHttpHostRelayPort({
      backend: this.backend, host: opts.host, keyring: (keyId) => this.keyringFor(keyId),
      client: () => this.enrolledClient(), signer: opts.signer,
    });
    this.state = 'active';
  }

  /** TEST-ONLY: inject a crash at a named command-processing boundary. */
  debugSetCrashPointForTest(point: HostCommandCrashPoint | null): void { this.crashPoint = point; }

  status(): { state: HostDataServiceState; scopeId: string; epoch: number; leaseExpiresAt: number } {
    const authority = this.opts.host.getAuthority(this.fence.scopeId);
    return { state: this.state, scopeId: this.fence.scopeId, epoch: this.fence.epoch, leaseExpiresAt: authority?.leaseExpiresAt ?? 0 };
  }

  /**
   * Phase 3B0 NOTE-2: the LIVE authority actually in force on this service's
   * `ShadowHostCore` — the current fence, lease, active scope-key id, and the
   * revoked-controller set that gates every command (read-only included). Used to
   * assert that renew/revoke propagation fed the current revoked set + rotated
   * scope-key id into the live plane (no scope-key plaintext is exposed).
   */
  authoritySnapshot(): { scopeId: string; epoch: number; leaseId: string; leaseExpiresAt: number; scopeKeyId: string; revokedControllerDeviceIds: string[] } {
    const a = this.opts.host.getAuthority(this.fence.scopeId);
    return {
      scopeId: this.fence.scopeId,
      epoch: this.fence.epoch,
      leaseId: this.fence.leaseId,
      leaseExpiresAt: a?.leaseExpiresAt ?? 0,
      scopeKeyId: this.scopeKeyId,
      revokedControllerDeviceIds: [...(a?.revokedControllerDeviceIds ?? [])],
    };
  }

  /** Update authority after a lease renewal / rotation (new epoch/lease/expiry/revocations). */
  setAuthority(fence: Fence, leaseExpiresAt: number, revokedControllerDeviceIds: readonly string[] = [], scopeKeyId?: string): void {
    this.fence = fence;
    if (scopeKeyId) this.scopeKeyId = scopeKeyId;
    this.opts.host.setAuthority({
      accountId: fence.accountId, scopeId: fence.scopeId, hostDeviceId: fence.hostDeviceId,
      epoch: fence.epoch, leaseId: fence.leaseId, leaseExpiresAt, revokedControllerDeviceIds,
    });
  }

  /** Append a product state event (public controller view) and return it. Fail-closed if the lease expired. */
  appendEvent(input: { collection: ShadowCollection; op: ShadowStateEvent['op']; entityId: string; revision: number; payload: unknown; commandId?: string }): ShadowStateEvent {
    return this.opts.host.appendEvent({
      fence: this.fence, collection: input.collection, op: input.op, entityId: input.entityId,
      revision: input.revision, payload: input.payload, commandId: input.commandId, now: this.now(),
    });
  }

  /** Publish all un-published events to the relay (ordered, idempotent). */
  async publish(): Promise<number> {
    return this.publishAllPending();
  }

  /**
   * Drain pending state events in contiguous relay batches. `ShadowHostCore` keeps
   * the per-call batch bounded (default 100); this wrapper is the production loop's
   * bounded "publish until empty" contract so a large first baseline does not stall
   * after the first batch.
   */
  async publishAllPending(maxBatches = 20, batchLimit = 100): Promise<number> {
    if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_PUBLISH_DRAIN_BATCHES) throw new Error('publish-drain-batches-invalid');
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_PUBLISH_BATCH_LIMIT) throw new Error('publish-drain-limit-invalid');
    const effectiveMaxBatches = Math.max(maxBatches, DEFAULT_PUBLISH_DRAIN_BATCHES);
    const effectiveBatchLimit = Math.max(batchLimit, DEFAULT_PUBLISH_BATCH_LIMIT);
    if (this.publishDrainInFlight) return this.publishDrainInFlight;
    const drain = this.drainPendingEvents(effectiveMaxBatches, effectiveBatchLimit);
    this.publishDrainInFlight = drain;
    try {
      return await drain;
    } finally {
      if (this.publishDrainInFlight === drain) this.publishDrainInFlight = null;
    }
  }

  private async drainPendingEvents(maxBatches: number, batchLimit: number): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      this.assertOpenForPublish();
      const published = await this.opts.host.publishPending(this.relay, {
        fence: this.fence,
        now: this.now(),
        limit: batchLimit,
        beforeMark: () => this.assertOpenForPublish(),
      });
      total += published;
      if (published === 0 || published < batchLimit) break;
    }
    return total;
  }

  private assertOpenForPublish(): void {
    if (this.state !== 'active') throw new Error('publish-service-closed');
  }

  /**
   * Pull queued controller commands, then drive EVERY locally-durable command
   * (freshly pulled + any left incomplete by a prior crash) to completion exactly
   * once. Returns the number of newly-pulled commands.
   */
  async pollAndExecuteCommands(limit = 50): Promise<number> {
    const rows = await this.pullCommands(limit);
    const scopeId = this.fence.scopeId;
    for (const row of rows) {
      const decoded = await this.decode(row);
      const idempotencyKey = this.idempotencyKeyFor(row, decoded);
      this.intake.put(scopeId, idempotencyKey, row, this.now());
    }
    await this.crashAt('after-intake-before-claim');
    await this.recoverPendingCommands();
    // HIGH-2: never publish under an invalid/expired authority (and never let the poll loop
    // hot on the requireFence throw). Under valid authority this is the normal publish.
    try {
      this.opts.host.assertCurrentAuthority(this.fence, undefined, this.now());
      await this.publishAllPending();
    } catch (e) {
      if (!isFenceOrAuthorityError(e)) throw e;
    }
    return rows.length;
  }

  /**
   * Recovery worker: ingest every durable intake command into the ledger
   * (idempotent), settle any already-`applied` ones (re-post ACK + republish),
   * then CLAIM + drive the retryable ones exactly once.
   */
  async recoverPendingCommands(): Promise<number> {
    const scopeId = this.fence.scopeId;
    for (const row of this.intake.all(scopeId)) {
      const decoded = await this.decode(row);
      const idempotencyKey = this.idempotencyKeyFor(row, decoded);
      const status = this.ingestToLedger(row, idempotencyKey, decoded);
      if (status === 'applied') await this.settleApplied(row);
    }
    const claims = this.opts.host.claimRetryableCommands({ scopeId, ownerId: this.ownerId, now: this.now(), leaseMs: CLAIM_LEASE_MS, limit: 100 });
    await this.crashAt('after-claim-before-execute');
    let n = 0;
    for (const claim of claims) { await this.driveClaimed(claim); n += 1; }
    return n;
  }

  // ── command processing ──────────────────────────────────────────────────────

  private async pullCommands(limit: number): Promise<QueuedCommandRow[]> {
    const { client, session } = await this.enrolledClient();
    const res = await client.requestEnrolled<QueuedCommandRow[]>(
      { accountId: session.accountId, deviceId: session.hostDeviceId, sessionToken: session.sessionToken },
      this.opts.signer,
      { method: 'GET', path: `/api/shadow/commands?scopeId=${encodeURIComponent(this.fence.scopeId)}&limit=${Math.min(limit, 100)}` },
    );
    if (!res.ok) throw Object.assign(new Error(res.error ?? 'pull commands failed'), { statusCode: res.status });
    return Array.isArray(res.json) ? res.json : [];
  }

  private async decode(row: Pick<QueuedCommandRow, 'commandId' | 'fence' | 'envelopeCiphertext'>): Promise<ControllerCommand | null> {
    const keyring = await this.keyringFor(this.scopeKeyId);
    return (await openCommandEnvelope(this.backend, keyring, row.fence, row.commandId, row.envelopeCiphertext)) as ControllerCommand | null;
  }

  private idempotencyKeyFor(row: { commandId: string }, decoded: ControllerCommand | null): string {
    return decoded?.idempotencyKey ?? `idem_${row.commandId}`;
  }

  /** The active controller's authoritative approved capabilities (default `account.read`). */
  private approvedCapabilities(controllerDeviceId: string): readonly ShadowCapability[] {
    const c = this.opts.capabilitiesFor?.(controllerDeviceId);
    return c && c.length ? c : SHADOW_DEFAULT_CAPABILITIES;
  }

  /** Ingest into the durable ledger; returns the resulting lifecycle status, or 'fence-rejected'. */
  private ingestToLedger(row: IntakeRow | QueuedCommandRow, idempotencyKey: string, decoded: ControllerCommand | null): string {
    try {
      const ledger = this.opts.host.createOrRetryCommand({
        scopeId: this.fence.scopeId, commandId: row.commandId, idempotencyKey, fence: row.fence,
        params: decoded ?? { bad: true }, now: this.now(), retryDelayMs: 0,
      });
      return ledger.status;
    } catch {
      return 'fence-rejected';
    }
  }

  /** Drive one CLAIMED command from its current ledger state to completion, exactly once. */
  private async driveClaimed(claim: ClaimedCommand): Promise<void> {
    const scopeId = this.fence.scopeId;
    const commandId = claim.state.commandId;
    const intakeRow = this.intake.get(scopeId, commandId);
    if (!intakeRow) { this.release(commandId, claim.claimToken); return; }
    const decoded = await this.decode(intakeRow);

    if (!decoded || typeof decoded.method !== 'string') { await this.ackRejected(claim, intakeRow, 'bad-envelope', 'command envelope invalid'); return; }
    // Only registered read-only / event-only / product-idempotent commands run; anything
    // else (a mutating-but-unregistered or unknown method) is rejected BEFORE any effect.
    const entry = this.opts.commandRegistry.get(decoded.method);
    if (!entry) { await this.ackRejected(claim, intakeRow, 'method-not-registered', `method ${decoded.method} not registered`); return; }

    // HIGH-2: fail-closed authority pre-check BEFORE executing any registered command. A
    // command claimed under a valid lease but recovered after `leaseExpiresAt` (or under a
    // revoked controller / epoch drift) must NOT run. Terminalize locally — no product
    // mutation, no receipt, no published event, no hot re-claim loop.
    try { this.opts.host.assertCurrentAuthority(this.fence, intakeRow.controllerDeviceId, this.now()); }
    catch (err) {
      if (isAuthorityError(err)) { this.opts.host.terminalizeCommandLocally(scopeId, commandId, this.ownerId, claim.claimToken, this.now()); return; }
      throw err;
    }

    // Recover the bounded result if the effect already happened; else execute once.
    type Completion = (HostCommandExecution & { ok: true })['completion'];
    let completion: Completion | null = intakeRow.completionJson ? JSON.parse(intakeRow.completionJson) as Completion : null;
    if (!completion) {
      let outcome: HostCommandExecution;
      if (entry.effectMode === 'product-idempotent') {
        // EXECUTION-TIME capability enforcement from the AUTHORITATIVE host record —
        // never trust the envelope. A downgraded/revoked capability blocks a queued
        // command here, BEFORE any product receipt or effect (effect count 0).
        const caps = this.approvedCapabilities(intakeRow.controllerDeviceId);
        if (!methodPermittedBy(decoded.method, caps) || requiredCapabilityForMethod(decoded.method) !== entry.requiredCapability) {
          await this.ackRejected(claim, intakeRow, 'capability-denied', `method ${decoded.method} requires ${entry.requiredCapability}`);
          return;
        }
        const parsed = entry.parse(decoded.params);
        if (!parsed.ok) { await this.ackRejected(claim, intakeRow, 'bad-params', parsed.reason); return; }
        const idempotencyKey = this.idempotencyKeyFor(intakeRow, decoded);
        const canonicalPayloadDigest = sha256Digest(canonicalStringify(decoded.params ?? null));
        try {
          outcome = await entry.adapter.execute({
            accountId: this.fence.accountId, scopeId, controllerDeviceId: intakeRow.controllerDeviceId,
            commandId, idempotencyKey, canonicalPayloadDigest, params: parsed.value, fence: this.fence, now: this.now(),
            // HIGH-2: the SERVICE-constructed synchronous authority guard (not the registry/
            // controller). The adapter invokes it immediately before its first durable mutation.
            assertAuthority: () => this.opts.host.assertCurrentAuthority(this.fence, intakeRow.controllerDeviceId, this.now()),
          });
        } catch (err) {
          // The in-adapter guard fired between the pre-check and the mutation (TOCTOU race):
          // authority was invalidated → zero product effect. Terminalize locally, no publish.
          if (isAuthorityError(err)) { this.opts.host.terminalizeCommandLocally(scopeId, commandId, this.ownerId, claim.claimToken, this.now()); return; }
          throw err;
        }
      } else {
        outcome = await entry.execute({ method: decoded.method, params: decoded.params, commandId, fence: this.fence });
      }
      if (!outcome.ok) { await this.ackRejected(claim, intakeRow, outcome.code, outcome.message); return; }
      await this.crashAt('after-execute-before-ack');
      this.intake.recordCompletion(scopeId, commandId, outcome.completion); // bounded receipt, no secret
      completion = outcome.completion;
    }
    const effect = completion;

    // Build + durably record the reproducible ACK (relay dedupes by digest).
    const ack = await this.buildAck(commandId, 'accepted');
    const keyring = await this.keyringFor(this.scopeKeyId);
    const ackCiphertext = intakeRow.ackCiphertext ?? await sealCommandAck(this.backend, keyring, ack);
    const ackDigest = intakeRow.ackDigest ?? sha256Digest(ackCiphertext);
    this.intake.recordAck(scopeId, commandId, ackCiphertext, ackDigest);

    // Ledger ACK (requires the claim token), then the atomic completion event.
    try { this.opts.host.applyCommandAck(scopeId, ack, this.now(), { ownerId: this.ownerId, claimToken: claim.claimToken }); }
    catch { /* idempotent: already accepted/applied (e.g. recovery re-drive) */ }
    await this.crashAt('after-ack-before-append');
    this.commitCompletionEvent(entry.effectMode, effect, commandId);
    await this.crashAt('after-append-before-relay-ack');
    await this.postRelayAck(commandId, ackCiphertext, ackDigest);
    await this.crashAt('after-relay-ack-before-publish');
    await this.publishAllPending();
  }

  /**
   * Durably commit the command-bound completion event. For product-idempotent actions
   * the AUTHORITATIVE product entity is projected through the SAME atomic projection
   * index the all-project projection uses, carrying `commandId`, so the controller marks
   * the command `applied` only when the real projected state arrives (not on optimistic
   * ACK). Idempotent by digest / content-addressed eventId across replay — safe to
   * re-drive during recovery.
   */
  private commitCompletionEvent(effectMode: ShadowCommandEffectMode, effect: (HostCommandExecution & { ok: true })['completion'], commandId: string): void {
    if (effectMode === 'product-idempotent') {
      const digest = projectionDigest(effect.collection, effect.entityId, effect.payload);
      this.opts.host.projectEntity({
        fence: this.fence, collection: effect.collection, entityId: effect.entityId,
        digest, op: effect.op === 'delete' ? 'delete' : 'upsert', payload: effect.payload,
        commandId, now: this.now(),
      });
    } else {
      this.opts.host.appendEvent({
        fence: this.fence, collection: effect.collection, op: effect.op,
        entityId: effect.entityId, revision: effect.revision,
        payload: effect.payload, commandId, now: this.now(),
      });
    }
  }

  /**
   * An already-`applied` command in recovery: RE-DRIVE the command-bound completion
   * event (idempotent) so a crash AFTER the durable product commit + ledger `applied`
   * but BEFORE the projection/append still delivers the coherence event the controller
   * settles on — not merely the ACK. Then (re-)post the relay ACK. Closes the
   * "receipt/ACK durable, projection missing" window (§2 boundary B/C).
   */
  private async settleApplied(row: IntakeRow): Promise<void> {
    if (row.completionJson) {
      const decoded = await this.decode(row);
      const entry = decoded && typeof decoded.method === 'string' ? this.opts.commandRegistry.get(decoded.method) : undefined;
      if (entry) {
        try {
          const effect = JSON.parse(row.completionJson) as (HostCommandExecution & { ok: true })['completion'];
          this.commitCompletionEvent(entry.effectMode, effect, row.commandId);
        } catch { /* corrupt completion receipt — do not project a bad event; leave for diagnosis */ }
      }
    }
    if (row.ackCiphertext && row.ackDigest) await this.postRelayAck(row.commandId, row.ackCiphertext, row.ackDigest);
    await this.publishAllPending();
  }

  private async ackRejected(claim: ClaimedCommand, row: IntakeRow, code: string, message: string): Promise<void> {
    const ack = await this.buildAck(row.commandId, 'rejected', { code, message });
    try { this.opts.host.applyCommandAck(this.fence.scopeId, ack, this.now(), { ownerId: this.ownerId, claimToken: claim.claimToken }); }
    catch { /* already terminal */ }
    const keyring = await this.keyringFor(this.scopeKeyId);
    const ackCiphertext = row.ackCiphertext ?? await sealCommandAck(this.backend, keyring, ack);
    const ackDigest = row.ackDigest ?? sha256Digest(ackCiphertext);
    this.intake.recordAck(this.fence.scopeId, row.commandId, ackCiphertext, ackDigest);
    await this.postRelayAck(row.commandId, ackCiphertext, ackDigest);
  }

  private async buildAck(commandId: string, status: HostCommandAck['status'], error?: HostCommandAck['error']): Promise<HostCommandAck> {
    // Phase 3B0 NOTE-3: sanitize the ACK error message AT CONSTRUCTION — the
    // reason (which may derive from a raw executor exception or a controller-
    // supplied method name) is sealed + shipped to the controller's product error
    // result, so it must never carry a path / URL / host:port / stack / secret.
    const safeError = error ? { code: error.code, message: sanitizeAckErrorMessage(error.message) } : undefined;
    const unsigned: Omit<HostCommandAck, 'signature'> = { family: 'command-ack', v: 1, commandId, status, fence: this.fence, error: safeError, signedAt: this.now() };
    const keyring = await this.keyringFor(this.scopeKeyId);
    return { ...unsigned, signature: await signCommandAck(this.backend, keyring, unsigned) };
  }

  private async postRelayAck(commandId: string, ackCiphertext: string, ackDigest: string): Promise<void> {
    const { client, session } = await this.enrolledClient();
    const res = await client.requestEnrolled(
      { accountId: session.accountId, deviceId: session.hostDeviceId, sessionToken: session.sessionToken },
      this.opts.signer,
      { method: 'POST', path: `/api/shadow/commands/${encodeURIComponent(commandId)}/ack`, body: { scopeId: this.fence.scopeId, ackCiphertext, ackDigest } },
    );
    // A 409 means the relay already stored this ACK (idempotent recovery); 410 means expired — both terminal, no retry.
    if (!res.ok && res.status !== 409 && res.status !== 410) throw Object.assign(new Error(res.error ?? 'ack failed'), { statusCode: res.status });
  }

  private release(commandId: string, claimToken: string): void {
    try { this.opts.host.releaseCommandLease({ scopeId: this.fence.scopeId, commandId, ownerId: this.ownerId, claimToken, now: this.now(), nextAttemptAt: this.now() + RECLAIM_DELAY_MS }); }
    catch { /* best-effort */ }
  }

  private async crashAt(point: HostCommandCrashPoint): Promise<void> {
    if (this.crashPoint === point) throw new Error(`crash-${point}`);
  }

  private async keyringFor(keyId: string): Promise<ScopeKeyring> {
    let kr = this.keyrings.get(keyId);
    if (!kr) {
      const key = this.opts.keys.keyFor(keyId);
      if (!key) throw new Error(`missing scope key for ${keyId}`);
      kr = await deriveScopeKeyring(this.backend, new Uint8Array(key), { accountId: this.fence.accountId, scopeId: this.fence.scopeId, keyId });
      this.keyrings.set(keyId, kr);
    }
    return kr;
  }

  private async enrolledClient(): Promise<{ client: ShadowRequestClient; session: HostSessionContext }> {
    const session = await this.opts.session();
    const client = new ShadowRequestClient({
      baseUrl: session.relayOrigin,
      fetch: this.opts.transport.fetch,
      backend: this.backend,
      now: this.now,
      randomNonce: this.opts.transport.randomNonce,
      allowInsecureLoopback: this.opts.transport.allowInsecureLoopback,
      timeoutMs: this.opts.transport.timeoutMs,
      maxResponseBytes: this.opts.transport.maxResponseBytes,
    });
    return { client, session };
  }

  close(): void {
    this.state = 'closed';
    for (const kr of this.keyrings.values()) kr.dispose();
    this.keyrings.clear();
    this.intake.close();
    this.opts.host.close();
  }
}
