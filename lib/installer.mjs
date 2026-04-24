// Cross-platform installer logic. Detects which supported CLIs (Claude
// Code, Gemini CLI, Codex CLI) are on PATH and runs each one's `mcp add`
// to register sessions-dashboard. Replaces the bespoke bash + PowerShell
// install scripts with a single JS module so the npm-published binary
// can ship the same logic as the git-clone install scripts (which now
// thin-shim into this module via `node bin/sessions-dashboard.mjs install`).

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
const FLAG_PROFILES = {
  claude: { scope: ["--scope", "user"], env: ["--env", "SESSIONS_DASHBOARD_HOST=claude"] },
  gemini: { scope: ["--scope", "user"], env: ["--env", "SESSIONS_DASHBOARD_HOST=gemini"] },
  codex:  { scope: [],                    env: ["--env", "SESSIONS_DASHBOARD_HOST=codex"] },
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
  const args0 = [
    "mcp", "add", "sessions-dashboard",
    ...profile.scope,
    ...profile.env,
    "--", command, ...args,
  ];
  const r = spawnSync(cli, args0, { ...SPAWN_OPTS, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`${cli} mcp add exited ${r.status}`);
  }
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

// Pre-download Playwright's Chromium so the first dashboard open isn't
// surprised by a 150 MB download. Idempotent — Playwright caches the
// browser bundle under ~/.cache/ms-playwright (Linux/macOS) or
// %LOCALAPPDATA%\ms-playwright (Windows); a second call is a no-op
// fast path.
export function prefetchChromium(log = console.log) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--yes", "playwright", "install", "chromium"], {
      ...SPAWN_OPTS,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright install chromium exited ${code}`));
    });
  });
}

// Top-level install orchestration. Pre-fetches Chromium, detects CLIs,
// registers each one. Tolerates per-CLI failure. Exits 1 if zero CLIs
// were on PATH so CI / scripted callers can tell.
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

  log("[1/3] pre-fetching Chromium via Playwright (one-time, ~150 MB on first install)");
  try {
    await prefetchChromium(log);
  } catch (e) {
    log(`      (prefetch failed: ${e.message})`);
    log("      Not fatal — Playwright will download on first dashboard open.");
  }

  log("");
  log("[2/3] registering sessions-dashboard with detected CLIs");
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
  log(`[3/3] done — registered with ${registered} CLI(s).`);
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
