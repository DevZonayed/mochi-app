import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const productionFiles = [
  'lib/ui.tsx',
  'screens/ProjectDetail.tsx',
  'screens/PlanDiffGate.tsx',
  'screens/TrendIntelligence.tsx',
  'screens/JobMonitor.tsx',
  'screens/ApprovalsCenter.tsx',
  'screens/McpGateway.tsx',
  'screens/AuditHistory.tsx',
  'screens/Projects.tsx',
].map(file => path.join(rendererRoot, file));

const prohibited = [
  '41,209 entries',
  'Refactor auth service to short-lived JWTs',
  'Refactor auth service',
  'Issue short-lived JWTs on login',
  'Auth service',
  'auth-refactor',
  '3/3 judges',
  'Judge panel: 3/3 approve',
  '3 of 5 files reviewed',
  'Waiting at gate',
  'PLANNED AT DEEP',
  'Reviewer: all clear',
  'Reviewer result unavailable',
  'Reviewer · GPT reviewer',
  'pass 2 of 2',
  'src/auth/session.ts',
  'Bearer parsing assumes',
  'Legacy cookie fallback',
  'clearSession is now explicitly typed',
  'Approve & merge to PR',
  'Request fixes',
  'Already approved',
  'Gate survived a restart',
  'Refactor Atlas API',
  'Atlas API',
  'Fastify',
  'Postgres',
  'fallback Atlas',
  '+128%',
  'Aphex-style ambient loop',
  'Wed & Sat, 6',
  'posting velocity vs last week',
  'Audio angle',
  'Competitor stream',
  'Heatmap',
  'Peak window',
  'CALLS_SEED',
  'get_pull_request',
  'delete_repo',
  'drop_table',
  'Grant access',
  'GrantSheet',
  'Finance Copilot',
  'Launch Ops',
  'Design System',
  'Raised Market Scan',
  'Market Scan’s monthly ceiling',
  'Raise cap to $60',
  'Hard budget cap',
  'Hard cap',
  'Downgrade model',
  'Abort run',
  'Over budget · $60',
  '~6 min',
  '12 min',
  '$0.60',
  '$1.80',
  '$3.00',
  'EFFORT_EST',
  'Sub-projects',
  "['Schedule', null]",
  'Frontend · React',
  'Backend · Node',
  'Docs · MDX',
  '41,209 entries',
  'Hash chain verified',
  'Read-only replay',
  'Export CSV',
  'ReplayOverlay',
];

