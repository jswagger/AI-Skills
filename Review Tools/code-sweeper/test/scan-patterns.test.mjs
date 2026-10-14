import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scannerPath = fileURLToPath(new URL('../scripts/scan-patterns.mjs', import.meta.url));

function scan(files, args = []) {
  const result = spawnSync(process.execPath, [scannerPath, ...args], {
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

  assert.equal(duplicates.length, 1);
  assert(duplicates.every((candidate) => candidate.path === 'src/first.py'));
  assert.equal(duplicates[0].occurrenceCount, 2);
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

  const duplicateBlocks = report.candidates.filter((candidate) => candidate.ruleId === 'SWEEP-105');
  assert.equal(duplicateBlocks.length, 1);
  assert.equal(duplicateBlocks[0].line, 1);
  assert.equal(duplicateBlocks[0].blockLength, 3);
  assert.equal(duplicateBlocks[0].occurrenceCount, 2);
  assert.equal(report.candidates.filter((candidate) => candidate.ruleId === 'SWEEP-107').length, 2);
  assert.equal(
    report.candidates.some((candidate) => candidate.path.endsWith('.py') && candidate.ruleId === 'SWEEP-107'),
    false,
  );
  assert.match(report.stderr, /scanning 9 added lines across 2 files/);
  assert.match(report.stderr, /Pass a base ref or adjust scan\.exclude/);
  assert.match(report.stderr, /found \d+ candidates/);
});

test('duplicate blocks collapse to one occurrence-aware candidate and suppress helper/side-effect repeats', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-sweeper-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'sagas.ts');
  const block = [
    'const firstValue = calculateFirst(input);',
    'const secondValue = calculateSecond(input);',
    'return combine(firstValue, secondValue);',
  ];
  const lines = [
    'const buildCustomerParams = (value: Input) => value;',
    'function firstSaga() {',
    'const params = buildCustomerParams({ customerGuid, orgGuid });',
    ...block,
    'yield put(listActions.setPanelLoading(false));',
    '}',
    'function secondSaga() {',
    'const params = buildCustomerParams({ customerGuid, orgGuid });',
    ...block,
    'yield put(listActions.setPanelLoading(false));',
    '}',
    'function thirdSaga() {',
    ...block,
    'yield put(listActions.setPanelLoading(false));',
    '}',
  ];
  writeFileSync(path, lines.join('\n'));
  const report = scan([{
    path,
    changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })),
  }]);
  const duplicates = report.candidates.filter((candidate) => candidate.ruleId === 'SWEEP-105');

  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].line, 4);
  assert.equal(duplicates[0].blockLength, 3);
  assert.equal(duplicates[0].occurrenceCount, 3);
  assert.equal(duplicates[0].enclosingFunctionChange, 'new');
  assert.equal(report.candidates.some((candidate) => /buildCustomerParams/.test(candidate.evidence)), false);
  assert.equal(report.candidates.some((candidate) => /setPanelLoading/.test(candidate.evidence)), false);
});

test('SWEEP-107 detects generic any, type assertions, and specific-to-any loosening', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-sweeper-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'types.ts');
  const lines = [
    '): Generator<any, void, any> => {',
    'type Result = Record<string, any>;',
    'const value = (fieldAcres as number);',
  ];
  writeFileSync(path, lines.join('\n'));
  const report = scan([{
    path,
    changes: [
      { side: 'removed', line: 1, text: '): Generator<PutEffect<any>, void, any> => {' },
      ...lines.map((text, index) => ({ side: 'added', line: index + 1, text })),
    ],
  }]);
  const candidates = report.candidates.filter((candidate) => candidate.ruleId === 'SWEEP-107');

  assert.equal(candidates.length, 3);
  assert(candidates.some((candidate) => candidate.signal === 'specific-type-replaced-with-any'));
  assert(candidates.some((candidate) => candidate.evidence.includes('Record<string, any>')));
  assert(candidates.some((candidate) => candidate.signal === 'type-assertion' && candidate.priority === 'lower'));
});

