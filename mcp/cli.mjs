#!/usr/bin/env node
/**
 * claude-coverwise CLI entry point.
 *
 * With no arguments it starts the stdio MCP server (this is what generated
 * config entries invoke via `npx -y github:libraz/claude-coverwise`). The
 * `init` / `uninstall` subcommands run the interactive install helper.
 */
import { runInit, runUninstall } from './init.mjs';

const PACKAGE_VERSION = '0.3.0';

const HELP = `claude-coverwise ${PACKAGE_VERSION}
Pairwise / t-wise combinatorial coverage MCP server.

Usage:
  claude-coverwise            Start the stdio MCP server.
  claude-coverwise init       Interactive setup: write the coverwise MCP entry
                              into Claude Code and/or Codex CLI config files.
  claude-coverwise uninstall  Interactive removal: drop the coverwise MCP entry
                              from those config files.
  claude-coverwise --help     Show this help.
  claude-coverwise --version  Show version.

Inside Claude Code, prefer the plugin marketplace:
  /plugin marketplace add libraz/claude-coverwise
  /plugin install claude-coverwise

Docs: https://github.com/libraz/claude-coverwise
`;

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (argv[0] === 'init') {
    await runInit();
    return;
  }
  if (argv[0] === 'uninstall') {
    await runUninstall();
    return;
  }

  // Default: start the MCP server. server.mjs self-connects on import.
  await import('./server.mjs');
};

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[claude-coverwise] ${message}\n`);
  process.exit(1);
});
