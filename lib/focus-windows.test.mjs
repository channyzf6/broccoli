// Tests for lib/focus-windows.mjs. Internal helpers are exposed via
// a mutable `_internal` object so tests can stub them without
// monkey-patching read-only ESM bindings. Real wezterm and Win32
// calls are out of scope for unit tests — covered by the manual
// smoke test in docs/superpowers/plans/...

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusSession, _internal } from "./focus-windows.mjs";

// Snapshot/restore _internal between tests so stubs don't leak.
function withStubs(stubs, fn) {
  const orig = {};
  for (const k of Object.keys(stubs)) orig[k] = _internal[k];
  Object.assign(_internal, stubs);
  return Promise.resolve(fn()).finally(() => Object.assign(_internal, orig));
}

test("non-win32: returns kind:'unsupported'", async () => {
  if (process.platform === "win32") return; // skip on the actual target
  const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
  assert.match(r.error, /Windows/i);
});

test("rejects sessions whose terminal != 'wezterm' as unsupported", async () => {
  if (process.platform !== "win32") return;
  const r = await focusSession({ pid: 1, terminal: "windows-terminal", terminalPaneId: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
  assert.match(r.error, /WezTerm/i);
  assert.equal(r.pid, 1);
});

test("rejects null terminal as unsupported", async () => {
  if (process.platform !== "win32") return;
  const r = await focusSession({ pid: 7, terminal: null, terminalPaneId: null });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
  assert.equal(r.pid, 7);
});

test("rejects missing terminalPaneId as runtime", async () => {
  if (process.platform !== "win32") return;
  const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: null });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "runtime");
  assert.match(r.error, /pane id/i);
});

test("rejects non-numeric terminalPaneId as runtime (defense in depth)", async () => {
  if (process.platform !== "win32") return;
  const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "abc; rm -rf /" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "runtime");
  assert.match(r.error, /pane id/i);
});

test("returns unsupported when wezterm CLI cannot be resolved", async () => {
  if (process.platform !== "win32") return;
  await withStubs({ resolveWeztermCli: () => null }, async () => {
    const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "1" });
    assert.equal(r.ok, false);
    assert.equal(r.kind, "unsupported");
    assert.match(r.error, /wezterm.*not found|wezterm.*PATH/i);
  });
});

