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

const discreteParameters = () => [
  { name: 'a', values: ['1', '2'] },
  { name: 'b', values: ['x', 'y'] },
];

const boundaryParameters = () => [
  { name: 'qty', type: 'integer', range: [1, 100], values: [] },
  { name: 'flag', values: ['on', 'off'] },
];

const classParameters = () => [
  {
    name: 'status',
    values: [
      { value: 200, class: 'ok' },
      { value: 400, class: 'client_error' },
      { value: 500, class: 'server_error' },
    ],
  },
  { name: 'method', values: ['GET', 'POST'] },
];

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

    const generateTool = tools.find((tool) => tool.name === 'generate');
    expect(generateTool.inputSchema.properties.strength).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(generateTool.inputSchema.properties.seed).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 4294967295,
    });
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
    expect(out.uncoveredCount).toBe(0);
    expect(out.omittedUncovered).toBe(0);
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
    expect(report.uncoveredCount).toBe(2);
    expect(report.omittedUncovered).toBe(0);
    expect(report.invalidTests).toEqual([]);
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

  it('constraint solver excludes partial tuples that cannot extend to a valid complete test', async () => {
    const parameters = [
      { name: 'a', values: ['0', '1'] },
      { name: 'b', values: ['0', '1'] },
      { name: 'c', values: ['0', '1'] },
    ];
    const constraints = ['IF a = 0 THEN c = 0', 'IF b = 0 THEN c = 1'];
    const generated = await client.callTool({
      name: 'generate',
      arguments: { parameters, constraints, seed: 11 },
    });
    const suite = parseResult(generated);
    expect(suite.coverage).toBe(1);

    const analyzed = await client.callTool({
      name: 'analyze_coverage',
      arguments: { parameters, constraints, tests: suite.tests },
    });
    const report = parseResult(analyzed);
    expect(report.coverageRatio).toBe(1);
    expect(report.totalTuples).toBe(9);
    expect(report.uncoveredCount).toBe(0);
    expect(report.uncovered).toEqual([]);
  });

  it('analyze_coverage reports rows excluded from coverage accounting', async () => {
    const result = await client.callTool({
      name: 'analyze_coverage',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        tests: [{ a: '1' }],
      },
    });
    const report = parseResult(result);
    expect(report.coverageRatio).toBe(0);
    expect(report.invalidTests).toHaveLength(1);
    expect(report.invalidTests[0].testIndex).toBe(0);
    expect(report.invalidTests[0].reason).toMatch(/parameter b/i);
    expect(report.uncoveredCount).toBe(4);
  });

  it('analyze_coverage reports the full gap count when diagnostics are truncated', async () => {
    const values = Array.from({ length: 40 }, (_, index) => String(index));
    const result = await client.callTool({
      name: 'analyze_coverage',
      arguments: {
        parameters: [
          { name: 'a', values },
          { name: 'b', values },
        ],
        tests: [],
      },
    });
    const report = parseResult(result);
    expect(report.coverageRatio).toBe(0);
    expect(report.uncoveredCount).toBe(1600);
    expect(report.uncovered).toHaveLength(1000);
    expect(report.omittedUncovered).toBe(600);
  });

  it('generate expands boundary values from type + range', async () => {
    const result = await client.callTool({
      name: 'generate',
      arguments: {
        parameters: [
          { name: 'qty', type: 'integer', range: [1, 100], values: [] },
          { name: 'flag', values: ['on', 'off'] },
        ],
      },
    });
    const out = parseResult(result);
    const qtys = new Set(out.tests.map((t) => String(t.qty)));
    // integer boundary expansion of [1, 100] → 0,1,2,99,100,101
    for (const expected of ['0', '1', '2', '99', '100', '101']) {
      expect(qtys.has(expected)).toBe(true);
    }
  });

  it('generate reports class coverage when values carry equivalence classes', async () => {
    const result = await client.callTool({
      name: 'generate',
      arguments: {
        parameters: [
          {
            name: 'status',
            values: [
              { value: 400, class: 'client_error' },
              { value: 404, class: 'client_error' },
              { value: 500, class: 'server_error' },
              { value: 200, class: 'ok' },
            ],
          },
          { name: 'method', values: ['GET', 'POST'] },
        ],
      },
    });
    const out = parseResult(result);
    expect(out.classCoverage).toBeDefined();
    expect(out.classCoverage.classCoverageRatio).toBe(1);
    expect(out.classCoverage.coveredClassTuples).toBe(out.classCoverage.totalClassTuples);
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
        mode: 'strict',
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
    expect(out.tests.slice(0, existing.length)).toEqual(existing);
  });

  it('forwards the warnings array on a successful generation', async () => {
    // GenerateResult always carries a warnings array (empty on the happy path).
    // The MCP server must forward it verbatim so callers can inspect it.
    const result = await client.callTool({
      name: 'generate',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
      },
    });
    const out = parseResult(result);
    expect(Array.isArray(out.warnings)).toBe(true);
  });

  it('surfaces a structured CONSTRAINT_ERROR for malformed constraint syntax', async () => {
    // A syntactically malformed constraint is a hard error in coverwise. The
    // MCP server should faithfully forward the structured error payload.
    const result = await client.callTool({
      name: 'generate',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        constraints: ['NOT A VALID CONSTRAINT @@@'],
      },
    });
    expect(result.isError).toBe(true);
    const out = parseResult(result);
    expect(out.code).toBe('CONSTRAINT_ERROR');
    expect(out.message).toBeTruthy();
  });

  it('surfaces structured INVALID_INPUT errors for invalid generation options', async () => {
    const result = await client.callTool({
      name: 'generate',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        weights: { a: { 1: 0 } },
      },
    });
    expect(result.isError).toBe(true);
    const out = parseResult(result);
    expect(out.code).toBe('INVALID_INPUT');
    expect(out.message).toMatch(/weight/i);
  });

  it.each([
    {
      scenario: 'class model + malformed constraint + seed + valid options',
      arguments: {
        parameters: classParameters(),
        constraints: ['NOT A VALID CONSTRAINT @@@'],
        seed: 17,
        weights: { method: { GET: 2 } },
      },
      expectedError: 'CONSTRAINT_ERROR',
    },
    {
      scenario: 'boundary model + malformed constraint + seed + invalid options',
      arguments: {
        parameters: boundaryParameters(),
        constraints: ['NOT A VALID CONSTRAINT @@@'],
        seed: 17,
        weights: { flag: { on: 0 } },
      },
      expectedError: 'INVALID_INPUT',
    },
    {
      scenario: 'class model + satisfiable constraint + no seed + invalid options',
      arguments: {
        parameters: classParameters(),
        constraints: ['IF method = POST THEN status != 500'],
        weights: { method: { GET: 0 } },
      },
      expectedError: 'INVALID_INPUT',
    },
    {
      scenario: 'boundary model + no constraint or seed + valid options',
      arguments: {
        parameters: boundaryParameters(),
        weights: { flag: { on: 2 } },
        seeds: [{ qty: 1, flag: 'on' }],
        subModels: [{ parameters: ['qty', 'flag'], strength: 2 }],
        maxTests: 0,
      },
    },
    {
      scenario: 'boundary model + satisfiable constraint + seed + valid options',
      arguments: {
        parameters: boundaryParameters(),
        constraints: ['IF flag = on THEN qty >= 0'],
        seed: 23,
        weights: { flag: { off: 2 } },
      },
    },
    {
      scenario: 'discrete model + satisfiable constraint + seed + valid options',
      arguments: {
        parameters: discreteParameters(),
        constraints: ['IF a = 1 THEN b = x'],
        seed: 29,
        weights: { a: { 1: 2 } },
        seeds: [{ a: '1', b: 'x' }],
        subModels: [{ parameters: ['a', 'b'], strength: 2 }],
        maxTests: 0,
      },
    },
  ])('covers generate interaction: $scenario', async ({ arguments: args, expectedError }) => {
    const result = await client.callTool({ name: 'generate', arguments: args });
    const out = parseResult(result);
    if (expectedError) {
      expect(result.isError).toBe(true);
      expect(out.code).toBe(expectedError);
      return;
    }
    expect(result.isError).toBeFalsy();
    expect(out.coverage).toBe(1);
    expect(out.uncoveredCount).toBe(0);
  });

  it('analyze_coverage reports a complete unconstrained suite', async () => {
    const result = await client.callTool({
      name: 'analyze_coverage',
      arguments: {
        parameters: discreteParameters(),
        tests: [
          { a: '1', b: 'x' },
          { a: '1', b: 'y' },
          { a: '2', b: 'x' },
          { a: '2', b: 'y' },
        ],
      },
    });
    const report = parseResult(result);
    expect(report.coverageRatio).toBe(1);
    expect(report.uncoveredCount).toBe(0);
    expect(report.invalidTests).toEqual([]);
  });

  it('analyze_coverage reports invalid rows with constraints present', async () => {
    const result = await client.callTool({
      name: 'analyze_coverage',
      arguments: {
        parameters: discreteParameters(),
        tests: [{ a: '1' }],
        constraints: ['IF a = 1 THEN b = x'],
      },
    });
    const report = parseResult(result);
    expect(report.coverageRatio).toBe(0);
    expect(report.invalidTests).toHaveLength(1);
    expect(report.invalidTests[0].testIndex).toBe(0);
  });

  it('analyze_coverage truncates constrained incomplete-suite diagnostics', async () => {
    const values = Array.from({ length: 40 }, (_, index) => String(index));
    const result = await client.callTool({
      name: 'analyze_coverage',
      arguments: {
        parameters: [
          { name: 'a', values },
          { name: 'b', values },
        ],
        tests: [],
        constraints: [`a IN {${values.join(', ')}}`],
      },
    });
    const report = parseResult(result);
    expect(report.coverageRatio).toBe(0);
    expect(report.uncoveredCount).toBe(1600);
    expect(report.uncovered).toHaveLength(1000);
    expect(report.omittedUncovered).toBe(600);
  });

  it.each([
    { scenario: 'constraints + seed + default mode', constraints: true, seed: 31 },
    { scenario: 'no constraints or seed + default mode' },
    { scenario: 'constraints + no seed + strict mode', constraints: true, mode: 'strict' },
  ])('covers extend_tests interaction: $scenario', async ({ constraints, seed, mode }) => {
    const existing = [
      { a: '1', b: 'x' },
      { a: '2', b: 'y' },
    ];
    const args = { existing, parameters: discreteParameters() };
    if (constraints) {
      args.constraints = ['IF a = 1 THEN b = x'];
    }
    if (seed !== undefined) {
      args.seed = seed;
    }
    if (mode !== undefined) {
      args.mode = mode;
    }

    const result = await client.callTool({ name: 'extend_tests', arguments: args });
    const out = parseResult(result);
    expect(result.isError).toBeFalsy();
    expect(out.coverage).toBe(1);
    expect(out.tests.slice(0, existing.length)).toEqual(existing);
  });

  it.each([
    {
      scenario: 'constraints + custom strength + no sub-model',
      constraints: true,
      strength: 3,
    },
    {
      scenario: 'constraints + default strength + sub-model',
      constraints: true,
      subModels: [{ parameters: ['a', 'b', 'c'], strength: 3 }],
    },
    { scenario: 'no constraints + custom strength + no sub-model', strength: 3 },
    {
      scenario: 'no constraints + custom strength + sub-model',
      strength: 1,
      subModels: [{ parameters: ['a', 'b'], strength: 2 }],
    },
  ])(
    'covers estimate_model interaction: $scenario',
    async ({ constraints, strength, subModels }) => {
      const args = {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
          { name: 'c', values: ['on', 'off'] },
        ],
      };
      if (constraints) {
        args.constraints = ['IF a = 1 THEN b = x'];
      }
      if (strength !== undefined) {
        args.strength = strength;
      }
      if (subModels !== undefined) {
        args.subModels = subModels;
      }

      const result = await client.callTool({ name: 'estimate_model', arguments: args });
      const stats = parseResult(result);
      expect(result.isError).toBeFalsy();
      expect(stats.parameterCount).toBe(3);
      expect(stats.totalTuples).toBeGreaterThan(0);
      expect(stats.subModelCount).toBe(subModels ? 1 : 0);
    },
  );
});

describe('CLI entry point', () => {
  it('boots the MCP server when invoked with no arguments', async () => {
    const cliPath = resolve(here, '..', 'mcp', 'cli.mjs');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
    });
    const client = new Client({ name: 'cli-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['analyze_coverage', 'estimate_model', 'extend_tests', 'generate']);
    } finally {
      await transport.close();
    }
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
