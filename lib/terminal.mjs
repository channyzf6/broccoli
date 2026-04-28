// Identify which terminal hosts this session by reading our own
// env vars. Terminals like WezTerm set a per-pane env var in every
// shell they spawn; child processes (the user's shell, the MCP
// proxy, ...) inherit it transitively. Daemon-side detection would
// need to read another process's environment, which has no portable
// answer on Windows — so we do it proxy-side and propagate via
// the /session/register payload.

export function detectHostTerminal() {
  if (process.env.WEZTERM_PANE) {
    return { terminal: "wezterm", terminalPaneId: process.env.WEZTERM_PANE };
  }
  return { terminal: null, terminalPaneId: null };
}
