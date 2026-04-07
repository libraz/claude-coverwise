---
description: Generate a minimal pairwise test suite for a function or component from its parameters.
argument-hint: "[function-name-or-file]"
---

Generate a minimum-size pairwise (or t-wise) test matrix.

Target: $ARGUMENTS (a function name, file path, or free-form description of what to test).

Steps:

1. Locate the target code. Read it to understand inputs: parameters, enums, flags, config.
2. Build a parameter model:
   - Enums and unions → list every variant
   - Booleans → `[true, false]`
   - Numeric ranges → bucket to boundary values (min / typical / max); do NOT enumerate raw ranges
   - Nullable inputs → add an explicit null/undefined value only if null behavior matters
3. Derive constraints from the code (invariants, guards, mutually exclusive flags). Use the DSL documented in the `coverwise` skill. Prefer fewer, sharper constraints.
4. Call `coverwise.estimate_model` first for sanity. If `estimatedTests` looks unreasonable, adjust the model before generating.
5. Call `coverwise.generate` with the model. Use `strength: 2` (pairwise) unless the user explicitly asks for higher.
6. Verify `coverage === 1.0`. If not, inspect `uncovered` — constraint-excluded tuples are fine, anything else is a real problem and must be reported.
7. Translate each row of `result.tests` into a concrete test case in the user's chosen framework (vitest / jest / pytest / Go table test / etc.), matching the file's existing style.
8. Write the tests to the appropriate test file, or print them if the user hasn't specified a destination.

Follow the `coverwise` skill for constraint syntax, anti-patterns, and strength selection.
