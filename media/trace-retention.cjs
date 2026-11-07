'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const TRACE_FILE_PATTERN = /^trace-\d+-[a-f0-9-]+\.json$/i;

/**
 * Keep only recent Trace trace files in extension global storage.
 * Non-trace files are never touched. Cleanup failures are deliberately
 * non-fatal so a storage issue cannot block a user's next run.
 */
async function pruneStoredTraces(directory, options = {}) {
  const maxTraces = Number.isInteger(options.maxTraces) ? Math.max(1, options.maxTraces) : 25;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Math.max(0, options.maxAgeMs) : 30 * 24 * 60 * 60 * 1000;
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const statResults = await Promise.all(entries
      .filter((entry) => entry.isFile() && TRACE_FILE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        try {
          const stats = await fs.stat(filePath);
          return { filePath, modifiedAt: stats.mtimeMs };
        } catch {
          return null;
        }
      }));

    const recent = statResults
      .filter((item) => item !== null)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    let deleted = 0;
    for (let index = 0; index < recent.length; index += 1) {
      const item = recent[index];
      if (index >= maxTraces || now - item.modifiedAt > maxAgeMs) {
        try {
          await fs.unlink(item.filePath);
          deleted += 1;
        } catch {
          // Another process may have removed the file, or storage may be read-only.
        }
      }
    }
    return { retained: recent.length - deleted, deleted };
  } catch {
    return { retained: 0, deleted: 0, skipped: true };
  }
}

module.exports = { pruneStoredTraces };
