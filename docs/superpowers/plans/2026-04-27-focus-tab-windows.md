# Focus-tab on Windows (WezTerm) Implementation Plan

> **Spec:** `docs/superpowers/specs/2026-04-27-focus-tab-windows-design.md`

**Goal:** Make the dashboard's `↗` "focus this session's terminal" button work for sessions running inside WezTerm on Windows.

**Architecture:** Proxy reads `WEZTERM_PANE` env var at register time and tags the session with `terminal: "wezterm"` + `terminalPaneId`. Daemon stores per-session terminal info, advertises `capabilities.focusTerminals: ["wezterm"]` on Windows, and dispatches `/session/focus` to a new `lib/focus-windows.mjs` module. That module shells out to `wezterm cli activate-pane` and runs a small PowerShell helper to raise the WezTerm GUI window.

**Tech Stack:** Node 22 ESM, `node:child_process` spawn, `node --test` harness, PowerShell 7 (already required by daemon — Playwright/Chromium dep).

---

## File Structure

| File | Action | Why |
|---|---|---|
| `index.mjs` | Modify ~line 195-220 | Proxy collects `terminal` / `terminalPaneId` from env at register time |
| `daemon.mjs` | Modify ~line 372, 400, 559, 642 | Store per-session terminal; capability shape; platform dispatch; kind-based status |
| `lib/focus.mjs` | Modify ~line 219-268 | Add `kind` field to all returns (no behavioral change) |
| `lib/focus-windows.mjs` | Create | The Windows path. Pane activation + window raise. |
| `lib/focus-windows.test.mjs` | Create | Unit tests with stubbed internals |
| `data/sessions.html` | Modify ~line 1111, 1322 | Capability gate uses `caps.focus || caps.focusTerminals?.includes(s.terminal)`; cardSignature picks up `s.terminal` |
| `package.json` | Modify line 18, 22 | Test script glob, files exclusion |

---

## Task 1: Proxy emits `terminal` / `terminalPaneId` at register

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\index.mjs:195-229`

**Note on TDD here:** the proxy is a long-running CLI process; the test would be an integration test against a running daemon. Existing convention: no proxy unit tests. Verification is "POST register, GET sessions, assert fields." We'll do that as a manual command-line check at the end of this task.

- [ ] **Step 1.1: Add `detectHostTerminal()` helper near top of `index.mjs`**

Insert after the imports, before the existing helpers (around line 60, just after `httpPost`/`httpPostJson` definitions — find where `function ping(timeoutMs = 300)` lives and add the helper just above it):

```js
// Identify which terminal hosts this session by reading our own env vars.
// Set by terminal emulators in every shell they spawn; the MCP proxy
// inherits them transitively through the user's shell. Daemon-side
// detection would need to read another process's env, which has no
// portable answer on Windows.
function detectHostTerminal() {
  if (process.env.WEZTERM_PANE) {
    return { terminal: "wezterm", terminalPaneId: process.env.WEZTERM_PANE };
  }
  return { terminal: null, terminalPaneId: null };
}
```

- [ ] **Step 1.2: Include detection in the register payload**

In `registerSession()` (line ~195), find the `httpPost("/session/register", { ... })` call and merge in the new fields:

```js
const term = detectHostTerminal();
const status = await httpPost("/session/register", {
  sessionId: SESSION_ID,
  pid: process.pid,
  cwd: SESSION_CWD,
  startedAt: SESSION_STARTED,
  clientInfo: SESSION_CLIENT_INFO,
  sessionName: SESSION_NAME,
  host: SESSION_HOST,
  gitBranch: SESSION_GIT_BRANCH,
  ...term,
});
```

- [ ] **Step 1.3: Smoke-check via syntax**

Run: `node --check index.mjs`
Expected: no output, exit 0.

- [ ] **Step 1.4: Commit**

```bash
git add index.mjs
git commit -m "proxy: detect host terminal via WEZTERM_PANE at register time

Sets terminal/terminalPaneId on the /session/register payload when the
proxy is running inside WezTerm. Daemon storage + dashboard gating
land in follow-up commits."
```

---

## Task 2: Daemon stores + projects + validates `terminal` / `terminalPaneId`

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\daemon.mjs:362, 372, 559`

- [ ] **Step 2.1: Update the session-record shape comment**

Find line 362:
```js
const sessions = new Map(); // sessionId -> {pid, cwd, clientInfo, startedAt, lastSeen, toolCalls}
```

Replace with:
```js
const sessions = new Map(); // sessionId -> {pid, cwd, clientInfo, startedAt, lastSeen, toolCalls, terminal, terminalPaneId}
```

- [ ] **Step 2.2: Project the new fields in `listSessions()`**

In `listSessions()` (line 375), inside the `Array.from(sessions, ([id, s]) => ({...}))` projection, add two fields. The natural place is after `gitBranch`:

```js
gitBranch: s.gitBranch ?? null,
terminal: s.terminal ?? null,
terminalPaneId: s.terminalPaneId ?? null,
clientInfo: s.clientInfo ?? null,
```

- [ ] **Step 2.3: Validate `terminalPaneId` shape at the register boundary**

In the `/session/register` handler (line ~555), after the `MAX_SESSIONS` cap check and before the `prev` lookup, add:

