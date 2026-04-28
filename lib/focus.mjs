// macOS focus-session support. Given a session's pid, bring its terminal
// tab to the foreground with input focus. Supports Terminal.app, iTerm2,
// and tmux-inside-either. Other terminals return a clean 501.
//
// Security: all values interpolated into AppleScript (tty, pane id) are
// wrapped with JSON.stringify so they become safe string literals. All
// subprocess spawns use argv arrays (never a shell string). The only
// numbers that reach the shell are pids read from our own session
// registry — never from HTTP bodies.

import { spawn } from "node:child_process";

// First-use on macOS triggers a TCC system dialog ("allow node to control
// Terminal.app") that blocks osascript until the user clicks Allow/Deny.
// 15s gives a realistic window for the user to read & respond; shorter
// timeouts kill osascript but leave the dialog orphaned on screen, which
// is a UX trap (user's next click ends up recorded against a dead process).
const OSASCRIPT_TIMEOUT_MS = 15000;
const PS_TIMEOUT_MS = 1500;

// Spawn a command with argv; collect stdout+stderr+exit. Kills after
// timeout. Never shells out.
function runCmd(cmd, args, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); finish({ code: null, stdout, stderr, error: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); finish({ code, stdout, stderr }); });
  });
}

// Return /dev/ttysNNN for a pid, or null if unreadable / invalid.
// Uses -o tty= which strips the header, so output is just the tty name.
async function psTty(pid) {
  const r = await runCmd("/bin/ps", ["-o", "tty=", "-p", String(pid)], { timeoutMs: PS_TIMEOUT_MS });
  if (r.code !== 0) return null;
  const raw = r.stdout.trim();
  // macOS ps returns "ttys003" (no /dev/ prefix). Validate strictly so nothing
  // untrusted slips into a later AppleScript interpolation.
  if (!/^ttys\d+$/.test(raw)) return null;
  return "/dev/" + raw;
}

// Return a { KEY: VALUE } map of environment variables for a pid.
// Uses `ps -E ww -p <pid>`. On macOS this prints the command followed by
// KEY=VAL pairs on one long line. We parse by splitting on the first line
// after the header (or the only line if headerless) and greedy KEY=VAL
// matches.
async function psEnv(pid) {
  // macOS `ps` supports the -E flag to include environment. The `ww` forces
  // wide-unlimited output. Verified at runtime on the target machine —
  // if this variant fails we fall through to `eww` which is the older syntax.
  const out = {};
  let r = await runCmd("/bin/ps", ["-Eww", "-p", String(pid)], { timeoutMs: PS_TIMEOUT_MS });
  if (r.code !== 0 || !r.stdout.trim()) {
    r = await runCmd("/bin/ps", ["eww", String(pid)], { timeoutMs: PS_TIMEOUT_MS });
  }
  if (r.code !== 0) return out;
  const text = r.stdout;
  // Strip the header line if present. macOS ps prefix line typically starts
  // with "  PID" or similar; skip until we find an "=" token (env pair).
  // Easier: just scan the whole output for KEY=VAL pairs.
  // Walk token-by-token to handle values with spaces: env vars on macOS
  // are joined with single spaces in the output, so greedy parsing is
  // imperfect for values that contain `=`. For our three keys of
  // interest (TERM_PROGRAM, TMUX, TMUX_PANE) their values never contain
  // spaces, so split-on-space is safe enough.
  for (const tok of text.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    const val = tok.slice(eq + 1);
    if (!(key in out)) out[key] = val; // first occurrence wins
  }
  return out;
}

// Run an AppleScript snippet. Returns { ok, stdout, stderr, timedOut }.
function runOsascript(script) {
  return runCmd("/usr/bin/osascript", ["-e", script], { timeoutMs: OSASCRIPT_TIMEOUT_MS })
    .then((r) => ({
      ok: r.code === 0 && !r.timedOut,
      stdout: (r.stdout || "").trim(),
      stderr: (r.stderr || "").trim(),
      timedOut: !!r.timedOut,
    }));
}

// Escape a string for safe embedding as an AppleScript string literal.
// JSON string syntax is a subset of AppleScript's double-quoted string
// syntax for ASCII + basic escapes — good enough for tty paths and pane
// ids which are strict ASCII.
function asQ(s) { return JSON.stringify(String(s)); }

async function focusTerminalApp(tty) {
  const script = [
    'tell application "Terminal"',
    '  activate',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      if tty of t is ' + asQ(tty) + ' then',
    '        set selected of t to true',
    '        set frontmost of w to true',
    '        return "ok"',
    '      end if',
    '    end repeat',
    '  end repeat',
    '  return "no-match"',
    'end tell',
  ].join("\n");
  const r = await runOsascript(script);
  if (!r.ok) return { ok: false, error: r.stderr || "osascript failed", kind: r.timedOut ? "timeout" : "runtime", timedOut: r.timedOut };
  if (r.stdout !== "ok") return { ok: false, error: "no matching Terminal tab for tty " + tty, kind: "runtime" };
  return { ok: true };
}

async function focusITerm2(tty) {
  // iTerm2 historically has been registered as both "iTerm2" and "iTerm"
  // depending on version. Try iTerm2 first; fall back to iTerm if the
  // bundle isn't found. Errors for a missing app show up in stderr as
  // "Application isn't running" or similar.
  const body = [
    '  activate',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    '        if tty of s is ' + asQ(tty) + ' then',
    '          select s',
    '          set frontmost of w to true',
    '          return "ok"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    '  return "no-match"',
  ].join("\n");
  for (const appName of ['iTerm2', 'iTerm']) {
    const script = 'tell application "' + appName + '"\n' + body + '\nend tell';
    const r = await runOsascript(script);
    if (r.ok && r.stdout === 'ok') return { ok: true };
    if (r.ok && r.stdout === 'no-match') return { ok: false, error: 'no matching iTerm2 session for tty ' + tty, kind: "runtime" };
    // else: try the next name
  }
  return { ok: false, error: 'iTerm2 not running or AppleScript failed', kind: "runtime" };
}

