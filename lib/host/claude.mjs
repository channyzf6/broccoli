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
    // Sticky JSONL binding. Once _resolvePath returns a path it gets cached
    // here; subsequent calls short-circuit. See _resolvePath for why.
    this._resolvedPath = null;
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

  // Sticky JSONL resolver. Once we've bound to a file we keep that binding
  // for the proxy's lifetime; only invalidates if the bound file goes away.
  //
  // Why sticky: re-running the heuristic every tick is what causes
  // cross-session contamination. With two resumed CC sessions in the same
  // cwd, both .jsonl files have first-entry timestamps from the original
  // (pre-resume) start — many minutes before either proxy's sessionStart.
  // Neither qualifies under the bestDelta window; the resolver falls
  // through to "most-recent mtime" and ping-pongs as each underlying
  // session writes activity.
  //
  // Initial-bind heuristic: read each candidate's LAST line timestamp and
  // pick the one closest to our sessionStart within 30s. Last-line is the
  // right anchor because on resume CC writes new entries within seconds
  // of the proxy starting, while a sibling session's last-line ts is
  // either old (sibling not yet resumed) or anchored on the sibling's own
  // sessionStart (different time). The previous first-line heuristic
  // failed the resumed-sibling case because first-line ts is invariant
  // across resumes.
  //
  // No mtime fallback: with multiple stale sibling .jsonls, most-recent
  // mtime can't tell us which is ours and may cross-resolve. If no
  // candidate is within the window, return null and let the watcher try
  // again next tick — same soft-fail pattern as the Codex adapter.
  async _resolvePath() {
    if (this._resolvedPath) {
      try { await fsp.stat(this._resolvedPath); return this._resolvedPath; }
      catch { this._resolvedPath = null; /* file gone — re-resolve */ }
    }
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return null;
    // CC's encoder collapses dots too — without "." here, worktrees
    // under ".claude/" silently resolve to a non-existent dir.
    const encoded = this.cwd.replace(/[.:\\/_]/g, "-");
    const dir = path.join(home, ".claude", "projects", encoded);
    let entries;
    try { entries = await fsp.readdir(dir); } catch { return null; }
    const sessionStartMs = Date.parse(this.sessionStart);
    let best = null;
    let bestDelta = Infinity;
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f);
      let st;
      try { st = await fsp.stat(fp); } catch { continue; }
      if (st.mtimeMs < sessionStartMs - 2000) continue;
      const lastTs = await this._readLastLineTimestamp(fp, st.size);
      if (!lastTs) continue;
      const delta = Math.abs(lastTs - sessionStartMs);
      if (delta < bestDelta) { bestDelta = delta; best = fp; }
    }
    if (best && bestDelta < 30000) {
      this._resolvedPath = best;
      return best;
    }
    return null;
  }

  // Read the last 8 KB of `fp` and return the most-recent line's timestamp
  // (epoch ms), or null on read/parse failure. The leading partial line is
  // dropped; we walk lines from the end and return the first parseable
  // timestamp encountered. 8 KB comfortably fits a final assistant turn at
  // the file sizes CC produces; oversized turns just fall back to null and
  // _resolvePath skips that candidate this tick (it'll be retried next).
  async _readLastLineTimestamp(fp, size) {
    if (!size) return null;
    const READ = 8192;
    const offset = Math.max(0, size - READ);
    let fh;
    try { fh = await fsp.open(fp, "r"); } catch { return null; }
    try {
      const want = Math.min(READ, size);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (bytesRead === 0) return null;
      let text = buf.toString("utf8", 0, bytesRead);
      if (offset > 0) {
        const nl = text.indexOf("\n");
        if (nl === -1) return null;
        text = text.slice(nl + 1);
      }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.timestamp) {
          const ts = Date.parse(obj.timestamp);
          if (ts) return ts;
        }
      }
      return null;
    } finally { try { await fh.close(); } catch { /* ignore */ } }
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
            // Three flavors of type="user" lines exist; only the first
            // is a real prompt that should transition state to "thinking":
            //
            //   1. Real user prompt -- string content, isMeta=undefined.
            //      The user actually typed something. -> thinking.
            //   2. tool_result delivery -- array content of all
            //      tool_result blocks, isMeta=undefined. Intra-turn
            //      agent loop; skip (state stays as the prior assistant
            //      line set it).
            //   3. System-reminder injection -- isMeta=true, string
            //      content like "<system-reminder>The user named this
            //      session 'X'...</system-reminder>". Claude Code emits
            //      these to inform the LLM about out-of-band events
            //      (e.g., after /rename). NOT a real prompt. Skip.
            //
            // Treating every type="user" line as a real prompt was the
            // root cause of two long-standing bugs: mid-turn pill
            // flicker (oscillating thinking <-> running on each
            // tool_result line) and "pill stuck on working" -- the
            // latter triggered both by tool_result-terminated turns
            // (v0.4.3 fix) AND by /rename injecting a synthetic user
            // line with no follow-up (v0.4.4 fix). isMeta=true is the
            // clean marker for synthetic content -- both real prompts
            // and tool_result deliveries leave it undefined.

            // Filter 1: synthetic user lines (system-reminder, etc.)
            if (obj.isMeta === true) continue;

            // Filter 2: tool_result deliveries.
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
