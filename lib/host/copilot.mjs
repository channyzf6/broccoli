// GitHub Copilot CLI adapter. Copilot stores each session as
//   <COPILOT_HOME>/session-state/<sessionId>/events.jsonl
// alongside a workspace.yaml carrying cwd + name metadata. COPILOT_HOME
// defaults to ~/.copilot.
//
// events.jsonl is a real-time append-only stream of records of the form
//   { type, data, id, timestamp, parentId }
// where `type` is the discriminator (session.start, user.message,
// assistant.turn_start/end, tool.execution_start/complete, hook.start/end,
// system.message, ...). Verified against @github/copilot 1.0.43.
//
// Activity model (minimal): track most-recent meaningful event timestamp
// plus a binary thinking/idle flag. user.message flips to "thinking",
// assistant.turn_end flips to "idle"; otherwise the state ticks to idle
// after 30s of no events as a defensive fallback. We do not extract
// per-tool name on day one — the dashboard's tool-name pill stays empty
// for Copilot sessions until / unless we want extended-mode parity.
//
// Session binding: we prefer to bind by `inuse.<pid>.lock` where <pid> is
// the copilot CLI's process id (= our proxy's process.ppid). The lock
// filename is the cleanest binding hook of any host; no timestamp window
// or cwd-collision disambiguation needed when it's present. Fallback for
// the brief race between session-start and lock-write: pick the session
// dir whose workspace.yaml.cwd matches ours and whose created_at is
// closest to sessionStart within a 30s window.

import fsp from "node:fs/promises";
import path from "node:path";
import { HostAdapter, HOST } from "./base.mjs";

const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
const SESSION_MATCH_WINDOW_MS = 30 * 1000;
const IDLE_AFTER_MS = 30 * 1000;

function copilotHome() {
  if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? path.join(home, ".copilot") : null;
}

