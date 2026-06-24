/* Renderer-side mirror of electron/plan-mode-gate.ts. The shape crosses the
   IPC boundary as plain JSON via the `plan-mode-exit-request` event; both
   sides have to stay in sync by hand.

   These are USED BY: src/screens/ExitPlanModeDialog.tsx (the modal) and
   src/lib/api.ts (the subscriber + `exitPlanModeRespond` call). */

export interface PlanModeExitRequest {
  /** Stable id for THIS specific ExitPlanMode call. Echoed back to
      `api.exitPlanModeRespond(toolUseID, approved)` so the main process
      resolves the right pending Promise. */
  toolUseID: string;
  /** Markdown plan body the agent passed via `ExitPlanMode({ plan: … })`.
      May be an empty string if the agent didn't supply one — the dialog
      should fall back to "(no plan body)" rather than crash. */
  plan: string;
  /** Chat session this belongs to. Used by the dialog to silently dismiss a
      request that arrived for a session the operator has since switched
      away from. */
  sessionId: string | null;
  /** Job id (turn) running the agent. Logged for diagnosis; the dialog
      doesn't need to read it. */
  jobId: string | null;
}
