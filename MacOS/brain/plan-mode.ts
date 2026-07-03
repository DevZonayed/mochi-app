// Plan mode — NO popup. The operator explicitly does not want the SDK's
// ExitPlanMode approval dialog. Instead the agent writes its plan to a Markdown
// file under `.maestro/plans/`, replies with the path, and asks for approval in
// chat. runClaude wires `planPermission` into the Agent SDK's canUseTool so it
// allows writing ONLY that plan file (everything else stays read-only) and denies
// ExitPlanMode with a nudge back to this flow.
import path from 'node:path';

/** Repo-relative directory where plan-mode Markdown plans are written. */
export const PLAN_DIR = path.join('.maestro', 'plans');

export const PLAN_DIRECTIVE =
  `\n\n---\n\n[Plan mode] You are PLANNING, not building. Do NOT modify project files, run ` +
  `builds, or deploy. Read and search the codebase as needed, then WRITE your implementation ` +
  `plan as a Markdown file at \`${PLAN_DIR}/plan-<short-slug>.md\` (create the folder if needed). ` +
  `Cover the goal, the files you'll touch, the step-by-step changes, and the risks. When the ` +
  `plan file is written, reply with its exact path and a 2–3 line summary, then ASK the operator ` +
  `to review and approve. Do NOT call the ExitPlanMode tool and do NOT expect a popup — approval ` +
  `happens right here in chat: the operator reviews the file, turns off Plan mode, and replies to ` +
  `let you execute.`;

/** True when a write target is the agent's plan Markdown under `.maestro/plans/`.
 *  Accepts both absolute paths inside `cwd` and repo-relative paths so the gate
 *  is robust to however the tool passes the path. */
export function isPlanFile(cwd: string, filePath: string): boolean {
  if (!filePath) return false;
  const planRoot = path.resolve(cwd, PLAN_DIR);
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
  const rel = path.relative(planRoot, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export type PlanDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Pure plan-mode permission decision for the Agent SDK's canUseTool.
 *  - ExitPlanMode → deny (no popup; approval happens in chat).
 *  - a write to the plan Markdown → allow.
 *  - any other write → deny (read-only).
 *  - anything else that reaches this gate → deny (read tools never reach
 *    canUseTool in plan mode, so a non-read tool here is a mutation attempt). */
/** File name for a materialized plan, slugged from a seed (jobId) or the clock.
 *  Codex runs sandboxed read-only in plan mode, so the HOST writes the plan
 *  file on its behalf after the run — this names that file deterministically. */
export function planFileName(seed?: string): string {
  const raw = (seed && seed.trim()) || Date.now().toString(36);
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
  return `plan-${slug}.md`;
}

/** Chat note appended after the host saves a Codex plan to disk. Mirrors the
 *  Claude-side flow (plan file + in-chat approval, never a popup). */
export function planSavedNote(relPath: string): string {
  return (
    `\n\n---\n\nPlan saved to \`${relPath}\`. Review it, then approve here in chat: ` +
    `turn off Plan mode and reply (e.g. "approved — execute the plan") to let the agent build it. ` +
    `No popup will appear — this message is the approval request.`
  );
}

export function planPermission(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
): PlanDecision {
  if (toolName === 'ExitPlanMode') {
    return {
      behavior: 'deny',
      message:
        `Don't call ExitPlanMode. Write your plan to a Markdown file under ${PLAN_DIR}/, ` +
        `reply with its path, and ask the operator to review and approve before executing.`,
    };
  }
  const target = String((input?.file_path ?? input?.path ?? input?.notebook_path ?? '') as string);
  if (WRITE_TOOLS.has(toolName)) {
    if (isPlanFile(cwd, target)) return { behavior: 'allow' };
    return {
      behavior: 'deny',
      message: `Plan mode is read-only. The only file you may write is your plan Markdown under ${PLAN_DIR}/.`,
    };
  }
  return {
    behavior: 'deny',
    message: 'Plan mode is read-only — research and write your plan file; do not modify the project.',
  };
}
