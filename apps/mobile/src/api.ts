/* Maestro mobile — live API client for the deployed maestro-server.

   React Native has fetch but no EventSource, so live updates use polling
   (api.poll) instead of SSE. Same shape/contract as the desktop client. */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type EngineId = 'claude' | 'codex';
export type ProjectKind = 'coding' | 'content' | 'research' | 'general';

export interface Workspace { id: string; name: string; budgetCap: number; createdAt: number }
export interface Project { id: string; workspaceId: string; name: string; template: string; instructions: string; color: string; kind?: ProjectKind; path?: string; repoUrl?: string; createdAt: number }
export interface Job {
  id: string; projectId: string; title: string; status: JobStatus; phase: string; progress: number;
  input: string; output: string | null; error: string | null; effort: Effort; cost: number; tokens: number; stage: string;
  engine?: EngineId; model?: string; createdAt: number; updatedAt: number;
}
export interface Approval {
  id: string; projectId: string | null; kind: ApprovalKind; title: string; subtitle: string; detail: string; status: ApprovalStatus; jobId?: string | null; createdAt: number; resolvedAt: number | null;
}
export type AppEventKind =
  | 'job-done' | 'job-failed' | 'job-cancelled'
  | 'approval-created' | 'approval-resolved'
  | 'schedule-fired' | 'clone-done' | 'clone-failed'
  | 'research' | 'publish' | 'comm' | 'asset';
export interface AppEvent { id: string; ts: number; kind: AppEventKind; title: string; subtitle?: string; projectId?: string | null; jobId?: string | null }
export interface CostsData {
  today: number; thisMonth: number; projectedMonth: number;
  byDay: { day: string; total: number }[];
  byProject: { projectId: string; name: string; color: string; total: number; jobs: number }[];
  byEngine: { engine: string; total: number; jobs: number; tokens: number }[];
  includedCodexRuns: number; claudeRuns: number;
}
export interface Schedule { id: string; projectId: string | null; title: string; time: string; cadence: string; enabled: boolean; nextRun: number | null; createdAt: number }
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

export const API_BASE = 'https://api.nexalance.cloud';

import { getStr, setStr, PAIR_TOKEN } from './storage';

/* Pairing token — the relay refuses /api/* without the code shown in the
   Maestro desktop app (Settings → Devices). Stored locally on this phone. */
let pairToken = getStr(PAIR_TOKEN);
export function getPairToken(): string { return pairToken; }
export function setPairToken(token: string): void {
  pairToken = token.trim();
  setStr(PAIR_TOKEN, pairToken);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there's actually a body — otherwise
  // Fastify rejects the empty body (FST_ERR_CTP_EMPTY_JSON_BODY) on bodyless POSTs.
  const hasBody = init?.body != null;
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(pairToken ? { authorization: `Bearer ${pairToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const qp = (params: Record<string, string | undefined>): string => {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  return q ? `?${q}` : '';
};

export const api = {
  base: API_BASE,
  health: () => req<{ ok: boolean; name: string; version: string; engine: string }>('/health'),

  dashboard: (workspaceId?: string) => req<DashboardData>('/api/dashboard' + qp({ workspaceId })),
  budget: (workspaceId?: string) => req<BudgetData>('/api/budget' + qp({ workspaceId })),
  costs: () => req<CostsData>('/api/costs'),
  listEvents: () => req<AppEvent[]>('/api/events'),

  listWorkspaces: () => req<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string, budgetCap?: number) => req<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, budgetCap }) }),

  listProjects: (workspaceId?: string) => req<Project[]>('/api/projects' + qp({ workspaceId })),
  createProject: (input: { name: string; workspaceId?: string; template?: string; instructions?: string; color?: string }) =>
    req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) => req<Project>(`/api/projects/${encodeURIComponent(id)}`),

  listJobs: (projectId?: string) => req<Job[]>('/api/jobs' + qp({ projectId })),
  createJob: (input: { projectId: string; input: string; title?: string; effort?: Effort }) =>
    req<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(input) }),
  getJob: (id: string) => req<Job>(`/api/jobs/${encodeURIComponent(id)}`),
  runJob: (id: string, effort?: Effort) => req<Job>(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify(effort ? { effort } : {}) }),
  createAndRunJob: (input: { projectId: string; input: string; title?: string; effort?: Effort; engine?: EngineId }) =>
    req<Job>('/api/jobs/run', { method: 'POST', body: JSON.stringify(input) }),
  cancelJob: (id: string) => req<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  listApprovals: (status?: ApprovalStatus) => req<Approval[]>('/api/approvals' + qp({ status })),
  approveApproval: (id: string) => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  denyApproval: (id: string) => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/deny`, { method: 'POST' }),

  listSchedules: () => req<Schedule[]>('/api/schedules'),
  toggleSchedule: (id: string, enabled: boolean) => req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),

  listSkills: () => req<Skill[]>('/api/skills'),
  toggleSkill: (id: string) => req<Skill>(`/api/skills/${encodeURIComponent(id)}/toggle`, { method: 'POST' }),

  listTemplates: () => req<Template[]>('/api/templates'),

  /** Poll a fetcher every ms; returns a cleanup that stops polling. (RN has no SSE.) */
  poll(fetchOnce: () => void, ms = 4000): () => void {
    fetchOnce();
    const t = setInterval(fetchOnce, ms);
    return () => clearInterval(t);
  },
};
