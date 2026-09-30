---
name: code-sweeper
description: 'Review code changes and pull request diffs for clean-code issues, unnecessary complexity, duplication, verbose comments, and low-value tests. Use before creating or reviewing a pull request.'
argument-hint: 'Optional base ref, such as origin/main'
---

# Code Sweeper

Review additions and revisions for adherence to clean coding practices. Use the shared review-tool helper to collect diff evidence and the bundled scanner to flag repeatable patterns, then verify each candidate in context. This is a focused review of the change, not a repository-wide style audit.

## Configuration

Read [config.json](./config.json) before starting. `autoFix.enabled` defaults to `true` for clear, low-risk Unclean findings. Do not auto-fix Dusty findings. `tests.removeLowValue` defaults to `false`; when disabled, report test-removal suggestions only. When enabled, remove a test only when its lack of long-term value is clear from the test and directly related behavior. Never delete a test based only on a scanner match.

`scan.exclude` patterns are omitted during collection and scanning. `scan.testFiles.patterns` identifies test paths for a dedicated test-value review. `scan.thresholds` provides review heuristics, not hard style requirements.

## Procedure

1. Determine the comparison base. Use the provided argument when present; otherwise use `diff.baseRef` from the config. Collect the change set with [collect-diff.mjs](../review-tools-common/collect-diff.mjs), passing this skill's config path. For a pull request, prefer its target branch or merge base. Include untracked, non-ignored files.
2. Run [scan-patterns.mjs](./scripts/scan-patterns.mjs) on the collector's JSON output. Treat its output as candidate locations, not verdicts. The scripts use Node.js built-ins and do not need third-party dependencies.
3. Review changed code and directly relevant nearby code for:
   - **Single Responsibility:** functions, methods, and modules that combine unrelated work or make changes difficult to isolate.
   - **Function size:** functions that are hard to understand or test as one unit. Use `scan.thresholds.maxFunctionLines` as a prompt to inspect, not an automatic failure.
   - **DRY:** repeated logic that can sensibly share an existing or newly introduced helper. Check directly relevant existing call sites for reuse opportunities; avoid broad searches and abstractions for one-off code.
   - **Simplicity:** unnecessary branches, indirection, state, nesting, or cleverness that can be made clearer without changing behavior.
   - **Comments:** comments that narrate obvious code, are irrelevant, or repeat outdated behavior. Preserve comments that explain intent, constraints, or non-obvious decisions.
   - **Tests:** whether added or revised tests verify meaningful behavior, add distinct coverage, and remain valuable as the implementation evolves. Prefer recommending removal unless `tests.removeLowValue` is enabled and the test is plainly obsolete or redundant.
4. Keep related-code inspection narrow. Start with changed lines and their immediate context. Open another file only when it is directly linked to a concrete reuse or behavior question. Do not perform repository-wide cleanup or refactoring.
5. Apply only clear, low-risk Unclean fixes when `autoFix.enabled` is true. Preserve behavior and public APIs, and run the narrowest relevant test or validation after changes. If a finding is subjective or the behavior is unclear, leave the code unchanged and report it as Dusty.
6. Report using exactly these sections, in this order:

   ### 🔴 Unclean
   Obvious cleanup items with clear evidence. Auto-fix by default when safe and enabled.

   ### 🟡 Dusty
   Plausible opportunities for cleanup or simplification that may be acceptable as-is. Never auto-fix these.

   ### 🟢 Clean
   Specific changed areas reviewed that appear to follow the stated criteria. Do not imply exhaustive coverage.

For each item, include the rule ID when applicable, file and line, concise evidence, why it matters, and a concrete recommendation. Avoid duplicating the same issue across sections. If a section has no entries, write `None found.` In Clean, list only areas actually reviewed; if none can be responsibly identified, write `No specific areas to report.`

## Script Usage

Run from the repository root:

```sh
node "Review Tools/review-tools-common/collect-diff.mjs" --config "Review Tools/code-sweeper/config.json" [base-ref] | node "Review Tools/code-sweeper/scripts/scan-patterns.mjs"
```

The collector defaults to `diff.baseRef` in the supplied config, or `HEAD` when unset; pass a target ref such as `origin/main` for a PR review. It includes tracked changes relative to that ref and untracked, non-ignored text files. Binary files and untracked files over the configured collection limit are skipped. The scanner reads JSON from standard input and prints heuristic candidates and changed test files to standard output; it does not apply fixes or classify test value by itself.
