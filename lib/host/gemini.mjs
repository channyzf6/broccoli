// Gemini CLI adapter. Gemini stores each session as a chat file at
//   ~/.gemini/tmp/<cwd-encoded-or-hash>/chats/session-<iso>-<short>.{json,jsonl}
// The `.project_root` file in each tmp/<dir> holds the canonical cwd, so we
// don't rely on a hash convention we can't verify across Gemini versions.
//
// Two formats coexist (Gemini preserves history across the bump rather than
// migrating), and we dispatch by extension:
//
//   .json  (Gemini <= 0.38): atomic full-file rewrite. Single JSON.parse on
//          read. mtime-gated so we re-parse only when the file changes.
//   .jsonl (Gemini >= 0.39, per PR google-gemini/gemini-cli#23749): append-
//          only stream. Each line is a record; parseJsonl() materializes a
//          ConversationRecord by walking lines (line 1 is header, subsequent
//          lines are MessageRecord, MetadataUpdateRecord {$set:{...}}, or
//          RewindRecord {$rewindTo:"<id>"}). Per-line parse failures are
//          swallowed so a partial trailing line doesn't drop earlier records.
//
// Both formats produce the same ConversationRecord shape, so _deriveSnapshot
// is format-agnostic and unchanged. Mtime-gating still applies for both;
// JSONL re-parsing is sub-millisecond at the sub-MB sizes Gemini produces.
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

// Replay a Gemini 0.39.0+ .jsonl chat log into the same
// ConversationRecord shape that legacy .json files have, so the
// existing _deriveSnapshot() can consume either format unchanged.
//
// Schema (from google-gemini/gemini-cli PR #23749):
//   line 1: PartialMetadataRecord (header)
//   line N: MessageRecord ({id, type, timestamp, content, toolCalls?})
//           OR MetadataUpdateRecord ({$set: {...}})
//           OR RewindRecord ({$rewindTo: "<message-id>"})
// Unknown record shapes are ignored (forward-compat). Per-line JSON
// parse failures are swallowed — handles mid-write partial trailing
// lines and forward-compat garbage without losing prior records.
function parseJsonl(text) {
  const conversation = { messages: [] };
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (!rec || typeof rec !== "object") continue;
    if (rec.$set && typeof rec.$set === "object") {
      Object.assign(conversation, rec.$set);
      continue;
    }
    if (typeof rec.$rewindTo === "string") {
      const idx = conversation.messages.findIndex((m) => m?.id === rec.$rewindTo);
      if (idx >= 0) conversation.messages.length = idx;
      continue;
    }
    if (rec.id && rec.type) {
      conversation.messages.push(rec);
      continue;
    }
    // Header / extra metadata (has sessionId but no id+type pair).
    if (rec.sessionId && !rec.id) {
      Object.assign(conversation, rec);
      if (!Array.isArray(conversation.messages)) conversation.messages = [];
      continue;
    }
    // anything else: ignore (forward-compat)
  }
  return conversation;
}

export class GeminiAdapter extends HostAdapter {
  name = HOST.GEMINI;
  displayName = "Gemini CLI";

