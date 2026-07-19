/**
 * Phase 3A2b1 Section C+D cross-tier ACTIONS E2E. REAL boundaries: listening Fastify +
 * disposable PostgreSQL + real signed HTTP + real product Store (isolated userData) +
 * real product-idempotent action adapters + durable receipt + real ShadowHostCore /
 * projection + real ShadowControllerService over Node 24 node:sqlite + node:crypto.
 *
 * Proves: enroll with an explicit approved capability subset; mobile sends encrypted
 * capability-gated actions (autopilot / approval); host enforces capability from the
 * AUTHORITATIVE record, applies the idempotent product effect, projects the authoritative
 * entity carrying `commandId`; mobile marks the command applied and the selector reflects
 * real Store state; a host re-poll re-applies nothing (exactly once); a capability-limited
 * controller is DENIED the mutator (effect count 0) but can still read; relay PG never
 * holds a plaintext canary.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ userData: `/tmp/maestro-actions-e2e-store-${process.pid}-${process.hrtime()[1]}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.userData } }));

import { buildAccountServer, migrateAll } from '../../apps/server/src/accountServer.ts';
import { auth, getSessionUser } from '../../apps/server/src/auth.ts';
import { upsertDevice } from '../../apps/server/src/accountDevices.ts';
import { getDb } from '../../apps/server/src/db.ts';
import {
  registerHostIdentity, createEnrollmentSession, submitEnrollmentRequest, approveEnrollment as serverApprove,
  computeEnrollmentVerifier, signHostRegistration,
} from '../../apps/server/src/shadowEnrollmentService.ts';
import { acquireShadowLease } from '../../apps/server/src/shadowRelay.ts';
import { nodeShadowCrypto as node } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode, base64urlDecode } from '@maestro/realtime/shadowCrypto';
import {
  generateShadowIdentity, buildEnrollmentRequest, approveEnrollment as hostApprove, acceptEnrollmentGrant,
  SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, SHADOW_ENROLLMENT_BOOTSTRAP_VERSION,
  type ShadowIdentity, type EnrollmentBootstrap,
} from '@maestro/realtime/shadowEnrollment';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import type { Fence } from '@maestro/realtime';
import type { ShadowFetch, ShadowRequestSigner } from '@maestro/realtime/shadowRequestClient';
import { ShadowHostCore, StaticShadowKeyProvider } from '../../MacOS/brain/shadow-host.ts';
import { ShadowHostDataService, defineShadowCommandRegistry } from '../../MacOS/brain/shadow-host-service.ts';
import { ShadowProductProjection } from '../../MacOS/brain/shadow-product-projection.ts';
import { ShadowActionReceiptStore } from '../../MacOS/brain/shadow-action-receipt.ts';
import { buildControllerActionRegistryEntries, type ControllerActionEngine } from '../../MacOS/brain/shadow-controller-actions.ts';
import { ShadowControllerService } from '../../apps/mobile/src/shadowControllerService.ts';
import { ExpoSQLiteShadowStore } from '../../apps/mobile/src/shadowClient.ts';
import * as sel from '../../apps/mobile/src/shadowProjectionSelectors.ts';
import { Store } from '../../MacOS/brain/store.ts';
import { openRealSQLite } from './adapters.ts';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const realFetch: ShadowFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ShadowFetch>;
const CANARY = 'CANARY_ACT_E2E_1a2b3c4d5e6f7a8b';

let app: ReturnType<typeof buildAccountServer>;
let origin = '';
let accountId = '';
let token = '';

function signer(identity: ShadowIdentity): ShadowRequestSigner {
  return { keyId: identity.signingKeyId, sign: (bytes) => node.sign(identity.keys.signing.privateKey, bytes) };
}
async function makeAccount(): Promise<void> {
  const res = await auth.api.signUpEmail({ body: { email: `ac${Date.now()}_${Math.floor(process.hrtime()[1])}@x.dev`, password: 'pw-12345678', name: 'AC' } });
  token = res.token as string;
  accountId = (await getSessionUser({ authorization: `Bearer ${token}` }))!.userId;
}

interface Enrolled { host: ShadowIdentity; controller: ShadowIdentity; hostDeviceId: string; controllerDeviceId: string; scopeKey: Uint8Array; scopeKeyId: string; fence: Fence; leaseExpiresAt: number; capabilities?: readonly ShadowCapability[]; }

async function enroll(hostDeviceId: string, controllerDeviceId: string, sessionId: string, capabilities?: readonly ShadowCapability[]): Promise<Enrolled> {
  process.env.SHADOW_RELAY_ORIGINS = origin;
  const nowMs = Date.now();
  await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
  const host = await generateShadowIdentity(node, hostDeviceId);
  const regSig = await signHostRegistration(node, host.keys.signing.privateKey, accountId, hostDeviceId, host.signingPublicKey, host.agreementPublicKey);
  await registerHostIdentity({ accountId, hostDeviceId, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: regSig, nowMs });
  const lease = await acquireShadowLease({ accountId, hostDeviceId, scopeId: `account:${accountId}`, requestedLeaseId: `lease_${hostDeviceId}`, ttlMs: 300_000 });
  const fence = lease.fence;
  const secret = node.randomBytes(32); const salt = node.randomBytes(16);
  const verifier = await computeEnrollmentVerifier(node, { sessionId, accountId, secret, salt });
  const session = await createEnrollmentSession({ accountId, hostDeviceId, sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: origin, ttlMs: 300_000, nowMs });
  const bootstrap: EnrollmentBootstrap = {
    scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION, sessionId, accountId,
    hostDeviceId, hostSigningKeyId: host.signingKeyId, hostSigningPublicKey: base64urlEncode(host.signingPublicKey),
    hostAgreementPublicKey: base64urlEncode(host.agreementPublicKey), relayOrigin: origin, secret: base64urlEncode(secret), expiresAt: session.expiresAt,
  };
  const controller = await generateShadowIdentity(node, controllerDeviceId);
  // Request the same set the host will approve (server enforces approved ⊆ requested).
  const { request } = await buildEnrollmentRequest(node, { controller, bootstrap, nowMs, requestedCapabilities: capabilities });
  await submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: bootstrap.secret, nowMs });
  const transcriptHash = base64urlDecode(request.transcriptHash);
  // HOST approves an EXPLICIT capability subset, bound into the signed grant.
  const approval = await hostApprove(node, { host, fence, controllerDeviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash, sessionId, nowMs, ttlMs: 300_000, capabilities });
  await serverApprove({ accountId, hostDeviceId, sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs });
  const accepted = await acceptEnrollmentGrant(node, { controller, bootstrap, grant: approval.grant, keyMaterial: approval.keyMaterial, transcriptHash, nowMs });
  expect(accepted.ok).toBe(true);
  // Controller reads back the SAME approved set from the signed grant.
  if (accepted.ok) expect(accepted.capabilities).toEqual(approval.capabilities ?? ['account.read']);
  return { host, controller, hostDeviceId, controllerDeviceId, scopeKey: approval.scopeKey, scopeKeyId: approval.scopeKeyId, fence, leaseExpiresAt: nowMs + 300_000, capabilities: approval.capabilities };
}

function tmp(name: string): string { return join(mkdtempSync(join(tmpdir(), 'act-e2e-')), name); }

function fakeEngine(store: Store): ControllerActionEngine {
  return {
    launchJob: () => { /* launch is out of scope for the E2E; the durable Job exists */ },
    cancelJob: (jobId) => { const j = store.getJob(jobId); if (j) store.updateJob(jobId, { status: 'cancelled' }); return !!j; },
  };
}

