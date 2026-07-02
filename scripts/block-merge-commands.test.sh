#!/usr/bin/env bash
# block-merge-commands.test.sh — exercise the PreToolUse hook with synthetic
# Claude Code stdin payloads. Pure bash so it runs anywhere the hook does;
# no jq, no node, no vitest. Each case asserts the exit code + (for blocks)
# that the JSON deny envelope appears on stdout.
#
# Run: bash scripts/block-merge-commands.test.sh
# Pass: prints "OK" and exits 0. Fail: prints which case + exits 1.

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/block-merge-commands.sh"
if [ ! -x "$HOOK" ]; then
  echo "FAIL: $HOOK is not executable" >&2
  exit 1
fi

fails=0
pass=0

assert_block() {
  local label="$1"; local cmd="$2"
  local payload="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}"
  local out; local rc
  out="$(printf '%s' "$payload" | "$HOOK" 2>/dev/null)"
  rc=$?
  if [ $rc -ne 2 ]; then
    echo "FAIL [$label]: expected exit 2 (blocked), got $rc — cmd: $cmd" >&2
    fails=$((fails+1)); return
  fi
  if ! printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then
    echo "FAIL [$label]: deny JSON missing on stdout — cmd: $cmd" >&2
    fails=$((fails+1)); return
  fi
  pass=$((pass+1))
}

assert_allow() {
  local label="$1"; local cmd="$2"
  local payload="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}}"
  local rc
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "FAIL [$label]: expected exit 0 (allowed), got $rc — cmd: $cmd" >&2
    fails=$((fails+1)); return
  fi
  pass=$((pass+1))
}

# ── Blocked patterns ────────────────────────────────────────────────────────
assert_block "gh pr merge bare"            "gh pr merge"
assert_block "gh pr merge #1"              "gh pr merge 1"
assert_block "gh pr merge --squash"        "gh pr merge --squash 42"
assert_block "gh pr merge --auto"          "gh pr merge --auto --squash 42"
assert_block "gh pr merge after cd"        "cd /tmp && gh pr merge 1"
assert_block "gh pr merge multi-space"     "gh   pr   merge   7"
assert_block "gh pr merge after semicolon" "echo hi; gh pr merge 9"
assert_block "gh api pulls merge PATCH"    "gh api -X PUT repos/foo/bar/pulls/123/merge"
assert_block "gh api pulls merge POST"     "gh api -X POST repos/o/r/pulls/9/merge -f merge_method=squash"
assert_block "gh pr review --approve"      "gh pr review 42 --approve"
assert_block "gh pr edit auto-merge"       "gh pr edit 42 --enable-auto-merge --squash"
assert_block "git push origin master"      "git push origin master"
assert_block "git push origin main"        "git push origin main"
assert_block "git push -u origin master"   "git push -u origin master"
assert_block "git push --force master"     "git push --force origin master"
assert_block "git push --force-with-lease" "git push --force-with-lease origin master"
assert_block "git push HEAD:master"        "git push origin HEAD:master"
assert_block "git push :master delete"     "git push origin :master"

# ── Allowed patterns (the agent must keep doing these) ─────────────────────
assert_allow "git status"                  "git status"
assert_allow "git log"                     "git log --oneline -10"
assert_allow "git diff"                    "git diff origin/master"
assert_allow "git fetch master"            "git fetch origin master"
assert_allow "git push feature branch"     "git push origin fix/strict-merge-gate"
assert_allow "git push -u feature"         "git push -u origin mochi/lyon/fix-foo"
assert_allow "git push --force feature"    "git push --force-with-lease origin fix/strict-merge-gate"
assert_allow "gh pr list"                  "gh pr list"
assert_allow "gh pr view"                  "gh pr view 42"
assert_allow "gh pr create"                "gh pr create --title foo --body bar"
assert_allow "gh api user"                 "gh api user"
assert_allow "gh repo view"                "gh repo view DevZonayed/mochi-app"
assert_allow "ls"                          "ls -la"
assert_allow "echo"                        "echo hello"
assert_allow "rebase onto master"          "git rebase origin/master"

if [ $fails -ne 0 ]; then
  echo "------------------------------------------"
  echo "FAILED: $fails case(s); $pass passed."
  exit 1
fi
echo "OK — $pass cases (all blocked patterns rejected, all benign patterns allowed)."
exit 0