// Extract the tmux socket path from the TMUX env var. Format is
// "<socket-path>,<server-pid>,<session-id>" so we split on comma and take
// the first segment. Returns null when TMUX is empty/malformed so the
// caller can pass no -S flag (default socket).
function tmuxSocketFromEnv(tmuxEnv) {
  if (!tmuxEnv) return null;
  const first = String(tmuxEnv).split(",")[0];
  return first && first.startsWith("/") ? first : null;
}

// Build argv for a tmux invocation on the right socket. Default (no -S)
// when no socket path is provided.
function tmuxArgv(socket, ...rest) {
  const base = socket ? ["tmux", "-S", socket, ...rest] : ["tmux", ...rest];
  return ["/usr/bin/env", ...base];
}

// Resolve the outer terminal's tty (the one running the tmux client, not
// the session's own pty inside tmux). Uses `tmux list-clients -F`.
// Returns a /dev/ttysNNN path or null.
async function tmuxClientTty(socket) {
  const r = await runCmd(
    "/usr/bin/env",
    (socket ? ["tmux", "-S", socket] : ["tmux"]).concat(["list-clients", "-F", "#{client_tty}"]),
    { timeoutMs: PS_TIMEOUT_MS },
  );
  if (r.code !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^\/dev\/ttys\d+$/.test(line)) return line;
  }
  return null;
}

async function focusViaTmux(tmuxPane, outerTty, termProgram, socket) {
  // Step 1: switch the active tmux pane on the correct socket.
  if (!/^%\d+$/.test(String(tmuxPane))) {
    return { ok: false, error: "invalid tmux pane id: " + tmuxPane, kind: "runtime" };
  }
  const switchR = await runCmd(
    "/usr/bin/env",
    (socket ? ["tmux", "-S", socket] : ["tmux"]).concat(["switch-client", "-t", tmuxPane]),
    { timeoutMs: PS_TIMEOUT_MS },
  );
  if (switchR.code !== 0) {
    return { ok: false, error: "tmux switch-client failed: " + (switchR.stderr || switchR.stdout).trim(), kind: "runtime" };
  }
  // Step 2: bring the outer terminal app forward, targeted by outer tty.
  if (!outerTty) {
    return { ok: true, partial: "tmux pane switched; outer terminal not raised (no client tty)" };
  }
  if (termProgram === "Apple_Terminal") {
    const r = await focusTerminalApp(outerTty);
    return r.ok ? { ok: true, strategy: "tmux+terminal" } : r;
  }
  if (termProgram === "iTerm.app") {
    const r = await focusITerm2(outerTty);
    return r.ok ? { ok: true, strategy: "tmux+iterm2" } : r;
  }
  return { ok: true, partial: "tmux pane switched; outer terminal '" + termProgram + "' not supported for raise" };
}

// Main entry. Returns one of:
//   { ok: true, strategy: "terminal-app" | "iterm2" | "tmux+..." }
//   { ok: true, partial: "<reason>" }   // tmux switch succeeded but
//                                       // couldn't raise the outer terminal
//   { ok: false, error: "<reason>", kind: "unsupported"|"runtime"|"timeout", pid?, terminal? }
//
// `kind` lets the daemon map result -> HTTP status without
// regex-matching the error string. Same scheme is used by
// lib/focus-windows.mjs.
export async function focusSession(session) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "focus only implemented on macOS", kind: "unsupported", pid: session?.pid ?? null };
  }
  const pid = session?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: "invalid session pid", kind: "unsupported", pid };
  }

  const tty = await psTty(pid);
  if (!tty) return { ok: false, error: "session pid has no tty (process may have exited)", kind: "runtime", pid };

  const env = await psEnv(pid);
  const termProgram = env.TERM_PROGRAM || "";

  // tmux wrapper takes precedence: if we're inside tmux, the session's
  // own tty is the pane pty (not a terminal tab), and only tmux can
  // switch to it. Parse the socket path out of TMUX so non-default-socket
  // setups (tmux -L / tmux -S) are supported.
  if (env.TMUX && env.TMUX_PANE) {
    const socket = tmuxSocketFromEnv(env.TMUX);
    // Defensive: if tmuxClientTty returns null, this may not actually be
    // a tmux session (env var misattribution is theoretically possible if
    // some other env var's value ends up split to look like `TMUX=...`).
    // Keep going — focusViaTmux will still switch-client on the right
    // socket; the terminal-raise just gets skipped if outer tty is unknown.
    const outerTty = await tmuxClientTty(socket);
    return await focusViaTmux(env.TMUX_PANE, outerTty, termProgram, socket);
  }

  if (termProgram === "Apple_Terminal") {
    const r = await focusTerminalApp(tty);
    return r.ok ? { ok: true, strategy: "terminal-app" } : { ...r, pid };
  }
  if (termProgram === "iTerm.app") {
    const r = await focusITerm2(tty);
    return r.ok ? { ok: true, strategy: "iterm2" } : { ...r, pid };
  }
  return {
    ok: false,
    error: "focus not supported for terminal '" + (termProgram || "unknown") + "'",
    kind: "unsupported",
    terminal: termProgram || null,
    pid,
  };
}
