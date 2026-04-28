# Focus-tab on Windows (WezTerm)

**Status:** Draft (2026-04-27)
**Branch:** `focus-tab-win`

## Summary

Extend the dashboard's existing "focus this session's terminal" feature
(`↗` button) to work for sessions running inside WezTerm on Windows. The
button currently only renders on macOS (`capabilities.focus = darwin`)
and uses AppleScript to walk Terminal.app / iTerm tabs by tty.

On Windows the button will render only on **WezTerm-hosted sessions**,
identified by the `WEZTERM_PANE` env var the proxy reads at register
time. A click activates the pane via `wezterm cli activate-pane` and
raises the WezTerm GUI window via a small Win32 helper.

Other Windows terminals (Windows Terminal, ConEmu, cmd, pwsh, git-bash,
Alacritty) are **out of scope for this PR**. The architecture leaves
room for them as future per-terminal additions.

## Motivation

The dashboard is a multi-session overview. A frequent want is "I see
the session that's idle waiting for input — take me there." On macOS
that's one click. On Windows today the button doesn't exist, so the
user has to alt-tab and remember which window held which Claude.

WezTerm is a heavily-used cross-platform terminal with a clean control
CLI, so it's the natural first Windows target. Other terminals have
either no control surface (cmd, git-bash) or a much messier one
(Windows Terminal's broker model) — those wait for separate work.

## Non-goals

- **Windows Terminal, ConEmu, Alacritty, cmd, pwsh, git-bash, Hyper, Tabby support.** Not in this PR.
- **WSL-hosted sessions inside WezTerm.** Env vars are dropped at the
  WSL boundary unless the user has `WSLENV=WEZTERM_PANE/u`. We don't
  configure that. WSL sessions will simply not show the button.
- **tmux-on-Windows handling.** Rare; out of scope. The macOS
  tmux+terminal codepath is not ported.
- **Multiple WezTerm GUI processes / multiplexer routing.** If the
  user runs more than one wezterm-gui.exe, `wezterm cli` will hit
  whichever the auto-detect picks. Acceptable v1 limitation.
- **Refactoring the macOS code.** No changes to `lib/focus.mjs` or its
  tests beyond what the dispatcher needs.

## Key insight that shaped the design

The first plan was "walk the session pid's parents to find a terminal,
then enumerate WezTerm panes by leader pid." Verification on the
target machine showed:

- `wezterm cli list --format json` does **not** emit a `pid` per pane.
  Fields are `window_id`, `tab_id`, `pane_id`, `workspace`, `cwd`,
  `title`, `tty_name` (null on Windows), and a few cursor fields.
- WezTerm sets `WEZTERM_PANE=<pane-id>` in every shell it spawns. This
  env var is inherited by child processes, including the Claude CLI
  and the MCP proxy.

The proxy already lives inside the session's process tree and has its
own `process.env`. So the cleanest way to identify the host terminal
is **proxy-side at register time**, not via the daemon walking the
process tree from outside. This avoids:

- Native modules / WMI parent-walks
- Reading another process's environment (PEB/NtQuery — no good
  cross-Windows-version answer)
- Disambiguating multiple panes with the same cwd