  constructor(ctx) {
    super(ctx);
    this._chatFilePath = null;    // resolved on first locate() success
    this._lastMtimeMs = null;     // mtime at last scan — gates re-read only
    this._parsedCache = null;     // cached parsed ConversationRecord (invalidated on mtime change)
    this._snapshotCache = null;   // last produced ActivitySnapshot (for failure fallback)
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
  //
  // We cache a tight match (startTime within SESSION_MATCH_WINDOW_MS) on
  // this._chatFilePath. A LOOSE fallback is not cached — if our proxy
  // started before Gemini created its chat file (the common case with
  // AUTOSTART=1), we want each tick to re-probe so we pick up the new
  // file as soon as it appears. Otherwise we'd be stuck reading an old
  // unrelated session forever.
  async _locate() {
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
      // Accept both legacy atomic .json (Gemini ≤0.38) and append-only
      // .jsonl (Gemini ≥0.39, per PR google-gemini/gemini-cli#23749). The
      // startTime regex peek below works for both because the field
      // appears near the top of either format.
      if (!f.startsWith("session-") || !(f.endsWith(".json") || f.endsWith(".jsonl"))) continue;
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
    const tight = best && bestDelta < SESSION_MATCH_WINDOW_MS;
    if (tight) {
      if (this._chatFilePath !== best) {
        // Path changed (Gemini created a new chat file that matches our
        // sessionStart more tightly than the previous pick). Reset scan
        // caches so mtime-gating doesn't carry over stale state.
        this._lastMtimeMs = null;
        this._snapshotCache = null;
        this._chatFilePath = best;
      }
      return best;
    }
    // Loose fallback: use it this tick but do NOT cache — next tick
    // re-probes so a newly-created tight match can supersede.
    this._chatFilePath = null;
    return fallback;
  }

  // Derive an ActivitySnapshot from a parsed session JSON.
  //
  // Gemini only writes tool-call entries to disk AFTER they complete (with
  // status "success" or "error") — there is no in-flight/"running" status
  // persisted. Likewise the gemini response message is typically written
  // only once the whole turn is resolved. That means the file's "last
  // message" is a user message for most of the time any real work is
  // happening. We treat that as "thinking" (label: "working").
  //
  // When the gemini message HAS been written and contains tool calls, we
  // briefly surface the most-recent tool name if it just landed — gives
  // the user a hint that a tool did fire even though we only saw it
  // post-completion.
  _deriveSnapshot(parsed, fileMtimeMs) {
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

    let activityState = null;
    let toolName = null;
    let stateChangedAt = null;

    // Walk back to the most recent conversational message (user/gemini),
    // skipping metadata entries like type:"info" that don't transition state.
    let last = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.type === "user" || m?.type === "gemini") { last = m; break; }
    }
    if (!last) {
      return { count: 0, lastAt: null, activityState: null, toolName: null, stateChangedAt: null };
    }
    const lastTs = last?.timestamp ? Date.parse(last.timestamp) : null;
    const now = Date.now();

    // Window during which a just-completed tool call's name is still shown
    // as "running <tool>..". Matches the dashboard's 2s poll + roughly one
    // proxy scan cycle so transitions feel responsive without sticking.
    const RECENT_CALL_MS = 4000;

    if (last?.type === "user") {
      // User message is the latest thing in the file. Gemini hasn't finished
      // writing its response yet; classify as "thinking".
      activityState = "thinking";
      stateChangedAt = lastTs;
    } else if (last?.type === "gemini") {
      const calls = Array.isArray(last.toolCalls) ? last.toolCalls : [];
      const recentCall = [...calls].reverse().find((c) => {
        const ts = c?.timestamp ? Date.parse(c.timestamp) : 0;
        return ts && now - ts < RECENT_CALL_MS;
      });
      if (recentCall) {
        activityState = "running";
        toolName = this._shortToolName(recentCall.name);
        stateChangedAt = recentCall.timestamp ? Date.parse(recentCall.timestamp) : lastTs;
      } else if (fileMtimeMs && lastTs && fileMtimeMs > lastTs + 500 && now - fileMtimeMs < RECENT_CALL_MS) {
        // File was updated after the gemini message's own timestamp AND the
        // update was recent — Gemini is still streaming content into the
        // current turn (text tokens or a tool result landing soon).
        activityState = "thinking";
        stateChangedAt = lastTs;
      } else {
        activityState = "idle";
        stateChangedAt = lastTs;
      }
    }

    // Stale-running guard (defensive — our RECENT_CALL_MS should already
    // prevent this, but keep it as a belt-and-suspenders).
    if (
      activityState === "running"
      && stateChangedAt
      && now - stateChangedAt > STALE_RUNNING_MS
    ) {
      activityState = "idle";
      toolName = null;
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

    // Re-read + re-parse ONLY when mtime has advanced. Derivation always
    // runs, so time-windowed states (running / thinking) decay to idle
    // even when the file is quiet.
    if (this._lastMtimeMs === null || st.mtimeMs !== this._lastMtimeMs) {
      let text;
      try { text = await fsp.readFile(fp, "utf8"); } catch {
        return this._ready ? this._snapshotCache : null;
      }
      // Dispatch by extension. Gemini 0.39.0+ writes append-only .jsonl;
      // earlier versions wrote atomic .json. Both coexist in the same
      // chats/ dir because Gemini preserves history across the format
      // bump rather than migrating. _locate accepts both extensions.
      const isJsonl = fp.endsWith(".jsonl");
      try {
        this._parsedCache = isJsonl ? parseJsonl(text) : JSON.parse(text);
      } catch {
        // .json mid-write race is rare (atomic writes); .jsonl line-level
        // parse failures are already swallowed inside parseJsonl. A throw
        // here means the whole file is unreadable — keep the last-known
        // snapshot rather than publishing null.
        return this._ready ? this._snapshotCache : null;
      }
      this._lastMtimeMs = st.mtimeMs;
    }

    const snap = this._deriveSnapshot(this._parsedCache, st.mtimeMs);
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
