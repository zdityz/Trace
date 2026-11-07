'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pruneStoredTraces } = require('./trace-retention.cjs');

test('retains only the newest configured number of trace files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-retention-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const names = [1, 2, 3, 4].map((id) => `trace-${id}-${String(id).padStart(8, '0')}.json`);
  for (let index = 0; index < names.length; index += 1) {
    const file = path.join(directory, names[index]);
    await fs.writeFile(file, '{}');
    const stamp = new Date(now - index * 1000);
    await fs.utimes(file, stamp, stamp);
  }
  await fs.writeFile(path.join(directory, 'keep-me.txt'), 'not a trace');

  const result = await pruneStoredTraces(directory, { maxTraces: 2, maxAgeMs: 60_000, now });
  assert.deepEqual(result, { retained: 2, deleted: 2 });
  assert.equal(await fs.readFile(path.join(directory, names[0]), 'utf8'), '{}');
  assert.equal(await fs.readFile(path.join(directory, names[1]), 'utf8'), '{}');
  await assert.rejects(fs.access(path.join(directory, names[2])));
  await assert.rejects(fs.access(path.join(directory, names[3])));
  assert.equal(await fs.readFile(path.join(directory, 'keep-me.txt'), 'utf8'), 'not a trace');
});

test('removes old traces even when they are within the count limit', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-retention-age-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const oldTrace = path.join(directory, 'trace-1-abcdef01.json');
  const recentTrace = path.join(directory, 'trace-2-abcdef02.json');
  await fs.writeFile(oldTrace, '{}');
  await fs.writeFile(recentTrace, '{}');
  const now = Date.now();
  await fs.utimes(oldTrace, new Date(now - 50_000), new Date(now - 50_000));
  await fs.utimes(recentTrace, new Date(now - 1_000), new Date(now - 1_000));

  const result = await pruneStoredTraces(directory, { maxTraces: 10, maxAgeMs: 10_000, now });
  assert.deepEqual(result, { retained: 1, deleted: 1 });
  await assert.rejects(fs.access(oldTrace));
  await fs.access(recentTrace);
});

test('cleanup failure is non-fatal', async () => {
  const result = await pruneStoredTraces(path.join(os.tmpdir(), 'trace-no-such-directory'));
  assert.deepEqual(result, { retained: 0, deleted: 0, skipped: true });
});
