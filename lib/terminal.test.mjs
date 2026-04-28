// Tests for proxy-side terminal detection. The function reads
// `process.env` to identify which terminal hosts the current
// session — used at /session/register time so the daemon can
// surface a per-session focus capability.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHostTerminal, isValidTerminalPaneId } from "./terminal.mjs";

// Each test snapshots+restores process.env to avoid bleeding
// state across cases. Vars used: WEZTERM_PANE, WEZTERM_UNIX_SOCKET.
function withEnv(overrides, fn) {
  const KEYS = ["WEZTERM_PANE", "WEZTERM_UNIX_SOCKET"];
  const prev = {};
  for (const k of KEYS) {
    prev[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test("WEZTERM_PANE + socket → terminal:'wezterm' with both fields", async () => {
  await withEnv({ WEZTERM_PANE: "42", WEZTERM_UNIX_SOCKET: "C:\\path\\to\\sock" }, () => {
    const r = detectHostTerminal();
    assert.deepEqual(r, {
      terminal: "wezterm",
      terminalPaneId: "42",
      terminalSocket: "C:\\path\\to\\sock",
    });
  });
});

test("WEZTERM_PANE without socket → terminal:'wezterm', terminalSocket:null", async () => {
  await withEnv({ WEZTERM_PANE: "42", WEZTERM_UNIX_SOCKET: undefined }, () => {
    const r = detectHostTerminal();
    assert.deepEqual(r, {
      terminal: "wezterm",
      terminalPaneId: "42",
      terminalSocket: null,
    });
  });
});

test("WEZTERM_PANE empty string → terminal:null (treated as unset)", async () => {
  await withEnv({ WEZTERM_PANE: "" }, () => {
    const r = detectHostTerminal();
    assert.deepEqual(r, { terminal: null, terminalPaneId: null, terminalSocket: null });
  });
});

test("no WEZTERM_PANE → terminal:null", async () => {
  await withEnv({ WEZTERM_PANE: undefined }, () => {
    const r = detectHostTerminal();
    assert.deepEqual(r, { terminal: null, terminalPaneId: null, terminalSocket: null });
  });
});

test("WEZTERM_PANE preserves the pane id verbatim (numeric string)", async () => {
  await withEnv({ WEZTERM_PANE: "0" }, () => {
    const r = detectHostTerminal();
    assert.equal(r.terminalPaneId, "0");
  });
});

// isValidTerminalPaneId — defense-in-depth check at the daemon's
// /session/register boundary. The value is interpolated into a
// `wezterm cli activate-pane --pane-id <id>` argv, so it must be
// strictly numeric. Absence (null/undefined) is allowed because not
// every session has a pane id.

test("isValidTerminalPaneId: null and undefined are valid (absence)", () => {
  assert.equal(isValidTerminalPaneId(null), true);
  assert.equal(isValidTerminalPaneId(undefined), true);
});

test("isValidTerminalPaneId: numeric strings are valid", () => {
  assert.equal(isValidTerminalPaneId("0"), true);
  assert.equal(isValidTerminalPaneId("1"), true);
  assert.equal(isValidTerminalPaneId("42"), true);
  assert.equal(isValidTerminalPaneId("999999"), true);
});

test("isValidTerminalPaneId: bare numbers are valid (coerced)", () => {
  assert.equal(isValidTerminalPaneId(0), true);
  assert.equal(isValidTerminalPaneId(42), true);
});

test("isValidTerminalPaneId: empty string is INVALID", () => {
  assert.equal(isValidTerminalPaneId(""), false);
});

test("isValidTerminalPaneId: non-numeric strings are INVALID", () => {
  assert.equal(isValidTerminalPaneId("abc"), false);
  assert.equal(isValidTerminalPaneId("1a"), false);
  assert.equal(isValidTerminalPaneId("a1"), false);
  assert.equal(isValidTerminalPaneId("-1"), false);
  assert.equal(isValidTerminalPaneId("1.0"), false);
});

test("isValidTerminalPaneId: injection attempts are INVALID", () => {
  assert.equal(isValidTerminalPaneId("1; rm -rf /"), false);
  assert.equal(isValidTerminalPaneId("1`whoami`"), false);
  assert.equal(isValidTerminalPaneId("1\n2"), false);
  assert.equal(isValidTerminalPaneId("1 2"), false);
});

test("isValidTerminalPaneId: objects/arrays are INVALID", () => {
  assert.equal(isValidTerminalPaneId({}), false);
  assert.equal(isValidTerminalPaneId([]), false);
  assert.equal(isValidTerminalPaneId([1]), false);
});
