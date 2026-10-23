---
name: code-sweeper
description: Review code changes and pull request diffs for clean-code issues, unnecessary complexity, duplication, verbose comments, and low-value tests. Use before creating or reviewing a pull request.
argument-hint: Optional base ref (for example origin/main) and/or --no-fix
---

# Code Sweeper

Review additions and revisions for adherence to clean coding practices. A script collects the diff and flags repeatable patterns as *candidates*; you verify each one in context.

## Scope

- A focused review of the change, not a repository-wide style audit.
- Not for bugs (use Bug Hunter) or vulnerabilities (use Security Auditor).
- Do not clean up or refactor code the diff did not touch.

## Configuration

Read [config.json](./config.json) first.

- `autoFix.enabled` (default `true`): fix clear, low-risk 🔴 Unclean findings. `--no-fix` or `dry-run` disables all edits for this run without changing the config.
- `tests.removeLowValue` (default `false`): when `false`, only suggest test removals. When `true`, remove a test only if its lack of long-term value is clear from the test and its directly related behavior. Never delete a test because of a scanner match alone.
- `scan.exclude`: patterns omitted during collection and scanning. Defaults cover generated JS/TS artifacts and common prose and data files (`.txt`, `.json`, CSV, XML, YAML, TOML, databases). Adjust them when those files are part of the review.
- `scan.testFiles.patterns`: paths treated as tests for the test-value review.
- `scan.thresholds`: review heuristics, not hard style rules.

## Procedure

Run commands from the repository root.

```sh
TOOLS="Review Tools"  # where the skills live; for example .github/skills once installed
CFG="$TOOLS/code-sweeper/config.json"
node "$TOOLS/review-tools-common/collect-diff.mjs" --config "$CFG" [base-ref] \
  | node "$TOOLS/code-sweeper/scripts/scan-patterns.mjs" [--no-fix]
```

1. **Collect.** Use the provided base ref, else `diff.baseRef` from the config. For a pull request, prefer its target branch. Note the resolved base commit hash and date (printed by the collector) in the report header. A `HEAD` base often yields an empty diff on a clean feature branch; do not mistake that for a reviewed diff. See the [README](../../README.md#how-the-diff-is-chosen) for how the base is resolved.
2. **Scan.** Treat the scanner's JSON as candidate locations, not verdicts. Each candidate has a rule ID, file, line, evidence, and an `enclosingFunctionChange` hint (`new`, `existing`, or `unknown`); verify the hint in context. On large diffs, narrow the review with a base ref or `scan.exclude`.
3. **Review** changed code and directly relevant nearby code for:
   - **Single Responsibility:** functions or modules that combine unrelated work.
   - **Function size:** functions that are hard to understand or test as one unit. Use `scan.thresholds.maxFunctionLines` and the `enclosingFunctionChange` hint as prompts to inspect, not automatic failures.
   - **DRY:** repeated logic that can sensibly share a helper. Check directly relevant call sites for reuse; don't abstract one-off code.
   - **Simplicity:** unnecessary branches, indirection, state, nesting, or cleverness.
   - **Comments:** comments that narrate obvious code or repeat outdated behavior. Keep comments that explain intent, constraints, or non-obvious decisions.
   - **Tests:** whether added or changed tests verify meaningful behavior and add distinct coverage. Prefer recommending removal unless `tests.removeLowValue` is enabled and the test is plainly obsolete or redundant.
4. **Keep related-code inspection narrow.** Start with changed lines and their immediate context. Open another file only for a concrete reuse or behavior question.
5. **Auto-fix** only when `autoFix.enabled` is `true` and `--no-fix`/`dry-run` was not given. For each 🔴 finding inside a function:
   1. Was the function new in this diff? If so, it is eligible.
   2. If it already existed, search tracked files with the same source extension for whole-word references to its name, excluding changed files. Any outside reference means downgrade the finding to 🟡 Dusty and do not fix it.
   3. Preserve behavior and public APIs.
   4. If the finding is subjective or the behavior unclear, leave the code unchanged and report it as 🟡 Dusty.
   5. Run the narrowest relevant test or validation after changes.
6. **Report** using the format below.

## Report

Header: the resolved base (hash and date) and whether auto-fix is enabled. Then these sections, in this order:

- **🔴 Unclean:** obvious cleanup items with clear evidence. Auto-fixed by default when safe and enabled.
- **🟡 Dusty:** plausible cleanup that may be acceptable as-is. Never auto-fix.
- **🟢 Clean:** specific changed areas you actually reviewed that follow the criteria. Do not imply exhaustive coverage. If none can be responsibly identified, write `No specific areas to report.`

Each item includes the rule ID (when applicable), file and line, concise evidence, why it matters, and a concrete recommendation. Don't repeat an issue across sections. An empty section reads `None found.`

End with every edit made, as a concise list, or `No files changed.`
