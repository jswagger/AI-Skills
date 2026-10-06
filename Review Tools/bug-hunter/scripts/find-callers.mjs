#!/usr/bin/env node
// Finds references to symbols whose contract changed (SIGNATURE_CHANGED findings), so the reviewer
// can check callers the diff did not touch. Matching is by name, so results are leads, not proof.
// Usage: find-callers.mjs --diff <collector.json> --scan <scan-report.json> [--config <path>] [--max-callers <n>]

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFileFilters } from '../../review-tools-common/file-filters.mjs';
import { isMain, languageForPath, loadConfig, parseArgs, runCli } from './lib/common.mjs';
import { isCommentLine } from './lib/hunks.mjs';
import { parseSignature } from './lib/rules-regression.mjs';

const DEFAULT_MAX_CALLERS = 5;
const MAX_SNIPPET_LENGTH = 200;

const PATHSPECS = {
  javascript: ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.mts', '*.cts'],
  python: ['*.py'],
  csharp: ['*.cs'],
};
PATHSPECS.typescript = PATHSPECS.javascript;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A usage of the symbol: call, import/export, or passed as an argument. Plain word hits are dropped. */
export function isReference(text, symbol) {
  const name = escapeRegex(symbol);
  return new RegExp(`(?:\\b${name}\\s*(?:<[^>]*>)?\\s*\\(|\\b(?:import|from|using|export)\\b.*\\b${name}\\b|[(,]\\s*${name}\\s*[,)]|\\bnew\\s+${name}\\b|\\b${name}\\.\\w|:\\s*${name}\\b|\\bextends\\s+${name}\\b|\\(\\s*${name}\\s*\\))`).test(text);
}

/** Real search: tracked and untracked (non-ignored) files of the symbol's language family. */
export function gitGrepSearch(symbol, language) {
  const pathspecs = PATHSPECS[language];
  if (!pathspecs) return [];
  let output;
  try {
    output = execFileSync('git', ['grep', '-n', '-w', '-F', '--untracked', '-e', symbol, '--', ...pathspecs], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  return output.split('\n').filter(Boolean).map((row) => {
    const match = row.match(/^(.*?):(\d+):(.*)$/);
    return match ? { file: match[1], line: Number(match[2]), text: match[3] } : undefined;
  }).filter(Boolean);
}

function addedLinesByFile(collected) {
  const byFile = new Map();
  for (const file of collected.files ?? []) {
    byFile.set(file.path, new Set(file.changes.filter((change) => change.side === 'added').map((change) => change.line)));
  }
  return byFile;
}

export function findCallers(scanReport, collected, { search, isTestFile, maxCallers = DEFAULT_MAX_CALLERS }) {
  const changed = addedLinesByFile(collected);
  const symbols = new Map();
  for (const finding of scanReport.script_findings ?? []) {
    if (finding.rule === 'SIGNATURE_CHANGED' && !symbols.has(finding.symbol)) {
      symbols.set(finding.symbol, finding);
    }
  }

  const callers = [];
  const symbolsWithoutCallers = [];

  for (const [symbol, finding] of symbols) {
    const language = languageForPath(finding.file);
    const references = search(symbol, language)
      .filter((hit) => !changed.get(hit.file)?.has(hit.line))
      .filter((hit) => !isCommentLine(hit.text) && isReference(hit.text, symbol))
      .filter((hit) => parseSignature(hit.text, languageForPath(hit.file) ?? language)?.name !== symbol)
      .map((hit) => ({
        file: hit.file,
        line: hit.line,
        text: hit.text.trim().slice(0, MAX_SNIPPET_LENGTH),
        isTest: isTestFile(hit.file),
      }))
      // Production callers first: they are where a silent break reaches users.
      .sort((a, b) => Number(a.isTest) - Number(b.isTest) || a.file.localeCompare(b.file) || a.line - b.line);

    if (references.length === 0) {
      symbolsWithoutCallers.push(symbol);
      continue;
    }
    callers.push({
      symbol,
      definedIn: finding.file,
      change: finding.message,
      totalReferences: references.length,
      truncated: references.length > maxCallers,
      references: references.slice(0, maxCallers),
    });
  }
  return { schemaVersion: 1, matchedBy: 'name', callers, symbolsWithoutCallers };
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.diff || !flags.scan) throw new Error('Usage: find-callers.mjs --diff <collector.json> --scan <scan-report.json>');
    const config = loadConfig(flags.config);
    const { isTestFile } = createFileFilters(config.scan);
    const collected = JSON.parse(readFileSync(resolve(flags.diff), 'utf8'));
    const scanReport = JSON.parse(readFileSync(resolve(flags.scan), 'utf8'));
    const maxCallers = flags['max-callers'] ? Number(flags['max-callers']) : DEFAULT_MAX_CALLERS;
    if (!Number.isInteger(maxCallers) || maxCallers <= 0) throw new Error('--max-callers must be a positive integer.');
    const result = findCallers(scanReport, collected, { search: gitGrepSearch, isTestFile, maxCallers });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}
