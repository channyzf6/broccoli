// Tests for proxy-side terminal detection. The function reads
// `process.env` to identify which terminal hosts the current
// session — used at /session/register time so the daemon can
// surface a per-session focus capability.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHostTerminal } from "./terminal.mjs";

// Each test snapshots+restores process.env to avoid bleeding
// state across cases. Vars used: WEZTERM_PANE.
function withEnv(overrides, fn) {
  const KEYS = ["WEZTERM_PANE"];
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

test("WEZTERM_PANE set → terminal:'wezterm' with the pane id", async () => {
  await withEnv({ WEZTERM_PANE: "42" }, () => {
    const r = detectHostTerminal();
    assert.deepEqual(r, { terminal: "wezterm", terminalPaneId: "42" });
  });
});

test("WEZTERM_PANE empty string → terminal:null (treated as unset)", async () => {
  await withEnv({ WEZTERM_PANE: "" }, () => {
    const r = detectHostTerminal();
    assert.deepEqual(r, { terminal: null, terminalPaneId: null });
  });
});

test("no WEZTERM_PANE → terminal:null", async () => {
  await withEnv({ WEZTERM_PANE: undefined }, () => {
    const r = detectHostTerminal();
    assert.deepEqual(r, { terminal: null, terminalPaneId: null });
  });
});

test("WEZTERM_PANE preserves the pane id verbatim (numeric string)", async () => {
  await withEnv({ WEZTERM_PANE: "0" }, () => {
    const r = detectHostTerminal();
    assert.equal(r.terminalPaneId, "0");
  });
});