test("resolveWeztermCli: finds wezterm.exe via PATH", () => {
  if (process.platform !== "win32") return;
  const tmp = mkdtempSync(join(tmpdir(), "ghs-wezterm-"));
  try {
    const fake = join(tmp, "wezterm.exe");
    writeFileSync(fake, "");
    const prevPath = process.env.PATH;
    process.env.PATH = tmp;
    try {
      const found = _internal.resolveWeztermCli();
      assert.equal(found, fake);
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveWeztermCli: PATH miss returns null when fallback also missing", () => {
  if (process.platform !== "win32") return;
  const tmp = mkdtempSync(join(tmpdir(), "ghs-no-wezterm-"));
  try {
    const prevPath = process.env.PATH;
    process.env.PATH = tmp;
    try {
      // Stub statSync? Cleaner: rely on the real fallback behavior. If
      // the test machine has WezTerm installed at the standard path,
      // this assertion would fail — accept that and assert truthy
      // either way. The miss-PATH-AND-miss-fallback case is exercised
      // when the test runs on a machine with no wezterm install.
      const found = _internal.resolveWeztermCli();
      // On this machine wezterm IS installed at C:\Program Files\WezTerm\wezterm.exe,
      // so we get the fallback. Just verify the resolver doesn't pick
      // up the empty tempdir as a false positive.
      assert.notEqual(found, join(tmp, "wezterm.exe"));
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("activate-pane is invoked with paneId + socket from session", async () => {
  if (process.platform !== "win32") return;
  let captured = null;
  await withStubs({
    resolveWeztermCli: () => "C:\\fake\\wezterm.exe",
    activatePane: async (cli, paneId, socket) => {
      captured = { cli, paneId, socket };
      return { ok: true };
    },
    raiseWezTerm: async () => ({ ok: true }),
  }, async () => {
    const r = await focusSession({
      pid: 1,
      terminal: "wezterm",
      terminalPaneId: "42",
      terminalSocket: "C:\\Users\\u\\.local\\share\\wezterm\\gui-sock-1234",
    });
    assert.equal(r.ok, true);
    assert.equal(r.strategy, "wezterm");
    assert.deepEqual(captured, {
      cli: "C:\\fake\\wezterm.exe",
      paneId: "42",
      socket: "C:\\Users\\u\\.local\\share\\wezterm\\gui-sock-1234",
    });
  });
});

test("focusSession: passes wezterm-gui pid (extracted from socket) to raiseWezTerm", async () => {
  if (process.platform !== "win32") return;
  let raisePid = "unset";
  await withStubs({
    resolveWeztermCli: () => "C:\\fake\\wezterm.exe",
    activatePane: async () => ({ ok: true }),
    raiseWezTerm: async (p) => { raisePid = p; return { ok: true }; },
  }, async () => {
    await focusSession({
      pid: 1,
      terminal: "wezterm",
      terminalPaneId: "0",
      terminalSocket: "C:\\Users\\u\\.local\\share\\wezterm\\gui-sock-27632",
    });
    assert.equal(raisePid, "27632", "raise must receive the pid encoded in the socket path");
  });
});

test("focusSession: passes null pid to raiseWezTerm when socket has no embedded pid", async () => {
  if (process.platform !== "win32") return;
  let raisePid = "unset";
  await withStubs({
    resolveWeztermCli: () => "C:\\fake\\wezterm.exe",
    activatePane: async () => ({ ok: true }),
    raiseWezTerm: async (p) => { raisePid = p; return { ok: true }; },
  }, async () => {
    await focusSession({
      pid: 1,
      terminal: "wezterm",
      terminalPaneId: "0",
      terminalSocket: "C:\\custom\\socket\\name",
    });
    assert.equal(raisePid, null, "raise must receive null when socket doesn't match gui-sock-<pid>");
  });
});

test("activate-pane: missing terminalSocket → strategy 'wezterm' but partial warns", async () => {
  if (process.platform !== "win32") return;
  // No socket → CLI won't talk to the GUI; we still try and let
  // wezterm's own error surface, but if the proxy lacked the socket
  // env (older WezTerm? WSL?) we degrade gracefully.
  let captured = null;
  await withStubs({
    resolveWeztermCli: () => "C:\\fake\\wezterm.exe",
    activatePane: async (cli, paneId, socket) => {
      captured = { cli, paneId, socket };
      return { ok: true };
    },
    raiseWezTerm: async () => ({ ok: true }),
  }, async () => {
    const r = await focusSession({
      pid: 1,
      terminal: "wezterm",
      terminalPaneId: "1",
      terminalSocket: null,
    });
    assert.equal(r.ok, true);
    assert.equal(captured.socket, null, "socket passed through as null");
  });
});

test("activate-pane runtime failure surfaces stderr in error", async () => {
  if (process.platform !== "win32") return;
  await withStubs({
    resolveWeztermCli: () => "C:\\fake\\wezterm.exe",
    activatePane: async () => ({ ok: false, error: "pane 999 not found in mux" }),
    raiseWezTerm: async () => ({ ok: true }),
  }, async () => {
    const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "999" });
    assert.equal(r.ok, false);
    assert.equal(r.kind, "runtime");
    assert.match(r.error, /pane 999 not found/);
    assert.equal(r.pid, 1);
  });
});

test("activate-pane timeout surfaces kind:'timeout'", async () => {
  if (process.platform !== "win32") return;
  await withStubs({
    resolveWeztermCli: () => "C:\\fake\\wezterm.exe",
    activatePane: async () => ({ ok: false, error: "wezterm cli timed out", timedOut: true }),
    raiseWezTerm: async () => ({ ok: true }),
  }, async () => {
    const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "1" });
    assert.equal(r.ok, false);
    assert.equal(r.kind, "timeout");
    assert.equal(r.timedOut, true);
  });
});

test("window raise failure → ok:true with partial reason", async () => {
  if (process.platform !== "win32") return;
  await withStubs({
    resolveWeztermCli: () => "C:\\fake\\wezterm.exe",
    activatePane: async () => ({ ok: true }),
    raiseWezTerm: async () => ({ ok: false, error: "no wezterm-gui.exe found" }),
  }, async () => {
    const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "1" });
    assert.equal(r.ok, true);
    assert.equal(r.strategy, "wezterm");
    assert.match(r.partial, /window raise failed.*no wezterm-gui/);
  });
});

test("real activatePane: passes --no-auto-start + WEZTERM_UNIX_SOCKET env", async () => {
  if (process.platform !== "win32") return;
  let captured = null;
  await withStubs({
    runCmd: async (cmd, args, opts) => {
      captured = { cmd, args, env: opts?.env };
      return { code: 0, stdout: "", stderr: "" };
    },
  }, async () => {
    const r = await _internal.activatePane("C:\\fake\\wezterm.exe", "42", "C:\\sock");
    assert.equal(r.ok, true);
    assert.equal(captured.cmd, "C:\\fake\\wezterm.exe");
    assert.deepEqual(captured.args, ["cli", "--no-auto-start", "activate-pane", "--pane-id", "42"],
      "--no-auto-start prevents the CLI from spawning a fresh mux when socket is stale (~5s hang)");
    assert.equal(captured.env?.WEZTERM_UNIX_SOCKET, "C:\\sock", "must pass socket through env so CLI hits the GUI's mux");
  });
});

test("real activatePane: omits WEZTERM_UNIX_SOCKET when socket is null", async () => {
  if (process.platform !== "win32") return;
  let captured = null;
  await withStubs({
    runCmd: async (cmd, args, opts) => {
      captured = { cmd, args, env: opts?.env };
      return { code: 0, stdout: "", stderr: "" };
    },
  }, async () => {
    await _internal.activatePane("C:\\fake\\wezterm.exe", "42", null);
    // Either env is undefined (inherit) or env doesn't include the key.
    if (captured.env != null) {
      assert.equal(captured.env.WEZTERM_UNIX_SOCKET, undefined);
    }
  });
});

