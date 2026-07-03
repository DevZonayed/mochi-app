/* ExitPlanModeDialog — the renderer half of plan-mode-gate.ts.

   WHY THIS EXISTS
   When the operator turns on the composer's Plan toggle, runClaude passes
   `permissionMode: 'plan'` to the Claude Agent SDK and the agent plans without
   executing. When it's ready it calls `ExitPlanMode({ plan })`; the SDK pauses
   the run on that call and invokes the host's `canUseTool` callback. The host
   is expected to render an "approve plan" UI — Maestro did NOT have one
   before, so plan mode was a one-way trip: the agent stayed trapped, every
   Bash/Edit got denied, and the operator saw no way out (this is the exact
   dead-end the SecureWire transcript hit).

   This dialog mirrors PrActionConfirmDialog: subscribe to a `desktopOnly`
   event the engine emits, show a modal with the plan body + Approve / Keep
   Planning buttons, send the operator's decision back over IPC. On Approve
   we ALSO flip `maestro.chat.plan` to '0' in localStorage so the composer's
   Plan toggle reflects the new state and the next message doesn't restart the
   agent in plan mode unless the operator re-enables it. */

import React from 'react';
import { api } from '../lib/api';
import type { PlanModeExitRequest } from '../lib/plan-mode-types';

interface DialogState { req: PlanModeExitRequest; openedAt: number }

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9999,
  background: 'rgba(0,0,0,0.45)',
  display: 'grid', placeItems: 'center',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
};
const cardStyle: React.CSSProperties = {
  width: 'min(560px, 92vw)',
  maxHeight: '82vh',
  background: 'var(--bg-elevated)',
  color: 'var(--ink)',
  borderRadius: 14,
  border: '0.5px solid var(--separator)',
  boxShadow: 'var(--card-shadow)',
  padding: 20,
  display: 'flex', flexDirection: 'column', gap: 14,
  font: '500 var(--fs-footnote)/1.45 var(--font-text)',
};
const btnBase: React.CSSProperties = {
  height: 32, padding: '0 14px', borderRadius: 8,
  font: '600 var(--fs-footnote)/1 var(--font-text)',
  cursor: 'pointer',
};
const btnCancel: React.CSSProperties = {
  ...btnBase,
  background: 'var(--fill-secondary)',
  color: 'var(--ink)',
  border: '0.5px solid var(--separator-strong)',
};
const btnConfirm: React.CSSProperties = {
  ...btnBase,
  background: 'var(--blue)',
  color: '#FFFFFF',
  border: '0.5px solid var(--blue-press)',
};

/** Mount once at the app root (see App.tsx). Subscribes to
 *  `plan-mode-exit-request` events and shows the modal until the operator
 *  picks Approve or Keep Planning. */
