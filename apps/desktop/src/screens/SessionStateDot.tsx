/* Tiny status dot — one CSS dot per session that reflects its git/PR state.

   Reused on every surface a session is listed on:
   • the sidebar/rail (next to the chat title — replaces nothing, just adorns)
   • the chat header (next to the codename)
   • the project card icon overlay (worst-state-wins rollup)

   Pulse animation reserved for actionable / urgent states (PR conflicts +
   ready-for-pr) so the eye is drawn there first. Everything else sits still. */

import React from 'react';
import type { SessionGitState } from '../lib/git-types';
import { SESSION_STATE_COLOR, SESSION_STATE_LABELS } from '../lib/git-types';
import { useSessionStateOnly, useProjectRollupState } from '../lib/useSessionGitState';
import { useSessionRunning, useProjectRunning } from '../lib/useSessionRunning';

export interface SessionStateDotProps {
  state: SessionGitState | null | undefined;
  /** Outer diameter, px. Default 8. The dot itself is 60% of this. */
  size?: number;
  /** Tooltip override; defaults to the state label. */
  title?: string;
  /** Whether to render a fixed-size slot when `state` is null/no-repo (helps
      keep alignment in lists). Default false — render nothing. */
  reserveSpace?: boolean;
}

const PULSE_STATES = new Set<SessionGitState>(['pr-conflicts', 'pr-mergeable']);

export function SessionStateDot({ state, size = 8, title, reserveSpace }: SessionStateDotProps) {
  if (!state || state === 'no-repo') {
    return reserveSpace
      ? <span aria-hidden="true" style={{ display: 'inline-block', width: size, height: size }} />
      : null;
  }
  const color = SESSION_STATE_COLOR[state];
  const label = title ?? SESSION_STATE_LABELS[state];
  const pulse = PULSE_STATES.has(state);
  const inner = Math.max(4, Math.round(size * 0.75));
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={pulse ? 'session-state-dot breathe' : 'session-state-dot'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
      }}>
      <span style={{
        width: inner,
        height: inner,
        borderRadius: inner / 2,
        background: color,
        boxShadow: pulse ? `0 0 0 2px color-mix(in srgb, ${color} 30%, transparent)` : 'none',
        transition: 'background 200ms ease',
      }} />
    </span>
  );
}

/* ───────────────── Running indicator ─────────────────
   While a session's job is actively running, its pill/icon shows a smooth
   spinning ring INSTEAD of the git-state dot — the clearest "the agent is
   working right now" cue. The arc is a conic-gradient masked into a ring so it
   reads at very small sizes (7–11px) where a border-spinner would look like a
   solid dot. `@keyframes spin` is defined globally in index.css. */
export function RunningDot({ size = 9, title = 'Running', tint = 'var(--purple)' }: { size?: number; title?: string; tint?: string }) {
  const thick = Math.max(1.5, size / 4);
  const inner = size / 2 - thick;
  return (
    <span role="img" aria-label={title} title={title} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flexShrink: 0 }}>
      <span style={{
        width: size, height: size, borderRadius: '50%', display: 'inline-block',
        // A ~250° arc with soft edges; rotating gives a smooth indeterminate spin.
        background: `conic-gradient(from 0deg, transparent 0deg, ${tint} 70deg, ${tint} 300deg, transparent 360deg)`,
        WebkitMask: `radial-gradient(circle, transparent ${inner}px, #000 ${inner + 0.5}px)`,
        mask: `radial-gradient(circle, transparent ${inner}px, #000 ${inner + 0.5}px)`,
        animation: 'spin 0.75s linear infinite',
      }} />
    </span>
  );
}

/** The dot shown on a SESSION row/pill: a spinning ring while the agent is
    running, otherwise the git/PR state dot. Drop-in for <SessionStateDot/>. */
export function SessionActivityDot({ sessionId, size = 8 }: { sessionId: string | null | undefined; size?: number }) {
  const running = useSessionRunning(sessionId);
  const state = useSessionStateOnly(sessionId);
  if (running) return <RunningDot size={Math.max(9, size + 1)} />;
  return <SessionStateDot state={state} size={size} reserveSpace />;
}

/** The dot shown on a PROJECT icon: a spinning ring if ANY of the project's
    sessions is running, otherwise the worst-state-wins git rollup. Returns null
    when there's nothing to show (no running + no repo state). */
export function ProjectActivityDot({ projectId, sessionIds, size = 10 }: { projectId: string | null | undefined; sessionIds: string[]; size?: number }) {
  const running = useProjectRunning(projectId, sessionIds);
  const rollup = useProjectRollupState(projectId, sessionIds);
  if (running) return <RunningDot size={Math.max(11, size + 1)} />;
  if (rollup && rollup !== 'no-repo') return <SessionStateDot state={rollup} size={size} />;
  return null;
}
