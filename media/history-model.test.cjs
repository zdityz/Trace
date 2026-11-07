const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHistoryModel, formatValue } = require('./history-model.js');

function event(sequence, frames, objects = {}, line = sequence + 1) {
  return {
    sequence,
    event: 'line_executed',
    source: { line },
    state: { frames, objects },
  };
}

function frame(scope_id, fn, locals) {
  return { scope_id, function: fn, locals };
}

function primitive(value, type) {
  return { kind: 'primitive', type: type || typeof value, value };
}

test('builds one table row per recorded event and discovers variables across the trace', () => {
  const trace = [
    event(0, [frame('scope-1', '<module>', { nums: primitive(7, 'int'), total: primitive(0, 'int') })]),
    event(1, [frame('scope-1', '<module>', { nums: primitive(7, 'int'), total: primitive(7, 'int'), index: primitive(0, 'int') })]),
  ];

  const model = buildHistoryModel(trace);
  assert.equal(model.rows.length, 2);
  assert.deepEqual(model.columns.map((column) => column.name), ['nums', 'total', 'index']);
  assert.equal(model.rows[0].values.has(model.columns[2].key), false);
  assert.equal(model.rows[1].values.has(model.columns[2].key), true);
  assert.equal(model.rows[1].newKeys.has(model.columns[2].key), true);
});

test('marks primitive value changes between adjacent execution events', () => {
  const trace = [
    event(0, [frame('scope-1', '<module>', { total: primitive(0, 'int') })]),
    event(1, [frame('scope-1', '<module>', { total: primitive(10, 'int') })]),
    event(2, [frame('scope-1', '<module>', { total: primitive(10, 'int') })]),
  ];

  const model = buildHistoryModel(trace);
  const totalKey = model.columns[0].key;
  assert.equal(model.rows[0].newKeys.has(totalKey), true);
  assert.equal(model.rows[1].changedKeys.has(totalKey), true);
  assert.equal(model.rows[2].changedKeys.has(totalKey), false);
});

test('detects in-place list mutations through snapshot object contents', () => {
  const listRef = { kind: 'ref', id: 'obj-1' };
  const trace = [
    event(0, [frame('scope-1', '<module>', { nums: listRef })], {
      'obj-1': { type: 'list', items: [primitive(3, 'int'), primitive(1, 'int')] },
    }),
    event(1, [frame('scope-1', '<module>', { nums: listRef })], {
      'obj-1': { type: 'list', items: [primitive(1, 'int'), primitive(3, 'int')] },
    }),
  ];

  const model = buildHistoryModel(trace);
  assert.equal(model.rows[1].changedKeys.has(model.columns[0].key), true);
  assert.equal(formatValue(listRef, trace[1].state.objects), '[1, 3]');
});

test('qualifies duplicate variable names by scope, including repeated function calls', () => {
  const trace = [
    event(0, [frame('scope-1', '<module>', { value: primitive(1, 'int') })]),
    event(1, [frame('scope-1', '<module>', { value: primitive(1, 'int') }), frame('scope-2', 'solve', { value: primitive(2, 'int') })]),
    event(2, [frame('scope-1', '<module>', { value: primitive(1, 'int') }), frame('scope-3', 'solve', { value: primitive(3, 'int') })]),
  ];

  const model = buildHistoryModel(trace);
  assert.deepEqual(model.columns.map((column) => column.label), [
    'value · global',
    'value · solve #1',
    'value · solve #2',
  ]);
});

test('formats None, strings, and compact container previews', () => {
  assert.equal(formatValue(primitive(null, 'NoneType'), {}), 'None');
  assert.equal(formatValue(primitive('hello', 'str'), {}), '"hello"');
  const encoded = { kind: 'ref', id: 'obj-2' };
  const objects = { 'obj-2': { type: 'list', items: [1, 2, 3, 4, 5, 6].map((n) => primitive(n, 'int')) } };
  assert.equal(formatValue(encoded, objects), '[1, 2, 3, 4, 5, … +1]');
});
