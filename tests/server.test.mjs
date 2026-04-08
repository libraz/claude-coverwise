/**
 * End-to-end smoke tests for the claude-coverwise MCP server.
 *
 * Spawns mcp/server.mjs as a subprocess and drives it with the official
 * MCP SDK client over stdio, exactly as Claude Code would. Validates that
 * every tool advertised in tools/list works on a small happy-path input.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'mcp', 'server.mjs');

/** Spawn the MCP server and return a connected SDK Client. */
async function startClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });
  const client = new Client(
    { name: 'claude-coverwise-tests', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

/** Parse the first text content block of a tool result as JSON. */
function parseResult(result) {
  expect(result.content).toBeDefined();
  expect(result.content.length).toBeGreaterThan(0);
  const block = result.content[0];
  expect(block.type).toBe('text');
  return JSON.parse(block.text);
}

describe('claude-coverwise MCP server', () => {
  let client;
  let transport;

  beforeAll(async () => {
    ({ client, transport } = await startClient());
  });

  afterAll(async () => {
    await transport?.close();
  });

  it('lists exactly the four expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['analyze_coverage', 'estimate_model', 'extend_tests', 'generate']);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('estimate_model returns parameter statistics without running generation', async () => {
    const result = await client.callTool({
      name: 'estimate_model',
      arguments: {
        parameters: [
          { name: 'os', values: ['win', 'mac', 'linux'] },
          { name: 'browser', values: ['chrome', 'firefox', 'safari'] },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const stats = parseResult(result);
    expect(stats.parameterCount).toBe(2);
    expect(stats.totalValues).toBe(6);
    expect(stats.totalTuples).toBe(9);
    expect(stats.estimatedTests).toBeGreaterThan(0);
  });

  it('generate produces a covering array with full pairwise coverage', async () => {
    const result = await client.callTool({
      name: 'generate',
      arguments: {
        parameters: [
          { name: 'os', values: ['win', 'mac', 'linux'] },
          { name: 'browser', values: ['chrome', 'firefox', 'safari'] },
        ],
        seed: 42,
      },
    });
    expect(result.isError).toBeFalsy();
    const out = parseResult(result);
    expect(out.coverage).toBe(1);
    expect(out.uncovered).toEqual([]);
    expect(out.tests.length).toBeGreaterThanOrEqual(9);
    for (const tc of out.tests) {
      expect(['win', 'mac', 'linux']).toContain(tc.os);
      expect(['chrome', 'firefox', 'safari']).toContain(tc.browser);
    }
  });

  it('generate honours constraints', async () => {
    const result = await client.callTool({
      name: 'generate',
      arguments: {
        parameters: [
          { name: 'os', values: ['win', 'mac'] },
          { name: 'browser', values: ['chrome', 'safari'] },
        ],
        constraints: ['IF os = win THEN browser != safari'],
        seed: 1,
      },
    });
    const out = parseResult(result);
    expect(out.coverage).toBe(1);
    for (const tc of out.tests) {
      expect(tc.os === 'win' && tc.browser === 'safari').toBe(false);
    }
  });

  it('analyze_coverage reports a gap in an incomplete suite', async () => {
    const result = await client.callTool({
      name: 'analyze_coverage',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        tests: [
          { a: '1', b: 'x' },
          { a: '2', b: 'y' },
        ],
      },
    });
    const report = parseResult(result);
    expect(report.totalTuples).toBe(4);
    expect(report.coveredTuples).toBe(2);
    expect(report.uncovered).toHaveLength(2);
    expect(report.coverageRatio).toBeCloseTo(0.5, 5);
  });

  it('analyze_coverage with constraints removes impossible tuples from the universe', async () => {
    const result = await client.callTool({
      name: 'analyze_coverage',
      arguments: {
        parameters: [
          { name: 'locale', values: ['en', 'ja', 'ar'] },
          { name: 'dir', values: ['ltr', 'rtl'] },
        ],
        tests: [
          { locale: 'en', dir: 'ltr' },
          { locale: 'ar', dir: 'rtl' },
        ],
        constraints: ['IF locale = ar THEN dir = rtl', 'IF locale IN {en, ja} THEN dir = ltr'],
      },
    });
    const report = parseResult(result);
    // Without constraints: 6 tuples. With constraints: 6 - 3 impossible = 3.
    expect(report.totalTuples).toBe(3);
    expect(report.coveredTuples).toBe(2);
    // The single uncovered tuple must be locale=ja × dir=ltr (the only valid one not exercised).
    expect(report.uncovered).toHaveLength(1);
    const u = report.uncovered[0];
    expect(u.tuple).toEqual(expect.arrayContaining(['locale=ja', 'dir=ltr']));
    // No constraint-impossible tuple should appear in uncovered.
    for (const entry of report.uncovered) {
      const flat = entry.tuple.join(',');
      expect(flat).not.toMatch(/locale=en.*dir=rtl|dir=rtl.*locale=en/);
      expect(flat).not.toMatch(/locale=ja.*dir=rtl|dir=rtl.*locale=ja/);
      expect(flat).not.toMatch(/locale=ar.*dir=ltr|dir=ltr.*locale=ar/);
    }
  });

  it('extend_tests preserves existing tests and reaches full coverage', async () => {
    const existing = [
      { a: '1', b: 'x' },
      { a: '2', b: 'y' },
    ];
    const result = await client.callTool({
      name: 'extend_tests',
      arguments: {
        existing,
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        seed: 7,
      },
    });
    const out = parseResult(result);
    expect(out.coverage).toBe(1);
    expect(out.tests.length).toBeGreaterThanOrEqual(existing.length);
    // Every existing test must still be present somewhere in the result.
    for (const e of existing) {
      const found = out.tests.some((t) => t.a === e.a && t.b === e.b);
      expect(found).toBe(true);
    }
  });

  it('surfaces warnings from the underlying engine', async () => {
    // A syntactically malformed constraint is treated as a warning, not a hard
    // error, by coverwise. The MCP server should faithfully forward the
    // warnings array so callers can see what went wrong.
    const result = await client.callTool({
      name: 'generate',
      arguments: {
        parameters: [{ name: 'a', values: ['1'] }],
        constraints: ['NOT A VALID CONSTRAINT @@@'],
      },
    });
    const out = parseResult(result);
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});

describe('install-deps hook script', () => {
  it('exits successfully with no environment variables set (no-op path)', async () => {
    const hookPath = resolve(here, '..', 'scripts', 'install-deps.mjs');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookPath], {
        env: {}, // strip CLAUDE_PLUGIN_ROOT — should exit cleanly
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('exit', (c) => resolve(c));
      child.on('error', reject);
    });
    expect(code).toBe(0);
  });
});
