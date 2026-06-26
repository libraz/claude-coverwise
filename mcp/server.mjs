#!/usr/bin/env node
/**
 * claude-coverwise MCP server.
 *
 * Exposes the @libraz/coverwise combinatorial test engine over stdio
 * so Claude Code can analyze, generate, and extend pairwise / t-wise
 * test suites while writing tests.
 */
import { analyzeCoverage, estimateModel, extendTests, generate, init } from '@libraz/coverwise';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// --- WASM initialization -------------------------------------------------
// Defer reporting init failures until the first tool call so the client
// sees a structured error instead of a silent stdio disconnect.
let initError = null;
try {
  await init();
} catch (err) {
  initError = err;
}

const server = new Server({ name: 'coverwise', version: '0.3.0' }, { capabilities: { tools: {} } });

// --- Shared JSON Schema fragments ---------------------------------------

/** A single parameter value: primitive or { value, invalid?, aliases?, class? } object. */
const parameterValueSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    {
      type: 'object',
      properties: {
        value: {
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        },
        invalid: {
          type: 'boolean',
          description: 'If true, this value triggers a negative test (single-fault).',
        },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description: 'Alternate names that match this value in constraints.',
        },
        class: {
          type: 'string',
          description:
            'Equivalence class name. Values sharing a class are interchangeable for the class-coverage metric, surfaced as result.classCoverage.',
        },
      },
      required: ['value'],
      additionalProperties: false,
    },
  ],
};

const parameterSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Parameter name (e.g. "os").' },
    values: {
      type: 'array',
      description: 'Discrete values for this parameter.',
      items: parameterValueSchema,
    },
    type: {
      type: 'string',
      enum: ['integer', 'float'],
      description:
        'Boundary value expansion type. With `range`, expands the value set to min-1/min/min+1 and max-1/max/max+1 (spaced by `step` for "float").',
    },
    range: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: 'Inclusive [min, max] range driving boundary value expansion. Requires `type`.',
    },
    step: {
      type: 'number',
      description: 'Step size for "float" boundary expansion (default 1.0).',
    },
  },
  required: ['name', 'values'],
  additionalProperties: false,
};

const parametersSchema = {
  type: 'array',
  description: 'List of input parameters to cover.',
  items: parameterSchema,
};

const constraintsSchema = {
  type: 'array',
  description:
    'Constraint DSL strings (e.g. "IF os = macOS THEN browser != IE"). See the coverwise skill for grammar.',
  items: { type: 'string' },
};

const primitiveSchema = {
  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
};

const testCaseSchema = {
  type: 'object',
  description: 'A test case as a { paramName: value } map.',
  additionalProperties: primitiveSchema,
};

const testCasesSchema = { type: 'array', items: testCaseSchema };

const weightsSchema = {
  type: 'object',
  description:
    'Per-parameter value weights to bias generation. Shape: { paramName: { value: weight, ... } }.',
  additionalProperties: {
    type: 'object',
    additionalProperties: { type: 'number' },
  },
};

const subModelsSchema = {
  type: 'array',
  description:
    'Mixed-strength sub-models. Each entry raises the strength for a named subset of parameters (e.g. boost critical groups to 3-wise while the rest stays pairwise).',
  items: {
    type: 'object',
    properties: {
      parameters: { type: 'array', items: { type: 'string' } },
      strength: { type: 'number' },
    },
    required: ['parameters', 'strength'],
    additionalProperties: false,
  },
};

/** Fields shared by generate / extend_tests / estimate_model. */
const generateInputFields = {
  parameters: parametersSchema,
  constraints: constraintsSchema,
  strength: {
    type: 'number',
    description: 'Interaction strength t. 2 = pairwise (default), 3 = triple-wise, etc.',
    default: 2,
  },
  seed: { type: 'number', description: 'RNG seed for deterministic output.' },
  weights: weightsSchema,
  seeds: {
    ...testCasesSchema,
    description: 'Mandatory seed test cases that must appear in the generated suite.',
  },
  subModels: subModelsSchema,
  maxTests: {
    type: 'number',
    description: 'Optional cap on test count. Coverage may be < 1.0 if set too low.',
  },
};

// --- Tool definitions ---------------------------------------------------

const tools = [
  {
    name: 'generate',
    description:
      'Generate a minimal t-wise (default pairwise) test suite from parameters and optional constraints. Returns tests, coverage ratio, and any uncovered tuples with human-readable reasons.',
    inputSchema: {
      type: 'object',
      properties: generateInputFields,
      required: ['parameters'],
    },
  },
  {
    name: 'analyze_coverage',
    description:
      'Analyze t-wise coverage of an EXISTING test suite (e.g. AI- or hand-written tests). Returns every uncovered tuple with a display string explaining what is missing. Use this as the primary "did I cover everything?" check. Pass `constraints` when the model has them — constraint-impossible tuples are then removed from the coverage universe (not counted toward totalTuples / coveredTuples / uncovered), matching the generator\'s semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        parameters: parametersSchema,
        tests: { ...testCasesSchema, description: 'Test cases to analyze.' },
        strength: { type: 'number', default: 2 },
        constraints: constraintsSchema,
      },
      required: ['parameters', 'tests'],
    },
  },
  {
    name: 'extend_tests',
    description:
      'Extend an existing test suite with the minimum additional tests needed to reach full t-wise coverage. Existing tests are kept verbatim; only new tests are appended. The returned tests array is not guaranteed to preserve the original ordering — diff it against `existing` to identify the newly added rows.',
    inputSchema: {
      type: 'object',
      properties: {
        existing: {
          ...testCasesSchema,
          description: 'Test cases already written — will be preserved as-is.',
        },
        ...generateInputFields,
      },
      required: ['existing', 'parameters'],
    },
  },
  {
    name: 'estimate_model',
    description:
      'Report model statistics (parameter count, total t-tuples, estimated test count) WITHOUT running generation. Use this to sanity-check a model before committing to a large generate() call.',
    inputSchema: {
      type: 'object',
      properties: {
        parameters: parametersSchema,
        constraints: constraintsSchema,
        strength: { type: 'number', default: 2 },
        subModels: subModelsSchema,
      },
      required: ['parameters'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// --- Call dispatch ------------------------------------------------------

function toErrorPayload(err) {
  // CoverwiseError carries a structured `code` (and optional `detail`); preserve
  // its enumerable fields. `message` lives on Error as a non-enumerable property,
  // so JSON.stringify would drop it unless we copy it onto the payload explicitly.
  if (err && typeof err === 'object' && 'code' in err) {
    return { ...err, message: err.message ? String(err.message) : String(err) };
  }
  return {
    code: 'INVALID_INPUT',
    message: err?.message ? String(err.message) : String(err),
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (initError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              code: 'INVALID_INPUT',
              message: `coverwise WASM init failed: ${initError?.message ?? initError}`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    switch (name) {
      case 'generate':
        result = generate(args);
        break;
      case 'analyze_coverage':
        result = analyzeCoverage(args.parameters, args.tests, args.strength, args.constraints);
        break;
      case 'extend_tests': {
        const { existing, ...rest } = args;
        result = extendTests(existing, rest);
        break;
      }
      case 'estimate_model':
        result = estimateModel(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(toErrorPayload(err), null, 2) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
