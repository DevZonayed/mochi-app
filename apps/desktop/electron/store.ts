/* Maestro local store — the source of truth lives ON THIS MAC.

   A JSON-file store in Electron userData holding every domain entity
   (workspace, projects, jobs, approvals, schedules, skills, templates,
   media assets, publish drafts, research briefs, comms bindings, events,
   settings) plus device identity for the relay. The remote server never
   owns this data; it only mirrors the snapshot we push for the phone/web
   remote controls. */

import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { quietDeadline } from './whatsapp-quiet.js';
import { WaStore, type WaChatMeta, type WaStoredMessage, type WaMessageInput, type WaChatKind } from './wa-store.js';
import type { RemoteDevice } from './relay.js';

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
export type ProjectKind = 'coding' | 'design' | 'content' | 'research' | 'general';

export interface Workspace { id: string; name: string; budgetCap: number; createdAt: number }
export interface Project {
  id: string; workspaceId: string; name: string; template: string; instructions: string; color: string;
  kind?: ProjectKind; path?: string; repoUrl?: string;
  /** Worktree base branch override (else auto-detected from origin/HEAD). */
  defaultBaseBranch?: string;
  /** Shell script run once in each new session worktree (e.g. install deps). */
  setupScript?: string;
  /** Gitignored files copied into each new session worktree. Default ['.env*'].
      A committed `.worktreeinclude` file at the repo root overrides this. */
  copyGlobs?: string[];
  /** Whether sessions of this project may run their dev server / background tasks
      at the same time. 'concurrent' (default) → each session gets its own isolated
      MOCHI_PORT block; 'nonconcurrent' → only one session may run at a time
      (project depends on one fixed port / DB / Docker stack). */
  runMode?: 'concurrent' | 'nonconcurrent';
  /** Manual display order from drag-and-drop. Lower = earlier. Unset → sorts by createdAt. */
  order?: number;
  createdAt: number;
  /** Set on create + bumped on every mutation (incl. reorder). Drives the
      relay's delta-sync filter (/api/sync?since=ts). */
  updatedAt: number;
}
/** One step of an agent run, in order: prose, a tool/skill invocation, or the
    final result. The chat renders these as separate blocks with timings. */
export interface TranscriptItem {
  kind: 'text' | 'thinking' | 'tool' | 'result' | 'ask' | 'review' | 'image';
  /** text/result: the content. thinking: the model's reasoning prose. tool: the HUMAN label (Bash description, relative file path, search pattern…). ask: prompt. review: the findings. image: a short caption (the prompt). */
  text: string;
  /** tool: tool name. review: the reviewer engine's label. */
  name?: string;
  /** tool: a secondary, de-emphasized detail shown under the human label — e.g. the
      raw shell command behind a Bash 'description'. Absent when there's nothing extra
      to show (the label already IS the detail). */
  cmd?: string;
  toolStatus?: 'running' | 'done' | 'error';
  /** review only: the reviewer's verdict. */
  verdict?: 'approved' | 'needs-work';
  /** review only: the primary went on to fix the flagged findings → show as resolved. */
  resolved?: boolean;
  durMs?: number;
  /** file-writing tools only: a capped snapshot of the content written, for the hover preview. */
  preview?: string;
  /** ask only: JSON of the AskUserQuestion input ({ questions:[{question,header,options,multiSelect}] }). */
  ask?: string;
  /** image only: the Asset id this image was registered as (resolved to bytes on the Mac via the maestro:assetImage IPC — never sent to the relay). */
  assetId?: string;
  /** image only: absolute local path on this Mac (used for reveal-in-Finder/copy; STRIPPED from the relay snapshot). */
  imagePath?: string;
  /** image only: alt text / the generation prompt. */
  alt?: string;
  /** image only: pixel dimensions, when known. */
  width?: number;
  height?: number;
  ts: number;
}

/** An image attached to a user message (pasted, dropped, or picked) — vision
    input for the agent. Saved on disk under `<projectCwd>/.continuum/Attachment/`
    and registered as an Asset; the absolute path is stripped from the relay
    snapshot (the phone sees only the basename). The `id` is the composer's chip
    id and matches the `«attach:id»` placeholder substituted into the prompt text
    AT the chip position. */
export interface ChatImage { id?: string; assetId: string; imagePath: string; mime: string; name?: string; width?: number; height?: number }

/** A non-image file attached to a user message. Every kind ('text' for pasted
    text / code, 'file' for any binary) is saved on disk under
    `<projectCwd>/.continuum/Attachment/` and referenced inline as `@<absPath>`
    at the chip position — the agent reads the file with its own tools (so a
    50k-char paste doesn't re-blast the prompt every turn). The `path` (Mac-
    local) and `content` (legacy) are stripped from the relay snapshot. */
export interface ChatFile {
  /** Composer chip id — matches the `«attach:id»` placeholder before substitution. */
  id?: string;
  name: string;
  kind: 'text' | 'file';
  mime?: string;
  bytes?: number;
  /** Legacy: text content inlined into the prompt. Stripped from the relay. New
      writes save the text to disk and leave this undefined; kept on the type for
      back-compat with old persisted jobs. */
  content?: string;
  /** Mac-local saved path (under `.continuum/Attachment/`). Stripped from the relay. */
  path?: string;
  /** short display preview (first chars / filename). */
  preview?: string;
}

export interface Job {
  id: string; projectId: string; title: string; status: JobStatus; phase: string; progress: number;
  input: string; output: string | null; error: string | null; effort: Effort; cost: number; tokens: number; stage: string;
  engine?: EngineId; model?: string;
  /** Goal mode: this turn ran autonomously toward the goal (SP2). */
  goal?: boolean;
  /** Chat turn: set when this job is one turn of a project chat session. */
  sessionId?: string;
  /** Images attached to the user's message (vision input). */
  inputImages?: ChatImage[];
  /** Non-image files attached to the user's message (text inlined, files referenced). */
  inputFiles?: ChatFile[];
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
  /** Archived (hidden from the project's active chat list, restorable). Set to the
      timestamp it was archived; absent = active. */
  archived?: number;
  /** Per-chat model overrides; absent = the workspace role defaults apply. */
  primary?: RoleChoice;
  reviewer?: RoleChoice | 'off';
  /** Isolated git branch for this chat (Conductor-style), once checked out. */
  branch?: string;
  /** Absolute path of this session's git worktree (Conductor-style isolation). */
  worktreePath?: string;
  /** The base branch this session's worktree was forked from. */
  baseBranch?: string;
  /** Set when the session's worktree has been pruned/archived. */
  archivedAt?: number;
  /** Memorable per-session city callsign ("lyon", "porto" …). Assigned once at
      creation; appears in the branch path (`mochi/<codename>/<slug>`) AND in the
      UI (rails, chat header) so the operator can refer to the session by name
      instead of an opaque id. */
  codename?: string;
  /** Timestamp the branch was auto-renamed from its initial codename-only form
      to a task-derived slug. Set once; gates the rename so we don't keep
      renaming as the title evolves (and to keep the name locked once a PR
      exists on GitHub). */
  branchRenamedAt?: number;
  /** Imported from an external store (Claude/Codex/Conductor) — read-only history. */
  importedFrom?: 'claude' | 'codex' | 'conductor';
  /** Source-side conversation id; dedupes re-imports of the same conversation. */
  externalId?: string;
  createdAt: number; updatedAt: number;
}
export interface Approval {
  id: string; projectId: string | null; kind: ApprovalKind; title: string; subtitle: string; detail: string;
  status: ApprovalStatus; jobId?: string | null; createdAt: number; resolvedAt: number | null;
  /** Set on create + bumped on every status change. Drives the relay's
      delta-sync filter (/api/sync?since=ts). */
  updatedAt: number;
}

/** Soft-deletion marker so a delta-sync caller learns about removals. The Mac
    keeps the last ~1000 across all entity kinds in `data.tombstones`. */