```js
// terminalPaneId is interpolated into a wezterm CLI argv. It comes from
// our own proxy via env-var read, but defense in depth: reject anything
// that isn't a positive integer string.
if (body.terminalPaneId != null && !/^\d+$/.test(String(body.terminalPaneId))) {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "terminalPaneId must be a non-negative integer" }));
  return;
}
```

- [ ] **Step 2.4: Destructure and store the new fields with `gitBranch`-style preserve**

In the same handler, find:
```js
const { sessionId, pid, cwd, startedAt: sStarted, clientInfo, sessionName, host, gitBranch } = body;
```

Add `terminal, terminalPaneId`:
```js
const { sessionId, pid, cwd, startedAt: sStarted, clientInfo, sessionName, host, gitBranch, terminal, terminalPaneId } = body;
```

In the `sessions.set(sessionId, { ... })` block, add the new fields right next to `gitBranch`. Use the explicit-undefined-check pattern (NOT `?? prev?.field`):

```js
gitBranch: gitBranch !== undefined ? gitBranch : (prev?.gitBranch ?? null),
// Terminal info comes from the proxy's own env at register time. Use
// the gitBranch idiom (explicit undefined check) so a current proxy
// can overwrite to null, but a stale proxy that omits the field
// preserves the prior value.
terminal: terminal !== undefined ? (terminal ?? null) : (prev?.terminal ?? null),
terminalPaneId: terminalPaneId !== undefined ? (terminalPaneId ?? null) : (prev?.terminalPaneId ?? null),
```

- [ ] **Step 2.5: Syntax check**

Run: `node --check daemon.mjs`
Expected: no output, exit 0.

- [ ] **Step 2.6: Commit**

```bash
git add daemon.mjs
git commit -m "daemon: store + project per-session terminal/terminalPaneId

Adds register-boundary validation that terminalPaneId is a
non-negative integer string. Uses the gitBranch preserve idiom so
a stale proxy can't wipe a previously-detected value but a current
proxy can explicitly null it out."
```

---

## Task 3: Daemon advertises `capabilities.focusTerminals`

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\daemon.mjs:397-402`

- [ ] **Step 3.1: Update the capability literal**

Find lines 397-402:

```js
// Platform-conditional capabilities. The focus endpoint only actually works
// on macOS (AppleScript-driven). Advertising this lets the frontend hide
// UI it can't usefully offer on Windows / Linux daemons.
const DAEMON_CAPABILITIES = Object.freeze({
  focus: process.platform === "darwin",
});
```

Replace with:

```js
// Platform-conditional capabilities. `focus` is the macOS catch-all
// (any session can be targeted via tty walk). `focusTerminals` is the
// per-terminal allowlist for platforms where we can only support
// specific terminals — Windows + WezTerm in v0.5. The frontend gates
// per-card on `caps.focus || caps.focusTerminals?.includes(s.terminal)`.
const DAEMON_CAPABILITIES = Object.freeze({
  focus: process.platform === "darwin",
  focusTerminals: process.platform === "win32" ? ["wezterm"] : [],
});
```

- [ ] **Step 3.2: Verify shape via curl-style check**

Start the daemon in a separate window and curl the endpoint to confirm. (Daemon spawn is heavy — Playwright/Chromium. Alternative: read `daemon.mjs:412` to confirm `capabilities: DAEMON_CAPABILITIES` is included in `daemon_info`'s response, which it is. Skip the live test in this step; we'll smoke test at the end.)

Verify by re-reading the daemon block of the `/sessions` response:
```bash
grep -n "DAEMON_CAPABILITIES" daemon.mjs
```
Expected: line 412 (in `daemon_info`) and line 521 (in `/sessions`) both reference it.

- [ ] **Step 3.3: Commit**

```bash
git add daemon.mjs
git commit -m "daemon: add focusTerminals capability for per-terminal Windows support

darwin keeps the existing 'any session' catch-all. win32 advertises
['wezterm'] as the per-session-eligible terminal. Other platforms
get an empty array — the dashboard's gate hides the button."
```

---

## Task 4: Refactor `lib/focus.mjs` to thread a `kind` field

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\lib\focus.mjs:219-268`

This is a small refactor that doesn't change macOS behavior — it just classifies error returns so the daemon can map kinds to HTTP status codes without regex matching.

**Test-first.** Existing macOS tests don't exist for `lib/focus.mjs` (no test file). We'll add a tiny test file that verifies the kind field on the non-darwin early-return path (which IS testable on Windows because the function checks platform itself).

- [ ] **Step 4.1: Write the failing test**

Create `C:\Users\parkc\repos_p\sessions-dashboard\lib\focus.test.mjs`:

```js
// Lightweight contract test for lib/focus.mjs. The macOS-specific
// branches require darwin to exercise; here we only verify the
// platform-gate early return shape, which all platforms hit when
// not on darwin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { focusSession } from "./focus.mjs";

test("non-darwin: returns kind:'unsupported' with pid", async () => {
  if (process.platform === "darwin") return; // skip on the actual platform
  const r = await focusSession({ pid: 12345 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
  assert.equal(r.pid, 12345);
  assert.match(r.error, /macOS/);
});

test("non-darwin: missing pid still returns kind:'unsupported'", async () => {
  if (process.platform === "darwin") return;
  const r = await focusSession(null);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
});
```

