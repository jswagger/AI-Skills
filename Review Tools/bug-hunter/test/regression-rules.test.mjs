import assert from 'node:assert/strict';
import test from 'node:test';
import { groupHunks, isTrivialHunk, isWholeDeclarationRemoval } from '../scripts/lib/hunks.mjs';
import { analyzeHunk, parseSignature } from '../scripts/lib/rules-regression.mjs';

const removed = (line, text) => ({ side: 'removed', line, text });
const added = (line, text) => ({ side: 'added', line, text });

function analyze(changes, language = 'javascript', isTest = false) {
  return groupHunks(changes)
    .filter((hunk) => !isTrivialHunk(hunk))
    .flatMap((hunk) => analyzeHunk(hunk, { language, isTest }));
}

const rulesOf = (findings) => findings.map((finding) => finding.rule);

// --- hunks ---------------------------------------------------------------------------------

test('groupHunks pairs a removed run with the added run that follows it', () => {
  const hunks = groupHunks([removed(10, 'a'), removed(11, 'b'), added(10, 'c'), added(11, 'd')]);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].removed.length, 2);
  assert.equal(hunks[0].added.length, 2);
});

test('groupHunks splits on line-number gaps and on added-to-removed transitions', () => {
  assert.equal(groupHunks([added(1, 'a'), added(2, 'b'), added(9, 'c')]).length, 2);
  assert.equal(groupHunks([removed(1, 'a'), added(1, 'b'), removed(7, 'c'), added(7, 'd')]).length, 2);
  assert.deepEqual(groupHunks([]), []);
});

test('isTrivialHunk ignores comments, imports, blank lines and whitespace-only rewrites', () => {
  const trivial = (changes) => isTrivialHunk(groupHunks(changes)[0]);
  assert.equal(trivial([added(1, '// explain'), added(2, '')]), true);
  assert.equal(trivial([added(1, "import { x } from './x';")]), true);
  assert.equal(trivial([added(1, 'using System.Linq;')]), true);
  assert.equal(trivial([removed(4, 'const a=1;'), added(4, 'const a = 1;')]), true);
  assert.equal(trivial([added(1, 'doWork();')]), false);
});

test('isWholeDeclarationRemoval recognizes a deleted function body only', () => {
  const deleted = groupHunks([
    removed(1, 'function old(x) {'), removed(2, '  if (x == null) return;'), removed(3, '  work(x);'), removed(4, '}'),
  ])[0];
  assert.equal(isWholeDeclarationRemoval(deleted), true);
  const edited = groupHunks([removed(2, '  if (x == null) return;'), added(2, '  work(x);')])[0];
  assert.equal(isWholeDeclarationRemoval(edited), false);
});

// --- REMOVED_GUARD ---------------------------------------------------------------------------

test('REMOVED_GUARD flags a removed null check in JavaScript', () => {
  const findings = analyze([removed(5, '  if (user === null) return;'), added(5, '  render(user);')]);
  assert.deepEqual(rulesOf(findings), ['REMOVED_GUARD']);
  assert.equal(findings[0].line, 5);
  assert.match(findings[0].snippet, /user === null/);
});

test('REMOVED_GUARD flags optional chaining replaced by a plain property access', () => {
  const findings = analyze([removed(3, 'const n = user?.name;'), added(3, 'const n = user.name;')]);
  assert.ok(rulesOf(findings).includes('REMOVED_GUARD'));
});

test('REMOVED_GUARD stays quiet when the guard is rewritten, not removed', () => {
  const findings = analyze([removed(5, '  if (user === null) return;'), added(5, '  if (user == null) return;')]);
  assert.equal(findings.some((finding) => finding.rule === 'REMOVED_GUARD'), false);
});

test('REMOVED_GUARD supports Python and C# guards', () => {
  assert.deepEqual(rulesOf(analyze([removed(2, '    if item is None:'), added(2, '    use(item)')], 'python')), ['REMOVED_GUARD']);
  assert.deepEqual(rulesOf(analyze([removed(2, '        if (order == null) return;'), added(2, '        Process(order);')], 'csharp')), ['REMOVED_GUARD']);
});

