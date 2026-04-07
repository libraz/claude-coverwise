#!/usr/bin/env node
/**
 * SessionStart hook: ensure the MCP server's runtime dependencies are
 * installed into ${CLAUDE_PLUGIN_DATA}, which survives plugin updates
 * (unlike ${CLAUDE_PLUGIN_ROOT}, which is a cache and gets overwritten).
 *
 * Strategy:
 *   1. If ${CLAUDE_PLUGIN_ROOT}/node_modules exists (local dev clone), do nothing.
 *   2. Otherwise, install into ${CLAUDE_PLUGIN_DATA}/node_modules using npm
 *      (npm ships with Node; yarn may not be available on the user's machine).
 *   3. Idempotent: skip if the dependency lock already matches.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PLUGIN_ROOT;
const data = process.env.CLAUDE_PLUGIN_DATA;

if (!root) {
  // Not running under Claude Code — nothing to do.
  process.exit(0);
}

// Local dev checkout: deps are already installed next to package.json.
if (existsSync(join(root, 'node_modules', '@libraz', 'coverwise'))) {
  process.exit(0);
}

if (!data) {
  process.stderr.write(
    '[claude-coverwise] CLAUDE_PLUGIN_DATA not set; cannot install runtime deps.\n',
  );
  process.exit(0);
}

const pkgSrc = join(root, 'package.json');
const pkgDst = join(data, 'package.json');
const marker = join(data, '.installed-version');

const pkgJson = JSON.parse(readFileSync(pkgSrc, 'utf8'));
const currentVersion = pkgJson.version ?? '0.0.0';
const installed = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;

if (installed === currentVersion && existsSync(join(data, 'node_modules', '@libraz', 'coverwise'))) {
  process.exit(0);
}

mkdirSync(data, { recursive: true });

// Write a minimal package.json containing only runtime deps (no devDeps, no scripts).
const runtimePkg = {
  name: pkgJson.name,
  version: pkgJson.version,
  private: true,
  type: 'module',
  dependencies: pkgJson.dependencies ?? {},
};
writeFileSync(pkgDst, `${JSON.stringify(runtimePkg, null, 2)}\n`);

process.stderr.write('[claude-coverwise] installing runtime dependencies...\n');
try {
  execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
    cwd: data,
    stdio: 'inherit',
  });
  writeFileSync(marker, currentVersion);
  process.stderr.write('[claude-coverwise] dependencies installed.\n');
} catch (err) {
  process.stderr.write(`[claude-coverwise] install failed: ${err?.message ?? err}\n`);
  process.exit(0); // Do not block the session on install failure.
}
