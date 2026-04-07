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
6. The returned `tests` array contains the full extended suite (existing + new). Do **not** assume the existing tests appear at the head of the array — the ordering is not guaranteed. Identify the new rows by diffing `result.tests` against `existing` (compare as sets of parameter-to-value maps).
7. Append only the new tests to the file, matching the file's existing style and framework.
8. Verify `coverage === 1.0`. Any remaining `uncovered` with a non-constraint reason must be reported to the user.

Do NOT rewrite, reorder, or delete existing tests — only append. If the user's existing tests have drifted from the parameter model (e.g. they use a value that no longer exists), stop and ask rather than silently "fixing" them.
