import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { ServerResponse } from 'node:http';
import type { Repositories, Effort, ApprovalStatus } from './repositories.js';
import type { EngineAdapter } from './engine.js';
import { AnthropicEngine, OpenAIEngine } from './engine.js';
import { validateProviderKey, isProviderId } from './providers.js';

export function buildServer(repos: Repositories, engine: EngineAdapter): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

  // Tolerate empty JSON bodies on bodyless POSTs (approve/deny/toggle) instead of
  // returning FST_ERR_CTP_EMPTY_JSON_BODY when a client sends content-type: application/json.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = typeof body === 'string' ? body : '';
    if (s.trim() === '') { done(null, undefined); return; }
    try { done(null, JSON.parse(s)); } catch (err) { done(err instanceof Error ? err : new Error('invalid json'), undefined); }
  });

  // ── Server-Sent Events: live job updates ──────────────────────────
  const clients = new Set<ServerResponse>();
  function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  app.get('/health', async () => ({ ok: true, name: 'maestro-server', version: '0.2.0', engine: engine.id, time: Date.now() }));
  app.get('/', async () => ({
    ok: true,
    service: 'maestro-server',
    docs: '/health, /api/dashboard, /api/workspaces, /api/projects, /api/jobs, /api/approvals, /api/schedules, /api/skills, /api/templates, /api/budget, /api/stream',
  }));

  function defaultWorkspaceId(): string | undefined {
    return repos.defaultWorkspace()?.id;
  }
  function resolveWorkspaceId(q: unknown): string | undefined {
    return (q as { workspaceId?: string }).workspaceId ?? defaultWorkspaceId();
  }

  // ── Workspaces ────────────────────────────────────────────────────
  app.get('/api/workspaces', async () => repos.listWorkspaces());
  app.post('/api/workspaces', async (req, reply) => {
    const { name, budgetCap } = (req.body ?? {}) as { name?: string; budgetCap?: number };
    if (!name) return reply.code(400).send({ error: 'name required' });
    return repos.createWorkspace(name, budgetCap ?? 200);
  });
  app.post('/api/workspaces/:id/budget', async (req, reply) => {
    const cap = Number(((req.body ?? {}) as { cap?: number }).cap);
    if (!Number.isFinite(cap) || cap <= 0) return reply.code(400).send({ error: 'cap must be a positive number' });
    repos.setBudgetCap((req.params as { id: string }).id, cap);
    return { ok: true, cap };
  });

  // ── Dashboard + Budget aggregates ─────────────────────────────────
  app.get('/api/dashboard', async (req) => {
    const wsId = resolveWorkspaceId(req.query);
    if (!wsId) return { workspace: null, greetingProjects: [], gates: [], activeJobs: [], recentlyCompleted: [], schedule: [], budget: { cap: 200, spent: 0, byProject: [] } };
    return repos.dashboard(wsId);
  });
  app.get('/api/budget', async (req) => {
    const wsId = resolveWorkspaceId(req.query);
    if (!wsId) return { cap: 200, spent: 0, byProject: [] };
    return repos.budget(wsId);
  });

  // ── Projects ──────────────────────────────────────────────────────
  app.get('/api/projects', async (req) => {
    const wsId = resolveWorkspaceId(req.query);
    if (!wsId) return [];
    return repos.listProjects(wsId);
  });
  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as { workspaceId?: string; name?: string; template?: string; instructions?: string; color?: string };
    const workspaceId = body.workspaceId ?? defaultWorkspaceId();
    if (!workspaceId) return reply.code(400).send({ error: 'no workspace; create one first' });
    if (!body.name) return reply.code(400).send({ error: 'name required' });
    return repos.createProject({ workspaceId, name: body.name, template: body.template, instructions: body.instructions, color: body.color });
  });
  app.get('/api/projects/:id', async (req, reply) => {
    const p = repos.getProject((req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: 'project not found' });
  });

  // ── Jobs ──────────────────────────────────────────────────────────
  app.get('/api/jobs', async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    return repos.listJobs(projectId);
  });
  app.post('/api/jobs', async (req, reply) => {
    const body = (req.body ?? {}) as { projectId?: string; input?: string; title?: string; effort?: Effort };
    if (!body.projectId || !body.input) return reply.code(400).send({ error: 'projectId and input required' });
    if (!repos.getProject(body.projectId)) return reply.code(404).send({ error: 'project not found' });
    const job = repos.createJob(body.projectId, body.input, body.title ?? '', body.effort ?? 'balanced');
    broadcast('job', job);
    return job;
  });
  app.get('/api/jobs/:id', async (req, reply) => {
    const j = repos.getJob((req.params as { id: string }).id);
    return j ?? reply.code(404).send({ error: 'job not found' });
  });

  // Pick the engine for a workspace: a connected provider's real engine, else Echo.
  function resolveEngine(workspaceId: string | undefined): EngineAdapter {
    if (workspaceId) {
      const aKey = repos.getProviderKey(workspaceId, 'anthropic');
      if (aKey) return new AnthropicEngine(aKey, repos.getProviderModel(workspaceId, 'anthropic'));
      const oKey = repos.getProviderKey(workspaceId, 'openai');
      if (oKey) return new OpenAIEngine(oKey, repos.getProviderModel(workspaceId, 'openai'));
    }
    return engine;
  }

  async function runJob(jobId: string, effortOverride?: Effort) {
    let job = repos.getJob(jobId);
    if (!job) return undefined;
    const project = repos.getProject(job.projectId);
    const eng = resolveEngine(project?.workspaceId);
    job = repos.updateJob(jobId, { status: 'running', phase: 'Working', progress: 15, output: null, error: null, stage: `running on ${eng.id}…` });
    broadcast('job', job);
    try {
      const result = await eng.run({ prompt: job.input, projectInstructions: project?.instructions, effort: effortOverride ?? job.effort });
      job = repos.updateJob(jobId, { status: 'done', phase: 'Done', progress: 100, output: result.output, error: null, cost: result.cost, tokens: result.tokens, stage: '' });
    } catch (e) {
      job = repos.updateJob(jobId, { status: 'failed', phase: 'Failed', error: e instanceof Error ? e.message : String(e), stage: '' });
    }
    broadcast('job', job);
    return job;
  }

  app.post('/api/jobs/:id/run', async (req, reply) => {
    const effort = ((req.body ?? {}) as { effort?: Effort }).effort;
    const job = await runJob((req.params as { id: string }).id, effort);
    return job ?? reply.code(404).send({ error: 'job not found' });
  });
  // Create + run in one call (the "Run a job" composer flow).
  app.post('/api/jobs/run', async (req, reply) => {
    const body = (req.body ?? {}) as { projectId?: string; input?: string; title?: string; effort?: Effort };
    if (!body.projectId || !body.input) return reply.code(400).send({ error: 'projectId and input required' });
    if (!repos.getProject(body.projectId)) return reply.code(404).send({ error: 'project not found' });
    const created = repos.createJob(body.projectId, body.input, body.title ?? '', body.effort ?? 'balanced');
    broadcast('job', created);
    const job = await runJob(created.id, body.effort);
    return job ?? created;
  });

  // ── Approvals ─────────────────────────────────────────────────────
  app.get('/api/approvals', async (req) => {
    const status = (req.query as { status?: ApprovalStatus }).status;
    return repos.listApprovals(status);
  });
  app.post('/api/approvals/:id/approve', async (req, reply) => {
    const a = repos.getApproval((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: 'approval not found' });
    const next = repos.resolveApproval(a.id, 'approved');
    broadcast('approval', next);
    return next;
  });
  app.post('/api/approvals/:id/deny', async (req, reply) => {
    const a = repos.getApproval((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: 'approval not found' });
    const next = repos.resolveApproval(a.id, 'denied');
    broadcast('approval', next);
    return next;
  });

  // ── Schedules ─────────────────────────────────────────────────────
  app.get('/api/schedules', async () => repos.listSchedules());
  app.post('/api/schedules', async (req, reply) => {
    const body = (req.body ?? {}) as { title?: string; projectId?: string; time?: string; cadence?: string };
    if (!body.title) return reply.code(400).send({ error: 'title required' });
    return repos.createSchedule({ title: body.title, projectId: body.projectId ?? null, time: body.time, cadence: body.cadence });
  });
  app.post('/api/schedules/:id/toggle', async (req) => {
    const body = (req.body ?? {}) as { enabled?: boolean };
    repos.setScheduleEnabled((req.params as { id: string }).id, body.enabled ?? false);
    return { ok: true };
  });

  // ── Skills ────────────────────────────────────────────────────────
  app.get('/api/skills', async () => repos.listSkills());
  app.post('/api/skills/:id/toggle', async (req, reply) => {
    const s = repos.toggleSkill((req.params as { id: string }).id);
    return s ?? reply.code(404).send({ error: 'skill not found' });
  });

  // ── Templates ─────────────────────────────────────────────────────
  app.get('/api/templates', async () => repos.listTemplates());

  // ── Providers (real Anthropic/OpenAI credentials) ─────────────────
  app.get('/api/providers', async (req) => {
    const wsId = resolveWorkspaceId(req.query);
    if (!wsId) return [];
    return repos.listProviders(wsId);
  });
  app.post('/api/providers/:provider/connect', async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    if (!isProviderId(provider)) return reply.code(400).send({ error: 'unsupported provider' });
    const body = (req.body ?? {}) as { apiKey?: string; model?: string; workspaceId?: string };
    if (!body.apiKey || !body.apiKey.trim()) return reply.code(400).send({ error: 'apiKey required' });
    const wsId = body.workspaceId ?? defaultWorkspaceId();
    if (!wsId) return reply.code(400).send({ error: 'no workspace; create one first' });
    const check = await validateProviderKey(provider, body.apiKey.trim());
    if (!check.ok) return reply.code(400).send({ error: check.error ?? 'invalid key' });
    return repos.connectProvider(wsId, provider, body.apiKey.trim(), body.model ?? '');
  });
  app.post('/api/providers/:provider/disconnect', async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    if (!isProviderId(provider)) return reply.code(400).send({ error: 'unsupported provider' });
    const wsId = resolveWorkspaceId(req.body ?? {}) ?? defaultWorkspaceId();
    if (!wsId) return reply.code(400).send({ error: 'no workspace' });
    repos.disconnectProvider(wsId, provider);
    return { ok: true };
  });

  // ── SSE stream ────────────────────────────────────────────────────
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* closed */
      }
    }, 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  return app;
}
