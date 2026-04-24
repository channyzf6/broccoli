# Install — full reference

The README's [Install](../README.md#install) section covers the recommended one-line install. This doc covers everything else: installing from source for contributors, per-CLI manual config for users who'd rather hand-edit, and platform-specific caveats.

---

## Install from source (contributors)

If you're forking the repo and want your local checkout registered with your CLIs (instead of the published npm version):

**macOS / Linux**
```bash
git clone https://github.com/channyzf6/sessions-dashboard
cd sessions-dashboard
bash bin/install.sh
```

**Windows PowerShell**
```powershell
git clone https://github.com/channyzf6/sessions-dashboard
cd sessions-dashboard
powershell -ExecutionPolicy Bypass -File bin\install.ps1
```

**Windows cmd.exe** (hands off to PowerShell internally)
```cmd
git clone https://github.com/channyzf6/sessions-dashboard
cd sessions-dashboard
bin\install.bat
```

These shims do `npm install` (downloads Chromium) and then run `node bin/sessions-dashboard.mjs install --local`, which registers a `node <local-path>` invocation against your working tree rather than `npx -y sessions-dashboard@<version>`.

---

## Per-CLI manual install

Skip this section if you used the `npx -y sessions-dashboard install` one-liner — it auto-handles all three CLIs. This is for users hand-editing their CLI config files.

All three CLIs register against the same daemon and show up side-by-side on the dashboard. The host is surfaced via the card's tooltip ("Claude Code" / "Gemini CLI" / "Codex CLI") rather than a visible glyph. Pin `SESSIONS_DASHBOARD_HOST` in each registration's env to make host detection deterministic — without it a cold-start dir-probe race can mis-route mixed-host sessions.

### Claude Code

```bash
claude mcp add sessions-dashboard --scope user --env SESSIONS_DASHBOARD_HOST=claude -- npx -y sessions-dashboard
```

Or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "sessions-dashboard": {
      "command": "npx",
      "args": ["-y", "sessions-dashboard"],
      "env": { "SESSIONS_DASHBOARD_HOST": "claude" }
    }
  }
}
```

### Gemini CLI

```bash
gemini mcp add --scope user sessions-dashboard --env SESSIONS_DASHBOARD_HOST=gemini -- npx -y sessions-dashboard
```

Or `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "sessions-dashboard": {
      "command": "npx",
      "args": ["-y", "sessions-dashboard"],
      "env": {
        "SESSIONS_DASHBOARD_AUTOSTART": "1",
        "SESSIONS_DASHBOARD_HOST": "gemini"
      }
    }
  }
}
```

Gemini CLI has no `/rename` slash command — name a session via `SESSIONS_DASHBOARD_SESSION_NAME` in the env block or by calling `set_session_name` from inside the session.

### Codex CLI

```bash
codex mcp add sessions-dashboard --env SESSIONS_DASHBOARD_HOST=codex -- npx -y sessions-dashboard
```

Codex's `mcp add` is global by default and doesn't accept `--scope`.

Or `~/.codex/config.toml`:

```toml
[mcp_servers.sessions-dashboard]
command = "npx"
args = ["-y", "sessions-dashboard"]
env = { SESSIONS_DASHBOARD_AUTOSTART = "1", SESSIONS_DASHBOARD_HOST = "codex" }
```

Restart your CLI after registration; tools appear as `mcp__sessions-dashboard__*`.

---

## Notes & caveats

**Codex activity pill in Limited persistence mode.** Codex's default rollout-persistence mode (Limited) skips `*_begin` events, so the activity pill can only show `working` (between a user message and the next `task_complete`) and `idle <duration>` after the task completes — tool names are never surfaced. To get the violet `running <tool>..` pill, set Codex to Extended persistence (the relevant config key has shifted between Codex versions; check `codex config schema`). The dashboard still works in Limited mode — it just won't surface tool names.

**Codex on Windows.** Codex's official Windows support runs through WSL2, but the native Windows build (transcripts under `%USERPROFILE%\.codex\sessions\`) works in practice — sessions-dashboard's transcript scanner and `/rename` detection both function on native Windows. Use whichever fits your workflow.
