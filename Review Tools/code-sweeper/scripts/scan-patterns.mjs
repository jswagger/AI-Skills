#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createFileFilters } from '../../review-tools-common/file-filters.mjs';
import { findLongJsFunctions } from './function-length.mjs';

const configPath = new URL('../config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { isExcluded, isTestFile } = createFileFilters(config.scan);
const thresholds = config.scan?.thresholds ?? {};
const scannerArgs = process.argv.slice(2);
if (scannerArgs.some((argument) => !['--no-fix', '--dry-run', 'dry-run'].includes(argument))) {
  process.stderr.write('Usage: scan-patterns.mjs [--no-fix|--dry-run]\n');
  process.exit(1);
}
const autoFixEnabled = config.autoFix?.enabled === true
  && !scannerArgs.some((argument) => ['--no-fix', '--dry-run', 'dry-run'].includes(argument));

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
const addedLineCount = report.files.reduce((count, file) => count
  + (file.changes ?? []).filter((change) => change.side === 'added').length, 0);
const fileCount = report.files.length;
const sizeSummary = `${addedLineCount.toLocaleString()} added lines across `
  + `${fileCount.toLocaleString()} ${fileCount === 1 ? 'file' : 'files'}`;
const largeDiffNote = addedLineCount >= 10000 ? '; large diffs may yield thousands of candidates' : '';
process.stderr.write(
  `Code Sweeper: scanning ${sizeSummary}${largeDiffNote}. `
    + 'Pass a base ref or adjust scan.exclude to scope the review.\n',
);
process.stderr.write(`Code Sweeper: auto-fix ${autoFixEnabled ? 'enabled' : 'disabled'}.\n`);

const sourceCache = new Map();
function getSourceLines(file) {
  if (sourceCache.has(file.path)) return sourceCache.get(file.path);
  let lines;
  try {
    lines = readFileSync(file.path, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  sourceCache.set(file.path, lines);
  return lines;
}

function braceDelta(line) {
  const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '')
    .replace(/\/\/.*$/, '');
  return (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
}

function findEnclosingFunction(file, lineNumber) {
  const lines = getSourceLines(file);
  const addedLines = new Set((file.changes ?? [])
    .filter((change) => change.side === 'added')
    .map((change) => change.line));
  let best;
  for (let index = 0; index < lines.length && index + 1 <= lineNumber; index += 1) {
    const line = lines[index];
    const python = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (python) {
      let endIndex = lines.length;
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        const next = lines[nextIndex];
        if (!next.trim() || next.trimStart().startsWith('#')) continue;
        if (next.length - next.trimStart().length <= python[1].length) {
          endIndex = nextIndex;
          break;
        }
      }
      if (lineNumber <= endIndex) {
        best = { name: python[2], change: addedLines.has(index + 1) ? 'new' : 'existing' };
      }
      continue;
    }

    const declaration = line.match(/\bfunction\s*\*?\s*([$\w]+)?\s*\(|\b(?:const|let|var)\s+([$\w]+)\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[$\w]+)\s*=>)/);
    if (!declaration) continue;
    let openIndex = index;
    while (openIndex < lines.length && openIndex <= index + 8 && !lines[openIndex].includes('{')) openIndex += 1;
    if (openIndex >= lines.length || openIndex > index + 8) continue;
    let depth = 0;
    let endIndex = openIndex;
    for (; endIndex < lines.length; endIndex += 1) {
      depth += braceDelta(lines[endIndex]);
      if (depth <= 0 && endIndex >= openIndex) break;
    }
    if (lineNumber <= endIndex + 1) {
      best = {
        name: declaration[1] ?? declaration[2] ?? '<anonymous>',
        change: addedLines.has(index + 1) ? 'new' : 'existing',
      };
    }
  }
  return best;
}

function addCandidate(candidate) {
  const context = findEnclosingFunction(
    report.files.find((file) => file.path === candidate.path),
    candidate.line,
  );
  candidates.push({
    ...candidate,
    enclosingFunction: context?.name ?? null,
    enclosingFunctionChange: context?.change ?? 'unknown',
  });
}

function declaredFunctions(file) {
  const names = new Set();
  for (const change of file.changes ?? []) {
    if (change.side !== 'added') continue;
    const text = change.text;
    for (const match of text.matchAll(/\bfunction\s*\*?\s+([$\w]+)\s*\(|\b(?:const|let|var)\s+([$\w]+)\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[$\w]+)\s*=>)/g)) {
      names.add(match[1] ?? match[2]);
    }
  }
  return names;
}

