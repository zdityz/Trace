(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TraceStructures = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const VALUE_FIELDS = ['value', 'val', 'key', 'data', 'label'];
  const ACTIVE_NAMES = new Set(['current', 'currentnode', 'current_node', 'node', 'vertex', 'currentvertex', 'current_vertex', 'active']);
  const VISITED_PATTERN = /^(visited|seen|visitednodes|visited_nodes)$/i;
  const QUEUE_PATTERN = /^(queue|frontier|pending)$/i;

  function discoverStructures(state) {
    const objects = state && state.objects && typeof state.objects === 'object' ? state.objects : {};
    const frames = Array.isArray(state && state.frames) ? state.frames : [];
    const locals = [];
    frames.forEach((frame) => {
      Object.entries(frame && frame.locals ? frame.locals : {}).forEach(([name, encoded]) => {
        locals.push({ name, encoded, scopeId: frame.scope_id || 'scope-unknown' });
      });
    });

    const markers = collectMarkers(locals, objects);
    return {
      linkedLists: discoverLinkedLists(locals, objects, markers),
      trees: discoverTrees(locals, objects, markers),
      graphs: discoverGraphs(locals, objects, markers),
    };
  }

  function collectMarkers(locals, objects) {
    const visitedTokens = new Set();
    const queuedTokens = new Set();
    const activeTokens = new Set();
    const activeObjectIds = new Set();

    locals.forEach(({ name, encoded }) => {
      const normalized = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (ACTIVE_NAMES.has(normalized)) {
        const primitive = primitiveInfo(encoded);
        if (primitive) activeTokens.add(primitive.token);
        if (encoded && encoded.kind === 'ref' && objects[encoded.id]?.type === 'instance') activeObjectIds.add(encoded.id);
      }
      if (VISITED_PATTERN.test(normalized)) {
        collectionValues(encoded, objects).forEach((item) => {
          const primitive = primitiveInfo(item);
          if (primitive) visitedTokens.add(primitive.token);
          else if (item && item.kind === 'ref') activeObjectIds.add(item.id);
        });
      }
      if (QUEUE_PATTERN.test(normalized)) {
        collectionValues(encoded, objects).forEach((item) => {
          const primitive = primitiveInfo(item);
          if (primitive) queuedTokens.add(primitive.token);
        });
      }
    });

    return { visitedTokens, queuedTokens, activeTokens, activeObjectIds };
  }

  function primitiveInfo(encoded) {
    if (!encoded || encoded.kind !== 'primitive') return null;
    const value = encoded.value;
    return {
      token: `${encoded.type || typeof value}:${JSON.stringify(value)}`,
      label: value === null ? 'None' : String(value),
    };
  }

  function collectionValues(encoded, objects) {
    if (!encoded || encoded.kind !== 'ref') return [];
    const node = objects[encoded.id];
    if (!node) return [];
    if (Array.isArray(node.items)) return node.items;
    return [];
  }

  function instanceNode(id, objects) {
    const node = objects[id];
    if (!node || node.type !== 'instance' || !node.attributes || typeof node.attributes !== 'object') return null;
    return node;
  }

  function valueAttribute(node) {
    for (const name of VALUE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(node.attributes, name)) return node.attributes[name];
    }
    return null;
  }

  function isTreeNode(id, objects) {
    const node = instanceNode(id, objects);
    return Boolean(node && Object.prototype.hasOwnProperty.call(node.attributes, 'left') && Object.prototype.hasOwnProperty.call(node.attributes, 'right') && valueAttribute(node));
  }

  function isLinkedNode(id, objects) {
    const node = instanceNode(id, objects);
    return Boolean(node && Object.prototype.hasOwnProperty.call(node.attributes, 'next') && valueAttribute(node));
  }

  function referenceId(encoded, objects) {
    if (!encoded || encoded.kind !== 'ref' || !objects[encoded.id]) return null;
    return encoded.id;
  }

  function localReferenceRoots(locals, objects, predicate, childFieldNames) {
    const candidates = new Set(Object.keys(objects).filter((id) => predicate(id, objects)));
    const parentIds = new Set();
    candidates.forEach((id) => {
      const node = objects[id];
      childFieldNames.forEach((field) => {
        const childId = referenceId(node.attributes[field], objects);
        if (childId && candidates.has(childId)) parentIds.add(childId);
      });
    });

    const result = [];
    const seen = new Set();
    locals.forEach(({ name, encoded, scopeId }) => {
      const id = referenceId(encoded, objects);
      if (id && candidates.has(id) && !parentIds.has(id) && !seen.has(id)) {
        seen.add(id);
        result.push({ name, id, scopeId: scopeId || 'scope-unknown' });
      }
    });
    if (!result.length) {
      candidates.forEach((id) => {
        if (!parentIds.has(id) && !seen.has(id)) {
          seen.add(id);
          result.push({ name: 'structure', id });
        }
      });
    }
    return result;
  }

  function discoverTrees(locals, objects, markers) {
    const roots = localReferenceRoots(locals, objects, isTreeNode, ['left', 'right']);
    const trees = [];
    const usedRoots = new Set();
    roots.forEach(({ name, id, scopeId }) => {
      if (usedRoots.has(id)) return;
      const seen = new Set();
      let count = 0;
      let truncated = false;
      function build(nodeId, depth) {
        if (!nodeId || !isTreeNode(nodeId, objects)) return null;
        if (seen.has(nodeId) || depth > 7 || count >= 63) {
          truncated = true;
          return null;
        }
        seen.add(nodeId);
        count += 1;
        const source = objects[nodeId];
        const value = primitiveInfo(valueAttribute(source));
        const label = value ? value.label : source.class_name || 'Node';
        const leftId = referenceId(source.attributes.left, objects);
        const rightId = referenceId(source.attributes.right, objects);
        return {
          id: nodeId,
          label,
          left: build(leftId, depth + 1),
          right: build(rightId, depth + 1),
          active: markers.activeObjectIds.has(nodeId) || Boolean(value && markers.activeTokens.has(value.token)),
          visited: markers.activeObjectIds.has(nodeId) || Boolean(value && markers.visitedTokens.has(value.token)),
        };
      }
      const root = build(id, 0);
      if (root) {
        usedRoots.add(id);
        trees.push({ name, root, objectId: id, scopeId: scopeId || 'scope-unknown', nodeCount: count, truncated });
      }
    });
    return trees;
  }

  function discoverLinkedLists(locals, objects, markers) {
    const roots = localReferenceRoots(locals, objects, isLinkedNode, ['next']);
    const lists = [];
    const usedRoots = new Set();
    roots.forEach(({ name, id, scopeId }) => {
      if (usedRoots.has(id)) return;
      const seen = new Set();
      const nodes = [];
      let currentId = id;
      let truncated = false;
      while (currentId && isLinkedNode(currentId, objects)) {
        if (seen.has(currentId) || nodes.length >= 60) {
          truncated = true;
          break;
        }
        seen.add(currentId);
        const source = objects[currentId];
        const value = primitiveInfo(valueAttribute(source));
        nodes.push({
          id: currentId,
          label: value ? value.label : source.class_name || 'Node',
          active: markers.activeObjectIds.has(currentId) || Boolean(value && markers.activeTokens.has(value.token)),
          visited: markers.activeObjectIds.has(currentId) || Boolean(value && markers.visitedTokens.has(value.token)),
        });
        currentId = referenceId(source.attributes.next, objects);
      }
      if (nodes.length) {
        usedRoots.add(id);
        lists.push({ name, nodes, objectId: id, scopeId: scopeId || 'scope-unknown', truncated });
      }
    });
    return lists;
  }

  function discoverGraphs(locals, objects, markers) {
    const graphs = [];
    const seenObjects = new Set();
    locals.forEach(({ name, encoded, scopeId }) => {
      const id = referenceId(encoded, objects);
      if (!id || seenObjects.has(id)) return;
      const mapping = objects[id];
      if (!mapping || mapping.type !== 'dict' || !Array.isArray(mapping.entries) || mapping.entries.length < 2) return;

      const keySet = new Set();
      const adjacency = new Map();
      let edgeCount = 0;
      let matchedEdges = 0;
      let valid = true;
      mapping.entries.forEach((entry) => {
        const key = primitiveInfo(entry.key);
        const listId = referenceId(entry.value, objects);
        const listNode = listId ? objects[listId] : null;
        if (!key || !listNode || !['list', 'tuple', 'set', 'frozenset'].includes(listNode.type) || !Array.isArray(listNode.items)) {
          valid = false;
          return;
        }
        keySet.add(key.token);
        const neighbors = [];
        listNode.items.forEach((item) => {
          const neighbor = primitiveInfo(item);
          if (!neighbor) { valid = false; return; }
          neighbors.push(neighbor);
          edgeCount += 1;
        });
        adjacency.set(key.token, { label: key.label, neighbors });
      });
      if (!valid || keySet.size < 2 || edgeCount < 1) return;

      const nodeMap = new Map();
      adjacency.forEach((row, token) => {
        nodeMap.set(token, { token, label: row.label });
        row.neighbors.forEach((neighbor) => {
          if (keySet.has(neighbor.token)) matchedEdges += 1;
          if (!nodeMap.has(neighbor.token)) nodeMap.set(neighbor.token, { token: neighbor.token, label: neighbor.label });
        });
      });
      const graphLikeName = /(graph|adj|neighbor|edge)/i.test(name);
      const matchRatio = edgeCount ? matchedEdges / edgeCount : 0;
      if (!graphLikeName && (edgeCount < 2 || matchRatio < 0.8)) return;
      if (nodeMap.size < 2 || nodeMap.size > 40) return;

      const edges = [];
      const edgeKeys = new Set();
      adjacency.forEach((row, from) => {
        row.neighbors.forEach((neighbor) => {
          const edgeKey = `${from}->${neighbor.token}`;
          if (edgeKeys.has(edgeKey)) return;
          edgeKeys.add(edgeKey);
          edges.push({ from, to: neighbor.token });
        });
      });
      const directed = edges.some((edge) => !edgeKeys.has(`${edge.to}->${edge.from}`));
      const displayEdges = directed ? edges : edges.filter((edge) => edge.from < edge.to);
      const nodes = [...nodeMap.values()].map((node) => ({
        ...node,
        active: markers.activeTokens.has(node.token),
        visited: markers.visitedTokens.has(node.token),
        queued: markers.queuedTokens.has(node.token),
      }));
      graphs.push({ name, directed, nodes, edges: displayEdges, objectId: id, scopeId: scopeId || 'scope-unknown', nodeCount: nodes.length, edgeCount: displayEdges.length });
      seenObjects.add(id);
    });
    return graphs;
  }

  return { discoverStructures, primitiveInfo };
});
