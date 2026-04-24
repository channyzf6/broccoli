# MCP tools — full reference

All tools prefixed `mcp__sessions-dashboard__`.

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

The last six are the shared-browser primitives — general-purpose, not dashboard-specific. They're what enables the "session A opens a webview, session B scripts it" pattern useful for coordinated debugging flows where one agent drives and another inspects.
