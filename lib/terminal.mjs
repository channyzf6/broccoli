// Identify which terminal hosts this session by reading our own
// env vars. Terminals like WezTerm set a per-pane env var in every
// shell they spawn; child processes (the user's shell, the MCP
// proxy, ...) inherit it transitively. Daemon-side detection would
// need to read another process's environment, which has no portable
// answer on Windows — so we do it proxy-side and propagate via
// the /session/register payload.

export function detectHostTerminal() {
  if (process.env.WEZTERM_PANE) {
    // WEZTERM_UNIX_SOCKET is the path of the GUI's IPC pipe, also set
    // on Windows (the env var name is misleading). Without it, a
    // `wezterm cli` invocation from outside the GUI's process tree
    // auto-spawns a SEPARATE headless mux and talks to that — so
    // activate-pane targets a phantom pane and the GUI stays
    // unchanged. We pass the socket through so the CLI talks to the
    // GUI hosting the user's pane.
    return {
      terminal: "wezterm",
      terminalPaneId: process.env.WEZTERM_PANE,
      terminalSocket: process.env.WEZTERM_UNIX_SOCKET || null,
    };
  }
  return { terminal: null, terminalPaneId: null, terminalSocket: null };
}

// Validate a terminalPaneId received over the wire (e.g. in
// /session/register's body). The value is interpolated into a
// `wezterm cli activate-pane --pane-id <id>` argv, so it MUST be
// strictly numeric. null/undefined are accepted as "absent" — not
// every session has a pane id.
export function isValidTerminalPaneId(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string" && typeof value !== "number") return false;
  return /^\d+$/.test(String(value));
}