test('REMOVED_GUARD ignores removed comments and deleted whole functions', () => {
  assert.deepEqual(analyze([removed(1, '// if (x === null) handle')]), []);
  const deleted = [
    removed(1, 'function old(x) {'), removed(2, '  if (x === null) return;'), removed(3, '  try { go(); } catch (e) {}'), removed(4, '}'),
  ];
  assert.deepEqual(analyze(deleted), []);
});

// --- REMOVED_AWAIT / REMOVED_ERROR_HANDLING --------------------------------------------------

test('REMOVED_AWAIT flags a dropped await and ignores a moved one', () => {
  assert.deepEqual(rulesOf(analyze([removed(8, '  const r = await load();'), added(8, '  const r = load();')])), ['REMOVED_AWAIT']);
  assert.deepEqual(analyze([removed(8, '  const r = await load(a);'), added(8, '  const r = await load(a, b);')]).filter((f) => f.rule === 'REMOVED_AWAIT'), []);
});

test('REMOVED_ERROR_HANDLING flags removed try/catch and except blocks', () => {
  const js = analyze([removed(4, '  try {'), removed(5, '  } catch (e) {'), added(4, '  run();')]);
  assert.equal(js.filter((f) => f.rule === 'REMOVED_ERROR_HANDLING').length, 2);
  assert.deepEqual(rulesOf(analyze([removed(4, '    except ValueError:'), added(4, '    pass_through()')], 'python')), ['REMOVED_ERROR_HANDLING']);
});

test('REMOVED_ERROR_HANDLING is quiet when handling is kept', () => {
  const findings = analyze([removed(4, '  } catch (e) {'), added(4, '  } catch (err) {')]);
  assert.equal(findings.some((f) => f.rule === 'REMOVED_ERROR_HANDLING'), false);
});

// --- tests -----------------------------------------------------------------------------------

test('REMOVED_TEST_ASSERTION only applies to test files', () => {
  const change = [removed(9, '  expect(total).toBe(10);'), added(9, '  doThing();')];
  assert.deepEqual(rulesOf(analyze(change, 'javascript', true)), ['REMOVED_TEST_ASSERTION']);
  assert.deepEqual(rulesOf(analyze(change, 'javascript', false)), []);
});

test('TEST_DISABLED flags skipped, focused and ignored tests', () => {
  assert.deepEqual(rulesOf(analyze([added(3, "  it.skip('works', () => {});")], 'javascript', true)), ['TEST_DISABLED']);
  assert.deepEqual(rulesOf(analyze([added(3, '    [Ignore]')], 'csharp', true)), ['TEST_DISABLED']);
  assert.deepEqual(rulesOf(analyze([added(3, '@pytest.mark.skip')], 'python', true)), ['TEST_DISABLED']);
  assert.deepEqual(analyze([added(3, "  it('works', () => {});")], 'javascript', true), []);
});

// --- BEHAVIOR_CHANGE_PAIR --------------------------------------------------------------------

test('BEHAVIOR_CHANGE_PAIR flags operator, literal, boolean and negation flips', () => {
  const pair = (before, after, language = 'javascript') => analyze([removed(1, before), added(1, after)], language);
  assert.match(pair('if (count < limit) {', 'if (count <= limit) {')[0].message, /comparison changed from `<` to `<=`/);
  assert.match(pair('const retries = 3;', 'const retries = 0;')[0].message, /number changed/);
  assert.match(pair('enabled = True', 'enabled = False', 'python')[0].message, /boolean changed/);
  assert.match(pair('if (a && b) {', 'if (a || b) {')[0].message, /logical changed/);
  assert.match(pair('if (isReady) {', 'if (!isReady) {')[0].message, /negation `!` added/);
  assert.match(pair('if not ready:', 'if ready:', 'python')[0].message, /negation `not` removed/);
  assert.match(pair('return total + fee;', 'return total - fee;')[0].message, /arithmetic changed/);
});

