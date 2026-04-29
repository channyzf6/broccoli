// Tests for the codex config-toml patcher. Pure-function — no
// filesystem or subprocess. Codex's `mcp add` doesn't expose env_vars
// (the per-server inherit list); the installer post-edits config.toml
// to inject it after running the CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { patchCodexEnvVars } from "./installer.mjs";

test("inserts env_vars after the section header when none present", () => {
  const toml = [
    "[mcp_servers.sessions-dashboard]",
    'command = "node"',
    "args = ['/path/to/bin']",
    "",
    "[mcp_servers.sessions-dashboard.env]",
    'SESSIONS_DASHBOARD_HOST = "codex"',
    "",
  ].join("\n");
  const out = patchCodexEnvVars(toml, ["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET"]);
  assert.match(out, /\[mcp_servers\.sessions-dashboard\]\nenv_vars = \["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET"\]\n/);
  // Other content preserved.
  assert.match(out, /command = "node"/);
  assert.match(out, /SESSIONS_DASHBOARD_HOST = "codex"/);
});

test("replaces an existing env_vars line in our section", () => {
  const toml = [
    "[mcp_servers.sessions-dashboard]",
    'command = "node"',
    'env_vars = ["OLD_VAR"]',
    "args = ['/path/to/bin']",
    "",
    "[mcp_servers.sessions-dashboard.env]",
    'SESSIONS_DASHBOARD_HOST = "codex"',
  ].join("\n");
  const out = patchCodexEnvVars(toml, ["WEZTERM_PANE"]);
  assert.match(out, /env_vars = \["WEZTERM_PANE"\]/);
  assert.doesNotMatch(out, /OLD_VAR/, "old value must be replaced, not duplicated");
});

test("does NOT touch env_vars in OTHER mcp_server sections", () => {
  const toml = [
    "[mcp_servers.other-server]",
    'env_vars = ["OTHER_KEEPS_THIS"]',
    "",
    "[mcp_servers.sessions-dashboard]",
    'command = "node"',
    "",
  ].join("\n");
  const out = patchCodexEnvVars(toml, ["WEZTERM_PANE"]);
  assert.match(out, /env_vars = \["OTHER_KEEPS_THIS"\]/, "other server's env_vars must remain unchanged");
  assert.match(out, /\[mcp_servers\.sessions-dashboard\]\nenv_vars = \["WEZTERM_PANE"\]/);
});

test("idempotent: running twice produces the same output as running once", () => {
  const toml = [
    "[mcp_servers.sessions-dashboard]",
    'command = "node"',
    "",
    "[mcp_servers.sessions-dashboard.env]",
    'SESSIONS_DASHBOARD_HOST = "codex"',
  ].join("\n");
  const once = patchCodexEnvVars(toml, ["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET"]);
  const twice = patchCodexEnvVars(once, ["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET"]);
  assert.equal(twice, once, "idempotency: second pass must not duplicate or re-arrange");
});

test("returns input unchanged when our section is missing", () => {
  const toml = [
    "[mcp_servers.other-server]",
    'command = "x"',
  ].join("\n");
  const out = patchCodexEnvVars(toml, ["WEZTERM_PANE"]);
  assert.equal(out, toml);
});

test("respects sub-table boundaries — env_vars goes in the parent, not in .env", () => {
  // The .env subtable is `[mcp_servers.sessions-dashboard.env]`. We must
  // insert env_vars in the PARENT section, not within .env.
  const toml = [
    "[mcp_servers.sessions-dashboard]",
    'command = "node"',
    "",
    "[mcp_servers.sessions-dashboard.env]",
    'SESSIONS_DASHBOARD_HOST = "codex"',
  ].join("\n");
  const out = patchCodexEnvVars(toml, ["WEZTERM_PANE"]);
  // The env_vars line must appear BEFORE the .env subtable header.
  const envVarsAt = out.indexOf("env_vars =");
  const subEnvAt = out.indexOf("[mcp_servers.sessions-dashboard.env]");
  assert.ok(envVarsAt > 0 && subEnvAt > 0, "both lines must exist");
  assert.ok(envVarsAt < subEnvAt, "env_vars must appear before the .env subtable header");
});

test("forwards macOS focus env vars (TERM_PROGRAM, TMUX, TMUX_PANE) alongside WezTerm vars", () => {
  // Regression for the codex-on-macOS focus bug: without TERM_PROGRAM
  // forwarded, daemon-side `psEnv(pid)` reads no terminal hint and
  // focus.mjs falls through to "focus not supported for terminal
  // 'unknown'". The list must include every env var that focus.mjs
  // reads off the proxy via `ps -Eww`.
  const toml = [
    "[mcp_servers.sessions-dashboard]",
    'command = "npx"',
    "",
  ].join("\n");
  const names = ["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET", "TERM_PROGRAM", "TMUX", "TMUX_PANE"];
  const out = patchCodexEnvVars(toml, names);
  for (const n of names) {
    assert.match(out, new RegExp(`"${n}"`), `env_vars must include ${n}`);
  }
  // Single line, all five names — order preserved as given.
  assert.match(
    out,
    /env_vars = \["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET", "TERM_PROGRAM", "TMUX", "TMUX_PANE"\]/,
  );
});
