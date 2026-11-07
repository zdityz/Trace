(function (root, factory) {
  const traceState = typeof module !== 'undefined' && module.exports
    ? require('./trace-state.js')
    : root.TraceState;
  const api = factory(traceState);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TraceHistory = api;
})(typeof window !== 'undefined' ? window : globalThis, function (traceState) {
  'use strict';

  function buildHistoryModel(events) {
    const source = Array.isArray(events) ? events : [];
    const columnsByKey = new Map();
    const scopesById = new Map();
    const scopeCountsByFunction = new Map();
    const rawRows = [];
    const resolver = traceState && typeof traceState.createTraceStateResolver === 'function'
      ? traceState.createTraceStateResolver(source)
      : null;
    let previousSignatures = new Map();

    source.forEach((event, index) => {
      const state = resolver
        ? resolver.get(index)
        : (event && event.state ? event.state : { frames: [], objects: {} });
      const values = new Map();
      const displayValues = new Map();
      const currentSignatures = new Map();
      const changedKeys = new Set();
      const newKeys = new Set();
      const frames = Array.isArray(state.frames) ? state.frames : [];
      const objects = state.objects && typeof state.objects === 'object' ? state.objects : {};

      frames.forEach((frame) => {
        const functionName = frame.function || '<module>';
        const scopeId = String(frame.scope_id || `${functionName}-scope`);
        if (!scopesById.has(scopeId)) {
          const ordinal = (scopeCountsByFunction.get(functionName) || 0) + 1;
          scopeCountsByFunction.set(functionName, ordinal);
          scopesById.set(scopeId, { id: scopeId, functionName, ordinal });
        }

        const locals = frame.locals && typeof frame.locals === 'object' ? frame.locals : {};
        Object.entries(locals).forEach(([name, encoded]) => {
          const key = `${scopeId}\u0000${name}`;
          if (!columnsByKey.has(key)) {
            columnsByKey.set(key, {
              key,
              name,
              scopeId,
              functionName,
              firstSeenAt: index,
            });
          }
          values.set(key, encoded);
          const signature = valueSignature(encoded, objects, new Set());
          currentSignatures.set(key, signature);
          displayValues.set(key, formatValue(encoded, objects));
          if (!previousSignatures.has(key)) newKeys.add(key);
          else if (previousSignatures.get(key) !== signature) changedKeys.add(key);
        });
      });

      rawRows.push({ index, event, values, displayValues, changedKeys, newKeys });
      previousSignatures = currentSignatures;
    });

    const nameCounts = new Map();
    columnsByKey.forEach((column) => {
      nameCounts.set(column.name, (nameCounts.get(column.name) || 0) + 1);
    });

    const columns = [...columnsByKey.values()].map((column) => {
      const scope = scopesById.get(column.scopeId);
      const duplicateName = (nameCounts.get(column.name) || 0) > 1;
      const scopeName = column.functionName === '<module>' ? 'global' : column.functionName;
      const scopeSuffix = scope && (scopeCountsByFunction.get(column.functionName) || 0) > 1
        ? ` #${scope.ordinal}`
        : '';
      return {
        ...column,
        label: duplicateName ? `${column.name} · ${scopeName}${scopeSuffix}` : column.name,
        scopeLabel: `${scopeName}${scopeSuffix}`,
      };
    });

    return { columns, rows: rawRows };
  }

  function valueSignature(encoded, objects, seen) {
    if (!encoded || typeof encoded !== 'object') return `${typeof encoded}:${String(encoded)}`;
    if (encoded.kind === 'primitive') return `primitive:${JSON.stringify(encoded.value)}`;
    if (encoded.kind === 'opaque') return `opaque:${encoded.type || 'object'}`;
    if (encoded.kind !== 'ref') return JSON.stringify(encoded);

    const id = encoded.id;
    if (!id) return 'ref:missing-id';
    if (seen.has(id)) return `circular:${id}`;
    const node = objects[id];
    if (!node) return `unavailable:${id}`;
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    if (Array.isArray(node.items)) {
      return `${node.type || 'sequence'}:[${node.items.map((item) => valueSignature(item, objects, nextSeen)).join('|')}]`;
    }
    if (Array.isArray(node.entries)) {
      return `${node.type || 'mapping'}:{${node.entries.map((entry) => `${valueSignature(entry.key, objects, nextSeen)}=${valueSignature(entry.value, objects, nextSeen)}`).join('|')}}`;
    }
    if (node.attributes && typeof node.attributes === 'object') {
      const fields = Object.keys(node.attributes).sort().map((name) => `${name}=${valueSignature(node.attributes[name], objects, nextSeen)}`);
      return `instance:${node.class_name || 'object'}:{${fields.join('|')}}`;
    }
    return `ref:${id}:${node.type || 'object'}`;
  }

  function formatValue(encoded, objects, seen, depth) {
    const visited = seen || new Set();
    const currentDepth = Number.isInteger(depth) ? depth : 0;
    if (!encoded || typeof encoded !== 'object') return String(encoded);
    if (encoded.kind === 'primitive') {
      if (encoded.type === 'str') return JSON.stringify(encoded.value);
      if (encoded.value === null) return 'None';
      return String(encoded.value);
    }
    if (encoded.kind === 'opaque') return `<${encoded.type || 'object'}>`;
    if (encoded.kind !== 'ref') return '[value unavailable]';

    const id = encoded.id;
    if (!id) return '[reference unavailable]';
    if (visited.has(id)) return '[Circular]';
    const node = objects && objects[id];
    if (!node) return '[Unavailable]';
    if (currentDepth >= 3) return `<${node.type || 'object'}>`;

    const nextSeen = new Set(visited);
    nextSeen.add(id);
    if (Array.isArray(node.items)) {
      const preview = node.items.slice(0, 5).map((item) => formatValue(item, objects, nextSeen, currentDepth + 1));
      if (node.items.length > 5) preview.push(`… +${node.items.length - 5}`);
      return `[${preview.join(', ')}]`;
    }
    if (Array.isArray(node.entries)) {
      const preview = node.entries.slice(0, 4).map((entry) =>
        `${formatValue(entry.key, objects, nextSeen, currentDepth + 1)}: ${formatValue(entry.value, objects, nextSeen, currentDepth + 1)}`
      );
      if (node.entries.length > 4) preview.push(`… +${node.entries.length - 4}`);
      return `{${preview.join(', ')}}`;
    }
    return `<${node.type || 'object'}>`;
  }

  return { buildHistoryModel, valueSignature, formatValue };
});
