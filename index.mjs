#!/usr/bin/env node
// MCP server — thin proxy to the shared web-view daemon at 127.0.0.1:PORT.
// Every Claude Code session spawns one of these; they all talk to the same
// daemon process, so they share a single browser window.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = parseInt(process.env.WEB_VIEW_PORT || "8787", 10);
// By default the daemon is dormant until a webview tool is invoked. Set
// WEB_VIEW_AUTOSTART=1 in the MCP server env block to spawn + register at CC
// startup (so this session shows up in the sessions dashboard immediately).
const AUTOSTART = process.env.WEB_VIEW_AUTOSTART === "1";
const here = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = join(here, "daemon.mjs");
const SESSION_ID = randomUUID();
const SESSION_STARTED = new Date().toISOString();
const SESSION_CWD = process.cwd();
// Optional human-readable session name. User can set this before launching CC:
//   CLAUDE_SESSION_NAME=my-project-worker claude
// Or via the `set_session_name` tool at any time, or via CC's `/rename` command
// (picked up from the session JSONL on startup and via the periodic watcher).
let SESSION_NAME = process.env.CLAUDE_SESSION_NAME || process.env.WEB_VIEW_SESSION_NAME || null;
// "env" | "manual" | "auto" | null — determines whether the name-watch loop
// is allowed to overwrite SESSION_NAME with a newly-detected /rename.
let SESSION_NAME_SOURCE = SESSION_NAME ? "env" : null;

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
      env: { ...process.env, WEB_VIEW_PORT: String(PORT) },
      windowsHide: true,
    });
    child.unref();
    // Poll up to ~10s for the daemon to come up.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await ping()) return;
    }
    throw new Error(`web-view daemon failed to start on 127.0.0.1:${PORT}`);
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

// Discover a session name from Claude Code's own session logs. CC stores
// each session as a JSONL at ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
// When the user runs `/rename <name>`, a line like
//   {..., "content":"<command-name>/rename</command-name>...<command-args>NAME</command-args>"}
// gets appended. We scan all JSONLs for this project, find the latest
// /rename by timestamp, and use that name.
//
// Cached by file mtime so re-scanning an active session's 5 MB JSONL on
// every heartbeat is cheap (just a stat unless the file changed). Entries
// for JSONLs that have been deleted get evicted each scan, and the cache is
// bounded so a user churning through many project dirs can't grow it unbounded.
const _nameCache = new Map(); // filepath -> { mtimeMs, latest: {name, ts} | null }
const _NAME_CACHE_CAP = 200;

async function discoverSessionName() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return null;
    const encoded = SESSION_CWD.replace(/[:\\/_]/g, "-");
    const dir = path.join(home, ".claude", "projects", encoded);
    let entries;
    try { entries = await fsp.readdir(dir); } catch { return null; }
    let bestName = null;
    let bestTs = 0;
    const visited = new Set();
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f);
      visited.add(fp);
      let st;
      try { st = await fsp.stat(fp); } catch { continue; }
      let entry = _nameCache.get(fp);
      if (!entry || entry.mtimeMs !== st.mtimeMs) {
        let localBest = null;
        let content;
        try { content = await fsp.readFile(fp, "utf8"); } catch { continue; }
        for (const line of content.split(/\r?\n/)) {
          if (!line.includes("/rename")) continue;
          let obj; try { obj = JSON.parse(line); } catch { continue; }
          const c = String(obj?.content ?? "");
          const m = c.match(/<command-name>\/rename<\/command-name>[\s\S]*?<command-args>([^<]*)<\/command-args>/);
          if (!m) continue;
          const argName = m[1].trim();
          if (!argName) continue;
          const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
          if (!localBest || ts >= localBest.ts) localBest = { name: argName, ts };
        }
        entry = { mtimeMs: st.mtimeMs, latest: localBest };
        _nameCache.set(fp, entry);
      }
      if (entry.latest && entry.latest.ts >= bestTs) {
        bestTs = entry.latest.ts;
        bestName = entry.latest.name;
      }
    }
    // Evict stale entries from this directory that we didn't visit this call
    // (the JSONL has been removed) — these are dead weight in the cache.
    for (const k of _nameCache.keys()) {
      if (k.startsWith(dir + path.sep) && !visited.has(k)) _nameCache.delete(k);
    }
    // Cap global cache size (LRU-ish: Map preserves insertion order, so the
    // oldest entries go first). Cheap safety net for users who work across
    // many project directories over a single long-lived CC session.
    while (_nameCache.size > _NAME_CACHE_CAP) {
      const oldest = _nameCache.keys().next().value;
      _nameCache.delete(oldest);
    }
    return bestName;
  } catch {
    return null;
  }
}

