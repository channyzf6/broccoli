// Host detection + adapter selection. The proxy calls this once at startup
// to figure out which CLI spawned it (Claude Code, Gemini CLI, ...) and
// gets back a configured HostAdapter it will call for activity + name work.

import fsp from "node:fs/promises";
import path from "node:path";
import { HOST, HostAdapter } from "./base.mjs";
import { ClaudeAdapter } from "./claude.mjs";
import { GeminiAdapter } from "./gemini.mjs";
import { CodexAdapter, CANDIDATE_DAY_COUNT as CODEX_DAY_COUNT } from "./codex.mjs";

// Probe Claude's per-cwd transcript dir. Returns {mtime} of the most-recent
// .jsonl in that dir, or null if nothing's there. cwd encoding must match
// what Claude Code uses: replace [:\/_] with "-".
async function probeClaudeDir(cwd) {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  const encoded = String(cwd).replace(/[:\\/_]/g, "-");
  const dir = path.join(home, ".claude", "projects", encoded);
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return null; }
  let mostRecent = 0;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const st = await fsp.stat(path.join(dir, f));
      if (st.mtimeMs > mostRecent) mostRecent = st.mtimeMs;
    } catch { /* skip unreadable */ }
  }
  return mostRecent > 0 ? { mtime: mostRecent } : null;
}

// Probe Gemini's tmp dirs. Iterate each subdir of ~/.gemini/tmp, read
// .project_root, match on cwd. Returns {mtime} of most-recent chat file
// in that tmp dir, or null if no match or no chats.
async function probeGeminiDir(cwd) {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  const tmpDir = path.join(home, ".gemini", "tmp");
  let entries;
  try { entries = await fsp.readdir(tmpDir); } catch { return null; }
  const want = String(cwd).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  for (const e of entries) {
    const entryPath = path.join(tmpDir, e);
    let st; try { st = await fsp.stat(entryPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    let pr;
    try { pr = await fsp.readFile(path.join(entryPath, ".project_root"), "utf8"); } catch { continue; }
    const norm = pr.trim().toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm !== want) continue;
    // Match found — get latest chat mtime for tie-breaking against Claude.
    const chatsDir = path.join(entryPath, "chats");
    let chatFiles;
    try { chatFiles = await fsp.readdir(chatsDir); } catch { return { mtime: st.mtimeMs }; }
    let latest = 0;
    for (const f of chatFiles) {
      if (!f.endsWith(".json")) continue;
      try {
        const fst = await fsp.stat(path.join(chatsDir, f));
        if (fst.mtimeMs > latest) latest = fst.mtimeMs;
      } catch { /* skip */ }
    }
    return { mtime: latest > 0 ? latest : st.mtimeMs };
  }
  return null;
}

// Probe Codex's date-bucketed sessions tree. Codex doesn't put each cwd in
// its own dir like Claude / Gemini do; instead each rollout file's first
// line carries the cwd in its session_meta payload. We scan a small
// window of UTC date dirs walking backward from today, read the first
// ~2KB of each rollout-*.jsonl, and match cwd. The window covers
// sessions started near midnight (yesterday) and multi-day resumes
// (day-before-yesterday). Returns {mtime} of the most-recent matching
// file or null.
async function probeCodexDir(cwd) {
  const homeRoot = process.env.USERPROFILE || process.env.HOME;
  const home = process.env.CODEX_HOME
    || (homeRoot ? path.join(homeRoot, ".codex") : null);
  if (!home) return null;
  const sessionsRoot = path.join(home, "sessions");
  const want = String(cwd).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  const now = Date.now();
  let mostRecent = 0;
  // Same window as codex.mjs._resolvePath. detectHost runs at proxy
  // startup, so `now` ≈ sessionStart anyway — the anchor difference is
  // immaterial in practice. Imported constant keeps the two in sync.
  for (let i = 0; i < CODEX_DAY_COUNT; i++) {
    const d = new Date(now - i * 86400000);
    const dir = path.join(
      sessionsRoot,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    );
    let entries;
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f);
      // Read first 2KB only — first line is always session_meta.
      let metaCwd = null;
      try {
        const fh = await fsp.open(fp, "r");
        try {
          const buf = Buffer.alloc(2048);
          const { bytesRead } = await fh.read(buf, 0, 2048, 0);
          if (bytesRead) {
            const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
            const obj = JSON.parse(firstLine);
            if (obj?.type === "session_meta" && obj.payload?.cwd) {
              metaCwd = obj.payload.cwd;
            }
          }
        } finally { await fh.close(); }
      } catch { continue; }
      if (!metaCwd) continue;
      const mc = String(metaCwd).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
      if (mc !== want) continue;
      try {
        const st = await fsp.stat(fp);
        if (st.mtimeMs > mostRecent) mostRecent = st.mtimeMs;
      } catch { /* skip */ }
    }
  }
  return mostRecent > 0 ? { mtime: mostRecent } : null;
}

/**
 * Detect which host CLI launched us.
 *
 * Priority:
 *   1. SESSIONS_DASHBOARD_HOST env var (explicit override — always wins).
 *   2. Dir-probe: check which host(s) have transcripts for this cwd. If
 *      only one has, pick it. If multiple, pick whichever has the most
 *      recently active transcript; tie-break in declaration order
 *      (Claude > Gemini > Codex) for backwards-compat.
 *   3. CLAUDE fallback (backward-compat for all existing installs).
 *
 * @param {{ cwd: string }} ctx
 * @returns {Promise<string>}  one of HOST.*
 */
export async function detectHost({ cwd } = {}) {
  const declared = (process.env.SESSIONS_DASHBOARD_HOST || "").toLowerCase().trim();
  if (declared === HOST.CLAUDE) return HOST.CLAUDE;
  if (declared === HOST.GEMINI) return HOST.GEMINI;
  if (declared === HOST.CODEX)  return HOST.CODEX;
  if (!cwd) return HOST.CLAUDE;

  const [claudeHit, geminiHit, codexHit] = await Promise.all([
    probeClaudeDir(cwd),
    probeGeminiDir(cwd),
    probeCodexDir(cwd),
  ]);
  // Build the list of hits in stable declaration order so ties resolve
  // Claude > Gemini > Codex.
  const hits = [
    { host: HOST.CLAUDE, hit: claudeHit },
    { host: HOST.GEMINI, hit: geminiHit },
    { host: HOST.CODEX,  hit: codexHit  },
  ].filter((x) => x.hit);
  if (hits.length === 0) return HOST.CLAUDE;
  if (hits.length === 1) return hits[0].host;
  // Multiple hits: most-recent mtime wins; declaration-order break on tie
  // (sort is stable in V8).
  hits.sort((a, b) => b.hit.mtime - a.hit.mtime);
  return hits[0].host;
}

/**
 * Construct a HostAdapter for the detected host.
 * @param {{ host: string, cwd: string, sessionStart: string, pid: number }} ctx
 * @returns {HostAdapter}
 */
export function makeAdapter({ host, cwd, sessionStart, pid }) {
  if (host === HOST.GEMINI) return new GeminiAdapter({ cwd, sessionStart, pid });
  if (host === HOST.CODEX)  return new CodexAdapter({ cwd, sessionStart, pid });
  // Default: Claude (also the fallback for HOST.UNKNOWN and unset).
  return new ClaudeAdapter({ cwd, sessionStart, pid });
}