test('a paired change replaces the less specific guard finding on the same line', () => {
  const findings = analyze([removed(2, '    if not ready:'), added(2, '    if ready:')], 'python');
  assert.deepEqual(rulesOf(findings), ['BEHAVIOR_CHANGE_PAIR']);
});

test('BEHAVIOR_CHANGE_PAIR ignores renames, string edits, multi-token edits and version lines', () => {
  const pair = (before, after) => analyze([removed(1, before), added(1, after)]).filter((f) => f.rule === 'BEHAVIOR_CHANGE_PAIR');
  assert.deepEqual(pair('const total = sum(a);', 'const sum2 = sum(a);'), []);
  assert.deepEqual(pair("log('start');", "log('begin');"), []);
  assert.deepEqual(pair('if (a < b && c) {', 'if (a <= b || c) {'), []);
  assert.deepEqual(pair('const version = 1;', 'const version = 2;'), []);
});

test('BEHAVIOR_CHANGE_PAIR requires the removed and added counts to match', () => {
  const findings = analyze([removed(1, 'if (a < b) {'), added(1, 'if (a <= b) {'), added(2, 'extra();')]);
  assert.equal(findings.some((f) => f.rule === 'BEHAVIOR_CHANGE_PAIR'), false);
});

// --- SIGNATURE_CHANGED -----------------------------------------------------------------------

test('parseSignature extracts names and normalizes parameters for each language', () => {
  assert.equal(parseSignature('export async function load(id, opts) {', 'javascript').name, 'load');
  assert.equal(parseSignature('const save = async (a: string) => {', 'typescript').name, 'save');
  assert.equal(parseSignature('    def process(self, batch=None):', 'python').name, 'process');
  assert.equal(parseSignature('    public async Task<User> GetUser(int id)', 'csharp').name, 'GetUser');
  assert.equal(parseSignature('if (x) {', 'javascript'), undefined);
  assert.equal(parseSignature('    public async foo(a) {', 'typescript').exported, true);
});

test('SIGNATURE_CHANGED reports a changed parameter list with the symbol name', () => {
  const findings = analyze([removed(2, 'export function load(id) {'), added(2, 'export function load(id, opts) {')]);
  assert.deepEqual(rulesOf(findings), ['SIGNATURE_CHANGED']);
  assert.equal(findings[0].symbol, 'load');
  assert.equal(findings[0].confidence, 'low');
});

test('SIGNATURE_CHANGED reports removed or renamed public symbols but not private ones', () => {
  assert.equal(analyze([removed(2, 'export function oldName(a) {'), added(2, 'export function newName(a) {')])[0].symbol, 'oldName');
  assert.deepEqual(analyze([removed(2, 'function helper(a) {'), added(2, 'function helper2(a) {')]), []);
});

test('SIGNATURE_CHANGED is quiet when only the body or whitespace of the signature changed', () => {
  assert.deepEqual(analyze([removed(2, 'export function load(id,opts) {'), added(2, 'export function load(id, opts) {')]), []);
});

test('SIGNATURE_CHANGED survives a whole-function deletion', () => {
  const findings = analyze([
    removed(1, 'export function gone(a) {'), removed(2, '  if (a === null) return;'), removed(3, '  work(a);'), removed(4, '}'),
  ]);
  assert.deepEqual(rulesOf(findings), ['SIGNATURE_CHANGED']);
});

// --- REMOVED_CLEANUP -------------------------------------------------------------------------

