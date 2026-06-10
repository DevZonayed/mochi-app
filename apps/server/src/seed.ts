import type { Repositories } from './repositories.js';

/** Populate a fresh DB with sample data so the deployed UI looks alive. */
export function seedIfEmpty(repos: Repositories): void {
  if (repos.listWorkspaces().length > 0) return;

  const ws = repos.createWorkspace('Atlas Studio');
  const atlas = repos.createProject({ workspaceId: ws.id, name: 'Atlas API', template: 'claude-code', instructions: 'TypeScript, Fastify, Postgres. Be terse.' });
  const content = repos.createProject({ workspaceId: ws.id, name: 'Q3 Content', template: 'claude-design', instructions: 'Brand voice: calm, confident.' });
  repos.createProject({ workspaceId: ws.id, name: 'Market Scan', template: 'claude', instructions: '' });
  repos.createProject({ workspaceId: ws.id, name: 'Brand Refresh', template: 'claude-design', instructions: '' });

  const done = repos.createJob(atlas.id, 'Refactor auth service', 'Refactor auth service');
  repos.updateJob(done.id, { status: 'done', output: '[echo:balanced] Refactor auth service', error: null });
  repos.createJob(atlas.id, 'Add rate-limiter tests', 'Add rate-limiter tests');
  repos.createJob(content.id, 'Draft launch thread', 'Draft launch thread');
}
