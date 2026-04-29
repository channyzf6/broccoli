// Cross-platform installer logic. Detects which supported CLIs (Claude
// Code, Gemini CLI, Codex CLI) are on PATH and runs each one's `mcp add`
// to register sessions-dashboard. Replaces the bespoke bash + PowerShell
// install scripts with a single JS module so the npm-published binary
// can ship the same logic as the git-clone install scripts (which now
// thin-shim into this module via `node bin/sessions-dashboard.mjs install`).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Env vars that need to reach the proxy process so focus-tab works.
// Two consumers read these:
//   - WEZTERM_*        : proxy-side `detectHostTerminal()` stamps a
//                        terminal/pane id at /session/register time
//                        (Windows + WezTerm focus path).
//   - TERM_PROGRAM,
//     TMUX, TMUX_PANE  : daemon-side `lib/focus.mjs psEnv(pid)` reads
//                        them off the proxy via `ps -Eww` to pick the
//                        macOS focus strategy (Apple_Terminal /
//                        iTerm.app / tmux-inside-either).
// Codex doesn't inherit parent env into spawned MCP servers, so we
// have to list these explicitly via its `env_vars` config field.
// Claude/Gemini inherit parent env by default and need no equivalent.
const TERMINAL_INHERITED_ENV = [
  "WEZTERM_PANE",
  "WEZTERM_UNIX_SOCKET",
  "TERM_PROGRAM",
  "TMUX",
  "TMUX_PANE",
];

const SUPPORTED_CLIS = ["claude", "gemini", "codex"];

// Per-CLI registration flag profiles.
//
// scope: claude/gemini take `--scope user` to mean "register globally
//        for this user, not per-project." Codex doesn't accept that
//        flag — its `mcp add` is global by default and erroring out on
//        `--scope` is the documented behavior.
//
// env:   pin the host explicitly for every CLI. Without this, the
//        proxy's cold-start dir-probe in registry.mjs picks "the host
//        with the most-recent transcript mtime in this cwd" — which
//        gets the wrong answer in any mixed-host scenario. Pinning
//        skips the probe entirely; the dir-probe stays as fallback for
//        manual-install users who edit settings.json without running
//        this installer.
//
// dashSeparator: claude (Commander.js) and codex (custom parser) treat
//        `--` as the boundary between the registration flags and the
//        invoked command, AND propagate everything after `--` as
//        positional args. Gemini's parser is yargs, which treats `--`
//        as "end of options" and shoves the post-`--` content into a
//        SEPARATE bucket (`argv["--"]`) — meaning `gemini mcp add` only
//        sees the `<name>` positional and errors with "Not enough non-
//        option arguments: got 1, need at least 2". For gemini we drop
//        the `--` and pass the command + args inline as positionals;
//        yargs is happy to accept `-y` and similar dash-prefixed
//        items as positional values when they follow the required
//        positionals (verified against gemini-cli 0.39.x).
const FLAG_PROFILES = {
  claude: { scope: ["--scope", "user"], env: ["--env", "SESSIONS_DASHBOARD_HOST=claude"], dashSeparator: true },
  gemini: { scope: ["--scope", "user"], env: ["--env", "SESSIONS_DASHBOARD_HOST=gemini"], dashSeparator: false },
  codex:  { scope: [],                    env: ["--env", "SESSIONS_DASHBOARD_HOST=codex"],  dashSeparator: true },
};

// Spawn options shared across all child invocations. shell:true is
// load-bearing on Windows where dev CLIs are typically .cmd shims that
// node can't exec directly. windowsHide:true suppresses the flash of
// a console window when running under a GUI parent.
const SPAWN_OPTS = { shell: true, windowsHide: true };

