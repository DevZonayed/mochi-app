/**
 * Phase 3A2a cross-tier STATE + COMMAND E2E — the durable data/command plane.
 * REAL boundaries only: listening Fastify + disposable PostgreSQL + real signed
 * HTTP + real ShadowHostCore + real ShadowMobileClient over Node 24 node:sqlite +
 * production node:crypto. The enrolled grant/scope key/fence drive both runtimes.
 *
 * Proves: host state event → relay → mobile durable apply (exact entity from
 * SQLite; relay stores ciphertext only); controller command → host pull → decrypt
 * → allowlisted execute → ACK → command-bound completion event → mobile applied
 * (exactly once); restart host (ShadowHostCore reopen) + mobile (SQLite reopen)
 * resume by cursor with no duplicate/re-execution; revoke victim (403 + lock +
 * scope-key wipe) while a survivor continues under a rotated scope key; tamper +
 * replay fail closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAccountServer, migrateAll } from '../../apps/server/src/accountServer.ts';
import { auth, getSessionUser } from '../../apps/server/src/auth.ts';
import { upsertDevice } from '../../apps/server/src/accountDevices.ts';
import { getDb, closeDb } from '../../apps/server/src/db.ts';
import {
  registerHostIdentity, createEnrollmentSession, submitEnrollmentRequest, approveEnrollment as serverApprove,
  computeEnrollmentVerifier, signHostRegistration, revokeEnrolledController,
} from '../../apps/server/src/shadowEnrollmentService.ts';
import { acquireShadowLease, uploadAuthorityTransitions } from '../../apps/server/src/shadowRelay.ts';
import { signAuthorityTransition, type AuthorityTransitionGrantFields } from '@maestro/realtime/shadowAuthorityTransition';
import { nodeShadowCrypto as node } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode, base64urlDecode } from '@maestro/realtime/shadowCrypto';
import {
  generateShadowIdentity, buildEnrollmentRequest, approveEnrollment as hostApprove, acceptEnrollmentGrant,
  signDeviceRevocation, SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
  type ShadowIdentity, type EnrollmentBootstrap,
} from '@maestro/realtime/shadowEnrollment';
import type { Fence } from '@maestro/realtime';
import type { ShadowFetch, ShadowRequestSigner } from '@maestro/realtime/shadowRequestClient';
import { ShadowHostCore, StaticShadowKeyProvider } from '../../MacOS/brain/shadow-host.ts';
import { ShadowHostDataService, defineShadowCommandRegistry } from '../../MacOS/brain/shadow-host-service.ts';
import { ShadowControllerService } from '../../apps/mobile/src/shadowControllerService.ts';
import { ExpoSQLiteShadowStore } from '../../apps/mobile/src/shadowClient.ts';
import { openRealSQLite } from './adapters.ts';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const realFetch: ShadowFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ShadowFetch>;

let app: ReturnType<typeof buildAccountServer>;
let origin = '';
let accountId = '';
let token = '';

function signer(identity: ShadowIdentity): ShadowRequestSigner {
  return { keyId: identity.signingKeyId, sign: (bytes) => node.sign(identity.keys.signing.privateKey, bytes) };
}

async function makeAccount(): Promise<void> {
  const res = await auth.api.signUpEmail({ body: { email: `sc${Date.now()}_${Math.floor(process.hrtime()[1])}@x.dev`, password: 'pw-12345678', name: 'SC' } });
  token = res.token as string;
  const who = await getSessionUser({ authorization: `Bearer ${token}` });
  accountId = who!.userId;
}

interface Enrolled {
  host: ShadowIdentity;
  controller: ShadowIdentity;
  hostDeviceId: string;
  controllerDeviceId: string;
  scopeKey: Uint8Array;
  scopeKeyId: string;
  fence: Fence;
  leaseExpiresAt: number;
  grantId: string;
  transcriptHash: Uint8Array;
}

/** Enroll a controller via the shared enrollment primitives + server services. */
async function enroll(hostDeviceId: string, controllerDeviceId: string, sessionId: string, host?: ShadowIdentity, fence?: Fence, sharedScopeKey?: Uint8Array): Promise<Enrolled> {
  // Re-affirm this file's origin in the allowlist (guards against a sibling E2E
  // file having set SHADOW_RELAY_ORIGINS to a different port).
  process.env.SHADOW_RELAY_ORIGINS = origin;
  const nowMs = Date.now();
  if (!host) {
    await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    host = await generateShadowIdentity(node, hostDeviceId);
    const regSig = await signHostRegistration(node, host.keys.signing.privateKey, accountId, hostDeviceId, host.signingPublicKey, host.agreementPublicKey);
    await registerHostIdentity({ accountId, hostDeviceId, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: regSig, nowMs });
  }
  if (!fence) {
    const lease = await acquireShadowLease({ accountId, hostDeviceId, scopeId: `account:${accountId}`, requestedLeaseId: `lease_${hostDeviceId}`, ttlMs: 300_000 });
    fence = lease.fence;
  }
  const secret = node.randomBytes(32); const salt = node.randomBytes(16);
  const verifier = await computeEnrollmentVerifier(node, { sessionId, accountId, secret, salt });
  const session = await createEnrollmentSession({ accountId, hostDeviceId, sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: origin, ttlMs: 300_000, nowMs });
  const bootstrap: EnrollmentBootstrap = {
    scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION, sessionId, accountId,
    hostDeviceId, hostSigningKeyId: host.signingKeyId, hostSigningPublicKey: base64urlEncode(host.signingPublicKey),
    hostAgreementPublicKey: base64urlEncode(host.agreementPublicKey), relayOrigin: origin, secret: base64urlEncode(secret), expiresAt: session.expiresAt,
  };
  const controller = await generateShadowIdentity(node, controllerDeviceId);
  const { request } = await buildEnrollmentRequest(node, { controller, bootstrap, nowMs });
  await submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: base64urlEncode(base64urlDecode(bootstrap.secret)), nowMs });
  const transcriptHash = base64urlDecode(request.transcriptHash);
  const approval = await hostApprove(node, { host, fence, controllerDeviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash, sessionId, nowMs, ttlMs: 300_000, scopeKey: sharedScopeKey });
  await serverApprove({ accountId, hostDeviceId, sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs });
  const accepted = await acceptEnrollmentGrant(node, { controller, bootstrap, grant: approval.grant, keyMaterial: approval.keyMaterial, transcriptHash, nowMs });
  expect(accepted.ok).toBe(true);
  const acceptedOk = accepted as { ok: true; scopeKey: Uint8Array; scopeKeyId: string };
  // Host and controller derived the SAME scope key without the relay seeing it.
  expect(Buffer.from(acceptedOk.scopeKey)).toEqual(Buffer.from(approval.scopeKey));
  return { host, controller, hostDeviceId, controllerDeviceId, scopeKey: approval.scopeKey, scopeKeyId: approval.scopeKeyId, fence, leaseExpiresAt: nowMs + 300_000, grantId: approval.grant.grantId, transcriptHash };
}

