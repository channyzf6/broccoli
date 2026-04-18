#!/usr/bin/env bash
# One-shot installer for the web-view MCP extension.
# Installs deps, registers with Claude Code using the absolute path of this
# clone, and prints a verify step.
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
index="$here/index.mjs"

echo "[1/3] npm install"
echo "      First run downloads Chromium via Playwright (~150 MB) — this can take 30-60s."
(cd "$here" && npm install)

echo ""
echo "[2/3] registering web-view with Claude Code"
if ! command -v claude >/dev/null 2>&1; then
  echo "  'claude' CLI not on PATH."
  echo "  Run this yourself after installing Claude Code:"
  echo ""
  echo "    claude mcp add web-view --scope user -- node \"$index\""
  echo ""
  exit 1
fi
claude mcp add web-view --scope user -- node "$index"

echo ""
echo "[3/3] done. Restart Claude Code, then ask Claude:"
echo ""
echo "    \"What's the status of the web-view daemon?\""
echo ""
echo "  Claude should invoke mcp__web-view__daemon_info and report a fresh pid."
