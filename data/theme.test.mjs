// Tests for the dashboard theme module. Run with:
//   node --test data/theme.test.mjs
// No external framework — uses Node's built-in `node:test`.
//
// Two concerns covered:
//  1. The pure JS in theme.mjs (algorithm correctness).
//  2. The inline copy of that algorithm embedded in data/sessions.html
//     stays in sync with the module — Chromium blocks ES module imports
//     from file:// origins where the dashboard runs, so the HTML keeps a
//     duplicate; this guard test fails if the duplicate drifts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getInitialChoice,
  nextThemeChoice,
  persistChoice,
  THEME_ORDER,
  THEME_GLYPH,
  THEME_LABEL,
} from "./theme.mjs";

const STORAGE_KEY = "sessions-dashboard-theme";
const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "sessions.html");

const makeGetter = (value) => (key) => (key === STORAGE_KEY ? value : null);

test("getInitialChoice returns 'current' when nothing is stored", () => {
  assert.equal(getInitialChoice(makeGetter(null)), "current");
});

test("getInitialChoice returns the stored value when it is 'current'", () => {
  assert.equal(getInitialChoice(makeGetter("current")), "current");
});

test("getInitialChoice returns the stored value when it is 'dark'", () => {
  assert.equal(getInitialChoice(makeGetter("dark")), "dark");
});

test("getInitialChoice returns the stored value when it is 'light'", () => {
  assert.equal(getInitialChoice(makeGetter("light")), "light");
});

test("getInitialChoice falls back to 'current' for an unknown stored value", () => {
  assert.equal(getInitialChoice(makeGetter("auto")), "current");
  assert.equal(getInitialChoice(makeGetter("")), "current");
  assert.equal(getInitialChoice(makeGetter("DARK")), "current");
});

test("getInitialChoice returns 'current' when the getter throws (private mode)", () => {
  const throwingGetter = () => {
    throw new Error("storage disabled");
  };
  assert.equal(getInitialChoice(throwingGetter), "current");
});

test("getInitialChoice tolerates undefined getter argument", () => {
  assert.equal(getInitialChoice(undefined), "current");
});

test("nextThemeChoice cycles current -> dark", () => {
  assert.equal(nextThemeChoice("current"), "dark");
});

test("nextThemeChoice cycles dark -> light", () => {
  assert.equal(nextThemeChoice("dark"), "light");
});

test("nextThemeChoice cycles light -> current", () => {
  assert.equal(nextThemeChoice("light"), "current");
});

test("nextThemeChoice on unknown input never returns the unknown input", () => {
  const out = nextThemeChoice("garbage");
  assert.ok(THEME_ORDER.includes(out), "must land on a known mode");
  assert.notEqual(out, "garbage");
});

test("persistChoice writes the choice under the canonical key", () => {
  let captured = null;
  persistChoice("dark", (key, value) => {
    captured = [key, value];
  });
  assert.deepEqual(captured, [STORAGE_KEY, "dark"]);
});

test("persistChoice swallows setter errors silently", () => {
  const throwingSetter = () => {
    throw new Error("quota exceeded");
  };
  assert.doesNotThrow(() => persistChoice("light", throwingSetter));
});

test("persistChoice tolerates undefined setter", () => {
  assert.doesNotThrow(() => persistChoice("dark", undefined));
});

test("THEME_ORDER is the canonical cycle", () => {
  assert.deepEqual(THEME_ORDER, ["current", "dark", "light"]);
});

test("THEME_GLYPH covers every entry in THEME_ORDER", () => {
  for (const t of THEME_ORDER) {
    assert.equal(typeof THEME_GLYPH[t], "string");
    assert.ok(THEME_GLYPH[t].length > 0, `glyph for ${t} must be non-empty`);
  }
});

test("THEME_LABEL covers every entry in THEME_ORDER", () => {
  for (const t of THEME_ORDER) {
    assert.equal(typeof THEME_LABEL[t], "string");
    assert.ok(THEME_LABEL[t].length > 0, `label for ${t} must be non-empty`);
  }
});

// Drift guard: the HTML embeds an inline copy of this module's order/
// glyph/label tables and the storage key. The dashboard runs over file://
// where Chromium blocks ES module imports, so the HTML can't pull from
// theme.mjs at runtime. These assertions fail loudly if the inline copy
// in sessions.html disagrees with the module — catching the case where
// someone edits one but forgets the other.
test("sessions.html inlines THEME_ORDER matching the module", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  const m = html.match(/const ORDER = \[([^\]]+)\];/);
  assert.ok(m, "sessions.html must declare `const ORDER = [...]`");
  const inlineOrder = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  assert.deepEqual(
    inlineOrder,
    THEME_ORDER,
    "inline ORDER in sessions.html must match THEME_ORDER",
  );
});

test("sessions.html inlines THEME_GLYPH matching the module", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  for (const key of THEME_ORDER) {
    const fragment = `${key}: "${THEME_GLYPH[key]}"`;
    assert.ok(
      html.includes(fragment),
      `sessions.html must contain glyph fragment: ${fragment}`,
    );
  }
});

test("sessions.html inlines THEME_LABEL matching the module", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  for (const key of THEME_ORDER) {
    const fragment = `${key}: "${THEME_LABEL[key]}"`;
    assert.ok(
      html.includes(fragment),
      `sessions.html must contain label fragment: ${fragment}`,
    );
  }
});

test("sessions.html inlines the canonical localStorage key", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  assert.ok(
    html.includes(`"${STORAGE_KEY}"`),
    `sessions.html must reference localStorage key "${STORAGE_KEY}"`,
  );
});

test("sessions.html bootstrap script runs before <style> (FOUC prevention)", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  const bootstrapIdx = html.indexOf('localStorage.getItem("sessions-dashboard-theme")');
  // The first `<style>` substring appears inside the bootstrap comment, so
  // anchor on the actual tag with surrounding newline/whitespace context.
  const styleTagIdx = html.search(/<\/script>\s*<style>/);
  assert.ok(bootstrapIdx > 0, "bootstrap script must exist");
  assert.ok(styleTagIdx > 0, "<style> tag must follow bootstrap script");
  assert.ok(
    bootstrapIdx < styleTagIdx,
    "theme bootstrap must appear before <style> to avoid flash-of-unstyled-content",
  );
});
