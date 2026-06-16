/* The Maestro command surface — ONE dispatcher serving both the desktop UI
   (over IPC) and remote controls (phone/web via the relay). Every command
   executes locally on this Mac against the local store + local engine. */

import type { Store, Effort, ApprovalStatus, EngineId, Routing, Roles, RoleChoice, AppSettings, ProjectKind, AssetStatus, ChatImage, ChatFile, TranscriptItem, FeedbackCategory, FeedbackContext, FeedbackSource } from './store.js';
import { resolveModelKey, buildModelGroups } from './models.js';
import type { LocalEngine } from './engine.js';
import type { MediaEngine } from './media.js';
import type { ResearchEngine } from './research.js';
import type { PublishingEngine } from './publishing.js';
import type { TelegramBot } from './telegram.js';
import type { Providers, ProviderId } from './providers.js';
import { cloneRepo, inspectFolder, repoInfo, gitAvailable, snapshotProject } from './git.js';
import { pruneSessionWorktree, worktreeRootDir } from './session-worktree.js';
import { githubConnectionStatus, ghCliToken } from './github-auth.js';
import type { GitService } from './git-service.js';
import type { ExtensionBridge } from './extension-bridge.js';
import { readProjectState, writeProjectState, listCheckpoints } from './continuum.js';
import { registryBase, searchRegistry, registryMeta, getRegistrySkill, fetchSkillContent, installSkillFiles, removeSkillFiles, setSkillFilesEnabled, listInstalledSlugsDetailed, skillSlug } from './skills-registry.js';
import { scanConversations, parseConversation, type ConvSource } from './conversation-sync.js';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { app } from 'electron';

type Params = Record<string, unknown>;

const bad = (msg: string, statusCode = 400): never => {
  throw Object.assign(new Error(msg), { statusCode });
};

/** A GitHub "owner/repo" slug: each side must start AND end alphanumeric, so
    junk like `owner/..`, `../repo`, or `a/.` is rejected (no traversal-ish names). */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const ENGINE_VALUES = new Set(['claude', 'codex']);
/** A project's working root on disk — its own folder, or ~/Maestro/<name>. */
function projectRootOf(proj: { name?: string; path?: string }): string {
  if (proj.path && existsSync(proj.path)) return proj.path;
  const safe = (proj.name || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
  return nodePath.join(homedir(), 'Maestro', safe);
}

function asEngine(v: unknown): EngineId | undefined {
  return typeof v === 'string' && ENGINE_VALUES.has(v) ? (v as EngineId) : undefined;
}
/** Model override: an alias (opus/sonnet/haiku) or a full model id — never shell-special. */
function asModel(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:\[\]-]{0,63}$/.test(v) ? v : undefined;
}