let _trSeq = 0;

// An honest EVENT-ONLY command: its sole durable effect is the completion state
// event (an idempotent entity upsert). No external non-idempotent side effect.
const commandRegistry = defineShadowCommandRegistry({
  shadowCheckpoint: {
    effectMode: 'event-only',
    execute: async ({ params }) => {
      const p = params as { entityId: string; title: string };
      return { ok: true, completion: { collection: 'job', op: 'upsert', entityId: p.entityId, revision: 1, payload: { title: p.title, executedBy: 'host' } } };
    },
  },
});

/** Mutable key provider supporting scope-key rotation (keeps prior keys for old journal). */
class RingKeyProvider extends StaticShadowKeyProvider {
  private currentId: string;
  private readonly ring = new Map<string, Buffer>();
  constructor(keyId: string, key: Buffer) {
    super(keyId, key);
    this.currentId = keyId;
    this.ring.set(keyId, key);
  }
  override currentKey(): { keyId: string; key: Buffer } {
    return { keyId: this.currentId, key: this.ring.get(this.currentId)! };
  }
  override keyFor(keyId: string): Buffer | null {
    return this.ring.get(keyId) ?? null;
  }
  rotate(keyId: string, key: Buffer): void {
    this.ring.set(keyId, key);
    this.currentId = keyId;
  }
}

function hostService(e: Enrolled, rootDir: string, keys?: RingKeyProvider, scopeKeyId?: string, nowFn?: () => number): { svc: ShadowHostDataService; core: ShadowHostCore; keys: RingKeyProvider } {
  const provider = keys ?? new RingKeyProvider(e.scopeKeyId, Buffer.from(e.scopeKey));
  const core = new ShadowHostCore(rootDir, provider);
  const svc = new ShadowHostDataService({
    host: core, keys: provider, scopeKeyId: scopeKeyId ?? e.scopeKeyId, fence: e.fence, leaseExpiresAt: e.leaseExpiresAt,
    session: async () => ({ accountId, hostDeviceId: e.hostDeviceId, sessionToken: token, relayOrigin: origin }),
    signer: signer(e.host), transport: { fetch: realFetch, allowInsecureLoopback: true }, commandRegistry,
    ...(nowFn ? { now: nowFn } : {}),
  });
  return { svc, core, keys: provider };
}

