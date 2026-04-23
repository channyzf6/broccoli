#!/usr/bin/env node
// Long-lived browser daemon. Owns a single Chromium instance with multiple
// independent OS windows (one per named webview). Multiple MCP sessions
// connect over HTTP on 127.0.0.1:<port> and share all windows.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { chromium } from "playwright";
import { focusSession } from "./lib/focus.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DASHBOARDS_PATH = path.join(DATA_DIR, "dashboards.json");
const SESSION_GROUPS_PATH = path.join(DATA_DIR, "session-groups.json");

const PORT = parseInt(process.env.SESSIONS_DASHBOARD_PORT || "8787", 10);
const startedAt = new Date().toISOString();

// Resource caps. Loopback-only binding + Origin lockdown prevent most abuse,
// but a local cooperating process (e.g. a malicious npm postinstall) could
// still POST register-with-random-UUID or open_webview-with-random-name in a
// loop. These caps turn that from a crash into a 429.
const MAX_SESSIONS = 50;
const MAX_WEBVIEWS = 20;

// -----------------------------------------------------------------------------
// Browser + multi-window state.
// Each named webview gets its own BrowserContext, which in Chromium headed mode
// maps to its own OS window. Reusing `context.newPage()` would give us tabs in
// a single window instead — we want windows, hence a context per name.
// -----------------------------------------------------------------------------
let browser = null;
const pages = new Map(); // name -> {context, page, startedAt}

// Guard concurrent launches: if two callers race ensureBrowser while
// browser === null, both could call chromium.launch() and spawn a second
// Chromium. We serialize through a single in-flight promise.
let launchPromise = null;
async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  if (launchPromise) { await launchPromise; return; }
  launchPromise = (async () => {
    browser = await chromium.launch({ headless: false, args: ["--no-first-run"] });
    browser.on("disconnected", () => {
      browser = null;
      pages.clear();
    });
  })();
  try { await launchPromise; } finally { launchPromise = null; }
}

function pageAlive(name) {
  const rec = pages.get(name);
  return !!(rec && rec.page && !rec.page.isClosed());
}

async function setWindowSizeUnlocked(page, width, height) {
  // Resize the OS window via CDP without pinning the page viewport. With
  // `viewport: null` at context creation, the page follows the window — so
  // dragging to resize reflows the content. `setViewportSize` would lock it.
  const cdp = await page.context().newCDPSession(page);
  try {
    // Both getWindowForTarget and setWindowBounds can throw on not-yet-
    // attached targets; treat window sizing as best-effort and never let
    // it fail the caller.
    try {
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      // Windows rejects bounds on maximized windows; drop to "normal" first.
      try {
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
      } catch {}
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          width: Math.max(200, width | 0),
          height: Math.max(150, height | 0),
        },
      });
    } catch {}
  } finally {
    await cdp.detach().catch(() => {});
  }
}

function getPage(name) {
  const rec = pages.get(name);
  if (!rec || !rec.page || rec.page.isClosed()) {
    throw new Error(`No webview open with name "${name}". Call open_webview first.`);
  }
  return rec.page;
}

async function open_webview({ name = "main", url: navUrl, html, title, width, height }) {
  if (!navUrl && !html) throw new Error("Provide either `url` or `html`.");
  await ensureBrowser();
  // Browser can disconnect between ensureBrowser's return and our next call
  // (user quits Chromium, OS kills it). Snapshot locally and re-check so we
  // produce a clear error instead of a bare TypeError on `browser.newContext`.
  const b = browser;
  if (!b || !b.isConnected()) {
    throw new Error("browser disconnected during open_webview; retry");
  }

  let rec = pages.get(name);
  let page;
  let createdNew = false;
  if (rec && rec.page && !rec.page.isClosed()) {
    page = rec.page; // reuse existing named window
  } else {
    // Cap the number of named windows so a misbehaving caller can't exhaust
    // BrowserContexts. Existing windows (reopening an already-named one) are
    // exempt from the check above.
    if (pages.size >= MAX_WEBVIEWS) {
      throw new Error(`webview cap reached (${MAX_WEBVIEWS} open). Close one before opening another.`);
    }
    const context = await b.newContext({ viewport: null });
    page = await context.newPage();
    rec = { context, page, startedAt: new Date().toISOString() };
    pages.set(name, rec);
    page.on("close", () => {
      if (pages.get(name) === rec) pages.delete(name);
      rec.context.close().catch(() => {});
    });
    createdNew = true;
  }

  // Apply the configured size only on FIRST creation. Reopening a named
  // window (the common "open sessions dashboard" case) re-navigates the
  // existing page and must not resize — it would blow away the user's
  // manual resize and on Windows would also un-maximize a maximized
  // window via the windowState=normal step inside setWindowSizeUnlocked.
  // dashboards.json width/height is now an initial-size, not a forced
  // size.
  if (createdNew && width && height) {
    await setWindowSizeUnlocked(page, width, height);
  }
  if (navUrl) await page.goto(navUrl, { waitUntil: "domcontentloaded" });
  else await page.setContent(html, { waitUntil: "domcontentloaded" });
  if (title) await page.evaluate((t) => { document.title = t; }, title);

  return { opened: true, name, url: page.url(), title: await page.title() };
}

