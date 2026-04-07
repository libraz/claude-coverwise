---
name: coverwise
description: Check and improve combinatorial (pairwise / t-wise) coverage of tests. Use when writing tests for code that takes multiple parameters (CLI flags, config options, feature flags, API query params, state machines, form fields) and you need to ensure every parameter interaction is exercised without writing a full cartesian product. Also use when the user asks about "pairwise", "t-wise", "covering arrays", "combinatorial testing", or "test matrix".
---

# coverwise — Combinatorial Coverage for Tests

This skill wraps the `coverwise` MCP server, which exposes four tools backed by a WASM pairwise / t-wise engine:

- `generate` — build a minimal test suite from parameters + constraints
- `analyze_coverage` — check an existing test suite for missing interactions
- `extend_tests` — add the minimum extra tests needed to reach 100% coverage
- `estimate_model` — sanity-check a model before running generation

## When to reach for this

Use the MCP tools (not ad-hoc reasoning) whenever the system under test has **≥ 3 independent parameters with ≥ 2 values each**. A cartesian product of 4 parameters × 3 values = 81 tests; pairwise covers every 2-way interaction in ~9. The tools produce the minimum.

Typical triggers:

- "Write tests for this function that takes `{flagA, flagB, mode, region}`…"
- "Does my test suite cover all combinations of X and Y?"
- "Add tests for the cases I'm missing."
- CLI tools, REST endpoint query params, feature flag matrices, form validation, state machines, build configuration matrices.

## The recommended workflow

1. **Extract parameters** from the code / spec. Each parameter has a `name` and discrete `values`.
   - Enums → use values as-is
   - Numeric ranges → bucket into boundary values (min, typical, max)
   - Booleans → `[true, false]`
   - Nullable → add `null` as an explicit value if null behavior matters
2. **Call `estimate_model`** first for any non-trivial model. If `estimatedTests` is surprisingly large or `totalTuples` explodes, the model is probably too wide — bucket numeric ranges or split into sub-models.
3. **Write constraints** for impossible combinations (see DSL below). Fewer is better — each constraint shrinks the reachable space.
4. **Generate or analyze**:
   - New test suite: call `generate`.
   - Reviewing existing tests: call `analyze_coverage`, inspect `uncovered[].display` strings.
   - Filling gaps in existing tests: call `extend_tests` with the current tests as `existing`.
5. **Verify**: the returned `coverage` should be `1.0`. If not, read `uncovered[]` — each entry has a `reason` (often "excluded by constraint", which is fine) and a `display` string.
6. **Translate to the target test framework**. The returned `tests` array is `[{param: value, ...}, ...]`. Map each row to one test case in the user's framework (vitest, jest, pytest, Go table tests, etc.).

## Constraint DSL — quick reference

Constraints are strings. Multiple are passed as an array and are AND-ed.

### Conditional

```
IF os = macOS THEN browser != IE
IF os = macOS THEN browser = Safari ELSE browser != Safari
```

`ELSE` is optional. Names and values are case-insensitive.

### Logical operators

```
IF os = Windows AND device = phone THEN browser = Edge
IF os = macOS OR os = iOS      THEN browser = Safari
IF NOT os = Linux              THEN arch IN {x64, arm64}
```

Precedence: `NOT` > `AND` > `OR`. Parenthesize to override:

```
IF (os = Windows OR os = Linux) AND device = desktop THEN browser != Safari
```

### Operators

- Equality: `=`, `!=`
- Relational (numeric): `<`, `<=`, `>`, `>=`
- Set membership: `IN {a, b, c}`
- Pattern: `LIKE chrome*` (`*` matches any substring)
- Parameter-to-parameter: `IF source = target THEN mode = copy`

### Unconditional

Drop the `IF` for constraints that always apply:

```
browser != IE
os IN {Windows, macOS, Linux}
```

### String values with spaces or special chars

Quote them:

```
IF region = "us-east-1" THEN provider = aws
```

## Constraint patterns (recipes)

