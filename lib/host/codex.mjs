// OpenAI Codex CLI adapter. Codex stores each session as a JSONL at
//   <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl
// where CODEX_HOME defaults to ~/.codex. Each line is a `RolloutLine`
//   { timestamp, type, payload }
// with `type` ∈ session_meta | session_state | turn_context |
// response_item | event_msg | compacted | ...
//
// We tail-scan by byte offset (same model as the Claude adapter; this
// works because the file is append-only). The scan filters to event_msg
// lines whose payload.type signals an activity transition.
//
// Persistence-mode caveat: Codex's default "Limited" mode omits *_begin
// events (turn_started, exec_command_begin, mcp_tool_call_begin). In
// Limited mode the activity pill can still distinguish thinking vs idle
// (via user_message and turn_complete) but cannot show "running <tool>"
// while a tool is in flight. Users wanting full granularity enable
// Extended mode in ~/.codex/config.toml. We document this; we do not
// hard-fail when in Limited.
//
// Verified against Codex CLI ~v0.x as of April 2026. Schema may shift —
// adapter parses defensively (optional chaining, null fallback).

import fsp from "node:fs/promises";
import path from "node:path";
import { HostAdapter, HOST } from "./base.mjs";

const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
const SESSION_MATCH_WINDOW_MS = 5 * 60 * 1000;
const META_PEEK_BYTES = 2048;
// How many UTC date dirs (sessionStart-anchored) to consider when locating
// the rollout file. Sessions that started near midnight may live in
// "yesterday"; long-running sessions resumed across multiple days may
// live in [today-2]. 3 is the sweet spot — covers reasonable cases
// without making a huge directory walk each tick.
const CANDIDATE_DAY_COUNT = 3;

function codexHome() {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? path.join(home, ".codex") : null;
}

