#!/usr/bin/env bash
# One-shot installer for the sessions-dashboard MCP extension.
# Detects which supported CLIs are on PATH (Claude Code, Gemini CLI,
# Codex CLI) and registers sessions-dashboard with each one found.
# Errors only if zero supported CLIs are present.
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
echo "[2/3] registering sessions-dashboard with detected CLIs"
registered=0
for cli in claude gemini codex; do
  if ! command -v "$cli" >/dev/null 2>&1; then
    continue
  fi
  echo "  - $cli detected"
  # CLI-specific flag handling. Claude and Gemini take `--scope user` to
  # mean "register globally for this user, not per-project." Codex doesn't
  # accept that flag — its mcp add is global by default. Trying to pass
  # --scope to Codex errors out with "unexpected argument '--scope'."
  #
  # env_args: pin the host explicitly for non-Claude CLIs. Without this,
  # the proxy's cold-start dir-probe can misroute the session to
  # ClaudeAdapter when Claude has any prior transcript in the same cwd
  # — Codex hasn't yet flushed session_meta when detection runs, and
  # Gemini's chat file isn't created until the first user message, so
  # both lose the most-recent-mtime tie-break to a freshly-touched
  # Claude jsonl. The result is a silently-inert activity pill and
  # wrong host label. Pinning skips the race entirely. Claude doesn't
  # need pinning since it's the default fallback.
  case "$cli" in
    claude) scope_args=(--scope user); env_args=() ;;
    gemini) scope_args=(--scope user); env_args=(--env "SESSIONS_DASHBOARD_HOST=gemini") ;;
    codex)  scope_args=();              env_args=(--env "SESSIONS_DASHBOARD_HOST=codex") ;;
  esac
  # Idempotent: remove any prior registration so re-running the installer
  # is a no-op update rather than a duplicate-registration failure.
  #
  # ${arr[@]+"${arr[@]}"} guard: Bash 3.2 (still the macOS-stock /bin/bash)
  # errors on "${empty_array[@]}" under `set -u` with "unbound variable".
  # Bash 4.4+ silently expands to nothing. The +-fallback pattern is the
  # portable spelling — expand only if the array variable is set, which
  # an empty array still is in semantics but not in 3.2's accounting.
  "$cli" mcp remove sessions-dashboard ${scope_args[@]+"${scope_args[@]}"} >/dev/null 2>&1 || true
  # Register. Tolerate failure on a single CLI — keep going so a broken
  # Codex install doesn't block Claude/Gemini for the same user.
  if "$cli" mcp add sessions-dashboard ${scope_args[@]+"${scope_args[@]}"} ${env_args[@]+"${env_args[@]}"} -- node "$index"; then
    registered=$((registered + 1))
  else
    echo "    (registration with $cli failed; continuing)"
  fi
done

if [ "$registered" -eq 0 ]; then
  echo ""
  echo "ERROR: no supported CLI found on PATH."
  echo "Install one of: claude, gemini, codex — then re-run this installer."
  echo "Or register manually:"
  echo ""
  echo "  <cli> mcp add sessions-dashboard --scope user -- node \"$index\""
  echo ""
  exit 1
fi

echo ""
echo "[3/3] done — registered with $registered CLI(s)."
echo "Restart your CLI(s), then ask one of them:"
echo ""
echo "    \"Open the sessions dashboard\""
echo ""
echo "  The CLI invokes mcp__sessions-dashboard__open_dashboard and a live"
echo "  browser window appears showing every connected session across all"
echo "  registered CLIs."