// Periodic watcher: picks up /rename commands issued mid-session and pushes
// the new name to the daemon. Runs every 15 s; no-ops when the current name
// came from `CLAUDE_SESSION_NAME` env or an explicit `set_session_name` call.
function startNameWatch() {
  const t = setInterval(async () => {
    if (SESSION_NAME_SOURCE === "manual" || SESSION_NAME_SOURCE === "env") return;
    const d = await discoverSessionName();
    if (d && d !== SESSION_NAME) {
      SESSION_NAME = d;
      SESSION_NAME_SOURCE = "auto";
      httpPost("/session/rename", { sessionId: SESSION_ID, sessionName: d }).catch(() => {});
    }
  }, 15000);
  t.unref();
}

// -----------------------------------------------------------------------------
// Activity watch: scan this CC session's JSONL for `tool_use` entries and push
// the count + latest-tool-use timestamp to the daemon. Captures every CC tool
// call (Bash, Read, Edit, Grep, web-view, …) rather than just web-view ones.
//
// Heuristic for "our" JSONL: the JSONL in this cwd's project dir whose first
// entry's timestamp is closest to SESSION_STARTED (within a 30 s window).
// Each CC launch creates a new JSONL so the alignment is usually ~hundreds of
// ms. In the edge case of two CC sessions launched in the exact same cwd at
// the same time, we may attribute one session's activity to the other — a
// known limitation documented for the user.
//
// Reading is incremental (byte offsets) so even a multi-MB JSONL is cheap to
// follow across many scans. We only parse newly-appended bytes.
// -----------------------------------------------------------------------------
let _ownJsonlPath = null;        // resolved on first successful identify
let _ownJsonlReadBytes = 0;      // byte offset up to which we've parsed
let _ownJsonlToolCalls = 0;      // running count for this session
let _ownJsonlLastAt = null;      // epoch ms of the most recent tool_use
// Tail-state tracking: each JSONL line transitions state deterministically.
// "running" = last assistant turn ended on a tool_use (stop_reason: "tool_use");
// "thinking" = last line was user-side (prompt or tool_result), Claude is about
// to respond; "idle" = last assistant turn ended with end_turn / max_tokens /
// stop_sequence. Lets the dashboard show "running bash" for long-running tools
// and "thinking" for text-only responses — strictly better than the old
// "tool_use within 60s" heuristic.
let _ownJsonlActivityState = null;   // "running" | "thinking" | "idle" | null
let _ownJsonlToolName = null;        // last tool_use's name when state === "running"
let _ownJsonlStateChangedAt = null;  // epoch ms of the line that set the current state