async function update_webview({ name = "main", url: navUrl, html }) {
  const page = getPage(name);
  if (!navUrl && !html) throw new Error("Provide either `url` or `html`.");
  if (navUrl) await page.goto(navUrl, { waitUntil: "domcontentloaded" });
  else await page.setContent(html, { waitUntil: "domcontentloaded" });
  return { updated: true, name, url: page.url(), title: await page.title() };
}

async function eval_js({ name = "main", expression }) {
  const page = getPage(name);
  if (!expression) throw new Error("`expression` is required.");
  const wrapped = `(async () => { return (${expression}); })()`;
  const raw = await page.evaluate(wrapped);
  // JSON.stringify returns undefined for functions/symbols/undefined and
  // throws on circular refs / BigInt. Return an explicit error field instead
  // of collapsing silently to "[object Object]" / "undefined".
  let serialized;
  try {
    serialized = JSON.stringify(raw);
  } catch (e) {
    return { name, result: null, error: `result not JSON-serializable: ${e.message}` };
  }
  if (serialized === undefined) {
    return { name, result: null, warning: `value of type ${typeof raw} is not JSON-serializable` };
  }
  return { name, result: serialized };
}

async function screenshot({ name = "main", fullPage }) {
  const page = getPage(name);
  const buf = await page.screenshot({ type: "png", fullPage: !!fullPage });
  return { name, mimeType: "image/png", base64: buf.toString("base64") };
}

async function close_webview({ name = "main" } = {}) {
  const rec = pages.get(name);
  if (!rec) return { closed: false, name, reason: "no such webview" };
  try { if (rec.page && !rec.page.isClosed()) await rec.page.close(); } catch {}
  try { if (rec.context) await rec.context.close(); } catch {}
  // The page.on("close") handler may have already deleted and even re-set
  // this entry (if open_webview raced the close). Only delete if we still
  // own the slot.
  if (pages.get(name) === rec) pages.delete(name);
  return { closed: true, name };
}

async function list_webviews() {
  const out = [];
  for (const [name, rec] of pages) {
    if (!rec.page || rec.page.isClosed()) continue;
    try {
      out.push({
        name,
        url: rec.page.url(),
        title: await rec.page.title(),
        startedAt: rec.startedAt,
      });
    } catch { /* ignore races */ }
  }
  return { webviews: out };
}

// -----------------------------------------------------------------------------
// Dashboards config (data/dashboards.json). Users register named dashboards
// with their URL, size, title, and whether they should auto-open.
//
// `url` may be an absolute URL (http(s)://, file://, data:) OR a path relative
// to the data/ directory. Using relative paths lets the shipped dashboards.json
// work on every machine without users having to rewrite hard-coded
// `file:///C:/Users/<user>/...` paths.
// -----------------------------------------------------------------------------
function resolveDashboardUrl(u) {
  if (!u) return u;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith("data:")) return u;
  const abs = path.resolve(DATA_DIR, u);
  return url.pathToFileURL(abs).toString();
}

