import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isPlanFile, planPermission, planFileName, planSavedNote, PLAN_DIR, PLAN_DIRECTIVE } from './plan-mode.js';

const CWD = '/repo';
const planAbs = path.join(CWD, PLAN_DIR, 'plan-foo.md');

describe('isPlanFile', () => {
  it('accepts an absolute path inside the plan dir', () => {
    expect(isPlanFile(CWD, planAbs)).toBe(true);
  });

  it('accepts a repo-relative path inside the plan dir', () => {
    expect(isPlanFile(CWD, path.join(PLAN_DIR, 'plan-foo.md'))).toBe(true);
  });

  it('accepts nested files under the plan dir', () => {
    expect(isPlanFile(CWD, path.join(PLAN_DIR, 'sub', 'plan.md'))).toBe(true);
  });

  it('rejects a project source file', () => {
    expect(isPlanFile(CWD, path.join(CWD, 'src', 'App.tsx'))).toBe(false);
  });

  it('rejects an empty path', () => {
    expect(isPlanFile(CWD, '')).toBe(false);
  });

  it('rejects a path that escapes the plan dir via ..', () => {
    expect(isPlanFile(CWD, path.join(PLAN_DIR, '..', 'secret.md'))).toBe(false);
  });

  it('rejects a sibling dir that merely shares the prefix', () => {
    expect(isPlanFile(CWD, path.join(CWD, '.maestro', 'plans-evil', 'x.md'))).toBe(false);
  });
});

describe('planPermission', () => {
  it('denies ExitPlanMode with a nudge back to the chat flow', () => {
    const d = planPermission(CWD, 'ExitPlanMode', {});
    expect(d.behavior).toBe('deny');
    if (d.behavior === 'deny') expect(d.message).toMatch(/Don't call ExitPlanMode/);
  });

  it('allows writing the plan Markdown (file_path)', () => {
    expect(planPermission(CWD, 'Write', { file_path: planAbs })).toEqual({ behavior: 'allow' });
  });

  it('allows Edit on the plan Markdown', () => {
    expect(planPermission(CWD, 'Edit', { file_path: planAbs })).toEqual({ behavior: 'allow' });
  });

  it('allows NotebookEdit via notebook_path when it is the plan file', () => {
    const nb = path.join(CWD, PLAN_DIR, 'plan.ipynb');
    expect(planPermission(CWD, 'NotebookEdit', { notebook_path: nb })).toEqual({ behavior: 'allow' });
  });

  it('denies writing a project file', () => {
    const d = planPermission(CWD, 'Write', { file_path: path.join(CWD, 'src', 'App.tsx') });
    expect(d.behavior).toBe('deny');
    if (d.behavior === 'deny') expect(d.message).toMatch(/read-only/);
  });

  it('denies a write with no path', () => {
    expect(planPermission(CWD, 'Write', {}).behavior).toBe('deny');
  });

  it('denies any non-write, non-read tool that reaches the gate', () => {
    const d = planPermission(CWD, 'Bash', { command: 'rm -rf /' });
    expect(d.behavior).toBe('deny');
    if (d.behavior === 'deny') expect(d.message).toMatch(/read-only/);
  });
});

describe('planFileName', () => {
  it('slugs the seed into a markdown filename', () => {
    expect(planFileName('Job_42/Alpha')).toBe('plan-job-42-alpha.md');
  });

  it('trims leading/trailing separator runs', () => {
    expect(planFileName('--Hello World!--')).toBe('plan-hello-world.md');
  });

  it('caps the slug at 40 chars', () => {
    const name = planFileName('x'.repeat(120));
    expect(name).toBe(`plan-${'x'.repeat(40)}.md`);
  });

  it('falls back to a non-empty slug when the seed is empty or all symbols', () => {
    expect(planFileName('###')).toBe('plan-plan.md');
    expect(planFileName()).toMatch(/^plan-[a-z0-9]+\.md$/);
  });
});

describe('planSavedNote', () => {
  it('mentions the path and in-chat approval, and rules out a popup', () => {
    const note = planSavedNote('.maestro/plans/plan-x.md');
    expect(note).toContain('.maestro/plans/plan-x.md');
    expect(note).toMatch(/turn off Plan mode/i);
    expect(note).toMatch(/No popup/i);
  });
});

describe('directive', () => {
  it('mentions the plan dir and forbids ExitPlanMode / popups', () => {
    expect(PLAN_DIRECTIVE).toContain(PLAN_DIR);
    expect(PLAN_DIRECTIVE).toMatch(/Do NOT call the ExitPlanMode tool/);
    expect(PLAN_DIRECTIVE).toMatch(/do NOT expect a popup/);
  });
});