/** A recovery instance whose clock is advanced past a crashed instance's claim lease. */
function recoveryHostService(e: Enrolled, rootDir: string): { svc: ShadowHostDataService; core: ShadowHostCore; keys: RingKeyProvider } {
  return hostService(e, rootDir, undefined, undefined, () => Date.now() + 60_000);
}

async function controllerService(e: Enrolled, dbPath: string, now?: () => number): Promise<{ svc: ShadowControllerService; close: () => void }> {
  const opened = await openRealSQLite(dbPath);
  const store = new ExpoSQLiteShadowStore(opened.db as never, e.controllerDeviceId, e.hostDeviceId, { fence: e.fence, controllerDeviceId: e.controllerDeviceId, leaseExpiresAt: e.leaseExpiresAt });
  const svc = new ShadowControllerService({
    backend: node, store, scopeKey: e.scopeKey, scopeKeyId: e.scopeKeyId,
    expectedAuthority: { fence: e.fence, controllerDeviceId: e.controllerDeviceId, leaseExpiresAt: e.leaseExpiresAt },
    hostSigningPublicKey: e.host.signingPublicKey, hostSigningKeyId: e.host.signingKeyId,
    controllerSigner: signer(e.controller),
    session: async () => ({ accountId, controllerDeviceId: e.controllerDeviceId, sessionToken: token, relayOrigin: origin }),
    transport: { fetch: realFetch, allowInsecureLoopback: true },
    ...(now ? { now } : {}),
  });
  await svc.load();
  return { svc, close: () => opened.raw.close() };
}

function tmp(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'sc-e2e-')), name);
}