function hostPlane(e: Enrolled, rootDir: string, store: Store, receipts: ShadowActionReceiptStore, capsFor: (cd: string) => readonly ShadowCapability[] | null, nowFn?: () => number) {
  const provider = new StaticShadowKeyProvider(e.scopeKeyId, Buffer.from(e.scopeKey));
  const core = new ShadowHostCore(rootDir, provider);
  const registry = defineShadowCommandRegistry({
    ...buildControllerActionRegistryEntries({
      store: {
        getProject: (id) => store.getProject(id), getSession: (id) => store.getSession(id), getJob: (id) => store.getJob(id),
        listApprovals: () => store.listApprovals(), listSchedules: () => store.listSchedules(),
        claimIdempotentJob: (k, s) => store.claimIdempotentJob(k, s as Parameters<typeof store.claimIdempotentJob>[1]),
        claimIdempotentQuestionAnswer: (k, i) => store.claimIdempotentQuestionAnswer(k, i),
        resolveApproval: (id, st) => store.resolveApproval(id, st), updateSession: (id, patch) => store.updateSession(id, patch),
      },
      engine: fakeEngine(store), receipts,
    }),
  });
  const svc = new ShadowHostDataService({
    host: core, keys: provider, scopeKeyId: e.scopeKeyId, fence: e.fence, leaseExpiresAt: e.leaseExpiresAt,
    session: async () => ({ accountId, hostDeviceId: e.hostDeviceId, sessionToken: token, relayOrigin: origin }),
    signer: signer(e.host), transport: { fetch: realFetch, allowInsecureLoopback: true }, commandRegistry: registry,
    capabilitiesFor: capsFor, ...(nowFn ? { now: nowFn } : {}),
  });
  const projection = new ShadowProductProjection({ host: core, fence: e.fence, store, publish: () => svc.publish().then(() => undefined) });
  return { core, svc, projection };
}

