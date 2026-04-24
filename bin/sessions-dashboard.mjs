#!/usr/bin/env node
// CLI dispatcher for sessions-dashboard.
//
// This is the binary the npm `bin` field points at. It handles
// subcommands (install, uninstall, version, help) and falls through to
// running the MCP server when invoked with no subcommand — that's what
// each CLI's MCP config invokes when it spawns this server as a child
// process. The MCP server itself lives in ../index.mjs and is loaded
// via dynamic import so subcommand-only invocations don't pay the cost
// of the MCP-server module graph.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { install, uninstall } from "../lib/installer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");

const sub = process.argv[2];

switch (sub) {
  case "install": {
    const local = process.argv.includes("--local");
    await install({ local });
    break;
  }
  case "uninstall":
    await uninstall();
    break;
  case "version":
  case "--version":
  case "-v": {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    console.log(pkg.version);
    break;
  }
  case "help":
  case "--help":
  case "-h":
    printUsage();
    break;
  case undefined:
    // No subcommand — the common case: each CLI's MCP config invokes
    // this binary with no args, expecting it to speak MCP over stdio.
    // Importing index.mjs runs its top-level code, which sets up the
    // server.
    await import("../index.mjs");
    break;
  default:
    console.error(`unknown subcommand: ${sub}`);
    console.error("");
    printUsage();
    process.exit(2);
}

function printUsage() {
  console.log(`sessions-dashboard — live dashboard for your Claude Code / Gemini CLI / Codex CLI sessions.

Usage:
  sessions-dashboard                    Run the MCP server (what each CLI's MCP config invokes)
  sessions-dashboard install            Register MCP with detected CLIs (one-time setup)
  sessions-dashboard install --local    Same, but registers a 'node <local-checkout>' invocation
                                        instead of the npm-pinned form (contributor flow)
  sessions-dashboard uninstall          Remove MCP registration from detected CLIs
  sessions-dashboard version            Print version
  sessions-dashboard help               This message

One-line install (recommended for end users — no global install needed):
  npx -y sessions-dashboard install

Repository: https://github.com/channyzf6/broccoli`);
}