export interface Tombstone {
  kind: 'project' | 'session' | 'job' | 'asset' | 'approval';
  id: string;
  ts: number;
}
export interface Schedule {
  id: string; projectId: string | null; title: string; time: string; cadence: string; enabled: boolean;
  nextRun: number | null; lastRun?: number | null; createdAt: number;
  /** One-shot "wait & check": fire once at this absolute time, into a chat. */
  fireAt?: number; sessionId?: string; prompt?: string;
  /** A user-scheduled chat message (vs. a recurring schedule or wait-&-check):
      the composer intent is captured so it fires exactly as if sent by hand.
      'auto-continue' is the same one-shot, created automatically when a Claude run
      is blocked by the usage limit — it fires "continue" into the chat at reset.
      'auto-answer' fires the recommended option into the chat when an unanswered
      AskUserQuestion times out (the countdown the user sees on the question card).
      'keep-going' fires an organized "continue" message into the chat when the
      model ended a turn on "want me to keep going?" and the user didn't reply
      within the wait window (image_0ss8f.png scenario).
      'retry-run' fires a fresh attempt of a failed (transient) job after the
      exponential backoff window (image_ni4jn.png scenario — "Interrupted —
      Maestro was restarted", overload, 429, 5xx).
      'whatsapp-analyze' is the per-chat quiet timer: it fires once a tracked
      WhatsApp chat has sat silent for 15 min, summarizing it back to the operator. */
  kind?: 'message' | 'auto-continue' | 'auto-answer' | 'keep-going' | 'retry-run' | 'whatsapp-analyze'; effort?: Effort; browser?: boolean; plan?: boolean; goal?: boolean;
  /** whatsapp-analyze only: the WhatsApp chat (JID) whose silence this timer watches. */
  chatId?: string;
  /** auto-answer only: when it was armed (base for the escalating-extend math),
      how many times the user extended, and whether it's been paused past the cap
      (paused = no auto-answer; the question waits indefinitely for a manual reply). */
  armedAt?: number; extends?: number; paused?: boolean;
  /** retry-run only: 1-indexed attempt number this scheduled retry represents
      (1..RETRY_MAX_ATTEMPTS). Surfaced in the schedule title + chat note. */
  retryAttempt?: number;
  /** retry-run / keep-going: original jobId this schedule was spawned from, so
      the UI can correlate the auto-recovery back to the failed run. */
  sourceJobId?: string;
  /** Interval cadence: fire every N minutes from `anchorAt` (defaults to createdAt).
      When set (>0) the schedule is interval-mode and ignores time/cadence. */
  everyMinutes?: number; anchorAt?: number;
  /** Clock-mode catch-up: if a daily/weekly slot was missed while the Mac was
      asleep, fire it once when next awake, provided now <= dueTime + window.
      catchUpWindowMs defaults to "rest of the local day". lastDueAt is the
      intended slot timestamp of the last fire (dedupe key); lastFireLate marks
      that the last fire was a catch-up (drives the "ran late" notice). */
  catchUp?: boolean; catchUpWindowMs?: number; lastDueAt?: number; lastFireLate?: boolean;
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

/* ── Feedback (operator/tester feedback collected from any surface) ──────
   Lives on the Mac like every other entity; the relay only mirrors it so a
   remote can submit + the operator can review. No secrets — safe to relay. */
export type FeedbackCategory = 'bug' | 'idea' | 'other';
export type FeedbackStatus = 'new' | 'triaged' | 'done';
export type FeedbackSource = 'desktop' | 'web' | 'phone';
/** Lightweight, auto-captured context so a piece of feedback is actionable
    without the sender having to describe their environment. */
export interface FeedbackContext {
  screen?: string;      // current route/screen key, e.g. 'workspace'
  appVersion?: string;
  platform?: string;    // 'darwin' | 'web' | 'ios' | …
  projectId?: string | null;
}
export interface Feedback {
  id: string;
  category: FeedbackCategory;
  message: string;
  status: FeedbackStatus;
  source: FeedbackSource;
  context?: FeedbackContext;
  /** Set once escalated to a GitHub issue. */
  issueUrl?: string;
  issueNumber?: number;
  createdAt: number;
  updatedAt: number;
}

export type CommsProvider = 'telegram' | 'whatsapp';
export interface ChatPermissions { startJobs: boolean; receiveReports: boolean; approveGates: boolean }
export interface ChatBinding {
  chatId: string; name: string; kind: 'dm' | 'group';
  /** Which channel this chat lives on. Absent on legacy (Telegram) bindings. */
  provider?: CommsProvider;
  projectId: string | null;
  /** WhatsApp quiet-timer: the session this chat's summaries are filed under. */
  sessionId?: string | null;
  permissions: ChatPermissions; boundAt: number;
}
export interface PendingChat { chatId: string; name: string; kind: 'dm' | 'group'; firstText: string; at: number }
export interface CommEvent { id: string; dir: 'in' | 'out'; chatId: string; chatName: string; payload: string; status: 'received' | 'sent' | 'failed'; at: number }
export interface TelegramState { offset: number; botUsername: string | null; connectedAt: number | null }

/** WhatsApp account/connection state. The desktop owns one Baileys socket; this
    is the persisted view of it. `sendApproved` is the one-time confirmation gate:
    no summary is ever sent until the operator approves the first send. */
export interface WhatsAppState {
  connected: boolean;
  /** The linked number's own JID (where summaries are sent — "message yourself"). */
  jid: string | null;
  name: string | null;
  linkedAt: number | null;
  /** The one-time send gate: until the operator approves, no summary is sent. */
  sendApproved: boolean;
  /** Durable outbox of summaries awaiting delivery — held until sending is approved
      AND the socket is connected, then flushed (retried). Survives restarts so a
      power-off mid-window never drops a summary (it's delivered on next availability). */
  pendingSummaries?: { id: string; text: string; chatName: string; at: number }[];
  /** Whether the in-app agent may message contacts OTHER than your own number.
      Off by default — the agent can always message your own number (confirmations,
      updates), but messaging real contacts requires this opt-in. */
  agentSendToOthers?: boolean;
  /** The operator's PERSONAL number (JID) where summaries + agent confirmations are
      sent. Distinct from `jid` (the linked account — often a separate "app" number).
      When unset, notifications fall back to the linked account's own "note to self". */
  notifyJid?: string | null;
}
export const DEFAULT_WHATSAPP_STATE: WhatsAppState = { connected: false, jid: null, name: null, linkedAt: null, sendApproved: false, pendingSummaries: [], agentSendToOthers: false, notifyJid: null };

/** One captured WhatsApp message (normalized, text-only — media is noted as a kind). */
export interface WaMessage { id: string; chatId: string; fromMe: boolean; senderName: string; text: string; ts: number }
/** A tracked WhatsApp chat's capture log + the watermark of what's been summarized. */
export interface WaChat {
  chatId: string; name: string; kind: 'dm' | 'group';
  lastMessageAt: number;
  /** ts of the newest message already folded into a sent summary (quiet-once). */
  lastReportedAt: number;
  messages: WaMessage[];
}

export interface CommsStatus {
  telegram: { connected: boolean; botUsername: string | null; tokenLast4: string | null; messagesToday: number; bindings: number; pending: number };
  whatsapp: { connected: boolean; jid: string | null; name: string | null; tracked: number; sendApproved: boolean };
}

/** A built-in notification chime (synthesised client-side; 'none' = silent). */
export type NotificationSound = 'chime' | 'ping' | 'marimba' | 'glass' | 'pop' | 'none';
/** Device-notification preferences. Sounds play in the client (Web Audio); this
    is just the persisted config so it follows the operator across surfaces. */
export interface NotificationSettings {
  /** Master switch — off silences everything. */
  enabled: boolean;
  /** Play a sound when an agent finishes a response (a job reaches `done`). */
  onComplete: boolean;
  completeSound: NotificationSound;
  /** Play a sound when a chat needs attention (an approval gate or a failed job). */
  onAttention: boolean;
  attentionSound: NotificationSound;
  /** Output level, 0–1. */
  volume: number;
  /** Only chime when the app window isn't focused (so active work stays quiet). */
  onlyWhenUnfocused: boolean;
}
export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  onComplete: true,
  completeSound: 'chime',
  onAttention: true,
  attentionSound: 'ping',
  volume: 0.7,
  onlyWhenUnfocused: false,
};

export interface AppSettings {
  defaultEffort: Effort;
  defaultEngine: EngineId | 'auto';
  openAtLogin: boolean;
  rescanCadence: 'daily' | 'weekly' | 'onchange';
  /** Picker keys the user starred — surfaced first in the model picker. */
  favoriteModels?: string[];
  /** Target repo ("owner/repo") that feedback is escalated to as GitHub issues.
      Empty/undefined = issue creation is disabled until the operator sets one. */
  feedbackRepo?: string;
  /** Device-notification sound preferences. */
  notifications?: NotificationSettings;
  /** Opt-in: try a direct desktop↔phone WebRTC channel before the relay (default off). */
  p2pEnabled?: boolean;
}
export const DEFAULT_SETTINGS: AppSettings = { defaultEffort: 'balanced', defaultEngine: 'auto', openAtLogin: false, rescanCadence: 'onchange', favoriteModels: [], p2pEnabled: false, notifications: { ...DEFAULT_NOTIFICATIONS } };

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
  /** Pairing token the local browser extension must present on the control port. Shown in the app; never in snapshots. */
  extensionToken: string;
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
  /** Soft-deletion markers (last ~1000 across kinds). Lets delta-sync clients
      learn about removals without diffing the whole list. */
  tombstones?: Tombstone[];
  chatBindings: ChatBinding[];
  pendingChats: PendingChat[];
  commEvents: CommEvent[];
  feedback: Feedback[];
  telegram: TelegramState;
  /** WhatsApp account/connection state (the desktop-owned Baileys socket). */
  whatsapp: WhatsAppState;
  /** Per-chat captured WhatsApp messages + report watermark, keyed by chat JID. */
  waChats: Record<string, WaChat>;
  /** Locally (safeStorage-)encrypted provider API keys, base64. Never leaves this Mac. */
  providerKeys: Record<string, { cipherB64: string; last4: string; createdAt: number }>;
  /** Per-design element comments (Mochi-style): a CSS selector into the live
      design artifact + the operator's note. The design agent reads these to
      revise specific elements. Keyed by projectId. Mac-local; never relayed. */
  designComments?: Record<string, DesignComment[]>;
  /** Skills installed into a project (from the registry). The files live on disk
      at <project>/.claude/skills/<slug>/; this records the metadata for the UI +
      Codex prompt-injection. Keyed by projectId. Mac-local. */
  installedSkills?: Record<string, InstalledSkill[]>;
  /** Custom MCP servers the operator connected (a global library). Enabled ones
      are merged into every agent run — Claude's `mcpServers`, Codex's
      `-c mcp_servers.<name>=…`. Mac-local; secrets referenced by env-var name. */
  mcpServers?: CustomMcpServer[];
  /** Auto-retry streak counter per chat session (or per one-off jobId), keyed
      by `session:<id>` / `job:<id>`. Bumped each time a retry schedule is armed
      and reset to 0 on a successful run for the same key, so the linear 1m → 10m
      backoff resumes from 1 minute after a single recovery (image_ni4jn.png).
      Mac-local; resets if the store is missing this map (older snapshots). */
  retryCounters?: Record<string, number>;
  /** Per-session running count of consecutive auto-continues issued by the
      keep-going follow-up (image_0ss8f.png). Reset on the next genuine user
      message. Capped by KEEP_GOING_MAX_PER_SESSION to keep a stuck agent from
      burning through tokens. Mac-local. */
  keepGoingCounters?: Record<string, number>;
}