// Cheap PATH-existence check — try to spawn `<cli> --version` and see
// if it returns a normal exit code. Equivalent to `command -v` / `where`
// without the cross-platform shell-builtin headache.
export function commandExists(cmd) {
  try {
    const r = spawnSync(cmd, ["--version"], { ...SPAWN_OPTS, stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Returns the list of supported CLIs that are present on PATH, in
// declaration order (claude, gemini, codex).
export function detectClis() {
  return SUPPORTED_CLIS.filter(commandExists);
}

// Read the version we're running as. Used to pin the npx invocation in
// registered MCP entries so user CLIs spawn THIS version, not whatever
// happens to be latest at the time of next mcp child spawn.
function readPackageVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

// Resolve the absolute path to bin/sessions-dashboard.mjs in the
// currently-running checkout. Used in --local mode (contributor flow)
// to register a node-direct invocation against the working tree.
function localDispatcherPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "bin", "sessions-dashboard.mjs");
}

// Register a single CLI. Throws on failure; caller decides whether to
// tolerate. Idempotent — runs `mcp remove` first to clear any prior
// registration so re-running is a clean update rather than a duplicate
// error.
export function registerCli(cli, { command, args }) {
  const profile = FLAG_PROFILES[cli];
  if (!profile) throw new Error(`unknown CLI: ${cli}`);

  // Best-effort cleanup of prior registration. Suppress all output and
  // ignore the exit code — first-time installs have nothing to remove,
  // which is "fine."
  spawnSync(cli, ["mcp", "remove", "sessions-dashboard", ...profile.scope], {
    ...SPAWN_OPTS,
    stdio: "ignore",
  });

  // Now register. Inherit stdio so the user sees the CLI's own output.
  // Per-CLI: `--` separator for claude/codex, inline positionals for
  // gemini (see FLAG_PROFILES.dashSeparator note above).
  const args0 = [
    "mcp", "add", "sessions-dashboard",
    ...profile.scope,
    ...profile.env,
    ...(profile.dashSeparator ? ["--", command, ...args] : [command, ...args]),
  ];
  const r = spawnSync(cli, args0, { ...SPAWN_OPTS, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`${cli} mcp add exited ${r.status}`);
  }

  // Codex doesn't have an `--env-var` flag for inheritance, only --env
  // (literal value). Without env_vars, the keys listed in
  // TERMINAL_INHERITED_ENV never reach our proxy and the focus-tab
  // path can't tell which terminal hosts the session. Post-edit
  // ~/.codex/config.toml to inject env_vars after the
  // [mcp_servers.sessions-dashboard] header. Other CLIs inherit parent
  // env by default and need no equivalent fix.
  if (cli === "codex") {
    try { ensureCodexEnvVars(); } catch (e) {
      // Non-fatal: registration itself succeeded; this just means the
      // focus button won't show for wezterm-hosted codex sessions.
      // Surface so the user can fix manually.
      console.error(`    (note: failed to inject env_vars into codex config — ${e.message})`);
    }
  }
}

// Edit ~/.codex/config.toml to add `env_vars = [...]` to the
// [mcp_servers.sessions-dashboard] section. Idempotent: replaces an
// existing env_vars line if present, otherwise inserts one immediately
// after the section header. Atomic write via temp + rename.
export function ensureCodexEnvVars(configPath) {
  const fp = configPath || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  if (!existsSync(fp)) return; // codex hasn't created it yet — nothing to patch
  const original = readFileSync(fp, "utf8");
  const patched = patchCodexEnvVars(original, TERMINAL_INHERITED_ENV);
  if (patched !== original) writeFileSync(fp, patched);
}

// Pure-function patcher. Exported for tests.
export function patchCodexEnvVars(toml, names) {
  const header = "[mcp_servers.sessions-dashboard]";
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return toml; // section not present — nothing to do
  // Find the END of our section: the next line that starts a different
  // table ("[" at column 0) or end-of-file.
  const afterHeader = headerIdx + header.length;
  const restAfter = toml.slice(afterHeader);
  const nextSectionRel = restAfter.search(/\n\[/);
  const sectionEnd = nextSectionRel === -1 ? toml.length : afterHeader + nextSectionRel;
  const sectionBody = toml.slice(afterHeader, sectionEnd);
  // TOML-quote each name as a basic string. Names are alphanumeric+_
  // env-var identifiers — no escaping needed, but JSON.stringify gives
  // a safe quoted form.
  const newLine = `env_vars = [${names.map((n) => JSON.stringify(n)).join(", ")}]`;
  // Replace existing env_vars line in this section, or insert after
  // the header line.
  const envVarsLineRe = /^env_vars\s*=.*$/m;
  if (envVarsLineRe.test(sectionBody)) {
    const newBody = sectionBody.replace(envVarsLineRe, newLine);
    return toml.slice(0, afterHeader) + newBody + toml.slice(sectionEnd);
  }
  // Insert on the line right after the header. The header is followed
  // by a newline; insert after that newline.
  const headerLineEnd = afterHeader + (toml[afterHeader] === "\n" ? 1 : 0);
  return toml.slice(0, headerLineEnd) + newLine + "\n" + toml.slice(headerLineEnd);
}

// Remove our MCP registration from a single CLI. Returns true on success.
export function unregisterCli(cli) {
  const profile = FLAG_PROFILES[cli];
  if (!profile) throw new Error(`unknown CLI: ${cli}`);
  const r = spawnSync(cli, [
    "mcp", "remove", "sessions-dashboard",
    ...profile.scope,
  ], { ...SPAWN_OPTS, stdio: "inherit" });
  return r.status === 0;
}

// Top-level install orchestration. Detects CLIs, registers each one.
// Tolerates per-CLI failure. Exits 1 if zero CLIs were on PATH so
// CI / scripted callers can tell.
//
// Chromium is downloaded by the npm `postinstall` script in
// package.json (`playwright install chromium`) — that runs during
// `npm install` / `npx` package fetch, BEFORE this subcommand. We
// don't redundantly invoke Playwright here. Earlier versions did
// (v0.4.0–v0.4.2 had a `prefetchChromium` step) but it triggered
// Playwright's `isLikelyNpxGlobal` warning whenever the user ran
// `npx -y sessions-dashboard install` — that check is a literal
// substring match for `_npx` in `process.argv[1]`, and our package
// always lives inside npx's `_npx` cache when invoked that way, so
// there's no env / cwd / invocation tweak that bypasses it. Letting
// `postinstall` handle Chromium avoids the second invocation
// entirely. The `--ignore-scripts` edge case (Chromium downloads
// lazily on first dashboard open) is rare and acceptable.
//
// command/args override how MCP children should invoke this server.
// Defaults to `npx -y sessions-dashboard@<pinned-version>` so the
// registered entry survives a `npm uninstall -g sessions-dashboard`.
// In --local mode (contributor flow) we register a `node <local-path>`
// invocation so the working tree is what gets exercised, not the
// published package.
export async function install({ local = false, command, args, log = console.log } = {}) {
  let cmd, cmdArgs;
  if (command && args) {
    cmd = command;
    cmdArgs = args;
  } else if (local) {
    cmd = "node";
    cmdArgs = [localDispatcherPath()];
  } else {
    cmd = "npx";
    cmdArgs = ["-y", `sessions-dashboard@${readPackageVersion()}`];
  }

  log("[1/2] registering sessions-dashboard with detected CLIs");
  const detected = detectClis();
  if (detected.length === 0) {
    log("");
    log("ERROR: no supported CLI found on PATH.");
    log("Install one of: claude, gemini, codex — then re-run this installer.");
    log("Or register manually:");
    log("");
    log(`  <cli> mcp add sessions-dashboard --scope user --env SESSIONS_DASHBOARD_HOST=<cli> -- ${cmd} ${cmdArgs.join(" ")}`);
    log("");
    process.exit(1);
  }

  let registered = 0;
  for (const cli of detected) {
    log(`  - ${cli} detected`);
    try {
      registerCli(cli, { command: cmd, args: cmdArgs });
      registered += 1;
    } catch (e) {
      log(`    (registration with ${cli} failed; continuing — ${e.message})`);
    }
  }

  log("");
  log(`[2/2] done — registered with ${registered} CLI(s).`);
  log("Restart your CLI(s), then ask one of them:");
  log("");
  log('    "Open the sessions dashboard"');
  log("");
  log("  The CLI invokes mcp__sessions-dashboard__open_dashboard and a live");
  log("  browser window appears showing every connected session across all");
  log("  registered CLIs.");
}

// Top-level uninstall orchestration. Removes the MCP registration from
// each detected CLI. Doesn't touch the npm package itself — the user
// runs `npm uninstall -g sessions-dashboard` separately if they want
// to remove the package too.
export async function uninstall({ log = console.log } = {}) {
  log("Removing sessions-dashboard MCP registration from detected CLIs:");
  const detected = detectClis();
  if (detected.length === 0) {
    log("  (no supported CLIs on PATH — nothing to do)");
    return;
  }
  let removed = 0;
  for (const cli of detected) {
    log(`  - ${cli}`);
    if (unregisterCli(cli)) removed += 1;
  }
  log("");
  log(`done — removed from ${removed} CLI(s).`);
  log("To also remove the npm package itself: npm uninstall -g sessions-dashboard");
}
