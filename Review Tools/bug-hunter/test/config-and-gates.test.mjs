import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { languageForPath, normalizeConfig, parseArgs } from '../scripts/lib/common.mjs';
import { checkDiffSize } from '../scripts/check-diff-size.mjs';
import { gatherRepositoryContext, gatherTicketContext } from '../scripts/gather-context.mjs';

function tempDir(context) {
  const dir = mkdtempSync(join(tmpdir(), 'bug-hunter-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, relativePath, content) {
  const path = join(dir, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

const lines = (count) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

test('normalizeConfig applies defaults and keeps autoFix off unless explicitly enabled', () => {
  const config = normalizeConfig({});
  assert.equal(config.autoFix, false);
  assert.equal(config.repositoryContext, null);
  assert.equal(config.diff.maxDiffBytes, 102400);
  assert.equal(normalizeConfig({ autoFix: true }).autoFix, true);
});

test('normalizeConfig fills context defaults and rejects invalid settings', () => {
  const config = normalizeConfig({ repositoryContext: { fileNames: ['CLAUDE.md'] }, ticketContext: { path: 'x' } });
  assert.equal(config.repositoryContext.maxLinesPerFile, 500);
  assert.equal(config.ticketContext.maxLines, 500);
  assert.throws(() => normalizeConfig({ autoFix: 'yes' }), /autoFix/);
  assert.throws(() => normalizeConfig({ diff: { maxDiffBytes: 0 } }), /maxDiffBytes/);
  assert.throws(() => normalizeConfig({ repositoryContext: { fileNames: [] } }), /fileNames/);
});

test('parseArgs handles value flags, boolean flags and positionals', () => {
  const { flags, positionals } = parseArgs(['--config', 'c.json', 'origin/main', '--verbose'], ['verbose']);
  assert.deepEqual(flags, { config: 'c.json', verbose: true });
  assert.deepEqual(positionals, ['origin/main']);
  assert.throws(() => parseArgs(['--config']), /Missing value/);
});

test('languageForPath maps supported extensions', () => {
  assert.equal(languageForPath('a/b.tsx'), 'typescript');
  assert.equal(languageForPath('a/b.mjs'), 'javascript');
  assert.equal(languageForPath('Svc.cs'), 'csharp');
  assert.equal(languageForPath('x.py'), 'python');
  assert.equal(languageForPath('x.rb'), undefined);
});

test('checkDiffSize passes small diffs and warns with the largest files for big ones', () => {
  const collected = {
    files: [
      { path: 'small.js', changes: [{ side: 'added', line: 1, text: 'abc' }] },
      { path: 'big.js', changes: [{ side: 'added', line: 1, text: 'x'.repeat(5000) }] },
    ],
  };
  const ok = checkDiffSize(collected, 10000);
  assert.equal(ok.exceeded, false);
  assert.equal(ok.warning, null);

  const over = checkDiffSize(collected, 1000);
  assert.equal(over.exceeded, true);
  assert.match(over.warning, /large number of tokens/);
  assert.equal(over.largestFiles[0].path, 'big.js');
});

test('repository context is skipped when settings are null', () => {
  assert.deepEqual(gatherRepositoryContext(['a.js'], null), { enabled: false, files: [], notes: [] });
});

test('repository context uses only the file folder and its parent (nearest neighbor)', (context) => {
  const root = tempDir(context);
  write(root, 'CLAUDE.md', 'root rules');
  write(root, 'src/CLAUDE.md', 'src rules');
  write(root, 'src/feature/CLAUDE.md', 'feature rules');
  write(root, 'src/feature/deep/CLAUDE.md', 'deep rules');
  write(root, 'src/feature/deep/file.js', '');

  const result = gatherRepositoryContext(
    ['src/feature/deep/file.js'],
    { fileNames: ['CLAUDE.md'], maxLinesPerFile: 500, maxTotalLines: 1500 },
    root,
  );
  assert.deepEqual(result.files.map((file) => file.path).sort(), [
    'src/feature/CLAUDE.md',
    'src/feature/deep/CLAUDE.md',
  ]);
});

test('repository context dedupes shared neighbors and honors per-file and total caps', (context) => {
  const root = tempDir(context);
  write(root, 'a/CLAUDE.md', lines(800));
  write(root, 'b/CLAUDE.md', lines(100));
  const settings = { fileNames: ['CLAUDE.md'], maxLinesPerFile: 500, maxTotalLines: 550 };

  const result = gatherRepositoryContext(['a/one.js', 'a/two.js', 'b/three.js'], settings, root);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].truncated, true);
  assert.equal(result.files[0].content.split('\n').length, 500);
  assert.equal(result.files[1].content.split('\n').length, 50);
  assert.equal(result.totalLines, 550);
});

test('repository context never reads above the repository root', (context) => {
  const root = tempDir(context);
  write(root, 'top.js', '');
  write(join(root, '..'), 'CLAUDE.md', 'outside the repo');
  context.after(() => rmSync(join(root, '..', 'CLAUDE.md'), { force: true }));
  const result = gatherRepositoryContext(['top.js'], { fileNames: ['CLAUDE.md'], maxLinesPerFile: 500, maxTotalLines: 1500 }, root);
  assert.equal(result.files.length, 0);
});

test('ticket context is skipped when settings are null', () => {
  assert.equal(gatherTicketContext(null).enabled, false);
});

test('ticket context matches by name with .md preferred over .txt', (context) => {
  const dir = tempDir(context);
  write(dir, 'HW-123.txt', 'text ticket');
  assert.equal(gatherTicketContext({ path: dir, ticketName: 'HW-123', maxLines: 500 }).content, 'text ticket');
  write(dir, 'HW-123.md', 'markdown ticket');
  assert.equal(gatherTicketContext({ path: dir, ticketName: 'HW-123', maxLines: 500 }).content, 'markdown ticket');
});

test('ticket context truncates, supports a CLI override, and reports a missing ticket', (context) => {
  const dir = tempDir(context);
  write(dir, 'HW-9.md', lines(600));
  const settings = { path: dir, ticketName: 'OLD-1', maxLines: 500 };

  const overridden = gatherTicketContext(settings, 'HW-9');
  assert.equal(overridden.found, true);
  assert.equal(overridden.truncated, true);
  assert.equal(overridden.content.split('\n').length, 500);

  const missing = gatherTicketContext(settings);
  assert.equal(missing.found, false);
  assert.match(missing.notes[0], /No OLD-1\.md or OLD-1\.txt/);
});

test('ticket context rejects names that try to escape the ticket folder', (context) => {
  const dir = tempDir(context);
  const result = gatherTicketContext({ path: dir, ticketName: '../secret', maxLines: 500 });
  assert.equal(result.found, false);
});
