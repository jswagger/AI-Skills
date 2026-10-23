import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findLongJsFunctions } from '../scripts/function-length.mjs';

const body = (count) => Array.from({ length: count }, (_, index) => `  step${index}();`);
const allAdded = (lines) => new Set(lines.map((_, index) => index + 1));

function scan(lines, { added = allAdded(lines), max = 5 } = {}) {
  return findLongJsFunctions(lines, added, max);
}

test('flags a long function declaration', () => {
  const lines = ['function build() {', ...body(6), '}'];
  assert.deepEqual(scan(lines).map(({ name, bodyLines, line }) => ({ name, bodyLines, line })), [
    { name: 'build', bodyLines: 6, line: 1 },
  ]);
});

test('flags long arrow functions and function expressions', () => {
  const arrow = ['const load = async (id: string): Promise<void> => {', ...body(6), '};'];
  const expression = ['const save = function (data) {', ...body(6), '};'];
  assert.equal(scan(arrow)[0].name, 'load');
  assert.equal(scan(expression)[0].name, 'save');
});

test('flags long class methods', () => {
  const lines = ['class Store {', '  async refresh(force: boolean): Promise<void> {', ...body(6), '  }', '}'];
  assert.equal(scan(lines)[0].name, 'refresh');
});

test('ignores functions at or under the limit', () => {
  assert.deepEqual(scan(['function ok() {', ...body(5), '}']), []);
});

test('ignores blank and comment-only lines when counting', () => {
  const lines = ['function ok() {', ...body(5), '', '  // note', '  /* block */', '  * continued', '}'];
  assert.deepEqual(scan(lines), []);
});

test('ignores long functions the diff did not touch', () => {
  const lines = ['function old() {', ...body(6), '}'];
  assert.deepEqual(scan(lines, { added: new Set([99]) }), []);
});

test('flags a long function when only one inner line changed', () => {
  const lines = ['function edited() {', ...body(6), '}'];
  assert.equal(scan(lines, { added: new Set([4]) }).length, 1);
});

test('skips expression-bodied arrows and control-flow blocks', () => {
  const lines = ['const pick = (list) => list.filter(Boolean);', 'if (ready) {', ...body(8), '}'];
  assert.deepEqual(scan(lines), []);
});

test('is not fooled by braces inside strings or comments', () => {
  const lines = ['function tricky() {', "  const open = '{';", '  // }', ...body(5), '}'];
  assert.equal(scan(lines).length, 1);
});

test('handles destructured parameters', () => {
  const lines = ['function render({ a, b }) {', ...body(6), '}'];
  assert.equal(scan(lines)[0].name, 'render');
});

test('braces inside a multi-line template literal do not end the function early', () => {
  const lines = ['function render() {', '  const html = `', '    }', '  `;', ...body(5), '}'];
  assert.equal(scan(lines)[0].bodyLines, 8);
});

test('flags long class-field and object-property arrows by their name', () => {
  const field = ['class Form {', '  private submit = async (event: Event): Promise<void> => {', ...body(6), '  };', '}'];
  const property = ['const handlers = {', '  onSave: (draft) => {', ...body(6), '  },', '};'];
  assert.equal(scan(field)[0].name, 'submit');
  assert.equal(scan(property)[0].name, 'onSave');
});

test('does not treat anonymous callbacks or short property values as named arrows', () => {
  const callback = ['app.get("/", (req, res) => {', ...body(6), '});'];
  const values = ['const config = {', '  retries: 3,', '  label: "a => b",', '  run: (x) => x + 1,', '};'];
  assert.deepEqual(scan(callback), []);
  assert.deepEqual(scan(values), []);
});
