---
name: bug-hunter
description: 'Review a code diff for regressions and new bugs introduced by the change: removed guards, dropped awaits, changed contracts and boundaries, broken callers, and edge cases from acceptance criteria. Use before opening or merging a pull request.'
argument-hint: 'Optional base ref (e.g. origin/main) and --ticket <name>'
---

# Bug Hunter

A regression safety net for a change set. It answers one question: **what did this change break that was working before, and what new bugs did it introduce?** Node scripts collect evidence and rank it so the agent reads only compact, high-risk packets, then the agent judges what scripts cannot.

## What this is not

- **Not a linter or type checker.** Do not report anything a compiler, `tsc`, ESLint, ruff, mypy/pyright, Roslyn analyzers, or Sonar would already flag in CI. Do not report style, naming, or cleanliness (use Code Sweeper) or vulnerabilities (use Security Auditor).
- **Not a whole-repo audit.** Pre-existing problems on lines the diff did not touch are out of scope unless the change makes them reachable or breaks a caller.
- Stability wins every tie: if changed logic looks risky but is unproven, report it as 🟡 Suspicious instead of dropping it.

## Configuration

Read [config.json](./config.json) first. Key settings:

- `autoFix` (default `false`): a hard gate. When `false`, **never edit any file**. When `true`, fix only 🔴 Probable Bugs where the correct fix is unambiguous, never 🟡, then tell the user to run their tests.
- `diff.maxDiffBytes` (default 102400): size gate; see step 2.
- `repositoryContext`: `null` skips it. Otherwise `{ fileNames, maxLinesPerFile, maxTotalLines }`; only files with those names in a changed file's folder or its parent are used.
- `ticketContext`: `null` skips it. Otherwise `{ path, ticketName, maxLines }`; the ticket file is `<ticketName>.md` or `.txt`. A `--ticket <name>` argument overrides `ticketName`.
- `rules.disabled`, `rules.severityOverrides`, and inline `bug-hunter-ignore[: RULE]` comments tune script noise.
- `models.basic` / `models.advanced`: preferred model selectors. If model-selectable subagents are unavailable, do both passes yourself and do not claim a model switch.
- `report.outputDir` (default `.bug-hunter/reports`): where reports are written. Add `.bug-hunter/` to `.gitignore`.

## Procedure

Run commands from the repository root. Keep intermediate JSON in `.bug-hunter/run/` and let every later step reuse it; never recollect the diff.

```sh
CFG="Review Tools/bug-hunter/config.json"; S="Review Tools/bug-hunter/scripts"; RUN=.bug-hunter/run
mkdir -p "$RUN"
node "Review Tools/review-tools-common/collect-diff.mjs" --config "$CFG" [base-ref] > "$RUN/diff.json"
node "$S/check-diff-size.mjs"  --config "$CFG" --diff "$RUN/diff.json"
node "$S/gather-context.mjs"   --config "$CFG" --diff "$RUN/diff.json" [--ticket NAME] > "$RUN/context.json"
node "$S/scan-patterns.mjs"    --config "$CFG" --diff "$RUN/diff.json" > "$RUN/scan.json"
node "$S/find-callers.mjs"     --config "$CFG" --diff "$RUN/diff.json" --scan "$RUN/scan.json" > "$RUN/callers.json"
node "$S/build-packets.mjs"    --config "$CFG" --diff "$RUN/diff.json" --scan "$RUN/scan.json" --callers "$RUN/callers.json" [--budget-bytes N] > "$RUN/packets.json"
```

