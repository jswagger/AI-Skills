---
name: security-auditor
description: 'Review code changes and pull request diffs for security vulnerabilities, insecure patterns, authorization gaps, and architectural risks. Use before creating or reviewing a pull request.'
argument-hint: 'Optional base ref, such as origin/main'
---

# Security Auditor

Review additions and revisions for security vulnerabilities and risky patterns. Use the shared review-tool helper to collect diff evidence and the bundled scanner to flag repeatable patterns; verify every candidate in context before reporting it. This is a focused code review, not a guarantee that the code is secure.

## Configuration

Read [config.json](./config.json) before starting. `models.basic` and `models.advanced` are preferred model selectors (`haiku` and `sonnet` by default), not claims about a specific model version. When model-selectable subagents are available, use them for their respective passes. Give each the collected diff JSON and scanner candidate JSON; do not ask them to recollect the diff. If model selection or subagents are unavailable, perform both passes with the available agent and do not claim a model switch.

`scan.exclude` patterns are omitted by collection and scanning. `scan.testFiles.mode` may be `skip` or `lower-confidence`; test-path matches are lower-confidence by default. The scanner detects changed source-file languages from their extensions and applies language-specific heuristics only to matching files; check `coverage.detectedLanguages` before interpreting its candidates. Choose `scan.projectStack` for the target repository as a separate architectural hint: use `backend` for server/API/data services, `frontend` for UI-only projects, `full-stack` when both are present, and `unknown` only when the repository role cannot be determined. The default is `backend`. In a frontend repository, lower-priority crypto and broad-permission candidates should be assessed in context, not discarded: raise their priority when the changed code actually implements cryptography, server-side authorization, or service-account permissions.

## Procedure