test('REMOVED_CLEANUP flags removed unsubscribe, timer, dispose and using/with cleanup', () => {
  const cleanup = (removedText, language) => rulesOf(analyze([removed(6, removedText), added(6, '  noop();')], language));
  assert.deepEqual(cleanup('    return () => window.removeEventListener("resize", onResize);'), ['REMOVED_CLEANUP']);
  assert.deepEqual(cleanup('    clearInterval(timer);'), ['REMOVED_CLEANUP']);
  assert.deepEqual(cleanup('        connection.Dispose();', 'csharp'), ['REMOVED_CLEANUP']);
  assert.deepEqual(cleanup('        using var stream = File.OpenRead(path);', 'csharp'), ['REMOVED_CLEANUP']);
  assert.deepEqual(cleanup('    with open(path) as handle:', 'python'), ['REMOVED_CLEANUP']);
});

test('REMOVED_CLEANUP ignores cleanup that is replaced, or removed together with its setup', () => {
  const replaced = analyze([removed(6, '    clearInterval(timer);'), added(6, '    clearInterval(newTimer);')]);
  assert.equal(replaced.some((f) => f.rule === 'REMOVED_CLEANUP'), false);

  const featureRemoved = analyze([
    removed(6, '    window.addEventListener("resize", onResize);'),
    removed(7, '    return () => window.removeEventListener("resize", onResize);'),
    added(6, '    init();'),
  ]);
  assert.equal(featureRemoved.some((f) => f.rule === 'REMOVED_CLEANUP'), false);
});

// --- REMOVED_EARLY_EXIT ----------------------------------------------------------------------

test('REMOVED_EARLY_EXIT is a low-confidence hint for a dropped conditional exit', () => {
  const findings = analyze([removed(4, '  if (items.length === 0) continue;'), added(4, '  process(items);')]);
  assert.deepEqual(rulesOf(findings), ['REMOVED_EARLY_EXIT']);
  assert.equal(findings[0].confidence, 'low');
});

test('REMOVED_EARLY_EXIT is quiet when exits are rewritten, and does not duplicate a guard finding', () => {
  assert.deepEqual(analyze([removed(4, '  return a;'), added(4, '  return b;')]), []);
  const findings = analyze([removed(4, '  if (x === null) return;'), added(4, '  go(x);')]);
  assert.deepEqual(rulesOf(findings), ['REMOVED_GUARD']);
});

// --- contract changes ------------------------------------------------------------------------

test('SIGNATURE_CHANGED flags a sync to async flip as contract-breaking', () => {
  const findings = analyze([removed(2, 'export function load(id) {'), added(2, 'export async function load(id) {')]);
  assert.deepEqual(rulesOf(findings), ['SIGNATURE_CHANGED']);
  assert.equal(findings[0].severity, 'MEDIUM');
  assert.match(findings[0].message, /now async/);
});

test('SIGNATURE_CHANGED flags a changed return type in TypeScript, Python and C#', () => {
  const ts = analyze([removed(2, 'export function load(id): User {'), added(2, 'export function load(id): User | null {')], 'typescript');
  assert.match(ts[0].message, /return type/);
  const py = analyze([removed(2, 'def load(id) -> dict:'), added(2, 'def load(id) -> User:')], 'python');
  assert.match(py[0].message, /return type/);
  const cs = analyze([removed(2, '    public User GetUser(int id)'), added(2, '    public Task<User> GetUserAsync(int id)')], 'csharp');
  assert.equal(cs[0].symbol, 'GetUser');
  const csSameName = analyze([removed(2, '    public User GetUser(int id)'), added(2, '    public async Task<User> GetUser(int id)')], 'csharp');
  assert.match(csSameName[0].message, /now async, return type/);
});

test('SIGNATURE_CHANGED flags removed exported classes, types and enums but not private or unchanged ones', () => {
  assert.equal(analyze([removed(1, 'export interface UserDto {')])[0].symbol, 'UserDto');
  assert.equal(analyze([removed(1, 'public enum Status')], 'csharp')[0].symbol, 'Status');
  assert.equal(analyze([removed(1, 'class Handler:')], 'python')[0].symbol, 'Handler');
  assert.deepEqual(analyze([removed(1, 'class _Internal:')], 'python'), []);
  assert.deepEqual(analyze([removed(1, 'export interface UserDto {'), added(1, 'export interface UserDto {')]), []);
});
