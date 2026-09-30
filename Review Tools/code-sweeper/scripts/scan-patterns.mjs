#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createFileFilters } from './file-filters.mjs';

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
const addedLines = [];
const commentPattern = /^\s*(?:\/\/|\/\*+|\*|#)/;

for (const file of report.files) {
  if (isExcluded(file.path)) continue;
  const testFile = isTestFile(file.path);
  const added = (file.changes ?? []).filter((change) => change.side === 'added');
  if (testFile && added.length > 0) {
    changedTests.push({ path: file.path, addedLines: added.length });
  }

  for (const change of added) {
    const text = change.text.trim();
    if (!text) continue;

    addedLines.push({ path: file.path, line: change.line, text });

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

    if ((text.match(/\?/g) ?? []).length >= 2 && /\?[^:]+:[^;]+\?/.test(text)) {
      candidates.push({
        ruleId: 'SWEEP-102',
        severity: 'dusty',
        path: file.path,
        line: change.line,
        description: 'Nested conditional expression may be difficult to read',
        evidence: text.slice(0, 240),
      });
    }

    const booleanOperators = (text.match(/&&|\|\|/g) ?? []).length;
    if (booleanOperators > (thresholds.maxBooleanOperators ?? 3)) {
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

const occurrences = new Map();
for (const line of addedLines) {
  if (line.text.length < 12 || commentPattern.test(line.text)) continue;
  const normalized = line.text.replace(/\s+/g, ' ').trim();
  const locations = occurrences.get(normalized) ?? [];
  locations.push({ path: line.path, line: line.line });
  occurrences.set(normalized, locations);
}

for (const [text, locations] of occurrences) {
  if (locations.length < 2) continue;
  for (const location of locations) {
    candidates.push({
      ruleId: 'SWEEP-105',
      severity: 'dusty',
      path: location.path,
      line: location.line,
      description: `Same added statement appears ${locations.length} times in the change; check whether the logic should be shared`,
      evidence: text.slice(0, 240),
    });
  }
}

process.stdout.write(`${JSON.stringify({
  candidates,
  changedTests,
  skipped: report.skipped ?? [],
  note: 'Heuristic candidates only; verify context, behavior, and existing reuse opportunities before reporting or changing code.',
}, null, 2)}\n`);