- [ ] **Step 4.2: Run the test — expect FAIL (kind not yet returned)**

Run: `node --test lib/focus.test.mjs`
Expected: 2 fail, "Expected values to be strictly equal: undefined !== 'unsupported'"

- [ ] **Step 4.3: Add `kind` to all returns in `lib/focus.mjs`**

In `focusSession()` (line 224-268), update each return statement. Diffs:

Line 226 — early platform check:
```js
return { ok: false, error: "focus only implemented on macOS", kind: "unsupported", pid: session?.pid ?? null };
```

Line 230 — pid validation:
```js
return { ok: false, error: "invalid session pid", kind: "unsupported", pid };
```

Line 234 — tty lookup:
```js
if (!tty) return { ok: false, error: "session pid has no tty (process may have exited)", kind: "runtime", pid };
```

Line 256, 260 — terminal-success branches: no change to ok:true returns. The error fallthrough returns at line 262-267 needs the kind:
```js
return {
  ok: false,
  error: "focus not supported for terminal '" + (termProgram || "unknown") + "'",
  kind: "unsupported",
  terminal: termProgram || null,
  pid,
};
```

For the error returns inside `focusTerminalApp`, `focusITerm2`, `focusViaTmux` (lines 122-124, 151-154, 201-216), classify them. They mostly return runtime errors:

In `focusTerminalApp` line 122-124:
```js
if (!r.ok) return { ok: false, error: r.stderr || "osascript failed", kind: r.timedOut ? "timeout" : "runtime", timedOut: r.timedOut };
if (r.stdout !== "ok") return { ok: false, error: "no matching Terminal tab for tty " + tty, kind: "runtime" };
```

In `focusITerm2` lines 150-154 (last few lines of the loop, plus the fallthrough):
```js
if (r.ok && r.stdout === 'no-match') return { ok: false, error: 'no matching iTerm2 session for tty ' + tty, kind: "runtime" };
// ...
return { ok: false, error: 'iTerm2 not running or AppleScript failed', kind: "runtime" };
```

In `focusViaTmux`:
- Line 194 (`invalid tmux pane id`): `kind: "runtime"`
- Line 201 (`tmux switch-client failed`): `kind: "runtime"`
- The success-with-partial branches don't need kind (they're ok:true).

Then at the call sites (line 256, 260) inside `focusSession`, the `{...r, pid}` spread already preserves kind:
```js
if (termProgram === "Apple_Terminal") {
  const r = await focusTerminalApp(tty);
  return r.ok ? { ok: true, strategy: "terminal-app" } : { ...r, pid };
}
```
That's already fine — `kind` will come along in the spread.

Update the JSDoc-style header comment (line 219-223) to document the new field:
```js
// Main entry. Returns one of:
//   { ok: true, strategy: "terminal-app" | "iterm2" | "tmux+..." }
//   { ok: true, partial: "<reason>" }   // tmux switch succeeded but
//                                       // couldn't raise the outer terminal
//   { ok: false, error: "<reason>", kind: "unsupported" | "runtime" | "timeout", pid?, terminal? }
```

- [ ] **Step 4.4: Run the test — expect PASS**

Run: `node --test lib/focus.test.mjs`
Expected: 2 pass.

- [ ] **Step 4.5: Commit**

```bash
git add lib/focus.mjs lib/focus.test.mjs
git commit -m "focus.mjs: tag every return with a kind field

Replaces the daemon's regex-on-error-string status mapping path with
a structured discriminator. unsupported -> 501, runtime/timeout -> 500.
No behavioral change on macOS; non-darwin early return still rejects."
```

---

## Task 5: Daemon dispatches focus by platform + maps kind to status

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\daemon.mjs:10, 642-661`

- [ ] **Step 5.1: Replace the static import with platform-conditional dispatch**

Find line 10:
```js
import { focusSession } from "./lib/focus.mjs";
```

Remove that import. We'll do it dynamically inside the handler so non-darwin / non-win32 deployments don't load Windows-only code.

Actually — `lib/focus.mjs` is portable (it just no-ops off darwin). And `lib/focus-windows.mjs` will be portable too (its own no-op off win32). So we can statically import both. Cleaner. Replace line 10 with:

```js
import { focusSession as focusDarwin } from "./lib/focus.mjs";
import { focusSession as focusWindows } from "./lib/focus-windows.mjs";
```

(Note: `lib/focus-windows.mjs` doesn't exist yet — Task 6 creates it. The `node --check` in this task will fail until then. We'll defer the import line addition to Task 6's commit, OR we add a stub `lib/focus-windows.mjs` here first.)

**Easier ordering: do this task AFTER Task 6.** Reorder mentally — Task 6 creates the module, Task 5 wires it.

- [ ] **Step 5.2: SKIP — return to this after Task 6**

Move on to Task 6, then come back.

---

## Task 6: Create `lib/focus-windows.mjs` (TDD)

**Files:**
- Create: `C:\Users\parkc\repos_p\sessions-dashboard\lib\focus-windows.mjs`
- Create: `C:\Users\parkc\repos_p\sessions-dashboard\lib\focus-windows.test.mjs`

This is the meat. Build it test-first, one behavior at a time.

### 6A: Module skeleton + non-Windows early return

- [ ] **Step 6A.1: Write failing test for non-win32 early return**

Create `lib/focus-windows.test.mjs`:

```js
// Tests for lib/focus-windows.mjs. Uses internal-export stubbing
// (the module exports a mutable _internal object whose helpers
// can be swapped per-test) to avoid spawning real wezterm/PowerShell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { focusSession, _internal } from "./focus-windows.mjs";

