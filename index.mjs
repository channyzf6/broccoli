#!/usr/bin/env node
// MCP server — thin proxy to the shared sessions-dashboard daemon at
// 127.0.0.1:PORT. Every Claude Code session spawns one of these; they all
// talk to the same daemon process, so they share a single browser window and
// all appear together in the live sessions dashboard.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { detectHost, makeAdapter } from "./lib/host/registry.mjs";
import { resolveGitDir, readHead } from "./lib/git.mjs";
import { detectHostTerminal } from "./lib/terminal.mjs";

const PORT = parseInt(process.env.SESSIONS_DASHBOARD_PORT || "8787", 10);
// By default the daemon is dormant until a tool is invoked. Set
// SESSIONS_DASHBOARD_AUTOSTART=1 in the MCP server env block to spawn +
// register at CC startup (so this session shows up in the dashboard
// immediately, before the user invokes any tool).
const AUTOSTART = process.env.SESSIONS_DASHBOARD_AUTOSTART === "1";
const here = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = join(here, "daemon.mjs");
const SESSION_ID = randomUUID();
const SESSION_STARTED = new Date().toISOString();
const SESSION_CWD = process.cwd();
// Optional human-readable session name. Priority:
//   1. SESSIONS_DASHBOARD_SESSION_NAME env (cross-host canonical)
//   2. CLAUDE_SESSION_NAME env (backward-compat alias — pre-multi-host)
//   3. set_session_name MCP tool at any time (source = "manual")
//   4. host-specific rename scrape, e.g. Claude /rename (source = "auto")
// Gemini CLI has no rename equivalent; Gemini users should use #1 or #3.
let SESSION_NAME =
  process.env.SESSIONS_DASHBOARD_SESSION_NAME
  || process.env.CLAUDE_SESSION_NAME
  || null;
// "env" | "manual" | "auto" | null — determines whether the name-watch loop
// is allowed to overwrite SESSION_NAME with a newly-detected /rename.
let SESSION_NAME_SOURCE = SESSION_NAME ? "env" : null;

// Detect host (Claude Code / Gemini CLI / ...) and build an adapter that
// knows how to read this CLI's transcript for activity + name detection.
// Resolves synchronously here; detectHost is async but only I/O-free checks
// so we defer the actual construction slightly.
let SESSION_HOST = "claude"; // set below once detectHost resolves
let adapter = null;
const adapterReady = (async () => {
  SESSION_HOST = await detectHost({ cwd: SESSION_CWD });
  adapter = makeAdapter({
    host: SESSION_HOST,
    cwd: SESSION_CWD,
    sessionStart: SESSION_STARTED,
    pid: process.pid,
  });
})();

// Git branch display — resolve the git directory once at register, then
// read HEAD on every heartbeat to pick up `git switch` / worktree changes
// within 5s. cwd is captured once at proxy startup and never changes, so
// the resolved gitDir is stable for the session's lifetime.
let SESSION_GIT_DIR = null;   // populated at first register; null if cwd not in a repo
let SESSION_GIT_BRANCH = null; // {branch, sha, detached} | null

function ping(timeoutMs = 300) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port: PORT, path: "/ping", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

let spawnPromise = null;
async function ensureDaemon() {
  if (await ping()) return;
  if (spawnPromise) { await spawnPromise; return; }
  spawnPromise = (async () => {
    const child = spawn(process.execPath, [DAEMON_PATH], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SESSIONS_DASHBOARD_PORT: String(PORT) },
      windowsHide: true,
    });
    child.unref();
    // Poll up to ~10s for the daemon to come up.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await ping()) return;
    }
    throw new Error(`sessions-dashboard daemon failed to start on 127.0.0.1:${PORT}`);
  })();
  try { await spawnPromise; } finally { spawnPromise = null; }
}

function callDaemon(op, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ op, args: args ?? {}, sessionId: SESSION_ID });
    const req = http.request(
      {
        hostname: "127.0.0.1", port: PORT, path: "/call", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed.result);
            else reject(new Error(parsed.error || "daemon error"));
          } catch (e) { reject(new Error("bad daemon response: " + e.message)); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("daemon call timed out")); });
    req.write(body); req.end();
  });
}

function httpPost(path, body, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      {
        hostname: "127.0.0.1", port: PORT, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.write(payload); req.end();
  });
}

