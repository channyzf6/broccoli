# Privacy

`sessions-dashboard` is a local-only developer tool. It collects no
analytics, sends no telemetry, and makes no outbound network requests
during normal operation.

## Data collected

None. The daemon and proxies run entirely on the user's machine.

## Network behavior

- The daemon binds to `127.0.0.1:8787` (loopback only). It does not
  accept connections from any non-localhost origin and rejects all
  HTTP requests with non-`null` Origin headers.
- Proxies (one per CLI session) communicate with the daemon over the
  same loopback socket.
- No outbound HTTP, no analytics endpoints, no usage reporting.

## Local files

- **`~/.claude/extensions/sessions-dashboard/data/`** — daemon log
  file.
- **`<plugin-cache>/data/session-groups.json`** — your group / pin
  configuration. Created when you first drag a card.
- **Read-only access** to the host CLI's transcript directories
  (`~/.claude/projects/...`, `~/.codex/sessions/...`,
  `~/.gemini/tmp/...`) for activity-state derivation. The daemon
  never modifies these files.

## Third-party software

- **Playwright** (npm dependency) downloads a copy of Chromium during
  `npm install`. This is a one-time install-time download from
  `https://playwright.dev`. After install, no further outbound
  requests are made by `sessions-dashboard`.
- **Chromium** runs locally to render the dashboard. Its own privacy
  posture is governed by Chromium itself; `sessions-dashboard`
  launches it with `--no-first-run` to suppress first-run prompts but
  does not otherwise modify Chromium's defaults.

## Webview contents

The MCP `eval_js` tool runs JavaScript in webviews opened by the
agent. Anything the agent fetches in those webviews is governed by
the third-party site's own privacy policy. `sessions-dashboard`
itself does not log or transmit webview contents.

## Contact

Issues / questions: https://github.com/channyzf6/sessions-dashboard/issues