export function createDispatch(store: Store, engine: LocalEngine, media: MediaEngine, research: ResearchEngine, publishing: PublishingEngine, telegram: TelegramBot, providers: Providers, emit: (name: string, data: unknown) => void, relayUrl = '', gitService?: GitService, getExtensionBridge?: () => ExtensionBridge | null) {
  return async function dispatch(method: string, params: Params = {}): Promise<unknown> {
    const p = params ?? {};
    switch (method) {
      case 'health':
        return { ok: true, name: 'maestro-desktop', version: app.getVersion(), engine: 'claude-code', time: Date.now() };

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
        if (typeof p.feedbackRepo === 'string') { // '' clears it; otherwise must look like owner/repo
          const v = p.feedbackRepo.trim().slice(0, 140);
          if (v === '' || REPO_RE.test(v)) patch.feedbackRepo = v;
        }
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
      // Per-project .continuum memory (STATE.md + checkpoint chain).
      case 'getProjectMemory': {
        const proj = store.getProject(String(p.id ?? ''));
        if (!proj) return bad('project not found', 404);
        const root = projectRootOf(proj);
        return { state: readProjectState(root), checkpoints: listCheckpoints(root, 50) };
      }
      case 'setProjectMemory': {
        const proj = store.getProject(String(p.id ?? ''));
        if (!proj) return bad('project not found', 404);
        writeProjectState(projectRootOf(proj), typeof p.state === 'string' ? p.state : '');
        return { ok: true };
      }
      // Commit a referable snapshot of the project (design + attachments).
      case 'snapshotProject': {
        const proj = store.getProject(String(p.id ?? ''));
        if (!proj) return bad('project not found', 404);
        return snapshotProject(projectRootOf(proj), typeof p.message === 'string' ? p.message : 'snapshot');
      }
      // Per-element design comments (Mochi-style commenting over the live preview).
      case 'listDesignComments': {
        return { comments: store.listDesignComments(String(p.id ?? '')) };
      }
      case 'addDesignComment': {
        const proj = store.getProject(String(p.id ?? ''));
        if (!proj) return bad('project not found', 404);
        const c = store.addDesignComment(proj.id, {
          selector: String(p.selector ?? ''), label: String(p.label ?? ''), note: String(p.note ?? ''),
        });
        return { comment: c };
      }
      case 'setDesignCommentStatus': {
        store.setDesignCommentStatus(String(p.id ?? ''), String(p.commentId ?? ''), p.status === 'resolved' ? 'resolved' : 'open');
        return { ok: true };
      }
      case 'deleteDesignComment': {
        store.deleteDesignComment(String(p.id ?? ''), String(p.commentId ?? ''));
        return { ok: true };
      }
      // ── Browser-extension control channel (local-only; blocked from relay) ──
      case 'extensionStatus': {
        const b = getExtensionBridge?.();
        return b ? b.status() : { running: false, port: 0, token: store.extensionToken, peers: [] };
      }
      case 'extensionSetActive': {
        const b = getExtensionBridge?.();
        if (!b) bad('extension channel unavailable', 503);
        return b!.setActiveFromApp(String(p.clientId ?? ''));
      }
      // Hand off a design to code: COPY the design's folder (design/index.html +
      // assets + .continuum memory) into a NEW coding project so the design lives
      // in BOTH the Design tab and the CodeSpace. The coding agent then scaffolds
      // a real app in this copy, with design/index.html as the visual reference.
      case 'copyDesignToCode': {
        const design = store.getProject(String(p.id ?? ''));
        if (!design || design.kind !== 'design') return bad('design project not found', 404);
        const src = projectRootOf(design);
        if (!existsSync(src)) return bad('design folder not found', 404);
        const safe = (design.name || 'design').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'design';
        const dest = nodePath.join(homedir(), 'Maestro', `${safe}-code-${Math.random().toString(36).slice(2, 8)}`);
        mkdirSync(dest, { recursive: true });
        // Copy everything except heavy/irrelevant trees (node_modules, .git).
        cpSync(src, dest, { recursive: true, filter: (s) => !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(s) });
        const proj = store.createProject({
          name: typeof p.name === 'string' && p.name ? p.name : `${design.name} (code)`,
          template: 'blank', color: 'blue', kind: 'coding', path: dest,
        });
        emit('project', proj);
        return proj;
      }
      case 'createProject': {
        if (!p.name || typeof p.name !== 'string') bad('name required');
        const kind = (p.kind === 'coding' || p.kind === 'design' || p.kind === 'content' || p.kind === 'research' || p.kind === 'general') ? (p.kind as ProjectKind) : undefined;
        let projPath = typeof p.path === 'string' && p.path ? p.path : undefined;
        // Design projects get a UNIQUE folder (id-suffixed) so two similarly-named
        // designs never share a folder/preview/memory/git (name-only dirs collide).
        if (!projPath && kind === 'design') {
          const safe = (p.name as string).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'design';
          projPath = nodePath.join(homedir(), 'Maestro', `${safe}-${Math.random().toString(36).slice(2, 8)}`);
          try { mkdirSync(nodePath.join(projPath, 'design'), { recursive: true }); } catch { /* best effort */ }
        }
        const proj = store.createProject({
          name: p.name as string, template: p.template as string | undefined, instructions: p.instructions as string | undefined,
          color: p.color as string | undefined, kind,
          path: projPath,
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
        if (p.kind === 'coding' || p.kind === 'design' || p.kind === 'content' || p.kind === 'research' || p.kind === 'general') patch.kind = p.kind;
        if (Object.keys(patch).length === 0) bad('no valid project fields');
        const proj = store.updateProject(String(p.id ?? ''), patch);
        emit('project', proj);
        return proj;
      }
      case 'reorderProjects': {
        const ids = Array.isArray(p.ids) ? (p.ids as unknown[]).map(String) : [];
        if (!ids.length) bad('ids required');
        return store.reorderProjects(ids);
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
        const s = store.getSession(String(p.id ?? ''));
        if (s?.worktreePath) {
          const proj = store.getProject(s.projectId);
          if (proj?.path) {
            try { pruneSessionWorktree({ repoDir: proj.path, worktreeRoot: worktreeRootDir(), projectId: proj.id, sessionId: s.id, branch: s.branch, deleteBranch: false }); } catch { /* best effort */ }
          }
        }
        store.deleteSession(String(p.id ?? ''));
        emit('session', { id: String(p.id ?? ''), deleted: true });
        return { ok: true };
      }
      case 'pinSession': {
        const s = store.setSessionPinned(String(p.id ?? ''), p.pinned === true);
        emit('session', s);
        return s;
      }
      case 'archiveSession': {
        const s = store.setSessionArchived(String(p.id ?? ''), p.archived === true);
        emit('session', s);
        return s;
      }
      // Worktree archive (Conductor PR lifecycle): prune this session's git worktree.
      case 'archiveSessionWorktree': {
        const s = store.getSession(String(p.sessionId ?? p.id ?? ''));
        if (!s) return bad('session not found', 404);
        const proj = store.getProject(s.projectId);
        if (proj?.path && s.worktreePath) {
          try { pruneSessionWorktree({ repoDir: proj.path, worktreeRoot: worktreeRootDir(), projectId: proj.id, sessionId: s.id, branch: s.branch, deleteBranch: p.deleteBranch === true }); } catch { /* best effort */ }
        }
        const updated = store.updateSession(s.id, { archivedAt: Date.now(), worktreePath: undefined });
        emit('session', updated);
        return updated;
      }
      // Per-session git/PR status (local facts + live PR). Emits a git-status event too.
      case 'getSessionGitStatus': {
        if (!gitService) return bad('git service unavailable', 500);
        const s = store.getSession(String(p.sessionId ?? ''));
        if (!s) return bad('session not found', 404);
        return gitService.fullStatus(s, { withPr: p.withPr !== false });
      }
      case 'refreshSessionGitStatus': {
        if (!gitService) return bad('git service unavailable', 500);
        const s = store.getSession(String(p.sessionId ?? ''));
        if (!s) return bad('session not found', 404);
        return gitService.fullStatus(s, { withPr: true });
      }
      // ── PR actions (DESKTOP-ONLY, outward — UI confirms before calling) ─
      case 'pushSession': {
        if (!gitService) return bad('git service unavailable', 500);
        const s = store.getSession(String(p.sessionId ?? '')); if (!s) return bad('session not found', 404);
        return gitService.pushSession(s);
      }
      case 'createSessionPR': {
        if (!gitService) return bad('git service unavailable', 500);
        const s = store.getSession(String(p.sessionId ?? '')); if (!s) return bad('session not found', 404);
        return gitService.createPr(s, {
          title: typeof p.title === 'string' ? p.title : undefined,
          body: typeof p.body === 'string' ? p.body : undefined,
          base: typeof p.base === 'string' ? p.base : undefined,
        });
      }
      case 'mergeSessionPR': {
        if (!gitService) return bad('git service unavailable', 500);
        const s = store.getSession(String(p.sessionId ?? '')); if (!s) return bad('session not found', 404);
        const method = p.method === 'merge' || p.method === 'squash' || p.method === 'rebase' ? p.method : undefined;
        return gitService.mergePr(s, { method });
      }
      case 'resolveSession': {
        if (!gitService) return bad('git service unavailable', 500);
        const s = store.getSession(String(p.sessionId ?? '')); if (!s) return bad('session not found', 404);
        return gitService.resolveSession(s);
      }

      // ── Conversation sync (import Claude/Codex/Conductor history) ──────────
      // DESKTOP-ONLY (reads local agent stores + the Conductor SQLite db). Guarded
      // from the relay in main.ts. Scans the project's folder for past conversations.
      case 'scanConversations': {
        const proj = store.getProject(String(p.projectId ?? ''));
        if (!proj) bad('project not found', 404);
        const root = projectRootOf(proj!);
        const { available, conversations } = scanConversations(root);
        const seen = store.importedExternalIds(proj!.id);
        return {
          available,
          path: root,
          conversations: conversations.map(c => ({ ...c, imported: seen.has(c.externalId) })),
        };
      }
      case 'importConversations': {
        const proj = store.getProject(String(p.projectId ?? ''));
        if (!proj) bad('project not found', 404);
        const items = Array.isArray(p.items) ? p.items as Array<{ source?: string; externalId?: string; filePath?: string; title?: string; createdAt?: number; updatedAt?: number }> : [];
        if (!items.length) bad('items required');
        const seen = store.importedExternalIds(proj!.id);
        const VALID = new Set<ConvSource>(['claude', 'codex', 'conductor']);
        let imported = 0;
        const sessions = [];
        for (const it of items) {
          const source = it.source as ConvSource;
          const externalId = String(it.externalId ?? '');
          if (!VALID.has(source) || !externalId || seen.has(externalId)) continue;
          const turns = parseConversation(source, { filePath: it.filePath, externalId });
          if (!turns.length) continue;
          const mapped = turns.map(t => ({
            input: t.input,
            output: t.output,
            createdAt: t.createdAt,
            transcript: t.transcript.map((b): TranscriptItem => ({
              kind: b.kind,
              text: b.text,
              ...(b.name ? { name: b.name } : {}),
              ...(b.kind === 'tool' ? { toolStatus: 'done' as const } : {}),
              ts: b.ts || t.createdAt,
            })),
          }));
          const createdAt = turns[0]?.createdAt || Number(it.createdAt) || Date.now();
          const updatedAt = Number(it.updatedAt) || turns[turns.length - 1]?.createdAt || createdAt;
          const { session } = store.commitImportedConversation({
            projectId: proj!.id, title: String(it.title ?? '') || `${source} chat`, source, externalId, createdAt, updatedAt, turns: mapped,
          });
          emit('session', session);
          sessions.push(session);
          seen.add(externalId);
          imported++;
        }
        return { imported, sessions };
      }
      case 'sendChat': {
        const projectId = String(p.projectId ?? '');
        const text = String(p.text ?? '').trim();
        const rawImages = Array.isArray(p.images) ? p.images as Array<{ dataB64?: string; mime?: string; name?: string }> : [];
        const rawFiles = Array.isArray(p.files) ? p.files as Array<{ name?: string; mime?: string; kind?: string; content?: string; dataB64?: string }> : [];
        if (!projectId || (!text && !rawImages.length && !rawFiles.length)) bad('projectId and a message, image, or file required');
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

        // Ingest pasted/dropped images as Assets (vision input). The bytes stay on
        // the Mac; the job carries only asset refs. Capped to bound payload + spend.
        const inputImages: ChatImage[] = [];
        const seenAssets = new Set<string>();
        for (const im of rawImages.slice(0, 8)) {
          const b64 = String(im?.dataB64 ?? '');
          if (!b64) continue;
          let buf: Buffer;
          try { buf = Buffer.from(b64, 'base64'); } catch { continue; }
          if (!buf.length || buf.length > 16 * 1024 * 1024) continue;
          try {
            const asset = publishing.importAssetBytes(buf, String(im?.name ?? 'pasted.png'), projectId);
            if (seenAssets.has(asset.id)) continue; // identical bytes attached twice → one entry
            seenAssets.add(asset.id);
            inputImages.push({ assetId: asset.id, imagePath: asset.localPath ?? '', mime: String(im?.mime ?? 'image/png'), name: asset.name, width: asset.width, height: asset.height });
          } catch { /* skip an unreadable image */ }
        }

        // Ingest non-image attachments. Text (pasted text / code files) is inlined
        // into the prompt; other files are saved on the Mac and referenced by path.
        const inputFiles: ChatFile[] = [];
        for (const f of rawFiles.slice(0, 12)) {
          const name = String(f?.name ?? 'file').slice(0, 200);
          if (f?.kind === 'text') {
            const content = String(f?.content ?? '');
            if (!content.trim()) continue;
            const capped = content.slice(0, 256 * 1024); // bound the prompt
            inputFiles.push({ name, kind: 'text', bytes: content.length, content: capped, preview: content.slice(0, 160).replace(/\s+/g, ' ').trim() });
          } else {
            const b64 = String(f?.dataB64 ?? '');
            if (!b64) continue;
            let buf: Buffer;
            try { buf = Buffer.from(b64, 'base64'); } catch { continue; }
            if (!buf.length || buf.length > 30 * 1024 * 1024) continue;
            try {
              const savedPath = publishing.saveAttachmentFile(buf, name, projectId);
              inputFiles.push({ name, kind: 'file', mime: String(f?.mime ?? ''), bytes: buf.length, path: savedPath, preview: name });
            } catch { /* skip an unwritable file */ }
          }
        }

        const job = store.createJob(projectId, text, text.slice(0, 60), p.effort as Effort | undefined, session.id, inputImages.length ? inputImages : undefined, inputFiles.length ? inputFiles : undefined);
        emit('job', job);
        // Fire the run async — the reply streams in over job events.
        void engine.run(job.id, { effort: p.effort as Effort | undefined, engine: primary.engine, model: primary.model, reviewer, plan: p.plan === true, goal: p.goal === true });
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

      // ── Background tasks (long-lived processes the agent started) ──
      case 'listBgTasks': return engine.bgList(p.projectId ? String(p.projectId) : undefined);
      case 'bgOutput': {
        const r = engine.bgOutput(String(p.id ?? ''), typeof p.tailKB === 'number' ? p.tailKB : undefined);
        return r ?? bad('background task not found', 404);
      }
      case 'stopBgTask': {
        const r = engine.bgStop(String(p.id ?? ''));
        return r ?? bad('background task not found', 404);
      }
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
      // Wait-&-check: schedule a one-shot follow-up that pokes a chat after delayMs.
      case 'scheduleCheck': {
        const delayMs = Number(p.delayMs);
        if (!Number.isFinite(delayMs) || delayMs < 30_000) bad('delayMs must be at least 30000');
        const prompt = typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt.trim().slice(0, 4000) : 'Check on the task and continue where you left off.';
        const sched = store.createSchedule({
          projectId: p.projectId ? String(p.projectId) : null,
          sessionId: p.sessionId ? String(p.sessionId) : undefined,
          title: prompt.slice(0, 50), prompt, fireAt: Date.now() + delayMs,
        });
        emit('schedule', sched);
        return sched;
      }

      // ── Skills / Templates ─────────────────────────────────────
      case 'listSkills': return store.listSkills();
      case 'toggleSkill': {
        const s = store.toggleSkill(String(p.id ?? ''));
        return s ?? bad('skill not found', 404);
      }
      case 'listTemplates': return store.listTemplates();

      // ── Skill registry (search + install secure skills into a project) ──
      case 'searchSkills': {
        return searchRegistry(registryBase(relayUrl), String(p.q ?? ''), Number(p.limit) || 30);
      }
      case 'skillRegistryMeta': {
        return registryMeta(registryBase(relayUrl)).catch(() => ({ count: 0, generatedAt: '', source: '', note: 'registry unreachable' }));
      }
      case 'registryGetSkill': {
        const id = String(p.id ?? p.skillId ?? '');
        if (!id) return bad('skill id required');
        return getRegistrySkill(registryBase(relayUrl), id);
      }
      case 'registrySkillContent': {
        const id = String(p.id ?? p.skillId ?? '');
        if (!id) return bad('skill id required');
        return fetchSkillContent(registryBase(relayUrl), id);
      }
      case 'listProjectSkills': {
        // The on-disk .claude/skills folder is the source of truth for what's
        // actually active. Reconcile the store records (operator- AND agent-added)
        // with disk so: (a) every active skill shows incl. ones the model installed
        // mid-run, (b) enabled state reflects the real SKILL.md vs .disabled file,
        // (c) a folder dropped in outside the app still appears.
        const projId = String(p.id ?? '');
        const proj = store.getProject(projId);
        const records = store.listInstalledSkills(projId);
        if (!proj) return { skills: records };
        const disk = listInstalledSlugsDetailed(projectRootOf(proj));
        const diskBySlug = new Map(disk.map(d => [d.slug, d]));
        // Always show a recorded skill — never silently drop one just because the disk
        // scan missed it (path quirks shouldn't make installed skills vanish from the
        // UI). When the folder IS found, trust its real enabled state (SKILL.md vs
        // .disabled); otherwise fall back to the record's flag.
        const skills = records.map(r => {
          const d = diskBySlug.get(r.slug);
          diskBySlug.delete(r.slug);
          return d ? { ...r, enabled: d.enabled } : r;
        });
        // Folders on disk with no record (e.g. dropped in manually / by another tool).
        for (const d of diskBySlug.values()) {
          skills.push({ id: d.slug, slug: d.slug, name: d.slug, enabled: d.enabled, addedBy: 'agent', installedAt: 0 });
        }
        return { skills };
      }
      case 'addSkillToProject': {
        const proj = store.getProject(String(p.projectId ?? p.id ?? ''));
        if (!proj) return bad('project not found', 404);
        const skillId = String(p.skillId ?? '');
        if (!skillId) return bad('skillId required');
        const content = await fetchSkillContent(registryBase(relayUrl), skillId);
        const root = projectRootOf(proj);
        mkdirSync(root, { recursive: true });
        const slug = installSkillFiles(root, skillId, content.skillMd);
        const rec = store.recordSkillInstall(proj.id, {
          id: skillId, slug, name: typeof p.name === 'string' && p.name ? p.name : content.name,
          description: typeof p.description === 'string' ? p.description : undefined,
          risk: typeof p.risk === 'string' ? p.risk : undefined,
          source: typeof p.source === 'string' ? p.source : undefined,
          version: typeof p.version === 'string' ? p.version : 'latest',
          sha256: content.sha256,
          enabled: content.enabled !== false,
          disabledReason: typeof p.disabledReason === 'string' ? p.disabledReason : undefined,
          mirrorRepo: typeof p.mirrorRepo === 'string' ? p.mirrorRepo : undefined,
          auditStatus: typeof p.auditStatus === 'string' ? p.auditStatus : undefined,
          addedBy: p.via === 'agent' ? 'agent' : 'operator',
        });
        return { skill: rec };
      }
      case 'setProjectSkillEnabled': {
        const proj = store.getProject(String(p.projectId ?? p.id ?? ''));
        if (!proj) return bad('project not found', 404);
        const idOrSlug = String(p.skillId ?? p.slug ?? '');
        if (!idOrSlug) return bad('skillId required');
        const enabled = Boolean(p.enabled);
        // Move the SKILL.md on disk so Claude's settingSources actually stops/starts
        // loading it, then mirror the flag in the store record.
        const ok = setSkillFilesEnabled(projectRootOf(proj), idOrSlug, enabled);
        let rec = store.setInstalledSkillEnabled(proj.id, idOrSlug, enabled);
        if (!rec) { // disk-only skill with no record yet — create one so the flag sticks
          const slug = skillSlug(idOrSlug);
          rec = store.ensureInstalledSkill(proj.id, { id: idOrSlug, slug, name: slug, enabled, addedBy: 'agent' });
          store.setInstalledSkillEnabled(proj.id, idOrSlug, enabled);
        }
        return { ok, skill: rec };
      }
      case 'removeSkillFromProject': {
        const proj = store.getProject(String(p.projectId ?? p.id ?? ''));
        if (!proj) return bad('project not found', 404);
        const idOrSlug = String(p.skillId ?? p.slug ?? '');
        removeSkillFiles(projectRootOf(proj), idOrSlug); // skills-registry slugs the last path segment
        store.removeInstalledSkill(proj.id, idOrSlug);
        return { ok: true };
      }

      // ── Providers (all local: CLI logins + Keychain-encrypted keys) ─
      case 'listProviders': return providers.list();
      case 'connectProvider': {
        const prov = String(p.provider ?? '');
        if (prov !== 'anthropic' && prov !== 'openai' && prov !== 'fal' && prov !== 'github') bad('unsupported provider');
        return providers.connect(prov as ProviderId, String(p.apiKey ?? ''));
      }
      case 'disconnectProvider': {
        const prov = String(p.provider ?? '');
        if (prov !== 'anthropic' && prov !== 'openai' && prov !== 'fal' && prov !== 'github') bad('unsupported provider');
        providers.disconnect(prov as ProviderId);
        return { ok: true };
      }
      // Codex ChatGPT OAuth, driven by the bundled CLI. Opens the system browser;
      // resolves once signed in. Available even when already signed in (re-auth).
      case 'codexLogin': return engine.codexLogin();
      case 'codexLoginCancel': return engine.codexLoginCancel();
      case 'codexLogout': return engine.codexLogout();

      // ── Engine binaries (Codex / Claude) — downloaded on demand, not bundled.
      case 'enginesStatus': return engine.enginesStatus();
      case 'installEngine': {
        const id = String(p.engine ?? '');
        if (!ENGINE_VALUES.has(id)) bad('unsupported engine');
        return engine.installEngine(id as EngineId);
      }
      case 'cancelEngineInstall': {
        const id = String(p.engine ?? '');
        if (!ENGINE_VALUES.has(id)) bad('unsupported engine');
        return engine.cancelEngineInstall(id as EngineId);
      }

      // Live GitHub connection status (login + scopes + repo-scope capability).
      case 'githubStatus': return githubConnectionStatus(providers.getLocalKey('github'));
      // One-click connect by importing a token from an authenticated `gh` CLI.
      case 'importGithubFromCli': {
        const token = ghCliToken();
        if (!token) bad('gh CLI is not authenticated — run `gh auth login`, or paste a token', 400);
        return providers.connect('github', token as string);
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
      // Regenerate or modify an existing image. Routes through engine.generateImage
      // → the SAME Codex/fal backend the generate_image tool uses (Codex-first).
      // No `instruction` → re-roll the original prompt. With an `instruction`
      // ("add a balloon in the sky") → EDIT the source image, keeping the rest.
      // Always produces a NEW asset (non-destructive). When a jobId is given the
      // result is appended to that chat turn's transcript so it shows inline and
      // survives reload. Runs on this Mac; safe over the relay (bytes never cross).
      case 'regenerateImage': {
        const src = store.getAsset(String(p.assetId ?? p.id ?? ''));
        if (!src) return bad('asset not found', 404);
        if (src.kind !== 'image') return bad('only images can be regenerated', 400);
        const instruction = typeof p.instruction === 'string' ? p.instruction.trim() : '';
        const basePrompt = typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt.trim() : (src.prompt ?? '');
        const editing = instruction.length > 0;
        if (!editing && !basePrompt) return bad('no original prompt to regenerate from — describe a change instead', 400);
        // An edit needs a usable source image (a local file or a fetchable url). If
        // neither exists, fail loudly here rather than letting it silently degrade
        // to a fresh text→image of the instruction.
        if (editing) {
          const hasLocal = !!(src.localPath && existsSync(src.localPath));
          const hasUrl = !!(src.url && /^https?:\/\//i.test(src.url));
          if (!hasLocal && !hasUrl) return bad('this image has no source to edit on this Mac — re-roll it instead', 400);
        }
        const aspect = src.width && src.height
          ? (src.height > src.width ? '9:16' : src.width > src.height ? '16:9' : '1:1')
          : undefined;
        const text = editing ? instruction : basePrompt;
        const res = await engine.generateImage(text, {
          aspect, projectId: src.projectId,
          ...(editing ? { sourceImagePath: src.localPath, sourceImageUrl: src.url } : {}),
        });
        // Backstop: a backend that returns the SOURCE asset id means nothing new was
        // produced (content-dedup of an unchanged result). Don't pass it off as new.
        if (res.assetId && res.assetId === src.id) return bad('the image came back unchanged — try again, or describe the change differently', 502);
        // An edited image's stored prompt should re-roll to a variation of the WHOLE
        // picture, not just the change fragment — compose original + instruction.
        if (editing && res.assetId) {
          const composed = (basePrompt ? `${basePrompt} — ${instruction}` : instruction).slice(0, 2000);
          try { store.updateAsset(res.assetId, { prompt: composed }); } catch { /* best effort */ }
        }
        const newAsset = res.assetId ? store.getAsset(res.assetId) : undefined;
        if (newAsset) emit('asset', newAsset);
        // Append the result to the originating chat turn so it shows inline + persists.
        // Guard ownership (a relay caller could pass any jobId) and skip while the job
        // is still streaming — the engine wholesale-rewrites transcript on each flush,
        // which would clobber an out-of-band append (the 'asset' event still delivers
        // the image to Media Studio either way).
        if (p.jobId) {
          const job = store.getJob(String(p.jobId));
          if (job && job.projectId === src.projectId && !engine.isRunning(job.id)) {
            const item: TranscriptItem = {
              kind: 'image', text: text.slice(0, 200), imagePath: res.path, assetId: res.assetId,
              alt: res.alt ?? text.slice(0, 200), width: res.width, height: res.height, ts: Date.now(),
            };
            const updated = store.updateJob(job.id, { transcript: [...(job.transcript ?? []), item] });
            emit('job', updated);
          }
        }
        // Return a minimal, relay-safe ack only — the new image reaches every
        // surface via the slimmed 'asset' / 'job' events above. Never return the
        // full Asset here: onCommand doesn't slim it, so its localPath/url would
        // ride the relay response in the clear.
        return { ok: true, assetId: res.assetId };
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

      // ── Feedback (collected from desktop / web / phone) ────────
      case 'listFeedback': return store.listFeedback();
      case 'submitFeedback': {
        const message = String(p.message ?? '').trim();
        if (!message) bad('a feedback message is required');
        const category: FeedbackCategory = (p.category === 'bug' || p.category === 'idea' || p.category === 'other') ? p.category : 'other';
        const source: FeedbackSource = (p.source === 'web' || p.source === 'phone') ? p.source : 'desktop';
        const ctxIn = (p.context && typeof p.context === 'object') ? p.context as Record<string, unknown> : {};
        const context: FeedbackContext = {
          appVersion: app.getVersion(), // authoritative — this Mac's build
          ...(typeof ctxIn.screen === 'string' ? { screen: ctxIn.screen.slice(0, 80) } : {}),
          ...(typeof ctxIn.platform === 'string' ? { platform: ctxIn.platform.slice(0, 40) } : {}),
          ...(typeof ctxIn.projectId === 'string' ? { projectId: ctxIn.projectId } : {}),
        };
        const rec = store.addFeedback({ category, message, source, context });
        emit('feedback', rec);
        return rec;
      }
      case 'updateFeedback': {
        const patch: { status?: 'new' | 'triaged' | 'done' } = {};
        if (p.status === 'new' || p.status === 'triaged' || p.status === 'done') patch.status = p.status;
        if (Object.keys(patch).length === 0) bad('no valid feedback fields');
        const rec = store.updateFeedback(String(p.id ?? ''), patch);
        emit('feedback', rec);
        return rec;
      }
      case 'deleteFeedback': {
        store.deleteFeedback(String(p.id ?? ''));
        emit('feedback', { id: String(p.id ?? ''), deleted: true });
        return { ok: true };
      }
      // Escalate a piece of feedback to a GitHub issue using the local GitHub
      // token. Desktop-only (blocked on the relay) — it spends the Mac's token.
      case 'feedbackCreateIssue': {
        const rec = store.getFeedback(String(p.id ?? ''));
        if (!rec) return bad('feedback not found', 404);
        const repo = (typeof p.repo === 'string' && p.repo.trim() ? p.repo.trim() : store.getSettings().feedbackRepo ?? '').trim();
        if (!REPO_RE.test(repo)) bad('set a target repo (owner/repo) for feedback issues');
        const token = providers.getLocalKey('github');
        if (!token) bad('connect GitHub in Settings → Accounts & keys first', 400);
        const TITLE_MAX = 80;
        const firstLine = rec.message.split('\n')[0].slice(0, TITLE_MAX);
        const title = `[${rec.category}] ${firstLine}${rec.message.length > firstLine.length ? '…' : ''}`;
        const ctx = rec.context ?? {};
        const body = [
          rec.message,
          '',
          '---',
          `*Filed from Maestro feedback (${rec.source}).*`,
          ctx.screen ? `- Screen: \`${ctx.screen}\`` : '',
          ctx.appVersion ? `- App version: \`${ctx.appVersion}\`` : '',
          ctx.platform ? `- Platform: \`${ctx.platform}\`` : '',
        ].filter(Boolean).join('\n');
        const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'maestro' },
          body: JSON.stringify({ title, body, labels: ['feedback', rec.category] }),
        });
        if (!res.ok) {
          let detail = `GitHub returned ${res.status}`;
          try { const j = await res.json() as { message?: string }; if (j?.message) detail = j.message; } catch { /* non-JSON */ }
          bad(detail, res.status === 401 || res.status === 403 ? 400 : 502);
        }
        const issue = await res.json() as { number?: number; html_url?: string };
        const updated = store.updateFeedback(rec.id, { status: 'triaged', issueUrl: issue.html_url, issueNumber: issue.number });
        emit('feedback', updated);
        return { feedback: updated, issueUrl: issue.html_url, issueNumber: issue.number };
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
