import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));

function scan(files) {
  const result = spawnSync(process.execPath, [scannerPath], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    input: JSON.stringify({ files }),
  });
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout), stderr: result.stderr };
}

test('Python tests and complexity patterns include top-level tests and long functions', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-sweeper-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'long.py');
  const lines = ['def long_task():', ...Array.from({ length: 51 }, (_, index) => `    value_${index} = ${index}`)];
  writeFileSync(path, lines.join('\n'));
  const report = scan([
    { path, changes: [{ side: 'added', line: 2, text: lines[1] }] },
    {
      path: 'test/test_api.py',
      changes: [
        { side: 'added', line: 1, text: 'if first and second or third and fourth or fifth and sixth:' },
        { side: 'added', line: 2, text: 'result = left if first else middle if second else right' },
      ],
    },
  ]);

  assert(report.changedTests.some((file) => file.path === 'test/test_api.py'));
  assert(report.candidates.some((candidate) => candidate.ruleId === 'SWEEP-103'));
  assert(report.candidates.some((candidate) => candidate.ruleId === 'SWEEP-102'));
  assert(report.candidates.some((candidate) => candidate.ruleId === 'SWEEP-106' && candidate.path === path));
});

test('duplicate statements require a long line or a repeated block and ignore common idioms', () => {
  const repeated = 'result = calculate_value(input_data, include_metadata=true)';
  const report = scan([
    {
      path: 'src/first.py',
      changes: [
        { side: 'added', line: 1, text: repeated },
        { side: 'added', line: 2, text: repeated },
        { side: 'added', line: 3, text: 'import unittest' },
        { side: 'added', line: 4, text: 'import unittest' },
        { side: 'added', line: 5, text: 'except Exception:' },
        { side: 'added', line: 6, text: 'except Exception:' },
        { side: 'added', line: 7, text: 'if __name__ == "__main__":' },
        { side: 'added', line: 8, text: 'if __name__ == "__main__":' },
        { side: 'added', line: 9, text: 'sut = create_subject()' },
        { side: 'added', line: 10, text: 'sut = create_subject()' },
        { side: 'added', line: 11, text: 'await waitFor(() => ready)' },
        { side: 'added', line: 12, text: 'await waitFor(() => ready)' },
        { side: 'added', line: 13, text: '});' },
        { side: 'added', line: 14, text: '});' },
        { side: 'added', line: 15, text: 'label: "value",' },
        { side: 'added', line: 16, text: 'label: "value",' },
        { side: 'added', line: 17, text: 'short = one' },
        { side: 'added', line: 18, text: 'short = one' },
      ],
    },
    { path: 'src/second.py', changes: [{ side: 'added', line: 1, text: repeated }] },
    {
      path: 'testdata/description.txt',
      changes: [{ side: 'added', line: 1, text: `# ${'prose '.repeat(40)}` }],
    },
    { path: 'fixtures/settings.json', changes: [{ side: 'added', line: 1, text: `{"value":"${'x'.repeat(160)}"}` }] },
  ]);
  const duplicates = report.candidates.filter((candidate) => candidate.ruleId === 'SWEEP-105');

  assert.equal(duplicates.length, 2);
  assert(duplicates.every((candidate) => candidate.path === 'src/first.py'));
  assert.equal(report.candidates.some((candidate) => candidate.path.endsWith('.txt') || candidate.path.endsWith('.json')), false);
  assert.equal(duplicates.some((candidate) => candidate.line >= 11), false);
});

test('duplicate multi-line blocks are reported, and any findings are JavaScript or TypeScript only', () => {
  const block = [
    'const first = calculateFirstValue(input);',
    'const second = calculateSecondValue(input);',
    'return combineValues(first, second);',
  ];
  const changes = [
    ...block.map((text, index) => ({ side: 'added', line: index + 1, text })),
    ...block.map((text, index) => ({ side: 'added', line: index + 5, text })),
    { side: 'added', line: 9, text: 'const value = input as any;' },
    { side: 'added', line: 10, text: 'function accept(value: any) {' },
  ];
  const report = scan([
    { path: 'src/example.ts', changes },
    { path: 'src/example.py', changes: [{ side: 'added', line: 1, text: 'value = input as any' }] },
  ]);

  assert.equal(report.candidates.filter((candidate) => candidate.ruleId === 'SWEEP-105').length, 6);
  assert.equal(report.candidates.filter((candidate) => candidate.ruleId === 'SWEEP-107').length, 2);
  assert.equal(
    report.candidates.some((candidate) => candidate.path.endsWith('.py') && candidate.ruleId === 'SWEEP-107'),
    false,
  );
  assert.match(report.stderr, /scanning 9 added lines across 2 files/);
  assert.match(report.stderr, /Pass a base ref or adjust scan\.exclude/);
  assert.match(report.stderr, /found \d+ candidates/);
});

test('large diffs announce their size and suggest scoping', () => {
  const changes = Array.from({ length: 10000 }, (_, index) => ({
    side: 'added',
    line: index + 1,
    text: `value_${index} = ${index}`,
  }));
  const report = scan([{ path: 'src/large.py', changes }]);

  const largeDiffNotice = 'scanning 10,000 added lines across 1 file; large diffs may yield thousands of candidates';
  assert(report.stderr.includes(largeDiffNotice));
  assert.match(report.stderr, /Pass a base ref or adjust scan\.exclude/);
});