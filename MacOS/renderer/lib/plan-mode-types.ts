/* Renderer-side mirror of electron/plan-mode-gate.ts. The shape crosses the
   IPC boundary as plain JSON via the `plan-mode-exit-request` event; both
   sides have to stay in sync by hand.

   These are USED BY: src/screens/ExitPlanModeDialog.tsx (the modal) and
   src/lib/api.ts (the subscriber + `exitPlanModeRespond` call). */

export interface PlanModeExitRequest {
  /** Stable id for THIS specific ExitPlanMode request. Echoed back to
      `api.exitPlanModeRespond(toolUseID, approved)` so the main process
      resolves the right pending Promise. */
  toolUseID: string;
  /** Markdown plan body. For Claude this is `input.plan` from the SDK's
      ExitPlanMode call; for Codex it's the agent's final reply text from the
      plan-only turn. May be empty — the dialog renders a fallback. */
  plan: string;
  /** Chat session this belongs to. Used by the dialog to silently dismiss a
      request that arrived for a session the operator has since switched
      away from. */
  sessionId: string | null;
  /** Job id (turn) running the agent. Logged for diagnosis; the dialog
      doesn't need to read it. */
  jobId: string | null;
  /** Which engine is parked. Drives the dialog's approve-action: Claude's
      SDK continues the same run on allow; Codex's `codex exec` is one-shot,
      so the renderer auto-sends an "execute the plan now" follow-up message
      on approve to make the approval take effect. */
  engine: 'claude' | 'codex';
}