test('test heuristics flag trivial assertions, repeated any fixtures, and sibling test shapes', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-sweeper-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'panel.test.ts');
  const lines = [
    'it("only checks that fn exists and makes no behavioral assertions, so the descriptive title spells out what is missing and fails to verify any observable result", () => {',
    '  expect(typeof fn).toBe("function");',
    '});',
    'it("only checks that fn is defined", () => {',
    '  expect(fn).toBeDefined();',
    '});',
    'it("first case", () => {',
    '  const fixture = { value: 1 } as any;',
    '  const result = fn(fixture);',
    '  expect(result.ready).toBe(true);',
    '  expect(result.value).toBe(1);',
    '});',
    'it("second case", () => {',
    '  const fixture = { value: 1 } as any;',
    '  const result = fn(fixture);',
    '  expect(result.ready).toBe(true);',
    '  expect(result.value).toBe(1);',
    '});',
    'it("third case", () => {',
    '  const fixture = { value: 1 };',
    '  const result = fn(fixture);',
    '  expect(result.ready).toBe(true);',
    '  expect(result.value).toBe(1);',
    '});',
  ];
  writeFileSync(path, lines.join('\n'));
  const report = scan([{
    path,
    changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })),
  }]);
  const candidates = report.candidates.filter((candidate) => candidate.path === path);

  assert.equal(candidates.filter((candidate) => candidate.ruleId === 'SWEEP-108').length, 2);
  const duplicateFixtures = candidates.filter((candidate) => candidate.ruleId === 'SWEEP-109');
  assert.equal(duplicateFixtures.length, 1);
  assert.equal(duplicateFixtures[0].occurrenceCount, 2);
  const tableDriven = candidates.find((candidate) => candidate.ruleId === 'SWEEP-110');
  assert.equal(tableDriven?.occurrenceCount, 3);
  assert.match(tableDriven.description, /table-driven/);
  assert.equal(candidates.some((candidate) => candidate.ruleId === 'SWEEP-105'), false);
  assert.equal(candidates.some((candidate) => candidate.ruleId === 'SWEEP-101'), false);
});

test('candidate reports identify changed versus pre-existing enclosing functions', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-sweeper-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'functions.ts');
  const lines = [
    'function existingSaga() {',
    '  const value = calculateValue(input, includeMetadata=true);',
    '  const value = calculateValue(input, includeMetadata=true);',
    '}',
    'function newSaga() {',
    '  const value = calculateNewValue(input, includeMetadata=true);',
    '  const value = calculateNewValue(input, includeMetadata=true);',
    '}',
  ];
  writeFileSync(path, lines.join('\n'));
  const report = scan([{
    path,
    changes: [
      { side: 'added', line: 2, text: lines[1] },
      { side: 'added', line: 3, text: lines[2] },
      { side: 'added', line: 5, text: lines[4] },
      { side: 'added', line: 6, text: lines[5] },
      { side: 'added', line: 7, text: lines[6] },
    ],
  }]);
  const candidates = report.candidates.filter((candidate) => candidate.ruleId === 'SWEEP-105');

  assert.equal(candidates.length, 2);
  assert.equal(candidates.find((candidate) => candidate.enclosingFunction === 'existingSaga')
    ?.enclosingFunctionChange, 'existing');
  assert.equal(candidates.find((candidate) => candidate.enclosingFunction === 'newSaga')
    ?.enclosingFunctionChange, 'new');
});

test('file-size signal only reports oversized files that grow in the diff', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-sweeper-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'large.ts');
  const lines = Array.from({ length: 501 }, (_, index) => `const value${index} = ${index};`);
  writeFileSync(path, lines.join('\n'));
  const report = scan([{
    path,
    changes: [{ side: 'added', line: 501, text: lines[500] }],
  }]);
  assert(report.candidates.some((candidate) => candidate.ruleId === 'SWEEP-111'));

  const unchanged = scan([{
    path,
    changes: [
      { side: 'removed', line: 1, text: 'old line' },
      { side: 'added', line: 1, text: 'new line' },
    ],
  }]);
  assert.equal(unchanged.candidates.some((candidate) => candidate.ruleId === 'SWEEP-111'), false);
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

test('scanner preserves collection metadata and honors review-only arguments', () => {
  const report = scan([{
    path: 'src/example.ts',
    changes: [{ side: 'added', line: 1, text: 'const value = 1;' }],
  }], ['--no-fix']);

  assert.equal(report.autoFixEnabled, false);
  assert.equal(report.baseRef, undefined);
  assert.equal(report.excludedCount, 0);
});