/** A literal key/value pair — an env var or an HTTP header. */
export interface McpKv { key: string; value: string }

/** A custom MCP server the operator connected via Settings → MCP servers.
    `stdio` launches a local `command`/`args` with `env`; `http` connects to a
    streamable-HTTP endpoint. Secrets are referenced BY ENV-VAR NAME
    (bearerTokenEnv, envPassthrough, headerEnv) and resolved from the host
    environment at spawn time — the secret value itself is never persisted. */
export interface CustomMcpServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  // stdio transport
  command?: string;
  args?: string[];
  env?: McpKv[];               // literal key=value (non-secret config)
  envPassthrough?: string[];   // host env var NAMES forwarded as-is
  cwd?: string;
  // http (streamable) transport
  url?: string;
  bearerTokenEnv?: string;     // env var NAME holding the bearer token
  headers?: McpKv[];           // literal header key=value
  headerEnv?: { key: string; valueEnv: string }[]; // header <- host env var NAME
  /** Registry skill ids attached to this server — installed on-demand and
      surfaced to the agent whenever this server is active in a run. */
  skillIds: string[];
  createdAt: number;
}

/** A registry skill installed into a project (metadata mirror of the on-disk folder). */
export interface InstalledSkill {
  id: string;          // registry id, e.g. anthropics/skills/frontend-design
  slug: string;        // on-disk folder name under .claude/skills/
  name: string;
  description?: string;
  risk?: string;
  source?: string;     // upstream GitHub url
  version?: string;
  sha256?: string;
  enabled?: boolean;
  disabledReason?: string | null;
  mirrorRepo?: string | null;
  auditStatus?: string | null;
  /** Who installed it: 'operator' from the UI, 'agent' when the model self-installed mid-run. */
  addedBy?: 'operator' | 'agent';
  installedAt: number;
}

/** A note anchored to a specific element of a live design (by CSS selector). */
export interface DesignComment {
  id: string;
  projectId: string;
  selector: string;
  label: string;            // human glyph for the element, e.g. `button · "Get started"`
  note: string;
  status: 'open' | 'resolved';
  createdAt: number;
}

const CATALOG_VERSION = 2;
/** Delta-sync: how many soft-deletion markers to keep before evicting the
    oldest. Sized for ~1 week of typical churn on a busy user. A client whose
    last sync predates the oldest tombstone should treat the next pull as a
    full re-sync (drop local store, GET /api/sync?since=0). */
const MAX_TOMBSTONES = 1000;
/** Job retention is two-tiered.
    - `JOB_TRANSCRIPT_RETAIN` jobs keep their full transcript in memory (and on
      disk). Beyond that, finished jobs have their `transcript` field stripped
      — the job, its tokens/cost/title still exist for stats and the chat list,
      but the heavy structured-events payload is dropped. Re-opening an old chat
      shows the persisted `output` text instead of the per-step replay.
    - Beyond `JOB_HARD_RETAIN` total jobs, the oldest finished ones are deleted
      outright (a tombstone is recorded so the relay learns).
    Sized so a heavy operator (~50 jobs/day) keeps a week of full transcripts
    and roughly a month of metadata. Adjust if real-world churn proves different. */
const JOB_TRANSCRIPT_RETAIN = 350;
const JOB_HARD_RETAIN = 1500;
const SEED_PROJECT_NAMES = ['Atlas API', 'Q3 Content', 'Market Scan', 'Brand Refresh', 'Infra / CI'];
const SEED_JOB_TITLE = 'Merge PR #482 — auth refactor';

const ASSET_TINTS = ['#5b8cff', '#9b6bff', '#41c8d4', '#ff9f6b', '#6bd49a', '#ff6b9f'];

export class Store {
  private file: string;
  private data!: StoreData;
  /** Full WhatsApp chat + message store (every chat, JSONL-backed). The
      monolithic `waChats` field is legacy — migrated into this on first load. */
  readonly wa: WaStore;

