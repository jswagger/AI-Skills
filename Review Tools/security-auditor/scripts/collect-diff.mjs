#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createFileFilters } from './file-filters.mjs';

const configPath = new URL('../config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { isExcluded } = createFileFilters(config.scan);
const args = process.argv.slice(2);
const baseRef = args[0] ?? config.diff.baseRef ?? 'HEAD';
const maxUntrackedBytes = config.diff.untrackedMaxBytes ?? 100000;

function runGit(gitArgs, options = {}) {
  return execFileSync('git', gitArgs, {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseDiff(diffText) {
  const files = [];
  let currentFile;
  let oldFilePath;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('--- ')) {
      const path = line.slice(6);
      oldFilePath = path === '/dev/null' ? undefined : path;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const path = line.slice(6);
      if (path !== '/dev/null') {
        currentFile = { path, status: oldFilePath ? 'modified' : 'added', changes: [] };
        files.push(currentFile);
      } else if (oldFilePath) {
        currentFile = { path: oldFilePath, status: 'deleted', changes: [] };
        files.push(currentFile);
      } else {
        currentFile = undefined;
      }
      oldFilePath = undefined;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }

    if (!currentFile || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentFile.changes.push({ side: 'added', line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentFile.changes.push({ side: 'removed', line: oldLine, text: line.slice(1) });
      oldLine += 1;
    }
  }

  return files;
}

function collectUntracked() {
  const paths = runGit(['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const files = [];
  const skipped = [];

  for (const path of paths) {
    if (isExcluded(path)) continue;
    try {
      const content = readFileSync(path);
      if (content.length > maxUntrackedBytes || content.includes(0)) {
        skipped.push({ path, reason: content.includes(0) ? 'binary file' : 'file exceeds size limit' });
        continue;
      }
      const text = content.toString('utf8');
      files.push({
        path,
        status: 'untracked',
        changes: text.split(/\r?\n/).map((line, index) => ({ side: 'added', line: index + 1, text: line })),
      });
    } catch (error) {
      skipped.push({ path, reason: `could not read file (${error.code ?? 'unknown error'})` });
    }
  }

  return { files, skipped };
}

try {
  const diffText = runGit(['diff', '--no-ext-diff', '--unified=0', baseRef, '--']);
  const files = parseDiff(diffText).filter((file) => !isExcluded(file.path));
  const untracked = collectUntracked();
  const trackedPaths = new Set(files.map((file) => file.path));

  process.stdout.write(`${JSON.stringify({
    baseRef,
    files: [...files, ...untracked.files.filter((file) => !trackedPaths.has(file.path))],
    skipped: untracked.skipped,
    note: 'Diff collection is limited to changes relative to the base ref and untracked non-ignored text files.',
  }, null, 2)}\n`);
} catch (error) {
  const message = error.stderr?.toString('utf8').trim() || error.message;
  process.stderr.write(`Failed to collect diff from ${basename(baseRef)}: ${message}\n`);
  process.exitCode = 1;
}