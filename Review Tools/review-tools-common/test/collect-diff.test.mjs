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