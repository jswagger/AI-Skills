import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_HUNK_LINES, buildPackets } from '../scripts/build-packets.mjs';

const removed = (line, text) => ({ side: 'removed', line, text });
const added = (line, text) => ({ side: 'added', line, text });
const file = (path, changes, status = 'modified') => ({ path, status, changes });
const isTestFile = (path) => /\.test\./.test(path);
const numbered = (count) => Array.from({ length: count }, (_, i) => `line${i + 1}`);

function build(files, { findings = [], callers, sources = {}, contextLines = 2, budgetBytes } = {}) {
  return buildPackets(
    { comparisonBase: 'abc', files },
    { script_findings: findings, signals: { logicChangedWithoutTests: false } },
    callers,
    { contextLines, isTestFile, readLines: (path) => sources[path], budgetBytes },
  );
}

test('a packet is one numbered unified view with context, additions and removals in place', () => {
  const source = numbered(10);
  source[4] = 'newFive';
  const result = build([file('a.js', [removed(5, 'oldFive'), added(5, 'newFive')])], { sources: { 'a.js': source } });
  const [packet] = result.packets;
  assert.deepEqual(packet.range, { start: 3, end: 7 });
  assert.equal(packet.diff, [
    ' 3  line3',
    ' 4  line4',
    '-5  oldFive',
    '+5  newFive',
    ' 6  line6',
    ' 7  line7',
  ].join('\n'));
});

test('trivial hunks produce no packets', () => {
  const result = build([file('a.js', [added(1, '// note'), added(2, "import x from 'x';")])], { sources: { 'a.js': numbered(5) } });
  assert.deepEqual(result.packets, []);
});

test('nearby hunks in a file merge into one packet; distant hunks stay separate', () => {
  const source = numbered(60);
  const near = build([file('a.js', [added(10, 'x'), added(14, 'y')])], { sources: { 'a.js': source } });
  assert.equal(near.packets.length, 1);
  const far = build([file('a.js', [added(10, 'x'), added(40, 'y')])], { sources: { 'a.js': source } });
  assert.equal(far.packets.length, 2);
});

test('a pure deletion is placed using the offset from earlier hunks', () => {
  const source = numbered(12);
  // Two lines added at 2-3 shift later content down by two, so old line 6 sits at new position 8.
  const result = build([file('a.js', [added(2, 'p'), added(3, 'q'), removed(6, 'gone')])], { sources: { 'a.js': source }, contextLines: 1 });
  const deletion = result.packets.find((packet) => packet.diff.includes('gone'));
  const rows = deletion.diff.split('\n');
  const goneIndex = rows.findIndex((row) => row.includes('gone'));
  assert.match(rows[goneIndex + 1], /\s8\s+line8/);
});

test('a deleted file shows only removed lines and flags the missing source', () => {
  const result = build([file('old.js', [removed(1, 'export function x() {'), removed(2, '}')], 'deleted')], {});
  const [packet] = result.packets;
  assert.equal(packet.sourceUnavailable, true);
  assert.equal(packet.diff, '-1  export function x() {\n-2  }');
});

test('findings attach to the packet that owns their line, with enclosing function and callers', () => {
  const source = ['export function load(id) {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}'];
  const finding = {
    file: 'a.js', rule: 'SIGNATURE_CHANGED', severity: 'LOW', confidence: 'low', line: 3, side: 'added', symbol: 'load', message: 'm',
  };
  const callers = { callers: [{ symbol: 'load', totalReferences: 1, truncated: false, references: [{ file: 'b.js', line: 2, text: 'load(1)', isTest: false }] }] };
  const result = build([file('a.js', [added(3, 'const b = 3;')])], { findings: [finding], callers, sources: { 'a.js': source } });
  const [packet] = result.packets;
  assert.equal(packet.enclosing.name, 'load');
  assert.deepEqual(packet.findings.map((f) => f.rule), ['SIGNATURE_CHANGED']);
  assert.equal(packet.callers[0].symbol, 'load');
  assert.ok(packet.risk.reasons.some((reason) => reason.includes('outside caller')));
});

test('packets rank by risk: high-confidence findings outrank hints and plain additions', () => {
  const finding = (rule, severity, confidence, file, line) => ({ file, rule, severity, confidence, line, side: 'added', message: 'm' });
  const sources = { 'plain.js': numbered(5), 'hint.js': numbered(5), 'bug.js': numbered(5) };
  const result = build([
    file('plain.js', [added(2, 'x')]),
    file('hint.js', [added(2, 'x')]),
    file('bug.js', [removed(2, 'a'), added(2, 'b')]),
  ], { sources, findings: [finding('REMOVED_GUARD', 'MEDIUM', 'high', 'bug.js', 2), finding('REMOVED_EARLY_EXIT', 'LOW', 'low', 'hint.js', 2)] });
  assert.deepEqual(result.packets.map((packet) => packet.file), ['bug.js', 'hint.js', 'plain.js']);
  assert.equal(result.packets[0].id, 'P1');
});

test('test-file packets score lower than the same change in production code', () => {
  const sources = { 'a.js': numbered(5), 'a.test.js': numbered(5) };
  const result = build([file('a.js', [removed(2, 'a'), added(2, 'b')]), file('a.test.js', [removed(2, 'a'), added(2, 'b')])], { sources });
  const score = (path) => result.packets.find((packet) => packet.file === path).risk.score;
  assert.ok(score('a.js') > score('a.test.js'));
});

test('a byte budget keeps the highest-risk packets and lists what was omitted', () => {
  const sources = { 'risky.js': numbered(30), 'quiet.js': numbered(30) };
  const finding = { file: 'risky.js', rule: 'REMOVED_GUARD', severity: 'MEDIUM', confidence: 'high', line: 5, side: 'added', message: 'm' };
  const files = [file('quiet.js', [added(5, 'x')]), file('risky.js', [removed(5, 'a'), added(5, 'b')])];
  const full = build(files, { sources, findings: [finding] });
  assert.equal(full.mode, 'full');

  const limited = build(files, { sources, findings: [finding], budgetBytes: 700 });
  assert.equal(limited.mode, 'high-risk-only');
  assert.deepEqual(limited.packets.map((packet) => packet.file), ['risky.js']);
  assert.equal(limited.omitted[0].file, 'quiet.js');
  assert.equal(limited.budget.packetsOmitted, 1);
});

test('the budget never drops the single highest-risk packet even when it alone exceeds the budget', () => {
  const result = build([file('a.js', [added(1, 'x')])], { sources: { 'a.js': numbered(5) }, budgetBytes: 10 });
  assert.equal(result.packets.length, 1);
});

test('very large additions are truncated and flagged', () => {
  const lines = Array.from({ length: MAX_HUNK_LINES + 50 }, (_, i) => added(i + 1, `row${i + 1}`));
  const result = build([file('new.js', lines, 'untracked')], { sources: { 'new.js': lines.map((line) => line.text) }, contextLines: 0 });
  assert.equal(result.packets[0].truncated, true);
  assert.equal(result.packets[0].diff.split('\n').length, MAX_HUNK_LINES);
});
