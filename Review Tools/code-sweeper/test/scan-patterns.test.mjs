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
  return JSON.parse(result.stdout);
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

test('duplicate statements are scoped per file and ignore boilerplate and data files', () => {
  const repeated = 'result = calculate_value(input_data)';
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
});