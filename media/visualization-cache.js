(function (root, factory) {
  const traceState = typeof module !== 'undefined' && module.exports
    ? require('./trace-state.js')
    : root.TraceState;
  const api = factory(traceState);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TraceVisualizationCache = api;
})(typeof window !== 'undefined' ? window : globalThis, function (traceState) {
  'use strict';

  function objectReference(encoded) {
    return Boolean(encoded && encoded.kind === 'ref' && typeof encoded.id === 'string');
  }

  function createVisualizationCache(structureModel) {
    const retained = new Map();
    const dismissed = new Set();
    let lastProcessedIndex = -1;
    let resolver = null;
    let resolverSource = null;
    let lastResolvedState = null;

    function reset() {
      retained.clear();
      dismissed.clear();
      lastProcessedIndex = -1;
      resolver = null;
      resolverSource = null;
      lastResolvedState = null;
    }

    function makeKey(scopeId, name) {
      return `${scopeId || 'scope-unknown'}::${name || 'structure'}`;
    }

    function makeDismissKey(key, objectId) {
      return `${key}::${objectId}`;
    }

    function currentFrames(state) {
      const result = new Map();
      (Array.isArray(state && state.frames) ? state.frames : []).forEach((frame) => {
        if (frame && frame.scope_id) result.set(frame.scope_id, frame);
      });
      return result;
    }

    function discoverArrays(state) {
      const objects = state && state.objects && typeof state.objects === 'object' ? state.objects : {};
      const seen = new Set();
      const result = [];
      (Array.isArray(state && state.frames) ? state.frames : []).forEach((frame) => {
        Object.entries(frame && frame.locals ? frame.locals : {}).forEach(([name, encoded]) => {
          if (!objectReference(encoded) || seen.has(encoded.id)) return;
          const object = objects[encoded.id];
          if (!object || object.type !== 'list' || !Array.isArray(object.items)) return;
          seen.add(encoded.id);
          result.push({
            type: 'array',
            name,
            objectId: encoded.id,
            scopeId: frame.scope_id || 'scope-unknown',
          });
        });
      });
      return result;
    }

    function discoverAll(state) {
      const arrays = discoverArrays(state);
      const structures = structureModel && typeof structureModel.discoverStructures === 'function'
        ? structureModel.discoverStructures(state)
        : { linkedLists: [], trees: [], graphs: [] };
      return [
        ...arrays,
        ...(structures.linkedLists || []).map((item) => ({ ...item, type: 'linked-list' })),
        ...(structures.trees || []).map((item) => ({ ...item, type: 'tree' })),
        ...(structures.graphs || []).map((item) => ({ ...item, type: 'graph' })),
      ];
    }

    function nestedObjectIds(item) {
      const ids = new Set();
      if (!item) return ids;

      if (item.type === 'tree' && item.root) {
        const visit = (node, isRoot = false) => {
          if (!node || typeof node !== 'object') return;
          if (!isRoot && node.id) ids.add(node.id);
          visit(node.left, false);
          visit(node.right, false);
        };
        visit(item.root, true);
      } else if (item.type === 'linked-list' && Array.isArray(item.nodes)) {
        item.nodes.slice(1).forEach((node) => {
          if (node && node.id) ids.add(node.id);
        });
      }
      return ids;
    }

    function pruneNestedVisualizations(item) {
      const nestedIds = nestedObjectIds(item);
      if (!nestedIds.size) return;
      for (const [existingKey, existing] of retained) {
        if (existing.type === item.type && nestedIds.has(existing.objectId)) {
          retained.delete(existingKey);
        }
      }
    }

    function processEvent(event, index, state, previousState) {
      const frames = currentFrames(state);

      // If a binding is still in an active scope but was deleted or rebound,
      // its previous visualization should disappear. A returned scope is not
      // treated as deletion: we retain its last useful snapshot.
      for (const [key, entry] of retained) {
        const frame = frames.get(entry.scopeId);
        if (!frame) continue;
        const locals = frame.locals || {};
        if (!Object.prototype.hasOwnProperty.call(locals, entry.name)) {
          retained.delete(key);
          continue;
        }
        const binding = locals[entry.name];
        if (!objectReference(binding) || binding.id !== entry.objectId) retained.delete(key);
      }

      const discovered = discoverAll(state);
      discovered.forEach((item) => {
        if (!item.objectId) return;
        const key = makeKey(item.scopeId, item.name);
        if (dismissed.has(makeDismissKey(key, item.objectId))) return;

        // The same object may move from a constructor's temporary `self`
        // binding to its eventual module-level name. Keep one card per object.
        for (const [existingKey, existing] of retained) {
          if (existing.objectId === item.objectId && existingKey !== key) retained.delete(existingKey);
        }

        // When a complete tree/list root becomes visible, remove older
        // visualizations of its child nodes. Those were useful construction
        // snapshots, but are not separate top-level structures any more.
        pruneNestedVisualizations(item);

        retained.set(key, {
          ...item,
          key,
          state,
          previousState,
          event,
          lastSeenIndex: index,
        });
      });
    }

    function update(events, targetIndex) {
      const source = Array.isArray(events) ? events : [];
      const target = Math.max(-1, Math.min(Number.isInteger(targetIndex) ? targetIndex : -1, source.length - 1));
      if (source !== resolverSource) {
        resolverSource = source;
        resolver = traceState && typeof traceState.createTraceStateResolver === 'function'
          ? traceState.createTraceStateResolver(source)
          : null;
        lastResolvedState = null;
        retained.clear();
        lastProcessedIndex = -1;
      }
      if (target < lastProcessedIndex) {
        retained.clear();
        lastProcessedIndex = -1;
        lastResolvedState = null;
        if (resolver) resolver.reset();
      }
      for (let index = lastProcessedIndex + 1; index <= target; index += 1) {
        const state = resolver
          ? resolver.get(index)
          : (source[index] && source[index].state ? source[index].state : { frames: [], objects: {} });
        processEvent(source[index], index, state, lastResolvedState);
        lastResolvedState = state;
        lastProcessedIndex = index;
      }
      return getEntries(target);
    }

    function getEntries(targetIndex = lastProcessedIndex) {
      return [...retained.values()].map((entry) => ({
        ...entry,
        stale: entry.lastSeenIndex !== targetIndex,
      }));
    }

    function dismiss(key) {
      const entry = retained.get(key);
      if (!entry) return false;
      dismissed.add(makeDismissKey(key, entry.objectId));
      retained.delete(key);
      return true;
    }

    return { update, getEntries, dismiss, reset };
  }

  return { createVisualizationCache };
});
