// Theme module for the sessions dashboard. Pure JS, no DOM dependency.
// data/sessions.html embeds an inline copy of this algorithm (Chromium
// blocks ES module imports from file:// origins where the dashboard runs),
// and `data/theme.test.mjs` enforces that the inline copy stays in sync
// with these exports.

const STORAGE_KEY = "sessions-dashboard-theme";

export const THEME_ORDER = ["current", "dark", "light"];

export const THEME_GLYPH = {
  current: "◐",
  dark: "☾",
  light: "☀",
};

export const THEME_LABEL = {
  current: "Current",
  dark: "Dark",
  light: "Light",
};

export function getInitialChoice(getItem) {
  let stored = null;
  try {
    if (typeof getItem === "function") stored = getItem(STORAGE_KEY);
  } catch (_) {
    stored = null;
  }
  return THEME_ORDER.includes(stored) ? stored : "current";
}

export function nextThemeChoice(current) {
  const i = THEME_ORDER.indexOf(current);
  if (i === -1) return "dark";
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}

export function persistChoice(choice, setItem) {
  try {
    if (typeof setItem === "function") setItem(STORAGE_KEY, choice);
  } catch (_) {
    /* storage disabled / quota — silently ignore */
  }
}
