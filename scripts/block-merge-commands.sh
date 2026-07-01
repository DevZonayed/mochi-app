#!/usr/bin/env bash
# block-merge-commands.sh — Claude Code PreToolUse hook on Bash.
#
# WHY THIS EXISTS
# PR #63 gated `pr_merge` / `pr_resolve_conflicts` behind a human click in the
# GitOpsDock + PrActionConfirmDialog. An agent then bypassed all of it by
# calling `gh pr merge` from a raw Bash tool — squash-merging 11 PRs without
# a single human confirmation.
#
# This hook is the OUTERMOST layer of defense. It runs BEFORE the Bash tool
# executes anything, reads the `tool_input.command` field off stdin, and
# DENIES every shape the agent can use to land a merge or move master:
#
#   1. gh pr merge …
#   2. gh api repos/.../pulls/.../merge   (raw GitHub REST merge)
#   3. gh pr review --approve …           (auto-merge enablers)
#   4. gh pr edit … --enable-auto-merge
#   5. git push … origin master           (any "push to master" shape)
#   6. git push … --force … master        (forced overwrite of master)
#   7. git push … origin main             (if a repo ever uses `main`)
#
# An agent path is ANY non-renderer caller. The renderer-side merge button
# never shells out — it goes via the IPC `mergeSessionPR` handler in
# `MacOS/brain/localApi.ts`, which calls `gitService.mergePr`
# directly. So if a merge command lands here at all, it's the agent.
#
# CONTRACT WITH CLAUDE CODE
# The hook is invoked as a `PreToolUse` hook with `matcher: "Bash"`. It
# receives `{ tool_name, tool_input: { command } }` on stdin. To block, it
# emits JSON on stdout describing the denial — Claude Code reads
# `hookSpecificOutput.permissionDecision` and refuses to run the command,
# surfacing `permissionDecisionReason` to the agent.
#
# Exit code 2 ALSO blocks the call (older Claude Code versions), so we do
# both: emit the JSON for the new path AND exit 2 for the old path.
#
# TESTING
# `scripts/block-merge-commands.test.sh` pipes synthetic stdin payloads and
# asserts that each blocked pattern triggers the deny path, and that
# benign commands (git status, git log, git push origin <feature-branch>)
# pass through.

set -u

# Read the full hook payload (one JSON blob on stdin).
PAYLOAD="$(cat || true)"

# Extract `tool_input.command`. We use `jq` when available (Claude Code ships
# it in its sandbox), with a fallback grep so the hook is robust on a bare
# shell. The grep path is intentionally narrow — it only needs to handle the
# one-line `"command": "..."` shape Claude Code emits.
extract_command() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty'
  else
    # Best-effort: pull the first "command":"..." string. Good enough as a
    # fallback because Claude Code's payloads are machine-emitted JSON
    # without nested escapes inside `command`.
    printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(\([^"\\]\|\\.\)*\)".*/\1/p' | head -n 1
  fi
}

CMD="$(extract_command)"

# Nothing to inspect = nothing to block. Let it through (the actual Bash
# handler will reject malformed input on its own).
if [ -z "$CMD" ]; then
  exit 0
fi

# Canonicalize for matching: collapse runs of whitespace to single spaces so
# `gh   pr   merge` is the same as `gh pr merge`. Lowercase isn't safe (paths
# are case-sensitive on Linux) — we match the literal subcommand verbs only.
NORM="$(printf '%s' "$CMD" | tr -s '[:space:]' ' ')"

# THE REGEX — extended-regex, anchored against word boundaries so we don't
# false-positive on a script named e.g. `mygh-pr-merge-summary`. The matchers
# cover:
#   • `gh pr merge`              → standard merge
#   • `gh api .../pulls/.../merge` (PATCH/PUT/POST) → raw REST merge
#   • `gh pr review --approve`   → can flip on auto-merge in some workflows
#   • `gh pr edit --enable-auto-merge` (and `gh pr merge --auto`)
#   • `git push <args> origin (master|main)` and `:master` / `:main` deletions
#   • `git push --force* origin (master|main)`
#   • `git push <args> origin HEAD:master` / `HEAD:main`
#
# Anything missed here is caught by the CLAUDE.md policy + the agent-side
# tripwire in `git-ctx.ts` (defense in depth, Layer C).
BLOCKED_RE='(^|[[:space:];&|])(gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)|gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+.*--auto|gh[[:space:]]+pr[[:space:]]+edit[[:space:]]+.*--enable-auto-merge|gh[[:space:]]+pr[[:space:]]+review[[:space:]]+.*--approve|gh[[:space:]]+api[[:space:]]+.*pulls/[^[:space:]]+/merge|git[[:space:]]+push([[:space:]]+[^[:space:]]+)*[[:space:]]+(origin[[:space:]]+(master|main)([[:space:]]|$|:)|.*:(master|main)([[:space:]]|$))|git[[:space:]]+push[[:space:]]+.*--force([^[:space:]]*)([[:space:]]+[^[:space:]]+)*[[:space:]]+(origin[[:space:]]+(master|main)|.*:(master|main)))'

if printf '%s' "$NORM" | grep -Eq "$BLOCKED_RE"; then
  REASON="Merging and writing to master/main is HUMAN-GATED by design (PR #63's PrActionConfirmDialog + GitOpsDock). Agents must never call \`gh pr merge\`, \`gh api .../pulls/.../merge\`, or \`git push origin master\`. To land a PR, ask the operator to click the Merge button in the GitOpsDock — the renderer drives \`mergeSessionPR\` IPC directly. Blocked command: $CMD"

  # New Claude Code (>=1.0.x): JSON on stdout with hookSpecificOutput.permissionDecision.
  # We escape the reason for JSON embedding (double-quotes + backslashes + newlines).
  ESC_REASON="$(printf '%s' "$REASON" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')"
  cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"$ESC_REASON"},"continue":false,"stopReason":"$ESC_REASON","systemMessage":"Blocked agent-side merge — see PR #63's human-confirm gate."}
JSON

  # Old Claude Code: non-zero exit also blocks. 2 = blocking error per the
  # hook protocol (stderr is surfaced to the model).
  echo "$REASON" >&2
  exit 2
fi

# Default: allow through.
exit 0
