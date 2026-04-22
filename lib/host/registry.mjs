// Host detection + adapter selection. The proxy calls this once at startup
// to figure out which CLI spawned it (Claude Code, Gemini CLI, ...) and
// gets back a configured HostAdapter it will call for activity + name work.

import { HOST, HostAdapter } from "./base.mjs";
import { ClaudeAdapter } from "./claude.mjs";
import { GeminiAdapter } from "./gemini.mjs";

/**
 * Detect which host CLI launched us.
 *
 * Priority:
 *   1. SESSIONS_DASHBOARD_HOST env var (explicit override — always wins).
 *   2. (M3: dir-probe heuristic for Claude/Gemini transcript dirs)
 *   3. CLAUDE fallback (backward-compat for all existing installs).
 *
 * @param {{ cwd: string }} ctx
 * @returns {Promise<string>}  one of HOST.*
 */
export async function detectHost(/* { cwd } */) {
  const declared = (process.env.SESSIONS_DASHBOARD_HOST || "").toLowerCase().trim();
  if (declared === HOST.CLAUDE) return HOST.CLAUDE;
  if (declared === HOST.GEMINI) return HOST.GEMINI;
  // Unknown declaration or unset → Claude default (M3 adds probe).
  return HOST.CLAUDE;
}

/**
 * Construct a HostAdapter for the detected host.
 * @param {{ host: string, cwd: string, sessionStart: string, pid: number }} ctx
 * @returns {HostAdapter}
 */
export function makeAdapter({ host, cwd, sessionStart, pid }) {
  if (host === HOST.GEMINI) return new GeminiAdapter({ cwd, sessionStart, pid });
  // Default: Claude (also the fallback for HOST.UNKNOWN and unset).
  return new ClaudeAdapter({ cwd, sessionStart, pid });
}