async function loadDashboards() {
  try {
    const raw = await fs.readFile(DASHBOARDS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.dashboards || {};
  } catch {
    return {};
  }
}

async function list_dashboards() {
  const dashboards = await loadDashboards();
  // Echo resolved URLs so callers can see what they'll actually open.
  const resolved = {};
  for (const [k, v] of Object.entries(dashboards)) {
    resolved[k] = v && v.url ? { ...v, url: resolveDashboardUrl(v.url) } : v;
  }
  return { dashboards: resolved };
}

async function open_dashboard({ name }) {
  if (!name) throw new Error("`name` is required.");
  const dashboards = await loadDashboards();
  const d = dashboards[name];
  if (!d) {
    const known = Object.keys(dashboards).join(", ") || "<none registered>";
    throw new Error(`unknown dashboard "${name}". Known: ${known}`);
  }
  if (!d.url) throw new Error(`dashboard "${name}" has no url configured`);
  return open_webview({
    name,
    url: resolveDashboardUrl(d.url),
    title: d.title,
    width: d.width,
    height: d.height,
  });
}

// -----------------------------------------------------------------------------
// Session groups (data/session-groups.json). Dashboards use this to organize
// connected sessions into user-defined workstreams.
//
// Two mechanisms:
//   - members (per group): cwd/sessionName rules that match sessions into a
//     group. Survive CC restarts because cwd/sessionName are stable.
//   - pins (top-level): per-session-id overrides that win over rules.
//     Scoped to the daemon-assigned session lifetime (new id on restart).
//     Needed to disambiguate sessions that share a cwd — the only case where
//     rule-based matching can't pick one session out of a cohort.
//
// Shape:
//   {
//     groups: [ { id, name, color, members: [{ key: "cwd"|"sessionName", value }] } ],
//     pins:   [ { sessionId, groupId: string | null } ]  // null = Ungrouped
//   }
// -----------------------------------------------------------------------------
async function loadSessionGroups() {
  // Always re-read from disk so hand-edits (migrations, debug) are picked up
  // without a daemon restart, and so concurrent GET + PUT can't interleave
  // via a shared in-memory cache. File is tiny; the read cost is negligible.
  try {
    const raw = await fs.readFile(SESSION_GROUPS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      pins: Array.isArray(parsed.pins) ? parsed.pins : [],
    };
  } catch {
    return { groups: [], pins: [] };
  }
}

function validateGroups(data) {
  if (!data || !Array.isArray(data.groups)) {
    throw new Error("expected { groups: [...] }");
  }
  for (const g of data.groups) {
    if (!g || typeof g.id !== "string" || typeof g.name !== "string") {
      throw new Error("each group requires id and name");
    }
    if (!Array.isArray(g.members)) throw new Error("each group requires members[]");
    for (const m of g.members) {
      if (!m || (m.key !== "cwd" && m.key !== "sessionName")) {
        throw new Error(`invalid member key "${m?.key}" — must be "cwd" or "sessionName"`);
      }
      if (typeof m.value !== "string" || !m.value) {
        throw new Error("member value must be a non-empty string");
      }
    }
  }
  if (data.pins !== undefined) {
    if (!Array.isArray(data.pins)) throw new Error("pins must be an array");
    const groupIds = new Set(data.groups.map((g) => g.id));
    for (const p of data.pins) {
      if (!p || typeof p.sessionId !== "string" || !p.sessionId) {
        throw new Error("pin requires non-empty sessionId");
      }
      if (p.groupId !== null && (typeof p.groupId !== "string" || !p.groupId)) {
        throw new Error("pin groupId must be null or non-empty string");
      }
      if (p.groupId !== null && !groupIds.has(p.groupId)) {
        throw new Error(`pin references unknown groupId "${p.groupId}"`);
      }
    }
  }
}

async function saveSessionGroups(data) {
  validateGroups(data);
  const normalized = {
    groups: data.groups.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color || null,
      members: g.members.map((m) => ({ key: m.key, value: m.value })),
    })),
    pins: (data.pins || []).map((p) => ({
      sessionId: p.sessionId,
      groupId: p.groupId === null ? null : p.groupId,
    })),
  };
  // Atomic write: write to a tmp file, then rename over the target. Rename is
  // atomic on both POSIX and NTFS, so a crash mid-write can't leave a
  // half-written or truncated session-groups.json.
  const json = JSON.stringify(normalized, null, 2);
  const tmp = SESSION_GROUPS_PATH + ".tmp";
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, SESSION_GROUPS_PATH);
  return normalized;
}

