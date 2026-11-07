'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverStructures } = require('./structure-model.js');

const primitive = (value, type) => ({ kind: 'primitive', type: type || typeof value, value });
const ref = (id) => ({ kind: 'ref', id });
const state = (locals, objects) => ({
  frames: [{ scope_id: 'scope-1', function: '<module>', locals }],
  objects,
});

test('recognizes a binary tree from safe instance snapshots', () => {
  const objects = {
    root: { type: 'instance', class_name: 'Node', attributes: { value: primitive(10, 'int'), left: ref('left'), right: ref('right') } },
    left: { type: 'instance', class_name: 'Node', attributes: { value: primitive(5, 'int'), left: primitive(null, 'NoneType'), right: primitive(null, 'NoneType') } },
    right: { type: 'instance', class_name: 'Node', attributes: { value: primitive(15, 'int'), left: primitive(null, 'NoneType'), right: primitive(null, 'NoneType') } },
  };
  const found = discoverStructures(state({ root: ref('root') }, objects));
  assert.equal(found.trees.length, 1);
  assert.equal(found.trees[0].name, 'root');
  assert.equal(found.trees[0].nodeCount, 3);
  assert.equal(found.trees[0].objectId, 'root');
  assert.equal(found.trees[0].scopeId, 'scope-1');
  assert.equal(found.trees[0].root.label, '10');
  assert.equal(found.trees[0].root.left.label, '5');
  assert.equal(found.trees[0].root.right.label, '15');
});

test('recognizes a linked list and stops safely on cycles', () => {
  const objects = {
    a: { type: 'instance', class_name: 'ListNode', attributes: { val: primitive(1, 'int'), next: ref('b') } },
    b: { type: 'instance', class_name: 'ListNode', attributes: { val: primitive(2, 'int'), next: ref('c') } },
    c: { type: 'instance', class_name: 'ListNode', attributes: { val: primitive(3, 'int'), next: ref('b') } },
  };
  const found = discoverStructures(state({ head: ref('a') }, objects));
  assert.equal(found.linkedLists.length, 1);
  assert.deepEqual(found.linkedLists[0].nodes.map((node) => node.label), ['1', '2', '3']);
  assert.equal(found.linkedLists[0].truncated, true);
  assert.equal(found.linkedLists[0].objectId, 'a');
  assert.equal(found.linkedLists[0].scopeId, 'scope-1');
});

test('recognizes a primitive-labelled adjacency dictionary as a graph', () => {
  const objects = {
    graph: { type: 'dict', entries: [
      { key: primitive(0, 'int'), value: ref('n0') },
      { key: primitive(1, 'int'), value: ref('n1') },
      { key: primitive(2, 'int'), value: ref('n2') },
    ] },
    n0: { type: 'list', items: [primitive(1, 'int'), primitive(2, 'int')] },
    n1: { type: 'list', items: [primitive(0, 'int')] },
    n2: { type: 'list', items: [primitive(0, 'int')] },
  };
  const found = discoverStructures(state({ graph: ref('graph'), visited: ref('visited') }, {
    ...objects,
    visited: { type: 'list', items: [primitive(0, 'int')] },
  }));
  assert.equal(found.graphs.length, 1);
  assert.equal(found.graphs[0].nodeCount, 3);
  assert.equal(found.graphs[0].directed, false);
  assert.equal(found.graphs[0].edgeCount, 2);
  assert.equal(found.graphs[0].objectId, 'graph');
  assert.equal(found.graphs[0].scopeId, 'scope-1');
  assert.equal(found.graphs[0].nodes.find((node) => node.label === '0').visited, true);
});

test('does not label an arbitrary mapping as a graph without adjacency evidence', () => {
  const objects = {
    config: { type: 'dict', entries: [
      { key: primitive('names', 'str'), value: ref('one') },
      { key: primitive('colors', 'str'), value: ref('two') },
    ] },
    one: { type: 'list', items: [primitive('Ada', 'str')] },
    two: { type: 'list', items: [primitive('blue', 'str')] },
  };
  const found = discoverStructures(state({ config: ref('config') }, objects));
  assert.equal(found.graphs.length, 0);
});
