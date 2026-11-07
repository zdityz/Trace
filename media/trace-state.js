(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TraceState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function applyNodePatch(previous, patch) {
    if (!patch || patch.$trace_patch !== 1) return patch;
    const node = { ...(previous || {}) };
    (Array.isArray(patch.remove) ? patch.remove : []).forEach((key) => delete node[key]);
    Object.assign(node, patch.set || {});

    Object.entries(patch.arrays || {}).forEach(([field, operation]) => {
      const values = Array.isArray(node[field]) ? node[field].slice() : [];
      if (Number.isInteger(operation.length) && operation.length >= 0) values.length = operation.length;
      Object.entries(operation.set || {}).forEach(([index, value]) => {
        const numericIndex = Number(index);
        if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < values.length) {
          values[numericIndex] = value;
        }
      });
      node[field] = values;
    });

    Object.entries(patch.maps || {}).forEach(([field, operation]) => {
      const values = { ...(node[field] && typeof node[field] === 'object' ? node[field] : {}) };
      (Array.isArray(operation.remove) ? operation.remove : []).forEach((key) => delete values[key]);
      Object.assign(values, operation.set || {});
      node[field] = values;
    });
    return node;
  }

  function applyEventObjects(previousObjects, state) {
    const current = { ...(previousObjects || {}) };
    if (!state || typeof state !== 'object') return current;

    if (state.object_checkpoint === true) {
      return { ...(state.objects || {}) };
    }

    if (state.object_delta && typeof state.object_delta === 'object') {
      (Array.isArray(state.object_delta.removed) ? state.object_delta.removed : [])
        .forEach((id) => delete current[id]);
      Object.entries(state.object_delta.upserts || {}).forEach(([id, update]) => {
        current[id] = update && update.$trace_patch === 1
          ? applyNodePatch(current[id], update)
          : update;
      });
      return current;
    }

    // Backward compatibility with traces written before delta encoding.
    return { ...(state.objects || {}) };
  }

  function createTraceStateResolver(events) {
    const source = Array.isArray(events) ? events : [];
    let lastIndex = -1;
    let objects = {};
    let lastState = { frames: [], objects: {} };

    function reset() {
      lastIndex = -1;
      objects = {};
      lastState = { frames: [], objects: {} };
    }

    function get(index) {
      const target = Math.max(-1, Math.min(Number.isInteger(index) ? index : -1, source.length - 1));
      if (target < 0) return { frames: [], objects: {} };
      if (target < lastIndex) reset();

      for (let cursor = lastIndex + 1; cursor <= target; cursor += 1) {
        const eventState = source[cursor] && source[cursor].state ? source[cursor].state : {};
        objects = applyEventObjects(objects, eventState);
        lastState = {
          ...eventState,
          frames: Array.isArray(eventState.frames) ? eventState.frames : [],
          objects,
        };
        lastIndex = cursor;
      }
      return lastState;
    }

    return { get, reset };
  }

  function resolveTraceState(events, index) {
    const source = Array.isArray(events) ? events : [];
    const target = Math.max(-1, Math.min(Number.isInteger(index) ? index : -1, source.length - 1));
    if (target < 0) return { frames: [], objects: {} };

    const targetState = source[target] && source[target].state ? source[target].state : {};
    if (!targetState.object_checkpoint && !targetState.object_delta) {
      // Legacy traces store a complete object map on every event.
      return {
        ...targetState,
        frames: Array.isArray(targetState.frames) ? targetState.frames : [],
        objects: targetState.objects && typeof targetState.objects === 'object' ? targetState.objects : {},
      };
    }

    let checkpoint = -1;
    for (let cursor = target; cursor >= 0; cursor -= 1) {
      const state = source[cursor] && source[cursor].state;
      if (state && state.object_checkpoint === true) {
        checkpoint = cursor;
        break;
      }
    }

    let objects = {};
    let start = 0;
    if (checkpoint >= 0) {
      const checkpointState = source[checkpoint].state;
      objects = { ...(checkpointState.objects || {}) };
      start = checkpoint + 1;
    }
    for (let cursor = start; cursor <= target; cursor += 1) {
      const state = source[cursor] && source[cursor].state ? source[cursor].state : {};
      if (cursor !== checkpoint) objects = applyEventObjects(objects, state);
    }
    return {
      ...targetState,
      frames: Array.isArray(targetState.frames) ? targetState.frames : [],
      objects,
    };
  }

  return { applyNodePatch, applyEventObjects, createTraceStateResolver, resolveTraceState };
});