1. Determine the comparison base. Use the provided argument when present; otherwise use `diff.baseRef` from the config. Collect the change set with [collect-diff.mjs](../review-tools-common/collect-diff.mjs), passing this skill's config path. For any base other than `HEAD`, the collector resolves `git merge-base <base> HEAD` before diffing, while retaining working-tree and untracked changes. Include untracked, non-ignored files.
2. Run [scan-patterns.mjs](./scripts/scan-patterns.mjs) on the collector's JSON output. Treat its output as candidate locations, not confirmed findings. Keep both JSON outputs as the shared review input; delegated passes must use them rather than collecting again. The scanner checks added lines and emits `REG-401` candidates for removed lines containing security-control terms. The scripts use Node.js built-ins and do not need third-party dependencies.
3. Use the basic model role for common implementation risks. Review the changed code for:
   - **CRIT-101:** dynamic string construction in database queries, OS commands, or HTML rendering, including Python SQL f-strings and C# SQL near `SqlCommand` or `Query`; prefer parameterized queries and safe APIs. Treat SQL candidates as contextual, lower-confidence leads: placeholders and fixed SQL fragments may be safe when values are passed separately to the driver. C# LINQ `.Select(...)` projections are not SQL sinks by themselves.
   - **CRIT-102:** blacklist-based input validation; prefer explicit allowlists, exact types, or enums.
   - **CRIT-103:** validation added only on the client; check the directly corresponding API/controller for server-side enforcement.
   - **CRIT-201:** hard-coded credentials or secrets, including quoted dictionary keys, fallback literals, and credentials embedded in connection URLs. Recommend environment configuration or a secrets manager. Never reproduce a secret value in the report; scanner evidence is redacted.
   - **CRIT-104:** shell execution through `subprocess` with `shell=True` or `os.system`; prefer argument arrays and safe process APIs.
   - **CRIT-105:** dynamic evaluation through `eval` or `exec`; remove it or constrain inputs with a safe parser.
   - **CRIT-106:** potentially unsafe `pickle` or `yaml.load` deserialization; only deserialize trusted data and use `SafeLoader` for YAML.
   - **CRIT-107:** disabled TLS certificate verification such as `verify=False`; restore verification and configure trusted certificates.
   - **CRIT-108 (C#):** `BinaryFormatter`; replace it with a safe, constrained serializer.
   - **CRIT-109 (C#):** `TypeNameHandling.All`; avoid unrestricted polymorphic deserialization and use an explicit type allowlist if polymorphism is required.
   - **CRIT-110 (C#):** `[AllowAnonymous]`; verify the endpoint is intentionally public and has appropriate abuse protections.
   - **CRIT-111 (C#):** `ServerCertificateValidationCallback`; ensure certificate validation is not bypassed and hostname/chain checks remain enabled.
   - **CRIT-112 (C#):** `Process.Start`; validate executable and arguments, avoid shell interpretation, and constrain untrusted input.
   - **CRIT-202:** homegrown cryptography or predictable randomness used for security tokens or identifiers, including `random.choice` and `uuid.uuid1`; recommend standard crypto libraries and a CSPRNG.
   - **CRIT-203:** encryption without integrity protection, including CBC-mode use without a separate integrity control; prefer authenticated encryption such as AES-GCM or ChaCha20-Poly1305.
   - **CRIT-301:** swallowed exceptions, including Python `except` blocks whose next statement is `pass`; distinguish intentional handling from lost failures.
   - **CRIT-302:** raw exception details exposed to users, including Python `str(exc)` in responses; check for stack traces, database details, or unfiltered error messages.
   - **CRIT-303:** logs containing request bodies, user objects, or sensitive values, including Python `logging` calls; recommend masking and narrow structured logging.

When supported, delegate this pass using a subagent's model selector set to `models.basic`, and include the complete collected diff JSON, scanner candidates, and the rule list above in its prompt. The pass can use the supplied evidence directly and must not rerun collection.
4. Use the advanced model role for architectural risks and multi-step attack paths. Review applicable changes for:
   - **ARCH-401:** implicit trust in internal requests, services, or message queues without authentication, authorization, or validation.
   - **ARCH-402:** IDOR/BOLA or access decisions based on user-provided IDs without verifying the authenticated principal's rights.
   - **ARCH-403:** over-privileged service accounts, integrations, or infrastructure permissions.
   - **ARCH-404:** fail-open authorization or validation where errors, timeouts, or missing permissions permit execution.
   - **ARCH-405:** infrastructure ingress open to all IPv4 or IPv6 addresses.
   - **ARCH-406:** public cloud storage or resources.
   - **ARCH-407:** privileged containers, privilege escalation, or root workloads.
   - **ARCH-408:** infrastructure encryption disabled at rest.
   - Perimeter-only security with unprotected internal boundaries; centralized or monolithic authorization that leaves paths unchecked; server-memory sessions incompatible with distributed deployment; blocking identity-provider calls on every internal request; and multiple service contexts sharing database tables.
   - Use `scan.projectStack` as a relevance hint. Do not let a frontend setting suppress a concrete server-side or cryptographic risk present in the changed code.
   - Review IaC and deployment changes such as Terraform, Kubernetes, Docker, Helm, and workflow files; scanner infrastructure matches are prompts, not proof of exposure.

When supported, delegate this pass using a subagent's model selector set to `models.advanced`, with the same collected diff JSON and candidate JSON. Focus on attack paths and infrastructure context; do not recollect the diff.
5. Keep related-code inspection narrow. Start with changed lines and their immediate context. Open another file only when it is directly linked to a concrete question raised by a change, such as the matching controller, validator, authorization middleware, schema, or direct caller/callee. Use `scope.maxRelatedFiles` and `scope.maxRelationshipHops` as defaults, and exceed them only when necessary to resolve a specific security question. State why any additional file was needed. Do not search unrelated modules, perform repository-wide audits, or infer missing behavior as fact.
6. Verify candidates against nearby mitigations and execution paths. Report only claims supported by the changed code and the limited related context. Review `coverage` metadata in scanner output; Python and infrastructure rules are targeted heuristics, and no candidates is not evidence of safety. Treat `REG-401` removed-control matches as Suspicious until confirming the control was replaced or intentionally removed. If relevant context is unavailable, say so and keep the concern in Suspicious rather than asserting exploitability.
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
node "Review Tools/review-tools-common/collect-diff.mjs" --config "Review Tools/security-auditor/config.json" [base-ref] | node "Review Tools/security-auditor/scripts/scan-patterns.mjs"
```

The collector defaults to `diff.baseRef` in the supplied config, or `HEAD` when unset. This config uses `origin/HEAD` and falls back to `HEAD` when that remote-tracking ref is unavailable. With `HEAD`, it compares the working tree to `HEAD`; with another ref, it compares the working tree to `git merge-base <ref> HEAD`, excluding target-only commits while retaining feature-branch and local changes. It also includes untracked, non-ignored text files. Binary files and untracked files over the configured collection limit are skipped. The scanner reads JSON from standard input and prints JSON candidates to standard output. It reports locations and rule IDs, not verdicts.