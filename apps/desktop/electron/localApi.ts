/* The Maestro command surface — ONE dispatcher serving both the desktop UI
   (over IPC) and remote controls (phone/web via the relay). Every command
   executes locally on this Mac against the local store + local engine. */

import type { Store, Effort, ApprovalStatus } from './store.js';
import type { LocalEngine } from './engine.js';
import type { Providers, ProviderId } from './providers.js';

type Params = Record<string, unknown>;

const bad = (msg: string, statusCode = 400): never => {
  throw Object.assign(new Error(msg), { statusCode });
};

export function createDispatch(store: Store, engine: LocalEngine, providers: Providers, emit: (name: string, data: unknown) => void) {
  return async function dispatch(method: string, params: Params = {}): Promise<unknown> {
    const p = params ?? {};
    switch (method) {
      case 'health':
        return { ok: true, name: 'maestro-desktop', version: '0.3.0', engine: 'claude-code', time: Date.now() };

      // ── Aggregates ─────────────────────────────────────────────
      case 'dashboard': return store.dashboard();
      case 'budget': return store.budget();

      // ── Workspace ──────────────────────────────────────────────
      case 'listWorkspaces': { const w = store.workspace(); return w ? [w] : []; }
      case 'createWorkspace': {
        if (!p.name || typeof p.name !== 'string') bad('name required');
        return store.createWorkspace(p.name as string, typeof p.budgetCap === 'number' ? p.budgetCap : 200);
      }
      case 'setBudgetCap': {
        const cap = Number(p.cap);
        if (!Number.isFinite(cap) || cap <= 0) bad('cap must be a positive number');
        store.setBudgetCap(cap);
        return { ok: true, cap };
      }

      // ── Projects ───────────────────────────────────────────────
      case 'listProjects': return store.listProjects();
      case 'getProject': {
        const proj = store.getProject(String(p.id ?? ''));
        return proj ?? bad('project not found', 404);
      }
      case 'createProject': {
        if (!p.name || typeof p.name !== 'string') bad('name required');
        const proj = store.createProject({ name: p.name as string, template: p.template as string | undefined, instructions: p.instructions as string | undefined, color: p.color as string | undefined });
        emit('project', proj);
        return proj;
      }

      // ── Jobs ───────────────────────────────────────────────────
      case 'listJobs': return store.listJobs(p.projectId ? String(p.projectId) : undefined);
      case 'getJob': {
        const j = store.getJob(String(p.id ?? ''));
        return j ?? bad('job not found', 404);
      }
      case 'createJob': {
        if (!p.projectId || !p.input) bad('projectId and input required');
        if (!store.getProject(String(p.projectId))) bad('project not found', 404);
        const j = store.createJob(String(p.projectId), String(p.input), String(p.title ?? ''), (p.effort as Effort) ?? 'balanced');
        emit('job', j);
        return j;
      }
      case 'runJob': return engine.run(String(p.id ?? ''), p.effort as Effort | undefined);
      case 'createAndRunJob': {
        if (!p.projectId || !p.input) bad('projectId and input required');
        if (!store.getProject(String(p.projectId))) bad('project not found', 404);
        const j = store.createJob(String(p.projectId), String(p.input), String(p.title ?? ''), (p.effort as Effort) ?? 'balanced');
        emit('job', j);
        return engine.run(j.id, p.effort as Effort | undefined);
      }

      // ── Approvals ──────────────────────────────────────────────
      case 'listApprovals': return store.listApprovals(p.status as ApprovalStatus | undefined);
      case 'approveApproval': { const a = store.resolveApproval(String(p.id ?? ''), 'approved'); emit('approval', a); return a; }
      case 'denyApproval': { const a = store.resolveApproval(String(p.id ?? ''), 'denied'); emit('approval', a); return a; }

      // ── Schedules ──────────────────────────────────────────────
      case 'listSchedules': return store.listSchedules();
      case 'createSchedule': {
        if (!p.title || typeof p.title !== 'string') bad('title required');
        return store.createSchedule({ title: p.title as string, projectId: (p.projectId as string) ?? null, time: p.time as string | undefined, cadence: p.cadence as string | undefined });
      }
      case 'toggleSchedule': { store.setScheduleEnabled(String(p.id ?? ''), Boolean(p.enabled)); return { ok: true }; }

      // ── Skills / Templates ─────────────────────────────────────
      case 'listSkills': return store.listSkills();
      case 'toggleSkill': {
        const s = store.toggleSkill(String(p.id ?? ''));
        return s ?? bad('skill not found', 404);
      }
      case 'listTemplates': return store.listTemplates();

      // ── Providers (all local: CLI logins + Keychain-encrypted keys) ─
      case 'listProviders': return providers.list();
      case 'connectProvider': {
        const prov = String(p.provider ?? '');
        if (prov !== 'anthropic' && prov !== 'openai') bad('unsupported provider');
        return providers.connect(prov as ProviderId, String(p.apiKey ?? ''));
      }
      case 'disconnectProvider': {
        const prov = String(p.provider ?? '');
        if (prov !== 'anthropic' && prov !== 'openai') bad('unsupported provider');
        providers.disconnect(prov as ProviderId);
        return { ok: true };
      }

      default:
        return bad(`unknown method: ${method}`, 404);
    }
  };
}
