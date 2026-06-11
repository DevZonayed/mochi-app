/* Maestro local store — the source of truth lives ON THIS MAC.

   A small JSON-file store in Electron userData holding every domain entity
   (workspace, projects, jobs, approvals, schedules, skills, templates) plus
   device identity for the relay. The remote server never owns this data; it
   only mirrors the snapshot we push for the phone/web remote controls. */

import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Workspace { id: string; name: string; budgetCap: number; createdAt: number }
export interface Project { id: string; workspaceId: string; name: string; template: string; instructions: string; color: string; createdAt: number }
export interface Job {
  id: string; projectId: string; title: string; status: JobStatus; phase: string; progress: number;
  input: string; output: string | null; error: string | null; effort: Effort; cost: number; tokens: number; stage: string;
  createdAt: number; updatedAt: number;
}
export interface Approval {
  id: string; projectId: string | null; kind: ApprovalKind; title: string; subtitle: string; detail: string;
  status: ApprovalStatus; createdAt: number; resolvedAt: number | null;
}
export interface Schedule { id: string; projectId: string | null; title: string; time: string; cadence: string; enabled: boolean; nextRun: number | null; lastRun?: number | null; createdAt: number }

export type EngineId = 'claude' | 'codex';
export interface Routing {
  /** Master agent — runs jobs. */
  master: EngineId;
  /** Reviewer — optional second pass appended to job output. */
  reviewer: EngineId | 'off';
  /** Studio routing (applies when the media pipeline ships). */
  image: EngineId;
  video: EngineId;
}
export const DEFAULT_ROUTING: Routing = { master: 'claude', reviewer: 'off', image: 'codex', video: 'codex' };
export interface Skill { id: string; name: string; description: string; category: string; kind: string; version: string; enabled: boolean; createdAt: number }
export interface Template { id: string; name: string; description: string; category: string; icon: string; engine: string; createdAt: number }

export interface BudgetData { cap: number; spent: number; byProject: { projectId: string; name: string; color: string; spent: number }[] }
export interface DashboardData {
  workspace: Workspace | null;
  greetingProjects: { id: string; name: string; color: string }[];
  gates: Approval[];
  activeJobs: Job[];
  recentlyCompleted: Job[];
  schedule: Schedule[];
  budget: BudgetData;
}

interface StoreData {
  deckId: string;
  deckSecret: string;
  /** Pairing token remotes must present to the relay. Shown in the app; never in snapshots. */
  accessToken: string;
  routing: Routing;
  workspace: Workspace | null;
  projects: Project[];
  jobs: Job[];
  approvals: Approval[];
  schedules: Schedule[];
  skills: Skill[];
  templates: Template[];
  /** Locally (safeStorage-)encrypted provider API keys, base64. Never leaves this Mac. */
  providerKeys: Record<string, { cipherB64: string; last4: string; createdAt: number }>;
}

export class Store {
  private file: string;
  private data!: StoreData;

