// Host-adapter interface. Each supported CLI (Claude Code, Gemini CLI, ...)
// ships a subclass that knows how to locate the session's transcript and
// translate it into an ActivitySnapshot. The proxy (index.mjs) is otherwise
// host-agnostic.

export const HOST = Object.freeze({
  CLAUDE: "claude",
  GEMINI: "gemini",
  CODEX: "codex",
  UNKNOWN: "unknown",
});

/**
 * @typedef {Object} ActivitySnapshot
 * @property {number} count                running tool-call total
 * @property {number|null} lastAt          ms epoch of most recent tool call
 * @property {"running"|"thinking"|"idle"|null} activityState
 * @property {string|null} toolName        tool name when state === "running"
 * @property {number|null} stateChangedAt  ms epoch of the event that set state
 */

export class HostAdapter {
  /** @type {string} */ name = HOST.UNKNOWN;
  /** @type {string} */ displayName = "Unknown";

  /**
   * @param {{ cwd: string, sessionStart: string, pid: number }} ctx
   *   cwd           absolute path of the CLI's working directory
   *   sessionStart  ISO timestamp when our proxy started
   *   pid           our proxy's pid (CC process id)
   */
  constructor({ cwd, sessionStart, pid }) {
    this.cwd = cwd;
    this.sessionStart = sessionStart;
    this.pid = pid;
  }

  /**
   * Produce an ActivitySnapshot or null.
   * Adapters should return null on first-time failure (nothing to report yet)
   * and the last-known snapshot on transient failure after at least one
   * successful scan (so we don't lose a 5s tick's worth of counter bumps).
   * @returns {Promise<ActivitySnapshot|null>}
   */
  async scanActivity() { return null; }

  /**
   * Tri-state return so watchers can distinguish:
   *   - string:     found a rename — adopt this name
   *   - null:       read succeeded AND no rename present — clear any stale name
   *   - undefined:  I/O error OR transcript not yet available — leave state alone
   *                 so a transient hiccup doesn't flicker-clear a valid name
   * Adapters that don't support in-transcript rename return null permanently.
   * @returns {Promise<string|null|undefined>}
   */
  async discoverName() { return null; }
}