// -----------------------------------------------------------------------------
// Session presence tracking. MCP proxies register on startup, heartbeat every
// 5 s, and unregister on shutdown. Any session without a heartbeat in the last
// 15 s is expired. Dashboards poll /sessions to render the connected list.
// -----------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> {pid, cwd, clientInfo, startedAt, lastSeen, toolCalls}
const SESSION_TTL_MS = 15000;

function expireSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
}

function listSessions() {
  expireSessions();
  const now = Date.now();
  return Array.from(sessions, ([id, s]) => ({
    id,
    pid: s.pid,
    cwd: s.cwd,
    sessionName: s.sessionName ?? null,
    host: s.host ?? "claude",
    gitBranch: s.gitBranch ?? null,
    clientInfo: s.clientInfo ?? null,
    startedAt: s.startedAt,
    lastSeen: s.lastSeen,
    lastSeenAgoMs: now - s.lastSeen,
    lastCallAt: s.lastCallAt ?? null,
    lastCallAgoMs: s.lastCallAt ? (now - s.lastCallAt) : null,
    ageMs: now - new Date(s.startedAt).getTime(),
    toolCalls: s.toolCalls,
    activityState: s.activityState ?? null,
    toolName: s.toolName ?? null,
    stateChangedAt: s.stateChangedAt ?? null,
    stateChangedAgoMs: s.stateChangedAt ? (now - s.stateChangedAt) : null,
  }));
}

// Platform-conditional capabilities. The focus endpoint only actually works
// on macOS (AppleScript-driven). Advertising this lets the frontend hide
// UI it can't usefully offer on Windows / Linux daemons.
const DAEMON_CAPABILITIES = Object.freeze({
  focus: process.platform === "darwin",
});

async function daemon_info() {
  return {
    pid: process.pid,
    port: PORT,
    startedAt,
    browserConnected: !!(browser && browser.isConnected()),
    webviews: (await list_webviews()).webviews,
    sessions: listSessions(),
    capabilities: DAEMON_CAPABILITIES,
  };
}

// Set/clear the caller's session name. The caller's sessionId is injected
// by the /call handler as __sessionId (never user-supplied).
async function set_session_name({ name, __sessionId }) {
  if (!__sessionId) throw new Error("caller has no sessionId — is this session registered?");
  const s = sessions.get(__sessionId);
  if (!s) throw new Error(`session ${__sessionId} is not known to the daemon`);
  s.sessionName = name || null;
  s.lastSeen = Date.now();
  return { ok: true, sessionId: __sessionId, sessionName: s.sessionName };
}

const ops = {
  open_webview, update_webview, eval_js, screenshot, close_webview,
  list_webviews, open_dashboard, list_dashboards, set_session_name, daemon_info,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 32 * 1024 * 1024) req.destroy(); });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

// Parse a JSON request body and return the parsed value. On malformed JSON,
// respond with 400 directly and return `null` so the caller can bail.
// Centralizes the try/catch that used to live (or not live) in every POST
// handler — avoids bubbling parse errors up as opaque 500s.
function parseBody(body, res) {
  try { return JSON.parse(body || "{}"); }
  catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
    return null;
  }
}

function requireSessionId(body, res) {
  if (typeof body.sessionId !== "string" || !body.sessionId) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "sessionId required (string)" }));
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Origin lockdown.
//
// The daemon exposes `eval_js` and other state-changing ops that effectively
// grant RCE over whatever window the user has open. With wildcard CORS, any
// website the user visits could POST to 127.0.0.1:<port> and run JS in their
// open webviews — including authenticated tabs. So we restrict the allowed
// Origins to:
//   - missing header (non-browser clients like the MCP proxy / curl)
//   - "null" (file:// pages, our own dashboards)
// Localhost HTTP origins (127.0.0.1/localhost) are NOT allowed: any dev
// server the user happens to run could otherwise POST /call op eval_js
// at an open webview. The browser would block the response cross-origin,
// but the side effect would already have landed.
// Anything else gets a 403 before the request even touches a handler.
// -----------------------------------------------------------------------------
function originAllowed(origin) {
  return origin == null || origin === "" || origin === "null";
}