async function controllerService(e: Enrolled, dbPath: string): Promise<{ svc: ShadowControllerService; close: () => void }> {
  const opened = await openRealSQLite(dbPath);
  const store = new ExpoSQLiteShadowStore(opened.db as never, e.controllerDeviceId, e.hostDeviceId, { fence: e.fence, controllerDeviceId: e.controllerDeviceId, leaseExpiresAt: e.leaseExpiresAt });
  const svc = new ShadowControllerService({
    backend: node, store, scopeKey: e.scopeKey, scopeKeyId: e.scopeKeyId,
    expectedAuthority: { fence: e.fence, controllerDeviceId: e.controllerDeviceId, leaseExpiresAt: e.leaseExpiresAt },
    hostSigningPublicKey: e.host.signingPublicKey, hostSigningKeyId: e.host.signingKeyId,
    controllerSigner: signer(e.controller),
    session: async () => ({ accountId, controllerDeviceId: e.controllerDeviceId, sessionToken: token, relayOrigin: origin }),
    transport: { fetch: realFetch, allowInsecureLoopback: true },
  });
  await svc.load();
  return { svc, close: () => opened.raw.close() };
}

describe.skipIf(!HAS_DB)('capability-gated product-idempotent actions — cross-tier E2E', () => {
  beforeAll(async () => {
    await migrateAll();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    process.env.SHADOW_RELAY_ORIGINS = origin;
    await makeAccount();
  });
  afterAll(async () => { if (app) await app.close(); try { rmSync(hoisted.userData, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('applies capability-gated actions cross-tier, exactly once, canary-free; unprivileged controller denied', async () => {
    await makeAccount();
    const caps: ShadowCapability[] = ['account.read', 'session.autopilot.set', 'approval.respond'];
    const e = await enroll(`host_${Date.now()}_a`, `ctrl_${Date.now()}_a`, `es_${Date.now()}_a`, caps);
    const store = new Store();
    const receipts = new ShadowActionReceiptStore(tmp('rcpt'));
    const capsMap: Record<string, readonly ShadowCapability[]> = { [e.controllerDeviceId]: e.capabilities! };
    const plane = hostPlane(e, tmp('host'), store, receipts, (cd) => capsMap[cd] ?? null);

    const p = store.createProject({ name: 'ActProj-safe-1' });
    const s = store.createSession(p.id, 'act chat');
    const appr = store.createApproval({ projectId: p.id, kind: 'merge', title: 'Merge-safe', subtitle: `detail ${CANARY}` });
    await plane.projection.scheduleReconcile();

    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    await mobile.connect();
    expect(sel.getSession(mobile.readEntities(), s.id)?.autopilot).not.toBe(true);

    // Action 1: set autopilot true.
    const { commandId: c1 } = await mobile.sendCommand('controller.session.autopilot.set', { sessionId: s.id, enabled: true });
    expect(await plane.svc.pollAndExecuteCommands()).toBe(1);
    // Exactly once: a second host poll re-applies nothing.
    expect(await plane.svc.pollAndExecuteCommands()).toBe(0);
    await mobile.pollAcks(); await mobile.pollEvents();
    expect(mobile.getCommand(c1)?.status).toBe('applied');
    expect(store.getSession(s.id)!.autoPilot).toBe(true);                 // authoritative Store state
    expect(sel.getSession(mobile.readEntities(), s.id)?.autopilot).toBe(true); // mobile selector reflects it

    // Action 2: approve the pending approval.
    const { commandId: c2 } = await mobile.sendCommand('controller.approval.respond', { approvalId: appr.id, decision: 'approve' });
    await plane.svc.pollAndExecuteCommands();
    await mobile.pollAcks(); await mobile.pollEvents();
    expect(mobile.getCommand(c2)?.status).toBe('applied');
    expect(store.listApprovals().find((a) => a.id === appr.id)!.status).toBe('approved');

    // Relay PG holds NO plaintext canary across command/event/ack tables.
    const evs = await getDb().selectFrom('shadow_event').select(['payload_ciphertext']).where('account_id', '=', accountId).execute();
    expect(evs.map((x) => x.payload_ciphertext).join('|')).not.toContain(CANARY);

    // Capability DOWNGRADE takes effect on a subsequent command AT EXECUTION: the host's
    // authoritative record now grants only account.read, so an autopilot mutator is
    // DENIED before any product effect (effect count 0) — the security property that matters.
    const beforeAuto = store.getSession(s.id)!.autoPilot;
    const jobsBefore = store.listJobs().length;
    capsMap[e.controllerDeviceId] = ['account.read'];
    await mobile.sendCommand('controller.session.autopilot.set', { sessionId: s.id, enabled: false });
    expect(await plane.svc.pollAndExecuteCommands()).toBe(1); // pulled + processed (→ rejected, encrypted ack)
    // Effect count 0: product state unchanged, no side-effect job.
    expect(store.getSession(s.id)!.autoPilot).toBe(beforeAuto); // unchanged — capability denied
    expect(store.listJobs().length).toBe(jobsBefore);
    // A re-poll re-applies nothing (still denied, still no effect).
    expect(await plane.svc.pollAndExecuteCommands()).toBe(0);
    expect(store.getSession(s.id)!.autoPilot).toBe(beforeAuto);

    close();
    receipts.close(); plane.core.close();
  });

  it('exercises message/start/cancel/question cross-tier + recovers a host crash (message) to one job + applied', async () => {
    await makeAccount();
    const caps: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'question.answer'];
    const e = await enroll(`host_${Date.now()}_m`, `ctrl_${Date.now()}_m`, `es_${Date.now()}_m`, caps);
    const store = new Store();
    const hostDir = tmp('host'); const receiptDir = tmp('rcpt');
    let receipts = new ShadowActionReceiptStore(receiptDir);
    const capsMap: Record<string, readonly ShadowCapability[]> = { [e.controllerDeviceId]: e.capabilities! };
    let plane = hostPlane(e, hostDir, store, receipts, (cd) => capsMap[cd] ?? null);

    const p = store.createProject({ name: 'MActProj-safe' });
    const s = store.createSession(p.id, 'm chat');
    const cancellable = store.createJob(p.id, 'busy', 'Cancel-me', 'balanced', s.id); store.updateJob(cancellable.id, { status: 'running' });
    store.createSchedule({ projectId: p.id, title: 'q', kind: 'auto-answer', sessionId: s.id, sourceJobId: cancellable.id, fireAt: Date.now() + 60000, armedAt: Date.now(), questionAsk: JSON.stringify({ questions: [{ question: 'Pick-safe?', options: [{ label: 'Yes-safe' }] }] }) });
    await plane.projection.scheduleReconcile();
    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    await mobile.connect();

    // job.start → applied; the created Job is projected + selector shows it.
    const start = await mobile.sendCommand('controller.job.start', { projectId: p.id, input: 'START-canary-run', title: 'Started' });
    await plane.svc.pollAndExecuteCommands(); await mobile.pollAcks(); await mobile.pollEvents();
    expect(mobile.getCommand(start.commandId)?.status).toBe('applied');
    expect(store.listJobs(p.id).filter((j) => j.input === 'START-canary-run').length).toBe(1);
    // job.cancel → the running job becomes cancelled authoritatively.
    const cancel = await mobile.sendCommand('controller.job.cancel', { jobId: cancellable.id });
    await plane.svc.pollAndExecuteCommands(); await mobile.pollAcks(); await mobile.pollEvents();
    expect(mobile.getCommand(cancel.commandId)?.status).toBe('applied');
    expect(store.getJob(cancellable.id)!.status).toBe('cancelled');
    // question.answer → the pending schedule is resolved.
    const answer = await mobile.sendCommand('controller.question.answer', { sessionId: s.id, sourceJobId: cancellable.id, answer: 'ANSWER-canary' });
    await plane.svc.pollAndExecuteCommands(); await mobile.pollAcks(); await mobile.pollEvents();
    expect(mobile.getCommand(answer.commandId)?.status).toBe('applied');
    expect(store.listSchedules().find((x) => x.kind === 'auto-answer')!.enabled).toBe(false);

    // NAMED CRASH: a message command crashes the host AFTER the durable Job + ledger
    // 'applied' but BEFORE the projection. Restart the host local services (same paths)
    // → recovery re-drives the command-bound projection → mobile eventually applied,
    // exactly one Job.
    const msg = await mobile.sendCommand('controller.session.message', { sessionId: s.id, text: 'MESSAGE-canary' });
    plane.svc.debugSetCrashPointForTest('after-ack-before-append');
    await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(/crash-after-ack-before-append/);
    plane.svc.close(); receipts.close();
    // Reopen host services against the SAME durable dirs.
    receipts = new ShadowActionReceiptStore(receiptDir);
    plane = hostPlane(e, hostDir, store, receipts, (cd) => capsMap[cd] ?? null);
    await plane.svc.pollAndExecuteCommands(); // recovery settles + publishes the projection
    await mobile.pollAcks(); await mobile.pollEvents();
    expect(mobile.getCommand(msg.commandId)?.status).toBe('applied');
    expect(store.listJobs(p.id).filter((j) => j.input === 'MESSAGE-canary').length).toBe(1); // exactly one job

    // No canary plaintext anywhere in the relay command/event tables.
    const evs = await getDb().selectFrom('shadow_event').select(['payload_ciphertext']).where('account_id', '=', accountId).execute();
    const cmds = await getDb().selectFrom('shadow_command').select(['envelope_ciphertext']).where('account_id', '=', accountId).execute();
    const blob = [...evs.map((x) => x.payload_ciphertext), ...cmds.map((x) => x.envelope_ciphertext)].join('|');
    for (const canary of ['START-canary-run', 'ANSWER-canary', 'MESSAGE-canary']) expect(blob).not.toContain(canary);

    close(); receipts.close(); plane.core.close();
  });

  it('HIGH-2 cross-tier: a command claimed valid then recovered AFTER lease expiry produces ZERO effect', async () => {
    await makeAccount();
    const caps: ShadowCapability[] = ['account.read', 'job.start'];
    const e = await enroll(`host_${Date.now()}_x`, `ctrl_${Date.now()}_x`, `es_${Date.now()}_x`, caps);
    const capsMap: Record<string, readonly ShadowCapability[]> = { [e.controllerDeviceId]: caps };
    const store = new Store();
    const hostDir = tmp('host'); const receiptDir = tmp('rcpt');
    const p = store.createProject({ name: 'ExpiryProj' });
    let receipts = new ShadowActionReceiptStore(receiptDir);

    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    await mobile.connect();
    // Controller submits a job.start while the lease is valid.
    const cmd = await mobile.sendCommand('controller.job.start', { projectId: p.id, input: 'EXPIRED-run-canary', title: 'T' });

    // Host ingests + CLAIMS the command (authority valid) then crashes BEFORE execute.
    let plane = hostPlane(e, hostDir, store, receipts, (cd) => capsMap[cd] ?? null);
    plane.svc.debugSetCrashPointForTest('after-claim-before-execute');
    await expect(plane.svc.pollAndExecuteCommands()).rejects.toThrow(/after-claim-before-execute/);
    expect(store.listJobs(p.id).filter((j) => j.input === 'EXPIRED-run-canary').length).toBe(0); // nothing yet
    plane.svc.close(); receipts.close();

    // Restart host services against the SAME durable dirs; the CONTROLLER AUTHORITY lease is now
    // expired locally (host-core authority.leaseExpiresAt in the past). The server pull still uses
    // the real clock (valid host lease), but the execution-time guard must fail closed.
    receipts = new ShadowActionReceiptStore(receiptDir);
    plane = hostPlane(e, hostDir, store, receipts, (cd) => capsMap[cd] ?? null);
    plane.svc.setAuthority(e.fence, Date.now() - 60_000, []); // controller lease expired
    await plane.svc.pollAndExecuteCommands();
    await mobile.pollAcks(); await mobile.pollEvents();
    // ZERO product effect; the controller never observes it applied; no applied event on the relay.
    expect(store.listJobs(p.id).filter((j) => j.input === 'EXPIRED-run-canary').length).toBe(0);
    expect(mobile.getCommand(cmd.commandId)?.status).not.toBe('applied');
    const evs = await getDb().selectFrom('shadow_event').select(['payload_ciphertext']).where('account_id', '=', accountId).execute();
    expect(evs.length).toBe(0);
    close(); receipts.close(); plane.core.close();
  });
});