function normCwd(p) {
  return String(p || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

// Date-bucketed dirs to consider when looking for our session. Codex
// stores sessions in YYYY/MM/DD/. We scan CANDIDATE_DAY_COUNT consecutive
// UTC days starting from sessionStart — covers near-midnight spills
// (yesterday) and multi-day resumes (day-before-yesterday).
function candidateDateDirs(sessionsRoot, sessionStartMs) {
  const dirs = [];
  for (let i = 0; i < CANDIDATE_DAY_COUNT; i++) {
    const d = new Date(sessionStartMs - i * 86400000);
    dirs.push(path.join(
      sessionsRoot,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    ));
  }
  return dirs;
}

// Read just enough of a rollout file to extract its session_meta line.
// Returns { cwd, timestamp } or null on parse failure.
async function readRolloutMeta(fp) {
  let fh;
  try { fh = await fsp.open(fp, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(META_PEEK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, META_PEEK_BYTES, 0);
    if (!bytesRead) return null;
    const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
    let obj;
    try { obj = JSON.parse(firstLine); } catch { return null; }
    if (obj?.type !== "session_meta") return null;
    const cwd = obj?.payload?.cwd;
    if (!cwd) return null;
    return { cwd, timestamp: obj.timestamp };
  } finally {
    try { await fh.close(); } catch { /* ignore */ }
  }
}

export class CodexAdapter extends HostAdapter {
  name = HOST.CODEX;
  displayName = "Codex CLI";

  constructor(ctx) {
    super(ctx);
    // Activity-scanner state (mirror of ClaudeAdapter shape).
    this._path = null;
    this._readBytes = 0;
    this._toolCalls = 0;
    this._lastAt = null;
    this._activityState = null;
    this._toolName = null;
    this._stateChangedAt = null;
    this._ready = false;
    // Name-watcher tail-scan state. Independent byte cursor so the name
    // watcher's reads don't perturb the activity scanner's. Only tracks
    // the latest name we've seen; gets reset on path change or
    // truncation alongside activity state.
    this._namePath = null;
    this._nameReadBytes = 0;
    this._lastSeenName = null;
  }

  _snapshot() {
    return {
      count: this._toolCalls,
      lastAt: this._lastAt,
      activityState: this._activityState,
      toolName: this._toolName,
      stateChangedAt: this._stateChangedAt,
    };
  }

  // Pure path resolver — no shared state mutation. Walks the date-bucketed
  // sessions tree (today + yesterday UTC), reads first-line session_meta
  // from each candidate, picks the one whose cwd matches AND whose
  // timestamp is closest to our sessionStart. Returns path or null.
  async _resolvePath() {
    const home = codexHome();
    if (!home) return null;
    const sessionsRoot = path.join(home, "sessions");
    const sessionStartMs = Date.parse(this.sessionStart);
    const wantCwd = normCwd(this.cwd);

    let best = null;
    let bestDelta = Infinity;
    for (const dir of candidateDateDirs(sessionsRoot, sessionStartMs)) {
      let entries;
      try { entries = await fsp.readdir(dir); } catch { continue; }
      for (const f of entries) {
        if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
        const fp = path.join(dir, f);
        const meta = await readRolloutMeta(fp);
        if (!meta) continue;
        if (normCwd(meta.cwd) !== wantCwd) continue;
        const ts = Date.parse(meta.timestamp);
        if (!ts) continue;
        const delta = Math.abs(ts - sessionStartMs);
        if (delta < bestDelta) { bestDelta = delta; best = fp; }
      }
    }
    return (best && bestDelta < SESSION_MATCH_WINDOW_MS) ? best : null;
  }

  // Activity-scanner wrapper around _resolvePath: maintains the
  // read-position cursor and tail-state. Only scanActivity should call
  // this; discoverName uses _resolvePath directly.
  async _identifyForScan() {
    const pick = await this._resolvePath();
    if (!pick) return this._path;
    if (pick !== this._path) {
      this._ready = false;
      this._path = pick;
      this._readBytes = 0;
      this._toolCalls = 0;
      this._lastAt = null;
      this._activityState = null;
      this._toolName = null;
      this._stateChangedAt = null;
    }
    return this._path;
  }

  async scanActivity() {
    const fp = await this._identifyForScan();
    if (!fp) return this._ready ? this._snapshot() : null;
    let st;
    try { st = await fsp.stat(fp); } catch {
      return this._ready ? this._snapshot() : null;
    }
    // Truncation / rewrite detection.
    if (st.size < this._readBytes) {
      this._readBytes = 0;
      this._toolCalls = 0;
      this._lastAt = null;
      this._activityState = null;
      this._toolName = null;
      this._stateChangedAt = null;
      this._ready = false;
    }
    if (this._readBytes >= st.size) {
      this._ready = true;
      return this._snapshot();
    }
    try {
      const fh = await fsp.open(fp, "r");
      try {
        const remaining = st.size - this._readBytes;
        const toRead = Math.min(remaining, SCAN_CHUNK_BYTES);
        const buf = Buffer.alloc(toRead);
        const { bytesRead } = await fh.read(buf, 0, toRead, this._readBytes);
        if (bytesRead === 0) return this._snapshot();
        const text = buf.toString("utf8", 0, bytesRead);
        const lastNl = text.lastIndexOf("\n");
        if (lastNl === -1) {
          // No newline in the entire chunk. Two possibilities:
          //   (a) we're mid-line at EOF — wait for more bytes.
          //   (b) a single line is larger than SCAN_CHUNK_BYTES (rare for
          //       Codex but possible for response_item with huge tool
          //       output). Skipping past it prevents indefinite stall;
          //       we lose the state-transition info from this one line
          //       (acceptable — the next line/event will resync state).
          if (bytesRead === toRead && remaining > toRead) {
            this._readBytes += toRead;
          }
          return this._snapshot();
        }
        this._readBytes += lastNl + 1;
        for (const line of text.slice(0, lastNl).split("\n")) {
          if (!line) continue;
          // Cheap prefilter — only event_msg lines change activity state.
          if (!line.includes('"type":"event_msg"')) continue;
          let obj; try { obj = JSON.parse(line); } catch { continue; }
          this._applyEvent(obj);
        }
      } finally { await fh.close(); }
    } catch {
      return this._ready ? this._snapshot() : null;
    }
    this._ready = true;
    return this._snapshot();
  }

  // Apply one event_msg's effect on tail state.
  _applyEvent(obj) {
    if (obj?.type !== "event_msg") return;
    const ev = obj?.payload?.type;
    if (!ev) return;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
    switch (ev) {
      case "user_message":
        this._activityState = "thinking";
        this._toolName = null;
        if (ts) this._stateChangedAt = ts;
        return;
      case "turn_started":
        this._activityState = "thinking";
        this._toolName = null;
        if (ts) this._stateChangedAt = ts;
        return;
      case "exec_command_begin":
        this._activityState = "running";
        this._toolName = obj?.payload?.payload?.command?.[0] || "shell";
        if (ts) this._stateChangedAt = ts;
        return;
      case "mcp_tool_call_begin":
        this._activityState = "running";
        this._toolName = obj?.payload?.payload?.invocation?.tool || "mcp";
        if (ts) this._stateChangedAt = ts;
        return;
      case "exec_command_end":
      case "mcp_tool_call_end":
        this._toolCalls += 1;
        if (ts) this._lastAt = ts;
        // After a tool ends, the assistant typically returns to producing
        // text — model as "thinking" until the next turn_complete. In
        // Limited mode this is the only signal we get for tool activity.
        this._activityState = "thinking";
        this._toolName = null;
        if (ts) this._stateChangedAt = ts;
        return;
      case "turn_complete":
      case "turn_aborted":
        this._activityState = "idle";
        this._toolName = null;
        if (ts) this._stateChangedAt = ts;
        return;
      // agent_message, token_count, patch_apply_*, web_search_* — ignored
      // for activity-state purposes. Some affect counters in the future.
      default:
        return;
    }
  }

  // Codex's `/rename <name>` slash command emits a thread_name_updated
  // event_msg. Tail-scan with an independent byte cursor so an active
  // session (whose mtime advances every ~second) doesn't trigger a
  // full-file re-read every 15s.
  //
  // Returns tri-state: string (found a name), null (read OK and
  // confirmed no name present yet OR the previously-seen name is still
  // valid — the watcher uses null+SOURCE checks to decide whether to
  // clear), undefined (I/O error — leave state alone).
  async discoverName() {
    const fp = await this._resolvePath();
    if (!fp) return undefined;
    let st;
    try { st = await fsp.stat(fp); } catch { return undefined; }
    // Path changed (rotation, restart) → reset cursor + last-seen name.
    if (fp !== this._namePath) {
      this._namePath = fp;
      this._nameReadBytes = 0;
      this._lastSeenName = null;
    }
    // File shrank → truncation, treat as fresh.
    if (st.size < this._nameReadBytes) {
      this._nameReadBytes = 0;
      this._lastSeenName = null;
    }
    if (this._nameReadBytes >= st.size) {
      // Nothing new since last scan — reflect what we last saw.
      return this._lastSeenName;
    }
    let fh;
    try { fh = await fsp.open(fp, "r"); } catch { return undefined; }
    try {
      const remaining = st.size - this._nameReadBytes;
      const toRead = Math.min(remaining, SCAN_CHUNK_BYTES);
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, this._nameReadBytes);
      if (bytesRead === 0) return this._lastSeenName;
      const text = buf.toString("utf8", 0, bytesRead);
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) {
        // Same oversized-line guard as scanActivity: if a single line
        // exceeds the chunk, skip it (rename events are tiny so this
        // shouldn't happen, but be defensive).
        if (bytesRead === toRead && remaining > toRead) {
          this._nameReadBytes += toRead;
        }
        return this._lastSeenName;
      }
      this._nameReadBytes += lastNl + 1;
      let latestInChunk = null;
      for (const line of text.slice(0, lastNl).split("\n")) {
        if (!line || !line.includes("thread_name_updated")) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.payload?.type !== "thread_name_updated") continue;
        const name = String(obj?.payload?.payload?.thread_name ?? "").trim();
        if (!name) continue;
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
        if (!latestInChunk || ts >= latestInChunk.ts) latestInChunk = { name, ts };
      }
      if (latestInChunk) this._lastSeenName = latestInChunk.name;
    } catch {
      return undefined;
    } finally {
      try { await fh.close(); } catch { /* ignore */ }
    }
    return this._lastSeenName;
  }
}
