# AI-Skills
A collection of generic skills to be utilized by agents in common development workflows

## Review Tools

- [Security Auditor](Review%20Tools/security-auditor/SKILL.md): review code changes for security vulnerabilities and risky patterns.
- [Code Sweeper](Review%20Tools/code-sweeper/SKILL.md): review code changes for clean-code issues and low-value tests.

### Run Unit Tests

Run the built-in Node.js test suites from the repository root with `node --test "Review Tools/code-sweeper/test/scan-patterns.test.mjs" "Review Tools/security-auditor/test/scan-patterns.test.mjs" "Review Tools/review-tools-common/test/collect-diff.test.mjs"`. This explicit file list works on Node 22 and avoids passing a test directory as a module. No third-party test dependencies are required.

### Shared Helper Setup

Both review skills use [review-tools-common](Review%20Tools/review-tools-common/) for diff collection and file filtering. Copy the complete folder into the target project's `.github/skills/review-tools-common/` directory (or `.agents/skills/review-tools-common/`) alongside whichever review skill folders you install.

### Code Sweeper Setup

To make the skill discoverable in a project, copy the complete `code-sweeper` folder into that project's `.github/skills/code-sweeper/` directory. The `.agents/skills/code-sweeper/` directory is also supported. Keep `SKILL.md`, `config.json`, and `scripts/` together so the skill can find its configuration and scripts.

Edit `config.json` to tune review defaults. Obvious cleanup auto-fixes are enabled by default; test removal is disabled by default and can be enabled separately after contextual review.

### Use the Skill

In VS Code Chat, run `/code-sweeper` to review changes against the configured base, or pass a target branch such as `/code-sweeper origin/main` for a pull request. The skill collects the diff, reports heuristic clean-code candidates, then reviews the evidence and reports Unclean, Dusty, and Clean sections. Treat automated matches as candidates, not confirmed issues.

### Run the Scripts Directly

From the target repository root, collect and scan changes with Node.js:

```sh
node ".github/skills/review-tools-common/collect-diff.mjs" --config ".github/skills/code-sweeper/config.json" origin/main | node ".github/skills/code-sweeper/scripts/scan-patterns.mjs"
```

Use `HEAD` or omit the argument to compare working-tree changes to `HEAD`. A target ref such as `origin/main` is resolved to `git merge-base <ref> HEAD`, so target-only commits are excluded while feature-branch and local changes remain included. Untracked, non-ignored text files are included; binary files and oversized untracked files are skipped. The scanner prints heuristic candidates as JSON; it does not apply fixes or decide whether tests are low-value.

### Security Auditor Setup

To make the skill discoverable in a project, copy the complete `security-auditor` folder into that project's `.github/skills/security-auditor/` directory. The `.agents/skills/security-auditor/` directory is also supported. Keep `SKILL.md`, `config.json`, and `scripts/` together so the skill can find its configuration and scripts.

Edit `config.json` to choose the model roles and review defaults:

```json
{
	"models": {
		"basic": "haiku",
		"advanced": "sonnet"
	},
	"diff": {
		"baseRef": "origin/HEAD",
		"untrackedMaxBytes": 100000
	},
	"scope": {
		"maxRelatedFiles": 5,
		"maxRelationshipHops": 1
	}
}
```

Set `models.basic` and `models.advanced` to the model selectors available in your agent environment. Defaults are `haiku` for common-pattern review and `sonnet` for architectural review; subagents should receive the collected diff and scanner candidates without recollecting. Set `scan.projectStack` for the target repository (`backend`, `frontend`, `full-stack`, or `unknown`); the shipped default is `backend`. The scanner recognizes JavaScript/TypeScript, Python, and C# source files, detecting languages per changed file so language-specific heuristics only run on matching files. Coverage is heuristic and varies by language; it is not exhaustive. `diff.baseRef` is used when no base is supplied; the Security Auditor defaults to `origin/HEAD` and falls back to `HEAD` if unavailable. The scope values guide how far the review follows related code.

### Use the Skill

In VS Code Chat, run `/security-auditor` to review changes against the configured base, or pass a target branch such as `/security-auditor origin/main` for a pull request. The skill collects the diff, runs its pattern scanner, then reviews the evidence and reports High Risk, Suspicious, and Clean sections. Treat automated matches as candidates for review, not confirmed vulnerabilities.

### Run the Scripts Directly

From the target repository root, collect and scan changes with Node.js:

```sh
node ".github/skills/review-tools-common/collect-diff.mjs" --config ".github/skills/security-auditor/config.json" origin/main | node ".github/skills/security-auditor/scripts/scan-patterns.mjs"
```

Pass a target ref such as `origin/main` to compare from `git merge-base <ref> HEAD`, excluding target-only commits while retaining feature-branch and local changes. With no argument, the Security Auditor uses `origin/HEAD`, falling back to `HEAD` when that ref is unavailable. Untracked, non-ignored text files are included; binary files and oversized untracked files are skipped. The scanner prints heuristic candidates as JSON; it does not perform the full contextual review or produce the final report on its own.
