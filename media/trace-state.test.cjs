'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTraceStateResolver, resolveTraceState } = require('./trace-state.js');

const primitive = (value) => ({ kind: 'primitive', type: 'int', value });
const frame = (valueRef) => ({
  scope_id: 'module',
  function: '<module>',
  locals: { values: { kind: 'ref', id: 'obj-1' }, count: primitive(valueRef) },
});

const events = [
  {
    state: {
      frames: [frame(0)],
      object_checkpoint: true,
      objects: { 'obj-1': { type: 'list', items: [primitive(1), primitive(2), primitive(3)] } },
    },
  },
  {
    state: {
      frames: [frame(1)],
      object_checkpoint: false,
      objects: {},
      object_delta: {
        upserts: {
          'obj-1': {
            $trace_patch: 1,
            set: {},
            remove: [],
            arrays: { items: { length: 3, set: { '1': primitive(20) } } },
            maps: {},
          },
        },
        removed: [],
      },
    },
  },
  {
    state: {
      frames: [frame(2)],
      object_checkpoint: false,
      objects: {},
      object_delta: {
        upserts: {
          'obj-1': {
            $trace_patch: 1,
            set: {},
            remove: [],
            arrays: { items: { length: 4, set: { '3': primitive(4) } } },
            maps: {},
          },
        },
        removed: [],
      },
    },
  },
];

test('resolves object checkpoints and applies list index patches', () => {
  const resolver = createTraceStateResolver(events);
  assert.deepEqual(resolver.get(0).objects['obj-1'].items.map((item) => item.value), [1, 2, 3]);
  assert.deepEqual(resolver.get(1).objects['obj-1'].items.map((item) => item.value), [1, 20, 3]);
  assert.deepEqual(resolver.get(2).objects['obj-1'].items.map((item) => item.value), [1, 20, 3, 4]);
});

test('resolving a later event does not mutate an earlier resolved state', () => {
  const resolver = createTraceStateResolver(events);
  const first = resolver.get(0);
  resolver.get(2);
  assert.deepEqual(first.objects['obj-1'].items.map((item) => item.value), [1, 2, 3]);
});

test('random access starts from the nearest checkpoint', () => {
  const final = resolveTraceState(events, 2);
  assert.deepEqual(final.objects['obj-1'].items.map((item) => item.value), [1, 20, 3, 4]);
  const middle = resolveTraceState(events, 1);
  assert.deepEqual(middle.objects['obj-1'].items.map((item) => item.value), [1, 20, 3]);
});

test('supports legacy full-snapshot trace states', () => {
  const legacy = [{ state: { frames: [], objects: { 'obj-1': { type: 'list', items: [primitive(7)] } } } }];
  assert.equal(resolveTraceState(legacy, 0).objects['obj-1'].items[0].value, 7);
});

test('replays long histories efficiently across 512-event checkpoints', () => {
  const longEvents = [
    {
      state: {
        frames: [frame(0)],
        object_checkpoint: true,
        objects: { 'obj-1': { type: 'list', items: [primitive(0), primitive(0)] } },
      },
    },
  ];

  for (let sequence = 1; sequence <= 700; sequence += 1) {
    if (sequence % 512 === 0) {
      longEvents.push({
        state: {
          frames: [frame(sequence)],
          object_checkpoint: true,
          objects: { 'obj-1': { type: 'list', items: [primitive(0), primitive(sequence)] } },
        },
      });
    } else {
      longEvents.push({
        state: {
          frames: [frame(sequence)],
          object_checkpoint: false,
          objects: {},
          object_delta: {
            upserts: {
              'obj-1': {
                $trace_patch: 1,
                set: {},
                remove: [],
                arrays: { items: { length: 2, set: { '1': primitive(sequence) } } },
                maps: {},
              },
            },
            removed: [],
          },
        },
      });
    }
  }

  const state = resolveTraceState(longEvents, 700);
  assert.equal(state.objects['obj-1'].items[1].value, 700);
  assert.equal(state.frames[0].locals.count.value, 700);
});
