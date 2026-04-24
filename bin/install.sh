#!/usr/bin/env bash
# Convenience installer for git-clone users (contributors who fork the
# repo and want the local checkout registered with their CLIs).
#
# End users: prefer the npm one-liner instead, no clone needed:
#   npx -y sessions-dashboard install
#
# This shim does two things:
#   1. npm install   — pulls deps + downloads Playwright Chromium on first run.
#   2. node bin/sessions-dashboard.mjs install --local
#                    — runs the JS installer in --local mode, which registers
#                      a `node <local-path>` invocation against this working
#                      tree (instead of the npm-pinned form), so contributors
#                      exercise their checkout, not the published package.
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
# On Git Bash / Cygwin on Windows, `pwd` returns a POSIX path like
# /c/Users/name/... — node.exe can be finicky with those downstream. If
# cygpath is available, convert to a native path with forward slashes
# (C:/Users/name/...), which node.exe resolves reliably.
if command -v cygpath >/dev/null 2>&1; then
  here="$(cygpath -m "$here")"
fi

echo "[1/2] npm install"
echo "      First run downloads Chromium via Playwright (~150 MB) -- this can take 30-60s."
(cd "$here" && npm install)

echo ""
echo "[2/2] running installer (registers MCP with detected CLIs)"
node "$here/bin/sessions-dashboard.mjs" install --local
