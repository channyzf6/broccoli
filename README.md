# sessions-dashboard

**A live dashboard for every CLI agent session you're running** — Claude Code, Gemini CLI, and Codex CLI on a single screen. See what each agent is doing in real time, organize sessions into groups, and jump straight to a session's terminal in one click.

<!-- TODO: add docs/hero.gif once produced -->

---

## Install

```bash
npx -y sessions-dashboard install
```

Requires Node ≥18 on PATH (already true if you're running Claude Code, Gemini CLI, or Codex CLI). The installer auto-detects which of the three CLIs are on your PATH and registers `sessions-dashboard` with each. First run pre-fetches Playwright's Chromium (~150 MB) so the first dashboard open is instant.

After install, restart your CLI(s) and ask any session: *"Open the sessions dashboard."*

To remove the MCP registrations later: `npx -y sessions-dashboard uninstall`.

For installing from source (contributors), per-CLI manual config, and platform-specific caveats (Codex on Windows / Limited persistence mode), see [docs/INSTALL.md](docs/INSTALL.md).

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

### Compatibility matrix

| Host | Cards + drag/drop | Tools | Live activity pill | In-transcript rename |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ | ✅ | ✅ `/rename` |
| Gemini CLI | ✅ | ✅ | ✅ | 🟡 (`/rename` not built-in, but should work in practice; else, env var or `set_session_name` tool) |
| Codex CLI | ✅ | ✅ | ✅ Extended mode (Limited shows working/idle only — no tool names) | ✅ `/rename` |

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SESSIONS_DASHBOARD_PORT` | `8787` | Port the daemon binds to on loopback. All sessions must agree. |
| `SESSIONS_DASHBOARD_AUTOSTART` | unset | Set to `1` to register this session at startup, so it appears in the dashboard before any tool is invoked. The installer doesn't set this by default — opt in if you want eager registration. |
| `SESSIONS_DASHBOARD_HOST` | auto | `claude`, `gemini`, or `codex`. When unset, detected by probing each host's transcript dir for one matching this cwd. The installer pins this per registration so the probe is bypassed. |
| `SESSIONS_DASHBOARD_SESSION_NAME` | unset | Sticky display name for this session (cross-host). |
| `CLAUDE_SESSION_NAME` | unset | Claude-era alias for `SESSIONS_DASHBOARD_SESSION_NAME`. |

Set these in the MCP server's `env` block in your CLI's config file — see [docs/INSTALL.md](docs/INSTALL.md#per-cli-manual-install) for the per-CLI config syntax (Claude / Gemini settings.json, Codex config.toml). `SESSIONS_DASHBOARD_AUTOSTART=1` is recommended — it ensures every session shows up in the dashboard without you having to manually invoke a tool first.

---

## Tools

The MCP entry point is `mcp__sessions-dashboard__open_dashboard`. The package also exports nine other tools for shared-browser scripting (`open_webview`, `eval_js`, `screenshot`, …) — see [docs/TOOLS.md](docs/TOOLS.md) for the full reference.

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

One MCP proxy per CLI session, all talking to a single long-lived daemon that owns the Chromium browser. The daemon is loopback-only, resource-capped (max 50 sessions, 20 webviews), and survives individual CLI restarts.

---

## Contributing

Issues and PRs welcome at <https://github.com/channyzf6/sessions-dashboard>.

Built on Playwright. No runtime deps beyond Node 18+ and `@modelcontextprotocol/sdk`.
