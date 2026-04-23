// Tests for GeminiAdapter. Run with:
//   node --test lib/host/gemini.test.mjs
// No external test framework — uses Node's built-in `node:test`.
//
// Tests bypass `_locate()` (the disk-walking session-finder) by monkey-
// patching it to return the fixture path. scanActivity() always re-calls
// _locate at the top, so setting _chatFilePath directly does not work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { GeminiAdapter } from "./gemini.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = (n) => join(__dirname, "__fixtures__", n);

test("test runner sanity", () => {
  assert.equal(1 + 1, 2);
});

test("legacy .json: parses atomic ConversationRecord and derives snapshot", async () => {
  const a = new GeminiAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-22T04:13:55.394Z",
    pid: 1,
  });
  a._locate = async () => FIX("gemini-legacy.json");
  const snap = await a.scanActivity();
  assert.equal(snap.count, 1, "one tool call counted across the conversation");
  assert.equal(snap.activityState, "idle", "no recent calls within RECENT_CALL_MS → idle");
  assert.equal(snap.toolName, null);
});

test("jsonl basic: parses replay records into ConversationRecord", async () => {
  const a = new GeminiAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-23T17:00:00Z",
    pid: 1,
  });
  a._locate = async () => FIX("gemini-jsonl-basic.jsonl");
  const snap = await a.scanActivity();
  assert.equal(snap.count, 1, "one tool call across the conversation");
  assert.equal(snap.activityState, "idle", "no calls within RECENT_CALL_MS → idle");
});

test("jsonl $set: metadata merge does not lose messages", async () => {
  const a = new GeminiAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-23T17:00:00Z",
    pid: 1,
  });
  a._locate = async () => FIX("gemini-jsonl-set.jsonl");
  await a.scanActivity();
  // White-box: inspect the materialized ConversationRecord directly.
  assert.equal(a._parsedCache.messages.length, 2);
  assert.equal(a._parsedCache.summary, "first turn done");
  assert.equal(a._parsedCache.lastUpdated, "2026-04-23T17:05:00Z");
});

test("jsonl $rewindTo: drops the named message and everything after, then continues", async () => {
  const a = new GeminiAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-23T17:00:00Z",
    pid: 1,
  });
  a._locate = async () => FIX("gemini-jsonl-rewind.jsonl");
  await a.scanActivity();
  const ids = a._parsedCache.messages.map((m) => m.id);
  assert.deepEqual(ids, ["m1", "m2", "m3b"], "m3 dropped, m3b appended after the rewind");
});

test("jsonl malformed line: skipped, surrounding lines still parse", async () => {
  const a = new GeminiAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-23T17:00:00Z",
    pid: 1,
  });
  a._locate = async () => FIX("gemini-jsonl-malformed.jsonl");
  await a.scanActivity();
  const ids = a._parsedCache.messages.map((m) => m.id);
  assert.deepEqual(ids, ["m1", "m2"], "garbage line skipped, m2 still picked up");
});

test("jsonl partial trailing line: prior records survive", async () => {
  const full = readFileSync(FIX("gemini-jsonl-rewind.jsonl"), "utf8");
  const truncated = full.slice(0, full.length - 30); // chop the tail
  const tmp = join(mkdtempSync(join(tmpdir(), "ghs-")), "session-x.jsonl");
  writeFileSync(tmp, truncated);

  const a = new GeminiAdapter({
    cwd: "/irrelevant",
    sessionStart: "2026-04-23T17:00:00Z",
    pid: 1,
  });
  a._locate = async () => tmp;
  await a.scanActivity();
  // Don't assert exact count (depends on truncation point); minimum 1
  // earlier message must survive and no exception was thrown.
  assert.ok(a._parsedCache.messages.length >= 1, "at least one earlier message survives a mid-write truncation");
});
