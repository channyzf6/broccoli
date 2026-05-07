// Tests for the Copilot CLI host adapter. Drives scanActivity and
// discoverName against handcrafted session-state trees that mimic the
// shape `~/.copilot/session-state/<id>/{events.jsonl, workspace.yaml,
// inuse.<pid>.lock}` we observed empirically against @github/copilot
// 1.0.43.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CopilotAdapter } from "./copilot.mjs";

async function makeHome(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "copilot-test-"));
  t.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
  await fsp.mkdir(path.join(dir, "session-state"), { recursive: true });
  return dir;
}

async function writeSession(home, id, { events = [], workspace = {}, lockPid = null } = {}) {
  const dir = path.join(home, "session-state", id);
  await fsp.mkdir(dir, { recursive: true });
  const wsLines = [
    `id: ${id}`,
    `cwd: ${workspace.cwd ?? "C:\\Users\\test\\proj"}`,
    workspace.name != null ? `name: ${workspace.name}` : null,
    `user_named: ${workspace.userNamed === true ? "true" : "false"}`,
    workspace.createdAt ? `created_at: ${workspace.createdAt}` : null,
  ].filter((x) => x !== null).join("\n") + "\n";
  await fsp.writeFile(path.join(dir, "workspace.yaml"), wsLines);
  const eventsText = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
  await fsp.writeFile(path.join(dir, "events.jsonl"), eventsText);
  if (lockPid != null) {
    await fsp.writeFile(path.join(dir, `inuse.${lockPid}.lock`), String(lockPid));
  }
  return dir;
}

function makeAdapter({ home, cwd, sessionStart, parentPid }) {
  process.env.COPILOT_HOME = home;
  const a = new CopilotAdapter({
    cwd: cwd ?? "C:\\Users\\test\\proj",
    sessionStart: sessionStart ?? "2026-05-07T15:00:00.000Z",
    pid: 1234,
  });
  if (parentPid != null) a._parentPid = parentPid;
  return a;
}

test("scanActivity returns null when no session matches", async (t) => {
  const home = await makeHome(t);
  const a = makeAdapter({ home, parentPid: 99999 });
  assert.equal(await a.scanActivity(), null);
});

test("scanActivity binds via inuse.<ppid>.lock and counts user-meaningful events", async (t) => {
  const home = await makeHome(t);
  // Use timestamps near now() so the time-based idle fallback (>30s
  // since last activity) doesn't fire for events that "just happened".
  const now = Date.now();
  const ts = (msAgo) => new Date(now - msAgo).toISOString();
  await writeSession(home, "s1", {
    lockPid: 4708,
    workspace: { cwd: "C:\\Users\\test\\proj", userNamed: false, createdAt: ts(10000) },
    events: [
      { type: "session.start", data: {}, id: "e1", timestamp: ts(9000) },
      { type: "system.message", data: {}, id: "e2", timestamp: ts(8900) },
      { type: "user.message", data: { content: "hi" }, id: "e3", timestamp: ts(2000) },
      { type: "tool.execution_start", data: { toolName: "grep" }, id: "e4", timestamp: ts(1900) },
      { type: "hook.start", data: {}, id: "e5", timestamp: ts(1800) },
      { type: "hook.end", data: {}, id: "e6", timestamp: ts(1700) },
      { type: "tool.execution_complete", data: {}, id: "e7", timestamp: ts(1500) },
    ],
  });
  const a = makeAdapter({ home, parentPid: 4708, sessionStart: ts(10000) });
  const snap = await a.scanActivity();
  assert.equal(snap.count, 3, "session.start + system.message + hook.* must be filtered out");
  assert.equal(snap.activityState, "thinking");
  assert.equal(snap.toolName, null, "minimal model exposes no toolName");
  assert.equal(snap.lastAt, Date.parse(ts(1500)));
});

test("scanActivity flips to idle on assistant.turn_end", async (t) => {
  const home = await makeHome(t);
  await writeSession(home, "s2", {
    lockPid: 5000,
    workspace: { cwd: "C:\\Users\\test\\proj", userNamed: false, createdAt: "2026-05-07T15:00:00.000Z" },
    events: [
      { type: "user.message", data: {}, id: "e1", timestamp: "2026-05-07T15:00:01.000Z" },
      { type: "assistant.turn_end", data: { turnId: "0" }, id: "e2", timestamp: "2026-05-07T15:00:02.000Z" },
    ],
  });
  const a = makeAdapter({ home, parentPid: 5000 });
  const snap = await a.scanActivity();
  assert.equal(snap.activityState, "idle");
  assert.equal(snap.stateChangedAt, Date.parse("2026-05-07T15:00:02.000Z"));
});

