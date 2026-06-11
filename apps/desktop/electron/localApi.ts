/* The Maestro command surface — ONE dispatcher serving both the desktop UI
   (over IPC) and remote controls (phone/web via the relay). Every command
   executes locally on this Mac against the local store + local engine. */

import type { Store, Effort, ApprovalStatus, EngineId, Routing, AppSettings, ProjectKind } from './store.js';
import type { LocalEngine } from './engine.js';
import type { Providers, ProviderId } from './providers.js';
import { cloneRepo, inspectFolder, repoInfo, gitAvailable } from './git.js';

type Params = Record<string, unknown>;

const bad = (msg: string, statusCode = 400): never => {
  throw Object.assign(new Error(msg), { statusCode });
};

const ENGINE_VALUES = new Set(['claude', 'codex']);
function asEngine(v: unknown): EngineId | undefined {
  return typeof v === 'string' && ENGINE_VALUES.has(v) ? (v as EngineId) : undefined;
}

export function createDispatch(store: Store, engine: LocalEngine, providers: Providers, emit: (name: string, data: unknown) => void, relayUrl = '') {
  return async function dispatch(method: string, params: Params = {}): Promise<unknown> {
    const p = params ?? {};
    switch (method) {
      case 'health':
        return { ok: true, name: 'maestro-desktop', version: '0.3.0', engine: 'claude-code', time: Date.now() };

      // ── Aggregates ─────────────────────────────────────────────
      case 'dashboard': return store.dashboard();
      case 'budget': return store.budget();
      case 'costs': return store.costs();
      case 'listEvents': return store.listEvents();

      // ── Settings ───────────────────────────────────────────────
      case 'getSettings': return store.getSettings();
      case 'setSettings': {
        const patch: Partial<AppSettings> = {};
        if (p.defaultEffort === 'fast' || p.defaultEffort === 'balanced' || p.defaultEffort === 'deep' || p.defaultEffort === 'max') patch.defaultEffort = p.defaultEffort;
        if (p.defaultEngine === 'auto' || p.defaultEngine === 'claude' || p.defaultEngine === 'codex') patch.defaultEngine = p.defaultEngine;
        if (typeof p.openAtLogin === 'boolean') patch.openAtLogin = p.openAtLogin;
        if (p.rescanCadence === 'daily' || p.rescanCadence === 'weekly' || p.rescanCadence === 'onchange') patch.rescanCadence = p.rescanCadence;
        if (Object.keys(patch).length === 0) bad('no valid settings fields');
        const next = store.setSettings(patch);
        emit('settings', next);
        return next;
      }

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
        const kind = (p.kind === 'coding' || p.kind === 'content' || p.kind === 'research' || p.kind === 'general') ? (p.kind as ProjectKind) : undefined;
        const proj = store.createProject({
          name: p.name as string, template: p.template as string | undefined, instructions: p.instructions as string | undefined,
          color: p.color as string | undefined, kind,
          path: typeof p.path === 'string' && p.path ? p.path : undefined,
          repoUrl: typeof p.repoUrl === 'string' && p.repoUrl ? p.repoUrl : undefined,
        });
        emit('project', proj);
        return proj;
      }
      case 'updateProject': {
        const patch: Record<string, unknown> = {};
        for (const k of ['name', 'instructions', 'color', 'template', 'path', 'repoUrl'] as const) {
          if (typeof p[k] === 'string') patch[k] = p[k];
        }
        if (p.kind === 'coding' || p.kind === 'content' || p.kind === 'research' || p.kind === 'general') patch.kind = p.kind;
        if (Object.keys(patch).length === 0) bad('no valid project fields');
        const proj = store.updateProject(String(p.id ?? ''), patch);
        emit('project', proj);
        return proj;
      }

      // ── Coding agent: folders + GitHub clone (git lives on this Mac) ──
      case 'gitAvailable': return { available: gitAvailable() };
      case 'inspectFolder': {
        const dir = String(p.path ?? '');
        if (!dir) bad('path required');
        return inspectFolder(dir);
      }
      case 'getProjectRepo': {
        const proj = store.getProject(String(p.id ?? ''));
        if (!proj) bad('project not found', 404);
        return proj!.path ? repoInfo(proj!.path) : { branch: null, remote: null, isRepo: false };
      }
      case 'cloneRepo': {
        const url = String(p.url ?? '').trim();
        if (!url) bad('url required');
        const name = (typeof p.name === 'string' && p.name.trim()) ? p.name.trim() : undefined;
        emit('clone', { phase: 'start', url });
        try {
          const result = await cloneRepo({ url, dirName: typeof p.dirName === 'string' ? p.dirName : undefined },
            (line) => emit('clone', { phase: 'progress', line }));
          const proj = store.createProject({
            name: name ?? url.split(/[/:]/).pop()?.replace(/\.git$/i, '') ?? 'Repo',
            template: 'claude-code', kind: 'coding', path: result.dir, repoUrl: result.remote,
            instructions: typeof p.instructions === 'string' ? p.instructions : '',
            color: typeof p.color === 'string' ? p.color : 'blue',
          });
          emit('clone', { phase: 'done', projectId: proj.id, dir: result.dir, branch: result.branch });
          emit('project', proj);
          store.pushEvent({ kind: 'clone-done', title: `Cloned ${proj.name}`, subtitle: result.branch ? `branch ${result.branch}` : undefined, projectId: proj.id });
          return proj;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          emit('clone', { phase: 'failed', error: msg });
          store.pushEvent({ kind: 'clone-failed', title: 'Clone failed', subtitle: msg });
          throw e;
        }
      }
      case 'revealProject': {
        // Reveal handled natively in main via maestro:revealPath; this returns the path.
        const proj = store.getProject(String(p.id ?? ''));
        return { path: proj?.path ?? null };
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
      case 'runJob': return engine.run(String(p.id ?? ''), { effort: p.effort as Effort | undefined, engine: asEngine(p.engine) });
      case 'cancelJob': {
        const c = engine.cancel(String(p.id ?? ''));
        return c ?? bad('job is not running', 409);
      }
      case 'deleteJob': { store.deleteJob(String(p.id ?? '')); return { ok: true }; }
      case 'createAndRunJob': {
        if (!p.projectId || !p.input) bad('projectId and input required');
        if (!store.getProject(String(p.projectId))) bad('project not found', 404);
        const j = store.createJob(String(p.projectId), String(p.input), String(p.title ?? ''), (p.effort as Effort) ?? 'balanced');
        emit('job', j);
        return engine.run(j.id, { effort: p.effort as Effort | undefined, engine: asEngine(p.engine) });
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
      case 'deleteSchedule': { store.deleteSchedule(String(p.id ?? '')); return { ok: true }; }

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

      // ── Engine status (THE single source of truth) ────────────
      case 'engineStatus': return engine.statuses();

      // ── Engine routing (which engine plays which role) ─────────
      case 'getRouting': return store.routing();
      case 'setRouting': {
        const patch: Partial<Routing> = {};
        const master = asEngine(p.master);
        if (master) patch.master = master;
        if (p.reviewer === 'off') patch.reviewer = 'off';
        else { const r = asEngine(p.reviewer); if (r) patch.reviewer = r; }
        const image = asEngine(p.image);
        if (image) patch.image = image;
        const video = asEngine(p.video);
        if (video) patch.video = video;
        if (Object.keys(patch).length === 0) bad('no valid routing fields');
        const next = store.setRouting(patch);
        emit('routing', next);
        return next;
      }

      // ── Pairing (desktop-only; never enters relay snapshots) ──
      case 'getPairing': return { token: store.accessToken, relayUrl };

      default:
        return bad(`unknown method: ${method}`, 404);
    }
  };
}
