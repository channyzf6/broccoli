# sessions-dashboard

**A live dashboard for every CLI agent session you're running** — Claude Code, Gemini CLI, and Codex CLI on a single screen. See what each agent is doing in real time, organize sessions into groups, and jump straight to a session's terminal in one click.

<!-- TODO: add docs/hero.gif once produced -->

---

## Why

If you run more than one CLI agent at a time, you quickly lose track:

- Which session is working on what repo?
- Is session 3 actively working right now, or idle waiting for you?
- What tool is that long-running session stuck on?
- Which of my dozen terminal tabs is the session I need?
- How do I group related sessions (e.g. frontend + backend workers) visually?

`sessions-dashboard` gives you a live, at-a-glance view:

- 🟢 **`working`** — the agent is producing output right now
- 🟣 **`running bash..`** — a tool is executing (you see which one)
- ⚪ **`idle 2m`** — done, waiting for your next prompt
- **Drag-and-drop groups** — organize sessions into named columns that persist across restarts
- **One-click focus (macOS)** — jump from a card to the corresponding terminal tab
- **Shared browser** — any session can open a webview every other session can script (useful for coordinated debugging)

---

## Install

### One-line install (recommended — macOS / Linux / Windows)

```bash
npx -y sessions-dashboard install
```

Requires Node ≥18 on PATH (already true if you're running Claude Code, Gemini CLI, or Codex CLI). The installer auto-detects which of those three CLIs are on your PATH and registers `sessions-dashboard` with each one. One CLI installed → one registration; all three → three registrations; none → clear error pointing you at the manual config snippets below.

The first run pre-fetches Playwright's Chromium (~150 MB) so the first dashboard open is instant. After that, restart your CLI(s) and in any session ask:

> *"Open the sessions dashboard"*

Your CLI invokes `mcp__sessions-dashboard__open_dashboard` and a live window appears showing every connected session across all registered CLIs.

To remove the MCP registrations later: `npx -y sessions-dashboard uninstall`.

### From source (contributors)

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

### Manual install (per CLI)

If you'd rather not use the installer at all and prefer to register each CLI by hand:

```bash
# Claude Code
claude mcp add sessions-dashboard --scope user --env SESSIONS_DASHBOARD_HOST=claude -- npx -y sessions-dashboard

# Gemini CLI
gemini mcp add --scope user sessions-dashboard --env SESSIONS_DASHBOARD_HOST=gemini -- npx -y sessions-dashboard

# Codex CLI (note: --scope is unsupported here, mcp add is global by default)
codex mcp add sessions-dashboard --env SESSIONS_DASHBOARD_HOST=codex -- npx -y sessions-dashboard
```

Or edit each CLI's settings file directly. For Claude (`~/.claude/settings.json`):

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

Pinning the host via `SESSIONS_DASHBOARD_HOST` makes detection deterministic and skips a cold-start dir-probe race that otherwise mis-routes mixed-host sessions. Restart your CLI; tools appear as `mcp__sessions-dashboard__*`.

### Per-CLI notes

All three CLIs (Claude Code, Gemini CLI, Codex CLI) register against the same daemon and show up side-by-side on the dashboard. The host is surfaced via the card's tooltip ("Claude Code" / "Gemini CLI" / "Codex CLI") rather than a visible glyph, so the visual stays uncluttered when you don't care which CLI is which.

The npx one-liner registers all three automatically; this section is for users hand-editing their config files or who want to see the per-CLI config syntax.

**Gemini** writes to `~/.gemini/settings.json`:

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

Gemini CLI has no `/rename` slash command, so name a session via `SESSIONS_DASHBOARD_SESSION_NAME` in the env block or by calling `set_session_name` from inside the Gemini session.

**Codex** writes to `~/.codex/config.toml`:

```toml
[mcp_servers.sessions-dashboard]
command = "npx"
args = ["-y", "sessions-dashboard"]
env = { SESSIONS_DASHBOARD_AUTOSTART = "1", SESSIONS_DASHBOARD_HOST = "codex" }
```

**Activity-pill caveat — set Codex to "Extended" persistence for full granularity.** Codex's default rollout-persistence mode (Limited) skips `*_begin` events (`task_started`, `exec_command_begin`, `mcp_tool_call_begin`). In Limited mode the activity pill can only show `working` (between a user message and the next `task_complete`) and `idle <duration>` after the task completes — tool names are never surfaced because the adapter has no signal for "tool currently executing." To enable Extended mode, edit `~/.codex/config.toml` per the Codex docs (the relevant key has shifted between Codex versions; check `codex config schema`). When unsure, the dashboard still works in Limited mode — it just won't surface tool names.

**Windows note:** Codex CLI is officially supported on Windows via WSL2 only. Run the daemon and Codex inside WSL together for the cleanest experience; native Windows builds of Codex are best-effort.

**Compatibility matrix:**

| Host | Cards + drag/drop | Tools | Live activity pill | In-transcript rename |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ | ✅ | ✅ `/rename` |
| Gemini CLI | ✅ | ✅ | ✅ | ❌ (use env var or `set_session_name` tool) |
| Codex CLI | ✅ | ✅ | ✅ Extended mode (Limited shows working/idle only — no tool name at all) | ✅ `/rename` |

---

## Quick tour

### Open the dashboard

Any session can open it:

> *"Open the sessions dashboard"*

A Chromium window appears, polling the daemon every 2 s. Every session currently using `sessions-dashboard` (or set to auto-register — see [Configuration](#configuration)) shows up as a card.

### Activity indicator

Each card shows a live pill:

| Pill | Meaning |
|---|---|
| 🟢 `working` | The agent is producing output — text, thinking tokens, or about to dispatch a tool |
| 🟣 `running bash..`, `running sessions-dashboard·screenshot..` | A tool is executing. The tool name is surfaced |
| ⚪ `idle 2m` | Assistant finished its turn, waiting for your next prompt |

The state is derived from each session's transcript (tail-state tracking against the host CLI's chat log). Long-running tools stay accurately marked as `running` — no 60-second false-idle.

### Name your sessions

Sessions default to their cwd's basename. Give them nicer names three ways:

- **Env var before launching:** `SESSIONS_DASHBOARD_SESSION_NAME=frontend-worker claude` (works for any host; `CLAUDE_SESSION_NAME` is a Claude-era alias)
- **`/rename` slash command** inside the session — auto-picked up within 15 s. Supported in Claude Code and Codex CLI; **Gemini CLI has no `/rename` equivalent**, so use the env var or the `set_session_name` tool below.
- **`set_session_name` tool** — your CLI agent can call it programmatically (works for every host)

### Group them

Drag cards between groups in the dashboard. Groups match by **cwd** or **session name** — stable identifiers that survive CLI restarts. Click `+ New group` to add one; click the name to rename inline; `delete` twice to remove.

### Share a browser across sessions

Under the hood, one Chromium instance serves all sessions. Session A can open `https://example.com`; session B can call `eval_js` on that same page; session C can screenshot it. Useful for coordinated debugging flows where one agent drives and another inspects.

### Focus a session's terminal (macOS only)

Each session card has a small `↗` button on its right side. Click it to bring that session's terminal window to the foreground with the correct tab selected — typing lands straight in the agent's prompt (Claude / Gemini / Codex, whichever the card is). Useful when the dashboard shows something finished and you need to jump to it.

Supported on macOS with Terminal.app, iTerm2, and tmux running inside either. Other terminals (WezTerm, Kitty, VS Code integrated terminal, ...) show a toast with the session's pid so you can Cmd-Tab manually. Windows and Linux daemons hide the button entirely (capability-gated).

First use triggers a one-time macOS automation-permission prompt asking to let `node` control Terminal.app / iTerm2. Click Allow; subsequent clicks work without a prompt.

---

## Tools

All tools prefixed `mcp__sessions-dashboard__`:

| Tool | Purpose |
|---|---|
| `open_dashboard` | Open a registered dashboard (e.g. `sessions`). The main entry point. |
| `list_dashboards` | List registered dashboards from `data/dashboards.json`. |
| `set_session_name` | Set or clear this session's display name. |
| `daemon_info` | `{ pid, port, uptime, webviews, sessions }` — diagnostics. |
| `open_webview` | Open a named browser window with a URL or HTML. |
| `update_webview` | Navigate an already-open window. |
| `eval_js` | Run JS in a named window; return JSON-serialized result. |
| `screenshot` | PNG of a named window. `fullPage: true` for full scroll height. |
| `close_webview` | Close a window. Other windows + the browser stay alive. |
| `list_webviews` | Enumerate open windows — `{ name, url, title, startedAt }`. |

The last six are the shared-browser primitives — general-purpose, not dashboard-specific.

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SESSIONS_DASHBOARD_PORT` | `8787` | Port the daemon binds to on loopback. All sessions must agree. |
| `SESSIONS_DASHBOARD_AUTOSTART` | unset | Set to `1` to register this session at startup, so it appears in the dashboard before any tool is invoked. The installer doesn't set this by default — opt in if you want eager registration. |
| `SESSIONS_DASHBOARD_HOST` | auto | `claude`, `gemini`, or `codex`. When unset, detected by probing each host's transcript dir for one matching this cwd. The installer pins this per registration so the probe is bypassed. |
| `SESSIONS_DASHBOARD_SESSION_NAME` | unset | Sticky display name for this session (cross-host). |
| `CLAUDE_SESSION_NAME` | unset | Claude-era alias for `SESSIONS_DASHBOARD_SESSION_NAME`. |

Set in the MCP server's `env` block. For Claude Code / Gemini CLI (`~/.claude/settings.json` or `~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "sessions-dashboard": {
      "command": "npx",
      "args": ["-y", "sessions-dashboard"],
      "env": { "SESSIONS_DASHBOARD_AUTOSTART": "1" }
    }
  }
}
```

For Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.sessions-dashboard]
command = "npx"
args = ["-y", "sessions-dashboard"]
env = { SESSIONS_DASHBOARD_AUTOSTART = "1" }
```

