import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const collectorPath = fileURLToPath(new URL('../collect-diff.mjs', import.meta.url));
const configPath = fileURLToPath(new URL('../../security-auditor/config.json', import.meta.url));

function git(directory, args) {
  execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
}

test('collector parses added, modified, and deleted Git paths', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-diff-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  writeFileSync(join(directory, 'delete.py'), 'value = 1\n');
  writeFileSync(join(directory, 'modify.py'), 'value = 1\n');
  git(directory, ['add', 'delete.py', 'modify.py']);
  git(directory, ['commit', '-qm', 'baseline']);

  rmSync(join(directory, 'delete.py'));
  writeFileSync(join(directory, 'modify.py'), 'value = 2\n');
  writeFileSync(join(directory, 'added.py'), 'value = 3\n');
  git(directory, ['add', '-A']);

  const result = spawnSync(process.execPath, [collectorPath, '--config', configPath, 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  const files = new Map(report.files.map((file) => [file.path, file]));
  assert.equal(files.get('added.py')?.status, 'added');
  assert.equal(files.get('modify.py')?.status, 'modified');
  assert.equal(files.get('delete.py')?.status, 'deleted');
  assert.equal(report.files.some((file) => file.path === 'ev/null'), false);
  assert.deepEqual(files.get('added.py').changes.map((change) => change.side), ['added']);
  assert.deepEqual(files.get('delete.py').changes.map((change) => change.side), ['removed']);
});

test('target refs compare from the merge base and retain working-tree changes', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-merge-base-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  writeFileSync(join(directory, 'base.py'), 'base_value = 1\n');
  git(directory, ['add', 'base.py']);
  git(directory, ['commit', '-qm', 'baseline']);
  const mergeBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

  git(directory, ['branch', 'target']);
  git(directory, ['checkout', '-q', 'target']);
  writeFileSync(join(directory, 'target_only.py'), 'target_value = 1\n');
  git(directory, ['add', 'target_only.py']);
  git(directory, ['commit', '-qm', 'target change']);

  git(directory, ['checkout', '-q', '-b', 'feature', mergeBase]);
  writeFileSync(join(directory, 'feature.py'), 'feature_value = 1\n');
  git(directory, ['add', 'feature.py']);
  git(directory, ['commit', '-qm', 'feature change']);
  writeFileSync(join(directory, 'working.py'), 'working_value = 1\n');

  const result = spawnSync(process.execPath, [collectorPath, '--config', configPath, 'target'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  const files = new Map(report.files.map((file) => [file.path, file]));
  assert.equal(report.comparisonBase, mergeBase);
  assert.equal(files.get('feature.py')?.status, 'added');
  assert.equal(files.get('working.py')?.status, 'untracked');
  assert.equal(files.has('target_only.py'), false);
});

test('configured origin/HEAD is used automatically and falls back to HEAD when absent', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'collect-auto-base-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.name', 'Code Review Tests']);
  git(directory, ['config', 'user.email', 'code-review-tests@example.invalid']);
  writeFileSync(join(directory, 'base.py'), 'value = 1\n');
  git(directory, ['add', 'base.py']);
  git(directory, ['commit', '-qm', 'baseline']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();

  const fallbackResult = spawnSync(process.execPath, [collectorPath, '--config', configPath], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(fallbackResult.status, 0, fallbackResult.stderr);
  const fallbackReport = JSON.parse(fallbackResult.stdout);
  assert.equal(fallbackReport.requestedBaseRef, 'origin/HEAD');
  assert.equal(fallbackReport.baseRef, 'HEAD');
  assert.equal(fallbackReport.comparisonBase, 'HEAD');
  assert.match(fallbackReport.note, /fell back/);

  git(directory, ['update-ref', 'refs/remotes/origin/main', head]);
  git(directory, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  writeFileSync(join(directory, 'changed.py'), 'value = 2\n');
  const detectedResult = spawnSync(process.execPath, [collectorPath, '--config', configPath], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(detectedResult.status, 0, detectedResult.stderr);
  const detectedReport = JSON.parse(detectedResult.stdout);
  assert.equal(detectedReport.requestedBaseRef, 'origin/HEAD');
  assert.equal(detectedReport.baseRef, 'origin/HEAD');
  assert.equal(detectedReport.comparisonBase, head);
});