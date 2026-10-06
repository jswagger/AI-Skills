#!/usr/bin/env node
// Detects regression signals in a collected diff. This is not a linter: every rule is about what the
// change removed, flipped, or broke for callers, never about patterns compilers/linters already catch.
// Usage: collect-diff.mjs ... | scan-patterns.mjs [--config <path>] [--diff <file>]
//
// Output `script_findings[].confidence` is "high" (report on its own once verified) or "low"
// (a hint: only surface it if the reviewing agent confirms it in context).

import { execFileSync } from 'node:child_process';
import { createFileFilters } from '../../review-tools-common/file-filters.mjs';
import { isMain, languageForPath, loadConfig, parseArgs, readJsonInput, runCli } from './lib/common.mjs';
import { groupHunks, isTrivialHunk } from './lib/hunks.mjs';
import { analyzeHunk } from './lib/rules-regression.mjs';

const SCHEMA_VERSION = 1;
const TEST_FILE_RULES = new Set(['REMOVED_TEST_ASSERTION', 'TEST_DISABLED']);
const IGNORE_MARKER = /bug-hunter-ignore(?:\s*:\s*([A-Z_,\s]+))?/;

/** Rules suppressed by `bug-hunter-ignore[: RULE_A, RULE_B]` on an added line of the hunk. */
function ignoredRules(hunk) {
  const ignored = new Set();
  for (const line of hunk.added) {
    const match = line.text.match(IGNORE_MARKER);
    if (!match) continue;
    if (!match[1]) return 'all';
    for (const rule of match[1].split(',')) ignored.add(rule.trim());
  }
  return ignored;
}

export function scanFile(file, { isTestFile, disabledRules = new Set(), severityOverrides = {} }) {
  const language = languageForPath(file.path);
  if (!language) return { language: undefined, findings: [], hunks: 0, trivialHunks: 0, behaviorChanged: false };

  const isTest = isTestFile(file.path);
  const findings = [];
  let hunkCount = 0;
  let trivialHunks = 0;
  let behaviorChanged = false;

  for (const hunk of groupHunks(file.changes)) {
    if (isTrivialHunk(hunk)) {
      trivialHunks += 1;
      continue;
    }
    hunkCount += 1;
    if (hunk.added.length > 0) behaviorChanged = true;
    const ignored = ignoredRules(hunk);
    if (ignored === 'all') continue;
    for (const finding of analyzeHunk(hunk, { language, isTest })) {
      if (disabledRules.has(finding.rule) || ignored.has(finding.rule)) continue;
      if (isTest && !TEST_FILE_RULES.has(finding.rule)) continue;
      // Deleting a whole file only matters for the exported symbols callers may still use.
      if (file.status === 'deleted' && finding.rule !== 'SIGNATURE_CHANGED') continue;
      findings.push({
        file: file.path,
        ...finding,
        severity: severityOverrides[finding.rule] ?? finding.severity,
      });
    }
  }
  return { language, findings, hunks: hunkCount, trivialHunks, behaviorChanged };
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.side}:${finding.line}:${finding.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scanCollected(collected, config) {
  const { isTestFile } = createFileFilters(config.scan);
  const options = {
    isTestFile,
    disabledRules: new Set(config.rules.disabled),
    severityOverrides: config.rules.severityOverrides,
  };

  const languages = new Set();
  const findings = [];
  const summary = { filesScanned: 0, filesSkippedUnsupported: 0, hunksAnalyzed: 0, trivialHunksSkipped: 0 };
  let sourceFilesWithLogicChanges = 0;
  let testFilesChanged = 0;

  for (const file of collected.files ?? []) {
    const result = scanFile(file, options);
    if (!result.language) {
      summary.filesSkippedUnsupported += 1;
      continue;
    }
    languages.add(result.language);
    summary.filesScanned += 1;
    summary.hunksAnalyzed += result.hunks;
    summary.trivialHunksSkipped += result.trivialHunks;
    findings.push(...result.findings);
    if (isTestFile(file.path)) testFilesChanged += 1;
    else if (result.behaviorChanged) sourceFilesWithLogicChanges += 1;
  }

  const unique = dedupe(findings);
  const byRule = {};
  for (const finding of unique) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    repository_type: [...languages].sort(),
    comparison_base: collected.comparisonBase,
    script_findings: unique,
    summary: { ...summary, findingsByRule: byRule },
    signals: {
      sourceFilesWithLogicChanges,
      testFilesChanged,
      logicChangedWithoutTests: sourceFilesWithLogicChanges > 0 && testFilesChanged === 0,
    },
  };
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    const config = loadConfig(flags.config);
    const collected = await readJsonInput(flags);
    const report = { ...scanCollected(collected, config), commit_hash: currentCommit() };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  });
}
