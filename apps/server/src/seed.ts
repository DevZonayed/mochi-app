import type { Repositories, Project, Effort, Job } from './repositories.js';

type JobPatch = Partial<Pick<Job, 'status' | 'phase' | 'progress' | 'output' | 'error' | 'cost' | 'tokens' | 'stage'>>;

/** Populate a fresh DB with rich sample data so every screen shows live content.
    Each entity seeds independently (idempotent) so partial DBs fill in cleanly. */
export function seedIfEmpty(repos: Repositories): void {
  let ws = repos.defaultWorkspace();
  if (!ws) ws = repos.createWorkspace('Atlas Studio', 200);

  let projects = repos.listProjects(ws.id);
  if (projects.length === 0) {
    repos.createProject({ workspaceId: ws.id, name: 'Atlas API', template: 'claude-code', color: 'blue', instructions: 'TypeScript, Fastify, Postgres. Be terse.' });
    repos.createProject({ workspaceId: ws.id, name: 'Q3 Content', template: 'claude-design', color: 'purple', instructions: 'Brand voice: calm, confident.' });
    repos.createProject({ workspaceId: ws.id, name: 'Market Scan', template: 'research', color: 'indigo', instructions: 'Weekly competitor + pricing digest.' });
    repos.createProject({ workspaceId: ws.id, name: 'Brand Refresh', template: 'claude-design', color: 'teal', instructions: 'Export-ready assets at @1x/@2x/@3x.' });
    repos.createProject({ workspaceId: ws.id, name: 'Infra / CI', template: 'claude-code', color: 'orange', instructions: 'Keep the pipeline green.' });
    projects = repos.listProjects(ws.id);
  }
  const P = (n: string): Project => projects.find((p) => p.name === n) ?? projects[0];
  const atlas = P('Atlas API'), content = P('Q3 Content'), scan = P('Market Scan'), brand = P('Brand Refresh'), infra = P('Infra / CI');

  if (repos.listJobs().length === 0) {
    const mk = (proj: Project, title: string, effort: Effort, patch: JobPatch): void => {
      const j = repos.createJob(proj.id, title, title, effort);
      repos.updateJob(j.id, patch);
    };
    // running
    mk(atlas, 'Refactor auth service', 'deep', { status: 'running', phase: 'Building', progress: 64, cost: 0.42, tokens: 18200, stage: 'patching 3 call sites in routes/' });
    mk(atlas, 'Add rate-limiter tests', 'balanced', { status: 'running', phase: 'Building', progress: 28, cost: 0.21, tokens: 9700, stage: 'generating fixtures for 429 path' });
    mk(brand, 'Export icon set @3x', 'balanced', { status: 'running', phase: 'Rendering', progress: 72, cost: 0.12, tokens: 6100, stage: 'optimizing with pngquant…' });
    mk(content, 'Draft launch thread', 'balanced', { status: 'running', phase: 'Reviewing', progress: 88, cost: 0.07, tokens: 11400, stage: 'tightening hook on post 1/6' });
    // done (spend history)
    mk(atlas, 'Merge PR #482 — auth refactor', 'deep', { status: 'done', progress: 100, cost: 8.10, tokens: 41000, output: 'Merged. 12 files changed, +840 −210.' });
    mk(atlas, 'Migrate session store to Redis', 'deep', { status: 'done', progress: 100, cost: 6.40, tokens: 33000, output: 'Done. Cutover behind a flag.' });
    mk(atlas, 'Add rate-limiter middleware', 'balanced', { status: 'done', progress: 100, cost: 3.04, tokens: 16000, output: 'Token-bucket limiter added.' });
    mk(content, 'Generate OG images', 'balanced', { status: 'done', progress: 100, cost: 0.34, tokens: 4200, output: '6 OG cards exported.' });
    mk(content, 'Summarize support tickets', 'fast', { status: 'done', progress: 100, cost: 8.76, tokens: 52000, output: 'Top 5 themes summarized.' });
    mk(scan, 'Competitor digest', 'deep', { status: 'done', progress: 100, cost: 6.80, tokens: 28000, output: 'Digest ready — 4 movers this week.' });
    mk(brand, 'Color token audit', 'balanced', { status: 'done', progress: 100, cost: 3.90, tokens: 14000, output: 'Audit complete, 9 tokens reconciled.' });
    mk(infra, 'Dependency audit', 'balanced', { status: 'done', progress: 100, cost: 0.12, tokens: 5000, output: '2 advisories patched.' });
    // failed + queued
    mk(infra, 'Nightly test suite', 'balanced', { status: 'failed', phase: 'Failed', cost: 0.18, tokens: 7000, error: 'flaky: 2 timeouts in payments.spec' });
    mk(scan, 'Deep pricing run', 'max', { status: 'pending', phase: 'Queued', cost: 0, tokens: 0 });
  }

  if (repos.listApprovals().length === 0) {
    repos.createApproval({ projectId: atlas.id, kind: 'merge', title: 'Merge PR #482 — auth refactor', subtitle: '12 files · +840 −210', detail: 'Refactors the auth service to a token-bucket limiter and moves sessions to Redis behind a flag.' });
    repos.createApproval({ projectId: scan.id, kind: 'budget', title: 'Deep run will exceed the $5 cap', subtitle: 'Est. $6.40 · competitor digest', detail: 'The weekly competitor digest needs a deep run that is estimated to cost $6.40, above the per-job $5 cap.' });
    repos.createApproval({ projectId: content.id, kind: 'publish', title: 'Publish “Launch week” thread to X', subtitle: '6 posts · scheduled 14:00', detail: 'A 6-post thread is ready to publish to X at 14:00.' });
    repos.createApproval({ projectId: brand.id, kind: 'review', title: 'Approve export — 48 assets', subtitle: '48 assets · @1x/@2x/@3x', detail: 'Brand refresh export bundle is ready for review before handoff.' });
  }

  if (repos.listSchedules().length === 0) {
    repos.createSchedule({ projectId: scan.id, title: 'Competitor digest', time: '14:00', cadence: 'daily' });
    repos.createSchedule({ projectId: content.id, title: 'Newsletter draft', time: '16:30', cadence: 'weekly' });
    repos.createSchedule({ projectId: infra.id, title: 'Nightly test suite', time: '18:00', cadence: 'daily' });
    repos.createSchedule({ projectId: brand.id, title: 'Asset backup', time: '21:00', cadence: 'daily' });
    repos.createSchedule({ projectId: infra.id, title: 'Dependency audit', time: '06:00', cadence: 'weekly' });
  }

  if (repos.listSkills().length === 0) {
    const sk = (name: string, description: string, category: string, kind: string, enabled: boolean): void => {
      repos.createSkill({ name, description, category, kind, enabled });
    };
    sk('Web Search', 'Search the live web and cite sources.', 'Core', 'builtin', true);
    sk('Code Interpreter', 'Run sandboxed Python for data + analysis.', 'Core', 'builtin', true);
    sk('File System', 'Read & write files in the project workspace.', 'Core', 'builtin', true);
    sk('Shell', 'Execute shell commands in a sandbox.', 'Core', 'builtin', false);
    sk('GitHub', 'PRs, issues, and code review.', 'Integrations', 'mcp', true);
    sk('Slack', 'Post updates and read channels.', 'Integrations', 'mcp', true);
    sk('Linear', 'Create and update issues.', 'Integrations', 'mcp', false);
    sk('Notion', 'Read & write docs and databases.', 'Integrations', 'mcp', false);
    sk('Postgres', 'Query the production read-replica.', 'Integrations', 'mcp', true);
    sk('Image Generation', 'Generate and edit images.', 'Media', 'builtin', true);
    sk('Video Render', 'Compose and render short clips.', 'Media', 'builtin', false);
    sk('Speech', 'Text-to-speech and transcription.', 'Media', 'builtin', false);
  }

  if (repos.listTemplates().length === 0) {
    const tp = (name: string, description: string, category: string, icon: string, engine: string): void => {
      repos.createTemplate({ name, description, category, icon, engine });
    };
    tp('Claude Code', 'Autonomous coding agent for a repo.', 'Build', 'terminal', 'claude-code');
    tp('Claude Design', 'Design + front-end generation.', 'Build', 'clapper', 'claude-design');
    tp('Deep Research', 'Multi-source research with citations.', 'Research', 'telescope', 'research');
    tp('Content Studio', 'Drafts, threads, and newsletters.', 'Content', 'send', 'claude-design');
    tp('Market Scan', 'Recurring competitor + pricing digest.', 'Research', 'gauge', 'research');
    tp('Data Pipeline', 'ETL + scheduled analysis jobs.', 'Build', 'layers', 'claude-code');
  }
}
