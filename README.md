# AI-Skills
Generic skills for AI agents in everyday development workflows.
## Review Tools
| Skill | Question it answers | Report sections |
| --- | --- | --- |
| [Bug Hunter](Review%20Tools/bug-hunter/SKILL.md) | What did this change break, and what new bugs did it add? | 🔴 Probable Bugs · 🟡 Suspicious · 🟢 Clean |
| [Code Sweeper](Review%20Tools/code-sweeper/SKILL.md) | Is this change clean, simple, and well tested? | 🔴 Unclean · 🟡 Dusty · 🟢 Clean |
| [Security Auditor](Review%20Tools/security-auditor/SKILL.md) | Does this change introduce vulnerabilities? | 🔴 High Risk · 🟡 Suspicious · 🟢 Clean |
Each skill reviews only your change, not the whole repo, and they don't overlap: Bug Hunter skips style and vulnerabilities, Code Sweeper skips bugs and security, and so on.
All three work the same way:
1. **Collect** the diff against a base branch (`review-tools-common`).
2. **Scan** it with fast pattern heuristics that flag *candidates*.
3. **Review** each candidate in context. Matches are leads, not verdicts.
## Install
Copy these folders into your project's `.github/skills/` (or `.agents/skills/`):
- `review-tools-common` (required by all three skills)
- `bug-hunter`, `code-sweeper`, and/or `security-auditor`
Keep each skill's `SKILL.md`, `config.json`, and `scripts/` together. Bug Hunter also needs its `references/` folder.
## Use
In VS Code Chat:
```
/bug-hunter origin/main --ticket PROJ-123
/code-sweeper origin/main
/code-sweeper --no-fix          # review only, no edits
/security-auditor origin/main
```
Leave off the base ref to use the configured default branch.
Or run the scripts directly from your repo root:
```bash
node ".github/skills/review-tools-common/collect-diff.mjs" \
  --config ".github/skills/code-sweeper/config.json" origin/main \
  | node ".github/skills/code-sweeper/scripts/scan-patterns.mjs"
```
Scanners print candidates as JSON. They never apply fixes or judge intent on their own. Bug Hunter runs a longer script pipeline; see its [SKILL.md](Review%20Tools/bug-hunter/SKILL.md).
## How the diff is chosen
- With no argument, the base is `origin/HEAD` (your default branch).
- A ref such as `origin/main` is compared from `git merge-base <ref> HEAD`, so target-only commits are excluded.
- Passing `HEAD` compares only the working tree, which is often empty on a clean feature branch.
- Untracked, non-ignored text files are included. Binary and oversized files are skipped.
## Bug Hunter
A regression safety net. It looks for removed guards, dropped awaits, changed contracts, and broken callers, then checks the change against your ticket's acceptance criteria.
| Rule | Flags |
| --- | --- |
| `REMOVED_GUARD` | A null/validity check was removed |
| `REMOVED_AWAIT` | An `await` was dropped |
| `REMOVED_ERROR_HANDLING` | Error handling was removed |
| `REMOVED_CLEANUP` | Cleanup or disposal was removed |
| `MISSING_RELEASE` | A JS/TS loading state may never complete |
| `REMOVED_EARLY_EXIT` | An early return was removed (hint) |
| `BEHAVIOR_CHANGE_PAIR` | A `-`/`+` pair changes behavior |
| `SIGNATURE_CHANGED` | A function contract changed (hint; triggers a caller search) |
| `REMOVED_TEST_ASSERTION` | A test assertion was removed |
| `TEST_DISABLED` | A test was disabled |
How it works:
- **Packets:** scripts rank findings by risk and bundle them with surrounding code and callers, so the agent reads only compact packets. Large diffs hit a size gate and ask whether to review everything or only the riskiest changes.
- **Two passes:** a basic model triages script findings, then an advanced model reviews what's left. Without model-selectable subagents, the agent does both passes itself.
- **Language notes:** JavaScript/TypeScript, C#, and Python.
- **Reports:** saved to `.bug-hunter/reports` (add `.bug-hunter/` to `.gitignore`).
| Setting | Purpose | Default |
| --- | --- | --- |
| `autoFix` | Fix unambiguous 🔴 bugs. When `false`, no files are ever edited | `false` |
| `diff.maxDiffBytes` | Size gate for the diff | `102400` |
| `ticketContext` | Ticket file used as acceptance criteria (`--ticket <name>` overrides) | `null` |
| `repositoryContext` | Nearby docs for local patterns and invariants | `null` |
| `rules.disabled` / `rules.severityOverrides` | Tune noisy rules | none |
| `models.basic` / `models.advanced` | Model selectors for each pass | see `config.json` |
| `report.outputDir` | Where reports are written | `.bug-hunter/reports` |
Silence a single finding inline with `bug-hunter-ignore` or `bug-hunter-ignore: RULE_NAME`.
## Code Sweeper
Checks changed code for long lines, nested conditionals, heavy boolean logic, long comments, duplication, loose types, oversized files, and weak tests.
| Rule | Flags |
| --- | --- |
| `SWEEP-101` | Long added line |
| `SWEEP-102` | Nested conditional expression |
| `SWEEP-103` | Many boolean operators on one line |
| `SWEEP-104` | Long comment |
| `SWEEP-105` | Repeated statement or block |
| `SWEEP-106` | Long Python function |
| `SWEEP-107` | `any` and type assertions (JS/TS) |
| `SWEEP-108` | Test with only trivial assertions |
| `SWEEP-109` | Duplicated `as any` test fixtures |
| `SWEEP-110` | Near-identical sibling tests |
| `SWEEP-111` | Large source file that grew |
Auto-fix is on by default for clear, low-risk findings. Dusty findings are never auto-fixed, and test removal is off until you enable `tests.removeLowValue` in `config.json`.
## Security Auditor
Scans JavaScript/TypeScript, Python, and C# by file, so language-specific heuristics only run on matching files. Coverage is heuristic, not exhaustive.
Set these in `config.json`:
| Setting | Purpose | Default |
| --- | --- | --- |
| `models.basic` / `models.advanced` | Model selectors for pattern review and architectural review | `haiku` / `sonnet` |
| `scan.projectStack` | `backend`, `frontend`, `full-stack`, or `unknown` | `backend` |
| `scope.maxRelatedFiles` / `maxRelationshipHops` | How far review follows related code | `5` / `1` |
## Tests
Requires Node 22. No third-party dependencies.
```bash
node --test \
  "Review Tools/bug-hunter/test/*.test.mjs" \
  "Review Tools/code-sweeper/test/scan-patterns.test.mjs" \
  "Review Tools/security-auditor/test/scan-patterns.test.mjs" \
  "Review Tools/review-tools-common/test/collect-diff.test.mjs"
```
## License
MIT
Displaying README.md.
