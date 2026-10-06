import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeConfig } from '../scripts/lib/common.mjs';
import { scanCollected } from '../scripts/scan-patterns.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));
const removed = (line, text) => ({ side: 'removed', line, text });
const added = (line, text) => ({ side: 'added', line, text });
const file = (path, changes) => ({ path, status: 'modified', changes });

const config = (overrides = {}) => normalizeConfig({
  scan: { exclude: [], testFiles: { patterns: ['*.test.*', '**/test/**'] } },
  ...overrides,
});

const NULL_GUARD_CHANGE = [removed(5, '  if (user === null) return;'), added(5, '  render(user);')];

test('scanCollected reports findings with file paths, languages and a rule summary', () => {
  const report = scanCollected({ comparisonBase: 'abc123', files: [file('src/ui.ts', NULL_GUARD_CHANGE)] }, config());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.comparison_base, 'abc123');
  assert.deepEqual(report.repository_type, ['typescript']);
  assert.equal(report.script_findings.length, 1);
  assert.equal(report.script_findings[0].file, 'src/ui.ts');
  assert.deepEqual(report.summary.findingsByRule, { REMOVED_GUARD: 1 });
});

test('scanCollected skips unsupported files and counts trivial hunks without analyzing them', () => {
  const report = scanCollected({
    files: [
      file('notes.rb', NULL_GUARD_CHANGE),
      file('src/a.js', [added(1, '// just a comment'), added(2, "import x from './x';")]),
    ],
  }, config());
  assert.equal(report.summary.filesSkippedUnsupported, 1);
  assert.equal(report.summary.trivialHunksSkipped, 1);
  assert.deepEqual(report.script_findings, []);
});

test('rules.disabled and severityOverrides are honored', () => {
  const collected = { files: [file('src/ui.js', NULL_GUARD_CHANGE)] };
  assert.deepEqual(scanCollected(collected, config({ rules: { disabled: ['REMOVED_GUARD'] } })).script_findings, []);
  const overridden = scanCollected(collected, config({ rules: { severityOverrides: { REMOVED_GUARD: 'HIGH' } } }));
  assert.equal(overridden.script_findings[0].severity, 'HIGH');
});

test('inline bug-hunter-ignore suppresses all rules or only the named rule for that hunk', () => {
  const ignoreAll = [removed(5, '  if (user === null) return;'), added(5, '  render(user); // bug-hunter-ignore')];
  assert.deepEqual(scanCollected({ files: [file('a.js', ignoreAll)] }, config()).script_findings, []);

  const ignoreNamed = [removed(5, '  if (user === null) return;'), added(5, '  render(user); // bug-hunter-ignore: REMOVED_GUARD')];
  assert.deepEqual(scanCollected({ files: [file('a.js', ignoreNamed)] }, config()).script_findings, []);

  const ignoreOther = [removed(5, '  if (user === null) return;'), added(5, '  render(user); // bug-hunter-ignore: REMOVED_AWAIT')];
  assert.equal(scanCollected({ files: [file('a.js', ignoreOther)] }, config()).script_findings.length, 1);
});

test('test files only produce test-integrity findings', () => {
  const testChanges = [
    removed(3, '  if (user === null) return;'),
    removed(4, '  expect(result).toBe(1);'),
    added(3, '  run();'),
  ];
  const report = scanCollected({ files: [file('src/ui.test.js', testChanges)] }, config());
  assert.deepEqual(report.script_findings.map((finding) => finding.rule), ['REMOVED_TEST_ASSERTION']);
});

test('logicChangedWithoutTests is raised only when source logic changes and no test file changes', () => {
  const source = file('src/pay.js', [removed(1, 'return a < b;'), added(1, 'return a <= b;')]);
  const test = file('src/pay.test.js', [added(1, "it('pays', () => {});")]);

  assert.equal(scanCollected({ files: [source] }, config()).signals.logicChangedWithoutTests, true);
  assert.equal(scanCollected({ files: [source, test] }, config()).signals.logicChangedWithoutTests, false);
  assert.equal(scanCollected({ files: [file('src/c.js', [added(1, '// note')])] }, config()).signals.logicChangedWithoutTests, false);
});

test('duplicate findings for the same file, line and rule are collapsed', () => {
  const changes = [removed(5, '  if (a === null) return;'), added(5, '  go();')];
  const report = scanCollected({ files: [file('a.js', changes), file('a.js', changes)] }, config());
  assert.equal(report.script_findings.length, 1);
});

test('a deleted file with exported symbols reports the removed symbols', () => {
  const deleted = { path: 'src/api.ts', status: 'deleted', changes: [
    removed(1, 'export function getUser(id) {'), removed(2, '  return db.find(id);'), removed(3, '}'),
  ] };
  const report = scanCollected({ files: [deleted] }, config());
  assert.deepEqual(report.script_findings.map((finding) => finding.symbol), ['getUser']);
});

test('the CLI reads collector JSON from stdin and prints a report', () => {
  const input = JSON.stringify({ comparisonBase: 'HEAD', files: [file('src/ui.js', NULL_GUARD_CHANGE)] });
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.script_findings[0].rule, 'REMOVED_GUARD');
});

test('the CLI fails with a clear message on empty input', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', input: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No input received/);
});
