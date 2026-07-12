#!/usr/bin/env bash
# Deterministic SOURCE provenance for a build — for promotion safety.
#
# Emits (KEY=VALUE per line):
#   SOURCE_REV          the HEAD commit sha (or 'no-head')
#   SOURCE_FINGERPRINT  a sha256 that CHANGES on any tracked OR untracked content
#                       change, a deletion, an exec-bit change, or a symlink-target
#                       change, and is DETERMINISTIC / STABLE for an unchanged tree
#   SOURCE_STATUS       clean | dirty  (clean iff `git status --porcelain` is empty)
#
# The heavy lifting is a content-addressed manifest in source-manifest.mjs (a
# version marker + HEAD + a NUL-safe byte-sorted set of every tracked and
# untracked-not-ignored path with its working-tree kind, exec bit, and SHA-256
# content or symlink target). That replaces the old textual `git diff HEAD`
# aggregate, which disagreed between package-time and later runs and ignored the
# exec bit / symlink target of untracked files.
#
# Security: NEVER prints source lines, paths, or secret bytes — only the three
# fields above. Fails closed (nonzero) if the manifest cannot be computed.
# Bash 3.2 compatible (thin wrapper; no logic in the shell).
set -euo pipefail

repo="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
here="$(cd "$(dirname "$0")" && pwd)"

exec node "$here/source-manifest.mjs" "$repo"
