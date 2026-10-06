import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CONFIG = Object.freeze({
  models: { basic: 'haiku', advanced: 'sonnet' },
  diff: { baseRef: 'HEAD', untrackedMaxBytes: 100000, maxDiffBytes: 102400 },
  scan: { exclude: [], testFiles: { patterns: [] }, contextLines: 15 },
  rules: { disabled: [], severityOverrides: {} },
  autoFix: false,
  repositoryContext: null,
  ticketContext: null,
  report: { outputDir: '.bug-hunter/reports' },
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in base ? merge(base[key], value) : value;
  }
  return result;
}

function requireType(condition, message) {
  if (!condition) throw new Error(`Invalid bug-hunter config: ${message}`);
}

/** Merges user config over defaults and validates the fields scripts depend on. */
export function normalizeConfig(userConfig = {}) {
  const config = merge(DEFAULT_CONFIG, userConfig);
  requireType(typeof config.autoFix === 'boolean', '"autoFix" must be a boolean');
  requireType(Number.isInteger(config.diff.maxDiffBytes) && config.diff.maxDiffBytes > 0,
    '"diff.maxDiffBytes" must be a positive integer');
  requireType(Number.isInteger(config.scan.contextLines) && config.scan.contextLines >= 0,
    '"scan.contextLines" must be a non-negative integer');
  requireType(Array.isArray(config.rules.disabled), '"rules.disabled" must be an array');

  const repo = config.repositoryContext;
  if (repo !== null) {
    requireType(isPlainObject(repo) && Array.isArray(repo.fileNames) && repo.fileNames.length > 0,
      '"repositoryContext.fileNames" must be a non-empty array, or set repositoryContext to null');
    config.repositoryContext = { maxLinesPerFile: 500, maxTotalLines: 1500, ...repo };
  }

  const ticket = config.ticketContext;
  if (ticket !== null) {
    requireType(isPlainObject(ticket) && typeof ticket.path === 'string',
      '"ticketContext.path" must be a string, or set ticketContext to null');
    config.ticketContext = { maxLines: 500, ...ticket };
  }
  return config;
}

export function loadConfig(configPath) {
  if (!configPath) return normalizeConfig();
  return normalizeConfig(JSON.parse(readFileSync(resolve(configPath), 'utf8')));
}

/** Minimal flag parser: `--name value` pairs, bare `--flag` booleans, and positionals. */
export function parseArgs(argv, booleanFlags = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleanFlags.includes(name)) {
      flags[name] = true;
    } else {
      if (i + 1 >= argv.length) throw new Error(`Missing value for --${name}`);
      flags[name] = argv[i + 1];
      i += 1;
    }
  }
  return { flags, positionals };
}

export function readStdin() {
  return new Promise((resolveInput, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolveInput(data));
    process.stdin.on('error', reject);
  });
}

/** Reads collector JSON from `--diff <file>` when given, otherwise from stdin. */
export async function readJsonInput(flags) {
  const text = flags.diff ? readFileSync(resolve(flags.diff), 'utf8') : await readStdin();
  if (!text.trim()) throw new Error('No input received. Pipe collector JSON on stdin or pass --diff <file>.');
  return JSON.parse(text);
}

export function languageForPath(path) {
  if (/\.py$/i.test(path)) return 'python';
  if (/\.cs$/i.test(path)) return 'csharp';
  if (/\.[cm]?tsx?$/i.test(path)) return 'typescript';
  if (/\.[cm]?jsx?$/i.test(path)) return 'javascript';
  return undefined;
}

export function isJsLike(language) {
  return language === 'javascript' || language === 'typescript';
}

/** True when the module is the process entry point, so scripts stay importable by tests. */
export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && importMetaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

/** Runs a CLI main function, printing errors to stderr with a non-zero exit code. */
export async function runCli(main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
