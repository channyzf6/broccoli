#!/usr/bin/env bash
# One-shot installer for the sessions-dashboard MCP extension.
# Installs deps, registers with Claude Code using the absolute path of this
# clone, and prints a verify step.
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
# On Git Bash / Cygwin on Windows, `pwd` returns a POSIX path like
# /c/Users/name/... — node.exe can be finicky with those downstream. If
# cygpath is available, convert to a native path with forward slashes
# (C:/Users/name/...), which node.exe resolves reliably.
if command -v cygpath >/dev/null 2>&1; then
  here="$(cygpath -m "$here")"
fi
index="$here/index.mjs"

echo "[1/3] npm install"
echo "      First run downloads Chromium via Playwright (~150 MB) — this can take 30-60s."
(cd "$here" && npm install)

echo ""
echo "[2/3] registering sessions-dashboard with Claude Code"
if ! command -v claude >/dev/null 2>&1; then
  echo "  'claude' CLI not on PATH."
  echo "  Run this yourself after installing Claude Code:"
  echo ""
  echo "    claude mcp add sessions-dashboard --scope user -- node \"$index\""
  echo ""
  exit 1
fi
# Remove first so re-running the installer (e.g. after moving the clone) is a
# no-op update rather than a hard failure from duplicate registration.
claude mcp remove sessions-dashboard --scope user >/dev/null 2>&1 || true
claude mcp add sessions-dashboard --scope user -- node "$index"

echo ""
echo "[3/3] done. Restart Claude Code, then ask Claude:"
echo ""
echo "    \"Open the sessions dashboard\""
echo ""
echo "  Claude should invoke mcp__sessions-dashboard__open_dashboard and a live"
echo "  browser window should appear showing every connected CC session."