// Snapshot/restore _internal between tests so stubs don't leak.
function withStubs(stubs, fn) {
  const orig = { ...stubs };
  for (const k of Object.keys(stubs)) orig[k] = _internal[k];
  Object.assign(_internal, stubs);
  return Promise.resolve(fn()).finally(() => Object.assign(_internal, orig));
}

test("non-win32: returns kind:'unsupported'", async () => {
  if (process.platform === "win32") return; // skip on actual target platform
  const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
  assert.match(r.error, /Windows/);
});
```

- [ ] **Step 6A.2: Run — expect FAIL (module doesn't exist)**

Run: `node --test lib/focus-windows.test.mjs`
Expected: ERROR `Cannot find module ... lib/focus-windows.mjs`.

- [ ] **Step 6A.3: Create the skeleton**

Create `lib/focus-windows.mjs`:

```js
// Windows focus-session support. Given a session running inside
// WezTerm on Windows, switch to its pane via `wezterm cli activate-pane`
// and raise the wezterm-gui.exe window via a small PowerShell helper.
// Other Windows terminals are out of scope for v0.5.
//
// Security: terminalPaneId is validated /^\d+$/ before any spawn.
// All spawns use argv arrays; no shell strings. The PowerShell helper
// is built from a static template with integer interpolations only.

import { spawn } from "node:child_process";

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

// Helpers exported on a single mutable object so tests can stub them
// without monkey-patching read-only ESM bindings.
export const _internal = {
  resolveWeztermCli: () => null,    // overridden below
  activatePane: async () => ({ ok: false, error: "not implemented" }),
  raiseWezTerm: async () => ({ ok: false, error: "not implemented" }),
  runCmd,
};

// Main entry. Returns one of:
//   { ok: true, strategy: "wezterm" }
//   { ok: true, strategy: "wezterm", partial: "<reason>" }
//   { ok: false, error: "<reason>", kind: "unsupported" | "runtime" | "timeout", pid }
export async function focusSession(session) {
  if (process.platform !== "win32") {
    return { ok: false, error: "focus-windows only implemented on Windows", kind: "unsupported", pid: session?.pid ?? null };
  }
  // TODO: rest of dispatch (next sub-task)
  return { ok: false, error: "not implemented", kind: "runtime", pid: session?.pid ?? null };
}
```

- [ ] **Step 6A.4: Run the test — expect PASS**

Run: `node --test lib/focus-windows.test.mjs`
Expected: 1 pass.

### 6B: Validation paths (terminal, terminalPaneId)

- [ ] **Step 6B.1: Write failing tests for validation paths**

Append to `lib/focus-windows.test.mjs`:

```js
test("rejects sessions whose terminal != 'wezterm' as unsupported", async () => {
  if (process.platform !== "win32") return;
  const r = await focusSession({ pid: 1, terminal: "windows-terminal", terminalPaneId: "1" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
  assert.match(r.error, /not.*WezTerm|wezterm/i);
  assert.equal(r.pid, 1);
});

test("rejects null terminal as unsupported", async () => {
  if (process.platform !== "win32") return;
  const r = await focusSession({ pid: 7, terminal: null, terminalPaneId: null });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
});

test("rejects missing terminalPaneId as runtime", async () => {
  if (process.platform !== "win32") return;
  const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: null });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "runtime");
  assert.match(r.error, /pane id/i);
});

