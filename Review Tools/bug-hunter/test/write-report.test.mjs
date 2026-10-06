import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MAX_SUSPICIOUS_IN_MARKDOWN,
  buildReportJson,
  groupFindings,
  renderMarkdown,
  reportBaseName,
  validateAgentReport,
  writeReport,
} from '../scripts/write-report.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/write-report.mjs', import.meta.url));
const NOW = new Date(2026, 9, 6, 14, 30, 5);

const probable = (overrides = {}) => ({ title: 'Guard removed', file: 'a.js', line: 5, scenario: 'null user crashes render', ...overrides });
const suspicious = (overrides = {}) => ({ title: 'Condition widened', file: 'b.js', line: 9, check: 'confirm 0 is valid', ...overrides });

function tempDir(context) {
  const dir = mkdtempSync(join(tmpdir(), 'bug-hunter-report-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('validateAgentReport requires a failure scenario for 🔴 and a specific check for 🟡', () => {
  assert.doesNotThrow(() => validateAgentReport({ probable_bugs: [probable()], suspicious: [suspicious()] }));
  assert.doesNotThrow(() => validateAgentReport({}));
  assert.throws(() => validateAgentReport({ probable_bugs: [probable({ scenario: '' })] }), /probable_bugs\[0\].*"scenario" is required/s);
  assert.throws(() => validateAgentReport({ suspicious: [suspicious({ check: undefined })] }), /"check" is required/);
  assert.throws(() => validateAgentReport({ probable_bugs: [{ scenario: 'x' }] }), /"title" is required/);
  assert.throws(() => validateAgentReport({ clean: [{ note: 'x' }] }), /clean\[0\]/);
});

test('validateAgentReport reports every problem at once', () => {
  assert.throws(
    () => validateAgentReport({ probable_bugs: [probable({ scenario: '' })], suspicious: [suspicious({ check: '' })] }),
    (error) => /probable_bugs\[0\]/.test(error.message) && /suspicious\[0\]/.test(error.message),
  );
});

test('groupFindings merges repeated rule+title hits into one entry with a location list', () => {
  const grouped = groupFindings([
    probable({ rule: 'REMOVED_GUARD', file: 'a.js', line: 1 }),
    probable({ rule: 'REMOVED_GUARD', file: 'b.js', line: 2 }),
    probable({ rule: 'REMOVED_AWAIT', title: 'Await dropped', file: 'c.js', line: 3 }),
  ]);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].locations, [{ file: 'a.js', line: 1 }, { file: 'b.js', line: 2 }]);
  assert.equal('file' in grouped[0], false);
});

test('the markdown report has the three sections in order with empty-state text', () => {
  const markdown = renderMarkdown(buildReportJson({}, { now: NOW }));
  const order = ['## 🔴 Probable Bugs', '## 🟡 Suspicious', '## 🟢 Clean'].map((heading) => markdown.indexOf(heading));
  assert.ok(order.every((index) => index >= 0) && order[0] < order[1] && order[1] < order[2]);
  assert.equal(markdown.match(/None found\./g).length, 2);
  assert.match(markdown, /No specific areas to report\./);
});

test('markdown renders scenario, verify step, location groups, snippets and auto-fix notes', () => {
  const report = buildReportJson({
    probable_bugs: [
      probable({ rule: 'REMOVED_GUARD', snippet: '- if (user === null) return;', recommendation: 'Restore the guard.', autoFixed: true, fixNote: 'Guard restored.' }),
      probable({ rule: 'REMOVED_GUARD', file: 'z.js', line: 8 }),
    ],
    suspicious: [suspicious()],
    clean: [{ area: 'src/pay.js', note: 'boundaries preserved' }, 'src/util.js'],
  }, { now: NOW });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /### 1\. Guard removed/);
  assert.match(markdown, /2 locations: `a\.js:5`, `z\.js:8` · Rule: `REMOVED_GUARD`/);
  assert.match(markdown, /\*\*Failure scenario:\*\* null user crashes render/);
  assert.match(markdown, /\*\*Verify:\*\* confirm 0 is valid/);
  assert.match(markdown, /✅ \*\*Auto-fixed\.\*\* Guard restored\./);
  assert.match(markdown, /```\n- if \(user === null\) return;\n```/);
  assert.match(markdown, /- \*\*src\/pay\.js\*\* — boundaries preserved/);
  assert.match(markdown, /- \*\*src\/util\.js\*\*/);
});

