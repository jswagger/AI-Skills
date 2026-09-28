---
name: security-auditor
description: 'Review code changes and pull request diffs for security vulnerabilities, insecure patterns, authorization gaps, and architectural risks. Use before creating or reviewing a pull request.'
argument-hint: 'Optional base ref, such as origin/main'
---

# Security Auditor

Review additions and revisions for security vulnerabilities and risky patterns. Use the bundled scripts to collect diff evidence and flag repeatable patterns; verify every candidate in context before reporting it. This is a focused code review, not a guarantee that the code is secure.

## Configuration

Read [config.json](./config.json) before starting. `models.basic` and `models.advanced` name the preferred model roles (Haiku and Sonnet by default). Use those models for their respective passes when the agent environment supports model selection. If it does not, continue with the available model and do not claim that another model was used.

## Procedure

1. Determine the comparison base. Use the provided argument when present; otherwise use `diff.baseRef` from the config. Collect the change set with [collect-diff.mjs](./scripts/collect-diff.mjs). For a pull request, prefer its target branch or merge base. Include untracked, non-ignored files.
2. Run [scan-patterns.mjs](./scripts/scan-patterns.mjs) on the collector's JSON output. Treat its output as candidate locations, not confirmed findings. Review removed lines too, especially when a change deletes or weakens an existing security control; the pattern scanner only checks added lines. The scripts use Node.js built-ins and do not need third-party dependencies.
3. Use the basic model role for common implementation risks. Review the changed code for:
   - **CRIT-101:** dynamic string construction in database queries, OS commands, or HTML rendering; prefer parameterized queries and safe APIs.
   - **CRIT-102:** blacklist-based input validation; prefer explicit allowlists, exact types, or enums.
   - **CRIT-103:** validation added only on the client; check the directly corresponding API/controller for server-side enforcement.
   - **CRIT-201:** hard-coded credentials or secrets; recommend environment configuration or a secrets manager. Never reproduce a secret value in the report.
   - **CRIT-202:** homegrown cryptography or predictable randomness used for security tokens or identifiers; recommend standard crypto libraries and a CSPRNG.
   - **CRIT-203:** encryption without integrity protection; prefer authenticated encryption such as AES-GCM or ChaCha20-Poly1305.
   - **CRIT-301:** swallowed exceptions, including empty catches or generic handling that silently continues; distinguish intentional handling from lost failures.
   - **CRIT-302:** raw exception details exposed to users; check for stack traces, database details, or unfiltered error messages.
   - **CRIT-303:** logs containing request bodies, user objects, or sensitive values; recommend masking and narrow structured logging.
4. Use the advanced model role for architectural risks and multi-step attack paths. Review applicable changes for:
   - **ARCH-401:** implicit trust in internal requests, services, or message queues without authentication, authorization, or validation.
   - **ARCH-402:** IDOR/BOLA or access decisions based on user-provided IDs without verifying the authenticated principal's rights.
   - **ARCH-403:** over-privileged service accounts, integrations, or infrastructure permissions.
   - **ARCH-404:** fail-open authorization or validation where errors, timeouts, or missing permissions permit execution.
   - Perimeter-only security with unprotected internal boundaries; centralized or monolithic authorization that leaves paths unchecked; server-memory sessions incompatible with distributed deployment; blocking identity-provider calls on every internal request; and multiple service contexts sharing database tables.
5. Keep related-code inspection narrow. Start with changed lines and their immediate context. Open another file only when it is directly linked to a concrete question raised by a change, such as the matching controller, validator, authorization middleware, schema, or direct caller/callee. Use `scope.maxRelatedFiles` and `scope.maxRelationshipHops` as defaults, and exceed them only when necessary to resolve a specific security question. State why any additional file was needed. Do not search unrelated modules, perform repository-wide audits, or infer missing behavior as fact.
6. Verify candidates against nearby mitigations and execution paths. Report only claims supported by the changed code and the limited related context. If relevant context is unavailable, say so and keep the concern in Suspicious rather than asserting exploitability.
7. Report using exactly these sections, in this order:

   ### 🔴 High Risk
   Findings with strong evidence of a real security issue and a credible path to impact.

   ### 🟡 Suspicious
   Plausible risky logic or patterns that are not proven vulnerabilities. Be liberal here and explain uncertainty.

   ### 🟢 Clean
   Specific changed areas reviewed that appear to follow sound security practices in the available context. Do not imply exhaustive coverage.

For each finding, include the rule ID when applicable, file and line, concise evidence, impact, and a concrete remediation. Avoid duplicating the same issue in multiple sections. If a section has no entries, write `None found.` In Clean, list only areas actually reviewed; if none can be responsibly identified, write `No specific areas to report.`

## Script Usage

Run from the repository root:

```sh
node "Review Tools/security-auditor/scripts/collect-diff.mjs" [base-ref] \
  | node "Review Tools/security-auditor/scripts/scan-patterns.mjs"
```

The collector defaults to `HEAD`; pass a target ref such as `origin/main` for a PR review. It includes tracked changes relative to that ref and untracked, non-ignored text files. Binary files and untracked files over the configured collection limit are skipped. The scanner reads JSON from standard input and prints JSON candidates to standard output. It reports locations and rule IDs, not verdicts.