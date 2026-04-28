// Tests for ClaudeAdapter. Run with:
//   node --test lib/host/claude.test.mjs
//
// Resolver tests (added v0.4.6 #39 + v0.4.7 dot-encoding fix) stage a
// fake $HOME/.claude/projects/<encoded>/ tree in a tempdir and override
// USERPROFILE/HOME. scanActivity / discoverName tests bypass the
// resolver by monkey-patching _identifyForScan / _resolvePath, mirroring
// the gemini-test pattern.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "./claude.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = (n) => join(__dirname, "__fixtures__", n);

// CC's actual on-disk encoding: every : / \ _ . in cwd → "-". Must
// match the regex inside ClaudeAdapter._resolvePath; tests that diverge
// from the production rule mask the very bug they should catch.
const ccEncode = (cwd) => String(cwd).replace(/[.:\\/_]/g, "-");

// Build a project dir under a fake $HOME / $USERPROFILE that mirrors the
// real layout (~/.claude/projects/<encoded-cwd>/). Returns { home, dir }.
function makeProjectDir({ cwd }) {
  const home = mkdtempSync(path.join(tmpdir(), "ghs-claude-"));
  const dir = path.join(home, ".claude", "projects", ccEncode(cwd));
  mkdirSync(dir, { recursive: true });
  return { home, dir };
}

function writeJsonl(fp, lines, mtimeMs) {
  writeFileSync(fp, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  if (mtimeMs) {
    const sec = mtimeMs / 1000;
    utimesSync(fp, sec, sec);
  }
}

// Copy a __fixtures__ JSONL into a fake home and stamp its mtime so the
// "mtime >= sessionStart - 2s" gate passes (fixtures on disk are older
// than any test's notional sessionStart).
function stageJsonl({ home, cwd, fixture, sessionStartMs }) {
  const dir = path.join(home, ".claude", "projects", ccEncode(cwd));
  mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, "session-test.jsonl");
  copyFileSync(FIX(fixture), dst);
  const t = (sessionStartMs ?? Date.now()) / 1000;
  utimesSync(dst, t, t);
  return dst;
}

function withHome(home, fn) {
  const prevH = process.env.HOME;
  const prevU = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return Promise.resolve(fn()).finally(() => {
    if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
    if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU;
  });
}

// ---------------------------------------------------------------------------
// _resolvePath — sticky binding + last-line-ts heuristic (v0.4.6 / PR #39)
// ---------------------------------------------------------------------------