async function identifyOwnJsonl() {
  // Re-run the heuristic every scan rather than committing permanently on
  // first success. If CC's JSONL didn't exist yet when we first looked, or
  // a different candidate's first-line happened to land closer to our
  // SESSION_STARTED before ours did, we'd otherwise be stuck on the wrong
  // file forever. When the best candidate changes, scanner state is reset.
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return _ownJsonlPath;
  const encoded = SESSION_CWD.replace(/[:\\/_]/g, "-");
  const dir = path.join(home, ".claude", "projects", encoded);
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return _ownJsonlPath; }
  const sessionStart = Date.parse(SESSION_STARTED);
  let best = null;
  let bestDelta = Infinity;
  // Fallback: the JSONL with the newest mtime among those still being
  // written to. Used when no first-line timestamp is close enough — e.g.
  // when CC auto-restarted the MCP server mid-session, so our proxy start
  // is much later than the CC session's actual start.
  let fallback = null;
  let fallbackMtime = 0;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(dir, f);
    let st;
    try { st = await fsp.stat(fp); } catch { continue; }
    // Must have been modified at or after our session started; otherwise it's
    // an older session's log, not ours.
    if (st.mtimeMs < sessionStart - 2000) continue;
    if (st.mtimeMs > fallbackMtime) { fallbackMtime = st.mtimeMs; fallback = fp; }
    // Peek the head of the file to find the first line with a `timestamp`.
    // CC now writes some untimestamped metadata lines at the top
    // (e.g. {"type":"permission-mode",...}), so "first line" isn't always
    // the first user/assistant event.
    let firstTs = 0;
    try {
      const fh = await fsp.open(fp, "r");
      try {
        const buf = Buffer.alloc(16384);
        const { bytesRead } = await fh.read(buf, 0, 16384, 0);
        const lines = buf.toString("utf8", 0, bytesRead).split("\n");
        for (const line of lines) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.timestamp) { firstTs = Date.parse(obj.timestamp); break; }
          } catch { /* keep scanning — may be a truncated final line */ }
        }
      } finally { await fh.close(); }
    } catch { continue; }
    if (!firstTs) continue;
    const delta = Math.abs(firstTs - sessionStart);
    if (delta < bestDelta) { bestDelta = delta; best = fp; }
  }
  const pick = (best && bestDelta < 30000) ? best : fallback;
  if (pick) {
    if (pick !== _ownJsonlPath) {
      // Chosen JSONL changed — reset scanner state so we re-count against
      // the new file from scratch.
      _ownJsonlPath = pick;
      _ownJsonlReadBytes = 0;
      _ownJsonlToolCalls = 0;
      _ownJsonlLastAt = null;
    }
    return pick;
  }
  return _ownJsonlPath;
}

// Read cap per scan. Multi-MB deltas (e.g. after a laptop sleep) get caught
// up across subsequent 5s ticks instead of allocating the whole delta in one
// shot.
const JSONL_SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

