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
