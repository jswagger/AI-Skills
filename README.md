# AI-Skills
A collection of generic skills to be utilized by agents in common development workflows

## Review Tools

- [Security Auditor](Review%20Tools/security-auditor/SKILL.md): review code changes for security vulnerabilities and risky patterns.

### Security Auditor Setup

To make the skill discoverable in a project, copy the complete `security-auditor` folder into that project's `.github/skills/security-auditor/` directory. The `.agents/skills/security-auditor/` directory is also supported. Keep `SKILL.md`, `config.json`, and `scripts/` together so the skill can find its configuration and scripts.

Edit `config.json` to choose the model roles and review defaults:

```json
{
	"models": {
		"basic": "Haiku",
		"advanced": "Sonnet"
	},
	"diff": {
		"baseRef": "HEAD",
		"untrackedMaxBytes": 100000
	},
	"scope": {
		"maxRelatedFiles": 5,
		"maxRelationshipHops": 1
	}
}
```

Set `models.basic` and `models.advanced` to the model names available in your agent environment. The defaults are Haiku for common-pattern review and Sonnet for architectural review; actual model switching depends on the agent environment. `diff.baseRef` is used when no base is supplied, and the scope values guide how far the review follows related code.

### Use the Skill

In VS Code Chat, run `/security-auditor` to review changes against the configured base, or pass a target branch such as `/security-auditor origin/main` for a pull request. The skill collects the diff, runs its pattern scanner, then reviews the evidence and reports High Risk, Suspicious, and Clean sections. Treat automated matches as candidates for review, not confirmed vulnerabilities.

### Run the Scripts Directly

From the target repository root, collect and scan changes with Node.js:

```sh
node ".github/skills/security-auditor/scripts/collect-diff.mjs" origin/main \
	| node ".github/skills/security-auditor/scripts/scan-patterns.mjs"
```

Use `HEAD` or omit the argument to use the configured default. The collector includes tracked changes relative to the base and untracked, non-ignored text files. It skips binary files and untracked files larger than `diff.untrackedMaxBytes`. The scanner prints heuristic candidates as JSON; it does not perform the full contextual review or produce the final report on its own.
