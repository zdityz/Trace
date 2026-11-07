'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { markTracePartial, partialTraceMessage } = require('./trace-process-state.cjs');

function sampleTrace() {
  return {
    schema_version: 1,
    metadata: {
      event_count: 12,
      program_error: null,
    },
    events: Array.from({ length: 12 }, (_, sequence) => ({ sequence, state: { frames: [], objects: {} } })),
  };
}

test('recovered timeout trace is marked partial and timed out', () => {
  const trace = sampleTrace();
  assert.equal(markTracePartial(trace, 'timeout'), trace);
  assert.equal(trace.metadata.truncated, true);
  assert.equal(trace.metadata.partial, true);
  assert.equal(trace.metadata.timed_out, true);
  assert.equal(trace.metadata.truncation_reason, 'timeout');
  assert.equal(trace.metadata.program_error, null, 'a recovered partial run is not a program failure');
  assert.equal(trace.events.length, 12);
});

test('recovered cancelled trace is marked partial but not timed out', () => {
  const trace = sampleTrace();
  markTracePartial(trace, 'cancelled');
  assert.equal(trace.metadata.truncated, true);
  assert.equal(trace.metadata.partial, true);
  assert.equal(trace.metadata.timed_out, false);
  assert.equal(trace.metadata.truncation_reason, 'cancelled');
  assert.equal(trace.metadata.program_error, null, 'a recovered partial run is not a program failure');
});

test('unsupported reason and malformed trace are rejected', () => {
  assert.throws(() => markTracePartial({}, 'timeout'), /valid Trace document/);
  assert.throws(() => markTracePartial(sampleTrace(), 'event_limit'), /Unsupported partial-trace reason/);
});

test('a real program error on a recovered trace is preserved, not erased', () => {
  const trace = sampleTrace();
  trace.metadata.program_error = { type: 'ZeroDivisionError', message: 'division by zero' };
  markTracePartial(trace, 'timeout');
  assert.equal(trace.metadata.program_error.type, 'ZeroDivisionError');
});

test('every stop reason has its own user-facing message', () => {
  const reasons = ['timeout', 'cancelled', 'size_limit', 'event_limit', 'something-new'];
  const messages = reasons.map(partialTraceMessage);
  assert.equal(new Set(messages).size, reasons.length, 'messages must be distinct');
  assert.match(partialTraceMessage('cancelled'), /cancelled/i);
  assert.doesNotMatch(partialTraceMessage('cancelled'), /event limit/i);
  assert.match(partialTraceMessage('event_limit'), /event limit/i);
  assert.match(partialTraceMessage('timeout'), /time limit/i);
});
