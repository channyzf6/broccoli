// Lightweight contract test for lib/focus.mjs. The macOS-specific
// branches require darwin to exercise; here we only verify the
// platform-gate early return shape, which all platforms hit when
// not on darwin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { focusSession } from "./focus.mjs";

test("non-darwin: returns kind:'unsupported' with pid", async () => {
  if (process.platform === "darwin") return; // skip on the actual platform
  const r = await focusSession({ pid: 12345 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
  assert.equal(r.pid, 12345);
  assert.match(r.error, /macOS/);
});

test("non-darwin: missing pid still returns kind:'unsupported'", async () => {
  if (process.platform === "darwin") return;
  const r = await focusSession(null);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "unsupported");
  assert.equal(r.pid, null);
});
