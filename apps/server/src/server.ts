import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { ServerResponse } from 'node:http';
import type { Repositories, Effort } from './repositories.js';
import type { EngineAdapter } from './engine.js';

export function buildServer(repos: Repositories, engine: EngineAdapter): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

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

  app.get('/health', async () => ({ ok: true, name: 'maestro-server', version: '0.1.0', engine: engine.id, time: Date.now() }));
  app.get('/', async () => ({ ok: true, service: 'maestro-server', docs: '/health, /api/workspaces, /api/projects, /api/jobs, /api/stream' }));

  // ── Workspaces ────────────────────────────────────────────────────
  app.get('/api/workspaces', async () => repos.listWorkspaces());
  app.post('/api/workspaces', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name) return reply.code(400).send({ error: 'name required' });
    return repos.createWorkspace(name);
  });

  function defaultWorkspaceId(): string | undefined {
    return repos.listWorkspaces()[0]?.id;
  }

  // ── Projects ──────────────────────────────────────────────────────
  app.get('/api/projects', async (req, reply) => {
    const wsId = (req.query as { workspaceId?: string }).workspaceId ?? defaultWorkspaceId();
    if (!wsId) return [];
    return repos.listProjects(wsId);
  });
  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as { workspaceId?: string; name?: string; template?: string; instructions?: string };
    const workspaceId = body.workspaceId ?? defaultWorkspaceId();
    if (!workspaceId) return reply.code(400).send({ error: 'no workspace; create one first' });
    if (!body.name) return reply.code(400).send({ error: 'name required' });
    return repos.createProject({ workspaceId, name: body.name, template: body.template, instructions: body.instructions });
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
  app.post('/api/jobs/:id/run', async (req, reply) => {
    const jobId = (req.params as { id: string }).id;
    const effort = ((req.body ?? {}) as { effort?: Effort }).effort;
    let job = repos.getJob(jobId);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    job = repos.updateJob(jobId, { status: 'running', output: null, error: null });
    broadcast('job', job);
    const project = repos.getProject(job.projectId);
    try {
      const result = await engine.run({ prompt: job.input, projectInstructions: project?.instructions, effort: effort ?? job.effort });
      job = repos.updateJob(jobId, { status: 'done', output: result.output, error: null });
    } catch (e) {
      job = repos.updateJob(jobId, { status: 'failed', output: null, error: e instanceof Error ? e.message : String(e) });
    }
    broadcast('job', job);
    return job;
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