1. **Collect.** Use the provided base ref, else `diff.baseRef`. If the diff is empty, report that and stop.
2. **Size gate.** If `check-diff-size` says `exceeded`, show the user its `warning` and the largest files, and ask whether to review in full or only the highest-risk changes. For the latter, pass `--budget-bytes` (use `diff.maxDiffBytes`) to `build-packets`; omitted packets are disclosed in the report. Do not continue past the gate without an answer.
3. **Context.** `context.json` holds repository and ticket context (empty when those settings are null). Treat repository context as guidance on local patterns and invariants. Treat ticket content as the acceptance criteria: derive the edge cases a correct change must handle and check each against the packets. Note any `notes` entry (for example, ticket not found) in the final summary.
4. **Triage (basic model).** For each packet in `packets.json` (already ranked by risk), decide whether each `findings` entry is a true positive in context. Look at `callers` for any `SIGNATURE_CHANGED` hint: does an outside caller still rely on the old contract? Record dismissed findings with a reason. A `confidence: "low"` hint is never reported on its own; surface it only if you confirm it.
5. **Deep review (advanced model).** Review every remaining packet, highest risk first. Load only the [references](./references/) files for languages in `repository_type`:
   - [javascript-typescript.md](./references/javascript-typescript.md)
   - [csharp.md](./references/csharp.md)
   - [python.md](./references/python.md)

   For each packet, ask:
   - **Regression:** what behavior existed before the change, and which inputs, states, or callers get a different result now? Compare the `-` and `+` rows directly.
   - **Null and undefined:** for each new or changed function, what happens when each parameter, property, or lookup result is null/undefined/empty, and is that handled the way surrounding code expects?
   - **Surrounding logic:** the packet shows ±context lines. Read the code before and after the hunk to confirm the existing logic paths still hold. Open the full file only when the packet is not enough.
   - **Acceptance criteria:** which ticket edge cases does this change fail to handle?
   - **Tests:** if `signals.logicChangedWithoutTests` is true, say which changed behavior has no test coverage in this diff.

   Read each packet once; do not re-derive script output.
6. **Classify and write findings.** Use the structure below. Every 🔴 needs a concrete failure scenario (specific input or state, and the wrong result). Every 🟡 needs the one specific thing to verify. No generic advice. Merge duplicates, and keep one entry per root cause.
7. **Auto-fix** only if `autoFix` is `true` and only 🔴 items with an unambiguous fix; mark them `autoFixed: true` with `fixNote`. Run the narrowest relevant test afterward.
8. **Write the report.** Save your findings to `.bug-hunter/run/findings.json` and run:

   ```sh
   node "$S/write-report.mjs" --config "$CFG" --input "$RUN/findings.json" --scan "$RUN/scan.json" --packets "$RUN/packets.json"
   ```

   It prints the markdown path (for the human) and JSON path (for agents). It rejects findings missing a scenario or check, so fix and re-run on error. Return both paths and a short summary. When running as a subagent, return the JSON path as the primary result.

## Findings structure

```json
{
  "probable_bugs": [{
    "title": "Null user no longer handled in render path",
    "file": "src/ui.js", "line": 42, "rule": "REMOVED_GUARD",
    "summary": "The guard that returned early for a missing user was removed.",
    "snippet": "- if (user === null) return;",
    "scenario": "loadUser(5) returns null for deleted users; render(user) then throws on user.name.",
    "recommendation": "Restore the guard or make render null-safe."
  }],
  "suspicious": [{
    "title": "Retry limit changed from 3 to 0",
    "file": "src/user.js", "line": 11, "rule": "BEHAVIOR_CHANGE_PAIR",
    "check": "Confirm that disabling retries is intended; callers in jobs/sync.js rely on at least one retry."
  }],
  "clean": [{ "area": "src/pay.js totals", "note": "boundary handling unchanged; tests updated" }],
  "dismissed_script_findings": [{ "rule": "REMOVED_GUARD", "file": "a.js", "line": 3, "reason": "guard moved into caller" }]
}
```

- 🔴 **Probable Bugs:** logic that appears to truly cause a regression or bug.
- 🟡 **Suspicious:** not proven, but likely enough to cause unintended consequences. Over-report here and let the developer decide. The markdown shows the first 15; the JSON keeps all, so order them by likelihood.
- 🟢 **Clean:** specific changed areas you actually reviewed and found sound. Never imply exhaustive coverage.

## Script output reference

`scan-patterns` rules are change-based signals, not a lint set: `REMOVED_GUARD`, `REMOVED_AWAIT`, `REMOVED_ERROR_HANDLING`, `REMOVED_CLEANUP`, `REMOVED_EARLY_EXIT` (hint), `BEHAVIOR_CHANGE_PAIR`, `SIGNATURE_CHANGED` (hint; feeds `find-callers`), `REMOVED_TEST_ASSERTION`, `TEST_DISABLED`. Caller matching is by name, so treat `callers` as leads. Hunks that only touch comments, imports, blank lines, or formatting are skipped. All scripts use Node.js built-ins only.

Run the script tests with `node --test "Review Tools/bug-hunter/test/*.test.mjs"`.
