/* Regression tests for the Agent-view (operator mode) scoping rules.

   The bug being locked down: /workspace and /operator render the same mounted
   Workspace instance, so operator scope must be re-derived every render — a
   leaked CodeSpace active project / kind filter once put all 26 coding
   projects into the Agent view. */

import { describe, it, expect } from 'vitest';
import {
  resolveOperatorScope,
  newChatTargetProject,
  isContextProject,
  scopeKind,
  type ProjectScopeLike,
} from './operatorScope';

const P = (id: string, kind?: string, hidden?: boolean): ProjectScopeLike => ({ id, kind, hidden });

const coding = P('code-1', 'coding');
const design = P('design-1', 'design');
const legacy = P('old-1'); // pre-`kind` project → 'general'
const ctx = P('ctx-1', 'context');
const ctxHidden = P('ctx-hidden', 'context', true);
const ctx2 = P('ctx-2', 'context');

describe('scopeKind / isContextProject', () => {
  it('defaults a kind-less project to general (same as Workspace)', () => {
    expect(scopeKind(legacy)).toBe('general');
    expect(scopeKind(undefined)).toBe('general');
    expect(isContextProject(legacy)).toBe(false);
  });
  it('recognizes context projects only', () => {
    expect(isContextProject(ctx)).toBe(true);
    expect(isContextProject(coding)).toBe(false);
    expect(isContextProject(design)).toBe(false);
  });
});

describe('resolveOperatorScope', () => {
  it('keeps an already-context active project', () => {
    expect(resolveOperatorScope([coding, ctx], ctx.id)).toEqual({ type: 'keep' });
  });

  it('re-aims a leaked CODING active project at the first context project (the original bug)', () => {
    expect(resolveOperatorScope([coding, ctx, ctx2], coding.id)).toEqual({ type: 'switch', pid: ctx.id });
  });

  it('re-aims when nothing is active but a context project exists', () => {
    expect(resolveOperatorScope([coding, ctx], null)).toEqual({ type: 'switch', pid: ctx.id });
  });

  it('prefers a VISIBLE context project over a hidden one', () => {
    expect(resolveOperatorScope([ctxHidden, ctx], coding.id)).toEqual({ type: 'switch', pid: ctx.id });
  });

  it('falls back to a hidden context project when it is the only one', () => {
    expect(resolveOperatorScope([coding, ctxHidden], coding.id)).toEqual({ type: 'switch', pid: ctxHidden.id });
  });

  it('clears a leaked active project when NO context project exists (coding tabs must not bleed in)', () => {
    expect(resolveOperatorScope([coding, design, legacy], coding.id)).toEqual({ type: 'clear' });
  });

  it('clears even when the active id no longer resolves to a project', () => {
    expect(resolveOperatorScope([coding], 'deleted-project')).toEqual({ type: 'clear' });
  });

  it('does nothing when nothing is active and there are no context projects', () => {
    expect(resolveOperatorScope([coding, design], null)).toEqual({ type: 'none' });
    expect(resolveOperatorScope([], null)).toEqual({ type: 'none' });
  });

  it('is stable once switched: the switched-to project resolves to keep (no effect loop)', () => {
    const projects = [coding, ctx];
    const first = resolveOperatorScope(projects, coding.id);
    expect(first).toEqual({ type: 'switch', pid: ctx.id });
    // simulate the effect applying the switch, then re-running
    expect(resolveOperatorScope(projects, ctx.id)).toEqual({ type: 'keep' });
  });
});

describe('newChatTargetProject', () => {
  it('always targets the active project when set', () => {
    expect(newChatTargetProject(true, ctx.id, [coding, ctx])).toBe(ctx.id);
    expect(newChatTargetProject(false, coding.id, [coding, ctx])).toBe(coding.id);
  });

  it('operator fallback picks a context project, never the first coding project', () => {
    expect(newChatTargetProject(true, null, [coding, ctx])).toBe(ctx.id);
  });

  it('operator fallback returns null when no context project exists (caller opens the add modal)', () => {
    expect(newChatTargetProject(true, null, [coding, design])).toBeNull();
  });

  it('CodeSpace fallback keeps the old behavior: first project', () => {
    expect(newChatTargetProject(false, null, [coding, ctx])).toBe(coding.id);
    expect(newChatTargetProject(false, null, [])).toBeNull();
  });
});