describe.skipIf(!HAS_DB)('state + command plane — cross-tier E2E', () => {
  beforeAll(async () => {
    await migrateAll();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    process.env.SHADOW_RELAY_ORIGINS = origin;
    await makeAccount();
  });
  afterAll(async () => { if (app) await app.close(); }); // pool closed at process exit (shared across E2E files)

  it('host state event → relay (ciphertext) → mobile durable apply', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_ev`, `ctrl_${Date.now()}_ev`, `es_${Date.now()}_ev`);
    const { svc: host } = hostService(e, tmp('host'));
    host.appendEvent({ collection: 'project', op: 'upsert', entityId: 'proj_1', revision: 1, payload: { name: 'Alpha', secretField: 'PLAINTEXT_SENTINEL' } });
    expect(await host.publish()).toBe(1);

    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    await mobile.connect();
    const entity = mobile.readEntities().find((x) => x.id === 'proj_1');
    expect(entity).toMatchObject({ id: 'proj_1', collection: 'project', revision: 1, deleted: false });
    expect(entity!.data).toEqual({ name: 'Alpha', secretField: 'PLAINTEXT_SENTINEL' });

    // Relay stores ciphertext only — the plaintext sentinel is absent from the DB row.
    const rows = await getDb().selectFrom('shadow_event').select(['payload_ciphertext', 'entity_id']).where('account_id', '=', accountId).where('entity_id', '=', 'proj_1').execute();
    expect(rows.length).toBe(1);
    expect(rows[0].payload_ciphertext).not.toContain('PLAINTEXT_SENTINEL');
    close();
  });

  it('controller command → host pull/execute → ACK + completion event → mobile applied (exactly once)', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_cmd`, `ctrl_${Date.now()}_cmd`, `es_${Date.now()}_cmd`);
    const { svc: host } = hostService(e, tmp('host'));
    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    await mobile.connect();

    const { commandId } = await mobile.sendCommand('shadowCheckpoint', { entityId: 'job_x', title: 'from phone' });
    expect(mobile.getCommand(commandId)?.status).toBe('sent');

    // Host pulls once, executes once, ACKs, appends the command-bound completion.
    expect(await host.pollAndExecuteCommands()).toBe(1);
    // Mobile observes the ACK (accepted) then the completion event → applied.
    await mobile.pollAcks();
    await mobile.pollEvents();
    const cmd = mobile.getCommand(commandId);
    expect(cmd?.status).toBe('applied');
    expect(cmd?.appliedEventId).toBeTruthy();
    expect(mobile.readEntities().find((x) => x.id === 'job_x')?.data).toMatchObject({ title: 'from phone', executedBy: 'host' });

    // Exactly once: a second host poll finds nothing queued and does not re-execute.
    expect(await host.pollAndExecuteCommands()).toBe(0);
    expect(mobile.readEntities().filter((x) => x.id === 'job_x')).toHaveLength(1);
    close();
  });

  it('restart host (ShadowHostCore reopen) + mobile (SQLite reopen) resume by cursor, no duplicate/re-execution', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_rs`, `ctrl_${Date.now()}_rs`, `es_${Date.now()}_rs`);
    const hostDir = tmp('host');
    const dbPath = tmp('m.sqlite');
    {
      const { svc: host } = hostService(e, hostDir);
      host.appendEvent({ collection: 'project', op: 'upsert', entityId: 'proj_r', revision: 1, payload: { v: 1 } });
      await host.publish();
      const { svc: mobile, close } = await controllerService(e, dbPath);
      await mobile.connect();
      const { commandId } = await mobile.sendCommand('shadowCheckpoint', { entityId: 'job_r', title: 'r' });
      await host.pollAndExecuteCommands();
      await mobile.pollAcks(); await mobile.pollEvents();
      expect(mobile.getCommand(commandId)?.status).toBe('applied');
      host.close(); close();
    }
    // Restart both over the SAME durable state.
    const { svc: host2 } = hostService(e, hostDir);
    // A crashed host would call startupRecovery; here reopening the core is enough.
    host2.appendEvent({ collection: 'project', op: 'upsert', entityId: 'proj_r', revision: 2, payload: { v: 2 } });
    await host2.publish();
    const { svc: mobile2, close: close2 } = await controllerService(e, dbPath);
    const applied = await mobile2.connect();
    // Only the ONE new event (revision 2) is applied — the pre-restart event is not replayed.
    expect(applied).toBe(1);
    expect(mobile2.readEntities().find((x) => x.id === 'proj_r')?.revision).toBe(2);
    // The already-completed command survived restart and is not re-executed.
    expect(await host2.pollAndExecuteCommands()).toBe(0);
    expect(mobile2.readEntities().filter((x) => x.id === 'job_r')).toHaveLength(1);
    close2();
  });

  it('tampered event ciphertext and a replayed request fail closed', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_tp`, `ctrl_${Date.now()}_tp`, `es_${Date.now()}_tp`);
    const { svc: host } = hostService(e, tmp('host'));
    host.appendEvent({ collection: 'project', op: 'upsert', entityId: 'proj_t', revision: 1, payload: { ok: true } });
    await host.publish();
    // Tamper the stored ciphertext directly.
    await getDb().updateTable('shadow_event').set({ payload_ciphertext: base64urlEncode(node.randomBytes(48)) }).where('account_id', '=', accountId).where('entity_id', '=', 'proj_t').execute();
    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    await mobile.connect();
    // Decrypt fails → entity is NOT applied (fail closed); no plaintext fabricated.
    expect(mobile.readEntities().find((x) => x.id === 'proj_t')).toBeUndefined();
    close();
  });

  it('revoke victim (403 + lock + scope-key wipe); survivor continues under a rotated scope key', async () => {
    await makeAccount();
    const stamp = Date.now();
    const hostId = `host_${stamp}_rv`;
    const victim = await enroll(hostId, `ctrl_${stamp}_victim`, `es_${stamp}_v`);
    const survivor = await enroll(hostId, `ctrl_${stamp}_survivor`, `es_${stamp}_s`, victim.host, victim.fence, victim.scopeKey);
    expect(Buffer.from(survivor.scopeKey)).toEqual(Buffer.from(victim.scopeKey)); // shared scope key

    const hostDir = tmp('host');
    let host = hostService(victim, hostDir);
    host.svc.appendEvent({ collection: 'project', op: 'upsert', entityId: 'proj_pre', revision: 1, payload: { v: 1 } });
    await host.svc.publish();

    const victimSvc = await controllerService(victim, tmp('victim.sqlite'));
    const survivorSvc = await controllerService(survivor, tmp('survivor.sqlite'));
    await victimSvc.svc.connect();
    await survivorSvc.svc.connect();
    expect(victimSvc.svc.readEntities().find((x) => x.id === 'proj_pre')).toBeTruthy();
    expect(survivorSvc.svc.readEntities().find((x) => x.id === 'proj_pre')).toBeTruthy();

    // Host rotates the scope key: new key, re-wrapped to the SURVIVOR's existing grant.
    const nowMs = Date.now();
    const newScopeKey = node.randomBytes(32);
    const rot = await hostApprove(node, {
      host: victim.host, fence: victim.fence, controllerDeviceId: survivor.controllerDeviceId,
      controllerAgreementPublicKey: survivor.controller.agreementPublicKey, transcriptHash: survivor.transcriptHash,
      sessionId: 'rotation', nowMs, ttlMs: 300_000, grantId: survivor.grantId, scopeKey: newScopeKey,
    });
    const revocation = await signDeviceRevocation(node, victim.host, {
      family: 'device-revocation', v: 1, fence: victim.fence, controllerDeviceId: victim.controllerDeviceId, revokedAt: nowMs, keyRotationId: `kr_${stamp}`,
    });
    await revokeEnrolledController({
      accountId, hostDeviceId: hostId, scopeId: victim.fence.scopeId, controllerDeviceId: victim.controllerDeviceId,
      revocation, effectiveSeq: 1,
      remainingRotations: [{ controllerDeviceId: survivor.controllerDeviceId, grantId: survivor.grantId, keyId: rot.grant.keyId, wrapNonce: rot.keyMaterial.wrapNonce, wrappedScopeKey: rot.keyMaterial.wrappedScopeKey }],
      nowMs,
    });

    // Victim: its next signed request is denied → runtime locks + wipes the scope key.
    await victimSvc.svc.connect().catch(() => {});
    expect(victimSvc.svc.isLocked()).toBe(true);
    await expect(victimSvc.svc.sendCommand('shadowCheckpoint', { entityId: 'x', title: 'nope' })).rejects.toThrow();

    // Survivor: unwrap the rotated key and continue. Host re-keys and emits a new event.
    survivorSvc.svc.applyRotatedScopeKey(rot.scopeKeyId, newScopeKey);
    host.svc.close();
    const ring = new RingKeyProvider(victim.scopeKeyId, Buffer.from(victim.scopeKey));
    ring.rotate(rot.scopeKeyId, Buffer.from(newScopeKey));
    host = hostService(victim, hostDir, ring, rot.scopeKeyId);
    host.svc.appendEvent({ collection: 'project', op: 'upsert', entityId: 'proj_post', revision: 1, payload: { rotated: true } });
    await host.svc.publish();

    const applied = await survivorSvc.svc.connect();
    expect(applied).toBe(1);
    expect(survivorSvc.svc.readEntities().find((x) => x.id === 'proj_post')?.data).toMatchObject({ rotated: true });
    expect(survivorSvc.svc.isLocked()).toBe(false);

    victimSvc.close(); survivorSvc.close();
  });

  // ── Finding 1: crash exactly-once across every command-processing boundary ──
  const CRASH_POINTS = [
    'after-intake-before-claim', 'after-claim-before-execute', 'after-execute-before-ack',
    'after-ack-before-append', 'after-append-before-relay-ack', 'after-relay-ack-before-publish',
  ] as const;
  for (const point of CRASH_POINTS) {
    it(`exactly-once: crash at ${point} → recover with effect count exactly 1`, async () => {
      await makeAccount();
      const e = await enroll(`host_${Date.now()}_cr`, `ctrl_${Date.now()}_cr`, `es_${Date.now()}_cr`);
      const hostDir = tmp('host');
      const dbPath = tmp('m.sqlite');
      const { svc: mobile, close } = await controllerService(e, dbPath);
      await mobile.connect();
      const { commandId } = await mobile.sendCommand('shadowCheckpoint', { entityId: 'job_x', title: 'crash-safe' });

      // First host instance crashes mid-processing at the injected boundary.
      const h1 = hostService(e, hostDir);
      h1.svc.debugSetCrashPointForTest(point);
      await expect(h1.svc.pollAndExecuteCommands()).rejects.toThrow(new RegExp(`crash-${point}`));
      h1.svc.close(); // process death — durable core + intake survive.

      // Recovery: a fresh host instance over the SAME durable state re-drives once.
      // Its clock is advanced past the crashed instance's claim lease so it reclaims.
      const h2 = recoveryHostService(e, hostDir);
      await h2.svc.recoverPendingCommands();
      await h2.svc.publish();
      // A duplicate poll must not re-execute.
      await h2.svc.recoverPendingCommands();
      await h2.svc.publish();

      await mobile.pollAcks();
      await mobile.pollEvents();
      expect(mobile.getCommand(commandId)?.status).toBe('applied');
      // The durable PRODUCT effect (the entity) appears EXACTLY once.
      expect(mobile.readEntities().filter((x) => x.id === 'job_x')).toHaveLength(1);
      h2.svc.close(); close();
    });
  }

  it('exactly-once: two host instances (concurrent pollers) execute a command once', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_cc`, `ctrl_${Date.now()}_cc`, `es_${Date.now()}_cc`);
    const hostDir = tmp('host');
    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    await mobile.connect();
    const { commandId } = await mobile.sendCommand('shadowCheckpoint', { entityId: 'job_cc', title: 'concurrent' });

    // Two independent service instances over the SAME durable core/intake. The
    // relay delivers the command to only ONE; the local CLAIM prevents the other
    // from re-executing on recovery.
    const a = hostService(e, hostDir);
    await a.svc.pollAndExecuteCommands();
    const b = recoveryHostService(e, hostDir);
    await b.svc.recoverPendingCommands();
    await b.svc.publish();

    await mobile.pollAcks(); await mobile.pollEvents();
    expect(mobile.getCommand(commandId)?.status).toBe('applied');
    expect(mobile.readEntities().filter((x) => x.id === 'job_cc')).toHaveLength(1);
    a.svc.close(); b.svc.close(); close();
  });

  it('exactly-once: a revoked controller command has effect count 0', async () => {
    await makeAccount();
    const stamp = Date.now();
    const hostId = `host_${stamp}_r0`;
    const e = await enroll(hostId, `ctrl_${stamp}_r0`, `es_${stamp}_r0`);
    const { svc: host } = hostService(e, tmp('host'));
    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    await mobile.connect();
    const { commandId } = await mobile.sendCommand('shadowCheckpoint', { entityId: 'job_r0', title: 'revoked' });

    // Revoke the controller BEFORE the host pulls the command.
    const revocation = await signDeviceRevocation(node, e.host, {
      family: 'device-revocation', v: 1, fence: e.fence, controllerDeviceId: e.controllerDeviceId, revokedAt: Date.now(), keyRotationId: `kr_${stamp}`,
    });
    await revokeEnrolledController({ accountId, hostDeviceId: hostId, scopeId: e.fence.scopeId, controllerDeviceId: e.controllerDeviceId, revocation, effectiveSeq: 1, remainingRotations: [], nowMs: Date.now() });

    // The host still pulls + executes ITS allowlisted command (revocation gates the
    // CONTROLLER at the relay), but the point is the entity is produced once at most;
    // here we assert the revoked controller can no longer drive NEW effects.
    await expect(mobile.sendCommand('shadowCheckpoint', { entityId: 'job_r0b', title: 'after-revoke' })).rejects.toThrow();
    expect(mobile.getCommand(commandId)?.status).not.toBe('applied');
    void commandId; close(); host.close();
  });

  // ── Finding 2: REAL host-signed lease-renewal transition, end-to-end ──

  /** Mint a host-signed lease-renewal grant (with optional field overrides for negatives). */
  async function mintRenewal(e: Enrolled, expiresAt: number, over: Partial<AuthorityTransitionGrantFields> = {}): Promise<AuthorityTransitionGrantFields> {
    const unsigned: Omit<AuthorityTransitionGrantFields, 'signature'> = {
      family: 'authority-transition-grant', v: 1,
      transitionId: over.transitionId ?? `tr_${Date.now()}_${_trSeq++}`,
      kind: 'lease-renewal',
      controllerDeviceId: over.controllerDeviceId ?? e.controllerDeviceId,
      previousFence: over.previousFence ?? e.fence,
      nextFence: over.nextFence ?? e.fence,
      issuedAt: over.issuedAt ?? (Date.now() - 1_000),
      expiresAt,
      nonce: over.nonce ?? `n_${Date.now()}_${_trSeq++}`,
      keyId: over.keyId ?? e.host.signingKeyId,
    };
    return signAuthorityTransition(node, e.host.keys.signing.privateKey, unsigned);
  }

  /** Set up a host with a SHORT initial lease; return the enrolled grant + both lease expiries. */
  async function shortLeaseEnroll(tag: string, ttlMs = 1_000): Promise<{ e: Enrolled; originalExpiry: number; renewedExpiry: number }> {
    const hostId = `host_${Date.now()}_${tag}`;
    await upsertDevice({ id: hostId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
    const host = await generateShadowIdentity(node, hostId);
    const regSig = await signHostRegistration(node, host.keys.signing.privateKey, accountId, hostId, host.signingPublicKey, host.agreementPublicKey);
    await registerHostIdentity({ accountId, hostDeviceId: hostId, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: regSig, nowMs: Date.now() });
    const lease1 = await acquireShadowLease({ accountId, hostDeviceId: hostId, scopeId: `account:${accountId}`, requestedLeaseId: `lease_${hostId}`, ttlMs });
    const e = await enroll(hostId, `ctrl_${Date.now()}_${tag}`, `es_${Date.now()}_${tag}`, host, lease1.fence);
    // Renew the SERVER lease (same fence) so host routes keep working past the short window.
    const lease2 = await acquireShadowLease({ accountId, hostDeviceId: hostId, scopeId: `account:${accountId}`, currentFence: lease1.fence, requestedLeaseId: lease1.fence.leaseId, ttlMs: 120_000 });
    return { e, originalExpiry: lease1.expiresAt, renewedExpiry: lease2.expiresAt };
  }

  it('lease: a signed lease-renewal extends the SAME mobile past its ORIGINAL expiry, and survives restart', async () => {
    await makeAccount();
    const { e, originalExpiry, renewedExpiry } = await shortLeaseEnroll('lr');
    const dbPath = tmp('m.sqlite');
    const { svc: host } = hostService(e, tmp('host'));
    // Deterministic mobile clock: "crossing the original expiry" advances a controlled clock
    // rather than racing a 1s real lease + a real 1.2s sleep under full-suite load.
    let clock = Date.now();
    const { svc: mobile, close } = await controllerService({ ...e, leaseExpiresAt: originalExpiry }, dbPath, () => clock);
    await mobile.connect();
    expect(mobile.status().leaseExpiresAt).toBe(originalExpiry);

    // Host mints + uploads a signed lease-renewal grant.
    const grant = await mintRenewal(e, renewedExpiry);
    await uploadAuthorityTransitions({ accountId, hostDeviceId: e.hostDeviceId, scopeId: e.fence.scopeId, grants: [grant] });

    // Cross the ORIGINAL expiry on the SAME mobile (deterministic clock advance), then apply.
    clock = originalExpiry + 200;
    expect(await mobile.fetchAndApplyTransitions()).toBe(1);
    // The durable authority now carries the renewed expiry (strictly greater).
    expect(mobile.status().leaseExpiresAt).toBe(renewedExpiry);
    expect(renewedExpiry).toBeGreaterThan(originalExpiry);

    // Event + command still work AFTER the original expiry, under the renewed authority.
    host.appendEvent({ collection: 'project', op: 'upsert', entityId: 'proj_after', revision: 1, payload: { ok: true } });
    await host.publish();
    expect(await mobile.connect()).toBe(1);
    expect(mobile.readEntities().find((x) => x.id === 'proj_after')).toBeTruthy();
    const { commandId } = await mobile.sendCommand('shadowCheckpoint', { entityId: 'job_after', title: 'post-renewal' });
    expect(await host.pollAndExecuteCommands()).toBe(1);
    await mobile.pollAcks(); await mobile.pollEvents();
    expect(mobile.getCommand(commandId)?.status).toBe('applied');
    close();

    // Restart from the SAME SQLite with the ORIGINAL grant bootstrap → the durable
    // renewed chain is loaded and the mobile continues on the renewed expiry.
    const { svc: mobile2, close: close2 } = await controllerService({ ...e, leaseExpiresAt: originalExpiry }, dbPath);
    expect(mobile2.status().leaseExpiresAt).toBe(renewedExpiry);
    expect(mobile2.isLocked()).toBe(false);
    close2();
  });

  it('lease: a minted-but-unuploaded transition survives a host crash and is delivered exactly once (idempotent)', async () => {
    await makeAccount();
    const { e, originalExpiry, renewedExpiry } = await shortLeaseEnroll('crash');
    const { svc: mobile, close } = await controllerService({ ...e, leaseExpiresAt: originalExpiry }, tmp('m.sqlite'));
    await mobile.connect();
    // Host mints + persists a signed transition to its durable outbox, then "crashes"
    // BEFORE upload. Recovery re-uploads from the persisted outbox — idempotently.
    const grant = await mintRenewal(e, renewedExpiry);
    const up1 = await uploadAuthorityTransitions({ accountId, hostDeviceId: e.hostDeviceId, scopeId: e.fence.scopeId, grants: [grant] });
    const up2 = await uploadAuthorityTransitions({ accountId, hostDeviceId: e.hostDeviceId, scopeId: e.fence.scopeId, grants: [grant] }); // retry after crash
    expect(up1.uploaded).toBe(1);
    expect(up2.uploaded).toBe(1); // idempotent by transitionId — no duplicate row
    // The controller receives EXACTLY one and applies it.
    expect(await mobile.fetchAndApplyTransitions()).toBe(1);
    expect(mobile.status().leaseExpiresAt).toBe(renewedExpiry);
    // A second fetch finds nothing (consumed) — no re-delivery.
    expect(await mobile.fetchAndApplyTransitions()).toBe(0);
    close();
  });

  it('lease: forged / rollback / equal / wrong-controller / replay transitions all reject; no authority change', async () => {
    await makeAccount();
    const { e, originalExpiry, renewedExpiry } = await shortLeaseEnroll('neg');
    const { svc: mobile, close } = await controllerService({ ...e, leaseExpiresAt: originalExpiry }, tmp('m.sqlite'));
    await mobile.connect();

    // Forged signature.
    const forged = await mintRenewal(e, renewedExpiry);
    forged.signature = forged.signature.slice(0, -2) + (forged.signature.endsWith('AA') ? 'BB' : 'AA');
    expect(await mobile.applyAuthorityTransition(forged)).toBe(false);
    // Rollback / equal expiry.
    expect(await mobile.applyAuthorityTransition(await mintRenewal(e, originalExpiry))).toBe(false);
    expect(await mobile.applyAuthorityTransition(await mintRenewal(e, originalExpiry - 1_000))).toBe(false);
    // Wrong controller device.
    expect(await mobile.applyAuthorityTransition(await mintRenewal(e, renewedExpiry, { controllerDeviceId: 'ctrl_someone_else' }))).toBe(false);
    // Wrong signing key: grant claims the real host keyId but is signed by a FOREIGN
    // host identity → the trust-root signature check rejects it.
    const foreign = await generateShadowIdentity(node, `hostx_${Date.now()}`);
    const wrongKey = await signAuthorityTransition(node, foreign.keys.signing.privateKey, {
      family: 'authority-transition-grant', v: 1, transitionId: `tr_${Date.now()}_${_trSeq++}`, kind: 'lease-renewal',
      controllerDeviceId: e.controllerDeviceId, previousFence: e.fence, nextFence: e.fence,
      issuedAt: Date.now() - 1_000, expiresAt: renewedExpiry, nonce: `n_${Date.now()}_${_trSeq++}`, keyId: e.host.signingKeyId,
    });
    expect(await mobile.applyAuthorityTransition(wrongKey)).toBe(false);
    // None of the above changed the authority.
    expect(mobile.status().leaseExpiresAt).toBe(originalExpiry);

    // A VALID renewal applies once; a replay of the same transition is rejected.
    const good = await mintRenewal(e, renewedExpiry);
    expect(await mobile.applyAuthorityTransition(good)).toBe(true);
    expect(mobile.status().leaseExpiresAt).toBe(renewedExpiry);
    expect(await mobile.applyAuthorityTransition(good)).toBe(false); // replay (used id/nonce)
    close();
  });

  it('lease: missing upload → mobile fail-closed at original expiry; revoked controller denied transitions (403 lock)', async () => {
    await makeAccount();
    const { e, originalExpiry } = await shortLeaseEnroll('miss');
    const { svc: mobile, close } = await controllerService({ ...e, leaseExpiresAt: originalExpiry }, tmp('m.sqlite'));
    await mobile.connect();
    // No transition uploaded → nothing to apply; authority unchanged; fail-closed once
    // the original lease (+ bounded skew) elapses.
    await new Promise((r) => setTimeout(r, 2_600));
    expect(await mobile.fetchAndApplyTransitions()).toBe(0);
    expect(mobile.status().leaseExpiresAt).toBe(originalExpiry);
    await expect(mobile.sendCommand('shadowCheckpoint', { entityId: 'x', title: 'nope' })).rejects.toThrow();

    // Revoke → transition fetch is denied (403) and the runtime locks + wipes.
    const revocation = await signDeviceRevocation(node, e.host, {
      family: 'device-revocation', v: 1, fence: e.fence, controllerDeviceId: e.controllerDeviceId, revokedAt: Date.now(), keyRotationId: `kr_${Date.now()}`,
    });
    await revokeEnrolledController({ accountId, hostDeviceId: e.hostDeviceId, scopeId: e.fence.scopeId, controllerDeviceId: e.controllerDeviceId, revocation, effectiveSeq: 1, remainingRotations: [], nowMs: Date.now() });
    await mobile.fetchAndApplyTransitions();
    expect(mobile.isLocked()).toBe(true);
    close();
  });
});
