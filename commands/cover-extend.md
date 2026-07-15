---
description: Extend an existing test suite with the minimum additional tests needed to reach full combinatorial coverage.
argument-hint: "[test-file]"
---

Add the minimum new tests required to bring an existing suite to 100% pairwise (or t-wise) coverage, keeping all current tests untouched.

Target: $ARGUMENTS (path to the test file to extend).

Steps:

1. Read the target test file. Extract every existing test case into `{paramName: value}` maps. Ask the user if the extraction is ambiguous.
2. Build the full parameter model (including values not yet used in the existing tests). See the `coverwise` skill for parameter modeling guidance.
3. Derive any necessary constraints from the code under test.
4. Call `coverwise.analyze_coverage` first to show the user the current gaps.
5. Call `coverwise.extend_tests` with:
   - `existing`: the extracted test cases
   - `parameters` / `constraints` / `strength`: the model
6. In strict mode, the returned `tests` array contains the existing rows verbatim at the head in their original order, followed by generated rows. Verify that prefix and identify new rows with `result.tests.slice(existing.length)`.
7. Append only the new tests to the file, matching the file's existing style and framework.
8. Verify `coverage === 1.0`. If coverage is incomplete, report `uncoveredCount`, every returned `uncovered[].display`, and `omittedUncovered` when non-zero. Constraint-unreachable tuples are already removed from the coverage universe.

Do NOT rewrite, reorder, or delete existing tests — only append. If the user's existing tests have drifted from the parameter model (e.g. they use a value that no longer exists), stop and ask rather than silently "fixing" them.
