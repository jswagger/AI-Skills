#!/usr/bin/env node
// Gathers optional repository and ticket context for the review agent.
// Usage: collect-diff.mjs ... | gather-context.mjs --config <path> [--ticket <name>] [--root <dir>]
//
// Repository context uses a nearest-neighbor strategy: only the folder of each changed file and
// its parent folder are searched for the configured context file names.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isMain, loadConfig, parseArgs, readJsonInput, runCli } from './lib/common.mjs';

function readCapped(path, maxLines) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines.length <= maxLines) return { content: lines.join('\n'), lineCount: lines.length, truncated: false };
  return { content: lines.slice(0, maxLines).join('\n'), lineCount: maxLines, truncated: true };
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Folder of the file, then its parent, never above `root`. */
function neighborFolders(filePath, root) {
  const folder = dirname(resolve(root, filePath));
  const parent = dirname(folder);
  const inside = (candidate) => !relative(root, candidate).startsWith('..');
  return [folder, parent].filter((candidate, index, all) => inside(candidate) && all.indexOf(candidate) === index);
}

export function gatherRepositoryContext(changedPaths, settings, root = process.cwd(), alreadyLoaded = new Set()) {
  if (!settings) return { enabled: false, files: [], notes: [] };
  const { fileNames, maxLinesPerFile, maxTotalLines } = settings;
  const seen = new Set();
  const files = [];
  const notes = [];
  let totalLines = 0;

  for (const changedPath of [...changedPaths].sort()) {
    for (const folder of neighborFolders(changedPath, root)) {
      for (const name of fileNames) {
        const candidate = join(folder, name);
        const key = resolve(candidate);
        if (seen.has(key) || !isFile(candidate)) continue;
        seen.add(key);
        if (alreadyLoaded.has(key)) {
          notes.push(`Skipped ${relative(root, key)}: already loaded by the host.`);
          continue;
        }
        const remaining = maxTotalLines - totalLines;
        if (remaining <= 0) {
          notes.push(`Skipped ${relative(root, key)}: total context budget of ${maxTotalLines} lines reached.`);
          continue;
        }
        const { content, lineCount, truncated } = readCapped(candidate, Math.min(maxLinesPerFile, remaining));
        totalLines += lineCount;
        files.push({ path: relative(root, key).replaceAll('\\', '/'), forFile: changedPath, truncated, content });
      }
    }
  }
  return { enabled: true, files, totalLines, notes };
}

export function gatherTicketContext(settings, ticketOverride) {
  if (!settings) return { enabled: false, found: false, notes: [] };
  const ticketName = ticketOverride ?? settings.ticketName;
  if (!ticketName) return { enabled: true, found: false, notes: ['ticketContext is set but no ticket name was provided.'] };
  if (/[\\/]/.test(ticketName)) return { enabled: true, found: false, notes: ['Ticket name must not contain path separators.'] };

  for (const extension of ['.md', '.txt']) {
    const candidate = join(resolve(settings.path), `${ticketName}${extension}`);
    if (!isFile(candidate)) continue;
    const { content, truncated } = readCapped(candidate, settings.maxLines);
    return { enabled: true, found: true, ticketName, path: candidate, truncated, content, notes: [] };
  }
  const where = existsSync(settings.path) ? settings.path : `${settings.path} (folder not found)`;
  return { enabled: true, found: false, ticketName, notes: [`No ${ticketName}.md or ${ticketName}.txt found in ${where}.`] };
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    const config = loadConfig(flags.config);
    const collected = await readJsonInput(flags);
    const paths = (collected.files ?? []).filter((file) => file.status !== 'deleted').map((file) => file.path);
    const root = resolve(flags.root ?? process.cwd());
    const result = {
      repository: gatherRepositoryContext(paths, config.repositoryContext, root),
      ticket: gatherTicketContext(config.ticketContext, flags.ticket),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}
