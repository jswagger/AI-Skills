#!/usr/bin/env node
// Gathers optional repository and ticket context for the review agent.
// Usage: collect-diff.mjs ... | gather-context.mjs --config <path> [--ticket <name>] [--root <dir>]
//
// Repository context searches from each changed file's folder up to the repository root.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMain, loadConfig, parseArgs, readJsonInput, runCli } from './lib/common.mjs';

const MAX_REPOSITORY_CONTEXT_FILES = 5;

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

/** Folders from the changed file's folder to `root`, without crossing the repository boundary. */
function ancestorFolders(filePath, root) {
  const rootPath = resolve(root);
  let folder = dirname(resolve(rootPath, filePath));
  const folders = [];
  while (true) {
    const fromRoot = relative(rootPath, folder);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) break;
    folders.push(folder);
    if (folder === rootPath) break;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return folders;
}

export function gatherRepositoryContext(changedPaths, settings, root = process.cwd(), alreadyLoaded = new Set()) {
  if (!settings) return { enabled: false, files: [], notes: [] };
  const { fileNames, maxLinesPerFile, maxTotalLines } = settings;
  const rootPath = resolve(root);
  const candidatesByPath = new Map();
  const files = [];
  const notes = [];
  let totalLines = 0;

  for (const changedPath of [...changedPaths].sort()) {
    for (const [distance, folder] of ancestorFolders(changedPath, rootPath).entries()) {
      for (const name of fileNames) {
        const candidate = join(folder, name);
        const key = resolve(candidate);
        if (!isFile(candidate)) continue;
        const existing = candidatesByPath.get(key);
        if (!existing || distance < existing.distance) {
          candidatesByPath.set(key, {
            key,
            path: relative(rootPath, key).replaceAll('\\', '/'),
            forFile: changedPath,
            distance,
          });
        }
      }
    }
  }

  const candidates = [...candidatesByPath.values()].sort((left, right) =>
    left.distance - right.distance || left.path.localeCompare(right.path));
  for (const candidate of candidates) {
    if (alreadyLoaded.has(candidate.key)) {
      notes.push(`Skipped ${candidate.path}: already loaded by the host.`);
      continue;
    }
    if (files.length >= MAX_REPOSITORY_CONTEXT_FILES) {
      notes.push(`Skipped remaining repository context files: maximum of ${MAX_REPOSITORY_CONTEXT_FILES} files reached.`);
      break;
    }
    const remaining = maxTotalLines - totalLines;
    if (remaining <= 0) {
      notes.push(`Skipped remaining repository context files: total context budget of ${maxTotalLines} lines reached.`);
      break;
    }
    const { content, lineCount, truncated } = readCapped(candidate.key, Math.min(maxLinesPerFile, remaining));
    totalLines += lineCount;
    files.push({ path: candidate.path, forFile: candidate.forFile, truncated, content });
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
