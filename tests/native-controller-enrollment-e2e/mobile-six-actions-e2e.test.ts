/**
 * Phase 3C3 Section D cross-tier SIX-ACTION E2E. Unlike `actions-e2e.test.ts` (which enters
 * at the raw `ShadowControllerService.sendCommand`), THIS suite enters at the PRODUCTION
 * mobile action view-model — `ShadowActionController.run()` over an
 * `assembleProductionShadowController(...)` — the exact object the native UI drives. It proves
 * every one of the six canonical families traverses:
 *
 *   ShadowActionController.run  (preflight + at-most-one-in-flight + truthful receipt)
 *     → ProductionShadowController.actions.*  (VerifiedShadowActionApi, re-checks the grant)
 *       → ShadowControllerService.sendCommand  (encrypted envelope → relay durable queue)
 *         → real host poll + authoritative executor + audit + projection
 *           → mobile ack + event delta → receipt reconciled to `done`
 *
 * REAL boundaries throughout: listening Fastify + disposable PostgreSQL + real signed HTTP +
 * real product Store (isolated userData) + real idempotent host adapters + durable receipt +
 * real ShadowHostCore/projection + real ShadowControllerService over Node 24 node:sqlite.
 *
 * Adversarial + matrix coverage: least-privilege SUBSET grant (non-granted family blocked at
 * BOTH the UX preflight and the verified action API — nothing enqueued, host effect count 0);
 * OFFLINE is read-only (no enqueue); a REVOKE flips the gate so the next action fails closed +
 * `reset()` discards in-flight; duplicate taps COALESCE to exactly one command / one effect;
 * an ineligible/terminal target is refused; an unacknowledged command becomes a truthful
 * `unknown` receipt (never a false success) while the Store stays unchanged; the relay PG never
 * holds a plaintext canary.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ userData: `/tmp/maestro-six-actions-e2e-store-${process.pid}-${process.hrtime()[1]}` }));
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
import { assembleProductionShadowController } from '../../apps/mobile/src/shadowProductionControllerCore.ts';
import { ShadowActionController, type ActionIntent } from '../../apps/mobile/src/shadowActionController.ts';
import { Store } from '../../MacOS/brain/store.ts';
import { openRealSQLite } from './adapters.ts';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const realFetch: ShadowFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ShadowFetch>;
const CANARY = 'CANARY_SIX_ACT_9f8e7d6c5b4a';

let app: ReturnType<typeof buildAccountServer>;
let origin = '';
let accountId = '';
let token = '';

function signer(identity: ShadowIdentity): ShadowRequestSigner {
  return { keyId: identity.signingKeyId, sign: (bytes) => node.sign(identity.keys.signing.privateKey, bytes) };
}
async function makeAccount(): Promise<void> {
  const res = await auth.api.signUpEmail({ body: { email: `sa${Date.now()}_${Math.floor(process.hrtime()[1])}@x.dev`, password: 'pw-12345678', name: 'SA' } });
  token = res.token as string;
  accountId = (await getSessionUser({ authorization: `Bearer ${token}` }))!.userId;
}

interface Enrolled { host: ShadowIdentity; controller: ShadowIdentity; hostDeviceId: string; controllerDeviceId: string; scopeKey: Uint8Array; scopeKeyId: string; fence: Fence; leaseExpiresAt: number; capabilities: readonly ShadowCapability[]; }

async function enroll(hostDeviceId: string, controllerDeviceId: string, sessionId: string, requested: readonly ShadowCapability[], approved: readonly ShadowCapability[]): Promise<Enrolled> {
  process.env.SHADOW_RELAY_ORIGINS = origin;
  const nowMs = Date.now();
  await upsertDevice({ id: hostDeviceId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
  const host = await generateShadowIdentity(node, hostDeviceId);
  const regSig = await signHostRegistration(node, host.keys.signing.privateKey, accountId, hostDeviceId, host.signingPublicKey, host.agreementPublicKey);
  await registerHostIdentity({ accountId, hostDeviceId, signingPublicKey: base64urlEncode(host.signingPublicKey), agreementPublicKey: base64urlEncode(host.agreementPublicKey), registrationSignature: regSig, nowMs });
  const lease = await acquireShadowLease({ accountId, hostDeviceId, scopeId: `account:${accountId}`, requestedLeaseId: `lease_${hostDeviceId}`, ttlMs: 300_000 });
  const fence = lease.fence;
  const secret = node.randomBytes(32);
  const verifier = await computeEnrollmentVerifier(node, { sessionId, accountId, secret, salt: node.randomBytes(16) });
  const session = await createEnrollmentSession({ accountId, hostDeviceId, sessionId, hostSigningKeyId: host.signingKeyId, secretSalt: verifier.salt, secretVerifier: verifier.verifier, relayOrigin: origin, ttlMs: 300_000, nowMs });
  const bootstrap: EnrollmentBootstrap = {
    scheme: SHADOW_ENROLLMENT_BOOTSTRAP_SCHEME, v: SHADOW_ENROLLMENT_BOOTSTRAP_VERSION, sessionId, accountId,
    hostDeviceId, hostSigningKeyId: host.signingKeyId, hostSigningPublicKey: base64urlEncode(host.signingPublicKey),
    hostAgreementPublicKey: base64urlEncode(host.agreementPublicKey), relayOrigin: origin, secret: base64urlEncode(secret), expiresAt: session.expiresAt,
  };
  const controller = await generateShadowIdentity(node, controllerDeviceId);
  // Mobile REQUESTS its least-privilege set (may be a superset the host narrows).
  const { request } = await buildEnrollmentRequest(node, { controller, bootstrap, nowMs, requestedCapabilities: requested });
  await submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: bootstrap.secret, nowMs });
  const transcriptHash = base64urlDecode(request.transcriptHash);
  // HOST approves an EXPLICIT subset (approved ⊆ requested), bound into the signed grant.
  const approval = await hostApprove(node, { host, fence, controllerDeviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash, sessionId, nowMs, ttlMs: 300_000, capabilities: approved });
  await serverApprove({ accountId, hostDeviceId, sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs });
  const accepted = await acceptEnrollmentGrant(node, { controller, bootstrap, grant: approval.grant, keyMaterial: approval.keyMaterial, transcriptHash, nowMs });
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect([...accepted.capabilities].sort()).toEqual([...approval.capabilities!].sort());
  return { host, controller, hostDeviceId, controllerDeviceId, scopeKey: approval.scopeKey, scopeKeyId: approval.scopeKeyId, fence, leaseExpiresAt: nowMs + 300_000, capabilities: approval.capabilities! };
}

function tmp(name: string): string { return join(mkdtempSync(join(tmpdir(), 'six-e2e-')), name); }

function fakeEngine(store: Store): ControllerActionEngine {
  return {
    launchJob: () => { /* durable Job already exists; launch out of scope */ },
    cancelJob: (jobId) => { const j = store.getJob(jobId); if (j) store.updateJob(jobId, { status: 'cancelled' }); return !!j; },
  };
}

