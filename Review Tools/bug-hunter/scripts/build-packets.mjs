#!/usr/bin/env node
// Builds compact, risk-ranked review packets for the agent: one per cluster of nearby non-trivial
// changes, each a single line-numbered unified view (context + added + removed) with its findings
// and caller leads attached. Replaces handing the agent whole files or raw `git diff` output.
// Usage: build-packets.mjs --diff <collector.json> --scan <scan-report.json> [--callers <callers.json>]
//        [--config <path>] [--budget-bytes <n>]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFileFilters } from '../../review-tools-common/file-filters.mjs';
import { isMain, languageForPath, loadConfig, parseArgs, runCli } from './lib/common.mjs';
import { groupHunks, isTrivialHunk } from './lib/hunks.mjs';
import { parseSignature } from './lib/rules-regression.mjs';

export const MAX_HUNK_LINES = 300;
const ENCLOSING_SEARCH_LINES = 200;
const SEVERITY_WEIGHT = { HIGH: 10, MEDIUM: 6, LOW: 2 };

/** Adds new-file positions to each hunk so deletions can be placed in the working-tree file. */
function locateHunks(file) {
  let offset = 0;
  return groupHunks(file.changes).filter((hunk) => !isTrivialHunk(hunk)).map((hunk) => {
    const hasAdded = hunk.added.length > 0;
    const start = hasAdded ? hunk.added[0].line : hunk.removed[0].line + offset;
    const end = hasAdded ? hunk.added.at(-1).line : start - 1;
    offset += hunk.added.length - hunk.removed.length;
    return { ...hunk, start, end };
  });
}

/** Merges hunks whose context windows would overlap, so shared context is sent once. */
function clusterHunks(hunks, contextLines) {
  const clusters = [];
  for (const hunk of hunks) {
    const last = clusters.at(-1);
    if (last && hunk.start - last.end <= contextLines * 2 + 1) {
      last.hunks.push(hunk);
      last.end = Math.max(last.end, hunk.end);
    } else {
      clusters.push({ hunks: [hunk], start: hunk.start, end: hunk.end });
    }
  }
  return clusters;
}

function findEnclosing(sourceLines, startLine, language) {
  if (!sourceLines || !language) return undefined;
  const floor = Math.max(1, startLine - ENCLOSING_SEARCH_LINES);
  for (let line = Math.min(startLine, sourceLines.length); line >= floor; line -= 1) {
    const signature = parseSignature(sourceLines[line - 1], language);
    if (signature?.kind === 'function' && sourceLines[line - 1].trim()) {
      return { line, text: sourceLines[line - 1].trim().slice(0, 160), name: signature.name };
    }
  }
  return undefined;
}

function renderView(cluster, sourceLines, contextLines) {
  const hunks = cluster.hunks;
  let from = Math.max(1, cluster.start - contextLines);
  let to = cluster.end + contextLines;
  let truncated = false;
  if (cluster.end - cluster.start + 1 > MAX_HUNK_LINES) {
    to = cluster.start + MAX_HUNK_LINES - 1;
    truncated = true;
  }
  if (sourceLines) to = Math.min(to, sourceLines.length);

  const addedLines = new Set(hunks.flatMap((hunk) => hunk.added.map((line) => line.line)));
  const removedBefore = new Map();
  for (const hunk of hunks) {
    const at = hunk.added.length > 0 ? hunk.added[0].line : hunk.start;
    removedBefore.set(at, [...(removedBefore.get(at) ?? []), ...hunk.removed]);
  }

  const width = String(Math.max(to, 1)).length;
  const rows = [];
  const emitRemoved = (at) => {
    for (const line of removedBefore.get(at) ?? []) rows.push(`-${String(line.line).padStart(width)}  ${line.text}`);
    removedBefore.delete(at);
  };
  for (let line = from; line <= to; line += 1) {
    emitRemoved(line);
    if (!sourceLines) continue;
    rows.push(`${addedLines.has(line) ? '+' : ' '}${String(line).padStart(width)}  ${sourceLines[line - 1]}`);
  }
  for (const at of [...removedBefore.keys()].sort((a, b) => a - b)) emitRemoved(at);

  return { range: { start: from, end: to }, diff: rows.join('\n'), truncated, sourceUnavailable: !sourceLines };
}

function hunkContainsFinding(hunk, finding) {
  const lines = finding.side === 'removed' ? hunk.removed : hunk.added;
  return lines.some((line) => line.line === finding.line);
}

function compactFinding(finding) {
  const { rule, severity, confidence, line, side, symbol, message } = finding;
  return { rule, severity, confidence, line, side, ...(symbol ? { symbol } : {}), message };
}

