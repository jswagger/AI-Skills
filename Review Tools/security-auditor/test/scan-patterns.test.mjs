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

test('Python security candidates include multiline exceptions and redact secrets', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'security-auditor-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'api.py');
  const lines = [
    'try:',
    '    work()',
    'except ValueError:',
    '    pass',
    'query = f"SELECT * FROM users WHERE id = {user_id}"',
    'token = random.choice(alphabet)',
    'session = uuid.uuid1()',
    'cipher = AES.MODE_CBC',
    'password = os.getenv("PASSWORD") or "fallback-secret"',
    'settings = {"password": "dictionary-secret"}',
    'url = "postgresql://alice:connection-secret@db.internal/app"',
    'subprocess.run(command, shell=True)',
    'exec(user_input)',
    'unsafe = yaml.load(raw)',
    'response = jsonify({"error": str(exc)})',
    'logging.info("request", request.json)',
    'requests.get(url, verify=False)',
    'safe = yaml.load(doc, Loader=yaml.SafeLoader)',
  ];
  writeFileSync(path, lines.join('\n'));

  const report = scan([{
    path,
    changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })),
  }]);
  const candidates = report.candidates;
  const hasRule = (ruleId) => candidates.some((candidate) => candidate.ruleId === ruleId);

  for (const ruleId of [
    'CRIT-101', 'CRIT-104', 'CRIT-105', 'CRIT-106', 'CRIT-107', 'CRIT-201',
    'CRIT-202', 'CRIT-203', 'CRIT-301', 'CRIT-302', 'CRIT-303',
  ]) {
    assert.equal(hasRule(ruleId), true, `${ruleId} should match the Python fixture`);
  }

  assert.equal(candidates.some((candidate) => candidate.ruleId === 'CRIT-106' && candidate.line === 18), false);
  assert(candidates.filter((candidate) => candidate.ruleId === 'CRIT-201')
    .every((candidate) => candidate.evidence === '[possible secret value omitted]'));
  assert.equal(JSON.stringify(candidates).includes('fallback-secret'), false);
  assert.equal(JSON.stringify(candidates).includes('connection-secret'), false);
});

test('top-level Python test paths are lower-confidence and removed controls are surfaced', () => {
  const report = scan([{
    path: 'test/test_auth.py',
    changes: [
      { side: 'added', line: 1, text: 'except Exception:' },
      { side: 'added', line: 2, text: '    pass' },
      { side: 'removed', line: 3, text: 'validate_request(user)' },
    ],
  }]);

  assert(report.candidates.some((candidate) =>
    candidate.ruleId === 'CRIT-301' && candidate.confidence === 'lower'));
  assert(report.candidates.some((candidate) =>
    candidate.ruleId === 'REG-401'
      && candidate.side === 'removed'
      && candidate.confidence === 'lower'));
  assert.equal(report.coverage.python.changedFiles, 1);
});

test('infrastructure rules flag public ingress and risky workload settings', () => {
  const report = scan([{
    path: 'terraform/main.tf',
    changes: [
      { side: 'added', line: 1, text: 'cidr_blocks = ["0.0.0.0/0"]' },
      { side: 'added', line: 2, text: 'ipv6_cidr_blocks = ["::/0"]' },
      { side: 'added', line: 3, text: 'publicly_accessible = true' },
      { side: 'added', line: 4, text: 'privileged: true' },
      { side: 'added', line: 5, text: 'storage_encrypted = false' },
      { side: 'added', line: 6, text: 'Action = "*"' },
    ],
  }]);
  const ruleIds = new Set(report.candidates.map((candidate) => candidate.ruleId));

  for (const ruleId of ['ARCH-403', 'ARCH-405', 'ARCH-406', 'ARCH-407', 'ARCH-408']) {
    assert(ruleIds.has(ruleId), `${ruleId} should match infrastructure settings`);
  }
  assert.equal(report.coverage.infrastructure.changedFiles, 1);
});

test('SQL f-strings produce one contextual low-confidence candidate per changed string', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'security-sql-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'sql.py');
  const lines = [
    'query = f"""SELECT * FROM users',
    'WHERE id IN ({placeholders})',
    '"""',
    'constant_query = f"SELECT * FROM users {CONSTANT_FILTER}"',
  ];
  writeFileSync(path, lines.join('\n'));
  const report = scan([{
    path,
    changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })),
  }]);
  const candidates = report.candidates.filter((candidate) => candidate.ruleId === 'CRIT-101');

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.line), [1, 4]);
  assert(candidates.every((candidate) => candidate.confidence === 'lower'));
  assert(candidates.every((candidate) => /placeholders|fixed SQL structure/.test(candidate.description)));
});

test('C# changes use C# rules and do not flag LINQ Select projections as SQL', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'security-csharp-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const path = join(directory, 'Controller.cs');
  const lines = [
    'var items = values.Select(value => new { value.Id });',
    'var command = new SqlCommand($"SELECT * FROM users WHERE id = {userId}", connection);',
    'var rows = connection.Query("SELECT * FROM users WHERE id = " + userId);',
    'var formatter = new BinaryFormatter();',
    'settings.TypeNameHandling = TypeNameHandling.All;',
    '[AllowAnonymous]',
    'ServicePointManager.ServerCertificateValidationCallback += (_, _, _, _) => true;',
    'Process.Start(fileName, arguments);',
    'var unsafeYaml = yaml.load(input);',
    'subprocess.run(command, shell=True);',
  ];
  writeFileSync(path, lines.join('\n'));
  const report = scan([{
    path,
    changes: lines.map((text, index) => ({ side: 'added', line: index + 1, text })),
  }]);
  const candidates = report.candidates;
  const ruleIds = new Set(candidates.map((candidate) => candidate.ruleId));

  assert.equal(report.coverage.csharp.changedFiles, 1);
  assert.deepEqual(report.coverage.detectedLanguages, ['csharp']);
  assert.equal(candidates.some((candidate) => candidate.ruleId === 'CRIT-101' && candidate.line === 1), false);
  assert.deepEqual(candidates.filter((candidate) => candidate.ruleId === 'CRIT-101').map((candidate) => candidate.line), [2, 3]);
  for (const ruleId of ['CRIT-101', 'CRIT-108', 'CRIT-109', 'CRIT-110', 'CRIT-111', 'CRIT-112']) {
    assert(ruleIds.has(ruleId), `${ruleId} should match the C# fixture`);
  }
  for (const ruleId of ['CRIT-104', 'CRIT-106', 'CRIT-107']) {
    assert.equal(ruleIds.has(ruleId), false, `${ruleId} should not run on C# files`);
  }
});

test('testdata fixtures are excluded without hiding source JSON policies', () => {
  const report = scan([
    { path: 'testdata/nested/description.txt', changes: [{ side: 'added', line: 1, text: 'verify=False' }] },
    { path: 'testdata/payload.json', changes: [{ side: 'added', line: 1, text: 'verify=False' }] },
    { path: 'policies/access.json', changes: [{ side: 'added', line: 1, text: 'Action = "*"' }] },
  ]);

  assert.equal(report.candidates.some((candidate) => candidate.path.startsWith('testdata/')), false);
  assert(report.candidates.some((candidate) => candidate.path === 'policies/access.json'));
});