async function scanOwnJsonlActivity() {
  const fp = await identifyOwnJsonl();
  if (!fp) return null;
  let st;
  try { st = await fsp.stat(fp); } catch { return null; }
  // File truncation / rewrite detection. If the file shrank below our
  // accumulated offset, CC either rotated the JSONL or re-opened from scratch
  // — reset scanner state so the next read re-parses from byte 0.
  if (st.size < _ownJsonlReadBytes) {
    _ownJsonlReadBytes = 0;
    _ownJsonlToolCalls = 0;
    _ownJsonlLastAt = null;
    _ownJsonlActivityState = null;
    _ownJsonlToolName = null;
    _ownJsonlStateChangedAt = null;
  }
  if (_ownJsonlReadBytes >= st.size) {
    return {
      count: _ownJsonlToolCalls,
      lastAt: _ownJsonlLastAt,
      activityState: _ownJsonlActivityState,
      toolName: _ownJsonlToolName,
      stateChangedAt: _ownJsonlStateChangedAt,
    };
  }
  try {
    const fh = await fsp.open(fp, "r");
    try {
      const remaining = st.size - _ownJsonlReadBytes;
      const toRead = Math.min(remaining, JSONL_SCAN_CHUNK_BYTES);
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, _ownJsonlReadBytes);
      if (bytesRead === 0) {
        // File shrank between stat and read, or concurrent truncation. Bail;
        // next scan's truncation branch above will reset state.
        return {
          count: _ownJsonlToolCalls,
          lastAt: _ownJsonlLastAt,
          activityState: _ownJsonlActivityState,
          toolName: _ownJsonlToolName,
          stateChangedAt: _ownJsonlStateChangedAt,
        };
      }
      // Only decode the bytes we actually read — avoids stray NULs from the
      // tail of Buffer.alloc on a short read.
      const text = buf.toString("utf8", 0, bytesRead);
      // If we ended mid-line, back off to the last newline so partial lines
      // are reconsidered on the next scan when more bytes have flushed.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) {
        return {
          count: _ownJsonlToolCalls,
          lastAt: _ownJsonlLastAt,
          activityState: _ownJsonlActivityState,
          toolName: _ownJsonlToolName,
          stateChangedAt: _ownJsonlStateChangedAt,
        };
      }
      _ownJsonlReadBytes += lastNl + 1;
      for (const line of text.slice(0, lastNl).split("\n")) {
        if (!line) continue;
        // Type prefilter — we care about user & assistant lines for tail state.
        // Metadata lines ({type:"permission-mode"}, {type:"summary"}, etc.)
        // don't transition activity; skipping them keeps the hot path cheap.
        const isAssistant = line.includes('"type":"assistant"');
        const isUser = line.includes('"type":"user"');
        if (!isAssistant && !isUser) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
        if (obj.type === "assistant") {
          const content = obj.message?.content;
          if (!Array.isArray(content)) continue;
          // Count tool_use blocks (legacy counter still useful for dashboards).
          let calls = 0;
          let lastToolUseName = null;
          for (const c of content) {
            if (c && c.type === "tool_use") {
              calls++;
              if (c.name) lastToolUseName = c.name;
            }
          }
          if (calls > 0) {
            _ownJsonlToolCalls += calls;
            if (ts) _ownJsonlLastAt = ts;
          }
          // Tail state: stop_reason authoritative if present; otherwise
          // infer from whether the last content block is a tool_use.
          const sr = obj.message?.stop_reason;
          const endedOnToolUse =
            sr === "tool_use" ||
            (!sr && content.length > 0 && content[content.length - 1]?.type === "tool_use");
          if (endedOnToolUse) {
            _ownJsonlActivityState = "running";
            _ownJsonlToolName = lastToolUseName;
          } else {
            _ownJsonlActivityState = "idle";
            _ownJsonlToolName = null;
          }
          _ownJsonlStateChangedAt = ts;
        } else if (obj.type === "user") {
          // A user line means Claude is either about to respond to a fresh
          // prompt or processing a tool_result. Either way, "thinking".
          _ownJsonlActivityState = "thinking";
          _ownJsonlToolName = null;
          _ownJsonlStateChangedAt = ts;
        }
      }
    } finally { await fh.close(); }
  } catch { return null; }
  return {
    count: _ownJsonlToolCalls,
    lastAt: _ownJsonlLastAt,
    activityState: _ownJsonlActivityState,
    toolName: _ownJsonlToolName,
    stateChangedAt: _ownJsonlStateChangedAt,
  };
}

function startActivityWatch() {
  const t = setInterval(async () => {
    const a = await scanOwnJsonlActivity();
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
    // Env var wins; otherwise scan CC's session logs for the latest /rename.
    if (!SESSION_NAME) {
      const d = await discoverSessionName();
      if (d) { SESSION_NAME = d; SESSION_NAME_SOURCE = "auto"; }
    }
    const status = await httpPost("/session/register", {
      sessionId: SESSION_ID,
      pid: process.pid,
      cwd: SESSION_CWD,
      startedAt: SESSION_STARTED,
      sessionName: SESSION_NAME,
    });
    if (status === 429) {
      // Daemon's session cap is full. Without this log the session would be
      // silently invisible to the sessions dashboard forever.
      const now = Date.now();
      if (now - _lastCapWarnAt > 60_000) {
        _lastCapWarnAt = now;
        console.error("[web-view] daemon session cap reached; this session will not appear in the sessions dashboard. Close an idle CC session or raise MAX_SESSIONS in daemon.mjs.");
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
      const res = await httpPostJson("/session/heartbeat", { sessionId: SESSION_ID });
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
  { name: "web-view", version: "0.3.0" },
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