function writeCORS(res, origin) {
  // Echo the caller's Origin back (or "null" if absent) — never wildcard.
  res.setHeader("Access-Control-Allow-Origin", origin || "null");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      // No CORS headers on a 403 — browser will block the response regardless,
      // and non-browser clients get a clear status. We intentionally don't
      // leak which Origins are allowed.
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
      return;
    }
    writeCORS(res, origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/ping") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid, startedAt }));
      return;
    }
    if (req.method === "GET" && (req.url === "/dashboards" || req.url.startsWith("/dashboards?"))) {
      const dashboards = await loadDashboards();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ dashboards }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessions: listSessions(), daemon: { pid: process.pid, port: PORT, startedAt, capabilities: DAEMON_CAPABILITIES } }));
      return;
    }
    if (req.method === "GET" && (req.url === "/session-groups" || req.url.startsWith("/session-groups?"))) {
      const data = await loadSessionGroups();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
      return;
    }
    if (req.method === "PUT" && req.url === "/session-groups") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        return;
      }
      let saved;
      try {
        saved = await saveSessionGroups(parsed);
      } catch (e) {
        // Validation failures are client errors, not server bugs.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        groups: saved.groups.length,
        pins: saved.pins.length,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/session/register") {
      const body = parseBody(await readBody(req), res);
      if (body === null) return;
      if (!requireSessionId(body, res)) return;
      const { sessionId, pid, cwd, startedAt: sStarted, clientInfo, sessionName, host, gitBranch } = body;
      // Cap total registered sessions so a local process can't balloon the
      // Map via register-with-random-UUID in a tight loop. Re-registering a
      // known id is always allowed (it's an idempotent upsert).
      if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `session cap reached (${MAX_SESSIONS})` }));
        return;
      }
      // Preserve any previously-set sessionName, toolCalls, lastCallAt, and
      // tail-state fields across re-registrations (e.g. daemon restart,
      // heartbeat re-registration). Scanner state lives in the proxy, so on
      // proxy restart these will refresh on the next /session/activity tick.
      const prev = sessions.get(sessionId);
      sessions.set(sessionId, {
        pid: pid ?? null,
        cwd: cwd ?? null,
        clientInfo: clientInfo ?? null,
        sessionName: sessionName ?? prev?.sessionName ?? null,
        // Host identifies which CLI spawned the session's proxy (claude, gemini, ...).
        // Preserved across re-registrations so a transient /register from an older
        // client that omits the field can't wipe the previously-detected host.
        host: host ?? prev?.host ?? "claude",
        // Current git branch / short-sha / null. Proxies from older clients
        // don't send it — fall back to prev so a re-register doesn't wipe it.
        gitBranch: gitBranch !== undefined ? gitBranch : (prev?.gitBranch ?? null),
        startedAt: sStarted ?? new Date().toISOString(),
        lastSeen: Date.now(),
        toolCalls: prev?.toolCalls ?? 0,
        lastCallAt: prev?.lastCallAt ?? null,
        activityState: prev?.activityState ?? null,
        toolName: prev?.toolName ?? null,
        stateChangedAt: prev?.stateChangedAt ?? null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, registered: sessionId, total: sessions.size }));
      return;
    }
    if (req.method === "POST" && req.url === "/session/rename") {
      const body = parseBody(await readBody(req), res);
      if (body === null) return;
      if (!requireSessionId(body, res)) return;
      const { sessionId, sessionName } = body;
      const s = sessions.get(sessionId);
      if (!s) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "no such session", sessionId }));
        return;
      }
      s.sessionName = sessionName || null;
      s.lastSeen = Date.now();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessionId, sessionName: s.sessionName }));
      return;
    }
    if (req.method === "POST" && req.url === "/session/heartbeat") {
      const body = parseBody(await readBody(req), res);
      if (body === null) return;
      if (!requireSessionId(body, res)) return;
      const s = sessions.get(body.sessionId);
      if (s) {
        s.lastSeen = Date.now();
        // Proxy sends gitBranch on every heartbeat; missing/undefined means
        // a pre-PR proxy we keep as-is. null from a current proxy means
        // "not in a git repo" — we accept that overwrite.
        if (body.gitBranch !== undefined) s.gitBranch = body.gitBranch;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, known: !!s }));
      return;
    }
    if (req.method === "POST" && req.url === "/session/unregister") {
      const body = parseBody(await readBody(req), res);
      if (body === null) return;
      if (!requireSessionId(body, res)) return;
      const existed = sessions.delete(body.sessionId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, removed: existed }));
      return;
    }
    // Focus a session's terminal tab (macOS only — see lib/focus.mjs).
    // The body's sessionId must correspond to an entry in our own registry;
    // we never take a pid from the HTTP body.
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
    if (req.method === "POST" && req.url === "/session/activity") {
      // Sessions push authoritative tool-use counts derived from scanning
      // their own CC JSONL. This supersedes the legacy /call increment so
      // the dashboard reflects ALL CC activity (Bash, Read, Edit, ...), not
      // just this MCP server's tool calls.
      const body = parseBody(await readBody(req), res);
      if (body === null) return;
      if (!requireSessionId(body, res)) return;
      const s = sessions.get(body.sessionId);
      if (!s) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "no such session" }));
        return;
      }
      // Monotonic: a delayed activity POST generated before a re-register
      // reset could otherwise silently decrease a live counter. Same for
      // lastCallAt.
      if (typeof body.toolCalls === "number" && body.toolCalls >= 0) {
        s.toolCalls = Math.max(s.toolCalls || 0, body.toolCalls);
      }
      if (typeof body.lastCallAt === "number" && body.lastCallAt > 0) {
        s.lastCallAt = Math.max(s.lastCallAt || 0, body.lastCallAt);
      }
      // Tail-state fields (new). activityState transitions freely (no
      // monotonicity — state is whatever the last JSONL line implies, which
      // the proxy re-derives authoritatively). stateChangedAt is only
      // updated forward so a delayed POST can't rewind it.
      if (
        body.activityState === "running" ||
        body.activityState === "thinking" ||
        body.activityState === "idle"
      ) {
        s.activityState = body.activityState;
      }
      if (typeof body.toolName === "string") {
        s.toolName = body.toolName || null;
      } else if (body.toolName === null) {
        s.toolName = null;
      }
      if (typeof body.stateChangedAt === "number" && body.stateChangedAt > 0) {
        s.stateChangedAt = Math.max(s.stateChangedAt || 0, body.stateChangedAt);
      }
      s.lastSeen = Date.now();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        toolCalls: s.toolCalls,
        lastCallAt: s.lastCallAt,
        activityState: s.activityState ?? null,
        toolName: s.toolName ?? null,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/call") {
      const body = parseBody(await readBody(req), res);
      if (body === null) return;
      const { op, args, sessionId } = body;
      if (sessionId && sessions.has(sessionId)) {
        // toolCalls / lastCallAt are now set by /session/activity (JSONL
        // scan), which captures ALL CC tool uses — not just this server's.
        // This handler only bumps presence.
        sessions.get(sessionId).lastSeen = Date.now();
      }
      const fn = ops[op];
      if (!fn) throw new Error("unknown op: " + op);
      // Pass the calling session's id into args so session-scoped ops
      // (like `set_session_name`) know which session to mutate.
      const result = await fn({ ...(args ?? {}), __sessionId: sessionId });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[sessions-dashboard daemon] port ${PORT} already in use — exiting (another daemon won).`);
    process.exit(0);
  }
  console.error("[sessions-dashboard daemon] fatal:", err);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", async () => {
  console.error(`[sessions-dashboard daemon] pid=${process.pid} listening on 127.0.0.1:${PORT} at ${startedAt}`);

  // Auto-open any dashboard whose config has `autoOpen: true`.
  try {
    const dashboards = await loadDashboards();
    for (const [name, d] of Object.entries(dashboards)) {
      if (d && d.autoOpen && d.url) {
        open_dashboard({ name }).catch((e) => {
          console.error(`[sessions-dashboard daemon] auto-open failed for ${name}:`, e.message);
        });
      }
    }
  } catch {}
});

async function shutdown() {
  try { if (browser && browser.isConnected()) await browser.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
