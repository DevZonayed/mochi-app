/**
 * Real Store → ShadowProductProjection → ShadowHostCore integration (Section 7B/C).
 * Uses the ACTUAL product Store (JSON-backed, isolated userData) and a real host
 * core (better-sqlite3), driving projections end-to-end and decrypting the emitted
 * events to prove no secret canary reaches the payload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-projection-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store, type Job } from './store.js';
import { ShadowHostCore, StaticShadowKeyProvider, type ShadowAuthority } from './shadow-host.js';
import { ShadowProductProjection } from './shadow-product-projection.js';
import type { Fence } from '@maestro/realtime';

const now = 1_800_000_000_000;
const key = Buffer.alloc(32, 5);
const CANARY = 'CANARY_SECRET_9z8y7x6w5v4u3t2s1r0q';
const LOG_LEAK_CANARIES = [
  '/Users/bob/secret-ghp_1234567890abcdef1234567890abcdef1234',
  '../relative/path/.env.local',
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'token=secret-token-value-1234567890',
  'alice@example.com',
  'https://example.com/callback?token=secret&email=alice@example.com',
  'query?access_token=abc123&refresh_token=def456',
  'control\u0000chars\u001b[31m',
  'OVERLONG_SECRET_'.repeat(40),
  'REGEX_SAFE_CANARY_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789',
  'malicious-name-ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'malicious-message-sk-ant-api03abcdefghijklmnopqrstuvwx',
] as const;

function makeFence(scopeId = 'account:user_1'): Fence {
  return { accountId: 'acct_1', scopeId, hostDeviceId: 'host_mac_1', epoch: 1, leaseId: 'lease_1' };
}
function makeCore(sub: string): ShadowHostCore {
  const core = new ShadowHostCore(join(hoisted.dir, 'shadow', sub), new StaticShadowKeyProvider('k1', key));
  const f = makeFence();
  const authority: ShadowAuthority = { accountId: f.accountId, scopeId: f.scopeId, hostDeviceId: f.hostDeviceId, epoch: f.epoch, leaseId: f.leaseId, leaseExpiresAt: now + 3_600_000 };
  core.setAuthority(authority);
  return core;
}
function decryptedPayloads(core: ShadowHostCore, sub: string): unknown[] {
  const raw = new Database(join(hoisted.dir, 'shadow', sub, 'shadow.sqlite'), { readonly: true });
  const rows = raw.prepare('SELECT event_id FROM events ORDER BY seq ASC').all() as Array<{ event_id: string }>;
  raw.close();
  return rows.map((r) => core.decryptEventPayload(r.event_id));
}
function maliciousError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}
function expectNoDiagnosticLeak(logs: string[], extraCanaries: readonly string[] = []): void {
  const joined = logs.join('\n');
  for (const canary of [...LOG_LEAK_CANARIES, ...extraCanaries]) {
    expect(joined).not.toContain(canary);
  }
  expect(joined).not.toMatch(/\/Users\/[A-Za-z0-9._-]+/);
  expect(joined).not.toMatch(/\.\.\/[A-Za-z0-9._/-]+/);
  expect(joined).not.toMatch(/ghp_[A-Za-z0-9_]{20,}/);
  expect(joined).not.toMatch(/sk-ant-api03[A-Za-z0-9_-]{16,}/);
  expect(joined).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  expect(joined).not.toMatch(/https?:\/\//);
  expect(joined).not.toMatch(/[?&](access_)?token=/);
  for (const line of logs) {
    expect(line).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  }
}

describe('ShadowProductProjection — real Store integration', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });
  afterEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('projects all account projects/sessions/jobs/approvals/questions/schedules; no-op + tombstone coherence', async () => {
    const store = new Store();
    const core = makeCore('c1');
    const projection = new ShadowProductProjection({ host: core, fence: makeFence(), store, now: () => now });

    // Seed 2+ projects. SAFE unique names are projected (visible); the secret CANARY
    // is hidden ONLY in secret-bearing fields (error/detail/questionAsk) and must never leak.
    const p1 = store.createProject({ name: 'Alpha-visible-alpha777', kind: 'coding' });
    const p2 = store.createProject({ name: 'Beta-visible-beta888', kind: 'design' });
    const s1 = store.createSession(p1.id, 'alpha chat');
    const j1 = store.createJob(p1.id, 'do the thing', 'Build Alpha', 'balanced', s1.id);
    store.updateJob(j1.id, { status: 'failed', error: `crashed with token sk-ant-api03${CANARY}` });
    store.createApproval({ projectId: p1.id, kind: 'merge', title: 'Merge PR', subtitle: 'ready', detail: `rm -rf ${CANARY}`, jobId: j1.id });
    store.createSchedule({ projectId: p1.id, title: 'auto answer', kind: 'auto-answer', sessionId: s1.id, sourceJobId: j1.id, fireAt: now + 60000, armedAt: now, questionAsk: JSON.stringify({ questions: [{ question: 'Pick one?', options: [{ label: 'Yes' }, { label: 'No' }] }] }) });
    store.createSchedule({ projectId: p2.id, title: 'daily digest', kind: 'message', time: '09:00', cadence: 'daily' });

    const r1 = await projection.scheduleReconcile();
    expect(r1.emitted).toBeGreaterThanOrEqual(7); // 2 project + 1 session + 1 job + 1 approval + 1 question + 2 schedule
    expect(r1.quarantined).toBe(0);

    // Re-reconcile with NO Store change → pure no-op.
    const r2 = await projection.scheduleReconcile();
    expect(r2.emitted).toBe(0);

    // Every emitted payload is secret-free; the SAFE project names ARE present.
    const allPayloads = decryptedPayloads(core, 'c1');
    const joined = JSON.stringify(allPayloads);
    expect(joined).not.toContain(CANARY);
    expect(joined).not.toContain('rm -rf');
    expect(joined).toContain('Alpha-visible-alpha777'); // safe name is projected
    expect(joined).toContain('Beta-visible-beta888');

    // Index reflects all collections.
    expect(core.projectionIndexEntities(makeFence().scopeId, 'project').length).toBe(2);
    expect(core.projectionIndexEntities(makeFence().scopeId, 'question').filter((e) => !e.deleted).length).toBe(1);

    // Delete a project → exactly one tombstone, no churn elsewhere.
    store.deleteProject(p2.id);
    const r3 = await projection.scheduleReconcile();
    expect(r3.tombstoned).toBeGreaterThanOrEqual(1);
    const p2row = core.projectionIndexEntities(makeFence().scopeId, 'project').find((e) => e.entityId === p2.id);
    expect(p2row?.deleted).toBe(true);
    core.close();
  });

  it('first-controller startup projects a representative 48-project / 1500-job UUID snapshot', async () => {
    const store = new Store();
    const logs: string[] = [];
    const firstProject = store.createProject({ name: 'Controller Project 01', kind: 'coding' });
    const firstSession = store.createSession(firstProject.id, 'controller session 01');
    const jobs: Job[] = [];
    const firstJobId = randomUUID();
    for (let i = 0; i < 48; i++) {
      const project = i === 0 ? firstProject : store.createProject({ name: `Controller Project ${String(i + 1).padStart(2, '0')}`, kind: 'coding' });
      const session = i === 0 ? firstSession : store.createSession(project.id, `controller session ${String(i + 1).padStart(2, '0')}`);
      const jobsForProject = i < 12 ? 32 : 31;
      for (let j = 0; j < jobsForProject; j++) {
        const id = i === 0 && j === 0 ? firstJobId : randomUUID();
        jobs.push({ id, projectId: project.id, sessionId: session.id, title: `Job ${i}-${j}`, status: 'pending', phase: 'Queued', progress: 0, input: '', output: null, error: null, effort: 'balanced', cost: 0, tokens: 0, stage: '', createdAt: now, updatedAt: now });
      }
    }
    expect(store.listProjects()).toHaveLength(48);
    expect(jobs).toHaveLength(1500);

    const core = makeCore('first-controller');
    const reader = {
      listProjects: () => store.listProjects(),
      listSessions: () => store.listSessions(),
      listJobs: () => jobs,
      listApprovals: () => [],
      listSchedules: () => [],
    };
    const projection = new ShadowProductProjection({ host: core, fence: makeFence(), store: reader, now: () => now, log: (m) => logs.push(m) });
    const result = await projection.start();

    expect(result.quarantined).toBe(0);
    expect(logs.join('\n')).not.toContain('invalid-projection-entity');
    expect(core.projectionIndexEntities(makeFence().scopeId, 'project')).toHaveLength(48);
    expect(core.projectionIndexEntities(makeFence().scopeId, 'job')).toHaveLength(1500);

    const payloads = decryptedPayloads(core, 'first-controller');
    const joined = JSON.stringify(payloads);
    expect(joined).toContain(firstProject.id);
    expect(joined).toContain(firstSession.id);
    expect(joined).toContain(firstJobId);
    expect(joined).toContain('Controller Project 01');
    core.close();
  }, 90_000);

  it('projection diagnostics never echo thrown message/name/entity content', async () => {
    const message = LOG_LEAK_CANARIES.join(' ');

    const listLogs: string[] = [];
    const listReader = {
      listProjects: () => { throw maliciousError('PathTokenEmailError', message); },
      listSessions: () => [],
      listJobs: () => [],
      listApprovals: () => [],
      listSchedules: () => [],
    };
    const listCore = makeCore('diagnostic-list');
    await new ShadowProductProjection({ host: listCore, fence: makeFence(), store: listReader, now: () => now, log: (m) => listLogs.push(m) }).scheduleReconcile();
    expect(listLogs).toContain('projection: list failed (list-failed:Error)');
    expectNoDiagnosticLeak(listLogs);
    listCore.close();

    const publishLogs: string[] = [];
    const publishStore = new Store();
    publishStore.createProject({ name: 'diagnostic publish project' });
    const publishCore = makeCore('diagnostic-publish');
    await new ShadowProductProjection({
      host: publishCore,
      fence: makeFence(),
      store: publishStore,
      now: () => now,
      publish: async () => { throw maliciousError('TypeError', message); },
      log: (m) => publishLogs.push(m),
    }).scheduleReconcile();
    expect(publishLogs).toContain('projection: publish failed (publish-failed:TypeError) — will retry on next change');
    expectNoDiagnosticLeak(publishLogs);
    publishCore.close();

    const entityLogs: string[] = [];
    const entityStore = new Store();
    const entityProject = entityStore.createProject({ name: 'diagnostic entity project' });
    const entityCore = makeCore('diagnostic-entity');
    const originalProjectEntity = entityCore.projectEntity.bind(entityCore);
    vi.spyOn(entityCore, 'projectEntity').mockImplementation((input) => {
      if (input.collection === 'project') throw maliciousError('SecretPathError', `${message} ${input.entityId}`);
      return originalProjectEntity(input);
    });
    await new ShadowProductProjection({ host: entityCore, fence: makeFence(), store: entityStore, now: () => now, log: (m) => entityLogs.push(m) }).scheduleReconcile();
    expect(entityLogs).toContain('projection: project skipped (entity-project-failed:Error)');
    expectNoDiagnosticLeak(entityLogs, [entityProject.id]);
    entityCore.close();
  });

  it('restart of Store + host emits NO duplicate events for unchanged state', async () => {
    const store = new Store();
    const core = makeCore('c2');
    const p = new ShadowProductProjection({ host: core, fence: makeFence(), store, now: () => now });
    store.createProject({ name: 'Alpha' });
    store.createProject({ name: 'Beta' });
    const first = await p.scheduleReconcile();
    expect(first.emitted).toBeGreaterThanOrEqual(2);
    core.close();

    // Reopen both against the SAME durable paths.
    const store2 = new Store();
    const core2 = makeCore('c2');
    const p2 = new ShadowProductProjection({ host: core2, fence: makeFence(), store: store2, now: () => now });
    const after = await p2.scheduleReconcile();
    expect(after.emitted).toBe(0); // index persisted → no duplicates
    core2.close();
  });

  it('the durable Store hook triggers a reconcile', async () => {
    const store = new Store();
    const core = makeCore('c3');
    const projection = new ShadowProductProjection({ host: core, fence: makeFence(), store, now: () => now });
    store.onDurableChange(projection.onDurableChange);
    store.createProject({ name: 'Hooked' });
    // The hook fires the async reconcile; let microtasks settle.
    await new Promise((r) => setTimeout(r, 30));
    await projection.scheduleReconcile(); // drain any coalesced follow-up
    expect(core.projectionIndexEntities(makeFence().scopeId, 'project').length).toBe(1);
    store.onDurableChange(null);
    core.close();
  });

  it('a throwing projection listener never breaks Store persistence', async () => {
    const store = new Store();
    store.onDurableChange(() => { throw new Error('listener boom'); });
    const p = store.createProject({ name: 'Survivor' });
    // Store still persisted the project despite the throwing listener.
    expect(store.getProject(p.id)?.name).toBe('Survivor');
    store.onDurableChange(null);
  });

  it('account switch: a different scope has a fully isolated projection index', async () => {
    const store = new Store();
    store.createProject({ name: 'Shared-view Alpha' });
    const coreA = makeCore('cA');
    const coreB = new ShadowHostCore(join(hoisted.dir, 'shadow', 'cB'), new StaticShadowKeyProvider('k1', key));
    const fenceB = makeFence('account:user_2');
    coreB.setAuthority({ accountId: 'acct_2', scopeId: fenceB.scopeId, hostDeviceId: fenceB.hostDeviceId, epoch: 1, leaseId: 'lease_1', leaseExpiresAt: now + 3_600_000 });

    await new ShadowProductProjection({ host: coreA, fence: makeFence(), store, now: () => now }).scheduleReconcile();
    // Account B never projected → its index is empty (no cross-account leakage).
    expect(coreB.projectionIndexEntities(fenceB.scopeId, 'project').length).toBe(0);
    expect(coreA.projectionIndexEntities(makeFence().scopeId, 'project').length).toBe(1);
    coreA.close(); coreB.close();
  });
});