function callsNewHelper(text, names) {
  return [...names].some((name) => new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\s*\\(`).test(text));
}

function genericArguments(line) {
  const generics = [];
  const expression = /\b[$\w]+\s*<([^<>]*(?:<[^<>]*>[^<>]*)*)>/g;
  for (const match of line.matchAll(expression)) {
    const argumentsList = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < match[1].length; index += 1) {
      if (match[1][index] === '<') depth += 1;
      if (match[1][index] === '>') depth -= 1;
      if (match[1][index] === ',' && depth === 0) {
        argumentsList.push(match[1].slice(start, index).trim());
        start = index + 1;
      }
    }
    argumentsList.push(match[1].slice(start).trim());
    generics.push({ name: match[0].split('<')[0].trim(), arguments: argumentsList });
  }
  return generics;
}

function weakensTypeArgument(file, addedLine) {
  const addedGenerics = genericArguments(addedLine);
  const removedLines = (file.changes ?? [])
    .filter((change) => change.side === 'removed')
    .map((change) => change.text);
  return addedGenerics.some((added) => added.arguments.some((argument, index) => {
    if (argument !== 'any') return false;
    return removedLines.some((removedLine) => genericArguments(removedLine).some((removed) => (
      removed.name === added.name
      && removed.arguments[index] !== undefined
      && removed.arguments[index] !== 'any'
    )));
  }));
}

function testBlocks(file) {
  const lines = getSourceLines(file);
  const addedLines = new Set((file.changes ?? [])
    .filter((change) => change.side === 'added')
    .map((change) => change.line));
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\b(?:it|test)\s*\(/.test(lines[index])) continue;
    let openLine = index;
    while (openLine < lines.length && openLine <= index + 8 && !lines[openLine].includes('{')) openLine += 1;
    if (openLine >= lines.length || openLine > index + 8) continue;
    let depth = 0;
    let endIndex = openLine;
    for (; endIndex < lines.length; endIndex += 1) {
      depth += braceDelta(lines[endIndex]);
      if (depth <= 0 && endIndex >= openLine) break;
    }
    if (addedLines.has(index + 1) || [...addedLines].some((added) => added > index + 1 && added <= endIndex + 1)) {
      blocks.push({ startLine: index + 1, endLine: endIndex + 1, text: lines.slice(openLine, endIndex + 1).join('\n') });
    }
  }
  return blocks;
}

function normalizeTestBody(text) {
  const callbackStart = text.indexOf('=>');
  const body = callbackStart >= 0 ? text.slice(callbackStart + 2) : text;
  const normalized = body.replace(/\/\/.*$/gm, '')
    .replace(/\s+as\s+any\b/g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '#')
    .replace(/\b\d+(?:\.\d+)?\b/g, '#');
  const variables = new Map();
  for (const match of normalized.matchAll(/\b(?:const|let|var)\s+([$\w]+)/g)) {
    if (!variables.has(match[1])) variables.set(match[1], `$v${variables.size}`);
  }
  let result = normalized;
  for (const [name, replacement] of variables) {
    result = result.replace(new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`, 'g'), replacement);
  }
  return result.replace(/\s+/g, ' ').trim();
}