test("rejects non-numeric terminalPaneId as runtime", async () => {
  if (process.platform !== "win32") return;
  const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "abc; rm -rf /" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "runtime");
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
```

- [ ] **Step 6B.2: Run — expect 5 new tests to fail**

Run: `node --test lib/focus-windows.test.mjs`
Expected: 1 pass (the existing one), 5 fail.

- [ ] **Step 6B.3: Implement validation logic in `focusSession`**

Replace the body of `focusSession` (after the platform check) with:

```js
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
  // Activation + window raise come in next sub-task.
  return { ok: false, error: "not implemented", kind: "runtime", pid };
}
```

- [ ] **Step 6B.4: Run — expect 6 pass**

Run: `node --test lib/focus-windows.test.mjs`
Expected: 6 pass.

### 6C: Real `resolveWeztermCli`

- [ ] **Step 6C.1: Implement `resolveWeztermCli`**

Replace the placeholder in `_internal`:

```js
// Find wezterm.exe. Tries PATH first; falls back to the standard
// installer location. Returns absolute path or null.
function resolveWeztermCli() {
  // PATH check via spawnSync would add a sync subprocess at module
  // load time. Instead: use the process.env.PATH split + fs.existsSync,
  // which mirrors `where wezterm` cheaply.
  const pathEnv = process.env.PATH || process.env.Path || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = dir.replace(/[\\/]+$/, "") + "\\" + "wezterm" + ext;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* not present */ }
    }
  }
  // Standard MSI install location.
  const fallback = "C:\\Program Files\\WezTerm\\wezterm.exe";
  try {
    if (statSync(fallback).isFile()) return fallback;
  } catch {}
  return null;
}
```

Add the import at the top of the file:
```js
import { statSync } from "node:fs";
```

Replace the `_internal` declaration to use the new function:
```js
export const _internal = {
  resolveWeztermCli,
  activatePane: async () => ({ ok: false, error: "not implemented" }),
  raiseWezTerm: async () => ({ ok: false, error: "not implemented" }),
  runCmd,
};
```

- [ ] **Step 6C.2: Verify the resolver finds wezterm on this machine**

Quick smoke check (won't add as a test — depends on local env):
```bash
node -e "import('./lib/focus-windows.mjs').then(m => console.log(m._internal.resolveWeztermCli()))"
```
Expected on this machine: `C:\Program Files\WezTerm\wezterm.exe` (or wherever PATH puts it).

- [ ] **Step 6C.3: Run the test suite — still 6 pass**

Run: `node --test lib/focus-windows.test.mjs`
Expected: 6 pass (resolver no longer stubbed in the wezterm-not-found test, BUT that test stubs `resolveWeztermCli` to `() => null` via `withStubs`, so it still works.).

### 6D: `activatePane` helper (with TDD)

- [ ] **Step 6D.1: Write failing test for activatePane invocation**

Append to `lib/focus-windows.test.mjs`:

```js
test("activate-pane is invoked with --pane-id <integer> argv", async () => {
  if (process.platform !== "win32") return;
  let captured = null;
  await withStubs({
    resolveWeztermCli: () => "C:\\fake\\wezterm.exe",
    activatePane: async (cli, paneId) => {
      captured = { cli, paneId };
      return { ok: true };
    },
    raiseWezTerm: async () => ({ ok: true }),
  }, async () => {
    const r = await focusSession({ pid: 1, terminal: "wezterm", terminalPaneId: "42" });
    assert.equal(r.ok, true);
    assert.equal(r.strategy, "wezterm");
    assert.deepEqual(captured, { cli: "C:\\fake\\wezterm.exe", paneId: "42" });
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
```

- [ ] **Step 6D.2: Run — expect 3 new tests to fail**

Run: `node --test lib/focus-windows.test.mjs`
Expected: 6 pass, 3 fail.

- [ ] **Step 6D.3: Implement real activatePane and wire focusSession**

Replace the stubbed `activatePane` and the trailing "not implemented" return in `focusSession`. Add the helper just below `runCmd`:

```js
// Spawn `wezterm cli activate-pane --pane-id <id>`. Returns
// { ok, error?, timedOut? }. paneId must be a numeric string (caller
// validates via /^\d+$/).
async function activatePane(cliPath, paneId) {
  const r = await _internal.runCmd(cliPath, ["cli", "activate-pane", "--pane-id", String(paneId)], { timeoutMs: WEZTERM_TIMEOUT_MS });
  if (r.timedOut) return { ok: false, error: "wezterm cli activate-pane timed out", timedOut: true };
  if (r.error) return { ok: false, error: "wezterm cli spawn failed: " + r.error };
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || "exit " + r.code).trim();
    return { ok: false, error: "wezterm activate-pane failed: " + msg };
  }
  return { ok: true };
}
```

Update `_internal` to expose it:
```js
export const _internal = {
  resolveWeztermCli,
  activatePane,
  raiseWezTerm,    // declared below
  runCmd,
};
```

(`raiseWezTerm` doesn't exist yet — defined in 6E. Forward reference is fine in JS hoisting since these are function declarations. To avoid the temporal-dead-zone gotcha we'll put `raiseWezTerm` as `const` declared below the `_internal` block. Alternative: leave the stub in `_internal` for now and replace in 6E.)

For now, keep `raiseWezTerm` as a stub in `_internal` to avoid forward-reference juggling:
```js
export const _internal = {
  resolveWeztermCli,
  activatePane,
  raiseWezTerm: async () => ({ ok: true }),  // 6E replaces this
  runCmd,
};
```

Replace the trailing "not implemented" branch in `focusSession`:

```js
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
    return { ok: true, strategy: "wezterm", partial: "pane activated; window raise failed: " + (raise.error || "") };
  }
  return { ok: true, strategy: "wezterm" };
}
```

- [ ] **Step 6D.4: Run — expect 9 pass**

Run: `node --test lib/focus-windows.test.mjs`
Expected: 9 pass.

### 6E: `raiseWezTerm` PowerShell helper

This step has no unit test (it shells out to PowerShell which we don't want to invoke in CI). We'll cover it via the manual smoke test at the end. The unit-test coverage of the orchestration is enough — we can stub it in tests.

- [ ] **Step 6E.1: Implement `raiseWezTerm`**

Add the helper above the `_internal` block:

```js
// Find a wezterm-gui.exe pid + HWND and raise its window. Best-effort:
// returns { ok: true } even when the foreground steal fails (taskbar
// flash is acceptable degradation). Failure modes: PowerShell missing,
// no wezterm-gui.exe running, helper times out.
async function raiseWezTerm() {
  // Step 1: locate the target via PowerShell. We grab pid+HWND of the
  // first wezterm-gui.exe with a non-zero MainWindowHandle. Multi-window
  // disambiguation is out of scope.
  const findScript = [
    "$p = Get-Process wezterm-gui -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if ($null -eq $p) { Write-Output 'NOPROC'; exit 0 }",
    "Write-Output ($p.Id.ToString() + ',' + ([int64]$p.MainWindowHandle).ToString())",
  ].join("; ");

  const findR = await _internal.runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", findScript], { timeoutMs: POWERSHELL_TIMEOUT_MS });
  if (findR.timedOut) return { ok: false, error: "powershell find-window timed out" };
  if (findR.code !== 0) return { ok: false, error: "powershell find-window failed: " + (findR.stderr || "exit " + findR.code).trim() };

  const out = (findR.stdout || "").trim();
  if (!out || out === "NOPROC") return { ok: false, error: "no wezterm-gui.exe with a visible window found" };

  const m = /^(\d+),(\d+)$/.exec(out);
  if (!m) return { ok: false, error: "unparseable powershell output: " + out };
  const procPid = m[1];
  const hwnd = m[2];

  // Step 2: raise. Try AppActivate first (one-line, often works on
  // locked-down Win11). Fall back to AttachThreadInput dance.
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

  const raiseR = await _internal.runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command", raiseScript], { timeoutMs: POWERSHELL_TIMEOUT_MS });
  if (raiseR.timedOut) return { ok: false, error: "powershell raise-window timed out" };
  if (raiseR.code !== 0) return { ok: false, error: "powershell raise-window failed: " + (raiseR.stderr || "exit " + raiseR.code).trim() };
  return { ok: true };
}
```

Update `_internal` to use the real impl:
```js
export const _internal = {
  resolveWeztermCli,
  activatePane,
  raiseWezTerm,
  runCmd,
};
```

- [ ] **Step 6E.2: Run the test suite**

Run: `node --test lib/focus-windows.test.mjs`
Expected: 9 pass (raiseWezTerm not exercised in tests; the orchestration test stubs it).

- [ ] **Step 6E.3: Commit**

```bash
git add lib/focus-windows.mjs lib/focus-windows.test.mjs
git commit -m "lib/focus-windows.mjs: WezTerm pane activation + window raise

