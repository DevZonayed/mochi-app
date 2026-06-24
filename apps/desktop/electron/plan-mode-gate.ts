/* plan-mode-gate — the Mac-local host side of the Claude Agent SDK's plan mode.

   THE BUG THIS EXISTS TO FIX
   When the renderer turns on Plan mode, runClaude passes `permissionMode: 'plan'`
   to the SDK. The SDK now blocks every write/exec tool and, when the agent is done
   planning, calls the host's `canUseTool` with `toolName === 'ExitPlanMode'`. The
   host is expected to (a) show a UI to the operator, (b) wait for an approve /
   keep-planning decision, and (c) return `{ behavior: 'allow' }` or
   `{ behavior: 'deny', … }`. Without a `canUseTool` handler the SDK leaves the
   call unresolved → the agent stays trapped in plan mode FOREVER and every Bash /
   Edit it tries is denied. That's the exact dead-end the SecureWire transcript
   hit ("there is no approve card, what is it?").

   THE FIX (this module)
   A tiny Promise-based gate keyed by the SDK's `toolUseID`:

     1. engine.ts → `requestExit(req)` returns a Promise the canUseTool callback
        awaits + emits a `plan-mode-exit-request` event so the renderer can show a
        modal (mirroring `PrActionConfirmDialog`).
     2. ExitPlanModeDialog (renderer) shows the plan body + Approve / Keep Planning.
     3. The renderer calls `exitPlanModeRespond(toolUseID, approved)` over IPC.
     4. localApi.ts → `respondExit(toolUseID, approved)` resolves the Promise.

   We also keep BG_RUN_IN_BACKGROUND_DENY here — it's the second bug the same
   `canUseTool` callback handles. Background dev servers started via the BUILT-IN
   Bash with `run_in_background: true` live as children of the Claude Code CLI
   subprocess; when the operator force-sends, `engine.cancel(jobId)` SIGTERMs the
   CLI and takes the dev server down with it. Maestro's own
   `mcp__maestro__run_in_background` spawns detached children off the ELECTRON
   process tree, so they survive a turn cancel. We deny the built-in variant with
   an `interrupt: false` retry-hint so the agent re-issues against the Maestro
   tool — same intent, but the child outlives the steer. */

export interface PlanModeExitRequest {
  /** Stable id for this specific request. For Claude it's the SDK's toolUseID;
      for Codex (which has no native ExitPlanMode protocol) we synthesise one
      from the jobId so the gate's routing stays uniform across engines. */
  toolUseID: string;
  /** Plan body (markdown). For Claude this is `input.plan` from the SDK's
      ExitPlanMode call; for Codex this is the agent's final reply text from
      the plan-only turn (read-only sandbox + plan directive). May be empty —
      the dialog renders a fallback in that case. */
  plan: string;
  /** The chat session this run belongs to — lets the renderer ignore stale
      requests if the operator already switched sessions. */
  sessionId: string | null;
  /** The job id (turn) running this agent — useful for logging. */
  jobId: string | null;
  /** Which engine is parked on the gate. Determines what happens on approve:
      Claude's SDK continues the same `query()` run when canUseTool returns
      allow, but Codex's `codex exec` is one-shot — its plan-mode run ENDS
      after producing the plan, so the renderer auto-queues an "execute now"
      follow-up message to make the approval take effect. The two-step shape
      is intrinsic to the engine difference, not a UX choice. */
  engine: 'claude' | 'codex';
}

interface Pending {
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
  /** Wall-clock when the request was registered, for timeout / staleness checks. */
  openedAt: number;
}

/** In-memory map of unresolved ExitPlanMode requests, keyed by toolUseID.
    Cleared when the operator answers, when the SDK aborts (signal), or when the
    surrounding `query()` iterator throws. Survives renderer reloads (the renderer
    re-subscribes to the IPC stream and re-renders the dialog for any pending
    request it sees). */
const pending = new Map<string, Pending>();

export interface PlanModeGate {
  /** Open a gate, returning a Promise that resolves with the operator's
      approve/deny decision. Cancelled (`rejected`) if the abort signal fires —
      e.g. the SDK's run-level AbortController, or the operator's force-send
      which calls `engine.cancel(jobId)`. */
  requestExit(req: PlanModeExitRequest, opts?: { signal?: AbortSignal }): Promise<boolean>;
  /** Resolve the pending request from the renderer's button click. No-op if the
      id is unknown (already answered, or stale from a previous run). Returns
      true on a real resolve, false if there was nothing pending. */
  respondExit(toolUseID: string, approved: boolean): boolean;
  /** How many requests are currently waiting on the operator. Exposed for tests. */
  pendingCount(): number;
  /** Cancel all in-flight requests with the given error. Used on app quit. */
  cancelAll(reason?: string): void;
}

/** Construct a fresh gate. Production wires this once in main.ts so the engine
 *  and IPC handler share the same Map. Tests can spin up isolated instances. */
export function createPlanModeGate(): PlanModeGate {
  return {
    requestExit(req, opts) {
      const signal = opts?.signal;
      if (signal?.aborted) return Promise.reject(new Error('cancelled before request'));
      return new Promise<boolean>((resolve, reject) => {
        pending.set(req.toolUseID, { resolve, reject, openedAt: Date.now() });
        if (signal) {
          const onAbort = () => {
            const p = pending.get(req.toolUseID);
            if (p) { pending.delete(req.toolUseID); p.reject(new Error('cancelled')); }
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    },
    respondExit(toolUseID, approved) {
      const p = pending.get(toolUseID);
      if (!p) return false;
      pending.delete(toolUseID);
      p.resolve(approved);
      return true;
    },
    pendingCount() { return pending.size; },
    cancelAll(reason = 'cancelled') {
      // Clone keys first — resolving inside the iteration would mutate the Map.
      const ids = [...pending.keys()];
      for (const id of ids) {
        const p = pending.get(id);
        if (!p) continue;
        pending.delete(id);
        p.reject(new Error(reason));
      }
    },
  };
}

/** Stable retry-hint surfaced to the agent when it calls the BUILT-IN Bash tool
 *  with `run_in_background: true`. The Maestro MCP variant spawns detached, so
 *  the dev server it starts survives a turn cancel — which the user has now
 *  asked for explicitly. The message is short + actionable: the agent re-issues
 *  the same intent against the right tool without burning extra reasoning. */
export const BG_RUN_IN_BACKGROUND_DENY =
  'Use mcp__maestro__run_in_background instead. The built-in Bash run_in_background option ' +
  'lives as a child of the Claude Code CLI subprocess and gets killed when the user steers / ' +
  'force-sends (which is why this turn would lose your dev server). The Maestro tool is ' +
  'detached at the Electron process level and persists across turns — re-call with the same ' +
  'command via mcp__maestro__run_in_background.';