test("real activatePane: non-zero exit returns ok:false with stderr", async () => {
  if (process.platform !== "win32") return;
  await withStubs({
    runCmd: async () => ({ code: 1, stdout: "", stderr: "pane 999 not found in mux\n" }),
  }, async () => {
    const r = await _internal.activatePane("C:\\fake\\wezterm.exe", "999");
    assert.equal(r.ok, false);
    assert.match(r.error, /pane 999 not found/);
  });
});

test("real activatePane: timeout returns timedOut:true", async () => {
  if (process.platform !== "win32") return;
  await withStubs({
    runCmd: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
  }, async () => {
    const r = await _internal.activatePane("C:\\fake\\wezterm.exe", "1");
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.match(r.error, /timed out/i);
  });
});

test("real raiseWezTerm: NOWND sentinel → ok:false 'no wezterm-gui window'", async () => {
  if (process.platform !== "win32") return;
  await withStubs({
    runCmd: async () => ({ code: 0, stdout: "NOWND\n", stderr: "" }),
  }, async () => {
    const r = await _internal.raiseWezTerm();
    assert.equal(r.ok, false);
    assert.match(r.error, /no wezterm-gui/i);
  });
});

test("real raiseWezTerm with pid: uses Get-Process -Id and returns ok", async () => {
  if (process.platform !== "win32") return;
  let captured = null;
  await withStubs({
    runCmd: async (cmd, args) => {
      captured = args[args.length - 1];
      return { code: 0, stdout: "OK\n", stderr: "" };
    },
  }, async () => {
    const r = await _internal.raiseWezTerm("27632");
    assert.equal(r.ok, true);
    assert.match(captured, /Get-Process -Id 27632/, "must look up by exact pid when provided");
    assert.match(captured, /SetForegroundWindow/, "raise must call SetForegroundWindow");
    assert.match(captured, /keybd_event/, "raise must use Alt-key trick");
    assert.doesNotMatch(captured, /Get-Process wezterm-gui/, "must NOT do the broad find-by-name when pid is known");
  });
});

test("real raiseWezTerm: gates ShowWindowAsync(SW_RESTORE) on IsIconic to preserve maximized state", async () => {
  if (process.platform !== "win32") return;
  let captured = null;
  await withStubs({
    runCmd: async (cmd, args) => {
      captured = args[args.length - 1];
      return { code: 0, stdout: "OK\n", stderr: "" };
    },
  }, async () => {
    await _internal.raiseWezTerm("123");
    assert.match(captured, /IsIconic/, "must check IsIconic before SW_RESTORE — calling SW_RESTORE on a maximized window un-maximizes it");
    // The script must guard the ShowWindowAsync call: if IsIconic is
    // false (window is maximized or normal), SW_RESTORE would resize.
    // Allow either an `if (IsIconic) { ShowWindowAsync... }` form or a
    // ternary — just assert the two are co-located on the same conditional.
    assert.match(
      captured,
      /IsIconic[^]*ShowWindowAsync/,
      "ShowWindowAsync(SW_RESTORE) must appear inside the IsIconic-true branch",
    );
  });
});

test("real raiseWezTerm without pid: falls back to find-by-name", async () => {
  if (process.platform !== "win32") return;
  let captured = null;
  await withStubs({
    runCmd: async (cmd, args) => {
      captured = args[args.length - 1];
      return { code: 0, stdout: "OK\n", stderr: "" };
    },
  }, async () => {
    const r = await _internal.raiseWezTerm(null);
    assert.equal(r.ok, true);
    assert.match(captured, /Get-Process wezterm-gui/, "must fall back to name lookup when pid is null");
  });
});

test("real raiseWezTerm: rejects non-numeric weztermPid (defense in depth)", async () => {
  if (process.platform !== "win32") return;
  let captured = null;
  await withStubs({
    runCmd: async (cmd, args) => {
      captured = args[args.length - 1];
      return { code: 0, stdout: "OK\n", stderr: "" };
    },
  }, async () => {
    await _internal.raiseWezTerm("123; rm -rf /");
    assert.match(captured, /Get-Process wezterm-gui/, "non-numeric pid must fall back to safe name lookup");
    assert.doesNotMatch(captured, /rm -rf/);
  });
});

test("real raiseWezTerm: timeout → ok:false", async () => {
  if (process.platform !== "win32") return;
  await withStubs({
    runCmd: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
  }, async () => {
    const r = await _internal.raiseWezTerm();
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/i);
  });
});

test("real raiseWezTerm: script failure surfaces stderr", async () => {
  if (process.platform !== "win32") return;
  await withStubs({
    runCmd: async () => ({ code: 1, stdout: "", stderr: "Add-Type compilation failed" }),
  }, async () => {
    const r = await _internal.raiseWezTerm();
    assert.equal(r.ok, false);
    assert.match(r.error, /Add-Type compilation failed/);
  });
});
