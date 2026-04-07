---
description: Analyze combinatorial coverage of the current / specified test file and report missing parameter interactions.
argument-hint: "[test-file-or-directory]"
---

Analyze the pairwise (or higher) coverage of an existing test suite.

Target: $ARGUMENTS (a path to a test file or directory, or empty to infer from context).

Steps:

1. Read the target test file(s). Identify the function or endpoint under test and the parameters it accepts.
2. Extract the parameter model: for each parameter, list the discrete values that appear in the tests AND any additional values that exist in the type / enum but are missing.
3. Call the `coverwise.analyze_coverage` MCP tool with:
   - `parameters`: the full parameter model (including values that are currently untested)
   - `tests`: the test cases already present, as `{paramName: value}` maps
   - `strength`: 2 unless the user specified otherwise
4. Report:
   - Current coverage ratio
   - Every uncovered tuple using its `display` string
   - Whether each gap is a real miss or excluded by a constraint (use the `reason` field)
5. If there are real gaps, offer to run `/cover-extend` to generate the minimum additional tests.

Follow the guidance in the `coverwise` skill for the constraint DSL and common pitfalls.
