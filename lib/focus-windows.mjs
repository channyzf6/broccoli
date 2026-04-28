// Windows focus-session support. Given a session running inside
// WezTerm on Windows, switches to its pane via `wezterm cli activate-pane`
// and raises the wezterm-gui.exe window via a small PowerShell helper.
// Other Windows terminals (Windows Terminal, ConEmu, cmd, pwsh,
// git-bash, Alacritty) are out of scope for v0.5.
//
// Security: terminalPaneId is validated /^\d+$/ before any spawn.
// All spawns use argv arrays; no shell strings. The PowerShell helper
// is built from a static template with integer interpolations only.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";

const WEZTERM_TIMEOUT_MS = 5000;
const POWERSHELL_TIMEOUT_MS = 5000;

// Spawn a command with argv; collect stdout+stderr+exit. Kills after
// timeout. Never shells out. Mirrors lib/focus.mjs's runCmd.
function runCmd(cmd, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); finish({ code: null, stdout, stderr, error: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
  });
}

// Find a wezterm-gui.exe pid + HWND and raise its window. Best-effort:
// returns { ok: true } when the foreground steal succeeds. Failure
// modes: PowerShell missing, no wezterm-gui.exe with a visible
// window, helper times out, or the raise script itself errors. The
// orchestrator (focusSession) downgrades a failed raise to a
// `partial` on the otherwise-successful pane activation.
async function raiseWezTerm() {
  // Step 1: locate the target via PowerShell. We grab pid+HWND of the
  // first wezterm-gui.exe with a non-zero MainWindowHandle. Multi-window
  // disambiguation is out of scope; first match wins.
  const findScript = [
    "$p = Get-Process wezterm-gui -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if ($null -eq $p) { Write-Output 'NOPROC'; exit 0 }",
    "Write-Output ($p.Id.ToString() + ',' + ([int64]$p.MainWindowHandle).ToString())",
  ].join("; ");

  const findR = await _internal.runCmd(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", findScript],
    { timeoutMs: POWERSHELL_TIMEOUT_MS },
  );
  if (findR.timedOut) return { ok: false, error: "powershell find-window timed out" };
  if (findR.code !== 0) return { ok: false, error: "powershell find-window failed: " + (findR.stderr || "exit " + findR.code).trim() };

  const out = (findR.stdout || "").trim();
  if (!out || out === "NOPROC") return { ok: false, error: "no wezterm-gui.exe with a visible window found" };

  const m = /^(\d+),(\d+)$/.exec(out);
  if (!m) return { ok: false, error: "unparseable powershell output: " + out };
  const procPid = m[1];
  const hwnd = m[2];

  // Step 2: raise. Try AppActivate first (one line, often works on
  // locked-down Win11). Fall back to AttachThreadInput dance.
  // $pid is a read-only automatic in PowerShell, hence $fgPid below.
  const raiseScript = [
    "$ok = $false",
    "try { $ok = (New-Object -ComObject WScript.Shell).AppActivate(" + procPid + ") } catch { $ok = $false }",
    "if (-not $ok) {",
    "  Add-Type @'",
    "  using System;",
    "  using System.Runtime.InteropServices;",
    "  public class W {",
    "    [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);",
    "    [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int n);",
    "    [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "    [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
    "    [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool f);",
    "    [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();",
    "  }",
    "'@",
    "  $h = [IntPtr]::new([int64]" + hwnd + ")",
    "  $fg = [W]::GetForegroundWindow()",
    "  $fgPid = 0",
    "  $fgT = [W]::GetWindowThreadProcessId($fg, [ref]$fgPid)",
    "  $me = [W]::GetCurrentThreadId()",
    "  [W]::AttachThreadInput($me, $fgT, $true) | Out-Null",
    "  [W]::ShowWindowAsync($h, 9) | Out-Null",
    "  [W]::SetForegroundWindow($h) | Out-Null",
    "  [W]::AttachThreadInput($me, $fgT, $false) | Out-Null",
    "}",
  ].join("\n");

  const raiseR = await _internal.runCmd(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", raiseScript],
    { timeoutMs: POWERSHELL_TIMEOUT_MS },
  );
  if (raiseR.timedOut) return { ok: false, error: "powershell raise-window timed out" };
  if (raiseR.code !== 0) return { ok: false, error: (raiseR.stderr || "exit " + raiseR.code).trim() };
  return { ok: true };
}

// Spawn `wezterm cli activate-pane --pane-id <id>`. Returns
// { ok, error?, timedOut? }. paneId must be a numeric string —
// caller validates via /^\d+$/.
async function activatePane(cliPath, paneId) {
  const r = await _internal.runCmd(
    cliPath,
    ["cli", "activate-pane", "--pane-id", String(paneId)],
    { timeoutMs: WEZTERM_TIMEOUT_MS },
  );
  if (r.timedOut) return { ok: false, error: "wezterm cli activate-pane timed out", timedOut: true };
  if (r.error) return { ok: false, error: "wezterm cli spawn failed: " + r.error };
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || "exit " + r.code).trim();
    return { ok: false, error: "wezterm activate-pane failed: " + msg };
  }
  return { ok: true };
}

