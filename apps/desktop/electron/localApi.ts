/* The Maestro command surface — ONE dispatcher serving both the desktop UI
   (over IPC) and remote controls (phone/web via the relay). Every command
   executes locally on this Mac against the local store + local engine. */

import type { Store, Effort, ApprovalStatus, EngineId, Routing, Roles, RoleChoice, AppSettings, ProjectKind, AssetStatus } from './store.js';
import { resolveModelKey, buildModelGroups } from './models.js';
import type { LocalEngine } from './engine.js';
import type { MediaEngine } from './media.js';
import type { ResearchEngine } from './research.js';
import type { PublishingEngine } from './publishing.js';
import type { TelegramBot } from './telegram.js';
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
/** Model override: an alias (opus/sonnet/haiku) or a full model id — never shell-special. */
function asModel(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:\[\]-]{0,63}$/.test(v) ? v : undefined;
}

export function createDispatch(store: Store, engine: LocalEngine, media: MediaEngine, research: ResearchEngine, publishing: PublishingEngine, telegram: TelegramBot, providers: Providers, emit: (name: string, data: unknown) => void, relayUrl = '') {
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
        if (Array.isArray(p.favoriteModels)) patch.favoriteModels = (p.favoriteModels as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 40);
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
        const dest = (typeof p.dest === 'string' && p.dest.trim()) ? p.dest.trim() : undefined;
        if (!dest) bad('a destination folder is required');
        const name = (typeof p.name === 'string' && p.name.trim()) ? p.name.trim() : undefined;
        emit('clone', { phase: 'start', url });
        try {
          const result = await cloneRepo({ url, dest, dirName: typeof p.dirName === 'string' ? p.dirName : undefined },
            (line) => emit('clone', { phase: 'progress', line }));
          const proj = store.createProject({
            name: name ?? result.name,
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
      case 'deleteProject': {
        store.deleteProject(String(p.id ?? ''));
        emit('project', { id: String(p.id ?? ''), deleted: true });
        return { ok: true };
      }

      // ── Chat sessions (each turn is a Job with sessionId) ─────
      case 'listSessions': return store.listSessions(p.projectId ? String(p.projectId) : undefined);
      case 'renameSession': {
        if (!p.title || typeof p.title !== 'string') bad('title required');
        const s = store.updateSession(String(p.id ?? ''), { title: (p.title as string).slice(0, 60) });
        emit('session', s);
        return s;
      }
      case 'deleteSession': {
        store.deleteSession(String(p.id ?? ''));
        emit('session', { id: String(p.id ?? ''), deleted: true });
        return { ok: true };
      }
      case 'pinSession': {
        const s = store.setSessionPinned(String(p.id ?? ''), p.pinned === true);
        emit('session', s);
        return s;
      }
      case 'sendChat': {
        const projectId = String(p.projectId ?? '');
        const text = String(p.text ?? '').trim();
        if (!projectId || !text) bad('projectId and text required');
        if (!store.getProject(projectId)) bad('project not found', 404);
        let session = p.sessionId ? store.getSession(String(p.sessionId)) : undefined;
        if (p.sessionId && !session) bad('session not found', 404);
        if (!session) {
          session = store.createSession(projectId, text);
          emit('session', session);
        }
        // Resolve the chosen primary + reviewer. A picker key (modelKey /
        // reviewerKey) is resolved provider-side; legacy engine/model still works.
        const primary = p.modelKey !== undefined
          ? resolveModelKey(String(p.modelKey))
          : { engine: asEngine(p.engine), model: asModel(p.model) };
        let reviewer: RoleChoice | 'off' | undefined;
        if (p.reviewerKey === 'off') reviewer = 'off';
        else if (typeof p.reviewerKey === 'string' && p.reviewerKey) {
          const r = resolveModelKey(p.reviewerKey);
          if (r.engine) reviewer = { engine: r.engine, model: r.model };
        }
        // Persist per-chat overrides so the chat restores them on reopen.
        const sessPatch: { primary?: RoleChoice; reviewer?: RoleChoice | 'off' } = {};
        if (primary.engine) sessPatch.primary = { engine: primary.engine, model: primary.model };
        if (reviewer !== undefined) sessPatch.reviewer = reviewer;
        if (Object.keys(sessPatch).length) { session = store.updateSession(session.id, sessPatch); emit('session', session); }

        const job = store.createJob(projectId, text, text.slice(0, 60), p.effort as Effort | undefined, session.id);
        emit('job', job);
        // Fire the run async — the reply streams in over job events.
        void engine.run(job.id, { effort: p.effort as Effort | undefined, engine: primary.engine, model: primary.model, reviewer, plan: p.plan === true });
        return { session, job };
      }

      // ── Jobs ───────────────────────────────────────────────────
      case 'listJobs': return store.listJobs(p.projectId ? String(p.projectId) : undefined, p.sessionId ? String(p.sessionId) : undefined);
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
      case 'runJob': return engine.run(String(p.id ?? ''), { effort: p.effort as Effort | undefined, engine: asEngine(p.engine), model: asModel(p.model) });
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
        return engine.run(j.id, { effort: p.effort as Effort | undefined, engine: asEngine(p.engine), model: asModel(p.model) });
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
        if (prov !== 'anthropic' && prov !== 'openai' && prov !== 'fal') bad('unsupported provider');
        return providers.connect(prov as ProviderId, String(p.apiKey ?? ''));
      }
      case 'disconnectProvider': {
        const prov = String(p.provider ?? '');
        if (prov !== 'anthropic' && prov !== 'openai' && prov !== 'fal') bad('unsupported provider');
        providers.disconnect(prov as ProviderId);
        return { ok: true };
      }

      // ── Media Studio (real fal generation) ─────────────────────
      case 'mediaRates': return media.rates();
      case 'listAssets': return store.listAssets({ projectId: p.projectId ? String(p.projectId) : undefined, status: p.status as AssetStatus | undefined });
      case 'getAsset': { const a = store.getAsset(String(p.id ?? '')); return a ?? bad('asset not found', 404); }
      case 'generateAsset': {
        if (!p.modelKey || !p.prompt) bad('modelKey and prompt required');
        return media.generate({
          projectId: p.projectId ? String(p.projectId) : null,
          modelKey: String(p.modelKey), prompt: String(p.prompt),
          durationS: typeof p.durationS === 'number' ? p.durationS : undefined,
          voice: typeof p.voice === 'string' ? p.voice : undefined,
          imageUrl: typeof p.imageUrl === 'string' ? p.imageUrl : undefined,
          aspect: typeof p.aspect === 'string' ? p.aspect : undefined,
        });
      }
      case 'cancelAsset': return media.cancel(String(p.id ?? ''));
      case 'deleteAsset': { const removed = store.deleteAsset(String(p.id ?? '')); emit('asset', { ...removed, status: 'deleted' }); return { ok: true }; }
      case 'approveAsset': {
        const a = store.updateAsset(String(p.id ?? ''), { status: 'approved' });
        emit('asset', a);
        return a;
      }

      // ── Trends (real web research → content briefs) ────────────
      case 'runResearch': {
        if (!p.topic || typeof p.topic !== 'string') bad('topic required');
        return research.runResearch(p.topic as string);
      }
      case 'listBriefs': return store.listBriefs();
      case 'listResearchRuns': return store.listResearchRuns();
      case 'markBriefSent': { const b = store.setBriefStatus(String(p.id ?? ''), 'sent-to-studio'); emit('briefs', [b]); return b; }

      // ── Publishing (local export pipeline) ─────────────────────
      case 'listPublishDrafts': return store.listPublishDrafts();
      case 'listPublishLedger': return store.listPublishLedger();
      case 'importAsset': return publishing.importAsset(String(p.path ?? ''), (p.projectId as string) ?? null);
      case 'createDraft': {
        if (!p.assetId) bad('assetId required');
        return publishing.createDraft({ assetId: String(p.assetId), caption: typeof p.caption === 'string' ? p.caption : undefined, platforms: Array.isArray(p.platforms) ? (p.platforms as string[]) : undefined });
      }
      case 'updateDraft': {
        const patch: Record<string, unknown> = {};
        if (typeof p.caption === 'string') patch.caption = p.caption;
        if (Array.isArray(p.platforms)) patch.platforms = p.platforms;
        if (typeof p.scheduledAt === 'number' || p.scheduledAt === null) patch.scheduledAt = p.scheduledAt;
        if (p.status === 'draft' || p.status === 'approved' || p.status === 'scheduled') patch.status = p.status;
        const d = store.updatePublishDraft(String(p.id ?? ''), patch);
        emit('publishDraft', d);
        return d;
      }
      case 'deleteDraft': { store.deletePublishDraft(String(p.id ?? '')); return { ok: true }; }
      case 'scheduleDraft': {
        const at = Number(p.scheduledAt);
        if (!Number.isFinite(at)) bad('scheduledAt required');
        const d = store.updatePublishDraft(String(p.id ?? ''), { status: 'scheduled', scheduledAt: at });
        emit('publishDraft', d);
        return d;
      }
      case 'exportDraft': return publishing.exportDraft(String(p.id ?? ''));
      case 'markPublished': return publishing.markPublished(String(p.id ?? ''));

      // ── Comms (Telegram bot) ───────────────────────────────────
      case 'commsStatus': return store.commsStatus();
      case 'listChatBindings': return store.listChatBindings();
      case 'listPendingChats': return store.listPendingChats();
      case 'listCommEvents': return store.listCommEvents();
      case 'connectTelegram': {
        if (!p.token || typeof p.token !== 'string') bad('token required');
        return telegram.connect(p.token as string);
      }
      case 'disconnectTelegram': { telegram.disconnect(); return { ok: true }; }
      case 'bindChat': {
        if (!p.chatId) bad('chatId required');
        const pending = store.listPendingChats().find(c => c.chatId === String(p.chatId));
        const perms = (p.permissions && typeof p.permissions === 'object') ? p.permissions as Record<string, boolean> : {};
        const b = store.bindChat({
          chatId: String(p.chatId), name: String(p.name ?? pending?.name ?? p.chatId), kind: (pending?.kind ?? 'dm'),
          projectId: (p.projectId as string) ?? null,
          permissions: { startJobs: perms.startJobs ?? true, receiveReports: perms.receiveReports ?? true, approveGates: perms.approveGates ?? false },
        });
        emit('comms', store.commsStatus());
        return b;
      }
      case 'unbindChat': { store.unbindChat(String(p.chatId ?? '')); emit('comms', store.commsStatus()); return { ok: true }; }
      case 'setChatPermissions': {
        if (!p.chatId || !p.permissions || typeof p.permissions !== 'object') bad('chatId and permissions required');
        const b = store.setChatPermissions(String(p.chatId), p.permissions as Record<string, boolean>);
        emit('comms', store.commsStatus());
        return b;
      }

      // ── Engine status (THE single source of truth) ────────────
      case 'engineStatus': return engine.statuses();

      // ── Model registry (provider-owned catalog) ───────────────
      case 'listModels': return buildModelGroups(engine.statuses());

      // ── Roles (model-level primary / reviewer) ─────────────────
      case 'getRoles': return store.getRoles();
      case 'setRoles': {
        const patch: Partial<Roles> = {};
        if (typeof p.primaryKey === 'string') {
          const r = resolveModelKey(p.primaryKey);
          if (r.engine) patch.primary = { engine: r.engine, model: r.model };
        } else if (p.primary && typeof p.primary === 'object') {
          const pr = p.primary as { engine?: unknown; model?: unknown };
          const e = asEngine(pr.engine);
          if (e) patch.primary = { engine: e, model: asModel(pr.model) };
        }
        if (p.reviewerKey === 'off' || p.reviewer === 'off') patch.reviewer = 'off';
        else if (typeof p.reviewerKey === 'string') {
          const r = resolveModelKey(p.reviewerKey);
          if (r.engine) patch.reviewer = { engine: r.engine, model: r.model };
        } else if (p.reviewer && typeof p.reviewer === 'object') {
          const rv = p.reviewer as { engine?: unknown; model?: unknown };
          const e = asEngine(rv.engine);
          if (e) patch.reviewer = { engine: e, model: asModel(rv.model) };
        }
        if (Object.keys(patch).length === 0) bad('no valid role fields');
        const next = store.setRoles(patch);
        emit('routing', store.routing());
        return next;
      }

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