// Periodic watcher: picks up the host's rename equivalent (/rename in Claude)
// and pushes the new name to the daemon. Runs every 15 s; no-ops when the
// current name came from an env var or an explicit set_session_name call.
// Delegates the host-specific scan to the adapter.
function startNameWatch() {
  const t = setInterval(async () => {
    if (SESSION_NAME_SOURCE === "manual" || SESSION_NAME_SOURCE === "env") return;
    if (!adapter) return;
    const d = await adapter.discoverName();
    if (d === undefined) return; // transient I/O error — leave state alone
    if (typeof d === "string" && d !== SESSION_NAME) {
      SESSION_NAME = d;
      SESSION_NAME_SOURCE = "auto";
      httpPost("/session/rename", { sessionId: SESSION_ID, sessionName: d }).catch(() => {});
    } else if (d === null && SESSION_NAME_SOURCE === "auto" && SESSION_NAME) {
      // Our own transcript was read successfully and contains no rename, but
      // we had auto-set a name previously (e.g. from an earlier buggy
      // version that cross-contaminated from a sibling session's transcript).
      // Clear so the dashboard reflects reality. The === null check (vs.
      // falsy) is load-bearing — undefined above means I/O error, not empty.
      SESSION_NAME = null;
      SESSION_NAME_SOURCE = null;
      httpPost("/session/rename", { sessionId: SESSION_ID, sessionName: null }).catch(() => {});
    }
  }, 15000);
  t.unref();
}

// Activity watch: every 5 s, ask the host adapter for a snapshot and push
// it to the daemon. The adapter owns host-specific transcript semantics
// (JSONL tailing for Claude/Codex, JSON or JSONL re-read for Gemini).
function startActivityWatch() {
  const t = setInterval(async () => {
    if (!adapter) return;
    const a = await adapter.scanActivity();
    if (!a) return;
    httpPost("/session/activity", {
      sessionId: SESSION_ID,
      toolCalls: a.count,
      lastCallAt: a.lastAt,
      activityState: a.activityState,
      toolName: a.toolName,
      stateChangedAt: a.stateChangedAt,
    }).catch(() => {});
  }, 5000);
  t.unref();
}

// Throttle repeated cap-hit warnings so we don't spam stderr every heartbeat.
let _lastCapWarnAt = 0;
async function registerSession() {
  try {
    await ensureDaemon();
    await adapterReady;
    // Env var wins; otherwise ask the host adapter to scrape an initial name.
    if (!SESSION_NAME && adapter) {
      const d = await adapter.discoverName();
      if (d) { SESSION_NAME = d; SESSION_NAME_SOURCE = "auto"; }
    }
    // Resolve git-dir once (lazy cache). cwd never changes, so this is
    // stable; heartbeat only re-reads HEAD after this point.
    if (SESSION_GIT_DIR === null) {
      SESSION_GIT_DIR = await resolveGitDir(SESSION_CWD);
    }
    SESSION_GIT_BRANCH = await readHead(SESSION_GIT_DIR);
    const status = await httpPost("/session/register", {
      sessionId: SESSION_ID,
      pid: process.pid,
      cwd: SESSION_CWD,
      startedAt: SESSION_STARTED,
      sessionName: SESSION_NAME,
      host: SESSION_HOST,
      gitBranch: SESSION_GIT_BRANCH,
      ...detectHostTerminal(),
    });
    if (status === 429) {
      // Daemon's session cap is full. Without this log the session would be
      // silently invisible to the sessions dashboard forever.
      const now = Date.now();
      if (now - _lastCapWarnAt > 60_000) {
        _lastCapWarnAt = now;
        console.error("[sessions-dashboard] daemon session cap reached; this session will not appear in the dashboard. Close an idle CC session or raise MAX_SESSIONS in daemon.mjs.");
      }
    }
  } catch { /* non-fatal */ }
}

function httpPostJson(path, body, { timeoutMs = 3000 } = {}) {
  // Like httpPost but returns the parsed JSON response body.
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      {
        hostname: "127.0.0.1", port: PORT, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data || "{}")); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.write(payload); req.end();
  });
}

function startHeartbeat() {
  const t = setInterval(async () => {
    try {
      // Pick up branch changes (`git switch`, `git worktree` adds, etc.).
      // gitDir was resolved once at register; HEAD is a small file read.
      SESSION_GIT_BRANCH = await readHead(SESSION_GIT_DIR);
      const res = await httpPostJson("/session/heartbeat", {
        sessionId: SESSION_ID,
        gitBranch: SESSION_GIT_BRANCH,
      });
      if (res && res.known === false) {
        // Daemon forgot us (probably restarted). Re-register so this session
        // doesn't silently disappear from the sessions dashboard.
        await registerSession();
      }
    } catch { /* non-fatal */ }
  }, 5000);
  t.unref();
}

function unregisterSessionBestEffort() {
  // Fire-and-forget synchronous-ish request on shutdown.
  try {
    const payload = JSON.stringify({ sessionId: SESSION_ID });
    const req = http.request({
      hostname: "127.0.0.1", port: PORT, path: "/session/unregister", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      timeout: 500,
    });
    req.on("error", () => {});
    req.write(payload); req.end();
  } catch {}
}

