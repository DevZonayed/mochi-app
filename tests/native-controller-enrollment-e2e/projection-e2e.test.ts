/**
 * Phase 3A2b1 Section B cross-tier PROJECTION E2E. REAL boundaries only: listening
 * Fastify + disposable PostgreSQL + real signed HTTP + real product Store (isolated
 * userData) + real ShadowProductProjection + real ShadowHostCore + real
 * ShadowControllerService over Node 24 node:sqlite + production node:crypto.
 *
 * Proves: seed 2+ projects + sessions/jobs/approval/question/schedule with SAFE
 * unique names and hidden secret canaries → host projection appends encrypted events
 * → relay stores ciphertext only → mobile catches up → mobile selectors reconstruct
 * ALL projects/relations → update/delete produce coherent revisions/tombstones →
 * host+mobile restart with NO duplicate → relay PG contains NONE of the canaries →
 * revoke locks the controller, whose offline cache stays truthful.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ userData: `/tmp/maestro-proj-e2e-store-${process.pid}-${process.hrtime()[1]}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.userData } }));

import { buildAccountServer, migrateAll } from '../../apps/server/src/accountServer.ts';
import { auth, getSessionUser } from '../../apps/server/src/auth.ts';
import { upsertDevice } from '../../apps/server/src/accountDevices.ts';
import { getDb } from '../../apps/server/src/db.ts';
import {
  registerHostIdentity, createEnrollmentSession, submitEnrollmentRequest, approveEnrollment as serverApprove,
  computeEnrollmentVerifier, signHostRegistration, revokeEnrolledController,
} from '../../apps/server/src/shadowEnrollmentService.ts';
import { acquireShadowLease } from '../../apps/server/src/shadowRelay.ts';
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
import { ShadowProductProjection } from '../../MacOS/brain/shadow-product-projection.ts';
import { ShadowControllerService } from '../../apps/mobile/src/shadowControllerService.ts';
import { ExpoSQLiteShadowStore } from '../../apps/mobile/src/shadowClient.ts';
import * as sel from '../../apps/mobile/src/shadowProjectionSelectors.ts';
import { Store } from '../../MacOS/brain/store.ts';
import { openRealSQLite } from './adapters.ts';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const realFetch: ShadowFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ShadowFetch>;
const CANARY = 'CANARY_PROJ_E2E_7f3a9b2c1d0e5a6b';

let app: ReturnType<typeof buildAccountServer>;
let origin = '';
let accountId = '';
let token = '';

function signer(identity: ShadowIdentity): ShadowRequestSigner {
  return { keyId: identity.signingKeyId, sign: (bytes) => node.sign(identity.keys.signing.privateKey, bytes) };
}
async function makeAccount(): Promise<void> {
  const res = await auth.api.signUpEmail({ body: { email: `pj${Date.now()}_${Math.floor(process.hrtime()[1])}@x.dev`, password: 'pw-12345678', name: 'PJ' } });
  token = res.token as string;
  const who = await getSessionUser({ authorization: `Bearer ${token}` });
  accountId = who!.userId;
}

interface Enrolled { host: ShadowIdentity; controller: ShadowIdentity; hostDeviceId: string; controllerDeviceId: string; scopeKey: Uint8Array; scopeKeyId: string; fence: Fence; leaseExpiresAt: number; }

async function enroll(hostDeviceId: string, controllerDeviceId: string, sessionId: string): Promise<Enrolled> {
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
  const { request } = await buildEnrollmentRequest(node, { controller, bootstrap, nowMs });
  await submitEnrollmentRequest({ accountId, sessionId, request, presentedSecret: bootstrap.secret, nowMs });
  const transcriptHash = base64urlDecode(request.transcriptHash);
  const approval = await hostApprove(node, { host, fence, controllerDeviceId, controllerAgreementPublicKey: base64urlDecode(request.agreementPublicKey), transcriptHash, sessionId, nowMs, ttlMs: 300_000 });
  await serverApprove({ accountId, hostDeviceId, sessionId, grant: approval.grant, keyMaterial: approval.keyMaterial, nowMs });
  const accepted = await acceptEnrollmentGrant(node, { controller, bootstrap, grant: approval.grant, keyMaterial: approval.keyMaterial, transcriptHash, nowMs });
  expect(accepted.ok).toBe(true);
  return { host, controller, hostDeviceId, controllerDeviceId, scopeKey: approval.scopeKey, scopeKeyId: approval.scopeKeyId, fence, leaseExpiresAt: nowMs + 300_000 };
}

const commandRegistry = defineShadowCommandRegistry({});

function hostPlane(e: Enrolled, rootDir: string, store: Store) {
  const provider = new StaticShadowKeyProvider(e.scopeKeyId, Buffer.from(e.scopeKey));
  const core = new ShadowHostCore(rootDir, provider);
  const svc = new ShadowHostDataService({
    host: core, keys: provider, scopeKeyId: e.scopeKeyId, fence: e.fence, leaseExpiresAt: e.leaseExpiresAt,
    session: async () => ({ accountId, hostDeviceId: e.hostDeviceId, sessionToken: token, relayOrigin: origin }),
    signer: signer(e.host), transport: { fetch: realFetch, allowInsecureLoopback: true }, commandRegistry,
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

function tmp(name: string): string { return join(mkdtempSync(join(tmpdir(), 'pj-e2e-')), name); }

describe.skipIf(!HAS_DB)('all-project projection — cross-tier E2E', () => {
  beforeAll(async () => {
    await migrateAll();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    process.env.SHADOW_RELAY_ORIGINS = origin;
    await makeAccount();
  });
  afterAll(async () => { if (app) await app.close(); try { rmSync(hoisted.userData, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('projects all projects/relations to mobile selectors; no plaintext canary; tombstone + restart-no-dup + revoke', async () => {
    await makeAccount();
    const e = await enroll(`host_${Date.now()}_pj`, `ctrl_${Date.now()}_pj`, `es_${Date.now()}_pj`);
    const store = new Store();
    const hostDir = tmp('host');
    const dbPath = tmp('m.sqlite');

    // Seed 2 projects with related entities. SAFE names visible; CANARY only in secret fields.
    // HIGH-1 canaries (paths / stack / connection-string / git-remote creds) — exactly the
    // reviewer's shapes. They live ONLY in secret/diagnostic fields and must never surface.
    const PATH_CANARIES = ['/Users/alice/proj/src/secrets.ts', '/Users/alice/.aws/credentials', '/Users/alice/Library/Application Support/maestro', 'C:\\Users\\alice\\secret.txt', 'at load ('];
    const CRED_CANARIES = ['Tr0ub4dor', 'admin:Tr0ub4dor@', 'Aph5xKq9rZsecret', 'ci-bot:Aph5xKq9rZsecret@', 'hunter2!'];
    const p1 = store.createProject({ name: 'ProjOne-safe-111', kind: 'coding', repoUrl: 'https://ci-bot:Aph5xKq9rZsecret@gitlab.example.com/team/app.git' } as Parameters<typeof store.createProject>[0]);
    const p2 = store.createProject({ name: 'ProjTwo-safe-222', kind: 'design' });
    const s1 = store.createSession(p1.id, 'session-safe-a');
    const j1 = store.createJob(p1.id, 'work', 'JobOne-safe', 'balanced', s1.id);
    store.updateJob(j1.id, {
      status: 'running',
      error: `boom sk-ant-api03${CANARY} at /Users/alice/proj/src/secrets.ts:42\n  at load (/Users/alice/.aws/credentials:9)`,
      output: `connected postgres://admin:Tr0ub4dor@db.internal:5432/prod ; home /Users/alice/Library/Application Support/maestro ; password=hunter2! ; C:\\Users\\alice\\secret.txt`,
    });
    store.createApproval({ projectId: p1.id, kind: 'merge', title: 'Approve-safe', subtitle: 'ready', detail: `rm -rf ${CANARY}`, jobId: j1.id });
    store.createSchedule({ projectId: p2.id, title: 'Sched-safe', kind: 'auto-answer', sessionId: s1.id, sourceJobId: j1.id, fireAt: Date.now() + 60000, armedAt: Date.now(), questionAsk: JSON.stringify({ questions: [{ question: 'Which safe option?', options: [{ label: 'OptA-safe' }, { label: 'OptB-safe' }] }] }) });

    const plane = hostPlane(e, hostDir, store);
    const r = await plane.projection.scheduleReconcile();
    expect(r.emitted).toBeGreaterThanOrEqual(6);

    // Mobile catches up and selectors reconstruct all projects/relations.
    const { svc: mobile, close } = await controllerService(e, dbPath);
    await mobile.connect();
    const ents = mobile.readEntities();
    expect(sel.listProjects(ents).map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(sel.listProjectSessions(ents, p1.id).map((s) => s.id)).toEqual([s1.id]);
    expect(sel.listProjectJobs(ents, p1.id).map((j) => j.id)).toEqual([j1.id]);
    expect(sel.listPendingApprovals(ents).length).toBe(1);
    expect(sel.listPendingQuestions(ents).length).toBe(1);
    expect(sel.listPendingQuestions(ents)[0].question).toBe('Which safe option?');
    // Job error/output + repo credentials NEVER reach the controller payload (mobile SQLite).
    const entsJson = JSON.stringify(ents);
    expect(entsJson).not.toContain(CANARY);
    expect(entsJson).not.toContain('rm -rf');
    for (const c of [...PATH_CANARIES, ...CRED_CANARIES]) expect(entsJson).not.toContain(c);
    expect(entsJson).not.toContain('@');            // no URL userinfo anywhere in the projection
    // A safe repo identity (host) DID survive for the UI.
    expect(sel.getProject(ents, p1.id)?.repoHost).toBe('gitlab.example.com');
    // Safe names ARE present.
    expect(sel.getProject(ents, p1.id)?.name).toBe('ProjOne-safe-111');

    // Relay PostgreSQL contains NONE of the canaries in plaintext.
    const rows = await getDb().selectFrom('shadow_event').select(['payload_ciphertext', 'entity_id']).where('account_id', '=', accountId).execute();
    const blob = rows.map((x) => x.payload_ciphertext).join('|');
    expect(blob).not.toContain(CANARY);
    for (const c of [...PATH_CANARIES, ...CRED_CANARIES]) expect(blob).not.toContain(c);
    expect(blob).not.toContain('ProjOne-safe-111'); // even safe names are E2E-encrypted on the relay

    // Update + delete → coherent revision + tombstone; mobile reflects it.
    store.updateProject(p1.id, { name: 'ProjOne-renamed-111' });
    store.deleteProject(p2.id);
    const r2 = await plane.projection.scheduleReconcile();
    expect(r2.emitted).toBeGreaterThanOrEqual(2); // p1 upsert (rev bump) + p2 tombstone
    expect(r2.tombstoned).toBeGreaterThanOrEqual(1);
    await mobile.connect();
    const ents2 = mobile.readEntities();
    expect(sel.getProject(ents2, p1.id)?.name).toBe('ProjOne-renamed-111');
    expect(sel.getProject(ents2, p2.id)).toBeUndefined(); // tombstoned → absent from selectors
    expect(sel.listProjects(ents2).map((p) => p.id)).toEqual([p1.id]);
    close();

    // Restart host (reopen core) + mobile (reopen SQLite): NO duplicate events.
    const plane2 = hostPlane(e, hostDir, store);
    const r3 = await plane2.projection.scheduleReconcile();
    expect(r3.emitted).toBe(0); // index persisted → nothing re-emitted
    const { svc: mobile2, close: close2 } = await controllerService(e, dbPath);
    const applied = await mobile2.connect();
    expect(applied).toBe(0); // mobile cursor already current

    // Durable offline cache: selectors remain readable + truthful (not locked yet).
    expect(sel.listProjects(mobile2.readEntities()).map((p) => p.id)).toEqual([p1.id]);
    expect(sel.connectionOf(mobile2.status()).locked).toBe(false);

    // Revoke the controller → next connect fails closed (locked, read-only).
    const revocation = await signDeviceRevocation(node, e.host, {
      family: 'device-revocation', v: 1, fence: e.fence, controllerDeviceId: e.controllerDeviceId, revokedAt: Date.now(), keyRotationId: `kr_${Date.now()}`,
    });
    await revokeEnrolledController({ accountId, hostDeviceId: e.hostDeviceId, scopeId: e.fence.scopeId, controllerDeviceId: e.controllerDeviceId, revocation, effectiveSeq: 1, remainingRotations: [], nowMs: Date.now() });
    // A revoked controller is denied by the relay; the service locks + wipes its key.
    await mobile2.connect().catch(() => { /* expected: denied */ });
    expect(sel.connectionOf(mobile2.status()).locked).toBe(true);
    close2();
    plane.core.close(); plane2.core.close();
  });
});
