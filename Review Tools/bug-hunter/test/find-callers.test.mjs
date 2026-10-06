import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findCallers, gitGrepSearch, isReference } from '../scripts/find-callers.mjs';

const signatureFinding = (symbol, file = 'src/api.ts') => ({
  rule: 'SIGNATURE_CHANGED', symbol, file, message: `Contract of \`${symbol}\` changed.`,
});
const scanOf = (...findings) => ({ script_findings: findings });
const isTestFile = (path) => /\.test\./.test(path);
const noChanges = { files: [] };

test('isReference accepts calls, imports, callbacks and constructors but rejects bare mentions', () => {
  assert.equal(isReference('const u = loadUser(id);', 'loadUser'), true);
  assert.equal(isReference("import { loadUser } from './api';", 'loadUser'), true);
  assert.equal(isReference('ids.map(loadUser)', 'loadUser'), true);
  assert.equal(isReference('var s = new UserService();', 'UserService'), true);
  assert.equal(isReference('class Admin extends UserService {', 'UserService'), true);
  assert.equal(isReference('const loadUserLabel = "x";', 'loadUser'), false);
  assert.equal(isReference('// loadUser was slow', 'loadUser'), false);
  assert.equal(isReference('const loadUser = 5;', 'loadUser'), false);
});

test('findCallers lists references, production callers before tests, and skips declarations and comments', () => {
  const hits = [
    { file: 'src/api.test.ts', line: 4, text: '  loadUser(1);' },
    { file: 'src/page.ts', line: 10, text: '  const u = loadUser(id);' },
    { file: 'src/api.ts', line: 1, text: 'export function loadUser(id, opts) {' },
    { file: 'src/page.ts', line: 3, text: '  // loadUser(old)' },
  ];
  const result = findCallers(scanOf(signatureFinding('loadUser')), noChanges, { search: () => hits, isTestFile });
  assert.equal(result.callers.length, 1);
  const [entry] = result.callers;
  assert.equal(entry.symbol, 'loadUser');
  assert.deepEqual(entry.references.map((ref) => `${ref.file}:${ref.line}`), ['src/page.ts:10', 'src/api.test.ts:4']);
  assert.equal(entry.references[1].isTest, true);
});

test('references on lines changed by the diff are skipped, but unchanged lines in changed files are kept', () => {
  const hits = [
    { file: 'src/page.ts', line: 10, text: '  loadUser(id);' },
    { file: 'src/page.ts', line: 30, text: '  loadUser(other);' },
  ];
  const collected = { files: [{ path: 'src/page.ts', changes: [{ side: 'added', line: 10, text: 'loadUser(id, {});' }] }] };
  const result = findCallers(scanOf(signatureFinding('loadUser')), collected, { search: () => hits, isTestFile });
  assert.deepEqual(result.callers[0].references.map((ref) => ref.line), [30]);
});

test('findCallers caps references and reports the total and truncation', () => {
  const hits = Array.from({ length: 9 }, (_, i) => ({ file: `src/f${i}.ts`, line: 1, text: 'loadUser(1);' }));
  const result = findCallers(scanOf(signatureFinding('loadUser')), noChanges, { search: () => hits, isTestFile, maxCallers: 3 });
  assert.equal(result.callers[0].references.length, 3);
  assert.equal(result.callers[0].totalReferences, 9);
  assert.equal(result.callers[0].truncated, true);
});

test('symbols with no outside references are listed separately, and non-signature findings are ignored', () => {
  const findings = scanOf(signatureFinding('orphan'), { rule: 'REMOVED_GUARD', file: 'a.ts', symbol: 'ignored' });
  const result = findCallers(findings, noChanges, { search: () => [], isTestFile });
  assert.deepEqual(result.callers, []);
  assert.deepEqual(result.symbolsWithoutCallers, ['orphan']);
});

test('each symbol is searched once even when it has several findings', () => {
  const searched = [];
  const search = (symbol) => { searched.push(symbol); return []; };
  findCallers(scanOf(signatureFinding('dup'), signatureFinding('dup')), noChanges, { search, isTestFile });
  assert.deepEqual(searched, ['dup']);
});

test('gitGrepSearch finds tracked and untracked files of the same language family only', (context) => {
  const repo = mkdtempSync(join(tmpdir(), 'bug-hunter-grep-'));
  const originalCwd = process.cwd();
  context.after(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/tracked.ts'), 'loadUser(1);\nloadUserLater();\n');
  writeFileSync(join(repo, 'src/other.py'), 'loadUser(1)\n');
  git('add', '.');
  writeFileSync(join(repo, 'src/untracked.js'), 'x = loadUser(2);\n');

  process.chdir(repo);
  const hits = gitGrepSearch('loadUser', 'typescript');
  assert.deepEqual(hits.map((hit) => `${hit.file}:${hit.line}`).sort(), ['src/tracked.ts:1', 'src/untracked.js:1']);
  assert.deepEqual(gitGrepSearch('absent', 'typescript'), []);
  assert.deepEqual(gitGrepSearch('loadUser', 'ruby'), []);
});