// Lazy presence: in the default (non-AUTOSTART) mode, we defer session
// registration + heartbeat until the first tool call, so installing this
// extension never spawns a background process before the user touches it.
let lazyPresenceStarted = false;
async function proxy(op, args) {
  await ensureDaemon();
  if (!lazyPresenceStarted && !AUTOSTART) {
    lazyPresenceStarted = true;
    // registerSession() is try/catch-wrapped internally; the start* helpers
    // use setInterval(...).unref(), so firing once per process is safe.
    await registerSession();
    startHeartbeat();
    startNameWatch();
    startActivityWatch();
  }
  try {
    return await callDaemon(op, args);
  } catch (e) {
    // One retry in case the daemon died between ping and call.
    if (await ping()) throw e;
    await ensureDaemon();
    // A respawned daemon has a fresh, empty sessions Map. Re-register before
    // retrying so session-scoped ops (set_session_name, /call tool-call
    // tracking) don't immediately fail with "session is not known".
    await registerSession();
    return await callDaemon(op, args);
  }
}

const NAME_PROP = { type: "string", description: "Window name. Each name is a separate OS window. Default: \"main\"." };

const tools = [
  {
    name: "open_webview",
    description:
      "Open a named browser window with a URL or raw HTML. Each `name` is a separate OS window. Calling with an already-open name navigates that window instead of opening a new one. Default name is \"main\". All windows are shared across Claude Code sessions.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME_PROP,
        url: { type: "string", description: "URL to load." },
        html: { type: "string", description: "Raw HTML document or fragment." },
        title: { type: "string", description: "Window/document title." },
        width: { type: "number", description: "Viewport width in pixels." },
        height: { type: "number", description: "Viewport height in pixels." },
      },
    },
  },
  {
    name: "update_webview",
    description:
      "Update a named webview by navigating to a URL or replacing its HTML. Requires that window to be already open.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME_PROP,
        url: { type: "string" },
        html: { type: "string" },
      },
    },
  },
  {
    name: "eval_js",
    description:
      "Evaluate a JS expression in the named webview and return the JSON-serialized result. Expression can be async.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME_PROP,
        expression: { type: "string" },
      },
      required: ["expression"],
    },
  },
  {
    name: "screenshot",
    description: "Capture a PNG screenshot of the named webview.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME_PROP,
        fullPage: { type: "boolean" },
      },
    },
    returnsImage: true,
  },
  {
    name: "close_webview",
    description: "Close a named webview window. Other named windows and the browser itself stay alive.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_PROP },
    },
  },
  {
    name: "list_webviews",
    description: "List currently open webview windows — name, url, title, startedAt — one entry per open window.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "open_dashboard",
    description:
      "Open a registered dashboard (from data/dashboards.json) in its own named window. The dashboard name doubles as the window name, so a second call re-navigates it instead of opening a duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Dashboard name from dashboards.json, e.g. \"sessions\"." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_dashboards",
    description: "Return the dashboards registered in data/dashboards.json — name, title, url, size, autoOpen.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_session_name",
    description:
      "Set (or clear) a human-readable name for THIS Claude Code session, shown in the sessions dashboard. Pass `name: \"\"` or omit to clear. The name sticks for the lifetime of the CC session; to make it permanent, set `CLAUDE_SESSION_NAME` in the environment before launching CC.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name, e.g. \"my-project\". Empty string clears it." },
      },
    },
  },
  {
    name: "daemon_info",
    description: "Report status of the shared daemon: pid, port, uptime, open webviews, connected sessions.",
    inputSchema: { type: "object", properties: {} },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: "sessions-dashboard", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await proxy(name, args ?? {});
    // Mirror sessionName updates into this proxy's local state so heartbeat
    // re-registration (after a daemon restart) preserves the chosen name.
    // Clearing the name should also clear the source, otherwise the watcher
    // thinks "manual" still wins and auto-discovery stays suppressed.
    if (name === "set_session_name") {
      const n = (args && typeof args.name === "string" && args.name) ? args.name : null;
      SESSION_NAME = n;
      SESSION_NAME_SOURCE = n ? "manual" : null;
    }
    if (tool.returnsImage && result?.base64) {
      return { content: [{ type: "image", data: result.base64, mimeType: result.mimeType }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Presence: register this session with the daemon, heartbeat every 5 s,
// and watch the session JSONL for /rename commands every 15 s.
// Eager startup only when AUTOSTART=1 — otherwise this kicks off lazily
// from proxy() on the first tool call (see `lazyPresenceStarted`).
if (AUTOSTART) {
  registerSession();
  startHeartbeat();
  startNameWatch();
  startActivityWatch();
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(sig, () => { unregisterSessionBestEffort(); process.exit(0); });
  } catch { /* SIGHUP/SIGBREAK not on all platforms */ }
}
process.on("exit", unregisterSessionBestEffort);
process.stdin.on("close", () => { unregisterSessionBestEffort(); process.exit(0); });
process.stdin.on("end", () => { unregisterSessionBestEffort(); process.exit(0); });
