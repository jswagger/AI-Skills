#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createFileFilters } from '../../review-tools-common/file-filters.mjs';

const configPath = new URL('../config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { isExcluded, isTestFile } = createFileFilters(config.scan);
const thresholds = config.scan?.thresholds ?? {};

const input = await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

let report;
try {
  report = JSON.parse(input);
  if (!report || !Array.isArray(report.files)) {
    throw new Error('Expected a JSON object with a files array.');
  }
} catch (error) {
  process.stderr.write(`Invalid diff JSON: ${error.message}\n`);
  process.exit(1);
}

const candidates = [];
const changedTests = [];
const commentPattern = /^\s*(?:\/\/|\/\*+|\*|#)/;

function addPythonFunctionCandidates(file) {
  if (!file.path.endsWith('.py')) return;

  let sourceLines;
  try {
    sourceLines = readFileSync(file.path, 'utf8').split(/\r?\n/);
  } catch {
    return;
  }

  const addedLines = new Set((file.changes ?? [])
    .filter((change) => change.side === 'added')
    .map((change) => change.line));

  for (let index = 0; index < sourceLines.length; index += 1) {
    const definition = sourceLines[index].match(/^(\s*)(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/);
    if (!definition) continue;

    const indentation = definition[1].length;
    let endIndex = sourceLines.length;
    for (let nextIndex = index + 1; nextIndex < sourceLines.length; nextIndex += 1) {
      const line = sourceLines[nextIndex];
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const lineIndentation = line.length - line.trimStart().length;
      if (lineIndentation <= indentation) {
        endIndex = nextIndex;
        break;
      }
    }

    const bodyLines = sourceLines.slice(index + 1, endIndex)
      .filter((line) => line.trim() && !line.trimStart().startsWith('#'));
    const changedFunction = [...addedLines].some((line) => line > index && line <= endIndex);
    if (changedFunction && bodyLines.length > (thresholds.maxFunctionLines ?? 50)) {
      candidates.push({
        ruleId: 'SWEEP-106',
        severity: 'dusty',
        path: file.path,
        line: index + 1,
        description: `Python function has ${bodyLines.length} nonblank body lines; consider splitting focused responsibilities`,
        evidence: sourceLines[index].trim().slice(0, 240),
      });
    }
  }
}

function isRepeatedBoilerplate(text) {
  return /^(?:import\b|from\s+\S+\s+import\b)/.test(text)
    || /^except\s+(?:Exception|BaseException)\b/.test(text)
    || /^if\s+__name__\s*==\s*["']__main__["']\s*:/.test(text)
    || /^(?:[\w$]+\.)?(?:sut|subject_under_test)\s*=/i.test(text);
}

for (const file of report.files) {
  if (isExcluded(file.path)) continue;
  const testFile = isTestFile(file.path);
  const added = (file.changes ?? []).filter((change) => change.side === 'added');
  if (testFile && added.length > 0) {
    changedTests.push({ path: file.path, addedLines: added.length });
  }
  addPythonFunctionCandidates(file);

  for (const change of added) {
    const text = change.text.trim();
    if (!text) continue;

    if (change.text.length > (thresholds.maxLineLength ?? 120)) {
      candidates.push({
        ruleId: 'SWEEP-101',
        severity: 'dusty',
        path: file.path,
        line: change.line,
        description: 'Long added line may hide multiple operations or be difficult to scan',
        evidence: text.slice(0, 240),
      });
    }

    const nestedConditional = ((text.match(/\?/g) ?? []).length >= 2 && /\?[^:]+:[^;]+\?/.test(text))
      || (/\bif\b.*\belse\b.*\bif\b/.test(text) && file.path.endsWith('.py'));
    if (nestedConditional) {
      candidates.push({
        ruleId: 'SWEEP-102',
        severity: 'dusty',
        path: file.path,
        line: change.line,
        description: 'Nested conditional expression may be difficult to read',
        evidence: text.slice(0, 240),
      });
    }

    const booleanOperators = commentPattern.test(change.text)
      ? []
      : text.match(/&&|\|\||\b(?:and|or)\b/g) ?? [];
    if (booleanOperators.length > (thresholds.maxBooleanOperators ?? 3)) {
      candidates.push({
        ruleId: 'SWEEP-103',
        severity: 'dusty',
        path: file.path,
        line: change.line,
        description: 'Many boolean operators on one line may obscure decision logic',
        evidence: text.slice(0, 240),
      });
    }

    if (commentPattern.test(change.text) && change.text.length > (thresholds.maxCommentLength ?? 160)) {
      candidates.push({
        ruleId: 'SWEEP-104',
        severity: 'dusty',
        path: file.path,
        line: change.line,
        description: 'Long added comment may be worth tightening while preserving useful rationale',
        evidence: text.slice(0, 240),
      });
    }
  }
}

for (const file of report.files) {
  if (isExcluded(file.path)) continue;
  const occurrences = new Map();
  for (const change of file.changes ?? []) {
    if (change.side !== 'added') continue;
    const text = change.text.replace(/\s+/g, ' ').trim();
    if (text.length < 12 || commentPattern.test(change.text) || isRepeatedBoilerplate(text)) continue;
    const locations = occurrences.get(text) ?? [];
    locations.push(change.line);
    occurrences.set(text, locations);
  }

  for (const [text, locations] of occurrences) {
    if (locations.length < 2) continue;
    for (const line of locations) {
      candidates.push({
        ruleId: 'SWEEP-105',
        severity: 'dusty',
        path: file.path,
        line,
        description: `Same added statement appears ${locations.length} times in this file; check whether the logic should be shared`,
        evidence: text.slice(0, 240),
      });
    }
  }
}

process.stdout.write(`${JSON.stringify({
  candidates,
  changedTests,
  skipped: report.skipped ?? [],
  note: 'Heuristic candidates only; verify context, behavior, and existing reuse opportunities before reporting or changing code.',
}, null, 2)}\n`);