`SESSIONS_DASHBOARD_AUTOSTART=1` is recommended — it ensures every session shows up in the dashboard without you having to manually invoke a tool first.

---

## Troubleshooting

- **`daemon_info` returns the PID** — use `taskkill /F /PID <pid>` (Windows) or `kill <pid>` (Unix) to force-kill a wedged daemon. Next tool call respawns it.
- **Chromium window gone but daemon alive** — next `open_dashboard` or `open_webview` relaunches Chromium.
- **Dashboard shows "daemon unreachable"** — daemon crashed or hasn't started yet. Run any `sessions-dashboard` tool to respawn.
- **Session not appearing** — by default the daemon is dormant until a session calls a tool. Either invoke one (e.g. `open_dashboard`) or set `SESSIONS_DASHBOARD_AUTOSTART=1`.

---

## Architecture

```
claude session ──┐
gemini session ──┼── MCP stdio ──► sessions-dashboard ──► HTTP 127.0.0.1:8787 ──┐
codex session  ──┘                 (proxy: index.mjs)                           │
                                                                                ▼
                                                                   daemon.mjs ──► Chromium
                                                                                │
                                                                sessions.html  ─┘ (polls /sessions)
```

- **`bin/sessions-dashboard.mjs`** — the npm-published binary. Subcommand dispatcher (install / uninstall / version / help). With no subcommand, falls through to `index.mjs` to run the MCP server (this is what each CLI's MCP config invokes).
- **`index.mjs`** — one MCP proxy per CLI session. Spawns the daemon on first use; heartbeats every 5 s; incrementally scans this session's transcript to report activity.
- **`daemon.mjs`** — long-lived HTTP server on `127.0.0.1:8787`. Owns the single Chromium instance. Survives individual CLI restarts.
- **`data/sessions.html`** — the dashboard. Polls `/sessions` every 2 s.

The daemon is loopback-only, resource-capped (max 50 sessions, 20 webviews), and races cleanly — concurrent spawns hit `EADDRINUSE` and exit.

See [PUBLISHING.md](PUBLISHING.md) for maintainer notes.

---

## Contributing

Issues and PRs welcome at <https://github.com/channyzf6/sessions-dashboard>.

Built on Playwright. No runtime deps beyond Node 18+ and `@modelcontextprotocol/sdk`.
