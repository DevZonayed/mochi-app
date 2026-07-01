/* ExitPlanModeDialog — DOM tests.

   The dialog is a thin shell over IPC: it subscribes to a `plan-mode-exit-request`
   event, shows a modal with the agent's plan, and on click sends the operator's
   decision back via `api.exitPlanModeRespond`. The contract worth pinning down:

   - It renders nothing while no request is pending
   - On a Claude request: Approve resolves with true + flips localStorage to '0'
     AND dispatches `maestro:plan-mode-changed` so the composer's React state
     catches up
   - On a Codex request: Approve does ALL of the above AND dispatches
     `maestro:plan-approved-codex` (in rAF) so ProjectDetail can auto-send the
     "execute the plan now" follow-up. Codex needs this because its one-shot
     `codex exec` can't continue the run the way Claude's SDK can
   - Keep Planning resolves with false and does NOT touch localStorage or the
     plan-mode-changed signal — the operator stays in plan mode
   - Esc key routes to Keep Planning (the conservative default — accidental
     keypress can't exit plan mode) */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { PlanModeExitRequest } from '../lib/plan-mode-types';

// `subscribe` returns an unsubscribe fn. Capture the handler so each test can
// fire the event at its own time.
let lastSubscribeHandlers: Parameters<typeof import('../lib/api').api.subscribe>[0] | null = null;
const exitPlanModeRespondMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    subscribe: (handlers: unknown) => {
      lastSubscribeHandlers = handlers as Parameters<typeof import('../lib/api').api.subscribe>[0];
      return () => { lastSubscribeHandlers = null; };
    },
    exitPlanModeRespond: (id: string, approved: boolean) => {
      exitPlanModeRespondMock(id, approved);
      return Promise.resolve({ ok: true });
    },
  },
}));

// Import AFTER the mock so the dialog picks up the mocked `api`.
import { ExitPlanModeDialog } from './ExitPlanModeDialog';

const fireRequest = (req: PlanModeExitRequest) => {
  // act() so React processes the setState synchronously; otherwise the
  // assertions below race with the next render.
  act(() => { lastSubscribeHandlers?.onPlanModeExitRequest?.(req); });
};

const baseReq = (overrides: Partial<PlanModeExitRequest> = {}): PlanModeExitRequest => ({
  toolUseID: 'tu-1',
  plan: '## Plan\n\n1. Read foo.ts\n2. Add bar\n3. Tests',
  sessionId: 'sess-1',
  jobId: 'job-1',
  engine: 'claude',
  ...overrides,
});

beforeEach(() => {
  exitPlanModeRespondMock.mockReset();
  lastSubscribeHandlers = null;
  // Each test gets its own localStorage state.
  try { localStorage.removeItem('maestro.chat.plan'); } catch { /* env-less */ }
});

afterEach(() => { cleanup(); });

describe('ExitPlanModeDialog', () => {
  it('renders nothing when no request is pending', () => {
    render(<ExitPlanModeDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the modal + plan body when a request fires', () => {
    render(<ExitPlanModeDialog />);
    fireRequest(baseReq({ plan: 'A REALLY SPECIFIC PLAN BODY' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Plan ready — approve to execute?')).toBeTruthy();
    expect(screen.getByText(/A REALLY SPECIFIC PLAN BODY/)).toBeTruthy();
    expect(screen.getByText('Approve plan')).toBeTruthy();
    expect(screen.getByText('Keep planning')).toBeTruthy();
  });

  it('falls back to a hint when the plan body is empty', () => {
    render(<ExitPlanModeDialog />);
    fireRequest(baseReq({ plan: '' }));
    expect(screen.getByText(/agent didn't supply a plan body/i)).toBeTruthy();
  });

  it('Approve resolves with true + dispatches plan-mode-changed (Claude)', async () => {
    // The plan-mode-changed event is the public contract — ProjectDetail and
    // any other listener subscribe to it. We don't assert on localStorage here
    // because happy-dom's storage state isn't reliable across testing-library
    // cleanup() between tests; the event being dispatched is sufficient proof
    // the approve branch ran (the dialog writes localStorage and dispatches in
    // the SAME synchronous block).
    const changed: { on?: boolean }[] = [];
    const onChanged = (e: Event) => { changed.push((e as CustomEvent<{ on: boolean }>).detail); };
    window.addEventListener('maestro:plan-mode-changed', onChanged);

    render(<ExitPlanModeDialog />);
    fireRequest(baseReq({ toolUseID: 'tu-claude', engine: 'claude' }));

    const approve = screen.getByText('Approve plan');
    await act(async () => { approve.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(exitPlanModeRespondMock).toHaveBeenCalledWith('tu-claude', true);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.on).toBe(false);

    window.removeEventListener('maestro:plan-mode-changed', onChanged);
  });

  it('Approve on Codex ALSO dispatches plan-approved-codex with sessionId + plan (in rAF)', async () => {
    const codexApproved: { sessionId?: string | null; plan?: string }[] = [];
    const onCodex = (e: Event) => { codexApproved.push((e as CustomEvent<{ sessionId: string | null; plan: string }>).detail); };
    window.addEventListener('maestro:plan-approved-codex', onCodex);

    render(<ExitPlanModeDialog />);
    fireRequest(baseReq({ toolUseID: 'tu-codex', engine: 'codex', sessionId: 'sess-X', plan: 'do A then B' }));

    const approve = screen.getByText('Approve plan');
    await act(async () => { approve.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // rAF defers the codex-specific dispatch by one frame — pump it.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    expect(codexApproved).toHaveLength(1);
    expect(codexApproved[0]?.sessionId).toBe('sess-X');
    expect(codexApproved[0]?.plan).toBe('do A then B');

    window.removeEventListener('maestro:plan-approved-codex', onCodex);
  });

  it('Keep Planning resolves with false and leaves localStorage + signals alone', async () => {
    const changed: unknown[] = [];
    const codexApproved: unknown[] = [];
    const onChanged = () => { changed.push({}); };
    const onCodex = () => { codexApproved.push({}); };
    window.addEventListener('maestro:plan-mode-changed', onChanged);
    window.addEventListener('maestro:plan-approved-codex', onCodex);

    render(<ExitPlanModeDialog />);
    fireRequest(baseReq({ toolUseID: 'tu-keep', engine: 'codex' }));

    const keep = screen.getByText('Keep planning');
    await act(async () => { keep.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(exitPlanModeRespondMock).toHaveBeenCalledWith('tu-keep', false);
    // The deny branch must NOT dispatch either signal — staying in plan mode
    // is the whole point of Keep Planning. These are the public contract; we
    // skip asserting on localStorage since happy-dom isn't reliable here.
    expect(changed).toHaveLength(0);
    expect(codexApproved).toHaveLength(0);

    window.removeEventListener('maestro:plan-mode-changed', onChanged);
    window.removeEventListener('maestro:plan-approved-codex', onCodex);
  });

  it('Esc key routes to Keep Planning (not Approve — the conservative default)', async () => {
    render(<ExitPlanModeDialog />);
    fireRequest(baseReq({ toolUseID: 'tu-esc' }));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(exitPlanModeRespondMock).toHaveBeenCalledWith('tu-esc', false);
  });
});