  constructor() {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'maestro-store.json');
    this.load();
    this.seedIfEmpty();
  }

  private load(): void {
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      // migrations for stores written by older builds
      let dirty = false;
      if (!this.data.accessToken) { this.data.accessToken = newPairingToken(); dirty = true; }
      if (!this.data.routing) { this.data.routing = { ...DEFAULT_ROUTING }; dirty = true; }
      if (dirty) this.save();
    } catch {
      this.data = {
        deckId: id(), deckSecret: id(), accessToken: newPairingToken(), routing: { ...DEFAULT_ROUTING }, workspace: null,
        projects: [], jobs: [], approvals: [], schedules: [], skills: [], templates: [], providerKeys: {},
      };
      this.save();
    }
  }
  private save(): void {
    try { writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch { /* disk hiccup — retry next save */ }
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
  createProject(args: { name: string; template?: string; instructions?: string; color?: string }): Project {
    const ws = this.data.workspace ?? this.createWorkspace('My Workspace');
    const p: Project = {
      id: id(), workspaceId: ws.id, name: args.name,
      template: args.template ?? 'claude-code', instructions: args.instructions ?? '', color: args.color ?? 'blue', createdAt: now(),
    };
    this.data.projects.push(p); this.save();
    return p;
  }

  // ── Jobs ────────────────────────────────────────────────────────────
  listJobs(projectId?: string): Job[] {
    const all = [...this.data.jobs].sort((a, b) => b.updatedAt - a.updatedAt);
    return projectId ? all.filter(j => j.projectId === projectId) : all.slice(0, 200);
  }
  getJob(jobId: string): Job | undefined { return this.data.jobs.find(j => j.id === jobId); }
  createJob(projectId: string, input: string, title = '', effort: Effort = 'balanced'): Job {
    const t = now();
    const j: Job = {
      id: id(), projectId, title: title || input.slice(0, 60), status: 'pending', phase: 'Queued', progress: 0,
      input, output: null, error: null, effort, cost: 0, tokens: 0, stage: '', createdAt: t, updatedAt: t,
    };
    this.data.jobs.push(j); this.save();
    return j;
  }
  updateJob(jobId: string, patch: Partial<Pick<Job, 'status' | 'phase' | 'progress' | 'output' | 'error' | 'cost' | 'tokens' | 'stage'>>): Job {
    const cur = this.getJob(jobId);
    if (!cur) throw Object.assign(new Error(`job not found: ${jobId}`), { statusCode: 404 });
    Object.assign(cur, patch, { updatedAt: now() });
    this.save();
    return cur;
  }

  // ── Approvals ───────────────────────────────────────────────────────
  listApprovals(status?: ApprovalStatus): Approval[] {
    const all = [...this.data.approvals].sort((a, b) => b.createdAt - a.createdAt);
    return status ? all.filter(a => a.status === status) : all.slice(0, 200);
  }
  createApproval(a: { projectId?: string | null; kind?: ApprovalKind; title: string; subtitle?: string; detail?: string }): Approval {
    const rec: Approval = {
      id: id(), projectId: a.projectId ?? null, kind: a.kind ?? 'review', title: a.title,
      subtitle: a.subtitle ?? '', detail: a.detail ?? '', status: 'pending', createdAt: now(), resolvedAt: null,
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
  createSchedule(s: { projectId?: string | null; title: string; time?: string; cadence?: string }): Schedule {
    const rec: Schedule = {
      id: id(), projectId: s.projectId ?? null, title: s.title, time: s.time ?? '', cadence: s.cadence ?? 'daily',
      enabled: true, nextRun: null, createdAt: now(),
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

  // ── Skills / Templates ─────────────────────────────────────────────
  listSkills(): Skill[] { return [...this.data.skills].sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name)); }
  toggleSkill(skillId: string): Skill | undefined {
    const s = this.data.skills.find(x => x.id === skillId);
    if (!s) return undefined;
    s.enabled = !s.enabled; this.save();
    return s;
  }
  listTemplates(): Template[] { return [...this.data.templates].sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name)); }

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
    const byProject = this.listProjects().map(p => ({
      projectId: p.id, name: p.name, color: p.color,
      spent: Math.round(this.data.jobs.filter(j => j.projectId === p.id).reduce((a, j) => a + j.cost, 0) * 100) / 100,
    }));
    const spent = Math.round(byProject.reduce((a, b) => a + b.spent, 0) * 100) / 100;
    return { cap, spent, byProject };
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

  /** Full snapshot pushed to the relay so phone/web remotes can mirror this Mac. */
  snapshot(providers: unknown): Record<string, unknown> {
    return {
      workspace: this.data.workspace,
      workspaces: this.data.workspace ? [this.data.workspace] : [],
      projects: this.listProjects(),
      jobs: this.listJobs(),
      approvals: this.listApprovals(),
      schedules: this.listSchedules(),
      skills: this.listSkills(),
      templates: this.listTemplates(),
      budget: this.budget(),
      dashboard: this.dashboard(),
      providers,
      routing: this.routing(),
      at: now(),
    };
  }

  // ── Seed (first run only — same demo content the design shipped with) ─
  private seedIfEmpty(): void {
    if (this.data.workspace) return;
    const ws = this.createWorkspace('Atlas Studio', 200);
    void ws;
    const mkProject = (name: string, template: string, color: string, instructions: string) =>
      this.createProject({ name, template, instructions, color });
    const atlas = mkProject('Atlas API', 'claude-code', 'blue', 'TypeScript, Fastify, Postgres. Be terse.');
    const content = mkProject('Q3 Content', 'claude-design', 'purple', 'Brand voice: calm, confident.');
    const scan = mkProject('Market Scan', 'research', 'indigo', 'Weekly competitor + pricing digest.');
    const brand = mkProject('Brand Refresh', 'claude-design', 'teal', 'Export-ready assets at @1x/@2x/@3x.');
    const infra = mkProject('Infra / CI', 'claude-code', 'orange', 'Keep the pipeline green.');

    const mkJob = (p: Project, title: string, effort: Effort, patch: Partial<Job>) => {
      const j = this.createJob(p.id, title, title, effort);
      this.updateJob(j.id, patch as Parameters<Store['updateJob']>[1]);
    };
    mkJob(atlas, 'Refactor auth service', 'deep', { status: 'running', phase: 'Building', progress: 64, cost: 0.42, tokens: 18200, stage: 'patching 3 call sites in routes/' });
    mkJob(atlas, 'Add rate-limiter tests', 'balanced', { status: 'running', phase: 'Building', progress: 28, cost: 0.21, tokens: 9700, stage: 'generating fixtures for 429 path' });
    mkJob(brand, 'Export icon set @3x', 'balanced', { status: 'running', phase: 'Rendering', progress: 72, cost: 0.12, tokens: 6100, stage: 'optimizing with pngquant…' });
    mkJob(content, 'Draft launch thread', 'balanced', { status: 'running', phase: 'Reviewing', progress: 88, cost: 0.07, tokens: 11400, stage: 'tightening hook on post 1/6' });
    mkJob(atlas, 'Merge PR #482 — auth refactor', 'deep', { status: 'done', phase: 'Done', progress: 100, cost: 8.10, tokens: 41000, output: 'Merged. 12 files changed, +840 −210.' });
    mkJob(atlas, 'Migrate session store to Redis', 'deep', { status: 'done', phase: 'Done', progress: 100, cost: 6.40, tokens: 33000, output: 'Done. Cutover behind a flag.' });
    mkJob(content, 'Generate OG images', 'balanced', { status: 'done', phase: 'Done', progress: 100, cost: 0.34, tokens: 4200, output: '6 OG cards exported.' });
    mkJob(scan, 'Competitor digest', 'deep', { status: 'done', phase: 'Done', progress: 100, cost: 6.80, tokens: 28000, output: 'Digest ready — 4 movers this week.' });
    mkJob(brand, 'Color token audit', 'balanced', { status: 'done', phase: 'Done', progress: 100, cost: 3.90, tokens: 14000, output: 'Audit complete, 9 tokens reconciled.' });
    mkJob(infra, 'Dependency audit', 'balanced', { status: 'done', phase: 'Done', progress: 100, cost: 0.12, tokens: 5000, output: '2 advisories patched.' });
    mkJob(infra, 'Nightly test suite', 'balanced', { status: 'failed', phase: 'Failed', cost: 0.18, tokens: 7000, error: 'flaky: 2 timeouts in payments.spec' });
    mkJob(scan, 'Deep pricing run', 'max', { status: 'pending', phase: 'Queued' });

    this.createApproval({ projectId: atlas.id, kind: 'merge', title: 'Merge PR #482 — auth refactor', subtitle: '12 files · +840 −210', detail: 'Refactors the auth service to a token-bucket limiter and moves sessions to Redis behind a flag.' });
    this.createApproval({ projectId: scan.id, kind: 'budget', title: 'Deep run will exceed the $5 cap', subtitle: 'Est. $6.40 · competitor digest', detail: 'The weekly competitor digest needs a deep run estimated at $6.40, above the per-job $5 cap.' });
    this.createApproval({ projectId: content.id, kind: 'publish', title: 'Publish “Launch week” thread to X', subtitle: '6 posts · scheduled 14:00', detail: 'A 6-post thread is ready to publish to X at 14:00.' });
    this.createApproval({ projectId: brand.id, kind: 'review', title: 'Approve export — 48 assets', subtitle: '48 assets · @1x/@2x/@3x', detail: 'Brand refresh export bundle is ready for review before handoff.' });

    this.createSchedule({ projectId: scan.id, title: 'Competitor digest', time: '14:00', cadence: 'daily' });
    this.createSchedule({ projectId: content.id, title: 'Newsletter draft', time: '16:30', cadence: 'weekly' });
    this.createSchedule({ projectId: infra.id, title: 'Nightly test suite', time: '18:00', cadence: 'daily' });
    this.createSchedule({ projectId: brand.id, title: 'Asset backup', time: '21:00', cadence: 'daily' });
    this.createSchedule({ projectId: infra.id, title: 'Dependency audit', time: '06:00', cadence: 'weekly' });

    const mkSkill = (name: string, description: string, category: string, kind: string, enabled: boolean) => {
      this.data.skills.push({ id: id(), name, description, category, kind, version: '1.0.0', enabled, createdAt: now() });
    };
    mkSkill('Web Search', 'Search the live web and cite sources.', 'Core', 'builtin', true);
    mkSkill('Code Interpreter', 'Run sandboxed Python for data + analysis.', 'Core', 'builtin', true);
    mkSkill('File System', 'Read & write files in the project workspace.', 'Core', 'builtin', true);
    mkSkill('Shell', 'Execute shell commands in a sandbox.', 'Core', 'builtin', false);
    mkSkill('GitHub', 'PRs, issues, and code review.', 'Integrations', 'mcp', true);
    mkSkill('Slack', 'Post updates and read channels.', 'Integrations', 'mcp', true);
    mkSkill('Linear', 'Create and update issues.', 'Integrations', 'mcp', false);
    mkSkill('Notion', 'Read & write docs and databases.', 'Integrations', 'mcp', false);
    mkSkill('Postgres', 'Query the production read-replica.', 'Integrations', 'mcp', true);
    mkSkill('Image Generation', 'Generate and edit images.', 'Media', 'builtin', true);
    mkSkill('Video Render', 'Compose and render short clips.', 'Media', 'builtin', false);
    mkSkill('Speech', 'Text-to-speech and transcription.', 'Media', 'builtin', false);

    const mkTemplate = (name: string, description: string, category: string, icon: string, engine: string) => {
      this.data.templates.push({ id: id(), name, description, category, icon, engine, createdAt: now() });
    };
    mkTemplate('Claude Code', 'Autonomous coding agent for a repo.', 'Build', 'terminal', 'claude-code');
    mkTemplate('Claude Design', 'Design + front-end generation.', 'Build', 'clapper', 'claude-design');
    mkTemplate('Deep Research', 'Multi-source research with citations.', 'Research', 'telescope', 'research');
    mkTemplate('Content Studio', 'Drafts, threads, and newsletters.', 'Content', 'send', 'claude-design');
    mkTemplate('Market Scan', 'Recurring competitor + pricing digest.', 'Research', 'gauge', 'research');
    mkTemplate('Data Pipeline', 'ETL + scheduled analysis jobs.', 'Build', 'layers', 'claude-code');
    this.save();
  }
}