| Intent | Pattern |
|---|---|
| Exclusion | `IF a = x THEN b != y` |
| Dependency | `IF feature = enabled THEN plan IN {pro, enterprise}` |
| Mutual implication | Two constraints: `IF os = iOS THEN browser = Safari` + `IF browser = Safari THEN os IN {iOS, macOS}` |
| Forbidden triple | `IF os = Windows AND browser = Chrome AND arch = arm64 THEN mode = compatibility` |
| Numeric bucket dependency | Bucket the number first (e.g. `age` → `[child, adult, senior]`), then `IF age = child THEN plan != business` |

## Anti-patterns (what AI gets wrong)

- **Too many constraints.** Each constraint subtracts from the reachable space. If coverage can't reach 1.0, the first thing to check is whether constraints are contradicting each other.
- **Type mismatch.** `"1"` (string) and `1` (number) are different values. Pick one and be consistent per parameter.
- **Raw continuous ranges.** Don't pass `values: [0, 1, 2, ..., 100]`. Bucket to boundary values.
- **Forgetting `extend_tests`.** When the user has hand-written tests they want to keep, use `extend_tests`, not `generate` — otherwise you'll throw away their tests.
- **Strength inflation.** Default to `strength: 2` (pairwise). Only bump to 3 when three-way interactions genuinely matter (security, money, critical state machines). Test count grows fast with strength.
- **Silent constraint violations.** If `analyze_coverage` shows a tuple uncovered with `reason: "excluded by constraint"`, that's expected — it means the constraint made the tuple impossible. Only uncovered tuples with a non-constraint reason are real gaps.

## Analyzing a constrained model

When the parameter model has constraints, **pass them to `analyze_coverage` too** — not just to `generate`. Without constraints, the analyzer cannot know that some tuples are impossible and will report them as `never covered`, polluting your "what's missing" list.

```json
{
  "parameters": [...],
  "tests": [...],
  "constraints": ["IF os = macOS THEN browser != IE"]
}
```

With constraints supplied, impossible tuples are **removed from the coverage universe entirely** — they do not appear in `totalTuples`, `coveredTuples`, or `uncovered`. This matches the generator's semantics, so analyzing a suite that `generate` produced for the same model+constraints yields `coverageRatio === 1.0`.

Rule of thumb: use the same `constraints` array in `analyze_coverage` / `generate` / `extend_tests` for the same model.

## Reading `analyze_coverage` output

```json
{
  "totalTuples": 36,
  "coveredTuples": 32,
  "coverageRatio": 0.888,
  "uncovered": [
    {
      "tuple": ["os=linux", "browser=safari"],
      "params": ["os", "browser"],
      "reason": "not covered by any test",
      "display": "os=linux × browser=safari"
    }
  ]
}
```

Report back to the user in the `display` form — it's the shortest faithful description of what's missing.

## Error codes

The MCP tools return structured errors:

- `INVALID_INPUT` — malformed parameters, typo in a value, unknown constraint syntax
- `CONSTRAINT_ERROR` — constraints are contradictory; no valid test can exist. Ask the user to loosen constraints.
- `INSUFFICIENT_COVERAGE` — `maxTests` cap was too tight. Raise it or drop the cap.
- `TUPLE_EXPLOSION` — strength × parameter count is too large. Lower strength or split into sub-models.

When a constraint error occurs, repeat back the failing constraint to the user; don't try to silently rewrite it.

## One-shot example

User: *"Write tests for a function `render(theme, density, locale, dir)` where theme ∈ {light, dark, hc}, density ∈ {compact, cozy}, locale ∈ {en, ja, ar}, dir ∈ {ltr, rtl}. Arabic and Hebrew must be RTL; everything else LTR."*

Call `generate`:

```json
{
  "parameters": [
    {"name": "theme",   "values": ["light", "dark", "hc"]},
    {"name": "density", "values": ["compact", "cozy"]},
    {"name": "locale",  "values": ["en", "ja", "ar"]},
    {"name": "dir",     "values": ["ltr", "rtl"]}
  ],
  "constraints": [
    "IF locale = ar THEN dir = rtl",
    "IF locale IN {en, ja} THEN dir = ltr"
  ]
}
```

Then translate each row of `result.tests` into one `test(...)` call in the user's framework.