  constructor() {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'maestro-store.json');
    this.wa = new WaStore(join(dir, 'whatsapp', 'primary', 'store'));
    this.load();
    this.migrateInlineWaChats();
    this.seedCatalog();
  }

  /** One-time lift of any legacy inline `waChats` (captured by older builds into
      maestro-store.json) into the JSONL-backed WaStore, then clear the inline copy. */
  private migrateInlineWaChats(): void {
    const inline = this.data.waChats;
    if (!inline || Object.keys(inline).length === 0) return;
    for (const c of Object.values(inline)) {
      this.wa.upsertChat({ chatId: c.chatId, name: c.name, kind: c.kind, lastMessageAt: c.lastMessageAt, lastReportedAt: c.lastReportedAt });
      for (const m of c.messages) this.wa.appendMessage({ chatId: c.chatId, fromMe: m.fromMe, senderName: m.senderName, text: m.text, ts: m.ts, kind: 'text' }, { bumpUnread: false });
    }
    this.data.waChats = {};
    this.save();
  }

  private load(): void {
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      let dirty = false;
      // migrations for stores written by older builds (dirty-flag pattern)
      if (!this.data.accessToken) { this.data.accessToken = newPairingToken(); dirty = true; }
      if (!this.data.extensionToken) { this.data.extensionToken = newPairingToken(); dirty = true; }
      if (!this.data.routing) { this.data.routing = { ...DEFAULT_ROUTING }; dirty = true; }
      if (!this.data.designComments) { this.data.designComments = {}; dirty = true; }
      if (!this.data.installedSkills) { this.data.installedSkills = {}; dirty = true; }
      if (!this.data.mcpServers) { this.data.mcpServers = []; dirty = true; }
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
      if (this.data.settings && !this.data.settings.notifications) { this.data.settings.notifications = { ...DEFAULT_NOTIFICATIONS }; dirty = true; }
      if (!this.data.sessions) { this.data.sessions = []; dirty = true; }
      if (!this.data.assets) { this.data.assets = []; dirty = true; }
      if (!this.data.publishDrafts) { this.data.publishDrafts = []; dirty = true; }
      if (!this.data.publishLedger) { this.data.publishLedger = []; dirty = true; }
      if (!this.data.briefs) { this.data.briefs = []; dirty = true; }
      if (!this.data.researchRuns) { this.data.researchRuns = []; dirty = true; }
      if (!this.data.events) { this.data.events = []; dirty = true; }
      if (!this.data.tombstones) { this.data.tombstones = []; dirty = true; }
      // Backfill `updatedAt` on entities written by an older build (delta-sync
      // protocol needs it on every row, but it's been added incrementally).
      for (const p of this.data.projects) if (p.updatedAt === undefined) { p.updatedAt = p.createdAt; dirty = true; }
      for (const a of this.data.approvals) if (a.updatedAt === undefined) { a.updatedAt = a.resolvedAt ?? a.createdAt; dirty = true; }
      if (!this.data.chatBindings) { this.data.chatBindings = []; dirty = true; }
      if (!this.data.pendingChats) { this.data.pendingChats = []; dirty = true; }
      if (!this.data.commEvents) { this.data.commEvents = []; dirty = true; }
      if (!this.data.feedback) { this.data.feedback = []; dirty = true; }
      if (!this.data.telegram) { this.data.telegram = { offset: 0, botUsername: null, connectedAt: null }; dirty = true; }
      if (!this.data.whatsapp) { this.data.whatsapp = { ...DEFAULT_WHATSAPP_STATE, pendingSummaries: [] }; dirty = true; }
      if (this.data.whatsapp && !this.data.whatsapp.pendingSummaries) {
        const old = (this.data.whatsapp as { pendingSummary?: { text: string; chatName: string; at: number } | null }).pendingSummary;
        this.data.whatsapp.pendingSummaries = old ? [{ id: id(), text: old.text, chatName: old.chatName, at: old.at }] : [];
        delete (this.data.whatsapp as { pendingSummary?: unknown }).pendingSummary;
        dirty = true;
      }
      if (!this.data.waChats) { this.data.waChats = {}; dirty = true; }

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
      // Existing stores from old builds may carry thousands of jobs with full
      // transcripts (the leak we just fixed). Run the retention sweep once at
      // boot so a long-lived install starts paying back memory immediately,
      // instead of waiting for the next createJob to trigger the first sweep.
      const beforeLen = this.data.jobs.length;
      this.pruneOldJobs();
      if (this.data.jobs.length !== beforeLen) this.save();
    } catch {
      this.data = {
        deckId: id(), deckSecret: id(), accessToken: newPairingToken(), extensionToken: newPairingToken(),
        routing: { ...DEFAULT_ROUTING }, settings: { ...DEFAULT_SETTINGS }, catalogVersion: CATALOG_VERSION,
        workspace: null,
        projects: [], jobs: [], sessions: [], approvals: [], schedules: [], skills: [], templates: [],
        assets: [], publishDrafts: [], publishLedger: [], briefs: [], researchRuns: [], events: [],
        tombstones: [],
        chatBindings: [], pendingChats: [], commEvents: [], feedback: [],
        telegram: { offset: 0, botUsername: null, connectedAt: null },
        whatsapp: { ...DEFAULT_WHATSAPP_STATE, pendingSummaries: [] }, waChats: {},
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
  /** Rotate the pairing code (regenerate): persists a fresh token; unpairs every remote. */
  setAccessToken(token: string): void { this.data.accessToken = token; this.save(); }
  get extensionToken(): string { return this.data.extensionToken; }

  // Remote-device presence (transient; the relay reports the full list, never persisted).
  private remoteDevices: RemoteDevice[] = [];
  setRemoteDevices(devices: RemoteDevice[]): RemoteDevice[] {
    this.remoteDevices = devices;
    return this.remoteDevices;
  }
  getRemoteDevices(): RemoteDevice[] {
    return this.remoteDevices;
  }

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

  // ── Design comments (per-element notes the design agent revises against) ──
  listDesignComments(projectId: string): DesignComment[] {
    return this.data.designComments?.[projectId] ?? [];
  }
  addDesignComment(projectId: string, c: { selector: string; label: string; note: string }): DesignComment {
    if (!this.data.designComments) this.data.designComments = {};
    const list = this.data.designComments[projectId] ?? (this.data.designComments[projectId] = []);
    const comment: DesignComment = {
      id: id(), projectId,
      selector: (c.selector || '').slice(0, 600),
      label: (c.label || '').slice(0, 200),
      note: (c.note || '').slice(0, 2000),
      status: 'open', createdAt: Date.now(),
    };
    list.push(comment);
    if (list.length > 200) list.splice(0, list.length - 200); // cap per design
    this.save();
    return comment;
  }
  setDesignCommentStatus(projectId: string, commentId: string, status: 'open' | 'resolved'): void {
    const c = this.data.designComments?.[projectId]?.find(x => x.id === commentId);
    if (!c) return;
    c.status = status; this.save();
  }
  deleteDesignComment(projectId: string, commentId: string): void {
    const list = this.data.designComments?.[projectId]; if (!list) return;
    this.data.designComments![projectId] = list.filter(x => x.id !== commentId);
    this.save();
  }

  // ── Installed skills (registry skills copied into a project) ─────────────
  listInstalledSkills(projectId: string): InstalledSkill[] {
    return this.data.installedSkills?.[projectId] ?? [];
  }
  recordSkillInstall(projectId: string, s: Omit<InstalledSkill, 'installedAt'>): InstalledSkill {
    if (!this.data.installedSkills) this.data.installedSkills = {};
    const list = this.data.installedSkills[projectId] ?? (this.data.installedSkills[projectId] = []);
    const rec: InstalledSkill = { ...s, installedAt: Date.now() };
    const i = list.findIndex(x => x.id === s.id || x.slug === s.slug);
    if (i >= 0) list[i] = rec; else list.push(rec);
    this.save();
    return rec;
  }
  removeInstalledSkill(projectId: string, idOrSlug: string): void {
    const list = this.data.installedSkills?.[projectId]; if (!list) return;
    this.data.installedSkills![projectId] = list.filter(x => x.id !== idOrSlug && x.slug !== idOrSlug);
    this.save();
  }
  /** Flip a project skill's enabled flag (the on-disk SKILL.md move is done by the caller). */
  setInstalledSkillEnabled(projectId: string, idOrSlug: string, enabled: boolean): InstalledSkill | null {
    const list = this.data.installedSkills?.[projectId]; if (!list) return null;
    const rec = list.find(x => x.id === idOrSlug || x.slug === idOrSlug); if (!rec) return null;
    rec.enabled = enabled;
    if (enabled) rec.disabledReason = null;
    this.save();
    return rec;
  }
  /** Upsert a bare record for a skill found on disk but not yet tracked (e.g. dropped in manually). */
  ensureInstalledSkill(projectId: string, rec: Omit<InstalledSkill, 'installedAt'>): InstalledSkill {
    if (!this.data.installedSkills) this.data.installedSkills = {};
    const list = this.data.installedSkills[projectId] ?? (this.data.installedSkills[projectId] = []);
    const existing = list.find(x => x.id === rec.id || x.slug === rec.slug);
    if (existing) return existing;
    const full: InstalledSkill = { ...rec, installedAt: Date.now() };
    list.push(full);
    this.save();
    return full;
  }

  // ── Custom MCP servers (operator-connected; merged into agent runs) ─────
  listMcpServers(): CustomMcpServer[] { return this.data.mcpServers ? [...this.data.mcpServers] : []; }
  getMcpServer(serverId: string): CustomMcpServer | undefined { return this.data.mcpServers?.find(s => s.id === serverId); }
  addMcpServer(input: Omit<CustomMcpServer, 'id' | 'createdAt'>): CustomMcpServer {
    if (!this.data.mcpServers) this.data.mcpServers = [];
    const rec: CustomMcpServer = { ...input, id: id(), createdAt: now() };
    this.data.mcpServers.push(rec);
    this.save();
    return rec;
  }
  updateMcpServer(serverId: string, patch: Partial<Omit<CustomMcpServer, 'id' | 'createdAt'>>): CustomMcpServer {
    const cur = this.getMcpServer(serverId);
    if (!cur) throw Object.assign(new Error('mcp server not found'), { statusCode: 404 });
    Object.assign(cur, patch);
    this.save();
    return cur;
  }
  setMcpServerEnabled(serverId: string, enabled: boolean): CustomMcpServer | null {
    const cur = this.getMcpServer(serverId);
    if (!cur) return null;
    cur.enabled = enabled;
    this.save();
    return cur;
  }
  removeMcpServer(serverId: string): void {
    if (!this.data.mcpServers) return;
    this.data.mcpServers = this.data.mcpServers.filter(s => s.id !== serverId);
    this.save();
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
  // Manual `order` (small ints from drag-and-drop) sorts ahead of unordered
  // projects, which fall back to createdAt — so newly-created projects land at
  // the end of a hand-ordered list and legacy projects keep creation order.
  listProjects(): Project[] { return [...this.data.projects].sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt)); }
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
    const t = now();
    const p: Project = {
      id: id(), workspaceId: ws.id, name: this.uniqueProjectName(args.name),
      template: args.template ?? 'claude-code', instructions: args.instructions ?? '', color: args.color ?? 'blue',
      kind: args.kind, path: args.path, repoUrl: args.repoUrl,
      createdAt: t, updatedAt: t,
    };
    this.data.projects.push(p); this.save();
    return p;
  }
  updateProject(projectId: string, patch: Partial<Pick<Project, 'name' | 'instructions' | 'color' | 'kind' | 'path' | 'repoUrl' | 'template' | 'defaultBaseBranch' | 'setupScript' | 'copyGlobs' | 'runMode'>>): Project {
    const cur = this.getProject(projectId);
    if (!cur) throw Object.assign(new Error('project not found'), { statusCode: 404 });
    Object.assign(cur, patch, { updatedAt: now() });
    this.save();
    return cur;
  }
  /** Persist a manual display order from drag-and-drop. Each id's position in
      `orderedIds` becomes its `order`; ids not present keep their current order.
      Bumps `updatedAt` on the touched projects so delta-sync clients reorder too. */
  reorderProjects(orderedIds: string[]): Project[] {
    const t = now();
    orderedIds.forEach((pid, i) => {
      const p = this.data.projects.find(x => x.id === pid);
      if (p) { p.order = i; p.updatedAt = t; }
    });
    this.save();
    return this.listProjects();
  }
  /** Remove a project + its jobs/sessions/schedules. Files on disk are untouched.
      Records tombstones for every removed entity so delta-sync clients learn. */
  deleteProject(projectId: string): void {
    const i = this.data.projects.findIndex(p => p.id === projectId);
    if (i === -1) throw Object.assign(new Error('project not found'), { statusCode: 404 });
    this.data.projects.splice(i, 1);
    this.recordTombstone('project', projectId);
    for (const j of this.data.jobs) if (j.projectId === projectId) this.recordTombstone('job', j.id);
    for (const s of this.data.sessions) if (s.projectId === projectId) this.recordTombstone('session', s.id);
    this.data.jobs = this.data.jobs.filter(j => j.projectId !== projectId);
    this.data.sessions = this.data.sessions.filter(s => s.projectId !== projectId);
    this.data.schedules = this.data.schedules.filter(s => s.projectId !== projectId);
    for (const a of this.data.assets) if (a.projectId === projectId) a.projectId = null;
    this.save();
  }

  /** Append a soft-deletion marker so the relay can serve it through
      /api/sync?since=<ts>. Capped to the last MAX_TOMBSTONES entries — older
      ones drop, so very stale clients should treat that as "full re-sync". */
  private recordTombstone(kind: Tombstone['kind'], entityId: string): void {
    const list = this.data.tombstones ?? (this.data.tombstones = []);
    list.push({ kind, id: entityId, ts: now() });
    if (list.length > MAX_TOMBSTONES) list.splice(0, list.length - MAX_TOMBSTONES);
  }

  // ── Chat sessions ───────────────────────────────────────────────────
  listSessions(projectId?: string): ChatSession[] {
    const all = [...this.data.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    return (projectId ? all.filter(s => s.projectId === projectId) : all).slice(0, 100);
  }
  getSession(sessionId: string): ChatSession | undefined { return this.data.sessions.find(s => s.id === sessionId); }
  /** Codenames already in use inside `projectId` — used to pick a unique one
      for a new session. Cheap (a single linear scan over the project's chats). */
  usedCodenamesIn(projectId: string): Set<string> {
    const used = new Set<string>();
    for (const s of this.data.sessions) {
      if (s.projectId === projectId && s.codename) used.add(s.codename);
    }
    return used;
  }
  createSession(projectId: string, title: string, codename?: string): ChatSession {
    const t = now();
    const s: ChatSession = { id: id(), projectId, title: (title.trim() || 'New chat').slice(0, 60), createdAt: t, updatedAt: t };
    if (codename) s.codename = codename;
    this.data.sessions.push(s); this.save();
    return s;
  }
  updateSession(sessionId: string, patch: Partial<Pick<ChatSession, 'title' | 'sdkSessionId' | 'primary' | 'reviewer' | 'branch' | 'worktreePath' | 'baseBranch' | 'archivedAt' | 'codename' | 'branchRenamedAt'>>): ChatSession {
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
  /** Archive/unarchive without bumping updatedAt (archiving must not reorder the list). */
  setSessionArchived(sessionId: string, archived: boolean): ChatSession {
    const s = this.getSession(sessionId);
    if (!s) throw Object.assign(new Error('session not found'), { statusCode: 404 });
    s.archived = archived ? now() : undefined;
    // An archived chat shouldn't also sit pinned at the top.
    if (archived) s.pinned = undefined;
    this.save();
    return s;
  }
  deleteSession(sessionId: string): void {
    const i = this.data.sessions.findIndex(s => s.id === sessionId);
    if (i === -1) throw Object.assign(new Error('session not found'), { statusCode: 404 });
    this.data.sessions.splice(i, 1);
    this.recordTombstone('session', sessionId);
    // Turns stay in the jobs ledger (costs/audit) but leave the chat. Bump
    // each affected job's `updatedAt` so a delta-sync client re-fetches them.
    const t = now();
    for (const j of this.data.jobs) if (j.sessionId === sessionId) { j.sessionId = undefined; j.updatedAt = t; }
    this.save();
  }
  /** External-conversation ids already imported into a project (re-scan dedupe). */
  importedExternalIds(projectId: string): Set<string> {
    return new Set(this.data.sessions.filter(s => s.projectId === projectId && s.externalId).map(s => s.externalId as string));
  }
  /** Atomically add an imported conversation: one read-only session + its turns,
      with original timestamps preserved, persisting once. */
  commitImportedConversation(args: {
    projectId: string;
    title: string;
    source: 'claude' | 'codex' | 'conductor';
    externalId: string;
    createdAt: number;
    updatedAt: number;
    turns: { input: string; output: string; transcript: TranscriptItem[]; createdAt: number }[];
  }): { session: ChatSession; jobs: Job[] } {
    const sId = id();
    const session: ChatSession = {
      id: sId, projectId: args.projectId, title: (args.title.trim() || 'Imported chat').slice(0, 80),
      importedFrom: args.source, externalId: args.externalId,
      createdAt: args.createdAt || now(), updatedAt: args.updatedAt || now(),
    };
    const jobs: Job[] = args.turns.map(t => ({
      id: id(), projectId: args.projectId, title: (t.input || t.output || 'Message').slice(0, 60),
      status: 'done' as JobStatus, phase: 'Imported', progress: 100,
      input: t.input, output: t.output || null, error: null,
      effort: this.data.settings.defaultEffort, cost: 0, tokens: 0, stage: '',
      sessionId: sId, transcript: t.transcript,
      createdAt: t.createdAt || session.createdAt, updatedAt: t.createdAt || session.createdAt,
    }));
    this.data.sessions.push(session);
    this.data.jobs.push(...jobs);
    this.save();
    return { session, jobs };
  }

  // ── Jobs ────────────────────────────────────────────────────────────
  listJobs(projectId?: string, sessionId?: string): Job[] {
    const all = [...this.data.jobs].sort((a, b) => b.updatedAt - a.updatedAt);
    if (sessionId) return all.filter(j => j.sessionId === sessionId);
    return projectId ? all.filter(j => j.projectId === projectId) : all.slice(0, 200);
  }
  getJob(jobId: string): Job | undefined { return this.data.jobs.find(j => j.id === jobId); }
  createJob(projectId: string, input: string, title = '', effort?: Effort, sessionId?: string, inputImages?: ChatImage[], inputFiles?: ChatFile[]): Job {
    const t = now();
    const j: Job = {
      id: id(), projectId, title: title || input.slice(0, 60) || (inputImages?.length ? 'Image' : inputFiles?.length ? inputFiles[0].name : 'Message'), status: 'pending', phase: 'Queued', progress: 0,
      input, output: null, error: null, effort: effort ?? this.data.settings.defaultEffort, cost: 0, tokens: 0, stage: '',
      sessionId,
      ...(inputImages && inputImages.length ? { inputImages } : {}),
      ...(inputFiles && inputFiles.length ? { inputFiles } : {}),
      createdAt: t, updatedAt: t,
    };
    this.data.jobs.push(j);
    this.pruneOldJobs();
    this.save();
    return j;
  }

  /** Two-tier job retention sweep — the jobs ledger never trimmed itself, so a
      multi-week-running app would accumulate every job's structured transcript
      in V8 memory and on disk indefinitely. Called on createJob (so the prune
      runs at the natural cadence of new work) and during loadStore boot. */
  private pruneOldJobs(): void {
    const jobs = this.data.jobs;
    if (jobs.length <= JOB_TRANSCRIPT_RETAIN) return;
    // Sort by createdAt newest-first; the first N keep transcripts, then any
    // FINISHED job loses its transcript, and beyond JOB_HARD_RETAIN the oldest
    // finished ones are deleted. Running/pending jobs are never pruned.
    const byAge = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
    let stripped = 0;
    let deleted = 0;
    for (let i = JOB_TRANSCRIPT_RETAIN; i < byAge.length; i++) {
      const j = byAge[i];
      if (j.status === 'running' || j.status === 'pending') continue;
      if (j.transcript !== undefined && j.transcript.length > 0) {
        // Strip transcript but keep an empty array sentinel so older UI code
        // that expects an array doesn't surprise-crash.
        j.transcript = [];
        stripped++;
      }
    }
    if (byAge.length > JOB_HARD_RETAIN) {
      // Take the oldest finished jobs above the cap and remove them outright.
      const tail = byAge.slice(JOB_HARD_RETAIN).filter(j => j.status !== 'running' && j.status !== 'pending');
      const dropIds = new Set(tail.map(j => j.id));
      if (dropIds.size > 0) {
        this.data.jobs = jobs.filter(j => !dropIds.has(j.id));
        for (const id of dropIds) this.recordTombstone('job', id);
        deleted = dropIds.size;
      }
    }
    if (stripped > 0 || deleted > 0) {
      // Best-effort diagnostic — silent on success so a normal createJob is quiet.
      try { console.log(`[store] job prune: stripped=${stripped} deleted=${deleted} total=${this.data.jobs.length}`); } catch { /* */ }
    }
  }
  updateJob(jobId: string, patch: Partial<Pick<Job, 'status' | 'phase' | 'progress' | 'output' | 'error' | 'cost' | 'tokens' | 'stage' | 'engine' | 'model' | 'goal' | 'transcript'>>): Job {
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
    this.recordTombstone('job', jobId);
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
    const t = now();
    const rec: Approval = {
      id: id(), projectId: a.projectId ?? null, kind: a.kind ?? 'review', title: a.title,
      subtitle: a.subtitle ?? '', detail: a.detail ?? '', status: 'pending', jobId: a.jobId ?? null,
      createdAt: t, resolvedAt: null, updatedAt: t,
    };
    this.data.approvals.push(rec); this.save();
    return rec;
  }
  resolveApproval(approvalId: string, status: 'approved' | 'denied'): Approval {
    const cur = this.data.approvals.find(a => a.id === approvalId);
    if (!cur) throw Object.assign(new Error('approval not found'), { statusCode: 404 });
    const t = now();
    cur.status = status; cur.resolvedAt = t; cur.updatedAt = t;
    this.save();
    return cur;
  }

  // ── Schedules ───────────────────────────────────────────────────────
  listSchedules(): Schedule[] { return [...this.data.schedules].sort((a, b) => a.time.localeCompare(b.time)); }
  createSchedule(s: { projectId?: string | null; title: string; time?: string; cadence?: string; fireAt?: number; sessionId?: string; prompt?: string; kind?: 'message' | 'auto-continue' | 'auto-answer' | 'keep-going' | 'retry-run' | 'whatsapp-analyze'; chatId?: string; effort?: Effort; browser?: boolean; plan?: boolean; goal?: boolean; armedAt?: number; extends?: number; everyMinutes?: number; anchorAt?: number; catchUp?: boolean; catchUpWindowMs?: number; retryAttempt?: number; sourceJobId?: string }): Schedule {
    const at = s.fireAt ? new Date(s.fireAt) : null;
    const time = s.time ?? (at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '');
    const rec: Schedule = {
      id: id(), projectId: s.projectId ?? null, title: s.title, time,
      cadence: s.fireAt ? 'once' : (s.everyMinutes ? 'interval' : (s.cadence ?? 'daily')),
      enabled: true, nextRun: s.fireAt ?? null, createdAt: now(),
      ...(s.fireAt ? { fireAt: s.fireAt } : {}),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      ...(s.prompt ? { prompt: s.prompt } : {}),
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.chatId ? { chatId: s.chatId } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.browser ? { browser: true } : {}),
      ...(s.plan ? { plan: true } : {}),
      ...(s.goal ? { goal: true } : {}),
      ...(s.armedAt ? { armedAt: s.armedAt } : {}),
      ...(s.extends ? { extends: s.extends } : {}),
      ...(s.everyMinutes ? { everyMinutes: s.everyMinutes } : {}),
      ...(s.anchorAt ? { anchorAt: s.anchorAt } : {}),
      ...(s.catchUp ? { catchUp: true } : {}),
      ...(s.catchUpWindowMs ? { catchUpWindowMs: s.catchUpWindowMs } : {}),
      ...(s.retryAttempt ? { retryAttempt: s.retryAttempt } : {}),
      ...(s.sourceJobId ? { sourceJobId: s.sourceJobId } : {}),
    };
    this.data.schedules.push(rec); this.save();
    return rec;
  }
  /** Patch a schedule's timing/extend state (used by the AskUserQuestion extend +
      graceful-pause flow). Re-derives nextRun from fireAt. Returns the updated record. */
  updateSchedule(scheduleId: string, patch: Partial<Pick<Schedule,
    'fireAt' | 'extends' | 'paused' | 'enabled' | 'prompt' | 'title' | 'time' | 'cadence'
    | 'everyMinutes' | 'anchorAt' | 'catchUp' | 'catchUpWindowMs'
    | 'effort' | 'browser' | 'plan' | 'goal' | 'sessionId' | 'projectId'>>): Schedule {
    const s = this.data.schedules.find(x => x.id === scheduleId);
    if (!s) throw Object.assign(new Error('schedule not found'), { statusCode: 404 });
    Object.assign(s, patch);
    if (patch.fireAt !== undefined) s.nextRun = patch.fireAt ?? null;
    this.save();
    return s;
  }
  /** Idempotent "schedule a continue at reset" for a single session.
   *
   *  Why this exists: when the user has queued messages while Claude is rate-
   *  limited, each queued message hits the limit and used to spawn its own
   *  duplicate `auto-continue` row (see image_5zcze.png — 4 identical entries
   *  all firing at the same time). At reset they'd all collide and re-send the
   *  same continue prompt 4×.
   *
   *  This helper coalesces all of them into a single pending row per session:
   *  - If a pending auto-continue (enabled + fireAt in the future) already
   *    exists for `sessionId`, we update its `fireAt` (the latest reset
   *    timestamp wins — sometimes Claude bumps it forward) and return it.
   *  - Otherwise we create one and return it.
   *  Returns `{ schedule, created }` so the caller knows whether to emit a
   *  'schedule' event (created) vs nothing (already existed).
   */
  upsertAutoContinueForSession(opts: {
    sessionId: string;
    fireAt: number;
    projectId?: string | null;
    title?: string;
    prompt: string;
    effort?: Effort;
  }): { schedule: Schedule; created: boolean } {
    const now = Date.now();
    const existing = this.data.schedules.find((s) =>
      s.kind === 'auto-continue' &&
      s.sessionId === opts.sessionId &&
      s.enabled !== false &&
      typeof s.fireAt === 'number' && s.fireAt > now,
    );
    if (existing) {
      // Bump fireAt FORWARD only — a stale earlier reset can't pull it
      // back and cause a premature re-hit.
      const fireAt = Math.max(existing.fireAt ?? 0, opts.fireAt);
      if (fireAt !== existing.fireAt) {
        existing.fireAt = fireAt;
        existing.nextRun = fireAt;
        this.save();
      }
      return { schedule: existing, created: false };
    }
    const schedule = this.createSchedule({
      projectId: opts.projectId ?? null,
      sessionId: opts.sessionId,
      title: opts.title ?? 'Continue when Claude limit resets',
      prompt: opts.prompt,
      fireAt: opts.fireAt,
      kind: 'auto-continue',
      effort: opts.effort,
    });
    return { schedule, created: true };
  }
  /** Idempotent "auto-continue on 'want me to keep going?'" — one PENDING
   *  schedule per session, regardless of how many times the engine re-arms it
   *  inside the wait window. Same coalescing shape as upsertAutoContinueForSession
   *  (image_5zcze.png style guard against duplicate rows) but driven by the
   *  end-of-turn pattern-match instead of a rate-limit event.
   *
   *  Per-session safety cap: the helper checks the keep-going streak counter
   *  and returns `{ capped: true }` once it would push past the limit, so the
   *  caller can post a graceful pause note instead of armed silence.
   *
   *  `bumpCounter` defaults to true (the normal arming path). The cron runner
   *  passes false when re-arming after a fire, so the count tracks consecutive
   *  auto-continues, not the total schedules created.
   */
  upsertKeepGoingForSession(opts: {
    sessionId: string;
    projectId?: string | null;
    title?: string;
    prompt: string;
    fireAt: number;
    effort?: Effort;
    sourceJobId?: string;
    maxPerSession: number;
    bumpCounter?: boolean;
  }): { schedule: Schedule | null; created: boolean; capped: boolean; attempt: number } {
    const counters = (this.data.keepGoingCounters ??= {});
    const current = counters[opts.sessionId] ?? 0;
    const nextAttempt = current + 1;
    if (nextAttempt > opts.maxPerSession) {
      return { schedule: null, created: false, capped: true, attempt: current };
    }
    const now = Date.now();
    const existing = this.data.schedules.find((s) =>
      s.kind === 'keep-going' &&
      s.sessionId === opts.sessionId &&
      s.enabled !== false &&
      typeof s.fireAt === 'number' && s.fireAt > now,
    );
    if (existing) {
      // Already armed for this session — extend forward only (never pull a
      // later deadline backward) and refresh the prompt to the latest
      // organized form, in case the model's last text changed.
      const fireAt = Math.max(existing.fireAt ?? 0, opts.fireAt);
      const patch: Partial<Schedule> = {};
      if (fireAt !== existing.fireAt) { existing.fireAt = fireAt; existing.nextRun = fireAt; patch.fireAt = fireAt; }
      if (opts.prompt && opts.prompt !== existing.prompt) { existing.prompt = opts.prompt; patch.prompt = opts.prompt; }
      if (Object.keys(patch).length) this.save();
      return { schedule: existing, created: false, capped: false, attempt: current };
    }
    if (opts.bumpCounter !== false) {
      counters[opts.sessionId] = nextAttempt;
    }
    const schedule = this.createSchedule({
      projectId: opts.projectId ?? null,
      sessionId: opts.sessionId,
      title: opts.title ?? 'Auto-continue (want me to keep going?)',
      prompt: opts.prompt,
      fireAt: opts.fireAt,
      kind: 'keep-going',
      effort: opts.effort,
      sourceJobId: opts.sourceJobId,
    });
    return { schedule, created: true, capped: false, attempt: opts.bumpCounter !== false ? nextAttempt : current };
  }
  /** Reset the per-session keep-going streak counter (called whenever the
      user sends a genuine message into the session — that's the "things are
      moving" signal, so the next stall starts fresh from attempt 1). */
  resetKeepGoingCounter(sessionId: string): void {
    if (!this.data.keepGoingCounters) return;
    if (this.data.keepGoingCounters[sessionId] != null) {
      delete this.data.keepGoingCounters[sessionId];
      this.save();
    }
  }
  /** Current consecutive-auto-continue count for a session (used by the UI
      to show "Auto-continue 3/20" on the schedule chip). */
  keepGoingCountFor(sessionId: string): number {
    return this.data.keepGoingCounters?.[sessionId] ?? 0;
  }
  /** Idempotent "retry this failed run on exponential backoff" — one PENDING
   *  retry schedule per session (or per one-off jobId). On every arming the
   *  counter bumps; on every job SUCCESS for the same key the counter resets,
   *  so the linear 1m → 10m series restarts after a single recovery, exactly
   *  as the user requested.
   *
   *  Returns the new attempt number (1..N) so the caller writes the right
   *  note ("Auto-retry 3/10 in 3 min …"), or `null` when past the cap (the
   *  caller surfaces a give-up note instead).
   */
  recordRetryAttempt(key: string, max: number): number | null {
    const counters = (this.data.retryCounters ??= {});
    const next = (counters[key] ?? 0) + 1;
    if (next > max) return null;
    counters[key] = next;
    this.save();
    return next;
  }
  /** Clear the retry streak for a key (called on a successful run for the same
      session/job, so the next single failure starts again from 1 minute). */
  resetRetryCounter(key: string): void {
    if (!this.data.retryCounters) return;
    if (this.data.retryCounters[key] != null) {
      delete this.data.retryCounters[key];
      this.save();
    }
  }
  /** Current attempt count for a key — used by tests + the UI. */
  retryCountFor(key: string): number {
    return this.data.retryCounters?.[key] ?? 0;
  }
  /** Idempotent "schedule a retry-run after the backoff window" — coalesces
      so a burst of re-emit events for the same failure can't spawn duplicates.
      Caller computes `attempt` via recordRetryAttempt first. */
  upsertRetryRunForKey(opts: {
    key: string;
    sessionId?: string;
    projectId?: string | null;
    sourceJobId: string;
    title: string;
    prompt: string;
    fireAt: number;
    attempt: number;
    effort?: Effort;
    browser?: boolean;
    plan?: boolean;
    goal?: boolean;
  }): { schedule: Schedule; created: boolean } {
    const now = Date.now();
    // Coalesce per (key) — same session OR same source job, whichever the
    // caller indexed under. We match on sourceJobId because that's the
    // stable identifier across attempts.
    const existing = this.data.schedules.find((s) =>
      s.kind === 'retry-run' &&
      s.enabled !== false &&
      typeof s.fireAt === 'number' && s.fireAt > now &&
      (s.sourceJobId === opts.sourceJobId || (opts.sessionId ? s.sessionId === opts.sessionId : false)),
    );
    if (existing) {
      const fireAt = Math.max(existing.fireAt ?? 0, opts.fireAt);
      const patch: Partial<Schedule> = {};
      if (fireAt !== existing.fireAt) { existing.fireAt = fireAt; existing.nextRun = fireAt; patch.fireAt = fireAt; }
      if (opts.attempt && existing.retryAttempt !== opts.attempt) { existing.retryAttempt = opts.attempt; patch.retryAttempt = opts.attempt; }
      if (Object.keys(patch).length) this.save();
      return { schedule: existing, created: false };
    }
    const schedule = this.createSchedule({
      projectId: opts.projectId ?? null,
      sessionId: opts.sessionId,
      title: opts.title,
      prompt: opts.prompt,
      fireAt: opts.fireAt,
      kind: 'retry-run',
      effort: opts.effort,
      browser: opts.browser,
      plan: opts.plan,
      goal: opts.goal,
      retryAttempt: opts.attempt,
      sourceJobId: opts.sourceJobId,
    });
    return { schedule, created: true };
  }
  setScheduleEnabled(scheduleId: string, enabled: boolean): void {
    const s = this.data.schedules.find(x => x.id === scheduleId);
    if (s) { s.enabled = enabled; this.save(); }
  }
  markScheduleRun(scheduleId: string, ts: number, nextRun: number | null, opts?: { dueAt?: number; late?: boolean }): void {
    const s = this.data.schedules.find(x => x.id === scheduleId);
    if (s) {
      s.lastRun = ts; s.nextRun = nextRun;
      if (opts?.dueAt !== undefined) s.lastDueAt = opts.dueAt;
      s.lastFireLate = !!opts?.late;
      this.save();
    }
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
  /** Arm (or RESET) a tracked WhatsApp chat's quiet timer. An inbound message
      pushes the chat's one-shot 'whatsapp-analyze' schedule out to now + 15 min;
      a chat that already has a live (enabled) timer is reset in place, so ONLY
      that chat is touched and an active conversation never fires mid-stream. A
      consumed (disabled) timer is left alone — the next message arms a fresh one,
      which is how analysis re-arms after each quiet period. */
  armWhatsappTimer(input: { chatId: string; projectId: string | null; sessionId?: string }): Schedule {
    const fireAt = quietDeadline(now());
    const existing = this.data.schedules.find(
      s => s.kind === 'whatsapp-analyze' && s.chatId === input.chatId && s.enabled,
    );
    if (existing) return this.updateSchedule(existing.id, { fireAt });
    return this.createSchedule({
      projectId: input.projectId,
      sessionId: input.sessionId,
      title: `WhatsApp quiet: ${input.chatId}`,
      fireAt,
      kind: 'whatsapp-analyze',
      chatId: input.chatId,
    });
  }
  /** Cancel a chat's quiet timer (e.g. on untrack/unbind) so it never fires. */
  cancelWhatsappTimer(chatId: string): void {
    for (const s of this.data.schedules) {
      if (s.kind === 'whatsapp-analyze' && s.chatId === chatId && s.enabled) { s.enabled = false; s.nextRun = null; }
    }
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
  /** Relay-safe projection of an Asset: drops the Mac-local path, the base64
      thumbnail, the content hash, and the fal queue URLs. Used for BOTH the
      snapshot and the live 'asset' event so none of those ever cross the relay. */
  slimAssetForRelay(a: Asset): Partial<Asset> {
    return {
      id: a.id, projectId: a.projectId, source: a.source, kind: a.kind, stage: a.stage,
      prompt: a.prompt ? a.prompt.slice(0, 200) : undefined, model: a.model, status: a.status,
      url: a.url, name: a.name, bytes: a.bytes, tint: a.tint, cost: a.cost,
      durationS: a.durationS, width: a.width, height: a.height, error: a.error,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
    };
  }
  /** Relay-safe projection of a Job: truncate long output, trim the run log, and
      strip every Mac-local image path (attached inputImages AND transcript image
      items) so the phone never learns a filesystem path. Used by BOTH the snapshot
      and the live 'job' event / command results, so no channel can leak it.
      Also rewrites `@<absPath>` inline-attachment markers inside the user's
      prompt + every transcript text block to `@.continuum/Attachment/<basename>`
      so the phone gets the chip's POSITION + name without the operator's home
      directory. */
  slimJobForRelay(j: Job): Job {
    const scrub = (s: string): string => s.replace(/@(\/[^\s]+\/\.continuum\/Attachment\/([A-Za-z0-9._-]+))/g, (_m, _full: string, base: string) => `@.continuum/Attachment/${base}`);
    const rawOut = j.output && j.output.length > 16384 ? '…' + j.output.slice(-16384) : j.output;
    const out = rawOut ? scrub(rawOut) : rawOut;
    const tr = j.transcript;
    const slimItem = (t: TranscriptItem): TranscriptItem => {
      if (t.kind === 'image') { const { imagePath: _omit, ...rest } = t; return rest; }
      const text = scrub(t.text.length > 4000 ? t.text.slice(0, 4000) + '…' : t.text);
      return text === t.text ? t : { ...t, text };
    };
    const transcript = !tr ? undefined
      : (tr.length <= 60 && !tr.some(t => t.text.length > 4000 || t.kind === 'image' || t.text.includes('@/'))) ? tr
      : tr.slice(-60).map(slimItem);
    const needsImgStrip = j.inputImages?.some(im => im.imagePath !== undefined);
    const inputImages = needsImgStrip ? j.inputImages!.map(({ imagePath: _omit, ...rest }) => rest as ChatImage) : j.inputImages;
    // Attached files: strip the inlined text content + the Mac-local path; the
    // phone keeps only name/kind/mime/bytes/preview.
    const needsFileStrip = j.inputFiles?.some(f => f.content !== undefined || f.path !== undefined);
    const inputFiles = needsFileStrip ? j.inputFiles!.map(({ content: _c, path: _p, ...rest }) => rest as ChatFile) : j.inputFiles;
    const inputScrubbed = scrub(j.input);
    const input = inputScrubbed === j.input ? j.input : inputScrubbed;
    if (out === j.output && transcript === tr && inputImages === j.inputImages && inputFiles === j.inputFiles && input === j.input) return j;
    return { ...j, input, output: out, transcript, ...(inputImages !== j.inputImages ? { inputImages } : {}), ...(inputFiles !== j.inputFiles ? { inputFiles } : {}) };
  }
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
    this.recordTombstone('asset', assetId);
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
  bindChat(args: { chatId: string; name: string; kind: 'dm' | 'group'; provider?: CommsProvider; projectId?: string | null; sessionId?: string | null; permissions?: Partial<ChatPermissions> }): ChatBinding {
    const existing = this.getChatBinding(args.chatId);
    const perms: ChatPermissions = { startJobs: true, receiveReports: true, approveGates: false, ...(args.permissions ?? {}) };
    // Tracking a WhatsApp chat that already synced history: seed the summary
    // watermark to its latest message so the first quiet-period summary covers only
    // what arrives AFTER tracking — not the entire synced backlog.
    if ((args.provider ?? existing?.provider) === 'whatsapp') {
      const meta = this.wa.getChat(args.chatId);
      if (meta) this.wa.markReported(args.chatId, meta.lastMessageAt);
    }
    if (existing) {
      Object.assign(existing, {
        name: args.name, kind: args.kind, provider: args.provider ?? existing.provider ?? 'telegram',
        projectId: args.projectId ?? existing.projectId,
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
        permissions: perms,
      });
      this.save();
      return existing;
    }
    const rec: ChatBinding = {
      chatId: args.chatId, name: args.name, kind: args.kind, provider: args.provider ?? 'telegram',
      projectId: args.projectId ?? null, sessionId: args.sessionId ?? null, permissions: perms, boundAt: now(),
    };
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
        tracked: this.data.chatBindings.filter(b => b.provider === 'whatsapp').length,
        sendApproved: wa.sendApproved,
      },
    };
  }

  // ── Comms (WhatsApp) ────────────────────────────────────────────────
  whatsappState(): WhatsAppState { return { ...this.data.whatsapp }; }
  setWhatsappState(patch: Partial<WhatsAppState>): WhatsAppState {
    this.data.whatsapp = { ...this.data.whatsapp, ...patch };
    this.save();
    return this.whatsappState();
  }
  /** Durable summary outbox: queue on generation, flush (drop) on successful send. */
  queueSummary(input: { text: string; chatName: string }): void {
    const wa = this.data.whatsapp;
    if (!wa.pendingSummaries) wa.pendingSummaries = [];
    wa.pendingSummaries.push({ id: id(), text: input.text, chatName: input.chatName, at: now() });
    if (wa.pendingSummaries.length > 100) wa.pendingSummaries.splice(0, wa.pendingSummaries.length - 100);
    this.save();
  }
  listPendingSummaries(): Array<{ id: string; text: string; chatName: string; at: number }> {
    return [...(this.data.whatsapp.pendingSummaries ?? [])];
  }
  dropPendingSummary(summaryId: string): void {
    const wa = this.data.whatsapp;
    if (!wa.pendingSummaries) return;
    wa.pendingSummaries = wa.pendingSummaries.filter(p => p.id !== summaryId);
    this.save();
  }
  /** Capture a message (legacy shim → WaStore). Used by the quiet-timer ingest path
      and tests; WaStore appends O(1) to the chat's JSONL log. */
  recordWaMessage(m: { chatId: string; name?: string; kind?: 'dm' | 'group'; fromMe: boolean; senderName: string; text: string; ts: number }): void {
    if (m.name || m.kind) this.wa.upsertChat({ chatId: m.chatId, ...(m.name ? { name: m.name } : {}), ...(m.kind ? { kind: m.kind } : {}) });
    this.wa.appendMessage({ chatId: m.chatId, fromMe: m.fromMe, senderName: m.senderName, text: m.text, ts: m.ts, kind: 'text' });
  }
  /** Read a chat's transcript. `sinceReported` returns only messages newer than the
      last summary watermark — what a quiet period needs to analyze. */
  getWaTranscript(chatId: string, opts: { sinceReported?: boolean } = {}): WaMessage[] {
    return this.wa.getMessages(chatId, { sinceReported: opts.sinceReported });
  }
  /** Advance a chat's report watermark so the next quiet period only sees newer messages. */
  markWaReported(chatId: string, ts: number): void { this.wa.markReported(chatId, ts); }
  /** Captured chats with message counts (back-compat shape for the Comms Bindings tab). */
  listWaChats(): Array<{ chatId: string; name: string; kind: WaChatKind; lastMessageAt: number; lastReportedAt: number; count: number }> {
    return this.wa.listChats().map(c => ({ chatId: c.chatId, name: c.name, kind: c.kind, lastMessageAt: c.lastMessageAt, lastReportedAt: c.lastReportedAt, count: this.wa.count(c.chatId) }));
  }
  /** Forget a chat's captured log entirely (on untrack/unbind). */
  forgetWaChat(chatId: string): void { this.wa.forget(chatId); }

  // ── WhatsApp full chat store (the WhatsApp screen + agent wa_* tools) ──
  /** Every captured chat (DMs, groups, channels), pinned-then-newest-first. */
  waListChats(): WaChatMeta[] { return this.wa.listChats(); }
  waGetChat(chatId: string): WaChatMeta | undefined { return this.wa.getChat(chatId); }
  /** A chat's messages for the UI: most-recent `limit`, page older with `before`. */
  waMessages(chatId: string, opts: { limit?: number; before?: number } = {}): WaStoredMessage[] { return this.wa.getMessages(chatId, opts); }
  waUpsertChat(meta: { chatId: string } & Partial<WaChatMeta>): WaChatMeta { return this.wa.upsertChat(meta); }
  waAppendMessage(input: WaMessageInput, opts?: { bumpUnread?: boolean }): WaStoredMessage | null { return this.wa.appendMessage(input, opts); }
  waUpdateMessage(chatId: string, msgIdOrId: string, patch: Partial<WaStoredMessage>): void { this.wa.updateMessage(chatId, msgIdOrId, patch); }
  waMarkRead(chatId: string): void { this.wa.markRead(chatId); }
  waSetUnread(chatId: string, n: number): void { this.wa.setUnread(chatId, n); }

  // ── Per-project WhatsApp chat assignment ────────────────────────────
  // Backed by whatsapp ChatBindings (single source of truth), so assigning a chat
  // here also makes it "tracked" (incoming messages route to the project + the
  // quiet-timer machinery applies) and it shows in the Comms Bindings tab.
  listProjectWaChats(projectId: string): string[] {
    return this.data.chatBindings.filter(b => b.provider === 'whatsapp' && b.projectId === projectId).map(b => b.chatId);
  }
  addProjectWaChat(projectId: string, chatId: string): string[] {
    const meta = this.wa.getChat(chatId);
    this.bindChat({ chatId, name: meta?.name ?? chatId, kind: meta?.kind === 'group' ? 'group' : 'dm', provider: 'whatsapp', projectId });
    return this.listProjectWaChats(projectId);
  }
  removeProjectWaChat(projectId: string, chatId: string): string[] {
    // Stop routing/summaries but KEEP the captured history (it still shows in the
    // WhatsApp screen) — only a full unlink wipes message logs.
    this.cancelWhatsappTimer(chatId);
    this.unbindChat(chatId);
    return this.listProjectWaChats(projectId);
  }

  // ── Feedback (collected from desktop / web / phone) ─────────────────
  listFeedback(): Feedback[] { return [...this.data.feedback].sort((a, b) => b.createdAt - a.createdAt); }
  getFeedback(feedbackId: string): Feedback | undefined { return this.data.feedback.find(f => f.id === feedbackId); }
  addFeedback(input: { category: FeedbackCategory; message: string; source?: FeedbackSource; context?: FeedbackContext }): Feedback {
    const t = now();
    const rec: Feedback = {
      id: id(),
      category: input.category,
      message: input.message.slice(0, 4000),
      status: 'new',
      source: input.source ?? 'desktop',
      ...(input.context ? { context: input.context } : {}),
      createdAt: t, updatedAt: t,
    };
    this.data.feedback.unshift(rec);
    if (this.data.feedback.length > 500) this.data.feedback.length = 500; // cap
    this.save();
    return rec;
  }
  updateFeedback(feedbackId: string, patch: Partial<Pick<Feedback, 'status' | 'issueUrl' | 'issueNumber'>>): Feedback {
    const f = this.getFeedback(feedbackId);
    if (!f) throw Object.assign(new Error('feedback not found'), { statusCode: 404 });
    Object.assign(f, patch, { updatedAt: now() });
    this.save();
    return f;
  }
  deleteFeedback(feedbackId: string): void {
    const i = this.data.feedback.findIndex(f => f.id === feedbackId);
    if (i === -1) throw Object.assign(new Error('feedback not found'), { statusCode: 404 });
    this.data.feedback.splice(i, 1);
    this.save();
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
    const slimJob = (j: Job): Job => this.slimJobForRelay(j);
    const slimAsset = (a: Asset) => this.slimAssetForRelay(a);
    const dashboard = this.dashboard();
    return {
      workspace: this.data.workspace,
      workspaces: this.data.workspace ? [this.data.workspace] : [],
      projects: this.listProjects(),
      // Phone/web shows a recent-job rail, not the full history — keep the
      // snapshot small (listJobs() default cap is 200; each slimmed job is
      // still up to ~360 KB, so 200 → 60 cuts the serialized snapshot ~3x).
      // Phone-side delta sync (/api/sync?since=ts) backfills the older ones
      // when actually requested.
      jobs: this.listJobs().slice(0, 60).map(slimJob),
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
      // Soft-deletion markers — relays serve these via /api/sync?since=<ts> so
      // mobile clients learn what to forget without diffing the whole list.
      tombstones: this.data.tombstones ?? [],
      chatBindings: this.listChatBindings(),
      pendingChats: this.listPendingChats(),
      commEvents: this.listCommEvents(),
      feedback: this.listFeedback(),
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
