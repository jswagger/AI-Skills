#!/usr/bin/env node
// Gate: measures the collected diff and warns before an expensive review.
// Usage: collect-diff.mjs ... | check-diff-size.mjs [--config <path>] [--limit <bytes>]

import { isMain, loadConfig, parseArgs, readJsonInput, runCli } from './lib/common.mjs';

const TOP_FILES = 10;

export function measureDiff(collected) {
  const files = (collected.files ?? []).map((file) => ({
    path: file.path,
    bytes: file.changes.reduce((sum, change) => sum + Buffer.byteLength(change.text, 'utf8') + 1, 0),
  }));
  files.sort((a, b) => b.bytes - a.bytes);
  return { bytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

export function checkDiffSize(collected, limit) {
  const { bytes, files } = measureDiff(collected);
  const exceeded = bytes > limit;
  return {
    bytes,
    limit,
    exceeded,
    fileCount: files.length,
    largestFiles: files.slice(0, TOP_FILES),
    warning: exceeded
      ? `Diff is ${(bytes / 1024).toFixed(1)}KB, over the ${(limit / 1024).toFixed(1)}KB limit. A full review may consume a large number of tokens. Continue in full, or review only the highest-risk files (build-packets --budget-bytes ${limit}).`
      : null,
  };
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    const config = loadConfig(flags.config);
    const limit = flags.limit ? Number(flags.limit) : config.diff.maxDiffBytes;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer.');
    const collected = await readJsonInput(flags);
    process.stdout.write(`${JSON.stringify(checkDiffSize(collected, limit), null, 2)}\n`);
  });
}
