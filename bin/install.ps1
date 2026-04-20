# One-shot installer for the sessions-dashboard MCP extension (Windows / PowerShell).
# Installs deps, registers with Claude Code using the absolute path of this
# clone, and prints a verify step.
$ErrorActionPreference = "Stop"

$here  = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$index = Join-Path $here "index.mjs"

Write-Host "[1/3] npm install"
Write-Host "      First run downloads Chromium via Playwright (~150 MB) - this can take 30-60s."
Push-Location $here
try { npm install } finally { Pop-Location }

Write-Host ""
Write-Host "[2/3] registering sessions-dashboard with Claude Code"
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Host "  'claude' CLI not on PATH."
    Write-Host "  Run this yourself after installing Claude Code:"
    Write-Host ""
    Write-Host "    claude mcp add sessions-dashboard --scope user -- node `"$index`""
    Write-Host ""
    exit 1
}
# Remove first so re-running the installer (e.g. after moving the clone) is a
# no-op update rather than a hard failure from duplicate registration.
& claude mcp remove sessions-dashboard --scope user 2>$null | Out-Null
claude mcp add sessions-dashboard --scope user -- node "$index"

Write-Host ""
Write-Host "[3/3] done. Restart Claude Code, then ask Claude:"
Write-Host ""
Write-Host '    "Open the sessions dashboard"'
Write-Host ""
Write-Host "  Claude should invoke mcp__sessions-dashboard__open_dashboard and a live"
Write-Host "  browser window should appear showing every connected CC session."
