# sessions-dashboard

**A live dashboard for every Claude Code *or Gemini CLI* session you're running.** See what each one's doing in real time, organize them into groups, and control their shared browser from any session.

<!-- TODO: add docs/dashboard.png once a clean screenshot is available -->

---

## Why

If you run more than one Claude Code session, you quickly lose track:

- Which session is working on what repo?
- Is session 3 actively generating code right now, or idle waiting for you?
- What tool is that long-running session stuck on?
- How do I group related sessions (e.g. frontend + backend workers) visually?

`sessions-dashboard` gives you a live, at-a-glance view:

- 🟢 **`working`** — Claude is producing output right now
- 🟣 **`running bash..`** — a tool is executing (you see which one)
- ⚪ **`idle 2m`** — done, waiting for your next prompt
- **Drag-and-drop groups** — organize sessions into named columns that persist across restarts
- **Inline rename, live counters, uptime, cwd** — every card tells you exactly what that session is doing without alt-tabbing

Plus, because all sessions share a browser under the hood, any session can open a webview that every other session can script — useful for coordinated debugging flows.

---

## Install

Heads up: first `npm install` downloads Chromium via Playwright (~150 MB, 30–60 s). Hang tight.

### One-command install

**macOS / Linux**
```bash
git clone https://github.com/channyzf6/broccoli sessions-dashboard && cd sessions-dashboard && bash bin/install.sh
```

**Windows PowerShell**
```powershell
git clone https://github.com/channyzf6/broccoli sessions-dashboard
cd sessions-dashboard
powershell -ExecutionPolicy Bypass -File bin\install.ps1
```

**Windows cmd.exe** (hands off to PowerShell internally)
```cmd
git clone https://github.com/channyzf6/broccoli sessions-dashboard
cd sessions-dashboard
bin\install.bat
```

The script registers the MCP server with Claude Code as `sessions-dashboard`. Restart Claude Code, then in any session ask:

> *"Open the sessions dashboard"*

Claude invokes `mcp__sessions-dashboard__open_dashboard` and a live window appears.

### Manual install

```bash
git clone https://github.com/channyzf6/broccoli sessions-dashboard
cd sessions-dashboard
npm install
claude mcp add sessions-dashboard --scope user -- node "$(pwd)/index.mjs"
```

Or edit `~/.claude/settings.json` directly:

```json
{
  "mcpServers": {
    "sessions-dashboard": {
      "command": "node",
      "args": ["<absolute path>/index.mjs"]
    }
  }
}
```

On Windows, use something like `C:\\Users\\<username>\\code\\sessions-dashboard\\index.mjs` (note the escaped backslashes). Restart Claude Code. Tools appear as `mcp__sessions-dashboard__*`.

### Gemini CLI

Gemini CLI is supported in addition to Claude Code — both hosts can register against the same daemon and show up side-by-side on the dashboard, with a `C` / `G` glyph on each card so you can tell them apart.

Register via the CLI:

```bash
gemini mcp add --scope user sessions-dashboard node "<absolute path>/index.mjs"
```

Or edit `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "sessions-dashboard": {
      "command": "node",
      "args": ["<absolute path>/index.mjs"],
      "env": {
        "SESSIONS_DASHBOARD_AUTOSTART": "1",
        "SESSIONS_DASHBOARD_HOST": "gemini"
      }
    }
  }
}
```

`SESSIONS_DASHBOARD_HOST=gemini` tells the proxy which host scraping strategy to use; if omitted, the proxy auto-detects from cwd. Gemini CLI has no `/rename` slash command, so name a session via `SESSIONS_DASHBOARD_SESSION_NAME` in the env block or by calling `set_session_name` from inside the Gemini session.

**Compatibility matrix:**

| Host | Cards + drag/drop | Tools | Live activity pill | In-transcript rename |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ | ✅ | ✅ `/rename` |
| Gemini CLI | ✅ | ✅ | ✅ | ❌ (use env var or `set_session_name` tool) |

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
| 🟢 `working` | Claude is producing output — text, thinking tokens, or about to dispatch a tool |
| 🟣 `running bash..`, `running sessions-dashboard·screenshot..` | A tool is executing. The tool name is surfaced |
| ⚪ `idle 2m` | Assistant finished its turn, waiting for your next prompt |

The state is derived from the session's JSONL log (tail-state tracking). Long-running tools stay accurately marked as `running` — no 60-second false-idle.

### Name your sessions

Sessions default to their cwd. Give them nicer names three ways:

- **Env var before launching:** `CLAUDE_SESSION_NAME=frontend-worker claude`
- **`/rename` slash command** inside the session — auto-picked up within 15 s
- **`set_session_name` tool** — Claude can call it programmatically

### Group them

Drag cards between groups in the dashboard. Groups match by **cwd** or **session name** — stable identifiers that survive CC restarts. Click `+ New group` to add one; click the name to rename inline; `delete` twice to remove.

### Share a browser across sessions

Under the hood, one Chromium instance serves all sessions. Session A can open `https://example.com`; session B can call `eval_js` on that same page; session C can screenshot it. Useful for coordinated debugging flows where one agent drives and another inspects.

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
| `SESSIONS_DASHBOARD_AUTOSTART` | unset | Set to `1` to register this session at startup, so it appears in the dashboard before any tool is invoked. |
| `SESSIONS_DASHBOARD_HOST` | auto | `claude` or `gemini`. When unset, detected from which host's transcript dir matches the cwd. |
| `SESSIONS_DASHBOARD_SESSION_NAME` | unset | Sticky display name for this session (cross-host). |
| `CLAUDE_SESSION_NAME` | unset | Claude-era alias for `SESSIONS_DASHBOARD_SESSION_NAME`. |

Set in the MCP server's `env` block in `settings.json`:

```json
{
  "mcpServers": {
    "sessions-dashboard": {
      "command": "node",
      "args": ["<path>/index.mjs"],
      "env": { "SESSIONS_DASHBOARD_AUTOSTART": "1" }
    }
  }
}
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
session A ──┐
            ├── MCP stdio ──► index.mjs (proxy) ──► HTTP 127.0.0.1:8787 ──┐
session B ──┘                                                             │
                                                                          ▼
                                                             daemon.mjs ──► Chromium
                                                                          │
                                                          sessions.html  ─┘ (polls /sessions)
```

- **`index.mjs`** — one MCP proxy per CC session. Spawns the daemon on first use; heartbeats every 5 s; incrementally scans this session's JSONL log to report activity.
- **`daemon.mjs`** — long-lived HTTP server on `127.0.0.1:8787`. Owns the single Chromium instance. Survives CC restarts.
- **`data/sessions.html`** — the dashboard. Polls `/sessions` every 2 s.

The daemon is loopback-only, resource-capped (max 50 sessions, 20 webviews), and races cleanly — concurrent spawns hit `EADDRINUSE` and exit.

See [PUBLISHING.md](PUBLISHING.md) for maintainer notes.

---

## Contributing

Issues and PRs welcome at <https://github.com/channyzf6/broccoli>.

Built on Playwright. No runtime deps beyond Node 18+ and `@modelcontextprotocol/sdk`.