The same pattern (`TERM_PROGRAM` / pane-id env vars) generalizes to
future terminals (Kitty's `KITTY_WINDOW_ID`, ConEmu's `ConEmuPID`,
Windows Terminal's `WT_SESSION`).

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Inside the session (proxy = index.mjs)                           │
│                                                                  │
│  registerSession() reads process.env.WEZTERM_PANE and adds:      │
│    terminal: "wezterm"                                           │
│    terminalPaneId: "<pane-id>"                                   │
│  to the /session/register POST body.                             │
└──────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ Daemon (daemon.mjs)                                              │
│                                                                  │
│  /session/register: stores terminal + terminalPaneId on the      │
│  session record (preserves across re-registers, like host).      │
│                                                                  │
│  /sessions: projects terminal + terminalPaneId per session.      │
│                                                                  │
│  capabilities.focus is true on darwin OR win32. The dashboard    │
│  decides per-session.                                            │
│                                                                  │
│  /session/focus: dispatches by process.platform:                 │
│    darwin → lib/focus.mjs (unchanged)                            │
│    win32  → lib/focus-windows.mjs (new)                          │
└──────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ lib/focus-windows.mjs                                            │
│                                                                  │
│  focusSession({ pid, terminal, terminalPaneId }):                │
│    if terminal !== "wezterm" → 501-style "not supported" error   │
│    if !terminalPaneId        → 500-style "pane id missing"       │
│                                                                  │
│    1. Resolve wezterm.exe (PATH first, then WEZTERM_EXECUTABLE   │
│       sibling).                                                  │
│    2. Run: wezterm cli activate-pane --pane-id <id>              │
│    3. Find a wezterm-gui.exe pid + HWND, raise it via Win32      │
│       AttachThreadInput + SetForegroundWindow (PowerShell        │
│       helper).                                                   │
│    4. Return { ok: true, strategy: "wezterm" }                   │
└──────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ Dashboard (data/sessions.html)                                   │
│                                                                  │
│  Per-card focus button gate:                                     │
│    const focusable =                                             │
│      caps.focus &&                                               │
│      (daemon.platform === "darwin" || s.terminal === "wezterm"); │
│  Add s.terminal to cardSignature() so re-detect rebuilds card.   │
└──────────────────────────────────────────────────────────────────┘
```

## Components

### Proxy: terminal detection (`index.mjs`)

A single helper near the top of the file:

```js
function detectHostTerminal() {
  if (process.env.WEZTERM_PANE) {
    return { terminal: "wezterm", terminalPaneId: process.env.WEZTERM_PANE };
  }
  return { terminal: null, terminalPaneId: null };
}
```

Called at every `registerSession()` and merged into the POST body.
Detection runs on every register (cheap; just an env read), so a
restart-relaunch in a new pane updates correctly.

Why proxy-side (not daemon-side):
- The proxy already has the env via `process.env`. The daemon would
  need to read another process's env — not portably possible on
  Windows without native deps.
- Mirrors how `host` (claude/gemini/codex) is already proxy-side and
  passed in at register.

### Daemon: storage and dispatch (`daemon.mjs`)

1. **Register handler** (line ~559): destructure `terminal`,
   `terminalPaneId` from body. Store on the session record with the
   same "preserve across re-registers via `prev?.field`" pattern used
   for `host` and `gitBranch`. (A re-register with `terminal=null`
   from an older proxy must not wipe a previously-detected terminal.)

2. **listSessions** (line ~372): project both fields.

3. **Capabilities** (line ~400): change to
   `{ focus: process.platform === "darwin" || process.platform === "win32" }`.
   Add `platform: process.platform` to the daemon block in the
   `/sessions` response so the dashboard can gate per platform.

4. **Focus handler** (line ~642): replace the static
   `import { focusSession } from "./lib/focus.mjs"` with a
   platform-conditional dispatch. Pass the full session record (not
   just `{ pid }`).

5. **Status code mapping**: extend the regex on line ~657 with a
   "wezterm not on PATH" / "session not in WezTerm" pattern → 501
   (capability gap) vs 500 (runtime failure).

### `lib/focus-windows.mjs` (new)

Public surface:

```js
export async function focusSession({ pid, terminal, terminalPaneId }) {
  // returns { ok: true, strategy: "wezterm" }
  //      | { ok: false, error, pid }
}
```

Internal helpers:

- `resolveWeztermCli()` — checks PATH for `wezterm`. On miss, derives
  from `WEZTERM_EXECUTABLE` (set by WezTerm in spawned env, also set
  in the proxy's env so the daemon may not have it; fall back to a
  small list of common install dirs: `C:\Program Files\WezTerm\wezterm.exe`).
  Returns the absolute path or `null`.
- `activatePane(weztermPath, paneId)` — spawn `wezterm cli activate-pane --pane-id <n>`. Strict integer validation on paneId before spawn.
- `findWezTermHwnd()` — runs PowerShell:
  `Get-Process wezterm-gui -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty MainWindowHandle`. Returns HWND as an integer string, or null.
- `raiseWindow(hwnd)` — runs an embedded PowerShell that uses
  `Add-Type` to define a tiny C# class with `AttachThreadInput` +
  `ShowWindowAsync(SW_RESTORE)` + `SetForegroundWindow`. Best-effort:
  swallow failures, return ok regardless of whether the foreground
  steal succeeded (taskbar flash is acceptable degradation on
  locked-down Win11).

Subprocess discipline (mirrors `lib/focus.mjs`):
- Use `spawn` with argv arrays. Never shell strings.
- All numeric / string interpolations validated by regex first.
- 5-second timeout per spawn.

### `lib/focus.mjs` (unchanged)

Keep macOS code intact. The dispatch is at the daemon layer, not
inside `lib/focus.mjs`.

### Dashboard (`data/sessions.html`)

1. **Capability gate** (line 1111): change
   `if (daemonState?.capabilities?.focus)` to:
   ```js
   const focusable =
     daemonState?.capabilities?.focus &&
     (daemonState?.platform === "darwin" || s.terminal === "wezterm");
   if (focusable) { /* render button */ }
   ```
   (`daemonState` is `sData.daemon` per `data/sessions.html:1569`, so
   `daemonState?.platform` reads the new field directly. macOS keeps
   the existing "all sessions" behavior for backwards compat;
   per-session detection is Windows-only in v1.)

2. **cardSignature** (line ~1322): add `s.terminal` to the per-card
   tuple AND extend the daemon-state portion (`cSig`, line ~1329) to
   include `daemonState?.platform`. Without the per-card field, a
   session that re-registers with a new `terminal` value won't rebuild
   to add/remove the button. Without the platform field on the daemon
   sig, swapping a Windows daemon ↔ macOS daemon (e.g., remote-port
   forwarding scenario) won't trigger the bulk rebuild.

3. **Tooltip**: extend the focus button title to read
   `"Focus this session's terminal tab"` already says enough; no
   change needed.

4. **No changes** to the toast wiring or the POST body.

### Tests (`lib/focus-windows.test.mjs`, new)

Pure-logic tests (no real WezTerm or Win32 calls):

1. `focusSession returns clear error when terminal !== "wezterm"` —
   covers cmd / pwsh / git-bash sessions.
2. `focusSession returns clear error when terminalPaneId is missing` —
   covers a malformed register payload.
3. `focusSession rejects non-numeric terminalPaneId` — security: ensure
   `--pane-id "; rm -rf /"` is impossible. Argv-based spawn means it
   cannot become a shell injection, but we still want strict shape
   validation upstream.
4. `focusSession returns "wezterm CLI not found" when resolver returns null`
   — the resolver is mocked to return null. No real spawn.
5. `focusSession success path` — resolver returns a path, the
   `activatePane` and `raiseWindow` helpers are stubbed to succeed,
   and the function returns `{ ok: true, strategy: "wezterm" }`.

The harness uses `node --test`, matching the existing
`lib/host/*.test.mjs` style. To make `npm test` pick up the new file,
update `package.json`'s `test` script from
`node --test lib/host/` to `node --test lib/host/ lib/`.

(`data/theme.test.mjs` already exists outside the host glob and isn't
picked up either — that's a pre-existing gap, not something we'd fix
in this PR. Mention in PR description.)

### `package.json`

Two changes:

1. **`scripts.test`**: change from `node --test lib/host/` to
   `node --test lib/host/ lib/`. Picks up the new `lib/focus-windows.test.mjs`
   without re-globbing the host directory.
2. **`files`**: add `"!lib/*.test.mjs"` to the exclude list.
   `lib/host/*.test.mjs` is already excluded; without an analogous rule
   for `lib/`, the new `lib/focus-windows.test.mjs` would ship in the npm
   artifact.

### Documentation

- **README.md**: a one-line addition under whatever section mentions
  the focus button (none currently — the feature lives in
  `lib/focus.mjs`'s comments). If there isn't one, add a short
  paragraph in the README's feature list.
- **CHANGELOG / version bump**: bump to `0.5.0` (new platform
  capability is feature-level, not patch-level).

## Data flow (end-to-end click)

1. User clicks `↗` on a WezTerm-hosted session card.
2. Dashboard POSTs `{ sessionId }` to `/session/focus`.
3. Daemon looks up the session: `{ pid, terminal: "wezterm", terminalPaneId: "5", ... }`.
4. Daemon's platform branch loads `lib/focus-windows.mjs` and calls
   `focusSession({ pid, terminal, terminalPaneId })`.
5. Module resolves `wezterm.exe` path.
6. Spawns `wezterm cli activate-pane --pane-id 5`. WezTerm's mux
   server flips the active pane.
7. Spawns PowerShell helper to find wezterm-gui.exe HWND and raise it.
8. Returns `{ ok: true, strategy: "wezterm" }`. Daemon → 200.
9. Dashboard's button releases its `focus-btn-active` class. WezTerm
   is now front, with the right pane active.

## Error handling

| Condition | Returned shape | HTTP |
|---|---|---|
| `terminal === null` | `{ ok: false, error: "session not running inside a supported terminal", pid }` | 501 |
| `terminal === "wezterm"`, `terminalPaneId` missing | `{ ok: false, error: "wezterm session has no pane id (proxy too old?)", pid }` | 500 |
| `wezterm.exe` not found | `{ ok: false, error: "wezterm CLI not found on PATH", pid }` | 501 |
| `wezterm cli activate-pane` fails (mux server gone, pane closed) | `{ ok: false, error: "wezterm activate-pane failed: <stderr>", pid }` | 500 |
| `wezterm cli` succeeds but window-raise PowerShell fails | `{ ok: true, strategy: "wezterm", partial: "pane activated; window raise failed" }` | 200 |
| Spawn timeout | `{ ok: false, error: "wezterm cli timed out", pid, timedOut: true }` | 500 |

The dashboard's existing `showToast("Focus: " + msg, "warn")` already
formats these for the user.

## Security

Same posture as macOS path:
- All spawns use argv arrays, never shell strings.
- `terminalPaneId` validated with `/^\d+$/` before any spawn.
- The pid in the response is from our own session registry, never the
  HTTP body. Already the case for `/session/focus`.
- The PowerShell helper is built from a static template; no untrusted
  string interpolation. The HWND value from `Get-Process` is consumed
  numerically.
- No new HTTP surface. No new file writes.

## Window-raise implementation detail

The `AttachThreadInput` trick (template — `<HWND>` is replaced
at runtime with the integer HWND from `findWezTermHwnd()`):

```powershell
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$h = [IntPtr]<HWND>
$fg = [W]::GetForegroundWindow()
$me = [W]::GetCurrentThreadId()
[W]::GetWindowThreadProcessId($fg, [ref]$null) | Out-Null
$fgT = [W]::GetWindowThreadProcessId($fg, [ref]$null)
[W]::AttachThreadInput($me, $fgT, $true) | Out-Null
[W]::ShowWindowAsync($h, 9) | Out-Null  # SW_RESTORE
[W]::SetForegroundWindow($h) | Out-Null
[W]::AttachThreadInput($me, $fgT, $false) | Out-Null
```

PowerShell cold-start is 200-500ms. Acceptable for a click-driven
action with existing 300ms button-press feedback animation.

## Future work (intentionally not in this PR)

- **Per-terminal pluggability.** Generalize the proxy-side detector
  into a small registry: `[{ envVar: "WEZTERM_PANE", terminal: "wezterm" }, { envVar: "KITTY_WINDOW_ID", terminal: "kitty" }, ...]`. Daemon dispatches focus by `terminal`.
- **Windows Terminal best-effort raise.** No tab pick (broker model
  precludes it), but window-raise alone is sometimes useful.
- **macOS proxy-side detection.** Move `TERM_PROGRAM` detection from
  `lib/focus.mjs`'s `psEnv` into the proxy. Eliminates the macOS
  child-env-read code path. Pure refactor; not driven by Windows
  work.
- **WSL-in-WezTerm**: requires `WSLENV` setup; doc-only at most.

## Open questions resolved

- **Q: Window-raise mechanism?** A: PowerShell + `AttachThreadInput`.
  Pure stdlib (no native deps). Hit-or-miss on locked-down Win11
  builds, but degrades to a taskbar flash, not a hard error.
- **Q: What about non-WezTerm Windows sessions?** A: Per-session
  capability — button is hidden for them. Discussed and approved.
- **Q: Where to put the new code?** A: `lib/focus-windows.mjs`
  parallel to `lib/focus.mjs`. Daemon dispatches by platform.

## Risks

1. **WezTerm version drift.** The user's installed version is
   2024-02-03. If they upgrade to a much newer release, the CLI
   surface should remain backwards-compatible (WezTerm has been
   careful here). Low risk.
2. **Multiple wezterm-gui.exe processes.** If the user has multiple
   independent WezTerm windows from the same install, the CLI will
   route to one; we'll raise "first wezterm-gui.exe with non-zero
   MainWindowHandle." This may not be the right one. Acceptable v1
   limitation; most users have one.
3. **`SetForegroundWindow` restriction on Win11 22H2+.** Some users
   will see only a taskbar flash. Documented as best-effort.
4. **Session still registered after WezTerm pane closed.** The
   stored `terminalPaneId` becomes invalid. `wezterm cli activate-pane` will
   error; we surface it as a clean error toast.