Validates the proxy-supplied terminal/terminalPaneId, resolves
wezterm.exe (PATH or default install dir), spawns
'wezterm cli activate-pane', and then raises the wezterm-gui.exe
window via PowerShell (AppActivate first, AttachThreadInput
fallback). Unit tests cover all branches except the real raise."
```

---

## Task 5 (resumed): Daemon dispatch + status mapping

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\daemon.mjs:10, 642-661`

- [ ] **Step 5.3: Update the import line**

At the top of `daemon.mjs`, replace line 10:
```js
import { focusSession } from "./lib/focus.mjs";
```

With:
```js
import { focusSession as focusDarwin } from "./lib/focus.mjs";
import { focusSession as focusWindows } from "./lib/focus-windows.mjs";
```

- [ ] **Step 5.4: Replace the focus handler body**

Find lines 642-661 (the `/session/focus` handler):
```js
if (req.method === "POST" && req.url === "/session/focus") {
  const body = parseBody(await readBody(req), res);
  if (body === null) return;
  if (!requireSessionId(body, res)) return;
  const s = sessions.get(body.sessionId);
  if (!s) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "no such session", sessionId: body.sessionId }));
    return;
  }
  const result = await focusSession({ pid: s.pid });
  // 501 for platform/terminal unsupported, 200 for success, 500 for
  // concrete runtime failures (osascript died, session pid gone, etc.).
  const errMsg = result.error || "";
  const status = result.ok ? 200 : (
    /implemented on macOS|not supported for|invalid session pid/.test(errMsg) ? 501 : 500
  );
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
  return;
}
```

Replace with:
```js
if (req.method === "POST" && req.url === "/session/focus") {
  const body = parseBody(await readBody(req), res);
  if (body === null) return;
  if (!requireSessionId(body, res)) return;
  const s = sessions.get(body.sessionId);
  if (!s) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "no such session", sessionId: body.sessionId }));
    return;
  }
  const platform = process.platform;
  const result = platform === "darwin"
    ? await focusDarwin(s)
    : platform === "win32"
    ? await focusWindows(s)
    : { ok: false, error: "focus not implemented on platform '" + platform + "'", kind: "unsupported", pid: s.pid };
  const status = result.ok ? 200 : (result.kind === "unsupported" ? 501 : 500);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
  return;
}
```

- [ ] **Step 5.5: Syntax check**

Run: `node --check daemon.mjs`
Expected: no output, exit 0.

- [ ] **Step 5.6: Commit**

```bash
git add daemon.mjs
git commit -m "daemon: dispatch /session/focus by platform; map status from result.kind

darwin -> lib/focus.mjs, win32 -> lib/focus-windows.mjs. Other
platforms get a clean 501. Status code derived from result.kind
('unsupported' -> 501, 'runtime'/'timeout' -> 500) rather than
regex-matching the error string."
```

---