function normCwd(p) {
  return String(p || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

// Tiny YAML-ish reader for the fields we care about (`cwd`, `name`,
// `user_named`, `created_at`). Avoids a yaml dep for a 6-key file. Each
// field is keyed on its own line; values may be unquoted or
// double-quoted; multi-line / nested YAML is not used by Copilot's
// workspace.yaml in practice.
function readWorkspaceField(yaml, field) {
  const re = new RegExp(`^${field}:\\s*(?:"([^"]*)"|(.+?))\\s*$`, "m");
  const m = re.exec(yaml);
  if (!m) return null;
  return (m[1] !== undefined ? m[1] : m[2]).trim();
}

// Read a session dir's workspace.yaml. Returns the parsed key/value
// fields we care about, or null on I/O / parse failure.
async function readWorkspace(dir) {
  let raw;
  try { raw = await fsp.readFile(path.join(dir, "workspace.yaml"), "utf8"); }
  catch { return null; }
  return {
    cwd: readWorkspaceField(raw, "cwd"),
    name: readWorkspaceField(raw, "name"),
    userNamed: readWorkspaceField(raw, "user_named") === "true",
    createdAt: readWorkspaceField(raw, "created_at"),
    raw,
  };
}

export class CopilotAdapter extends HostAdapter {
  name = HOST.COPILOT;
  displayName = "GitHub Copilot CLI";

  constructor(ctx) {
    super(ctx);
    // Sticky session-dir binding (the dir under session-state/ that holds
    // events.jsonl + workspace.yaml + the inuse.<pid>.lock file).
    this._sessionDir = null;
    // Activity-scanner state.
    this._path = null;
    this._readBytes = 0;
    this._count = 0;
    this._lastAt = null;
    this._activityState = null;
    this._stateChangedAt = null;
    this._ready = false;
    // Name watcher: workspace.yaml mtime cache so we don't re-parse the
    // file every 15s tick (the scan cadence for discoverName watchers).
    this._nameCache = { mtimeMs: null, name: null };
    // Parent-process pid used to match `inuse.<pid>.lock`. Read at
    // construction so tests can override before the first scan.
    this._parentPid = process.ppid;
  }

  _snapshot() {
    return {
      count: this._count,
      lastAt: this._lastAt,
      activityState: this._activityState,
      toolName: null,
      stateChangedAt: this._stateChangedAt,
    };
  }

  // Pure resolver — no shared state mutation. Returns the absolute path
  // to the session dir (containing events.jsonl + workspace.yaml + the
  // lock file) or null. Sticky once bound: subsequent calls short-circuit
  // unless the bound dir disappears.
  async _resolveSessionDir() {
    if (this._sessionDir) {
      try { await fsp.stat(this._sessionDir); return this._sessionDir; }
      catch { this._sessionDir = null; /* gone — re-resolve */ }
    }
    const home = copilotHome();
    if (!home) return null;
    const root = path.join(home, "session-state");
    let entries;
    try { entries = await fsp.readdir(root); } catch { return null; }

    const wantCwd = normCwd(this.cwd);
    const sessionStartMs = Date.parse(this.sessionStart);
    const lockName = `inuse.${this._parentPid}.lock`;
    let cwdBest = null;
    let cwdBestDelta = Infinity;
    for (const e of entries) {
      const dir = path.join(root, e);
      let st;
      try { st = await fsp.stat(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      // Primary: lock-file match. inuse.<copilotPid>.lock unambiguously
      // identifies the session our proxy was spawned by.
      try {
        await fsp.stat(path.join(dir, lockName));
        this._sessionDir = dir;
        return dir;
      } catch { /* no lock here — fall through to cwd match */ }
      // Fallback prep: collect cwd-matching candidates with their deltas.
      const ws = await readWorkspace(dir);
      if (!ws || !ws.cwd) continue;
      if (normCwd(ws.cwd) !== wantCwd) continue;
      const created = ws.createdAt ? Date.parse(ws.createdAt) : NaN;
      const delta = Number.isFinite(created)
        ? Math.abs(created - sessionStartMs)
        : Infinity;
      if (delta < cwdBestDelta) { cwdBestDelta = delta; cwdBest = dir; }
    }
    // Fallback: cwd + created_at within window. Used only when no
    // lock-file match exists (race window between session.start and the
    // lock being written, or copilot pid pivot we can't observe).
    if (cwdBest && cwdBestDelta < SESSION_MATCH_WINDOW_MS) {
      this._sessionDir = cwdBest;
      return cwdBest;
    }
    return null;
  }

  async _identifyForScan() {
    const dir = await this._resolveSessionDir();
    if (!dir) return null;
    const fp = path.join(dir, "events.jsonl");
    if (fp !== this._path) {
      this._ready = false;
      this._path = fp;
      this._readBytes = 0;
      this._count = 0;
      this._lastAt = null;
      this._activityState = null;
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
      this._count = 0;
      this._lastAt = null;
      this._activityState = null;
      this._stateChangedAt = null;
      this._ready = false;
    }
    if (this._readBytes < st.size) {
      try {
        const fh = await fsp.open(fp, "r");
        try {
          const remaining = st.size - this._readBytes;
          const toRead = Math.min(remaining, SCAN_CHUNK_BYTES);
          const buf = Buffer.alloc(toRead);
          const { bytesRead } = await fh.read(buf, 0, toRead, this._readBytes);
          if (bytesRead > 0) {
            const text = buf.toString("utf8", 0, bytesRead);
            const lastNl = text.lastIndexOf("\n");
            if (lastNl === -1) {
              if (bytesRead === toRead && remaining > toRead) {
                this._readBytes += toRead;
              }
            } else {
              this._readBytes += lastNl + 1;
              for (const line of text.slice(0, lastNl).split("\n")) {
                if (!line) continue;
                let obj; try { obj = JSON.parse(line); } catch { continue; }
                this._applyEvent(obj);
              }
            }
          }
        } finally { await fh.close(); }
      } catch {
        return this._ready ? this._snapshot() : null;
      }
    }
    // Time-based idle fallback. If we landed in "thinking" but no event
    // has bumped lastAt for IDLE_AFTER_MS, flip to "idle". This handles
    // sessions that exit mid-turn without writing an assistant.turn_end.
    if (
      this._activityState === "thinking"
      && this._lastAt
      && Date.now() - this._lastAt > IDLE_AFTER_MS
    ) {
      this._activityState = "idle";
      this._stateChangedAt = this._lastAt;
    }
    this._ready = true;
    return this._snapshot();
  }

  // Apply one events.jsonl record's effect on tail state. Filters out
  // events that aren't user-meaningful (session.start emits once per
  // session and shouldn't bump count; system.message and hook.* are
  // bookkeeping the user doesn't care about).
  _applyEvent(obj) {
    const t = obj?.type;
    if (!t) return;
    if (t === "session.start") return;
    if (t === "system.message") return;
    if (t === "hook.start" || t === "hook.end") return;
    const ts = obj?.timestamp ? Date.parse(obj.timestamp) : null;
    if (ts) this._lastAt = ts;
    this._count += 1;
    if (t === "user.message") {
      this._activityState = "thinking";
      if (ts) this._stateChangedAt = ts;
      return;
    }
    if (t === "assistant.turn_end") {
      this._activityState = "idle";
      if (ts) this._stateChangedAt = ts;
      return;
    }
    // Other meaningful events (assistant.message, tool.execution_*,
    // assistant.turn_start, session.model_change). Treat as continuation
    // of the current state — flip from idle/null up to thinking so a
    // dropped user.message (file read midway) still surfaces activity.
    if (this._activityState !== "thinking") {
      this._activityState = "thinking";
      if (ts) this._stateChangedAt = ts;
    }
  }

  // Read workspace.yaml's `name` field, gated on `user_named: true`. The
  // CLI auto-summarizes a name on every session (e.g. "View Staff
  // Features Gained"); we treat those as no-rename-present (return null)
  // for parity with how Codex and Gemini behave when the user hasn't
  // explicitly renamed. user_named:true is the slot a future /rename or
  // manual edit would set.
  async discoverName() {
    const dir = await this._resolveSessionDir();
    if (!dir) return undefined;
    const fp = path.join(dir, "workspace.yaml");
    let st;
    try { st = await fsp.stat(fp); } catch { return undefined; }
    if (this._nameCache.mtimeMs !== st.mtimeMs) {
      const ws = await readWorkspace(dir);
      this._nameCache = {
        mtimeMs: st.mtimeMs,
        name: ws && ws.userNamed && ws.name ? ws.name : null,
      };
    }
    return this._nameCache.name;
  }
}
