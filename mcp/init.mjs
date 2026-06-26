/**
 * Install helper for the coverwise MCP server.
 *
 * Writes (or removes) an `mcpServers.coverwise` entry into the config files of
 * common MCP clients so the server can be used outside the Claude Code plugin
 * mechanism — e.g. with Codex CLI, Cursor, Cline, or a project-scoped
 * `.mcp.json`. Inside Claude Code the plugin marketplace is still the
 * recommended path; this helper exists for everything else.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

/** Package specifier written into generated config snippets. */
const PACKAGE_SPEC = 'github:libraz/claude-coverwise';

/** Server key used under `mcpServers` / `[mcp_servers.*]`. */
const SERVER_NAME = 'coverwise';

/** The MCP entry shared by Claude Code and Codex CLI. coverwise needs no env. */
const buildEntry = () => ({
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
});

/**
 * Merge a `coverwise` MCP entry into a Claude Code JSON config, preserving every
 * other key. Creates the file (and parent dirs) when missing.
 *
 * @param {string} path Absolute path to the JSON config file.
 * @returns {Promise<void>}
 */
export const writeClaudeConfig = async (path) => {
  let data = {};
  if (existsSync(path)) {
    const raw = await readFile(path, 'utf8');
    if (raw.trim().length > 0) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          `Failed to parse existing JSON at ${path}. Fix or move it before re-running init.`,
        );
      }
    }
  }
  data.mcpServers = data.mcpServers ?? {};
  data.mcpServers[SERVER_NAME] = buildEntry();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
};

/**
 * Remove the `[mcp_servers.coverwise]` block from a TOML document. Stops
 * skipping at the next `[section]` header; lines after the block are kept as-is.
 *
 * @param {string} content Raw TOML document.
 * @returns {string} The document without the coverwise block.
 */
const stripCodexSection = (content) => {
  const lines = content.split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === `[mcp_servers.${SERVER_NAME}]`) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSection = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

/**
 * Append or replace the `[mcp_servers.coverwise]` block in a Codex CLI TOML
 * config. Other sections are kept verbatim.
 *
 * @param {string} path Absolute path to the TOML config file.
 * @returns {Promise<void>}
 */
export const writeCodexConfig = async (path) => {
  let existing = '';
  if (existsSync(path)) {
    existing = await readFile(path, 'utf8');
  }
  const stripped = stripCodexSection(existing).replace(/\n*$/, '');
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '';
  const entry = buildEntry();
  const args = entry.args.map((a) => `"${a}"`).join(', ');
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${entry.command}"`,
    `args = [${args}]`,
  ].join('\n');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${prefix}${block}\n`);
};

/**
 * Render a filesystem path with `~` substituted for the user's home directory.
 * Display-only; the actual writes always use the absolute path.
 *
 * @param {string} path Absolute path.
 * @returns {string} Path with the home directory collapsed to `~`.
 */
export const displayPath = (path) => {
  const home = homedir();
  if (path === home) {
    return '~';
  }
  if (path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }
  return path;
};

/**
 * One-word status describing what `init` will do to a config file.
 *
 * @param {string} path Absolute path to the config file.
 * @returns {Promise<string>} `(new)`, `(replace coverwise)`, or `(merge)`.
 */
export const previewWriteImpact = async (path) => {
  if (!existsSync(path)) {
    return '(new)';
  }
  const raw = await readFile(path, 'utf8').catch(() => '');
  if (raw.trim().length === 0) {
    return '(new)';
  }
  try {
    const data = JSON.parse(raw);
    return data.mcpServers && SERVER_NAME in data.mcpServers ? '(replace coverwise)' : '(merge)';
  } catch {
    /* fall through to TOML heuristic */
  }
  return new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]\\s*$`, 'm').test(raw)
    ? '(replace coverwise)'
    : '(merge)';
};

/**
 * One-word status describing what `uninstall` will do to a config file.
 *
 * @param {string} path Absolute path to the config file.
 * @returns {Promise<string>} `(no file; skip)`, `(no coverwise; skip)`, or `(remove coverwise)`.
 */