test('a snippet containing backticks gets a longer fence', () => {
  const report = buildReportJson({ probable_bugs: [probable({ snippet: 'run(`cmd ```x``` `)' })] }, { now: NOW });
  assert.match(renderMarkdown(report), /````\nrun\(/);
});

test('markdown caps 🟡 entries and points to the JSON for the rest, which keeps them all', () => {
  const many = Array.from({ length: MAX_SUSPICIOUS_IN_MARKDOWN + 4 }, (_, i) => suspicious({ title: `Item ${i + 1}` }));
  const report = buildReportJson({ suspicious: many }, { now: NOW });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /4 more suspicious item\(s\) are in the JSON report/);
  assert.ok(markdown.includes(`### ${MAX_SUSPICIOUS_IN_MARKDOWN}. Item ${MAX_SUSPICIOUS_IN_MARKDOWN}`));
  assert.equal(markdown.includes('Item 16'), false);
  assert.equal(report.suspicious.length, MAX_SUSPICIOUS_IN_MARKDOWN + 4);
});

test('a budgeted run is disclosed as a partial review listing the omitted files', () => {
  const packets = {
    mode: 'high-risk-only',
    comparison_base: 'origin/main',
    omitted: [{ id: 'P4', file: 'quiet.js', range: { start: 10, end: 20 }, riskScore: 1 }],
  };
  const markdown = renderMarkdown(buildReportJson({}, { packets, now: NOW }));
  assert.match(markdown, /Partial review/);
  assert.match(markdown, /`quiet\.js` \(lines 10-20, risk 1\)/);
});

test('scan metadata and the tests-missing signal flow into the report', () => {
  const scan = { comparison_base: 'abc', commit_hash: 'a1b2c3d', repository_type: ['csharp'], signals: { logicChangedWithoutTests: true } };
  const report = buildReportJson({}, { scan, now: NOW });
  assert.equal(report.run.commit, 'a1b2c3d');
  assert.deepEqual(report.run.languages, ['csharp']);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /commit `a1b2c3d`/);
  assert.match(markdown, /no test files changed/);
});

test('dismissed script findings are kept in the JSON only', () => {
  const dismissed = [{ rule: 'REMOVED_GUARD', file: 'a.js', line: 3, reason: 'guard moved to caller' }];
  const report = buildReportJson({ dismissed_script_findings: dismissed }, { now: NOW });
  assert.deepEqual(report.dismissed_script_findings, dismissed);
  assert.equal(report.summary.dismissed, 1);
  assert.equal(renderMarkdown(report).includes('guard moved to caller'), false);
});

test('reportBaseName embeds the run date and time plus a uniqueness suffix', () => {
  assert.equal(reportBaseName(NOW, 'ab12'), 'bug-hunter-2026-10-06T14-30-05-ab12');
});

test('writeReport writes both files, creates the folder, and never overwrites an existing report', (context) => {
  const outputDir = join(tempDir(context), 'nested', 'reports');
  const result = writeReport({ probable_bugs: [probable()] }, { outputDir, now: NOW, suffix: 'ab12' });
  assert.ok(existsSync(result.markdownPath) && existsSync(result.jsonPath));
  assert.match(result.jsonPath, /bug-hunter-2026-10-06T14-30-05-ab12\.json$/);
  assert.equal(JSON.parse(readFileSync(result.jsonPath, 'utf8')).summary.probableBugs, 1);
  assert.throws(() => writeReport({}, { outputDir, now: NOW, suffix: 'ab12' }), /EEXIST/);
});

test('writeReport rejects invalid agent findings before writing anything', (context) => {
  const outputDir = join(tempDir(context), 'reports');
  assert.throws(() => writeReport({ probable_bugs: [{ title: 'x' }] }, { outputDir }), /scenario/);
  assert.equal(existsSync(outputDir), false);
});

test('the CLI reads agent findings from stdin and prints both file paths', (context) => {
  const outputDir = tempDir(context);
  const result = spawnSync(process.execPath, [scriptPath, '--out', outputDir], {
    encoding: 'utf8',
    input: JSON.stringify({ probable_bugs: [probable()] }),
  });
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.ok(existsSync(printed.markdownPath) && existsSync(printed.jsonPath));
  assert.equal(printed.summary.probableBugs, 1);
});

test('the CLI exits non-zero with the validation problems for bad input', (context) => {
  const result = spawnSync(process.execPath, [scriptPath, '--out', tempDir(context)], {
    encoding: 'utf8',
    input: JSON.stringify({ probable_bugs: [{ title: 'no scenario' }] }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"scenario" is required/);
});
