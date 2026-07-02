/* Background-command guard. Pure so it unit-tests freely.

   THE BUG THIS EXISTS FOR: a coding agent constantly wants to start dev servers
   and watchers. If it runs them through the SDK's built-in `Bash` tool they get
   bound to the CHAT TURN, not the session:

     • foreground (`pnpm dev`) — the Bash tool blocks until the 2-min tool timeout,
       so the turn sits on "Responding…" forever and the dev server is KILLED when
       the run is cancelled / steered / times out.
     • `Bash` with its own `run_in_background: true`, or a shell-backgrounded
       command (`pnpm dev &`, `nohup …`) — the process is a CHILD of the per-turn
       `claude` subprocess, so cancelling the turn (or the next message) kills it.

   Either way "the local run stops working when I stop the turn." The fix is to
   force those onto Maestro's own `run_in_background` MCP tool, whose process is
   spawned in the MAIN process, detached into its own group, and OUTLIVES the turn
   (LocalEngine.bgStart). This module is the classifier a PreToolUse hook uses to
   decide when a `Bash` call must be redirected. It errs toward NOT redirecting:
   only well-known long-lived server/watcher shapes (or explicit backgrounding)
   trip it, so quick commands (install / build / test / git / file ops) run
   normally in the foreground. */

/** Well-known long-lived commands: dev/preview servers, watchers, app runners.
    Word-boundaried so they don't fire on unrelated substrings (a file called
    `dev.ts`, `--preview-flag`, etc.). Kept deliberately specific — a false
    positive only costs the agent a redirect to run_in_background, but we still
    avoid annoying it on genuinely short commands. */
const LONG_LIVED_PATTERNS: RegExp[] = [
  // JS/TS package-manager scripts that conventionally never return.
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/i,
  // Framework CLIs in their long-lived sub-command.
  /\b(?:next|nuxt|remix|astro|gatsby|vite|ng|expo|react-native|storybook|docusaurus)\s+(?:dev|start|serve|preview)\b/i,
  /\bvite\b(?!\s+build)/i, // bare `vite` / `vite --host` is a dev server; `vite build` is not
  /\bexpo\s+(?:start|run)\b/i,
  /\bwebpack(?:-dev-server)?\s+serve\b/i,
  /\bwebpack-dev-server\b/i,
  /\b(?:http-server|live-server|serve|browser-sync|json-server)\b/i,
  // File watchers / process supervisors.
  /\bnodemon\b/i,
  /\bts-node-dev\b/i,
  /\btsx\s+watch\b/i,
  /\bnode\s+--watch\b/i,
  /\b(?:watchexec|chokidar|onchange|watchman)\b/i,
  /\btail\s+-[a-zA-Z]*f\b/i, // tail -f / tail -F / tail -fn
  /--watch\b/i, // tsc --watch, jest --watch, vitest --watch, cargo watch, etc.
  // Python / Ruby / PHP / Go web servers.
  /\b(?:uvicorn|gunicorn|hypercorn|daphne|waitress-serve)\b/i,
  /\bflask\s+run\b/i,
  /\bmanage\.py\s+runserver\b/i,
  /\bpython[0-9.]*\s+-m\s+http\.server\b/i,
  /\brails\s+(?:s|server)\b/i,
  /\bphp\s+artisan\s+serve\b/i,
  /\bphp\s+-S\b/i,
  /\bair\b/i, // cosmtrek/air — Go live reload
  // Docker Compose foreground stacks (no `-d`/`--detach` → attaches & blocks).
  /\bdocker(?:-compose|\s+compose)\s+up\b(?![^\n]*\s(?:-d|--detach)\b)/i,
];

export interface BgGuardVerdict {
  /** True when this Bash call must be redirected to run_in_background. */
  redirect: boolean;
  /** Which rule tripped — 'sdk-background' (Bash's own run_in_background flag),
      'shell-background' (trailing `&` / nohup / disown / setsid), or
      'long-lived' (a known server/watcher command). Undefined when redirect=false. */
  rule?: 'sdk-background' | 'shell-background' | 'long-lived';
}

/** Strip the parts of a command line that legitimately contain `&` but are NOT
    job-control backgrounding: `&&` logical-and and `>&` / `&>` / `2>&1`
    redirections. What remains lets us spot a lone `&` (job backgrounding). */
function stripNonBackgroundAmpersands(cmd: string): string {
  return cmd
    .replace(/\d*>&\d*/g, ' ') // 2>&1, >&2, >&
    .replace(/&>>?/g, ' ') // &> and &>>
    .replace(/&&/g, ' '); // logical AND
}

/** Explicit shell backgrounding: a lone `&` (job control) or nohup/disown/setsid.
    These detach the process from the turn's foreground but keep it a CHILD of the
    claude subprocess, so it still dies when the turn is cancelled. */
function hasShellBackgrounding(cmd: string): boolean {
  if (/\b(?:nohup|disown|setsid)\b/i.test(cmd)) return true;
  const c = stripNonBackgroundAmpersands(cmd);
  // A `&` that ends the command or separates it from a following command.
  return /&\s*$/.test(c) || /(^|\s)&(\s|;)/.test(c);
}

function isLongLived(cmd: string): boolean {
  return LONG_LIVED_PATTERNS.some((re) => re.test(cmd));
}

/** Decide whether a `Bash` tool call should be redirected to run_in_background.
    `runInBackground` is the SDK Bash tool's own `run_in_background` flag — always
    redirect it, because that background shell is a child of the per-turn
    subprocess (dies on cancel), unlike Maestro's main-process bg tasks. */
export function classifyBashCommand(command: string, runInBackground?: boolean): BgGuardVerdict {
  if (runInBackground) return { redirect: true, rule: 'sdk-background' };
  const cmd = (command ?? '').trim();
  if (!cmd) return { redirect: false };
  if (hasShellBackgrounding(cmd)) return { redirect: true, rule: 'shell-background' };
  if (isLongLived(cmd)) return { redirect: true, rule: 'long-lived' };
  return { redirect: false };
}

/** The message the model sees when a Bash call is blocked — tells it exactly which
    tool to use instead and why, so it re-issues via run_in_background rather than
    fighting the denial. */
export function bgRedirectReason(command: string, rule: BgGuardVerdict['rule']): string {
  const why =
    rule === 'sdk-background'
      ? "Bash's own run_in_background makes the process a child of this turn's engine subprocess"
      : rule === 'shell-background'
        ? 'a shell-backgrounded command (`&` / nohup / disown) stays a child of this turn'
        : 'a dev server / watcher runs forever';
  const short = command.length > 120 ? command.slice(0, 117) + '…' : command;
  return (
    `Blocked \`${short}\`: ${why}, so it BLOCKS this chat turn and is KILLED the moment the run is ` +
    `cancelled, steered, or times out — "stop the turn and the local run dies." ` +
    `Start long-lived processes with the run_in_background tool instead ` +
    `(mcp__maestro__run_in_background — args: command, cwd). It runs in the app's main process, ` +
    `outlives the turn, survives cancel/steer, and the user can stop it from the Background tasks ` +
    `panel. Then call background_output to confirm it came up (and grab the URL). ` +
    `For a command that finishes on its own (install / build / test / git / file ops), just remove ` +
    `the trailing \`&\` and run it in the foreground.`
  );
}
