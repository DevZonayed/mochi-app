import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  listApprovals: vi.fn(),
  approveApproval: vi.fn(),
  denyApproval: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectRepo: vi.fn(),
  listJobs: vi.fn(),
  listJobPage: vi.fn(),
  listSessions: vi.fn(),
  listProjectSkills: vi.fn(),
  listProjectFiles: vi.fn(),
  listSchedules: vi.fn(),
  listBgTasks: vi.fn(),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  getRoles: vi.fn(),
  scanConversations: vi.fn(),
  listBriefs: vi.fn(),
  listResearchRuns: vi.fn(),
  runResearch: vi.fn(),
  markBriefSent: vi.fn(),
  listSkills: vi.fn(),
  skillRegistryMeta: vi.fn(),
  toggleSkill: vi.fn(),
  sendChat: vi.fn(),
  createAndRunJob: vi.fn(),
  cancelJob: vi.fn(),
  budget: vi.fn(),
  deleteProject: vi.fn(),
  updateProject: vi.fn(),
  getSessionGitStatus: vi.fn(),
  archiveSessionWorktree: vi.fn(),
  listModels: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<object>('../lib/api');
  return { ...actual, api: apiMock };
});

vi.mock('../lib/appShell', async () => {
  const actual = await vi.importActual<object>('../lib/appShell');
  return {
    ...actual,
    AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Sidebar: ({ children }: { children?: React.ReactNode }) => <aside>{children}</aside>,
    Toolbar: () => <div />,
    TrafficLights: () => <div />,
    useAppScale: () => 1,
    useTheme: () => ['light', vi.fn()],
    useWorkspaceName: () => 'Test Workspace',
  };
});

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ id: 'p1', projectId: 'p1' }),
  useLocation: () => ({ pathname: '/projects', search: '', hash: '', state: null, key: 'test' }),
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));

function routed(ui: React.ReactElement, path = '/') {
  void path;
  return render(ui);
}

function routedProjectDetail(ui: React.ReactElement) {
  return render(ui);
}

function setRichComposerText(text: string) {
  const box = screen.getAllByRole('textbox').find(el => el.getAttribute('contenteditable') === 'true') as HTMLElement | undefined;
  expect(box).toBeTruthy();
  box!.textContent = text;
  fireEvent.input(box!);
  return box!;
}

const now = 1_784_221_919_448;

function project(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Real Project',
    template: 'code',
    kind: 'coding',
    path: '/tmp/real-project',
    instructions: '',
    color: 'blue',
    createdAt: now - 10_000,
    workspaceId: 'w1',
    ...over,
  };
}

function job(over: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    projectId: 'p1',
    sessionId: 's1',
    title: 'Real running job',
    status: 'running',
    effort: 'balanced',
    engine: 'codex',
    model: 'gpt-5',
    cost: 1.25,
    tokens: 1200,
    createdAt: now - 60_000,
    updatedAt: now - 1000,
    output: 'real output',
    error: null,
    phase: 'Working',
    stage: 'Working',
    ...over,
  };
}

function approval(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    kind: 'merge',
    status: 'pending',
    projectId: 'p1',
    title: 'Review supplied title',
    subtitle: 'Only this supplied subtitle appears.',
    detail: 'Only this supplied detail appears.',
    jobId: 'j1',
    createdAt: now,
    resolvedAt: null,
    ...over,
  };
}