describe('truthful UI production contract', () => {
  test('prototype honesty patch literals do not occur in production renderer code', () => {
    const haystack = productionFiles.map(file => `${file}\n${readFileSync(file, 'utf8')}`).join('\n');
    for (const literal of prohibited) {
      expect(haystack, literal).not.toContain(literal);
    }
  });

  test('review needs-work status is a real persisted terminal state, not prototype copy', () => {
    const api = readFileSync(path.join(rendererRoot, 'lib/api.ts'), 'utf8');
    const store = readFileSync(path.resolve(rendererRoot, '../brain/store.ts'), 'utf8');
    const release = readFileSync(path.resolve(rendererRoot, '../webview-app/local-release.mjs'), 'utf8');
    expect(api).toContain("'gated'");
    expect(store).toContain("'gated'");
    expect(release).toContain("'gated'");
  });

  test('ProjectDetail composer keeps real goal submission wiring without visual autonomy claims', () => {
    const src = readFileSync(path.join(rendererRoot, 'screens/ProjectDetail.tsx'), 'utf8');
    expect(src).toContain('api.createAndRunJob');
    expect(src).toContain('api.sendChat');
    expect(src).toContain('projectId, input: text');
    expect(src).toContain('plan: planMode');
    expect(src).toContain('goal: goalMode');
    expect(src).toContain('EffortDial value={effort}');
    expect(src).toContain('ModelSwitcher value={engine}');
    expect(src).not.toContain('setAutonomy');
    expect(src).not.toContain('Unattended');
  });

  test('MCP gateway has no self-generating activity timer', () => {
    const src = readFileSync(path.join(rendererRoot, 'screens/McpGateway.tsx'), 'utf8');
    expect(src).toContain('api.listSkills');
    expect(src).toContain('api.toggleSkill');
    expect(src).toContain('No MCP activity is available.');
    expect(src).toContain('No MCP denials are available.');
    expect(src).not.toContain('setInterval');
    expect(src).not.toContain('Math.random');
  });

  test('MCP gateway skill rows expose only ApiSkill-backed facts', () => {
    const src = readFileSync(path.join(rendererRoot, 'screens/McpGateway.tsx'), 'utf8');
    expect(src).toContain('type Skill as ApiSkill');
    expect(src).toContain('description');
    expect(src).toContain('category');
    expect(src).toContain('version');
    expect(src).toContain('enabled');
    expect(src).not.toContain("transport: 'HTTP'");
    expect(src).not.toContain('Signature verified');
    expect(src).not.toContain('Unsigned');
    expect(src).not.toContain('tools ·');
    expect(src).not.toContain('loaded');
    expect(src).not.toContain("scope: 'read-only'");
    expect(src).not.toContain('Load on demand');
    expect(src).not.toContain('startup tokens');
    expect(src).not.toContain('setDefer');
  });

  test('MCP gateway does not claim unsupported gateway authority or audit coverage', () => {
    const src = readFileSync(path.join(rendererRoot, 'screens/McpGateway.tsx'), 'utf8');
    expect(src).toContain('Installed MCP skills');
    expect(src).not.toContain('One chokepoint');
    expect(src).not.toContain('every tool call passes through the gateway');
    expect(src).not.toContain('lands in the audit log');
    expect(src).not.toMatch(/chokepoint/i);
    expect(src).not.toMatch(/complete audit/i);
    expect(src).not.toMatch(/audit log/i);
    expect(src).not.toMatch(/enforced|enforcement/i);
    expect(src).not.toMatch(/signing|signed|signature/i);
    expect(src).not.toMatch(/permission/i);
    expect(src).not.toMatch(/token savings|startup tokens/i);
  });

  test('Audit history preserves live runs and does not expose audit replay/export controls', () => {
    const src = readFileSync(path.join(rendererRoot, 'screens/AuditHistory.tsx'), 'utf8');
    expect(src).toContain('api.listJobs()');
    expect(src).toContain('buildRuns(apiJobs, apiProjects)');
    expect(src).toContain('Audit log unavailable');
    expect(src).not.toContain('ReplayOverlay');
    expect(src).not.toContain('Export</button>');
  });

  test('Projects list has no project schedule column until real schedule data exists', () => {
    const src = readFileSync(path.join(rendererRoot, 'screens/Projects.tsx'), 'utf8');
    expect(src).toContain("['Source', null]");
    expect(src).not.toContain("['Schedule', null]");
    expect(src).not.toMatch(/gridTemplateColumns: '2fr 1\.5fr 1\.4fr 0\.8fr 1fr 36px'/);
  });

  test('Approvals unavailable merge detail stays neutral without reviewer glyph implication', () => {
    const src = readFileSync(path.join(rendererRoot, 'screens/ApprovalsCenter.tsx'), 'utf8');
    expect(src).toContain('Review result unavailable');
    expect(src).not.toContain('OpenAIGlyph');
    expect(src).not.toContain('Reviewer result unavailable');
  });

  test('API docs match exact qualitative effort depth export', () => {
    const uiSrc = readFileSync(path.join(rendererRoot, 'lib/ui.tsx'), 'utf8');
    const apiDoc = readFileSync(path.join(rendererRoot, 'lib/API.md'), 'utf8');
    const expectedType = 'const EFFORT_DEPTH: Record<EffortStop, { label: string; detail: string }>';
    const expectedSourceValues = [
      "FAST:     { label: 'Fast', detail: 'Quick pass' }",
      "BALANCED: { label: 'Balanced', detail: 'Default depth' }",
      "DEEP:     { label: 'Deep', detail: 'More thorough pass' }",
      "MAX:      { label: 'Max', detail: 'Most thorough pass' }",
    ];
    const expectedDocValues = [
      "`FAST` → `{ label: 'Fast', detail: 'Quick pass' }`",
      "`BALANCED` → `{ label: 'Balanced', detail: 'Default depth' }`",
      "`DEEP` → `{ label: 'Deep', detail: 'More thorough pass' }`",
      "`MAX` → `{ label: 'Max', detail: 'Most thorough pass' }`",
    ];

    expect(apiDoc).toContain(expectedType);
    expect(uiSrc).toContain(`export ${expectedType} = {`);
    for (const value of expectedSourceValues) {
      expect(uiSrc).toContain(value);
    }
    for (const value of expectedDocValues) {
      expect(apiDoc).toContain(value);
    }
    expect(apiDoc).not.toContain('Record<EffortStop, string>');
    expect(apiDoc).not.toContain('Balanced pass');
    expect(apiDoc).not.toContain('Deep pass');
    expect(apiDoc).not.toContain('Max depth');
    expect(uiSrc).not.toContain('Smallest useful pass');
  });
});
