/* Maestro local store — the source of truth lives ON THIS MAC.

   A JSON-file store in Electron userData holding every domain entity
   (workspace, projects, jobs, approvals, schedules, skills, templates,
   media assets, publish drafts, research briefs, comms bindings, events,
   settings) plus device identity for the relay. The remote server never
   owns this data; it only mirrors the snapshot we push for the phone/web
   remote controls. */

import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = (): string => randomUUID();
export const now = (): number => Date.now();

/** Human-enterable pairing token, e.g. "M7K2-Q9XF-4DTB" (no 0/O/1/I). */
export function newPairingToken(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}-${group()}`;
}

/* ── Domain types ────────────────────────────────────────────────────── */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type ProjectKind = 'coding' | 'content' | 'research' | 'general';

export interface Workspace { id: string; name: string; budgetCap: number; createdAt: number }
export interface Project {
  id: string; workspaceId: string; name: string; template: string; instructions: string; color: string;
  kind?: ProjectKind; path?: string; repoUrl?: string;
  createdAt: number;
}
/** One step of an agent run, in order: prose, a tool/skill invocation, or the
    final result. The chat renders these as separate blocks with timings. */
export interface TranscriptItem {
  kind: 'text' | 'tool' | 'result' | 'ask';
  /** text/result: the content. tool: short detail (command, file, query…). ask: prompt. */
  text: string;
  /** tool only */
  name?: string;
  toolStatus?: 'running' | 'done' | 'error';
  durMs?: number;
  /** file-writing tools only: a capped snapshot of the content written, for the hover preview. */
  preview?: string;
  /** ask only: JSON of the AskUserQuestion input ({ questions:[{question,header,options,multiSelect}] }). */
  ask?: string;
  ts: number;
}

export interface Job {
  id: string; projectId: string; title: string; status: JobStatus; phase: string; progress: number;
  input: string; output: string | null; error: string | null; effort: Effort; cost: number; tokens: number; stage: string;
  engine?: EngineId; model?: string;
  /** Chat turn: set when this job is one turn of a project chat session. */
  sessionId?: string;
  /** Structured run log (assistant text blocks, tool calls, result) — capped. */
  transcript?: TranscriptItem[];
  createdAt: number; updatedAt: number;
}

/** A chat thread inside a project. Each turn is a Job (sessionId set), so the
    whole engine stack (streaming, cancel, costs, events) works per message. */
export interface ChatSession {
  id: string; projectId: string; title: string;
  /** Engine continuity: Claude Agent SDK session id (Options.resume) once known. */
  sdkSessionId?: string;
  /** Pinned to the top of the workspace, across projects. */
  pinned?: boolean;
  /** Per-chat model overrides; absent = the workspace role defaults apply. */
  primary?: RoleChoice;
  reviewer?: RoleChoice | 'off';
  createdAt: number; updatedAt: number;
}
export interface Approval {
  id: string; projectId: string | null; kind: ApprovalKind; title: string; subtitle: string; detail: string;
  status: ApprovalStatus; jobId?: string | null; createdAt: number; resolvedAt: number | null;
}
export interface Schedule {
  id: string; projectId: string | null; title: string; time: string; cadence: string; enabled: boolean;
  nextRun: number | null; lastRun?: number | null; createdAt: number;
  /** One-shot "wait & check": fire once at this absolute time, into a chat. */
  fireAt?: number; sessionId?: string; prompt?: string;
}

export type EngineId = 'claude' | 'codex';
/** A model-level role choice: which engine + (optional) model id runs the role.
    `model` omitted = the engine's own default (Claude plan default / Codex default). */
export interface RoleChoice { engine: EngineId; model?: string }
export interface Roles {
  /** Primary / coding model — writes the code. */
  primary: RoleChoice;
  /** Reviewer model — reviews it, or 'off'. */
  reviewer: RoleChoice | 'off';
}
export const DEFAULT_ROLES: Roles = { primary: { engine: 'claude', model: 'opus' }, reviewer: 'off' };
export interface Routing {
  /** Master agent — runs jobs. Mirrors roles.primary.engine for back-compat. */
  master: EngineId;
  /** Reviewer — mirrors roles.reviewer (engine, or 'off'). */
  reviewer: EngineId | 'off';
  /** Legacy studio routing (media now runs on fal; kept for store compat). */
  image: EngineId;
  video: EngineId;
  /** Model-level primary/reviewer roles (SP1). */
  roles?: Roles;
}
export const DEFAULT_ROUTING: Routing = { master: 'claude', reviewer: 'off', image: 'codex', video: 'codex', roles: { ...DEFAULT_ROLES } };

export interface Skill { id: string; name: string; description: string; category: string; kind: string; version: string; enabled: boolean; createdAt: number }
export interface Template { id: string; name: string; description: string; category: string; icon: string; engine: string; createdAt: number }

/* Media assets — generated on fal or imported from disk. ONE entity. */
export type AssetKind = 'image' | 'video' | 'audio' | 'voiceover' | 'other';
export type AssetStage = 'broll' | 'avatar' | 'voice' | 'music';
export type AssetStatus = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled' | 'approved';
export interface Asset {
  id: string;
  projectId: string | null;
  source: 'generated' | 'import';
  kind: AssetKind;
  stage?: AssetStage;
  prompt?: string;
  model?: string;
  status: AssetStatus;
  falRequestId?: string;
  statusUrl?: string;
  responseUrl?: string;
  cancelUrl?: string;
  url?: string;
  localPath?: string;
  name?: string;
  bytes?: number;
  sha256?: string;
  thumbDataUrl?: string;
  tint?: string;
  cost: number;
  durationS?: number;
  width?: number;
  height?: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type PublishStatus = 'draft' | 'approved' | 'scheduled' | 'exported' | 'published-manual';
export interface PublishDraft {
  id: string; assetId: string; caption: string; platforms: string[]; scheduledAt: number | null;
  status: PublishStatus; provenance: string; exportedPaths: string[]; createdAt: number; updatedAt: number;
}
export interface PublishLedgerRow {
  id: string; draftId: string; at: number; platforms: string[]; action: 'exported' | 'published-manual'; ok: boolean; hash: string; paths: string[];
}

export interface Brief {
  id: string; topic: string; headline: string; hook: string; titles: string[]; platforms: string[];
  confidence: number; sources: string[]; status: 'ready' | 'sent-to-studio' | 'raw'; jobId: string; createdAt: number;
}
export interface ResearchRun { id: string; topic: string; jobId: string; status: 'running' | 'done' | 'failed'; briefCount: number; at: number }

export type AppEventKind =
  | 'job-done' | 'job-failed' | 'job-cancelled'
  | 'approval-created' | 'approval-resolved'
  | 'schedule-fired' | 'clone-done' | 'clone-failed'
  | 'research' | 'publish' | 'comm' | 'asset';
export interface AppEvent {
  id: string; ts: number; kind: AppEventKind; title: string; subtitle?: string;
  projectId?: string | null; jobId?: string | null;
}

export interface ChatPermissions { startJobs: boolean; receiveReports: boolean; approveGates: boolean }
export interface ChatBinding { chatId: string; name: string; kind: 'dm' | 'group'; projectId: string | null; permissions: ChatPermissions; boundAt: number }
export interface PendingChat { chatId: string; name: string; kind: 'dm' | 'group'; firstText: string; at: number }
export interface CommEvent { id: string; dir: 'in' | 'out'; chatId: string; chatName: string; payload: string; status: 'received' | 'sent' | 'failed'; at: number }
export interface TelegramState { offset: number; botUsername: string | null; connectedAt: number | null }

/* WhatsApp — connection state persisted in the store; the live QR string is
   held in memory only (never written to disk). */
export interface WhatsAppState { connected: boolean; jid: string | null; name: string | null; connectedAt: number | null }
export type WaMsgKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'location' | 'poll' | 'system';
export interface WaMedia { mimetype: string | null; fileName: string | null; sizeBytes: number | null }
/* A normalized WhatsApp message — the record stored per-chat in messages.jsonl. */
export interface WaMessage {
  msgId: string;
  chatId: string;
  fromMe: boolean;
  senderId: string;
  senderName: string;
  ts: number;          // epoch seconds
  kind: WaMsgKind;
  text: string;
  media: WaMedia | null;
  replyTo: string | null;
  source: 'live' | 'backfill';
}
/* A chat summary for the history list (derived from each chat's cursor + meta). */
export interface WaChat { chatId: string; name: string | null; kind: 'dm' | 'group'; count: number; newestTs: number; oldestTs: number }

export interface CommsStatus {
  telegram: { connected: boolean; botUsername: string | null; tokenLast4: string | null; messagesToday: number; bindings: number; pending: number };
  whatsapp: { connected: boolean; jid: string | null; name: string | null; connectedAt: number | null; chats: number; qr: string | null };
}

export interface AppSettings {
  defaultEffort: Effort;
  defaultEngine: EngineId | 'auto';
  openAtLogin: boolean;
  rescanCadence: 'daily' | 'weekly' | 'onchange';
  /** Picker keys the user starred — surfaced first in the model picker. */
  favoriteModels?: string[];
}
export const DEFAULT_SETTINGS: AppSettings = { defaultEffort: 'balanced', defaultEngine: 'auto', openAtLogin: false, rescanCadence: 'onchange', favoriteModels: [] };

export interface BudgetData { cap: number; spent: number; byProject: { projectId: string; name: string; color: string; spent: number }[] }
export interface CostsData {
  today: number;
  thisMonth: number;
  projectedMonth: number;
  byDay: { day: string; total: number }[];
  byProject: { projectId: string; name: string; color: string; total: number; jobs: number }[];
  byEngine: { engine: string; total: number; jobs: number; tokens: number }[];
  includedCodexRuns: number;
  claudeRuns: number;
}
export interface DashboardData {
  workspace: Workspace | null;
  greetingProjects: { id: string; name: string; color: string }[];
  gates: Approval[];
  activeJobs: Job[];
  recentlyCompleted: Job[];
  schedule: Schedule[];
  budget: BudgetData;
}

/* ── Persistence shape ───────────────────────────────────────────────── */

interface StoreData {
  deckId: string;
  deckSecret: string;
  /** Pairing token remotes must present to the relay. Shown in the app; never in snapshots. */
  accessToken: string;
  routing: Routing;
  settings: AppSettings;
  catalogVersion?: number;
  workspace: Workspace | null;
  projects: Project[];
  jobs: Job[];
  sessions: ChatSession[];
  approvals: Approval[];
  schedules: Schedule[];
  skills: Skill[];
  templates: Template[];
  assets: Asset[];
  publishDrafts: PublishDraft[];
  publishLedger: PublishLedgerRow[];
  briefs: Brief[];
  researchRuns: ResearchRun[];
  events: AppEvent[];
  chatBindings: ChatBinding[];
  pendingChats: PendingChat[];
  commEvents: CommEvent[];
  telegram: TelegramState;
  whatsapp: WhatsAppState;
  /** Locally (safeStorage-)encrypted provider API keys, base64. Never leaves this Mac. */
  providerKeys: Record<string, { cipherB64: string; last4: string; createdAt: number }>;
}

const CATALOG_VERSION = 2;
const SEED_PROJECT_NAMES = ['Atlas API', 'Q3 Content', 'Market Scan', 'Brand Refresh', 'Infra / CI'];
const SEED_JOB_TITLE = 'Merge PR #482 — auth refactor';

const ASSET_TINTS = ['#5b8cff', '#9b6bff', '#41c8d4', '#ff9f6b', '#6bd49a', '#ff6b9f'];

export class Store {
  private file: string;
  private data!: StoreData;
  /** Live WhatsApp pairing QR (raw string from Baileys). In-memory only — never
      persisted; cleared once the link goes 'open' or on disconnect. */
  private waQr: string | null = null;
  /** Per-chat seen msgId cache so appendWaMessage dedupes in O(1) instead of
      re-reading the whole messages.jsonl on every capture. Keyed by chat dir. */
  private waSeen = new Map<string, Set<string>>();

  constructor() {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'maestro-store.json');
    this.load();
    this.seedCatalog();
  }

  private load(): void {
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      let dirty = false;
      // migrations for stores written by older builds (dirty-flag pattern)
      if (!this.data.accessToken) { this.data.accessToken = newPairingToken(); dirty = true; }
      if (!this.data.routing) { this.data.routing = { ...DEFAULT_ROUTING }; dirty = true; }
      // SP1: seed model-level roles on older stores from the engine-level fields.
      if (this.data.routing && !this.data.routing.roles) {
        const r = this.data.routing;
        this.data.routing.roles = {
          primary: { engine: r.master ?? 'claude', model: (r.master ?? 'claude') === 'claude' ? 'opus' : undefined },
          reviewer: r.reviewer && r.reviewer !== 'off' ? { engine: r.reviewer } : 'off',
        };
        dirty = true;
      }
      if (!this.data.settings) { this.data.settings = { ...DEFAULT_SETTINGS }; dirty = true; }
      if (this.data.settings && !this.data.settings.favoriteModels) { this.data.settings.favoriteModels = []; dirty = true; }
      if (!this.data.sessions) { this.data.sessions = []; dirty = true; }
      if (!this.data.assets) { this.data.assets = []; dirty = true; }
      if (!this.data.publishDrafts) { this.data.publishDrafts = []; dirty = true; }
      if (!this.data.publishLedger) { this.data.publishLedger = []; dirty = true; }
      if (!this.data.briefs) { this.data.briefs = []; dirty = true; }
      if (!this.data.researchRuns) { this.data.researchRuns = []; dirty = true; }
      if (!this.data.events) { this.data.events = []; dirty = true; }
      if (!this.data.chatBindings) { this.data.chatBindings = []; dirty = true; }
      if (!this.data.pendingChats) { this.data.pendingChats = []; dirty = true; }
      if (!this.data.commEvents) { this.data.commEvents = []; dirty = true; }
      if (!this.data.telegram) { this.data.telegram = { offset: 0, botUsername: null, connectedAt: null }; dirty = true; }
      if (!this.data.whatsapp) { this.data.whatsapp = { connected: false, jid: null, name: null, connectedAt: null }; dirty = true; }

      // One-time demo-data purge: only fires on the full seed fingerprint so a
      // real project that happens to share a name never gets wiped.
      const seedNameHits = SEED_PROJECT_NAMES.filter((n) => this.data.projects.some((p) => p.name === n)).length;
      const seedJobHit = this.data.jobs.some((j) => j.title === SEED_JOB_TITLE);
      if (this.data.workspace?.name === 'Atlas Studio' && seedNameHits >= 4 && seedJobHit) {
        this.data.workspace = null;
        this.data.projects = [];
        this.data.jobs = [];
        this.data.approvals = [];
        this.data.schedules = [];
        this.data.skills = [];
        this.data.templates = [];
        this.data.catalogVersion = 0;
        dirty = true;
      }
      // Catalog refresh (honest skills + templates) for older stores.
      if ((this.data.catalogVersion ?? 0) < CATALOG_VERSION) {
        this.data.skills = [];
        this.data.templates = [];
        this.data.catalogVersion = CATALOG_VERSION;
        dirty = true;
      }
      if (dirty) this.save();
    } catch {
      this.data = {
        deckId: id(), deckSecret: id(), accessToken: newPairingToken(),
        routing: { ...DEFAULT_ROUTING }, settings: { ...DEFAULT_SETTINGS }, catalogVersion: CATALOG_VERSION,
        workspace: null,
        projects: [], jobs: [], sessions: [], approvals: [], schedules: [], skills: [], templates: [],
        assets: [], publishDrafts: [], publishLedger: [], briefs: [], researchRuns: [], events: [],
        chatBindings: [], pendingChats: [], commEvents: [],
        telegram: { offset: 0, botUsername: null, connectedAt: null },
        whatsapp: { connected: false, jid: null, name: null, connectedAt: null },
        providerKeys: {},
      };
      this.save();
    }
  }
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private save(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try { writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch { /* disk hiccup — retry next save */ }
  }
  /** Debounced save for high-frequency live updates: at most one disk write per
      window; any direct save() flushes immediately and cancels the timer. */
  private saveSoon(ms = 1200): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, ms);
  }

  get deck(): { deckId: string; deckSecret: string } {
    return { deckId: this.data.deckId, deckSecret: this.data.deckSecret };
  }
  get accessToken(): string { return this.data.accessToken; }

  routing(): Routing { return { ...this.data.routing }; }
  setRouting(patch: Partial<Routing>): Routing {
    this.data.routing = { ...this.data.routing, ...patch };
    this.save();
    return this.routing();
  }

  getRoles(): Roles { return this.data.routing.roles ? { ...this.data.routing.roles } : { ...DEFAULT_ROLES }; }
  setRoles(patch: Partial<Roles>): Roles {
    const cur = this.data.routing.roles ?? { ...DEFAULT_ROLES };
    const next: Roles = { ...cur, ...patch };
    this.data.routing.roles = next;
    // Keep the legacy engine-level fields consistent (cron + older callers read them).
    this.data.routing.master = next.primary.engine;
    this.data.routing.reviewer = next.reviewer === 'off' ? 'off' : next.reviewer.engine;
    this.save();
    return next;
  }

  getSettings(): AppSettings { return { ...this.data.settings }; }
  setSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.getSettings();
  }

  // ── Workspace ───────────────────────────────────────────────────────
  workspace(): Workspace | null { return this.data.workspace; }
  createWorkspace(name: string, budgetCap = 200): Workspace {
    if (this.data.workspace) {
      this.data.workspace = { ...this.data.workspace, name, budgetCap };
    } else {
      this.data.workspace = { id: id(), name, budgetCap, createdAt: now() };
    }
    this.save();
    return this.data.workspace;
  }
  setBudgetCap(cap: number): void {
    if (this.data.workspace) { this.data.workspace.budgetCap = cap; this.save(); }
  }

  // ── Projects ────────────────────────────────────────────────────────
  listProjects(): Project[] { return [...this.data.projects].sort((a, b) => a.createdAt - b.createdAt); }
  getProject(projectId: string): Project | undefined { return this.data.projects.find(p => p.id === projectId); }
  /** A project name that doesn't collide: "Repo", then "Repo v1", "Repo v2"… */
  uniqueProjectName(base: string): string {
    const wanted = (base || 'Project').trim() || 'Project';
    const taken = new Set(this.data.projects.map(p => p.name));
    if (!taken.has(wanted)) return wanted;
    let n = 1;
    while (taken.has(`${wanted} v${n}`)) n++;
    return `${wanted} v${n}`;
  }
  createProject(args: { name: string; template?: string; instructions?: string; color?: string; kind?: ProjectKind; path?: string; repoUrl?: string }): Project {
    const ws = this.data.workspace ?? this.createWorkspace('My Workspace');
    const p: Project = {
      id: id(), workspaceId: ws.id, name: this.uniqueProjectName(args.name),
      template: args.template ?? 'claude-code', instructions: args.instructions ?? '', color: args.color ?? 'blue',
      kind: args.kind, path: args.path, repoUrl: args.repoUrl,
      createdAt: now(),
    };
    this.data.projects.push(p); this.save();
    return p;
  }
  updateProject(projectId: string, patch: Partial<Pick<Project, 'name' | 'instructions' | 'color' | 'kind' | 'path' | 'repoUrl' | 'template'>>): Project {
    const cur = this.getProject(projectId);
    if (!cur) throw Object.assign(new Error('project not found'), { statusCode: 404 });
    Object.assign(cur, patch);
    this.save();
    return cur;
  }
  /** Remove a project + its jobs/sessions/schedules. Files on disk are untouched. */
  deleteProject(projectId: string): void {
    const i = this.data.projects.findIndex(p => p.id === projectId);
    if (i === -1) throw Object.assign(new Error('project not found'), { statusCode: 404 });
    this.data.projects.splice(i, 1);
    this.data.jobs = this.data.jobs.filter(j => j.projectId !== projectId);
    this.data.sessions = this.data.sessions.filter(s => s.projectId !== projectId);
    this.data.schedules = this.data.schedules.filter(s => s.projectId !== projectId);
    for (const a of this.data.assets) if (a.projectId === projectId) a.projectId = null;
    this.save();
  }

  // ── Chat sessions ───────────────────────────────────────────────────
  listSessions(projectId?: string): ChatSession[] {
    const all = [...this.data.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    return (projectId ? all.filter(s => s.projectId === projectId) : all).slice(0, 100);
  }
  getSession(sessionId: string): ChatSession | undefined { return this.data.sessions.find(s => s.id === sessionId); }
  createSession(projectId: string, title: string): ChatSession {
    const t = now();
    const s: ChatSession = { id: id(), projectId, title: (title.trim() || 'New chat').slice(0, 60), createdAt: t, updatedAt: t };
    this.data.sessions.push(s); this.save();
    return s;
  }
  updateSession(sessionId: string, patch: Partial<Pick<ChatSession, 'title' | 'sdkSessionId' | 'primary' | 'reviewer'>>): ChatSession {
    const s = this.getSession(sessionId);
    if (!s) throw Object.assign(new Error('session not found'), { statusCode: 404 });
    Object.assign(s, patch, { updatedAt: now() });
    this.save();
    return s;
  }
  touchSession(sessionId: string): void {
    const s = this.getSession(sessionId);
    if (s) { s.updatedAt = now(); this.save(); }
  }
  /** Pin/unpin without bumping updatedAt (pinning must not reorder the list). */
  setSessionPinned(sessionId: string, pinned: boolean): ChatSession {
    const s = this.getSession(sessionId);
    if (!s) throw Object.assign(new Error('session not found'), { statusCode: 404 });
    s.pinned = pinned || undefined;
    this.save();
    return s;
  }
  deleteSession(sessionId: string): void {
    const i = this.data.sessions.findIndex(s => s.id === sessionId);
    if (i === -1) throw Object.assign(new Error('session not found'), { statusCode: 404 });
    this.data.sessions.splice(i, 1);
    // Turns stay in the jobs ledger (costs/audit) but leave the chat.
    for (const j of this.data.jobs) if (j.sessionId === sessionId) j.sessionId = undefined;
    this.save();
  }

  // ── Jobs ────────────────────────────────────────────────────────────
  listJobs(projectId?: string, sessionId?: string): Job[] {
    const all = [...this.data.jobs].sort((a, b) => b.updatedAt - a.updatedAt);
    if (sessionId) return all.filter(j => j.sessionId === sessionId);
    return projectId ? all.filter(j => j.projectId === projectId) : all.slice(0, 200);
  }
  getJob(jobId: string): Job | undefined { return this.data.jobs.find(j => j.id === jobId); }
  createJob(projectId: string, input: string, title = '', effort?: Effort, sessionId?: string): Job {
    const t = now();
    const j: Job = {
      id: id(), projectId, title: title || input.slice(0, 60), status: 'pending', phase: 'Queued', progress: 0,
      input, output: null, error: null, effort: effort ?? this.data.settings.defaultEffort, cost: 0, tokens: 0, stage: '',
      sessionId,
      createdAt: t, updatedAt: t,
    };
    this.data.jobs.push(j); this.save();
    return j;
  }
  updateJob(jobId: string, patch: Partial<Pick<Job, 'status' | 'phase' | 'progress' | 'output' | 'error' | 'cost' | 'tokens' | 'stage' | 'engine' | 'model' | 'transcript'>>): Job {
    const cur = this.getJob(jobId);
    if (!cur) throw Object.assign(new Error(`job not found: ${jobId}`), { statusCode: 404 });
    Object.assign(cur, patch, { updatedAt: now() });
    this.save();
    return cur;
  }
  /** Streaming-frame variant: updates memory + defers the disk write (debounced).
      Used by the engine's high-frequency live flush; terminal states always go
      through updateJob so they persist immediately. */
  updateJobLive(jobId: string, patch: Partial<Pick<Job, 'progress' | 'output' | 'cost' | 'tokens' | 'stage' | 'transcript'>>): Job {
    const cur = this.getJob(jobId);
    if (!cur) throw Object.assign(new Error(`job not found: ${jobId}`), { statusCode: 404 });
    Object.assign(cur, patch, { updatedAt: now() });
    this.saveSoon();
    return cur;
  }
  deleteJob(jobId: string): void {
    const i = this.data.jobs.findIndex(j => j.id === jobId);
    if (i === -1) throw Object.assign(new Error('job not found'), { statusCode: 404 });
    this.data.jobs.splice(i, 1);
    this.save();
  }
  /** Boot sweep: jobs left 'running'/'pending' by a previous app instance can
      never complete (their child process died with the app) — without this
      they'd show as running forever. Called once at launch, before the engine
      starts anything new. */
  settleOrphanedRuns(): Job[] {
    const orphans = this.data.jobs.filter(j => j.status === 'running' || j.status === 'pending');
    for (const j of orphans) {
      j.status = 'failed';
      j.phase = 'Failed';
      j.stage = '';
      j.error = 'Interrupted — Maestro was restarted while this job was running.';
      j.updatedAt = now();
    }
    if (orphans.length) this.save();
    return orphans;
  }

  // ── Approvals ───────────────────────────────────────────────────────
  listApprovals(status?: ApprovalStatus): Approval[] {
    const all = [...this.data.approvals].sort((a, b) => b.createdAt - a.createdAt);
    return status ? all.filter(a => a.status === status) : all.slice(0, 200);
  }
  createApproval(a: { projectId?: string | null; kind?: ApprovalKind; title: string; subtitle?: string; detail?: string; jobId?: string | null }): Approval {
    const rec: Approval = {
      id: id(), projectId: a.projectId ?? null, kind: a.kind ?? 'review', title: a.title,
      subtitle: a.subtitle ?? '', detail: a.detail ?? '', status: 'pending', jobId: a.jobId ?? null,
      createdAt: now(), resolvedAt: null,
    };
    this.data.approvals.push(rec); this.save();
    return rec;
  }
  resolveApproval(approvalId: string, status: 'approved' | 'denied'): Approval {
    const cur = this.data.approvals.find(a => a.id === approvalId);
    if (!cur) throw Object.assign(new Error('approval not found'), { statusCode: 404 });
    cur.status = status; cur.resolvedAt = now();
    this.save();
    return cur;
  }

  // ── Schedules ───────────────────────────────────────────────────────
  listSchedules(): Schedule[] { return [...this.data.schedules].sort((a, b) => a.time.localeCompare(b.time)); }
  createSchedule(s: { projectId?: string | null; title: string; time?: string; cadence?: string; fireAt?: number; sessionId?: string; prompt?: string }): Schedule {
    const at = s.fireAt ? new Date(s.fireAt) : null;
    const time = s.time ?? (at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '');
    const rec: Schedule = {
      id: id(), projectId: s.projectId ?? null, title: s.title, time,
      cadence: s.fireAt ? 'once' : (s.cadence ?? 'daily'),
      enabled: true, nextRun: s.fireAt ?? null, createdAt: now(),
      ...(s.fireAt ? { fireAt: s.fireAt } : {}),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      ...(s.prompt ? { prompt: s.prompt } : {}),
    };
    this.data.schedules.push(rec); this.save();
    return rec;
  }
  setScheduleEnabled(scheduleId: string, enabled: boolean): void {
    const s = this.data.schedules.find(x => x.id === scheduleId);
    if (s) { s.enabled = enabled; this.save(); }
  }
  markScheduleRun(scheduleId: string, ts: number, nextRun: number | null): void {
    const s = this.data.schedules.find(x => x.id === scheduleId);
    if (s) { s.lastRun = ts; s.nextRun = nextRun; this.save(); }
  }
  setScheduleNextRun(scheduleId: string, nextRun: number | null): void {
    const s = this.data.schedules.find(x => x.id === scheduleId);
    if (s && s.nextRun !== nextRun) { s.nextRun = nextRun; this.save(); }
  }
  deleteSchedule(scheduleId: string): void {
    const i = this.data.schedules.findIndex(s => s.id === scheduleId);
    if (i === -1) throw Object.assign(new Error('schedule not found'), { statusCode: 404 });
    this.data.schedules.splice(i, 1);
    this.save();
  }

  // ── Skills / Templates ─────────────────────────────────────────────
  listSkills(): Skill[] { return [...this.data.skills].sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name)); }
  toggleSkill(skillId: string): Skill | undefined {
    const s = this.data.skills.find(x => x.id === skillId);
    if (!s) return undefined;
    s.enabled = !s.enabled; this.save();
    return s;
  }
  listTemplates(): Template[] { return [...this.data.templates].sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name)); }

  // ── Assets (generated + imported media) ─────────────────────────────
  listAssets(filter?: { projectId?: string; status?: AssetStatus }): Asset[] {
    let all = [...this.data.assets].sort((a, b) => b.updatedAt - a.updatedAt);
    if (filter?.projectId) all = all.filter(a => a.projectId === filter.projectId);
    if (filter?.status) all = all.filter(a => a.status === filter.status);
    return all.slice(0, 200);
  }
  getAsset(assetId: string): Asset | undefined { return this.data.assets.find(a => a.id === assetId); }
  createAsset(args: Partial<Asset> & { source: Asset['source']; kind: AssetKind; status: AssetStatus }): Asset {
    const t = now();
    const a: Asset = {
      id: id(), projectId: args.projectId ?? null, source: args.source, kind: args.kind, stage: args.stage,
      prompt: args.prompt, model: args.model, status: args.status,
      falRequestId: args.falRequestId, statusUrl: args.statusUrl, responseUrl: args.responseUrl, cancelUrl: args.cancelUrl,
      url: args.url, localPath: args.localPath, name: args.name, bytes: args.bytes, sha256: args.sha256,
      thumbDataUrl: args.thumbDataUrl, tint: args.tint ?? ASSET_TINTS[Math.floor(Math.random() * ASSET_TINTS.length)],
      cost: args.cost ?? 0, durationS: args.durationS, width: args.width, height: args.height,
      error: null, createdAt: t, updatedAt: t,
    };
    this.data.assets.push(a); this.save();
    return a;
  }
  updateAsset(assetId: string, patch: Partial<Asset>): Asset {
    const cur = this.getAsset(assetId);
    if (!cur) throw Object.assign(new Error('asset not found'), { statusCode: 404 });
    Object.assign(cur, patch, { updatedAt: now() });
    this.save();
    return cur;
  }
  deleteAsset(assetId: string): Asset {
    const i = this.data.assets.findIndex(a => a.id === assetId);
    if (i === -1) throw Object.assign(new Error('asset not found'), { statusCode: 404 });
    const [removed] = this.data.assets.splice(i, 1);
    this.save();
    return removed;
  }

  // ── Publishing ──────────────────────────────────────────────────────
  listPublishDrafts(): PublishDraft[] { return [...this.data.publishDrafts].sort((a, b) => b.updatedAt - a.updatedAt); }
  getPublishDraft(draftId: string): PublishDraft | undefined { return this.data.publishDrafts.find(d => d.id === draftId); }
  createPublishDraft(args: { assetId: string; caption?: string; platforms?: string[]; provenance?: string }): PublishDraft {
    const t = now();
    const d: PublishDraft = {
      id: id(), assetId: args.assetId, caption: args.caption ?? '', platforms: args.platforms ?? [],
      scheduledAt: null, status: 'draft', provenance: args.provenance ?? '', exportedPaths: [], createdAt: t, updatedAt: t,
    };
    this.data.publishDrafts.push(d); this.save();
    return d;
  }
  updatePublishDraft(draftId: string, patch: Partial<Pick<PublishDraft, 'caption' | 'platforms' | 'scheduledAt' | 'status' | 'exportedPaths' | 'provenance'>>): PublishDraft {
    const cur = this.getPublishDraft(draftId);
    if (!cur) throw Object.assign(new Error('draft not found'), { statusCode: 404 });
    Object.assign(cur, patch, { updatedAt: now() });
    this.save();
    return cur;
  }
  deletePublishDraft(draftId: string): void {
    const i = this.data.publishDrafts.findIndex(d => d.id === draftId);
    if (i === -1) throw Object.assign(new Error('draft not found'), { statusCode: 404 });
    this.data.publishDrafts.splice(i, 1);
    this.save();
  }
  appendPublishLedger(row: Omit<PublishLedgerRow, 'id' | 'at'>): PublishLedgerRow {
    const rec: PublishLedgerRow = { ...row, id: id(), at: now() };
    this.data.publishLedger.unshift(rec);
    if (this.data.publishLedger.length > 200) this.data.publishLedger.length = 200;
    this.save();
    return rec;
  }
  listPublishLedger(): PublishLedgerRow[] { return [...this.data.publishLedger]; }

  // ── Research briefs ─────────────────────────────────────────────────
  listBriefs(): Brief[] { return [...this.data.briefs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100); }
  addBriefs(briefs: Omit<Brief, 'id' | 'createdAt'>[]): Brief[] {
    const recs = briefs.map((b): Brief => ({ ...b, id: id(), createdAt: now() }));
    this.data.briefs.unshift(...recs);
    if (this.data.briefs.length > 100) this.data.briefs.length = 100;
    this.save();
    return recs;
  }
  setBriefStatus(briefId: string, status: Brief['status']): Brief {
    const b = this.data.briefs.find(x => x.id === briefId);
    if (!b) throw Object.assign(new Error('brief not found'), { statusCode: 404 });
    b.status = status;
    this.save();
    return b;
  }
  createResearchRun(args: { topic: string; jobId: string }): ResearchRun {
    const r: ResearchRun = { id: id(), topic: args.topic, jobId: args.jobId, status: 'running', briefCount: 0, at: now() };
    this.data.researchRuns.unshift(r);
    if (this.data.researchRuns.length > 50) this.data.researchRuns.length = 50;
    this.save();
    return r;
  }
  updateResearchRun(runId: string, patch: Partial<Pick<ResearchRun, 'status' | 'briefCount'>>): ResearchRun {
    const r = this.data.researchRuns.find(x => x.id === runId);
    if (!r) throw Object.assign(new Error('research run not found'), { statusCode: 404 });
    Object.assign(r, patch);
    this.save();
    return r;
  }
  listResearchRuns(): ResearchRun[] { return [...this.data.researchRuns]; }

  // ── Events feed ─────────────────────────────────────────────────────
  pushEvent(e: Omit<AppEvent, 'id' | 'ts'>): AppEvent {
    const rec: AppEvent = { ...e, id: id(), ts: now() };
    this.data.events.unshift(rec);
    if (this.data.events.length > 200) this.data.events.length = 200;
    this.save();
    return rec;
  }
  listEvents(): AppEvent[] { return [...this.data.events]; }

  // ── Comms (Telegram) ────────────────────────────────────────────────
  listChatBindings(): ChatBinding[] { return [...this.data.chatBindings]; }
  getChatBinding(chatId: string): ChatBinding | undefined { return this.data.chatBindings.find(b => b.chatId === chatId); }
  bindChat(args: { chatId: string; name: string; kind: 'dm' | 'group'; projectId?: string | null; permissions?: Partial<ChatPermissions> }): ChatBinding {
    const existing = this.getChatBinding(args.chatId);
    const perms: ChatPermissions = { startJobs: true, receiveReports: true, approveGates: false, ...(args.permissions ?? {}) };
    if (existing) {
      Object.assign(existing, { name: args.name, kind: args.kind, projectId: args.projectId ?? existing.projectId, permissions: perms });
      this.save();
      return existing;
    }
    const rec: ChatBinding = { chatId: args.chatId, name: args.name, kind: args.kind, projectId: args.projectId ?? null, permissions: perms, boundAt: now() };
    this.data.chatBindings.push(rec);
    this.removePendingChat(args.chatId);
    this.save();
    return rec;
  }
  unbindChat(chatId: string): void {
    this.data.chatBindings = this.data.chatBindings.filter(b => b.chatId !== chatId);
    this.save();
  }
  setChatPermissions(chatId: string, permissions: Partial<ChatPermissions>): ChatBinding {
    const b = this.getChatBinding(chatId);
    if (!b) throw Object.assign(new Error('chat not bound'), { statusCode: 404 });
    b.permissions = { ...b.permissions, ...permissions };
    this.save();
    return b;
  }
  upsertPendingChat(c: Omit<PendingChat, 'at'>): void {
    const existing = this.data.pendingChats.find(p => p.chatId === c.chatId);
    if (existing) { existing.name = c.name; existing.firstText = c.firstText; existing.at = now(); }
    else this.data.pendingChats.unshift({ ...c, at: now() });
    if (this.data.pendingChats.length > 50) this.data.pendingChats.length = 50;
    this.save();
  }
  removePendingChat(chatId: string): void {
    this.data.pendingChats = this.data.pendingChats.filter(p => p.chatId !== chatId);
    this.save();
  }
  listPendingChats(): PendingChat[] { return [...this.data.pendingChats]; }
  addCommEvent(e: Omit<CommEvent, 'id' | 'at'>): CommEvent {
    const rec: CommEvent = { ...e, id: id(), at: now() };
    this.data.commEvents.unshift(rec);
    if (this.data.commEvents.length > 200) this.data.commEvents.length = 200;
    this.save();
    return rec;
  }
  listCommEvents(): CommEvent[] { return [...this.data.commEvents]; }
  telegramState(): TelegramState { return { ...this.data.telegram }; }
  setTelegramState(patch: Partial<TelegramState>): TelegramState {
    this.data.telegram = { ...this.data.telegram, ...patch };
    this.save();
    return this.telegramState();
  }
  commsStatus(): CommsStatus {
    const key = this.providerKeyMeta('telegram');
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const wa = this.data.whatsapp;
    return {
      telegram: {
        connected: !!key,
        botUsername: this.data.telegram.botUsername,
        tokenLast4: key?.last4 ?? null,
        messagesToday: this.data.commEvents.filter(e => e.at >= midnight.getTime()).length,
        bindings: this.data.chatBindings.length,
        pending: this.data.pendingChats.length,
      },
      whatsapp: {
        connected: wa.connected,
        jid: wa.jid,
        name: wa.name,
        connectedAt: wa.connectedAt,
        chats: this.countWaChats(),
        qr: this.waQr,
      },
    };
  }

  // ── WhatsApp (Baileys) — connection state + file-based message history ─
  /* Connection state is small and persisted in the JSON store. Message history
     is NOT: every message is appended to a per-chat messages.jsonl under
     userData/comms/whatsapp/<account>/<chatDir>/ so a long history never bloats
     (or rewrites) the single store blob. */
  private static readonly WA_ACCOUNT = 'default';
  private static readonly WA_HISTORY_CAP = 500; // messages returned per getWaMessages page

  whatsappState(): WhatsAppState { return { ...this.data.whatsapp }; }
  setWhatsappState(patch: Partial<WhatsAppState>): WhatsAppState {
    this.data.whatsapp = { ...this.data.whatsapp, ...patch };
    this.save();
    return this.whatsappState();
  }
  /** Set/clear the live pairing QR (in-memory only). */
  setWhatsappQr(qr: string | null): void { this.waQr = qr; }

  private waRoot(): string { return join(dirname(this.file), 'comms', 'whatsapp', Store.WA_ACCOUNT); }
  /** Folder-safe segment for a JID. The real chatId is stored in meta.json, so
      this need only be deterministic + path-traversal-safe, not reversible. */
  private waChatDir(chatId: string): string {
    const seg = chatId.replace(/[^A-Za-z0-9._@=-]/g, '_').replace(/\.\.+/g, '_') || '_';
    return join(this.waRoot(), seg);
  }
  private countWaChats(): number {
    try { return readdirSync(this.waRoot(), { withFileTypes: true }).filter(d => d.isDirectory()).length; }
    catch { return 0; }
  }
  private readWaChatMeta(dir: string): { chatId: string; name: string | null; kind: 'dm' | 'group'; count: number; newestTs: number; oldestTs: number } | null {
    try {
      const v = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
      if (v && typeof v === 'object') return v;
    } catch { /* missing/corrupt */ }
    return null;
  }

  /** Append one captured message to its chat's history (deduped by msgId).
      Returns true when actually written (false on duplicate). */
  appendWaMessage(msg: WaMessage): boolean {
    if (!msg.chatId || !msg.msgId) return false;
    const dir = this.waChatDir(msg.chatId);
    const file = join(dir, 'messages.jsonl');
    // Dedupe by msgId (tier-1 identity, as in the reference). The seen-id set is
    // read from disk once per chat, then kept warm in memory for the session.
    let seen = this.waSeen.get(dir);
    if (!seen) { seen = this.readWaMessageIds(file); this.waSeen.set(dir, seen); }
    if (seen.has(msg.msgId)) return false;
    seen.add(msg.msgId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(msg) + '\n');
    // Refresh the per-chat meta (name/kind/count/newest/oldest) for the list.
    const meta = this.readWaChatMeta(dir) ?? { chatId: msg.chatId, name: null, kind: 'dm' as const, count: 0, newestTs: 0, oldestTs: 0 };
    meta.chatId = msg.chatId;
    meta.kind = msg.chatId.endsWith('@g.us') ? 'group' : 'dm';
    // Best-effort DM name from an inbound message's pushName (never our own).
    if (meta.kind === 'dm' && !msg.fromMe && !meta.name && msg.senderName?.trim()) meta.name = msg.senderName.trim();
    meta.count += 1;
    if (msg.ts >= meta.newestTs) meta.newestTs = msg.ts;
    if (!meta.oldestTs || msg.ts <= meta.oldestTs) meta.oldestTs = msg.ts;
    try { writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta)); } catch { /* disk hiccup */ }
    return true;
  }
  private readWaMessageIds(file: string): Set<string> {
    const ids = new Set<string>();
    if (!existsSync(file)) return ids;
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { const m = JSON.parse(line) as WaMessage; if (m.msgId) ids.add(m.msgId); } catch { /* skip bad line */ }
      }
    } catch { /* unreadable */ }
    return ids;
  }
  /** All known WhatsApp chats, newest activity first (from per-chat meta). */
  listWaChats(): WaChat[] {
    const root = this.waRoot();
    if (!existsSync(root)) return [];
    const out: WaChat[] = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const meta = this.readWaChatMeta(join(root, d.name));
      if (!meta) continue;
      out.push({ chatId: meta.chatId, name: meta.name ?? null, kind: meta.kind ?? 'dm', count: meta.count ?? 0, newestTs: meta.newestTs ?? 0, oldestTs: meta.oldestTs ?? 0 });
    }
    out.sort((a, b) => (b.newestTs || 0) - (a.newestTs || 0));
    return out;
  }
  /** A page of one chat's messages, oldest→newest, capped server-side.
      `before` (epoch seconds) pages older history; omit for the latest page. */
  getWaMessages(chatId: string, opts: { limit?: number; before?: number } = {}): WaMessage[] {
    const file = join(this.waChatDir(chatId), 'messages.jsonl');
    if (!existsSync(file)) return [];
    let msgs: WaMessage[] = [];
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { msgs.push(JSON.parse(line) as WaMessage); } catch { /* skip bad line */ }
      }
    } catch { return []; }
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.msgId.localeCompare(b.msgId));
    if (opts.before != null) msgs = msgs.filter(m => (m.ts || 0) < opts.before!);
    const cap = Math.min(opts.limit ?? Store.WA_HISTORY_CAP, Store.WA_HISTORY_CAP);
    return msgs.slice(-cap); // newest `cap` within the window, still oldest→newest
  }
  /** Wipe all stored WhatsApp history (on unlink). */
  clearWaHistory(): void {
    this.waSeen.clear();
    try { rmSync(this.waRoot(), { recursive: true, force: true }); } catch { /* nothing to clear */ }
  }

  // ── Provider keys (local, encrypted) ───────────────────────────────
  providerKeyMeta(provider: string): { last4: string; createdAt: number } | undefined {
    const k = this.data.providerKeys[provider];
    return k ? { last4: k.last4, createdAt: k.createdAt } : undefined;
  }
  setProviderKey(provider: string, cipherB64: string, last4: string): void {
    this.data.providerKeys[provider] = { cipherB64, last4, createdAt: now() };
    this.save();
  }
  getProviderKeyCipher(provider: string): string | undefined { return this.data.providerKeys[provider]?.cipherB64; }
  deleteProviderKey(provider: string): void { delete this.data.providerKeys[provider]; this.save(); }

  // ── Aggregates ─────────────────────────────────────────────────────
  budget(): BudgetData {
    const cap = this.data.workspace?.budgetCap ?? 200;
    const byProject = this.listProjects().map(p => {
      const jobSpend = this.data.jobs.filter(j => j.projectId === p.id).reduce((a, j) => a + j.cost, 0);
      const assetSpend = this.data.assets.filter(x => x.projectId === p.id).reduce((a, x) => a + x.cost, 0);
      return { projectId: p.id, name: p.name, color: p.color, spent: Math.round((jobSpend + assetSpend) * 100) / 100 };
    });
    const spent = Math.round(byProject.reduce((a, b) => a + b.spent, 0) * 100) / 100;
    return { cap, spent, byProject };
  }

  costs(): CostsData {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const t = new Date();
    const dayStart = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    const monthStart = new Date(t.getFullYear(), t.getMonth(), 1).getTime();
    const dayOfMonth = t.getDate();
    const daysInMonth = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();

    interface Spend { at: number; cost: number; projectId: string | null; engine: string; tokens: number }
    const spends: Spend[] = [
      ...this.data.jobs.map(j => ({ at: j.createdAt, cost: j.cost, projectId: j.projectId as string | null, engine: j.engine ?? 'claude', tokens: j.tokens })),
      ...this.data.assets.filter(a => a.source === 'generated').map(a => ({ at: a.createdAt, cost: a.cost, projectId: a.projectId, engine: 'media (fal)', tokens: 0 })),
    ];

    const today = r2(spends.filter(s => s.at >= dayStart).reduce((a, s) => a + s.cost, 0));
    const thisMonth = r2(spends.filter(s => s.at >= monthStart).reduce((a, s) => a + s.cost, 0));
    const projectedMonth = dayOfMonth > 0 ? r2((thisMonth / dayOfMonth) * daysInMonth) : thisMonth;

    const byDay: { day: string; total: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
      const start = d.getTime();
      const end = start + 24 * 60 * 60 * 1000;
      byDay.push({
        day: `${d.getMonth() + 1}/${d.getDate()}`,
        total: r2(spends.filter(s => s.at >= start && s.at < end).reduce((a, s) => a + s.cost, 0)),
      });
    }

    const byProject = this.listProjects().map(p => {
      const mine = spends.filter(s => s.projectId === p.id);
      return { projectId: p.id, name: p.name, color: p.color, total: r2(mine.reduce((a, s) => a + s.cost, 0)), jobs: this.data.jobs.filter(j => j.projectId === p.id).length };
    }).filter(p => p.total > 0 || p.jobs > 0);

    const engineMap = new Map<string, { total: number; jobs: number; tokens: number }>();
    for (const s of spends) {
      const e = engineMap.get(s.engine) ?? { total: 0, jobs: 0, tokens: 0 };
      e.total += s.cost; e.jobs += 1; e.tokens += s.tokens;
      engineMap.set(s.engine, e);
    }
    const byEngine = [...engineMap.entries()].map(([engine, v]) => ({ engine, total: r2(v.total), jobs: v.jobs, tokens: v.tokens }));

    return {
      today, thisMonth, projectedMonth, byDay, byProject, byEngine,
      includedCodexRuns: this.data.jobs.filter(j => j.engine === 'codex').length,
      claudeRuns: this.data.jobs.filter(j => (j.engine ?? 'claude') === 'claude').length,
    };
  }

  dashboard(): DashboardData {
    const projects = this.listProjects();
    const jobs = this.listJobs();
    return {
      workspace: this.data.workspace,
      greetingProjects: projects.map(p => ({ id: p.id, name: p.name, color: p.color })),
      gates: this.listApprovals('pending'),
      activeJobs: jobs.filter(j => j.status === 'running' || j.status === 'pending').slice(0, 8),
      recentlyCompleted: jobs.filter(j => j.status === 'done').slice(0, 6),
      schedule: this.listSchedules(),
      budget: this.budget(),
    };
  }

  /** Full snapshot pushed to the relay so phone/web remotes can mirror this Mac.
      Slimmed: queue/file paths and thumbs never leave the Mac; long outputs truncate. */
  snapshot(providers: unknown): Record<string, unknown> {
    const slimJob = (j: Job): Job => {
      const out = j.output && j.output.length > 16384 ? '…' + j.output.slice(-16384) : j.output;
      // Remotes get a trimmed run log: last 60 items, long text blocks truncated.
      // Skip the allocation entirely when nothing actually needs trimming.
      const tr = j.transcript;
      const transcript = !tr ? undefined
        : (tr.length <= 60 && !tr.some(t => t.text.length > 4000)) ? tr
        : tr.slice(-60).map(t => (t.text.length > 4000 ? { ...t, text: t.text.slice(0, 4000) + '…' } : t));
      return out === j.output && transcript === tr ? j : { ...j, output: out, transcript };
    };
    const slimAsset = (a: Asset) => ({
      id: a.id, projectId: a.projectId, source: a.source, kind: a.kind, stage: a.stage,
      prompt: a.prompt ? a.prompt.slice(0, 200) : undefined, model: a.model, status: a.status,
      url: a.url, name: a.name, bytes: a.bytes, tint: a.tint, cost: a.cost,
      durationS: a.durationS, width: a.width, height: a.height, error: a.error,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
    });
    const dashboard = this.dashboard();
    return {
      workspace: this.data.workspace,
      workspaces: this.data.workspace ? [this.data.workspace] : [],
      projects: this.listProjects(),
      jobs: this.listJobs().map(slimJob),
      sessions: this.listSessions(),
      approvals: this.listApprovals(),
      schedules: this.listSchedules(),
      skills: this.listSkills(),
      templates: this.listTemplates(),
      assets: this.listAssets().slice(0, 100).map(slimAsset),
      publishDrafts: this.listPublishDrafts(),
      publishLedger: this.listPublishLedger(),
      briefs: this.listBriefs(),
      researchRuns: this.listResearchRuns(),
      events: this.listEvents(),
      chatBindings: this.listChatBindings(),
      pendingChats: this.listPendingChats(),
      commEvents: this.listCommEvents(),
      commsStatus: this.commsStatus(),
      budget: this.budget(),
      costs: this.costs(),
      dashboard: { ...dashboard, activeJobs: dashboard.activeJobs.map(slimJob), recentlyCompleted: dashboard.recentlyCompleted.map(slimJob) },
      providers,
      routing: this.routing(),
      settings: this.getSettings(),
      at: now(),
    };
  }

  // ── Catalog seed (templates + honest skills only — NO demo data) ────
  private seedCatalog(): void {
    let dirty = false;
    if (this.data.templates.length === 0) {
      const mkTemplate = (name: string, description: string, category: string, icon: string, engine: string) => {
        this.data.templates.push({ id: id(), name, description, category, icon, engine, createdAt: now() });
      };
      mkTemplate('Claude Code', 'Autonomous coding agent for a repo.', 'Build', 'terminal', 'claude-code');
      mkTemplate('Codex', 'Coding agent on your ChatGPT sign-in.', 'Build', 'cpu', 'codex');
      mkTemplate('Deep Research', 'Multi-source research with citations.', 'Research', 'telescope', 'research');
      mkTemplate('Content Studio', 'Drafts, threads, and newsletters.', 'Content', 'send', 'claude-design');
      mkTemplate('Media Studio', 'Generate images, video, and voice on fal.', 'Content', 'clapper', 'media');
      mkTemplate('Blank', 'An empty project — bring your own goal.', 'Build', 'layers', 'claude-code');
      dirty = true;
    }
    if (this.data.skills.length === 0) {
      const mkSkill = (name: string, description: string, category: string, kind: string, enabled: boolean) => {
        this.data.skills.push({ id: id(), name, description, category, kind, version: '1.0.0', enabled, createdAt: now() });
      };
      // Honest catalog: only capabilities the engines genuinely have today.
      mkSkill('Web Search', 'Agents can search the live web during runs.', 'Core', 'builtin', true);
      mkSkill('Shell & Code Execution', 'Run commands and code in the project folder.', 'Core', 'builtin', true);
      mkSkill('File System', 'Read & write files in the project workspace.', 'Core', 'builtin', true);
      mkSkill('Git', 'Clone, branch, and commit via the system git.', 'Core', 'builtin', true);
      mkSkill('Media Generation (fal)', 'Image, video, and speech via your fal key.', 'Media', 'api', true);
      mkSkill('Telegram Bot', 'Start jobs and approve gates from Telegram.', 'Integrations', 'api', true);
      dirty = true;
    }
    if (dirty) this.save();
  }
}