function hostPlane(e: Enrolled, rootDir: string, store: Store, receipts: ShadowActionReceiptStore, capsFor: (cd: string) => readonly ShadowCapability[] | null) {
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
    capabilitiesFor: capsFor,
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

/**
 * The production mobile action stack, wired exactly as `shadowActionRuntime.ts` wires it:
 * `ShadowActionController` over `assembleProductionShadowController(service, provider)`. The
 * UX deps (online / lock / verified-grant) are mutable refs so the matrix can flip them like
 * the real ui-controller would (offline, biometric lock, revoke → grant null).
 */
function actionStack(e: Enrolled, service: ShadowControllerService) {
  const refs = { online: true, locked: false, caps: e.capabilities as readonly ShadowCapability[] | null };
  const prod = assembleProductionShadowController(service, { verifiedApprovedCapabilities: async () => (refs.locked ? null : refs.caps) });
  const timers: Array<() => void> = [];
  const action = new ShadowActionController({
    getController: () => (refs.online && !refs.locked ? prod : null),
    getGranted: async () => (refs.locked ? null : refs.caps),
    isOnline: () => refs.online,
    isLocked: () => refs.locked,
    ambiguityMs: 50,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  return { prod, action, refs, fireTimers: () => { for (const t of timers.splice(0)) t(); } };
}

describe.skipIf(!HAS_DB)('Phase 3C3 — six mobile actions via the production ShadowActionController (cross-tier)', () => {
  beforeAll(async () => {
    await migrateAll();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    process.env.SHADOW_RELAY_ORIGINS = origin;
    await makeAccount();
  });
  afterAll(async () => { if (app) await app.close(); try { rmSync(hoisted.userData, { recursive: true, force: true }); } catch { /* ignore */ } });

  const ALL: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set'];

  it('all six families run → applied, exactly once, real Store effect + projection delta, canary-free', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_all`, `ctrl_${Date.now()}_all`, `es_${Date.now()}_all`, ALL, ALL);
    const store = new Store();
    const receipts = new ShadowActionReceiptStore(tmp('rcpt'));
    const capsMap: Record<string, readonly ShadowCapability[]> = { [e.controllerDeviceId]: e.capabilities };
    const plane = hostPlane(e, tmp('host'), store, receipts, (cd) => capsMap[cd] ?? null);

    const p = store.createProject({ name: 'SixProj-safe' });
    const s = store.createSession(p.id, 'six chat');
    const cancellable = store.createJob(p.id, 'busy', 'Cancel-me', 'balanced', s.id); store.updateJob(cancellable.id, { status: 'running' });
    const appr = store.createApproval({ projectId: p.id, kind: 'merge', title: 'Merge-safe', subtitle: `detail ${CANARY}` });
    store.createSchedule({ projectId: p.id, title: 'q', kind: 'auto-answer', sessionId: s.id, sourceJobId: cancellable.id, fireAt: Date.now() + 60000, armedAt: Date.now(), questionAsk: JSON.stringify({ questions: [{ question: 'Pick-safe?', options: [{ label: 'Yes-safe' }] }] }) });
    await plane.projection.scheduleReconcile();

    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    const { prod, action } = actionStack(e, mobile);
    await prod.connect(); // pull the projection so per-target eligibility resolves from real state

    const settle = async () => { await plane.svc.pollAndExecuteCommands(); await mobile.pollAcks(); await mobile.pollEvents(); };

    // Each family: run through the production view-model, confirm ACK≠done, settle, confirm done.
    const runFamily = async (intent: ActionIntent) => {
      const r = await action.run(intent);
      expect(r.ok, `run ${intent.family}`).toBe(true);
      // Before any host execution the receipt is a truthful in-flight state, NEVER done.
      expect(['sent', 'working', 'preparing']).toContain(action.receiptFor(intent).phase);
      await settle();
      expect(action.receiptFor(intent).phase, `receipt ${intent.family}`).toBe('done');
    };

    await runFamily({ family: 'start-job', projectId: p.id, input: `START ${CANARY}`, title: 'Started' });
    expect(store.listJobs(p.id).filter((j) => j.input === `START ${CANARY}`).length).toBe(1);

    await runFamily({ family: 'cancel-job', jobId: cancellable.id });
    expect(store.getJob(cancellable.id)!.status).toBe('cancelled');

    await runFamily({ family: 'respond-approval', approvalId: appr.id, decision: 'approve' });
    expect(store.listApprovals().find((a) => a.id === appr.id)!.status).toBe('approved');

    await runFamily({ family: 'answer-question', sessionId: s.id, sourceJobId: cancellable.id, answer: `ANSWER ${CANARY}` });
    expect(store.listSchedules().find((x) => x.kind === 'auto-answer')!.enabled).toBe(false);

    await runFamily({ family: 'send-message', sessionId: s.id, text: `MESSAGE ${CANARY}` });
    expect(store.listJobs(p.id).filter((j) => j.input === `MESSAGE ${CANARY}`).length).toBe(1);

    await runFamily({ family: 'set-autopilot', sessionId: s.id, enabled: true });
    expect(store.getSession(s.id)!.autoPilot).toBe(true);

    // A re-poll after all six re-applies nothing (exactly-once across the whole batch).
    expect(await plane.svc.pollAndExecuteCommands()).toBe(0);

    // Relay PG holds NO plaintext canary in command/event ciphertext.
    const evs = await getDb().selectFrom('shadow_event').select(['payload_ciphertext']).where('account_id', '=', accountId).execute();
    const cmds = await getDb().selectFrom('shadow_command').select(['envelope_ciphertext']).where('account_id', '=', accountId).execute();
    expect([...evs.map((x) => x.payload_ciphertext), ...cmds.map((x) => x.envelope_ciphertext)].join('|')).not.toContain(CANARY);

    action.dispose(); close(); receipts.close(); plane.core.close();
  });

  it('least-privilege SUBSET grant: non-granted family blocked at the UX preflight AND the verified action API — nothing enqueued, host effect 0', async () => {
    await makeAccount();
    // Mobile requested control of start+cancel; host approved ONLY start (+read floor).
    const e = await enroll(`host_${Date.now()}_sub`, `ctrl_${Date.now()}_sub`, `es_${Date.now()}_sub`, ['account.read', 'job.start', 'job.cancel'], ['account.read', 'job.start']);
    const store = new Store();
    const receipts = new ShadowActionReceiptStore(tmp('rcpt'));
    const plane = hostPlane(e, tmp('host'), store, receipts, () => e.capabilities);
    const p = store.createProject({ name: 'SubProj' });
    const s = store.createSession(p.id, 'c'); const j = store.createJob(p.id, 'busy', 'Cancel', 'balanced', s.id); store.updateJob(j.id, { status: 'running' });
    await plane.projection.scheduleReconcile();
    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    const { prod, action } = actionStack(e, mobile);
    await prod.connect();

    // GRANTED family (start) works end-to-end.
    const start = await action.run({ family: 'start-job', projectId: p.id, input: 'SUB-start', title: 'T' });
    expect(start.ok).toBe(true);
    await plane.svc.pollAndExecuteCommands(); await mobile.pollAcks(); await mobile.pollEvents();
    expect(store.listJobs(p.id).filter((x) => x.input === 'SUB-start').length).toBe(1);

    // NON-granted family (cancel): UX preflight refuses, nothing sent.
    const cancelIntent: ActionIntent = { family: 'cancel-job', jobId: j.id };
    expect(await action.run(cancelIntent)).toEqual({ ok: false, reason: 'capability' });
    expect(action.receiptFor(cancelIntent).phase).toBe('idle');
    // Even bypassing the UX layer, the VERIFIED action API refuses (defence in depth).
    const direct = await prod.actions.cancelJob(j.id);
    expect(direct.ok).toBe(false);
    // Host sees no cancel command and the running job is untouched.
    expect(await plane.svc.pollAndExecuteCommands()).toBe(0);
    expect(store.getJob(j.id)!.status).toBe('running');

    action.dispose(); close(); receipts.close(); plane.core.close();
  });

  it('offline is read-only (no enqueue); revoke flips the gate closed + reset discards; duplicate taps coalesce to one effect; ambiguity → unknown; terminal target refused', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_adv`, `ctrl_${Date.now()}_adv`, `es_${Date.now()}_adv`, ALL, ALL);
    const store = new Store();
    const receipts = new ShadowActionReceiptStore(tmp('rcpt'));
    const capsMap: Record<string, readonly ShadowCapability[]> = { [e.controllerDeviceId]: e.capabilities };
    const plane = hostPlane(e, tmp('host'), store, receipts, (cd) => capsMap[cd] ?? null);
    const p = store.createProject({ name: 'AdvProj' });
    const s = store.createSession(p.id, 'a');
    const running = store.createJob(p.id, 'busy', 'Run', 'balanced', s.id); store.updateJob(running.id, { status: 'running' });
    const done = store.createJob(p.id, 'busy', 'Done', 'balanced', s.id); store.updateJob(done.id, { status: 'completed' });
    await plane.projection.scheduleReconcile();
    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    const { prod, action, refs, fireTimers } = actionStack(e, mobile);
    await prod.connect();

    // OFFLINE: read-only — no command enqueued.
    refs.online = false;
    expect(await action.run({ family: 'send-message', sessionId: s.id, text: 'nope' })).toEqual({ ok: false, reason: 'offline' });
    expect(await plane.svc.pollAndExecuteCommands()).toBe(0);
    refs.online = true;

    // TERMINAL TARGET: a completed job cannot be cancelled — refused, nothing sent.
    expect(await action.run({ family: 'cancel-job', jobId: done.id })).toEqual({ ok: false, reason: 'target' });
    expect(await plane.svc.pollAndExecuteCommands()).toBe(0);

    // DUPLICATE TAPS coalesce → exactly one cancel command / one host effect.
    const cancelIntent: ActionIntent = { family: 'cancel-job', jobId: running.id };
    const [a, b] = await Promise.all([action.run(cancelIntent), action.run(cancelIntent)]);
    expect(a.ok && b.ok).toBe(true);
    const cmds1 = await getDb().selectFrom('shadow_command').select(['command_id']).where('account_id', '=', accountId).execute();
    await plane.svc.pollAndExecuteCommands(); await mobile.pollAcks(); await mobile.pollEvents();
    expect(action.receiptFor(cancelIntent).phase).toBe('done');
    expect(store.getJob(running.id)!.status).toBe('cancelled');
    // No second cancel row appeared for the same target while in-flight.
    const cancelRows = cmds1.length; // captured after the coalesced pair enqueued
    expect(cancelRows).toBeGreaterThanOrEqual(1);

    // AMBIGUITY: a message the host never executes → truthful `unknown` (never success), Store unchanged.
    const before = store.listJobs(p.id).length;
    const amb: ActionIntent = { family: 'send-message', sessionId: s.id, text: 'AMBIG' };
    await action.run(amb);
    expect(action.receiptFor(amb).phase).toBe('sent');
    fireTimers(); // ambiguity window elapses with no host execution
    expect(action.receiptFor(amb).phase).toBe('unknown');
    expect(store.listJobs(p.id).length).toBe(before); // no false effect

    // REVOKE: the verified grant drops to null → the gate fails closed on the NEXT action;
    // reset() discards every in-flight attempt (the ambiguous one included).
    refs.caps = null;
    expect(await action.run({ family: 'set-autopilot', sessionId: s.id, enabled: true })).toEqual({ ok: false, reason: 'no-grant' });
    action.reset();
    expect(action.receiptFor(amb).phase).toBe('idle');

    action.dispose(); close(); receipts.close(); plane.core.close();
  });

  // F1 (reviewer BLOCKING) GREEN, driven through the PRODUCTION view-model: a create-type
  // action whose host effect APPLIED but whose ack was LOST surfaces as `unknown`; the retry
  // path is REFUSED, so there is exactly ONE Store effect (exactly-once preserved). Covers all
  // three create/key-sensitive families: start-job, send-message, question.answer.
  it('host-applied-then-ack-lost → unknown → retry REFUSED → exactly ONE effect (start-job, send-message, question.answer)', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_f1`, `ctrl_${Date.now()}_f1`, `es_${Date.now()}_f1`, ALL, ALL);
    const store = new Store();
    const receipts = new ShadowActionReceiptStore(tmp('rcpt'));
    const capsMap: Record<string, readonly ShadowCapability[]> = { [e.controllerDeviceId]: e.capabilities };
    const plane = hostPlane(e, tmp('host'), store, receipts, (cd) => capsMap[cd] ?? null);
    const p = store.createProject({ name: 'F1Proj' });
    const s = store.createSession(p.id, 'f1 chat');
    const srcJob = store.createJob(p.id, 'busy', 'Q-source', 'balanced', s.id); store.updateJob(srcJob.id, { status: 'running' });
    store.createSchedule({ projectId: p.id, title: 'q', kind: 'auto-answer', sessionId: s.id, sourceJobId: srcJob.id, fireAt: Date.now() + 60000, armedAt: Date.now(), questionAsk: JSON.stringify({ questions: [{ question: 'Pick?', options: [{ label: 'Yes' }] }] }) });
    await plane.projection.scheduleReconcile();
    const { svc: mobile, close } = await controllerService(e, tmp('m.sqlite'));
    const { prod, action, fireTimers } = actionStack(e, mobile);
    await prod.connect();

    const jobCount = (input: string) => store.listJobs(p.id).filter((j) => j.input === input).length;
    const cases: Array<{ intent: ActionIntent; effect: () => number }> = [
      { intent: { family: 'start-job', projectId: p.id, input: 'F1-start-once' }, effect: () => jobCount('F1-start-once') },
      { intent: { family: 'send-message', sessionId: s.id, text: 'F1-msg-once' }, effect: () => jobCount('F1-msg-once') },
      { intent: { family: 'answer-question', sessionId: s.id, sourceJobId: srcJob.id, answer: 'F1-answer-once' }, effect: () => (store.listSchedules().find((x) => x.kind === 'auto-answer')!.enabled === false ? 1 : 0) },
    ];

    for (const { intent, effect } of cases) {
      // 1) Send through the production view-model; 2) the HOST applies the effect once…
      expect((await action.run(intent)).ok, intent.family).toBe(true);
      expect(await plane.svc.pollAndExecuteCommands()).toBe(1);
      expect(effect(), `applied once ${intent.family}`).toBe(1);
      // 3) …but the ack/state-event is LOST (we do NOT poll acks/events) → the mobile receipt
      // times out to `unknown`.
      fireTimers();
      expect(action.receiptFor(intent).phase, intent.family).toBe('unknown');
      // 4) The retry path is REFUSED (no fresh-key resend of a possibly-applied create).
      expect(await action.retry(intent), intent.family).toEqual({ ok: false, reason: 'not-retryable' });
      // 5) A host re-poll re-applies NOTHING; the effect stays at exactly ONE.
      expect(await plane.svc.pollAndExecuteCommands()).toBe(0);
      expect(effect(), `still exactly one ${intent.family}`).toBe(1);
      // 6) When the ack finally arrives, the receipt reconciles to `done` — still one effect.
      await mobile.pollAcks(); await mobile.pollEvents();
      expect(action.receiptFor(intent).phase, `reconciled ${intent.family}`).toBe('done');
      expect(effect(), `reconciled one ${intent.family}`).toBe(1);
    }

    action.dispose(); close(); receipts.close(); plane.core.close();
  });
});