export const previewRemoveImpact = async (path) => {
  if (!existsSync(path)) {
    return '(no file; skip)';
  }
  const raw = await readFile(path, 'utf8').catch(() => '');
  if (raw.trim().length === 0) {
    return '(no coverwise; skip)';
  }
  try {
    const data = JSON.parse(raw);
    return data.mcpServers && SERVER_NAME in data.mcpServers
      ? '(remove coverwise)'
      : '(no coverwise; skip)';
  } catch {
    /* fall through to TOML heuristic */
  }
  return new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]\\s*$`, 'm').test(raw)
    ? '(remove coverwise)'
    : '(no coverwise; skip)';
};

/** @typedef {'removed' | 'absent' | 'no-file'} RemoveOutcome */

/**
 * Remove the `coverwise` MCP entry from a Claude Code JSON config. Preserves
 * every other top-level key and every other server entry.
 *
 * @param {string} path Absolute path to the JSON config file.
 * @returns {Promise<RemoveOutcome>} Whether anything was actually changed.
 */
export const removeFromClaudeConfig = async (path) => {
  if (!existsSync(path)) {
    return 'no-file';
  }
  const raw = await readFile(path, 'utf8');
  if (raw.trim().length === 0) {
    return 'absent';
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Failed to parse existing JSON at ${path}. Fix or move it before re-running uninstall.`,
    );
  }
  if (!data.mcpServers?.[SERVER_NAME]) {
    return 'absent';
  }
  delete data.mcpServers[SERVER_NAME];
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return 'removed';
};

/**
 * Remove the `[mcp_servers.coverwise]` block from a Codex CLI TOML config.
 *
 * @param {string} path Absolute path to the TOML config file.
 * @returns {Promise<RemoveOutcome>} Whether anything was actually changed.
 */