test("resolver picks the JSONL whose last-line ts is closest to sessionStart", async () => {
  const cwd = "C:\\fake\\proj";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    // Both files: first-entry timestamps 15+ min before sessionStart
    // (resumed-session shape). Last-entry timestamps differ — only A's
    // tail is near our sessionStart; B's tail is 4 minutes earlier.
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    const b = path.join(dir, "bbbb.jsonl");
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:08:00.000Z", content: "old" },
      { type: "assistant", timestamp: "2026-04-27T15:23:38.500Z", message: { content: [] } },
    ], Date.parse("2026-04-27T15:23:38.500Z"));
    writeJsonl(b, [
      { type: "user", timestamp: "2026-04-27T15:11:00.000Z", content: "old" },
      { type: "assistant", timestamp: "2026-04-27T15:20:00.000Z", message: { content: [] } },
    ], Date.parse("2026-04-27T15:23:39.000Z")); // freshest mtime — would have won under old fallback

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const pick = await ad._resolvePath();
      assert.equal(pick, a, "last-line ts on A is 0.5s from sessionStart; B's is 3:39 — A must win");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver returns null (no fallback) when no JSONL's last-line ts is within 30s", async () => {
  const cwd = "C:\\fake\\proj2";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    const b = path.join(dir, "bbbb.jsonl");
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:09:00.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:23:40.000Z"));
    writeJsonl(b, [
      { type: "user", timestamp: "2026-04-27T15:11:00.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:23:39.500Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const pick = await ad._resolvePath();
      assert.equal(pick, null, "no candidate within 30s window — must not fall back to most-recent mtime");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver is sticky: subsequent calls return the cached path even if a sibling becomes more recent", async () => {
  const cwd = "C:\\fake\\proj3";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    const b = path.join(dir, "bbbb.jsonl");
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:23:38.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:23:38.000Z"));
    writeJsonl(b, [
      { type: "user", timestamp: "2026-04-27T15:20:00.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:20:00.000Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const first = await ad._resolvePath();
      assert.equal(first, a, "first call binds to A");

      writeJsonl(b, [
        { type: "user", timestamp: "2026-04-27T15:23:38.000Z", content: "x" },
        { type: "assistant", timestamp: "2026-04-27T15:30:00.000Z", message: { content: [] } },
      ], Date.parse("2026-04-27T15:30:00.000Z"));

      const second = await ad._resolvePath();
      assert.equal(second, a, "sticky binding: subsequent call still returns A despite B now being most-recent");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver re-binds if the cached file disappears", async () => {
  const cwd = "C:\\fake\\proj4";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:23:39.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:23:39.000Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      assert.equal(await ad._resolvePath(), a);
      rmSync(a);
      const after = await ad._resolvePath();
      assert.equal(after, null, "cached path stat fails — re-resolve runs and finds nothing");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("first-line ts: binds OUR new session over an active sibling neither of which is in the last-line ts window", async () => {
  // Multi-sibling lazy-mode case. Our session B is brand new (first-
  // line ts ≈ sessionStart), sibling A has been running for a while
  // (its last-line ts is past OUR 30s window). Both pass the mtime
  // filter (both touched after our sessionStart-2s). Without first-
  // line ts, neither qualifies under the 30s last-line window, the
  // single-candidate fallback can't fire (2 candidates), and we
  // return null. With min(first-line, last-line) ts as the delta, B's
  // first-line ts wins.
  const cwd = "C:\\fake\\proj-multi-active";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z"; // OUR session
    const a = path.join(dir, "sibling.jsonl");
    const b = path.join(dir, "ours.jsonl");

    // Sibling A: first-line 30 min old (sibling's own session start),
    // last-line 50s before OUR sessionStart (out of 30s window), and
    // mtime SAME as last-line — so passes mtime filter only marginally
    // by being touched recently. Then assume the sibling kept being
    // touched after that to keep mtime fresh (we set it to T+5min).
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T14:53:39.000Z", content: "siblings start" },
      { type: "assistant", timestamp: "2026-04-27T15:22:49.000Z", message: { content: [] } }, // 50s before our start
    ], Date.parse("2026-04-27T15:28:39.000Z")); // mtime fresh

    // Our session B: first-line ts is right at sessionStart. But the
    // user has been chatting for a few min, so last-line ts is past
    // the window.
    writeJsonl(b, [
      { type: "attachment", timestamp: "2026-04-27T15:23:39.500Z" },
      { type: "user", timestamp: "2026-04-27T15:24:39.000Z", content: "rename foo" },
      { type: "assistant", timestamp: "2026-04-27T15:30:00.000Z", message: { content: [] } },
    ], Date.parse("2026-04-27T15:30:00.000Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const pick = await ad._resolvePath();
      assert.equal(pick, b, "must bind to OUR JSONL via first-line ts proximity; sibling A's last-line ts is out of window and first-line is ancient");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("first-line ts: still picks last-line proximity for resumed sessions (PR #39 invariant)", async () => {
  // Belt-and-suspenders for PR #39's fix: two RESUMED siblings, both
  // with ancient first-line ts (original session starts), but A's last-line
  // is closer to sessionStart than B's. min(first, last) reduces to last
  // for both (their first-line tss are huge), so A still wins.
  const cwd = "C:\\fake\\proj-resumed-pair";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "aaaa.jsonl");
    const b = path.join(dir, "bbbb.jsonl");
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T14:00:00.000Z", content: "ancient" }, // first
      { type: "assistant", timestamp: "2026-04-27T15:23:38.500Z", message: { content: [] } }, // last close
    ], Date.parse("2026-04-27T15:23:38.500Z"));
    writeJsonl(b, [
      { type: "user", timestamp: "2026-04-27T13:30:00.000Z", content: "ancient" }, // first
      { type: "assistant", timestamp: "2026-04-27T15:20:00.000Z", message: { content: [] } }, // last 219s away
    ], Date.parse("2026-04-27T15:23:39.000Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const pick = await ad._resolvePath();
      assert.equal(pick, a, "PR #39 invariant: among resumed siblings, last-line ts proximity still disambiguates");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("single-candidate fallback: binds the only eligible JSONL even when its last-line ts is beyond the 30s window", async () => {
  // Repro of the lazy-mode bug: in the default (non-AUTOSTART) proxy
  // mode, registerSession runs on the FIRST MCP tool call, which can
  // happen many minutes after sessionStart. By then the JSONL's
  // last-line ts is far outside the 30s freshness window. The strict
  // window is needed only for disambiguation when SIBLING JSONLs
  // exist; with exactly one candidate (the common case), there's
  // nothing to disambiguate — we should bind it.
  const cwd = "C:\\fake\\proj-lazy";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const a = path.join(dir, "only.jsonl");
    // mtime well after sessionStart-2s (passes filter), but last-line
    // ts is 5 minutes after sessionStart — well outside the 30s window.
    writeJsonl(a, [
      { type: "user", timestamp: "2026-04-27T15:23:40.000Z", content: "x" },
      { type: "assistant", timestamp: "2026-04-27T15:28:39.000Z", message: { content: [] } },
    ], Date.parse("2026-04-27T15:28:39.000Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const pick = await ad._resolvePath();
      assert.equal(pick, a, "single eligible candidate must bind regardless of last-line ts position — disambiguation only matters with siblings");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ignores a JSONL whose mtime is older than sessionStart-2s", async () => {
  const cwd = "C:\\fake\\proj5";
  const { home, dir } = makeProjectDir({ cwd });
  try {
    const sessionStart = "2026-04-27T15:23:39.000Z";
    const stale = path.join(dir, "stale.jsonl");
    writeJsonl(stale, [
      { type: "user", timestamp: "2026-04-27T15:23:39.000Z", content: "x" },
    ], Date.parse("2026-04-27T15:00:00.000Z"));

    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      assert.equal(await ad._resolvePath(), null, "stale-mtime file filtered out before tail-read");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// _resolvePath — cwd encoder (v0.4.7 dot-encoding fix)
// ---------------------------------------------------------------------------

test("resolver: cwd containing a dot resolves correctly (regression: worktree under .claude/)", async () => {
  const cwd = "/home/u/repo/.claude/worktrees/f1";
  const sessionStart = "2026-04-27T15:30:00.000Z";
  const home = mkdtempSync(join(tmpdir(), "ghs-claude-"));
  try {
    const expected = stageJsonl({
      home, cwd, fixture: "claude-basic.jsonl",
      sessionStartMs: Date.parse(sessionStart),
    });
    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const got = await ad._resolvePath();
      assert.equal(got, expected, "dot-encoded directory must resolve");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver: cwd without a dot still works (no regression)", async () => {
  const cwd = "/home/u/repo";
  const sessionStart = "2026-04-27T15:30:00.000Z";
  const home = mkdtempSync(join(tmpdir(), "ghs-claude-"));
  try {
    const expected = stageJsonl({
      home, cwd, fixture: "claude-basic.jsonl",
      sessionStartMs: Date.parse(sessionStart),
    });
    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const got = await ad._resolvePath();
      assert.equal(got, expected);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolver: returns null when projects dir missing", async () => {
  const home = mkdtempSync(join(tmpdir(), "ghs-claude-"));
  try {
    await withHome(home, async () => {
      const ad = new ClaudeAdapter({
        cwd: "/nope",
        sessionStart: "2026-04-27T15:30:00.000Z",
        pid: 1,
      });
      assert.equal(await ad._resolvePath(), null);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanActivity — state transitions across the JSONL
// ---------------------------------------------------------------------------

test("scanActivity: counts tool_use and ends idle when assistant ends on text", async () => {
  const a = new ClaudeAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-27T15:30:00.000Z",
    pid: 1,
  });
  a._identifyForScan = async () => {
    a._path = FIX("claude-basic.jsonl");
    return a._path;
  };
  const snap = await a.scanActivity();
  assert.equal(snap.count, 2, "two tool_use entries across the transcript");
  assert.equal(snap.activityState, "idle", "final assistant ended on text → idle");
  assert.equal(snap.toolName, null);
});

test("scanActivity: tool_result-only user lines do NOT transition state (v0.4.3 regression)", async () => {
  const tmp = join(mkdtempSync(join(tmpdir(), "ghs-claude-")), "s.jsonl");
  writeFileSync(tmp, [
    JSON.stringify({type:"assistant",timestamp:"2026-04-27T15:30:01.000Z",message:{content:[{type:"tool_use",name:"Read",id:"t1",input:{}}],stop_reason:"tool_use"}}),
    JSON.stringify({type:"user",timestamp:"2026-04-27T15:30:02.000Z",message:{content:[{type:"tool_result",tool_use_id:"t1",content:"ok"}]}}),
    "",
  ].join("\n"));

  const a = new ClaudeAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-27T15:30:00.000Z",
    pid: 1,
  });
  a._identifyForScan = async () => { a._path = tmp; return tmp; };
  const snap = await a.scanActivity();
  assert.equal(snap.activityState, "running", "tool_result delivery must not flip state to thinking");
  assert.equal(snap.toolName, "Read");
});

test("scanActivity: isMeta:true synthetic user lines are skipped (v0.4.4 regression)", async () => {
  const tmp = join(mkdtempSync(join(tmpdir(), "ghs-claude-")), "s.jsonl");
  writeFileSync(tmp, [
    JSON.stringify({type:"assistant",timestamp:"2026-04-27T15:30:01.000Z",message:{content:[{type:"text",text:"done"}]}}),
    JSON.stringify({type:"user",timestamp:"2026-04-27T15:30:02.000Z",isMeta:true,message:{content:"<system-reminder>x</system-reminder>"}}),
    "",
  ].join("\n"));

  const a = new ClaudeAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-27T15:30:00.000Z",
    pid: 1,
  });
  a._identifyForScan = async () => { a._path = tmp; return tmp; };
  const snap = await a.scanActivity();
  assert.equal(snap.activityState, "idle", "synthetic isMeta line must not flip state to thinking");
});

test("scanActivity: real user prompt → thinking", async () => {
  const tmp = join(mkdtempSync(join(tmpdir(), "ghs-claude-")), "s.jsonl");
  writeFileSync(tmp, [
    JSON.stringify({type:"assistant",timestamp:"2026-04-27T15:30:01.000Z",message:{content:[{type:"text",text:"hi"}]}}),
    JSON.stringify({type:"user",timestamp:"2026-04-27T15:30:02.000Z",message:{content:"another prompt"}}),
    "",
  ].join("\n"));

  const a = new ClaudeAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-27T15:30:00.000Z",
    pid: 1,
  });
  a._identifyForScan = async () => { a._path = tmp; return tmp; };
  const snap = await a.scanActivity();
  assert.equal(snap.activityState, "thinking");
  assert.equal(snap.toolName, null);
});

test("scanActivity: incremental — only new bytes are reparsed across calls", async () => {
  const tmp = join(mkdtempSync(join(tmpdir(), "ghs-claude-")), "s.jsonl");
  const line1 = JSON.stringify({type:"assistant",timestamp:"2026-04-27T15:30:01.000Z",message:{content:[{type:"tool_use",name:"Read",id:"t1",input:{}}],stop_reason:"tool_use"}}) + "\n";
  writeFileSync(tmp, line1);

  const a = new ClaudeAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-27T15:30:00.000Z",
    pid: 1,
  });
  a._identifyForScan = async () => { a._path = tmp; return tmp; };

  let snap = await a.scanActivity();
  assert.equal(snap.count, 1);
  assert.equal(snap.activityState, "running");

  const line2 = JSON.stringify({type:"assistant",timestamp:"2026-04-27T15:30:03.000Z",message:{content:[{type:"text",text:"bye"}]}}) + "\n";
  writeFileSync(tmp, line1 + line2);
  snap = await a.scanActivity();
  assert.equal(snap.count, 1, "first line not double-counted on second scan");
  assert.equal(snap.activityState, "idle");
});

// ---------------------------------------------------------------------------
// discoverName — /rename detection
// ---------------------------------------------------------------------------

test("discoverName: returns the most recent /rename argument", async () => {
  const cwd = "/home/u/repo/.claude/worktrees/f1";
  const sessionStart = "2026-04-27T15:30:00.000Z";
  const home = mkdtempSync(join(tmpdir(), "ghs-claude-"));
  try {
    stageJsonl({
      home, cwd, fixture: "claude-rename.jsonl",
      sessionStartMs: Date.parse(sessionStart),
    });
    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      const name = await ad.discoverName();
      assert.equal(name, "my-session-v2", "latest /rename wins");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverName: returns null when JSONL has no /rename line", async () => {
  const cwd = "/home/u/repo";
  const sessionStart = "2026-04-27T15:30:00.000Z";
  const home = mkdtempSync(join(tmpdir(), "ghs-claude-"));
  try {
    stageJsonl({
      home, cwd, fixture: "claude-basic.jsonl",
      sessionStartMs: Date.parse(sessionStart),
    });
    await withHome(home, async () => {
      const ad = new ClaudeAdapter({ cwd, sessionStart, pid: 1 });
      assert.equal(await ad.discoverName(), null);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("discoverName: returns undefined when JSONL not yet written", async () => {
  const home = mkdtempSync(join(tmpdir(), "ghs-claude-"));
  try {
    await withHome(home, async () => {
      const ad = new ClaudeAdapter({
        cwd: "/home/u/repo",
        sessionStart: "2026-04-27T15:30:00.000Z",
        pid: 1,
      });
      assert.equal(await ad.discoverName(), undefined);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
