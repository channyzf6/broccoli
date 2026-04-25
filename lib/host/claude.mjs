// Claude Code adapter. CC stores each session as a JSONL at
//   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
// appended to in real time. We tail-scan by byte offset for activity state
// and read the whole file (cached by mtime) for /rename detection.

import fsp from "node:fs/promises";
import path from "node:path";
import { HostAdapter, HOST } from "./base.mjs";

// Read cap per activity scan. Multi-MB deltas (e.g. after a laptop sleep)
// get caught up across subsequent ticks instead of allocating the whole
// delta in one shot.
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

// Name-cache cap — each proxy typically only ever caches one JSONL path.
const NAME_CACHE_CAP = 32;

export class ClaudeAdapter extends HostAdapter {
  name = HOST.CLAUDE;
  displayName = "Claude Code";

  constructor(ctx) {
    super(ctx);
    // Activity-scanner state.
    this._path = null;             // resolved on first successful identify
    this._readBytes = 0;           // byte offset up to which we've parsed
    this._toolCalls = 0;           // running count for this session
    this._lastAt = null;           // epoch ms of the most recent tool_use
    this._activityState = null;    // "running" | "thinking" | "idle" | null
    this._toolName = null;         // last tool_use's name when state === "running"
    this._stateChangedAt = null;   // epoch ms of the line that set current state
    this._ready = false;           // true after first successful scan
    // Name-watcher state — path-keyed mtime cache.
    this._nameCache = new Map();   // filepath -> { mtimeMs, latest: {name,ts}|null }
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

  // Pure path resolver — no shared state mutation. Heuristic: pick the JSONL
  // in the cwd's project dir whose first-entry timestamp is closest to our
  // sessionStart. If no candidate is within 30s, fall back to the most-
  // recently-modified JSONL (handles CC auto-restarts where our proxy's
  // sessionStart is much later than CC's session start).
  async _resolvePath() {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return null;
    const encoded = this.cwd.replace(/[:\\/_]/g, "-");
    const dir = path.join(home, ".claude", "projects", encoded);
    let entries;
    try { entries = await fsp.readdir(dir); } catch { return null; }
    const sessionStartMs = Date.parse(this.sessionStart);
    let best = null;
    let bestDelta = Infinity;
    let fallback = null;
    let fallbackMtime = 0;
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f);
      let st;
      try { st = await fsp.stat(fp); } catch { continue; }
      if (st.mtimeMs < sessionStartMs - 2000) continue;
      if (st.mtimeMs > fallbackMtime) { fallbackMtime = st.mtimeMs; fallback = fp; }
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
            } catch { /* truncated final line — keep scanning */ }
          }
        } finally { await fh.close(); }
      } catch { continue; }
      if (!firstTs) continue;
      const delta = Math.abs(firstTs - sessionStartMs);
      if (delta < bestDelta) { bestDelta = delta; best = fp; }
    }
    return (best && bestDelta < 30000) ? best : fallback;
  }

  // Activity-scanner wrapper around _resolvePath: maintains the read-position
  // cursor and tail-state. Only scanActivity() should call this; discoverName()
  // uses _resolvePath() directly so its polls don't perturb scanner state.
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
    // File truncation / rewrite detection.
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
        if (lastNl === -1) return this._snapshot();
        this._readBytes += lastNl + 1;
        for (const line of text.slice(0, lastNl).split("\n")) {
          if (!line) continue;
          // Type prefilter — only user & assistant lines transition state.
          const isAssistant = line.includes('"type":"assistant"');
          const isUser = line.includes('"type":"user"');
          if (!isAssistant && !isUser) continue;
          let obj; try { obj = JSON.parse(line); } catch { continue; }
          const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
          if (obj.type === "assistant") {
            const content = obj.message?.content;
            if (!Array.isArray(content)) continue;
            let calls = 0;
            let lastToolUseName = null;
            for (const c of content) {
              if (c && c.type === "tool_use") {
                calls++;
                if (c.name) lastToolUseName = c.name;
              }
            }
            if (calls > 0) {
              this._toolCalls += calls;
              if (ts) this._lastAt = ts;
            }
            const sr = obj.message?.stop_reason;
            const endedOnToolUse =
              sr === "tool_use" ||
              (!sr && content.length > 0 && content[content.length - 1]?.type === "tool_use");
            if (endedOnToolUse) {
              this._activityState = "running";
              this._toolName = lastToolUseName;
            } else {
              this._activityState = "idle";
              this._toolName = null;
            }
            this._stateChangedAt = ts;
          } else if (obj.type === "user") {
            // Distinguish real user prompts from tool_result deliveries.
            // Claude Code writes a type="user" line for BOTH: (a) a real
            // prompt the user typed, and (b) the tool_result rows that
            // get fed back to the LLM during a multi-tool turn. Treating
            // every type="user" as a fresh prompt and resetting state to
            // "thinking" causes two visible bugs:
            //
            //   1. Mid-turn pill flicker -- state oscillates
            //      thinking -> running -> thinking -> running as the
            //      tool loop alternates assistant/user lines.
            //   2. Pill stuck on "working" if the JSONL ends on a
            //      tool_result line (turn aborted mid-loop, session
            //      crashed, user closed the CLI). Without a follow-up
            //      assistant message to flip state to idle/running,
            //      the pill shows "working" forever.
            //
            // Real user prompts have content like
            //   [{ type: "text", text: "..." }]
            // tool_result deliveries look like
            //   [{ type: "tool_result", tool_use_id: "...", content: ... }]
            // (occasionally with multiple blocks if the assistant fired
            // multiple tool_uses; in that case ALL blocks are
            // tool_result). When every content block is a tool_result,
            // it's intra-turn -- skip the state transition entirely so
            // whatever state the prior assistant line set (running with
            // toolName, or thinking) carries through cleanly.
            const content = obj.message?.content;
            const isToolResultDelivery =
              Array.isArray(content)
              && content.length > 0
              && content.every((c) => c?.type === "tool_result");
            if (isToolResultDelivery) continue;

            this._activityState = "thinking";
            this._toolName = null;
            this._stateChangedAt = ts;
          }
        }
      } finally { await fh.close(); }
    } catch {
      return this._ready ? this._snapshot() : null;
    }
    this._ready = true;
    return this._snapshot();
  }

  // Scope to OUR JSONL only (via _resolvePath). Scanning every JSONL in the
  // cwd causes cross-contamination when multiple CC sessions share a repo.
  async discoverName() {
    const fp = await this._resolvePath();
    if (!fp) return undefined; // JSONL not ready — don't touch state
    let st;
    try { st = await fsp.stat(fp); } catch { return undefined; }
    let entry = this._nameCache.get(fp);
    if (!entry || entry.mtimeMs !== st.mtimeMs) {
      let content;
      try { content = await fsp.readFile(fp, "utf8"); } catch { return undefined; }
      let localBest = null;
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
      this._nameCache.set(fp, entry);
    }
    while (this._nameCache.size > NAME_CACHE_CAP) {
      const oldest = this._nameCache.keys().next().value;
      this._nameCache.delete(oldest);
    }
    return entry.latest ? entry.latest.name : null;
  }
}
