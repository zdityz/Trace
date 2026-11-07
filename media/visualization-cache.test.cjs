'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisualizationCache } = require('./visualization-cache.js');

const ref = (id) => ({ kind: 'ref', id });
const primitive = (value) => ({ kind: 'primitive', value, type: value === null ? 'NoneType' : typeof value });
const listState = (scopeId, locals, objects) => ({
  frames: [{ scope_id: scopeId, function: '<module>', locals }],
  objects,
});

const listOne = listState('module', { values: ref('list-1') }, {
  'list-1': { type: 'list', items: [primitive(1), primitive(2)] },
});
const listTwo = listState('module', { values: ref('list-1') }, {
  'list-1': { type: 'list', items: [primitive(1), primitive(3)] },
});
const noListSameScope = listState('module', { values: primitive(null) }, {});

function emptyStructures() {
  return { linkedLists: [], trees: [], graphs: [] };
}

function cache() {
  return createVisualizationCache({ discoverStructures: emptyStructures });
}

test('keeps the last visualization when later execution steps have no new structure', () => {
  const c = cache();
  const events = [
    { state: listOne },
    { state: { frames: [{ scope_id: 'inner', locals: { counter: primitive(1) } }], objects: {} } },
    { state: { frames: [{ scope_id: 'inner', locals: { counter: primitive(2) } }], objects: {} } },
  ];
  const views = c.update(events, 2);
  assert.equal(views.length, 1);
  assert.equal(views[0].name, 'values');
  assert.equal(views[0].stale, true);
  assert.equal(views[0].lastSeenIndex, 0);
  assert.equal(views[0].state.objects['list-1'].items[1].value, 2);
});

test('updates a retained visualization when its object changes', () => {
  const c = cache();
  const events = [{ state: listOne }, { state: listTwo }];
  const views = c.update(events, 1);
  assert.equal(views.length, 1);
  assert.equal(views[0].stale, false);
  assert.equal(views[0].state.objects['list-1'].items[1].value, 3);
});

test('clears a visualization when its active-scope variable is deleted or rebound', () => {
  const c = cache();
  const events = [{ state: listOne }, { state: noListSameScope }];
  assert.equal(c.update(events, 0).length, 1);
  assert.equal(c.update(events, 1).length, 0);
});

test('retains a visualization after the scope that owned it returns', () => {
  const c = cache();
  const events = [
    { state: listOne },
    { state: { frames: [], objects: {} } },
  ];
  const views = c.update(events, 1);
  assert.equal(views.length, 1);
  assert.equal(views[0].stale, true);
});

test('dismiss keeps a cleared card hidden for the same object during this run', () => {
  const c = cache();
  const events = [{ state: listOne }, { state: listTwo }];
  const first = c.update(events, 0);
  assert.equal(first.length, 1);
  assert.equal(c.dismiss(first[0].key), true);
  assert.equal(c.update(events, 1).length, 0);
});

test('backward replay reconstructs the visualization state for the selected step', () => {
  const c = cache();
  const events = [
    { state: listOne },
    { state: listTwo },
    { state: noListSameScope },
  ];
  assert.equal(c.update(events, 2).length, 0);
  const earlier = c.update(events, 0);
  assert.equal(earlier.length, 1);
  assert.equal(earlier[0].state.objects['list-1'].items[1].value, 2);
});

test('replaces temporary subtree cards with the completed top-level tree', () => {
  const structureModel = {
    discoverStructures(state) {
      return state.structures || emptyStructures();
    },
  };
  const c = createVisualizationCache(structureModel);
  const leafRoot = { id: 'leaf', label: '2', left: null, right: null };
  const fullRoot = {
    id: 'root', label: '10',
    left: { id: 'leaf', label: '2', left: null, right: null },
    right: { id: 'right', label: '15', left: null, right: null },
  };
  const leafState = {
    frames: [{ scope_id: 'constructor', function: '__init__', locals: { left: ref('leaf') } }],
    objects: { leaf: { type: 'instance', attributes: {} } },
    structures: { ...emptyStructures(), trees: [{ type: 'tree', name: 'left', objectId: 'leaf', scopeId: 'constructor', root: leafRoot }] },
  };
  const rootState = {
    frames: [
      { scope_id: 'constructor', function: '__init__', locals: { left: ref('leaf') } },
      { scope_id: 'module', function: '<module>', locals: { root: ref('root') } },
    ],
    objects: {
      leaf: { type: 'instance', attributes: {} },
      right: { type: 'instance', attributes: {} },
      root: { type: 'instance', attributes: {} },
    },
    structures: {
      ...emptyStructures(),
      trees: [
        { type: 'tree', name: 'left', objectId: 'leaf', scopeId: 'constructor', root: leafRoot },
        { type: 'tree', name: 'root', objectId: 'root', scopeId: 'module', root: fullRoot },
      ],
    },
  };

  assert.equal(c.update([{ state: leafState }], 0).length, 1);
  const entries = c.update([{ state: leafState }, { state: rootState }], 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'root');
  assert.equal(entries[0].objectId, 'root');
});