export function ExitPlanModeDialog() {
  const [state, setState] = React.useState<DialogState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);

  // Subscribe to plan-mode-exit-request events. Most-recent-wins on the rare
  // case of overlapping requests (parallel chats — each has its own toolUseID,
  // so the answer still routes correctly; this just decides which dialog the
  // operator sees). Auto-clears on close so the modal can be re-opened.
  React.useEffect(() => {
    const off = api.subscribe({
      onPlanModeExitRequest: (req) => {
        setErr(null);
        setState({ req, openedAt: Date.now() });
      },
    });
    return off;
  }, []);

  // Esc → keep planning (the conservative default). No Enter binding — the
  // click is the gate so an accidental keystroke can't exit plan mode.
  React.useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); void respond(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Focus "Keep planning" on open — accidental Enter/Space keeps plan mode on.
  React.useEffect(() => {
    if (state) {
      const id = requestAnimationFrame(() => { cancelRef.current?.focus(); });
      return () => cancelAnimationFrame(id);
    }
  }, [state]);

  function close() { setState(null); setErr(null); setBusy(false); }

  async function respond(approved: boolean) {
    if (!state || busy) return;
    const { req } = state;
    setBusy(true); setErr(null);
    try {
      const r = await api.exitPlanModeRespond(req.toolUseID, approved);
      // Stale request (operator double-clicked, or the dialog re-mounted after
      // the run already aborted) → silently close. Not an error worth alerting.
      if (!r?.ok) { close(); return; }
      // On Approve, the agent is about to execute. Flip the composer's Plan
      // toggle off so the next message starts in normal mode (matches what the
      // operator sees — the agent is no longer planning). Also dispatch a
      // custom DOM event so the open ProjectDetail's React state for `planMode`
      // updates in real time — otherwise it stays stuck at whatever it read
      // from localStorage at mount and the next sendChat would re-enter plan
      // mode. ProjectDetail listens for `maestro:plan-mode-changed` and calls
      // setPlanMode(false) on receipt.
      if (approved) {
        try { localStorage.setItem('maestro.chat.plan', '0'); } catch { /* storage unavailable */ }
        try { window.dispatchEvent(new CustomEvent('maestro:plan-mode-changed', { detail: { on: false } })); } catch { /* environment without CustomEvent */ }
        // Codex's `codex exec` is one-shot — there is no SDK to "continue the
        // same run" after permissionMode lifts, the way Claude's SDK can. So
        // for Codex we dispatch an additional event with the plan body and
        // session id; ProjectDetail listens and AUTO-SENDS an "execute the
        // plan now" follow-up message (provided the user is still on the same
        // session). Claude doesn't need this — its SDK already kept the run
        // open through the allow decision and the agent starts executing
        // immediately inside the same query() loop.
        if (req.engine === 'codex') {
          // Defer to the next paint frame so the `maestro:plan-mode-changed`
          // dispatched above has time to flush through React state. That way
          // the listener's sendText closure already reflects planMode=false
          // and the follow-up message goes out with `plan: false` (instead
          // of looping right back into a plan-only run).
          const detail = { sessionId: req.sessionId, plan: req.plan };
          try {
            requestAnimationFrame(() => {
              try { window.dispatchEvent(new CustomEvent('maestro:plan-approved-codex', { detail })); } catch { /* env without CustomEvent */ }
            });
          } catch { /* env without rAF (jsdom) */ }
        }
      }
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send the decision.');
      setBusy(false);
    }
  }

  if (!state) return null;
  const { req } = state;
  const planBody = req.plan?.trim() || '(The agent didn\'t supply a plan body. Approve to let it proceed, or keep planning.)';

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="plan-exit-title"
      style={overlayStyle}
      onClick={(e) => { if (e.target === e.currentTarget) void respond(false); }}>
      <div style={cardStyle}>
        <div id="plan-exit-title" style={{ font: '700 var(--fs-headline)/1.2 var(--font-display)', color: 'var(--ink)' }}>
          Plan ready — approve to execute?
        </div>
        <div style={{ color: 'var(--ink-secondary)' }}>
          The agent is in plan mode and has proposed the plan below. Approve to
          let it execute; Keep planning to push back with notes (the agent will
          refine the plan and call this dialog again).
        </div>
        <div style={{
          background: 'var(--fill-tertiary)',
          borderRadius: 10,
          padding: 14,
          maxHeight: '46vh',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          font: '500 var(--fs-footnote)/1.5 var(--font-mono)',
          color: 'var(--ink)',
        }}>
          {planBody}
        </div>
        {err && (
          <div role="alert" style={{ color: 'var(--color-danger)', font: '500 var(--fs-footnote)/1.3 var(--font-text)' }}>
            {err}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
          <button ref={cancelRef} onClick={() => void respond(false)} disabled={busy}
            style={{ ...btnCancel, ...(busy ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
            Keep planning
          </button>
          {/* type="button" so Enter on focus doesn't submit a parent form; the
              click event IS the gate. */}
          <button type="button" onClick={() => void respond(true)} disabled={busy}
            style={busy ? { ...btnConfirm, opacity: 0.5, cursor: 'not-allowed' } : btnConfirm}>
            {busy ? <Spinner /> : 'Approve plan'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span aria-label="working" style={{
      display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#FFFFFF',
      animation: 'plan-exit-spin 0.7s linear infinite',
    }}>
      <style>{`@keyframes plan-exit-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
