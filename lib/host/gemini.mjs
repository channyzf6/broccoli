// Gemini CLI adapter. Gemini stores each session as a single JSON file at
//   ~/.gemini/tmp/<cwd-basename-or-hash>/chats/session-<iso>-<short>.json
// The `.project_root` file in each tmp/<dir> holds the canonical cwd, so we
// don't rely on a hash convention we can't verify across Gemini versions.
//
// Critical difference from Claude: Gemini REWRITES the whole session JSON
// atomically on each update — it is NOT an append-only JSONL. We can't tail
// by byte offset. Instead we mtime-gate the file: only re-parse when the
// mtime advances. Bounded by session size (sub-MB even for long sessions).
//
// Activity derivation from the schema (verified against a live session):
//   messages: [ { id, timestamp, type: "user"|"gemini", content, ... } ]
//     user:     state = "thinking"
//     gemini:
//       with toolCalls and any status != "success"/"failure" → "running" + name
//       otherwise → "idle"
//
// Rename is not supported — Gemini has no /rename equivalent. Users name
// their Gemini session via SESSIONS_DASHBOARD_SESSION_NAME env or the
// set_session_name MCP tool.

import fsp from "node:fs/promises";
import path from "node:path";
import { HostAdapter, HOST } from "./base.mjs";

// If a "running" state hasn't been replaced for longer than this, treat it as
// stuck/aborted and report "idle" instead. Gemini doesn't always write a
// post-abort status; this prevents a card from being stuck on "running
// <tool>" forever after a bad abort.
const STALE_RUNNING_MS = 5 * 60 * 1000;

// How wide a window (ms) around our proxy's sessionStart a chat file's
// startTime may fall and still be considered "our" session. Gemini's own
// startup can lag our proxy's startup by a few seconds or the user may
// idle for minutes before the first prompt (chat file is only written on
// first user message). Keep this forgiving.
const SESSION_MATCH_WINDOW_MS = 5 * 60 * 1000;

export class GeminiAdapter extends HostAdapter {
  name = HOST.GEMINI;
  displayName = "Gemini CLI";

  constructor(ctx) {
    super(ctx);
    this._chatFilePath = null;    // resolved on first locate() success
    this._lastMtimeMs = null;     // mtime at last scan — gates re-parse
    this._snapshotCache = null;   // last produced ActivitySnapshot
    this._ready = false;          // true after first successful scan
  }

  // Strip the MCP prefix off tool names so the dashboard shows the human
  // tool name. "mcp_sessions-dashboard_open_dashboard" → "open_dashboard".
  // Non-MCP names pass through.
  _shortToolName(fullName) {
    if (typeof fullName !== "string" || !fullName.startsWith("mcp_")) return fullName || null;
    const rest = fullName.slice(4);
    const i = rest.indexOf("_");
    return i === -1 ? fullName : rest.slice(i + 1);
  }

  _normCwd(p) {
    return String(p || "")
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
  }

  _geminiHome() {
    const home = process.env.USERPROFILE || process.env.HOME;
    return home ? path.join(home, ".gemini") : null;
  }