test("falls back to cwd+createdAt match when no inuse.<ppid>.lock present", async (t) => {
  const home = await makeHome(t);
  const now = Date.now();
  const ts = (msAgo) => new Date(now - msAgo).toISOString();
  await writeSession(home, "near", {
    workspace: { cwd: "C:\\Users\\test\\proj", userNamed: false, createdAt: ts(2500) },
    events: [{ type: "user.message", data: {}, id: "e1", timestamp: ts(2000) }],
  });
  await writeSession(home, "far", {
    // Way outside the 30s SESSION_MATCH_WINDOW_MS, must not be picked.
    workspace: { cwd: "C:\\Users\\test\\proj", userNamed: false, createdAt: ts(3600000) },
    events: [{ type: "user.message", data: {}, id: "e1", timestamp: ts(3600000) }],
  });
  const a = makeAdapter({ home, parentPid: 99999, sessionStart: ts(3000) });
  const snap = await a.scanActivity();
  assert.equal(snap.count, 1);
  assert.equal(snap.activityState, "thinking");
});

test("sticky binding — a second scanActivity does not re-resolve", async (t) => {
  const home = await makeHome(t);
  const now = Date.now();
  const ts = (msAgo) => new Date(now - msAgo).toISOString();
  const dir = await writeSession(home, "stick", {
    lockPid: 7777,
    workspace: { cwd: "C:\\Users\\test\\proj", userNamed: false, createdAt: ts(3000) },
    events: [{ type: "user.message", data: {}, id: "e1", timestamp: ts(2000) }],
  });
  const a = makeAdapter({ home, parentPid: 7777, sessionStart: ts(3000) });
  await a.scanActivity();
  // Remove the lock — sticky binding should keep working.
  await fsp.unlink(path.join(dir, "inuse.7777.lock"));
  // Append another event.
  await fsp.appendFile(
    path.join(dir, "events.jsonl"),
    JSON.stringify({ type: "tool.execution_start", data: {}, id: "e2", timestamp: ts(1000) }) + "\n",
  );
  const snap = await a.scanActivity();
  assert.equal(snap.count, 2);
});

test("discoverName returns null when user_named is false", async (t) => {
  const home = await makeHome(t);
  await writeSession(home, "auto", {
    lockPid: 1111,
    workspace: { cwd: "C:\\Users\\test\\proj", name: "Auto Title", userNamed: false, createdAt: "2026-05-07T15:00:00.000Z" },
  });
  const a = makeAdapter({ home, parentPid: 1111 });
  assert.equal(await a.discoverName(), null);
});

test("discoverName returns the workspace name when user_named is true", async (t) => {
  const home = await makeHome(t);
  await writeSession(home, "named", {
    lockPid: 2222,
    workspace: { cwd: "C:\\Users\\test\\proj", name: "My Renamed Session", userNamed: true, createdAt: "2026-05-07T15:00:00.000Z" },
  });
  const a = makeAdapter({ home, parentPid: 2222 });
  assert.equal(await a.discoverName(), "My Renamed Session");
});

test("discoverName returns undefined when session dir is not yet bound", async (t) => {
  const home = await makeHome(t);
  const a = makeAdapter({ home, parentPid: 99999 });
  assert.equal(await a.discoverName(), undefined);
});

test("scanActivity is no-op when events.jsonl has no new bytes", async (t) => {
  const home = await makeHome(t);
  const now = Date.now();
  const ts = (msAgo) => new Date(now - msAgo).toISOString();
  await writeSession(home, "noop", {
    lockPid: 3333,
    workspace: { cwd: "C:\\Users\\test\\proj", userNamed: false, createdAt: ts(3000) },
    events: [{ type: "user.message", data: {}, id: "e1", timestamp: ts(2000) }],
  });
  const a = makeAdapter({ home, parentPid: 3333, sessionStart: ts(3000) });
  const s1 = await a.scanActivity();
  const s2 = await a.scanActivity();
  assert.equal(s1.count, 1);
  assert.equal(s2.count, 1);
  assert.equal(s2.lastAt, s1.lastAt);
});
