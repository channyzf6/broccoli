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
// timeout. Never shells out. Mirrors lib/focus.mjs's runCmd. Optional
// `env` is merged with process.env (caller-supplied keys win).
//
// windowsHide:true is load-bearing — without it each spawn flashes a
// new console window, because the daemon is started by the MCP host
// (a GUI-class process) and its children don't inherit a console.
// Same pattern as lib/installer.mjs.
function runCmd(cmd, args, { timeoutMs = 5000, env } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const spawnOpts = { stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
    if (env) spawnOpts.env = { ...process.env, ...env };
    const child = spawn(cmd, args, spawnOpts);
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

// Locate the target wezterm-gui window and raise it in a single
// PowerShell call. Caller passes the wezterm-gui pid extracted from
// the socket path (preferred — exact match for the pane's GUI) or
// null to fall back to "first wezterm-gui with a visible window."
//
// Combining find + raise into one PS invocation halves the cold-start
// cost (PowerShell takes ~300-500ms to spawn). The `findById/findAny`
// branch happens inside the script.
//
// The raise sequence:
//   - keybd_event(VK_MENU) simulates an Alt key tap. Windows treats
//     this as user input and lifts the foreground-lock for the
//     calling process — without this, SetForegroundWindow returns
//     false from non-foreground processes.
//   - AttachThreadInput attaches to the foreground thread's input
//     queue, sharing focus rights.
//   - IsIconic + ShowWindowAsync(SW_RESTORE) ONLY when the window is
//     minimized. SW_RESTORE is also defined as "restore from
//     maximized to normal", so calling it unconditionally
//     un-maximizes a maximized window — visible as a resize on every
//     focus click.
//   - BringWindowToTop reorders the Z-order without changing size.
//   - SetForegroundWindow does the actual transfer.
//   - Detach the thread input.
// $pid is a read-only automatic in PowerShell, hence $fgPid below.
async function raiseWezTerm(weztermPid) {
  const lookup = weztermPid && /^\d+$/.test(String(weztermPid))
    ? "$p = Get-Process -Id " + weztermPid + " -ErrorAction SilentlyContinue"
    : "$p = Get-Process wezterm-gui -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1";
  const script = [
    lookup,
    "if ($null -eq $p -or $p.MainWindowHandle -eq 0) { Write-Output 'NOWND'; exit 0 }",
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class W {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int n);",
    "  [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
    "  [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool f);",
    "  [DllImport(\"user32.dll\")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);",
    "  [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();",
    "}",
    "'@",
    "$h = [IntPtr]::new([int64]$p.MainWindowHandle)",
    "[W]::keybd_event(0x12, 0, 0, [IntPtr]::Zero) | Out-Null",
    "[W]::keybd_event(0x12, 0, 2, [IntPtr]::Zero) | Out-Null",
    "$fg = [W]::GetForegroundWindow()",
    "$fgPid = 0",
    "$fgT = [W]::GetWindowThreadProcessId($fg, [ref]$fgPid)",
    "$me = [W]::GetCurrentThreadId()",
    "[W]::AttachThreadInput($me, $fgT, $true) | Out-Null",
    "if ([W]::IsIconic($h)) { [W]::ShowWindowAsync($h, 9) | Out-Null }",
    "[W]::BringWindowToTop($h) | Out-Null",
    "[W]::SetForegroundWindow($h) | Out-Null",
    "[W]::AttachThreadInput($me, $fgT, $false) | Out-Null",
    "Write-Output 'OK'",
  ].join("\n");

  const r = await _internal.runCmd(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: POWERSHELL_TIMEOUT_MS },
  );
  if (r.timedOut) return { ok: false, error: "powershell raise-window timed out" };
  if (r.code !== 0) return { ok: false, error: (r.stderr || "exit " + r.code).trim() };
  const out = (r.stdout || "").trim();
  if (out === "NOWND") return { ok: false, error: "no wezterm-gui window found" + (weztermPid ? " (pid " + weztermPid + ")" : "") };
  return { ok: true };
}

// Spawn `wezterm cli --no-auto-start activate-pane --pane-id <id>`.
// paneId must be a numeric string (caller validates via /^\d+$/).
// socket, when non-null, is passed as WEZTERM_UNIX_SOCKET in the
// spawned env so the CLI talks to the GUI's mux instead of
// auto-spawning a separate headless one (the env-var name is
// misleading on Windows — it's a named-pipe path, but WezTerm uses
// the same env var on both platforms).
//
// --no-auto-start is load-bearing: without it, when the stored socket
// points at a dead wezterm-gui (user closed and reopened), the CLI
// retries by spawning wezterm-mux-server which itself takes ~5s to
// fail. With --no-auto-start the CLI errors immediately.
async function activatePane(cliPath, paneId, socket) {
  const opts = { timeoutMs: WEZTERM_TIMEOUT_MS };
  if (socket) opts.env = { WEZTERM_UNIX_SOCKET: socket };
  const r = await _internal.runCmd(
    cliPath,
    ["cli", "--no-auto-start", "activate-pane", "--pane-id", String(paneId)],
    opts,
  );
  if (r.timedOut) return { ok: false, error: "wezterm cli activate-pane timed out", timedOut: true };
  if (r.error) return { ok: false, error: "wezterm cli spawn failed: " + r.error };
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || "exit " + r.code).trim();
    return { ok: false, error: "wezterm activate-pane failed: " + msg };
  }
  return { ok: true };
}

// Extract the wezterm-gui PID from a socket path like
// `C:\Users\u\.local/share/wezterm\gui-sock-27632`. Returns the
// integer string or null. WezTerm's default socket-path scheme
// embeds the GUI's PID; if the user customizes it, this returns null
// and the caller falls back to find-by-name.
function pidFromSocket(socket) {
  if (typeof socket !== "string") return null;
  const m = /gui-sock-(\d+)\b/.exec(socket);
  return m ? m[1] : null;
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
  const terminalSocket = session?.terminalSocket ?? null;

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
  const act = await _internal.activatePane(cli, terminalPaneId, terminalSocket);
  if (!act.ok) {
    return {
      ok: false,
      error: act.error,
      kind: act.timedOut ? "timeout" : "runtime",
      pid,
      ...(act.timedOut ? { timedOut: true } : {}),
    };
  }
  // Extract the wezterm-gui pid from the socket path (default scheme
  // is `gui-sock-<pid>`). Lets the raise script Get-Process by id —
  // exact match for the pane's GUI rather than "first wezterm-gui".
  // Falls back to find-by-name if the socket uses a custom scheme.
  const weztermPid = pidFromSocket(terminalSocket);
  const raise = await _internal.raiseWezTerm(weztermPid);
  if (!raise.ok) {
    return { ok: true, strategy: "wezterm", partial: "window raise failed: " + (raise.error || "") };
  }
  return { ok: true, strategy: "wezterm" };
}