function onlyTrivialAssertions(text) {
  const expectations = [...text.matchAll(/\bexpect\s*\(/g)].length;
  if (!expectations) return false;
  const trivial = [...text.matchAll(/expect\s*\(\s*(?:typeof\s+[^)]+|[^)]+)\)\s*\.\s*(?:toBe\s*\(\s*['"]function['"]\s*\)|toBeDefined\s*\(\s*\))/g)].length;
  return expectations === trivial;
}

function addTestCandidates(file) {
  const blocks = testBlocks(file);
  for (const block of blocks) {
    if (onlyTrivialAssertions(block.text)) {
      addCandidate({
        ruleId: 'SWEEP-108',
        severity: 'dusty',
        path: file.path,
        line: block.startLine,
        description: 'Test only checks that a value exists or is a function; assert observable behavior instead',
        evidence: block.text.trim().slice(0, 240),
      });
    }
  }

  const normalizedTests = new Map();
  for (const block of blocks) {
    const normalized = normalizeTestBody(block.text);
    const matches = normalizedTests.get(normalized) ?? [];
    matches.push(block);
    normalizedTests.set(normalized, matches);
  }
  for (const matches of normalizedTests.values()) {
    if (matches.length < 2) continue;
    const tableDriven = matches.length >= 3;
    addCandidate({
      ruleId: 'SWEEP-110',
      severity: 'dusty',
      path: file.path,
      line: matches[0].startLine,
      occurrenceCount: matches.length,
      description: tableDriven
        ? `${matches.length} sibling tests have near-identical bodies; consider a table-driven test`
        : 'Sibling tests repeat the same arrange/act/assert shape and assertions',
      evidence: matches[0].text.trim().slice(0, 240),
    });
  }

  const lines = getSourceLines(file);
  const source = lines.join('\n');
  const addedLines = new Set((file.changes ?? [])
    .filter((change) => change.side === 'added')
    .map((change) => change.line));
  const fixtures = new Map();
  const literalPattern = /\b(?:const|let|var)\s+[$\w]+\s*=\s*\{/g;
  for (const match of source.matchAll(literalPattern)) {
    const openBrace = source.indexOf('{', match.index);
    let depth = 0;
    let end = openBrace;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      if (source[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    const literal = source.slice(openBrace, end + 1);
    const suffix = source.slice(end + 1, source.indexOf('\n', end) < 0 ? source.length : source.indexOf('\n', end));
    if (!/\bas\s+any\b/.test(literal + suffix)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    const lastLine = source.slice(0, end + 1).split('\n').length;
    if (![...addedLines].some((added) => added >= line && added <= lastLine)) continue;
    const normalized = literal.replace(/\s+/g, ' ').trim();
    const occurrences = fixtures.get(normalized) ?? [];
    occurrences.push({ line, evidence: literal });
    fixtures.set(normalized, occurrences);
  }
  for (const occurrences of fixtures.values()) {
    if (occurrences.length < 2) continue;
    addCandidate({
      ruleId: 'SWEEP-109',
      severity: 'dusty',
      path: file.path,
      line: occurrences[0].line,
      occurrenceCount: occurrences.length,
      description: `Same object-literal any fixture appears ${occurrences.length} times in this test file`,
      evidence: occurrences[0].evidence.trim().slice(0, 240),
    });
  }
}

function addJsFunctionCandidates(file) {
  const addedLines = new Set((file.changes ?? [])
    .filter((change) => change.side === 'added')
    .map((change) => change.line));
  const limit = thresholds.maxFunctionLines ?? 50;
  for (const fn of findLongJsFunctions(getSourceLines(file), addedLines, limit)) {
    addCandidate({
      ruleId: 'SWEEP-112',
      severity: 'dusty',
      path: file.path,
      line: fn.line,
      description: `JS/TS function ${fn.name} has ${fn.bodyLines} nonblank body lines; consider splitting focused responsibilities`,
      evidence: fn.signature.slice(0, 240),
    });
  }
}

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
      addCandidate({
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

function isDuplicateNoise(text) {
  return /^await\s+waitFor\b/.test(text)
    || /^\}\);$/.test(text)
    || /^[{}]+$/.test(text)
    || /^(?:[$\w]+|'[^']+'|"[^"]+")\s*:\s*.+,$/.test(text);
}

function isYieldIdiom(text) {
  return /^yield\s+(?:put|call)\s*\(/.test(text);
}

for (const file of report.files) {
  if (isExcluded(file.path)) continue;
  const testFile = isTestFile(file.path);
  const added = (file.changes ?? []).filter((change) => change.side === 'added');
  if (testFile && added.length > 0) {
    changedTests.push({ path: file.path, addedLines: added.length });
  }
  addPythonFunctionCandidates(file);

  if (/\.(?:[cm]?[jt]sx?)$/i.test(file.path)) {
    addJsFunctionCandidates(file);
    for (const change of added) {
      const text = change.text.trim();
      if (commentPattern.test(change.text)) continue;
      const anyType = /\bas\s+any\b|:\s*any\b|<\s*any\b|,\s*any\s*[>,]/.test(text);
      const assertion = /\bas\s+[A-Za-z_$][\w$.[\]<>|&?]*/.test(text);
      if (!anyType && !assertion) continue;
      const typeLoosening = anyType && weakensTypeArgument(file, change.text);
      addCandidate({
        ruleId: 'SWEEP-107',
        severity: 'dusty',
        path: file.path,
        line: change.line,
        ...(typeLoosening ? { signal: 'specific-type-replaced-with-any' } : {}),
        ...(!anyType && assertion ? { signal: 'type-assertion', priority: 'lower' } : {}),
        description: typeLoosening
          ? 'Changed a specific generic type argument to any, weakening type safety'
          : anyType
          ? 'Added JS/TS code uses any; prefer a specific type when practical'
          : 'Type assertion may conceal a type mismatch; prefer narrowing or validation where practical',
        evidence: text.slice(0, 240),
      });
    }
  }

  for (const change of added) {
    const text = change.text.trim();
    if (!text) continue;

    const testTitleLine = testFile && /\b(?:it|test|describe)\s*\(\s*['"`]/.test(change.text);
    if (!testTitleLine && change.text.length > (thresholds.maxLineLength ?? 120)) {
      addCandidate({
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
      addCandidate({
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
      addCandidate({
        ruleId: 'SWEEP-103',
        severity: 'dusty',
        path: file.path,
        line: change.line,
        description: 'Many boolean operators on one line may obscure decision logic',
        evidence: text.slice(0, 240),
      });
    }

    if (commentPattern.test(change.text) && change.text.length > (thresholds.maxCommentLength ?? 160)) {
      addCandidate({
        ruleId: 'SWEEP-104',
        severity: 'dusty',
        path: file.path,
        line: change.line,
        description: 'Long added comment may be worth tightening while preserving useful rationale',
        evidence: text.slice(0, 240),
      });
    }

  }

  if (testFile && added.length > 0) addTestCandidates(file);

  const addedCount = added.length;
  const removedCount = (file.changes ?? []).filter((change) => change.side === 'removed').length;
  const sourceLines = getSourceLines(file);
  const fileLineLimit = thresholds.maxFileLines ?? 500;
  if (/\.(?:[cm]?[jt]sx?|py|java|cs|go|rs|rb|php)$/i.test(file.path)
    && sourceLines.length > fileLineLimit
    && addedCount > removedCount) {
    addCandidate({
      ruleId: 'SWEEP-111',
      severity: 'dusty',
      path: file.path,
      line: added[0]?.line ?? 1,
      description: `File has ${sourceLines.length} lines, exceeds the ${fileLineLimit}-line review threshold, and grew in this diff`,
      evidence: `${sourceLines.length} total lines; ${addedCount} added and ${removedCount} removed`,
    });
  }
}

for (const file of report.files) {
  if (isExcluded(file.path)) continue;
  const added = (file.changes ?? []).filter((change) => change.side === 'added');
  if (isTestFile(file.path)) continue;
  const lineOccurrences = new Map();
  const repeatedBlocks = new Map();
  const helperNames = declaredFunctions(file);
  const runs = [];
  let run = [];

  function finishRun() {
    if (run.length > 0) runs.push(run);
    run = [];
  }

  for (const change of added) {
    const text = change.text.replace(/\s+/g, ' ').trim();
    const eligible = text.length > 0
      && !commentPattern.test(change.text)
      && !isRepeatedBoilerplate(text)
      && !isDuplicateNoise(text);

    if (!eligible) {
      finishRun();
      continue;
    }

    if (run.length > 0 && change.line !== run.at(-1).change.line + 1) finishRun();
    run.push({ change, text });

    if (text.length > 40
      && !isYieldIdiom(text)
      && !callsNewHelper(text, helperNames)) {
      const locations = lineOccurrences.get(text) ?? [];
      locations.push(change.line);
      lineOccurrences.set(text, locations);
    }
  }
  finishRun();

  const triples = new Map();
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    for (let index = 0; index <= runs[runIndex].length - 3; index += 1) {
      const key = JSON.stringify(runs[runIndex].slice(index, index + 3).map((entry) => entry.text));
      const starts = triples.get(key) ?? [];
      starts.push({ runIndex, index });
      triples.set(key, starts);
    }
  }

  for (const starts of triples.values()) {
    for (let startIndex = 0; startIndex < starts.length; startIndex += 1) {
      const first = starts[startIndex];
      for (let otherIndex = startIndex + 1; otherIndex < starts.length; otherIndex += 1) {
        const second = starts[otherIndex];
        if (first.runIndex === second.runIndex && second.index < first.index + 3) continue;
        const firstRun = runs[first.runIndex];
        const secondRun = runs[second.runIndex];
        let length = 3;
        while (first.index + length < firstRun.length
          && second.index + length < secondRun.length
          && firstRun[first.index + length].text === secondRun[second.index + length].text) {
          length += 1;
        }
        const sequence = firstRun.slice(first.index, first.index + length).map((entry) => entry.text);
        const key = JSON.stringify(sequence);
        const block = repeatedBlocks.get(key) ?? { sequence, starts: [] };
        block.starts.push(first, second);
        repeatedBlocks.set(key, block);
      }
    }
  }

  const selectedBlocks = [];
  const coveredRanges = new Map();
  const orderedBlocks = [...repeatedBlocks.values()]
    .sort((first, second) => second.sequence.length - first.sequence.length);
  for (const block of orderedBlocks) {
    const uniqueStarts = [...new Map(block.starts.map((start) => [
      `${start.runIndex}:${start.index}`,
      start,
    ])).values()].sort((first, second) => (
      runs[first.runIndex][first.index].change.line - runs[second.runIndex][second.index].change.line
    ));
    const occurrences = [];
    for (const start of uniqueStarts) {
      const priorEnd = occurrences
        .filter((occurrence) => occurrence.runIndex === start.runIndex)
        .reduce((end, occurrence) => Math.max(end, occurrence.index + block.sequence.length), -1);
      if (start.index < priorEnd) continue;
      occurrences.push(start);
    }
    if (occurrences.length < 2) continue;
    const allCovered = occurrences.every((start) => (coveredRanges.get(start.runIndex) ?? [])
      .some((range) => start.index >= range.start && start.index + block.sequence.length <= range.end));
    if (allCovered
      || block.sequence.every(isYieldIdiom)
      || block.sequence.some((text) => callsNewHelper(text, helperNames))) continue;

    const first = occurrences[0];
    selectedBlocks.push({
      line: runs[first.runIndex][first.index].change.line,
      blockLength: block.sequence.length,
      occurrenceCount: occurrences.length,
      evidence: block.sequence[0],
    });
    for (const occurrence of occurrences) {
      const ranges = coveredRanges.get(occurrence.runIndex) ?? [];
      ranges.push({ start: occurrence.index, end: occurrence.index + block.sequence.length });
      coveredRanges.set(occurrence.runIndex, ranges);
    }
  }

  for (const [text, locations] of lineOccurrences) {
    const uncovered = locations.filter((line) => !runs.some((currentRun, runIndex) => (
      currentRun.some((entry, index) => entry.change.line === line
        && (coveredRanges.get(runIndex) ?? []).some((range) => index >= range.start && index < range.end))
    )));
    if (uncovered.length < 2) continue;
    addCandidate({
      ruleId: 'SWEEP-105',
      severity: 'dusty',
      path: file.path,
      line: uncovered[0],
      occurrenceCount: uncovered.length,
      description: `Same added statement appears ${uncovered.length} times in this file; check whether the logic should be shared`,
      evidence: text.slice(0, 240),
    });
  }

  for (const block of selectedBlocks) {
    addCandidate({
      ruleId: 'SWEEP-105',
      severity: 'dusty',
      path: file.path,
      line: block.line,
      blockLength: block.blockLength,
      occurrenceCount: block.occurrenceCount,
      description: `Repeated ${block.blockLength}-line block appears ${block.occurrenceCount} times; check whether the logic should be shared`,
      evidence: block.evidence.slice(0, 240),
    });
  }
}

process.stdout.write(`${JSON.stringify({
  candidates,
  changedTests,
  skipped: report.skipped ?? [],
  baseRef: report.baseRef,
  requestedBaseRef: report.requestedBaseRef,
  comparisonBase: report.comparisonBase,
  baseCommitHash: report.baseCommitHash,
  baseCommitDate: report.baseCommitDate,
  excludedCount: report.excludedCount ?? 0,
  autoFixEnabled,
  note: 'Heuristic candidates only; verify context, behavior, and existing reuse opportunities before reporting or changing code.',
}, null, 2)}\n`);
process.stderr.write(`Code Sweeper: found ${candidates.length.toLocaleString()} candidates from ${sizeSummary}.\n`);