function scoreCluster(cluster, findings, callers, isTest) {
  const reasons = [];
  let score = 0;
  for (const finding of findings) {
    const weight = finding.confidence === 'low' ? 2 : SEVERITY_WEIGHT[finding.severity] ?? 2;
    score += weight;
    reasons.push(`${finding.rule}${finding.confidence === 'low' ? ' (hint)' : ''}`);
  }
  for (const entry of callers) {
    const production = entry.references.filter((reference) => !reference.isTest).length;
    if (production > 0) {
      score += 5;
      reasons.push(`${entry.symbol} has ${entry.totalReferences} outside caller(s)`);
    }
  }
  const removedCount = cluster.hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0);
  const addedCount = cluster.hunks.reduce((sum, hunk) => sum + hunk.added.length, 0);
  if (removedCount > 0) { score += 2; reasons.push('modifies existing code'); }
  score += Math.min(3, Math.floor(addedCount / 20));
  if (isTest) score = Math.max(0, score - 2);
  return { score, reasons: [...new Set(reasons)] };
}

export function buildPackets(collected, scanReport, callersReport, { contextLines, isTestFile, readLines, budgetBytes }) {
  const findingsByFile = new Map();
  for (const finding of scanReport.script_findings ?? []) {
    findingsByFile.set(finding.file, [...(findingsByFile.get(finding.file) ?? []), finding]);
  }
  const callersBySymbol = new Map((callersReport?.callers ?? []).map((entry) => [entry.symbol, entry]));

  const packets = [];
  for (const file of collected.files ?? []) {
    const hunks = locateHunks(file);
    if (hunks.length === 0) continue;
    const language = languageForPath(file.path);
    const sourceLines = file.status === 'deleted' ? undefined : readLines(file.path);
    const isTest = isTestFile(file.path);

    for (const cluster of clusterHunks(hunks, contextLines)) {
      const findings = (findingsByFile.get(file.path) ?? []).filter((finding) => cluster.hunks.some((hunk) => hunkContainsFinding(hunk, finding)));
      const callers = [...new Set(findings.map((finding) => finding.symbol).filter(Boolean))]
        .map((symbol) => callersBySymbol.get(symbol)).filter(Boolean);
      const view = renderView(cluster, sourceLines, contextLines);
      packets.push({
        file: file.path,
        status: file.status,
        language,
        isTest,
        enclosing: findEnclosing(sourceLines, cluster.start, language),
        ...view,
        findings: findings.map(compactFinding),
        callers: callers.map(({ symbol, totalReferences, truncated, references }) => ({ symbol, totalReferences, truncated, references })),
        risk: scoreCluster(cluster, findings, callers, isTest),
      });
    }
  }

  packets.sort((a, b) => b.risk.score - a.risk.score || a.file.localeCompare(b.file) || a.range.start - b.range.start);
  packets.forEach((packet, index) => { packet.id = `P${index + 1}`; });

  const sizeOf = (packet) => Buffer.byteLength(JSON.stringify(packet), 'utf8');
  const included = [];
  const omitted = [];
  let used = 0;
  for (const packet of packets) {
    const size = sizeOf(packet);
    if (budgetBytes && used + size > budgetBytes && included.length > 0) {
      omitted.push({ id: packet.id, file: packet.file, range: packet.range, riskScore: packet.risk.score });
    } else {
      included.push(packet);
      used += size;
    }
  }

  return {
    schemaVersion: 1,
    comparison_base: collected.comparisonBase,
    mode: omitted.length > 0 ? 'high-risk-only' : 'full',
    budget: { bytes: budgetBytes ?? null, used, packetsIncluded: included.length, packetsOmitted: omitted.length },
    signals: scanReport.signals,
    packets: included,
    omitted,
  };
}

function readWorkingTreeLines(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.diff || !flags.scan) throw new Error('Usage: build-packets.mjs --diff <collector.json> --scan <scan-report.json> [--callers <callers.json>]');
    const config = loadConfig(flags.config);
    const { isTestFile } = createFileFilters(config.scan);
    const readJson = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
    const budgetBytes = flags['budget-bytes'] ? Number(flags['budget-bytes']) : undefined;
    if (budgetBytes !== undefined && (!Number.isInteger(budgetBytes) || budgetBytes <= 0)) {
      throw new Error('--budget-bytes must be a positive integer.');
    }
    const result = buildPackets(readJson(flags.diff), readJson(flags.scan), flags.callers ? readJson(flags.callers) : undefined, {
      contextLines: config.scan.contextLines,
      isTestFile,
      readLines: readWorkingTreeLines,
      budgetBytes,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}