  // Find our session's chat file. Returns path or null.
  // Caches the discovered path on this._chatFilePath.
  async _locate() {
    if (this._chatFilePath) {
      // Short-circuit: if we already found it, assume it's still ours.
      return this._chatFilePath;
    }
    const geminiHome = this._geminiHome();
    if (!geminiHome) return null;
    const tmpDir = path.join(geminiHome, "tmp");
    let entries;
    try { entries = await fsp.readdir(tmpDir); } catch { return null; }

    const wantCwd = this._normCwd(this.cwd);
    let matchedTmpDir = null;
    for (const entry of entries) {
      const entryPath = path.join(tmpDir, entry);
      let st;
      try { st = await fsp.stat(entryPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      const prPath = path.join(entryPath, ".project_root");
      let pr;
      try { pr = await fsp.readFile(prPath, "utf8"); } catch { continue; }
      if (this._normCwd(pr.trim()) === wantCwd) {
        matchedTmpDir = entryPath;
        break;
      }
    }
    if (!matchedTmpDir) return null;

    const chatsDir = path.join(matchedTmpDir, "chats");
    let chatFiles;
    try { chatFiles = await fsp.readdir(chatsDir); } catch { return null; }

    const sessionStartMs = Date.parse(this.sessionStart);
    let best = null;
    let bestDelta = Infinity;
    let fallback = null;
    let fallbackMtime = 0;
    for (const f of chatFiles) {
      if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
      const fp = path.join(chatsDir, f);
      let st;
      try { st = await fsp.stat(fp); } catch { continue; }
      if (st.mtimeMs > fallbackMtime) { fallbackMtime = st.mtimeMs; fallback = fp; }
      // Read a small prefix to extract startTime cheaply. The field is near
      // the top of the file so 2KB is plenty.
      let fileStart = 0;
      try {
        const fh = await fsp.open(fp, "r");
        try {
          const buf = Buffer.alloc(2048);
          const { bytesRead } = await fh.read(buf, 0, 2048, 0);
          const text = buf.toString("utf8", 0, bytesRead);
          const m = text.match(/"startTime"\s*:\s*"([^"]+)"/);
          if (m) fileStart = Date.parse(m[1]);
        } finally { await fh.close(); }
      } catch { continue; }
      if (!fileStart) continue;
      const delta = Math.abs(fileStart - sessionStartMs);
      if (delta < bestDelta) { bestDelta = delta; best = fp; }
    }
    const resolved = (best && bestDelta < SESSION_MATCH_WINDOW_MS) ? best : fallback;
    if (resolved) this._chatFilePath = resolved;
    return resolved;
  }

  // Derive an ActivitySnapshot from a parsed session JSON.
  _deriveSnapshot(parsed) {
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];

    // Aggregate counters across all messages.
    let count = 0;
    let lastAt = null;
    for (const msg of messages) {
      if (msg?.type !== "gemini") continue;
      const calls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
      count += calls.length;
      for (const c of calls) {
        const ts = c?.timestamp ? Date.parse(c.timestamp) : null;
        if (ts && (lastAt === null || ts > lastAt)) lastAt = ts;
      }
    }

    // Derive current state from the LAST message.
    let activityState = null;
    let toolName = null;
    let stateChangedAt = null;

    if (messages.length === 0) {
      return { count: 0, lastAt: null, activityState: null, toolName: null, stateChangedAt: null };
    }
    const last = messages[messages.length - 1];
    const lastTs = last?.timestamp ? Date.parse(last.timestamp) : null;

    if (last?.type === "user") {
      activityState = "thinking";
      stateChangedAt = lastTs;
    } else if (last?.type === "gemini") {
      const calls = Array.isArray(last.toolCalls) ? last.toolCalls : [];
      // Any call that hasn't resolved → running.
      const pending = calls.find((c) => c?.status !== "success" && c?.status !== "failure");
      if (pending) {
        activityState = "running";
        toolName = this._shortToolName(pending.name);
        stateChangedAt = pending.timestamp ? Date.parse(pending.timestamp) : lastTs;
      } else {
        activityState = "idle";
        stateChangedAt = lastTs;
      }
    }

    // Stale-running guard: if the "running" state has been stuck for too long,
    // assume the tool aborted without a terminal status write and downgrade.
    if (
      activityState === "running"
      && stateChangedAt
      && Date.now() - stateChangedAt > STALE_RUNNING_MS
    ) {
      activityState = "idle";
      toolName = null;
      // keep stateChangedAt as-is so the card age reflects when we gave up.
    }

    return { count, lastAt, activityState, toolName, stateChangedAt };
  }

  async scanActivity() {
    const fp = await this._locate();
    if (!fp) return this._ready ? this._snapshotCache : null;

    let st;
    try { st = await fsp.stat(fp); } catch {
      return this._ready ? this._snapshotCache : null;
    }
    // Mtime-gated: skip re-parse when the file hasn't changed.
    if (this._lastMtimeMs !== null && st.mtimeMs === this._lastMtimeMs && this._snapshotCache) {
      return this._snapshotCache;
    }

    let text;
    try { text = await fsp.readFile(fp, "utf8"); } catch {
      return this._ready ? this._snapshotCache : null;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      // Mid-write race is extremely unlikely (Gemini writes atomically), but
      // on any parse error we keep the last-known snapshot rather than
      // publishing null and losing a 5s tick.
      return this._ready ? this._snapshotCache : null;
    }

    const snap = this._deriveSnapshot(parsed);
    this._lastMtimeMs = st.mtimeMs;
    this._snapshotCache = snap;
    this._ready = true;
    return snap;
  }

  // Gemini has no in-transcript rename mechanism (/rename doesn't exist;
  // /chat save is save-as, not rename). Users set their session name via
  // SESSIONS_DASHBOARD_SESSION_NAME env or the set_session_name MCP tool.
  async discoverName() {
    return null;
  }
}
