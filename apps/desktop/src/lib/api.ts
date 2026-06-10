/* Maestro desktop — live API client for the deployed maestro-server.

   Base URL resolves from VITE_API_BASE at build time and falls back to the
   production deployment, so the native app and the web build both talk to a
   real backend out of the box. Screens use this instead of hardcoded mock data. */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type Effort = 'fast' | 'balanced' | 'deep' | 'max';
export type ApprovalKind = 'merge' | 'budget' | 'publish' | 'deploy' | 'review';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Workspace {
  id: string;
  name: string;
  budgetCap: number;
  createdAt: number;
}
export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  template: string;
  instructions: string;
  color: string;
  createdAt: number;
}
export interface Job {
  id: string;
  projectId: string;
  title: string;
  status: JobStatus;
  phase: string;
  progress: number;
  input: string;
  output: string | null;
  error: string | null;
  effort: Effort;
  cost: number;
  tokens: number;
  stage: string;
  createdAt: number;
  updatedAt: number;
}
export interface Approval {
  id: string;
  projectId: string | null;
  kind: ApprovalKind;
  title: string;
  subtitle: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
}
export interface Schedule {
  id: string;
  projectId: string | null;
  title: string;
  time: string;
  cadence: string;
  enabled: boolean;
  nextRun: number | null;
  createdAt: number;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: string;
  version: string;
  enabled: boolean;
  createdAt: number;
}
export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  engine: string;
  createdAt: number;
}
export interface BudgetData {
  cap: number;
  spent: number;
  byProject: { projectId: string; name: string; color: string; spent: number }[];
}
export type ProviderId = 'anthropic' | 'openai';
export interface ProviderConn {
  workspaceId: string;
  provider: ProviderId;
  keyLast4: string;
  model: string;
  status: string;
  createdAt: number;
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

const RAW_BASE =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE ??
  'https://api.nexalance.cloud';

/** Live maestro-server base URL (no trailing slash). */
export const API_BASE = RAW_BASE.replace(/\/$/, '');

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
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
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

  // Aggregates
  dashboard: (workspaceId?: string) => req<DashboardData>('/api/dashboard' + qp({ workspaceId })),
  budget: (workspaceId?: string) => req<BudgetData>('/api/budget' + qp({ workspaceId })),

  // Workspaces
  listWorkspaces: () => req<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string, budgetCap?: number) =>
    req<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, budgetCap }) }),
  setBudgetCap: (workspaceId: string, cap: number) =>
    req<{ ok: boolean; cap: number }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/budget`, { method: 'POST', body: JSON.stringify({ cap }) }),

  // Projects
  listProjects: (workspaceId?: string) => req<Project[]>('/api/projects' + qp({ workspaceId })),
  createProject: (input: { name: string; workspaceId?: string; template?: string; instructions?: string; color?: string }) =>
    req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) => req<Project>(`/api/projects/${encodeURIComponent(id)}`),

  // Jobs
  listJobs: (projectId?: string) => req<Job[]>('/api/jobs' + qp({ projectId })),
  createJob: (input: { projectId: string; input: string; title?: string; effort?: Effort }) =>
    req<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(input) }),
  getJob: (id: string) => req<Job>(`/api/jobs/${encodeURIComponent(id)}`),
  runJob: (id: string, effort?: Effort) =>
    req<Job>(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify(effort ? { effort } : {}) }),
  /** Create + run a job in one call (the "Run a job" composer). */
  createAndRunJob: (input: { projectId: string; input: string; title?: string; effort?: Effort }) =>
    req<Job>('/api/jobs/run', { method: 'POST', body: JSON.stringify(input) }),

  // Approvals
  listApprovals: (status?: ApprovalStatus) => req<Approval[]>('/api/approvals' + qp({ status })),
  approveApproval: (id: string) => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  denyApproval: (id: string) => req<Approval>(`/api/approvals/${encodeURIComponent(id)}/deny`, { method: 'POST' }),

  // Schedules
  listSchedules: () => req<Schedule[]>('/api/schedules'),
  createSchedule: (input: { title: string; projectId?: string; time?: string; cadence?: string }) =>
    req<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(input) }),
  toggleSchedule: (id: string, enabled: boolean) =>
    req<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),

  // Skills
  listSkills: () => req<Skill[]>('/api/skills'),
  toggleSkill: (id: string) => req<Skill>(`/api/skills/${encodeURIComponent(id)}/toggle`, { method: 'POST' }),

  // Templates
  listTemplates: () => req<Template[]>('/api/templates'),

  // Providers (real Anthropic/OpenAI credentials — keys validated live, stored encrypted server-side)
  listProviders: (workspaceId?: string) => req<ProviderConn[]>('/api/providers' + qp({ workspaceId })),
  connectProvider: (provider: ProviderId, apiKey: string, model?: string, workspaceId?: string) =>
    req<ProviderConn>(`/api/providers/${provider}/connect`, { method: 'POST', body: JSON.stringify({ apiKey, model, workspaceId }) }),
  disconnectProvider: (provider: ProviderId, workspaceId?: string) =>
    req<{ ok: boolean }>(`/api/providers/${provider}/disconnect`, { method: 'POST', body: JSON.stringify({ workspaceId }) }),

  /** Subscribe to live SSE updates. Returns an unsubscribe function. */
  subscribe(handlers: { onJob?: (job: Job) => void; onApproval?: (a: Approval) => void }): () => void {
    if (typeof EventSource === 'undefined') return () => {};
    const es = new EventSource(API_BASE + '/api/stream');
    if (handlers.onJob) es.addEventListener('job', (e: MessageEvent) => { try { handlers.onJob!(JSON.parse(e.data) as Job); } catch { /* ignore */ } });
    if (handlers.onApproval) es.addEventListener('approval', (e: MessageEvent) => { try { handlers.onApproval!(JSON.parse(e.data) as Approval); } catch { /* ignore */ } });
    return () => es.close();
  },
  /** Convenience: subscribe to job updates only. */
  subscribeJobs(onJob: (job: Job) => void): () => void {
    return this.subscribe({ onJob });
  },
};