describe('Immediate Honesty Patch rendered behavior', () => {
  beforeEach(() => {
    vi.useRealTimers();
    apiMock.listApprovals.mockResolvedValue([]);
    apiMock.approveApproval.mockResolvedValue({ ok: true });
    apiMock.denyApproval.mockResolvedValue({ ok: true });
    apiMock.listProjects.mockResolvedValue([]);
    apiMock.getProject.mockResolvedValue(project());
    apiMock.getProjectRepo.mockResolvedValue(null);
    apiMock.listJobs.mockResolvedValue([]);
    apiMock.listJobPage.mockResolvedValue({ jobs: [], items: [], nextCursor: null, nextBefore: null, hasMore: false });
    apiMock.listSessions.mockResolvedValue([]);
    apiMock.listProjectSkills.mockResolvedValue({ skills: [] });
    apiMock.listProjectFiles.mockResolvedValue([]);
    apiMock.listSchedules.mockResolvedValue([]);
    apiMock.listBgTasks.mockResolvedValue([]);
    apiMock.getSettings.mockResolvedValue({ favoriteModels: [] });
    apiMock.setSettings.mockResolvedValue({ favoriteModels: [] });
    apiMock.getRoles.mockResolvedValue({});
    apiMock.scanConversations.mockResolvedValue([]);
    apiMock.listBriefs.mockResolvedValue([]);
    apiMock.listResearchRuns.mockResolvedValue([]);
    apiMock.runResearch.mockResolvedValue(undefined);
    apiMock.markBriefSent.mockResolvedValue(undefined);
    apiMock.listSkills.mockResolvedValue([]);
    apiMock.skillRegistryMeta.mockResolvedValue({ count: 0 });
    apiMock.toggleSkill.mockImplementation(async (id: string) => ({ id, enabled: true }));
    apiMock.sendChat.mockResolvedValue({ session: { id: 's1', projectId: 'p1', title: 'Chat', createdAt: now, updatedAt: now }, job: job({ id: 'j-chat', title: 'Chat turn' }) });
    apiMock.createAndRunJob.mockResolvedValue(job({ id: 'j-goal', title: 'Goal run' }));
    apiMock.cancelJob.mockResolvedValue({ ok: true });
    apiMock.budget.mockResolvedValue({ spent: 12, cap: 200 });
    apiMock.deleteProject.mockResolvedValue({ ok: true });
    apiMock.updateProject.mockResolvedValue(project());
    apiMock.getSessionGitStatus.mockResolvedValue(null);
    apiMock.archiveSessionWorktree.mockResolvedValue({ ok: true });
    apiMock.listModels.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    navigateMock.mockClear();
  });

  test('PlanDiffGate renders no pending plan instead of prototype plan claims', async () => {
    const { default: PlanDiffGate } = await import('./PlanDiffGate');
    routed(<PlanDiffGate />);
    expect(await screen.findByText('No plan pending')).toBeTruthy();
    expect(screen.getByText('There is no approval context to display right now.')).toBeTruthy();
    expect(screen.queryByText(/short-lived JWTs|Judge panel|files reviewed|Waiting at gate|PLANNED AT DEEP/i)).toBeNull();
  });

  test('PlanDiffGate renders supplied approval fields only and uses exact approve/deny ids', async () => {
    apiMock.listApprovals.mockResolvedValue([approval()]);
    apiMock.listProjects.mockResolvedValue([project()]);
    const { default: PlanDiffGate } = await import('./PlanDiffGate');
    routed(<PlanDiffGate />);
    expect(await screen.findByText('Review supplied title')).toBeTruthy();
    expect(screen.getByText('Only this supplied detail appears.')).toBeTruthy();
    expect(screen.getAllByText('Real Project').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Refactor auth service|src\/auth\/session|Reviewer · GPT|Request fixes|Approve & merge/i)).toBeNull();
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(apiMock.approveApproval).toHaveBeenCalledWith('a1'));
    fireEvent.click(screen.getByText('Deny'));
    await waitFor(() => expect(apiMock.denyApproval).toHaveBeenCalledWith('a1'));
  });

  test('TrendIntelligence shows real empty state and keeps run research action', async () => {
    const { default: TrendIntelligence } = await import('./TrendIntelligence');
    routed(<TrendIntelligence />);
    expect(await screen.findByText('No trend data is available. Enter a topic above and run research.')).toBeTruthy();
    expect(screen.queryByText('+128%')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/Research a topic/i), { target: { value: 'real topic' } });
    fireEvent.click(screen.getByText('Run research'));
    await waitFor(() => expect(apiMock.runResearch).toHaveBeenCalledWith('real topic'));
  });

  test('TrendIntelligence renders real briefs without fabricated signals', async () => {
    apiMock.listBriefs.mockResolvedValueOnce([{
      id: 'b1',
      topic: 'Real topic',
      headline: 'Real brief',
      hook: 'Real summary',
      titles: ['Real title'],
      platforms: ['TikTok'],
      confidence: 0.88,
      sources: ['https://example.com/source'],
      status: 'ready',
      jobId: 'j-brief',
      createdAt: now,
    }]);
    const { default: TrendIntelligence } = await import('./TrendIntelligence');
    routed(<TrendIntelligence />);
    expect(await screen.findByText('Real brief')).toBeTruthy();
    expect(screen.getAllByText((_, node) => node?.textContent === '“Real summary”').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\+128%|Aphex-style ambient loop|posting velocity/)).toBeNull();
  });

  test('McpGateway renders installed skills from ApiSkill fields and keeps toggle/activity behavior truthful', async () => {
    apiMock.listSkills.mockResolvedValueOnce([{
      id: 'mcp-1',
      name: 'Real MCP',
      description: 'Real installed skill description',
      category: 'Automation',
      kind: 'mcp',
      version: '1.2.3',
      enabled: true,
      createdAt: now,
    }]);
    const { default: McpGateway } = await import('./McpGateway');
    routed(<McpGateway />);
    expect(await screen.findByText('Real MCP')).toBeTruthy();
    expect(screen.getByText('Real installed skill description')).toBeTruthy();
    expect(screen.getByText('Automation')).toBeTruthy();
    expect(screen.getByText('mcp')).toBeTruthy();
    expect(screen.getByText('v1.2.3')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.getByText('Installed MCP skills')).toBeTruthy();
    expect(screen.queryByText(/Signature verified|Unsigned|0 tools|0 loaded|read-only|Load on demand|startup tokens/i)).toBeNull();
    expect(screen.queryByText(/One chokepoint|every tool call passes through the gateway|lands in the audit log|complete audit|enforced|enforcement|signing|signature|permission|token savings/i)).toBeNull();
    fireEvent.click(screen.getAllByRole('button').at(-1) as HTMLElement);
    await waitFor(() => expect(apiMock.toggleSkill).toHaveBeenCalledWith('mcp-1'));
    fireEvent.click(screen.getByText('Live activity'));
    expect(screen.getByText('No MCP activity is available.')).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByText('No MCP activity is available.')).toBeTruthy();
    expect(screen.queryByText(/get_pull_request|delete_repo|drop_table/)).toBeNull();
  });

  test('AuditHistory renders real runs and the truthful audit empty state', async () => {
    apiMock.listProjects.mockResolvedValueOnce([project()]);
    apiMock.listJobs.mockResolvedValueOnce([job({ status: 'done', title: 'Completed real run', updatedAt: now })]);
    const { default: AuditHistory } = await import('./AuditHistory');
    routed(<AuditHistory />);
    expect(await screen.findByText('Completed real run')).toBeTruthy();
    fireEvent.click(screen.getByText('Audit'));
    expect(screen.getByText('Audit log unavailable')).toBeTruthy();
    expect(screen.queryByText(/Replay|Export|Hash chain verified/)).toBeNull();
  });

  test('ApprovalsCenter renders live approval and calls approve/deny with exact ids', async () => {
    apiMock.listProjects.mockResolvedValue([project()]);
    apiMock.listApprovals.mockResolvedValue([approval({ id: 'ap1', title: 'Real approval', detail: 'Real detail' })]);
    const { default: ApprovalsCenter } = await import('./ApprovalsCenter');
    routed(<ApprovalsCenter />);
    expect((await screen.findAllByText('Real approval')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Reviewer: all clear|Reviewer result unavailable|3\/3 judges|Downgrade model|Abort run|Raise cap to \$60/)).toBeNull();
    expect(screen.queryByText('Review result unavailable')).toBeTruthy();
    fireEvent.click(screen.getByText(/^Approve/));
    await waitFor(() => expect(apiMock.approveApproval).toHaveBeenCalledWith('ap1'));
    fireEvent.click(screen.getByText(/^Reject/));
    await waitFor(() => expect(apiMock.denyApproval).toHaveBeenCalledWith('ap1'));
  });

  test('JobMonitor preserves real status, cancel, and steer behavior without gated labels', async () => {
    apiMock.listProjects.mockResolvedValueOnce([project()]);
    apiMock.listJobs.mockResolvedValueOnce([job()]);
    const { default: JobMonitor } = await import('./JobMonitor');
    routed(<JobMonitor />);
    expect(await screen.findByText('Real running job')).toBeTruthy();
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
    expect(screen.queryByText('Gated')).toBeNull();
    fireEvent.click(screen.getAllByText('Real running job')[0]);
    const steer = await screen.findByPlaceholderText(/Steer this run/i);
    fireEvent.change(steer, { target: { value: 'real steer' } });
    fireEvent.keyDown(steer, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(apiMock.cancelJob).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(apiMock.sendChat).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', sessionId: 's1', text: 'real steer' })));
  });

  test('Projects renders live project fields without cap/subproject/activity defaults', async () => {
    apiMock.listProjects.mockResolvedValueOnce([project({ name: 'Live Project', path: '/tmp/live-project' })]);
    apiMock.listApprovals.mockResolvedValueOnce([]);
    apiMock.listSessions.mockResolvedValueOnce([]);
    apiMock.listJobs.mockResolvedValueOnce([]);
    const { default: Projects } = await import('./Projects');
    routed(<Projects />);
    expect(await screen.findByText('Live Project')).toBeTruthy();
    fireEvent.click(screen.getByText('List'));
    expect(screen.queryByText('Schedule')).toBeNull();
    expect(screen.getByText('Source')).toBeTruthy();
    fireEvent.click(screen.getByText('Live Project'));
    expect(navigateMock).toHaveBeenCalledWith('/project-detail/p1');
    expect(screen.queryByText(/41,209 entries|Sub-projects|Next run|Activity/i)).toBeNull();
  });

  test('ProjectDetail renders live project header without fabricated controls', async () => {
    const { default: ProjectDetail } = await import('./ProjectDetail');
    routedProjectDetail(<ProjectDetail />);
    expect((await screen.findAllByText('Real Project')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Sub-projects')).toBeNull();
    expect(screen.queryByText(/Gated|Unattended|\$0\.60|~6 min/)).toBeNull();

    expect(screen.getByText('Code')).toBeTruthy();

    fireEvent.click(screen.getByText('Instructions'));
    expect(await screen.findByText('instructions.md')).toBeTruthy();
    expect(screen.queryByText(/Atlas API|Fastify|Postgres|Hard budget cap/)).toBeNull();

    fireEvent.click(screen.getByText('Budget'));
    expect(await screen.findByText('Project budget data unavailable')).toBeTruthy();
    expect(screen.queryByText(/Refactor auth service|Hard cap|\\$50|Spend by job/)).toBeNull();
  });

  test('ProjectDetail preserves visible chat Plan/Goal API wiring', async () => {
    const { default: ProjectDetail } = await import('./ProjectDetail');
    routedProjectDetail(<ProjectDetail />);
    expect((await screen.findAllByText('Real Project')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Plan'));
    let composer = setRichComposerText('make a real plan');
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(apiMock.sendChat).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1',
      text: 'make a real plan',
      plan: true,
      goal: false,
    })));

    apiMock.sendChat.mockClear();
    fireEvent.click(screen.getByText('Plan'));
    fireEvent.click(screen.getByText(/^(Pursue goal|Goal)$/));
    composer = setRichComposerText('pursue the real goal');
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(apiMock.sendChat).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1',
      text: 'pursue the real goal',
      plan: false,
      goal: true,
    })));
  });
});