// Find wezterm.exe. Tries PATH first, then the standard MSI install
// location. Returns absolute path or null. We avoid `where` /
// `Get-Command` to keep this synchronous and zero-spawn.
function resolveWeztermCli() {
  const pathEnv = process.env.PATH || process.env.Path || "";
  for (const dir of pathEnv.split(";")) {
    if (!dir) continue;
    const candidate = dir.replace(/[\\/]+$/, "") + "\\wezterm.exe";
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not present */ }
  }
  const fallback = "C:\\Program Files\\WezTerm\\wezterm.exe";
  try {
    if (statSync(fallback).isFile()) return fallback;
  } catch {}
  return null;
}

// Helpers exported on a single mutable object so tests can stub them
// without monkey-patching read-only ESM bindings.
export const _internal = {
  resolveWeztermCli,
  activatePane,
  raiseWezTerm,
  runCmd,
};

// Main entry. Returns one of:
//   { ok: true, strategy: "wezterm" }
//   { ok: true, strategy: "wezterm", partial: "<reason>" }
//   { ok: false, error, kind: "unsupported"|"runtime"|"timeout", pid }
export async function focusSession(session) {
  if (process.platform !== "win32") {
    return { ok: false, error: "focus-windows only implemented on Windows", kind: "unsupported", pid: session?.pid ?? null };
  }
  const pid = session?.pid ?? null;
  const terminal = session?.terminal ?? null;
  const terminalPaneId = session?.terminalPaneId ?? null;

  if (terminal !== "wezterm") {
    return {
      ok: false,
      error: "session not running inside WezTerm (terminal=" + JSON.stringify(terminal) + ")",
      kind: "unsupported",
      pid,
    };
  }
  if (terminalPaneId == null || !/^\d+$/.test(String(terminalPaneId))) {
    return {
      ok: false,
      error: "wezterm session has invalid pane id: " + JSON.stringify(terminalPaneId),
      kind: "runtime",
      pid,
    };
  }
  const cli = _internal.resolveWeztermCli();
  if (!cli) {
    return {
      ok: false,
      error: "wezterm CLI not found on PATH",
      kind: "unsupported",
      pid,
    };
  }
  const act = await _internal.activatePane(cli, terminalPaneId);
  if (!act.ok) {
    return {
      ok: false,
      error: act.error,
      kind: act.timedOut ? "timeout" : "runtime",
      pid,
      ...(act.timedOut ? { timedOut: true } : {}),
    };
  }
  const raise = await _internal.raiseWezTerm();
  if (!raise.ok) {
    return { ok: true, strategy: "wezterm", partial: "window raise failed: " + (raise.error || "") };
  }
  return { ok: true, strategy: "wezterm" };
}