export const removeFromCodexConfig = async (path) => {
  if (!existsSync(path)) {
    return 'no-file';
  }
  const existing = await readFile(path, 'utf8');
  if (!new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]\\s*$`, 'm').test(existing)) {
    return 'absent';
  }
  const stripped = stripCodexSection(existing).replace(/\n*$/, '');
  await writeFile(path, stripped.length > 0 ? `${stripped}\n` : '');
  return 'removed';
};

/**
 * Where to install / uninstall the coverwise MCP entry.
 *
 * @typedef {'claude-user' | 'claude-project' | 'codex'} TargetKind
 */

const TARGET_OPTIONS = [
  {
    key: '1',
    kind: 'claude-user',
    label: 'Claude Code — user',
    resolvePath: () => join(homedir(), '.claude.json'),
  },
  {
    key: '2',
    kind: 'claude-project',
    label: 'Claude Code — project',
    resolvePath: () => join(process.cwd(), '.mcp.json'),
  },
  {
    key: '3',
    kind: 'codex',
    label: 'Codex CLI',
    resolvePath: () => join(homedir(), '.codex', 'config.toml'),
  },
];

/**
 * Parse a comma-separated target selector like `"1,3"` into a deduplicated list
 * of target kinds. Falls back to `defaultRaw` when the input is blank.
 *
 * @param {string} raw User input.
 * @param {string} defaultRaw Fallback selector when input is blank.
 * @returns {TargetKind[]} Deduplicated, ordered target kinds.
 */
export const parseTargetChoice = (raw, defaultRaw) => {
  const input = raw.trim() === '' ? defaultRaw : raw;
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error('No targets selected.');
  }
  const selected = new Set();
  for (const p of parts) {
    const opt = TARGET_OPTIONS.find((o) => o.key === p);
    if (!opt) {
      throw new Error(`Invalid choice: ${p}`);
    }
    selected.add(opt.kind);
  }
  return [...selected];
};

const writeForKind = (kind, path) =>
  kind === 'codex' ? () => writeCodexConfig(path) : () => writeClaudeConfig(path);

const removeForKind = (kind, path) =>
  kind === 'codex' ? () => removeFromCodexConfig(path) : () => removeFromClaudeConfig(path);

const pickTargets = (kinds) =>
  TARGET_OPTIONS.filter((opt) => kinds.includes(opt.kind)).map((opt) => {
    const path = opt.resolvePath();
    return { label: opt.label, path, run: writeForKind(opt.kind, path) };
  });

const pickRemoveTargets = (kinds) =>
  TARGET_OPTIONS.filter((opt) => kinds.includes(opt.kind)).map((opt) => {
    const path = opt.resolvePath();
    return { label: opt.label, path, run: removeForKind(opt.kind, path) };
  });

const renderTargetMenu = () =>
  [
    `  1) Claude Code              ${displayPath(join(homedir(), '.claude.json'))}`,
    `  2) Claude Code (project)    ${displayPath(join(process.cwd(), '.mcp.json'))}`,
    `  3) Codex CLI                ${displayPath(join(homedir(), '.codex', 'config.toml'))}`,
  ].join('\n');

const promptYesNo = async (rl, question, defaultYes) => {
  const def = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await rl.question(`${question} [${def}] `)).trim().toLowerCase();
  if (ans === '') {
    return defaultYes;
  }
  return ans === 'y' || ans === 'yes';
};

/**
 * Run the interactive setup: pick which MCP client config files to update, then
 * write the `coverwise` entry into each.
 *
 * @returns {Promise<void>}
 */
export const runInit = async () => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('claude-coverwise setup\n\n');
    stdout.write('Where to install? (pick one or more, comma-separated)\n');
    stdout.write(`${renderTargetMenu()}\n`);
    const choice = (await rl.question('Choice [1,3]: ')).trim();
    const kinds = parseTargetChoice(choice, '1,3');
    const targets = pickTargets(kinds);

    stdout.write('\nWill update:\n');
    for (const t of targets) {
      const summary = await previewWriteImpact(t.path);
      stdout.write(`  - ${displayPath(t.path)} ${summary}\n`);
    }
    stdout.write('\n');

    const confirmed = await promptYesNo(rl, 'Proceed?', true);
    if (!confirmed) {
      stdout.write('Aborted.\n');
      return;
    }

    for (const t of targets) {
      await t.run();
      stdout.write(`Wrote ${displayPath(t.path)}\n`);
    }
    stdout.write('\nDone. Restart your MCP client to pick up the new server.\n');
  } finally {
    rl.close();
  }
};

/**
 * Interactive companion to {@link runInit}: removes the `coverwise` MCP entry
 * from the selected config files. Leaves other servers/sections alone.
 *
 * @returns {Promise<void>}
 */
export const runUninstall = async () => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('claude-coverwise uninstall\n\n');
    stdout.write('Where to remove from? (pick one or more, comma-separated)\n');
    stdout.write(`${renderTargetMenu()}\n`);
    const choice = (await rl.question('Choice [1,2,3]: ')).trim();
    const kinds = parseTargetChoice(choice, '1,2,3');
    const targets = pickRemoveTargets(kinds);

    stdout.write('\nWill update:\n');
    for (const t of targets) {
      const summary = await previewRemoveImpact(t.path);
      stdout.write(`  - ${displayPath(t.path)} ${summary}\n`);
    }
    stdout.write('\n');

    const confirmed = await promptYesNo(rl, 'Proceed?', true);
    if (!confirmed) {
      stdout.write('Aborted.\n');
      return;
    }

    for (const t of targets) {
      const outcome = await t.run();
      const p = displayPath(t.path);
      if (outcome === 'removed') {
        stdout.write(`Removed coverwise from ${p}\n`);
      } else if (outcome === 'absent') {
        stdout.write(`No coverwise in ${p}; skipped.\n`);
      } else {
        stdout.write(`${p} does not exist; skipped.\n`);
      }
    }
    stdout.write('\nDone. Restart your MCP client for the change to take effect.\n');
  } finally {
    rl.close();
  }
};
