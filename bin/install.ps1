# Convenience installer for git-clone users on Windows (contributors who
# fork the repo and want the local checkout registered with their CLIs).
#
# End users: prefer the npm one-liner instead, no clone needed:
#   npx -y sessions-dashboard install
#
# This shim does two things:
#   1. npm install   -- pulls deps + downloads Playwright Chromium on first run.
#   2. node bin\sessions-dashboard.mjs install --local
#                    -- runs the JS installer in --local mode, which registers
#                       a 'node <local-path>' invocation against this working
#                       tree (instead of the npm-pinned form), so contributors
#                       exercise their checkout, not the published package.
$ErrorActionPreference = "Stop"

$here = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host "[1/2] npm install"
Write-Host "      First run downloads Chromium via Playwright (~150 MB) -- this can take 30-60s."
Push-Location $here
try { npm install } finally { Pop-Location }

Write-Host ""
Write-Host "[2/2] running installer (registers MCP with detected CLIs)"
node (Join-Path $here "bin\sessions-dashboard.mjs") install --local
