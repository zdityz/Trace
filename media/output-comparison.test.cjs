'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOutput, compareOutput, classifyTestResult } = require('./output-comparison.cjs');

test('normalizes CRLF and CR line endings', () => {
  assert.equal(normalizeOutput('one\r\ntwo\rthree'), 'one\ntwo\nthree');
});

test('ignores one or more final newline characters', () => {
  assert.deepEqual(compareOutput('0 1\n\n', '0 1'), {
    equal: true,
    normalizedActual: '0 1',
    normalizedExpected: '0 1',
  });
});

test('preserves internal blank lines', () => {
  assert.equal(compareOutput('one\n\ntwo\n', 'one\ntwo').equal, false);
});

test('preserves leading whitespace and trailing spaces on content lines', () => {
  assert.equal(compareOutput('  value\n', 'value').equal, false);
  assert.equal(compareOutput('value \n', 'value').equal, false);
});

test('treats two empty outputs as equal', () => {
  assert.equal(compareOutput('', '\n').equal, true);
});

test('returns both normalized forms for mismatch inspection', () => {
  const result = compareOutput('0 2\n', '0 1\n');
  assert.equal(result.equal, false);
  assert.equal(result.normalizedActual, '0 2');
  assert.equal(result.normalizedExpected, '0 1');
});

test('does not report a pass or mismatch when stdout capture was truncated', () => {
  assert.equal(classifyTestResult({ stdoutTruncated: true, outputsEqual: true }), 'output-truncated');
  assert.equal(classifyTestResult({ stdoutTruncated: true, outputsEqual: false }), 'output-truncated');
});

test('runtime errors take precedence over output truncation', () => {
  assert.equal(classifyTestResult({ runtimeError: true, stdoutTruncated: true }), 'runtime-error');
});

test('incomplete execution is never reported as a passing output test', () => {
  assert.equal(classifyTestResult({ incomplete: true, outputsEqual: true }), 'incomplete');
});

test('classifies complete output comparisons', () => {
  assert.equal(classifyTestResult({ outputsEqual: true }), 'passed');
  assert.equal(classifyTestResult({ outputsEqual: false }), 'failed');
});