## Task 7: Dashboard capability gate + cardSignature

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\data\sessions.html:1108-1143, 1322-1331`

- [ ] **Step 7.1: Update the focus-button gate**

Find line 1108-1111:
```js
li.append(body);
// Focus-terminal button — only when the daemon advertises the capability
// (macOS only). Icon-only; sits between the body and the status pill so
// it's visually balanced and vertically centered by .session's flex.
if (daemonState?.capabilities?.focus) {
```

Replace the `if` line with the union check:
```js
li.append(body);
// Focus-terminal button. caps.focus is the macOS catch-all (any session
// can be targeted via tty walk). caps.focusTerminals is the per-terminal
// allowlist for platforms where only specific terminals are supported
// (Windows + WezTerm). Hidden on cards for which neither applies.
const caps = daemonState?.capabilities;
const focusable = caps?.focus || caps?.focusTerminals?.includes(s.terminal);
if (focusable) {
```

- [ ] **Step 7.2: Update the cardSignature for re-render correctness**

Find line 1322-1330 (the `cSig` computation):
```js
// Capability flags affect per-card DOM (focus button renders only when
// daemon.capabilities.focus is true). Include in the signature so a
// daemon-restart-swap transition triggers a full rebuild that
// adds/removes buttons rather than leaving stale ones.
const cSig = !!daemonState?.capabilities?.focus;
return JSON.stringify([sSig, gSig, pSig, cSig]);
```

Replace with:
```js
// Capability flags affect per-card DOM (focus button renders when
// caps.focus is true OR s.terminal is in caps.focusTerminals). Include
// the full capability shape in the signature so a daemon-restart-swap
// transition (e.g., port-forward to a different platform) triggers a
// full rebuild instead of leaving stale buttons.
const cSig = JSON.stringify([
  !!daemonState?.capabilities?.focus,
  daemonState?.capabilities?.focusTerminals || [],
]);
return JSON.stringify([sSig, gSig, pSig, cSig]);
```

- [ ] **Step 7.3: Add `s.terminal` to per-card signature**

Find lines 1312-1314:
```js
const sSig = sessionsState
  .map((s) => [s.id, s.sessionName || "", s.cwd || ""])
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
```

Replace with:
```js
const sSig = sessionsState
  .map((s) => [s.id, s.sessionName || "", s.cwd || "", s.terminal || ""])
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
```

This ensures a session that re-registers with a newly-detected `terminal` value (e.g., the user moved from cmd into WezTerm) triggers a card rebuild that adds the `↗` button.

- [ ] **Step 7.4: Manual visual check (deferred to integration test)**

The dashboard rendering is hard to unit-test in isolation. We'll verify in the smoke test (Task 9).

- [ ] **Step 7.5: Commit**

```bash
git add data/sessions.html
git commit -m "dashboard: per-session focus-button gate (caps.focus || focusTerminals)

The button now renders for any darwin session (catch-all) OR for a
session whose s.terminal is in the daemon's focusTerminals list
(win32 + wezterm). cardSignature includes both the per-card terminal
field and the full capability shape so daemon-swap and re-register
events trigger correct rebuilds."
```

---

## Task 8: package.json — test glob + files exclude

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\package.json`

- [ ] **Step 8.1: Update `scripts.test`**

Find:
```json
"test": "node --test lib/host/",
```

Replace with:
```json
"test": "node --test lib/ data/",
```

(`lib/` recursively picks up `lib/host/*.test.mjs` and the new `lib/focus.test.mjs` + `lib/focus-windows.test.mjs`. `data/` adds `data/theme.test.mjs` which existed but wasn't in the script.)

- [ ] **Step 8.2: Update the `files` exclusion**

Find:
```json
"!lib/host/__fixtures__",
"!lib/host/*.test.mjs"
```

Replace with:
```json
"!lib/host/__fixtures__",
"!lib/**/*.test.mjs"
```

- [ ] **Step 8.3: Sanity-check the test glob picks up everything**

Run: `node --test lib/ data/`
Expected: all tests pass (the existing host tests + the new focus tests + theme test). Output count: 9 focus-windows tests + 2 focus tests + N host tests + theme tests, all passing.

- [ ] **Step 8.4: Commit**

```bash
git add package.json
git commit -m "package.json: widen test glob to lib/ + data/, exclude all lib test files

Picks up lib/focus*.test.mjs and the previously-orphaned
data/theme.test.mjs. The new !lib/**/*.test.mjs exclusion keeps
test files out of the published npm artifact regardless of subdir
they live in."
```

---

## Task 9: Manual smoke test in real WezTerm

**No file changes.** Verification only.

- [ ] **Step 9.1: Launch a WezTerm window and start the daemon**

Open a fresh WezTerm window. In its shell, run:
```bash
cd C:/Users/parkc/repos_p/sessions-dashboard
node bin/sessions-dashboard.mjs
```

Wait for the daemon to listen on 127.0.0.1:8787.

- [ ] **Step 9.2: Verify capabilities exposed correctly**

In another shell:
```bash
curl -s http://127.0.0.1:8787/sessions | python -m json.tool | head -40
```

Expected: `daemon.capabilities` = `{ "focus": false, "focusTerminals": ["wezterm"] }`.

- [ ] **Step 9.3: Register a fake session manually with WEZTERM_PANE info**

In a WezTerm pane (so WEZTERM_PANE is set), POST a register payload manually:
```bash
echo "WEZTERM_PANE=$WEZTERM_PANE"
curl -s -X POST http://127.0.0.1:8787/session/register \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"smoke-1\",\"pid\":$$,\"terminal\":\"wezterm\",\"terminalPaneId\":\"$WEZTERM_PANE\",\"cwd\":\"$PWD\"}"
```

Expected: `{"ok":true,...}`.

Then check it appears in /sessions with the right terminal field:
```bash
curl -s http://127.0.0.1:8787/sessions | python -m json.tool | grep -A2 smoke-1
```

- [ ] **Step 9.4: Spawn a second WezTerm pane and trigger /session/focus**

Open a second WezTerm pane (Ctrl+Shift+Alt+%, or use the menu). Then in that pane (or in the current one), trigger focus on the registered session:
```bash
curl -s -X POST http://127.0.0.1:8787/session/focus \
  -H "content-type: application/json" \
  -d '{"sessionId":"smoke-1"}'
```

Expected: `{"ok":true,"strategy":"wezterm"}`. WezTerm should switch active pane to the one whose pane id you registered, AND raise the WezTerm window.

- [ ] **Step 9.5: Test the negative path — non-WezTerm session**

```bash
curl -s -X POST http://127.0.0.1:8787/session/register \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"smoke-2\",\"pid\":$$,\"terminal\":null,\"cwd\":\"$PWD\"}"

curl -i -X POST http://127.0.0.1:8787/session/focus \
  -H "content-type: application/json" \
  -d '{"sessionId":"smoke-2"}'
```

Expected: HTTP 501, body `{"ok":false,"kind":"unsupported","error":"session not running inside WezTerm..."}`.

- [ ] **Step 9.6: Test the dashboard end-to-end**

Open the dashboard:
```bash
node -e "import('http').then(http => { const req = http.request({hostname:'127.0.0.1',port:8787,path:'/call',method:'POST',headers:{'content-type':'application/json'}}, r => r.on('data', d => process.stdout.write(d))); req.write(JSON.stringify({op:'open_dashboard',args:{name:'sessions'},sessionId:'manual-test'})); req.end(); })"
```

Then visually verify:
- The card for `smoke-1` has the `↗` button.
- The card for `smoke-2` does NOT have the button.
- Clicking `↗` on smoke-1 raises WezTerm and switches to the right pane.

- [ ] **Step 9.7: Cleanup test sessions**

```bash
curl -s -X POST http://127.0.0.1:8787/session/unregister -H "content-type: application/json" -d '{"sessionId":"smoke-1"}'
curl -s -X POST http://127.0.0.1:8787/session/unregister -H "content-type: application/json" -d '{"sessionId":"smoke-2"}'
```

- [ ] **Step 9.8: Stop the daemon**

Ctrl+C the daemon process.

If anything in 9.1-9.7 failed, debug and fix before proceeding. Common issues:
- WezTerm CLI version too old → check `wezterm cli activate-pane --help`
- PowerShell helper failing → run the script manually in pwsh and inspect
- Pane id stale (pane was closed) → refresh
- AppActivate returning false but window still raising → fine

---

## Task 10: Bump version + brief README mention

**Files:**
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\package.json`
- Modify: `C:\Users\parkc\repos_p\sessions-dashboard\README.md` (if a relevant section exists)

- [ ] **Step 10.1: Bump version**

Find `"version": "0.4.6"` in package.json. Bump to `"version": "0.5.0"`.

- [ ] **Step 10.2: README mention (best-effort)**

Quick scan: `grep -n -i "focus" README.md`. If there's a section that mentions the focus feature, add a one-liner that it now works on Windows + WezTerm too. If not, skip — not worth inventing a new section.

- [ ] **Step 10.3: Commit**

```bash
git add package.json README.md
git commit -m "0.5.0: focus-tab support for WezTerm on Windows

The dashboard's '↗' focus-this-session-terminal button now works
for sessions running inside WezTerm on Windows. Other Windows
terminals (cmd, pwsh, git-bash, Windows Terminal, ConEmu) hide
the button.

Detection is proxy-side via WEZTERM_PANE env var. Daemon advertises
capabilities.focusTerminals: ['wezterm'] on win32; the dashboard
gates the button on caps.focus || caps.focusTerminals.includes(s.terminal).

See docs/superpowers/specs/2026-04-27-focus-tab-windows-design.md."
```

---

## Self-Review Notes

Coverage check against spec sections:

- [x] Proxy detects `WEZTERM_PANE` (Task 1)
- [x] Daemon stores + projects + validates terminalPaneId (Task 2)
- [x] capabilities.focusTerminals (Task 3)
- [x] lib/focus.mjs returns kind (Task 4)
- [x] lib/focus-windows.mjs implementation (Task 6 A-E)
- [x] Daemon dispatch + status mapping (Task 5)
- [x] Dashboard gate + cardSignature (Task 7)
- [x] package.json (Task 8)
- [x] Manual smoke test (Task 9)
- [x] Version bump + README (Task 10)

Out-of-scope from spec (correctly NOT in this plan):
- WSL handling
- Windows Terminal / ConEmu support
- macOS proxy-side TERM_PROGRAM detection
- tmux-on-Windows
