// Structural / CSS / copy assertions for data/sessions.html — pinned to
// the design-review fixes #1, #2, #3+#4, #5, #6, #9. Same pattern as
// data/theme.test.mjs: scan the HTML source string, regex out the rule
// or fragment we care about, fail loudly when intent drifts.
//
// Run with:
//   node --test data/sessions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "sessions.html");
const HTML = readFileSync(HTML_PATH, "utf8");

// Pull the body of a single CSS rule for a given selector. Tolerant of
// extra whitespace inside the selector (no nested braces — fine for our
// flat stylesheet, would need a real parser for @media etc.).
function cssRuleBody(html, selector) {
  const esc = selector
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const re = new RegExp(esc + "\\s*\\{([^}]*)\\}", "m");
  const m = html.match(re);
  return m ? m[1] : null;
}

test("#1 .theme-toggle uses position: absolute (anchored to the header, scrolls with the page)", () => {
  // The team explicitly chose NOT to float the toggle as the page scrolls
  // — keeping it anchored to the header is intentional dashboard chrome
  // behavior. This test pins that decision so a well-meaning future edit
  // doesn't silently switch it back to fixed.
  const body = cssRuleBody(HTML, ".theme-toggle");
  assert.ok(body, ".theme-toggle CSS rule must exist");
  assert.match(
    body,
    /position:\s*absolute/,
    ".theme-toggle must declare position: absolute (not fixed) so it scrolls away with the header",
  );
});

test("#2 header reserves right padding so the toggle can't overlap the title", () => {
  const body = cssRuleBody(HTML, "header");
  assert.ok(body, "header CSS rule must exist");
  // Accept either an explicit padding-right or a 4-value padding shorthand
  // whose right slot reserves the space.
  const explicit = body.match(/padding-right:\s*([\d.]+)rem/);
  if (explicit) {
    assert.ok(
      parseFloat(explicit[1]) >= 3.5,
      `header padding-right must be ≥ 3.5rem to clear the theme toggle (got ${explicit[1]}rem)`,
    );
    return;
  }
  const four = body.match(/padding:\s*([\d.]+)rem\s+([\d.]+)rem\s+([\d.]+)rem\s+([\d.]+)rem/);
  if (four) {
    assert.ok(
      parseFloat(four[2]) >= 3.5,
      `header 4-value padding must reserve ≥ 3.5rem on the right (got ${four[2]}rem)`,
    );
    return;
  }
  assert.fail(
    "header must reserve ≥ 3.5rem of right padding (padding-right or 4-value shorthand) so the theme toggle does not crash into the title",
  );
});

test("#3+#4 .session .status is capped and clips overflow so it can't crowd the body", () => {
  const body = cssRuleBody(HTML, ".session .status");
  assert.ok(body, ".session .status CSS rule must exist");
  assert.match(
    body,
    /max-width:/,
    ".session .status must declare max-width — without it a long tool name (e.g. 'running sessions-dashboard·eval_js..') eats the locator's horizontal space",
  );
  assert.match(
    body,
    /overflow:\s*hidden/,
    ".session .status must hide overflow so the inner label can ellipsize within the cap",
  );
});

test("#4 .session .status .label ellipsizes inside the capped pill", () => {
  const body = cssRuleBody(HTML, ".session .status .label");
  assert.ok(
    body,
    ".session .status .label CSS rule must exist — the inner span carries the truncatable tool-name text",
  );
  assert.match(body, /text-overflow:\s*ellipsis/, ".label must use text-overflow: ellipsis");
  assert.match(body, /overflow:\s*hidden/, ".label must hide overflow so ellipsis can apply");
});

test("#4 buildStatusPill assigns the inner text span the .label class so the CSS lands", () => {
  // Source-level guard: if someone refactors the JS without updating the
  // class, the CSS rule above silently stops applying. Catch it here.
  assert.match(
    HTML,
    /txt\.className\s*=\s*["']label["']/,
    'buildStatusPill must set txt.className = "label" so .session .status .label rules apply',
  );
});

test("#5 empty-state copy is host-neutral, not Claude-only", () => {
  // Original wording singled out Claude Code despite the dashboard handling
  // Codex and Gemini sessions just as well.
  assert.ok(
    !HTML.includes("No Claude Code sessions connected"),
    'empty-state heading must not say "No Claude Code sessions connected" — Codex/Gemini sessions land here too',
  );
  // Positive framing — mention of agentic / CLI sessions in the heading or body.
  assert.match(
    HTML,
    /No (agentic|active|connected|CLI)[^"<]*sessions/i,
    "empty-state heading must use host-neutral wording (e.g. 'No agentic CLI sessions connected')",
  );
  // The "Launch claude from any project" hint also has to lose its Claude-only framing.
  assert.ok(
    !/Launch <code>claude<\/code> from any project/.test(HTML),
    "empty-state body must not hard-code 'Launch claude from any project' — mention codex / gemini too",
  );
});

test("#6 .group-drop.empty is visually compact (low padding, smaller font) so empty groups don't dominate", () => {
  const body = cssRuleBody(HTML, ".group-drop.empty");
  assert.ok(body, ".group-drop.empty CSS rule must exist");
  const pad = body.match(/padding:\s*([\d.]+)rem/);
  assert.ok(pad, ".group-drop.empty must declare padding");
  assert.ok(
    parseFloat(pad[1]) <= 0.5,
    `.group-drop.empty padding must be ≤ 0.5rem so empty placeholders don't compete with real cards (got ${pad[1]}rem)`,
  );
  assert.match(
    body,
    /font-size:\s*\.?\d/,
    ".group-drop.empty must declare a smaller font-size for the placeholder hint",
  );
});

test("#9 footer no longer carries the long drag-and-drop tutorial sentence", () => {
  // Permanent footer chrome shouldn't be onboarding text. The same string
  // is allowed elsewhere (it migrates to a help-button title attribute).
  const footer = HTML.match(/<footer[^>]*>([\s\S]*?)<\/footer>/);
  assert.ok(footer, "<footer> tag must exist");
  assert.ok(
    !footer[1].includes("Drag session cards between groups to organize them"),
    "<footer> must not include the long drag-and-drop tutorial — move it to a help affordance with a title attribute",
  );
});

test("#9 the dropped help text is preserved on a help affordance (title or aria-label)", () => {
  // Don't just delete the info — re-expose it via a `?` button so first-time
  // users can still discover it.
  assert.match(
    HTML,
    /(title|aria-label)="[^"]*[Dd]rag session cards[^"]*"/,
    "the migrated help text must live on a button's title/aria-label so it stays discoverable",
  );
});
