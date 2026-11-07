'use strict';

/**
 * Normalize only platform line endings and final newline characters.
 * Leading whitespace, trailing spaces on content lines, and internal blank
 * lines remain significant so the comparison does not hide real differences.
 */
function normalizeOutput(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

function compareOutput(actual, expected) {
  const normalizedActual = normalizeOutput(actual);
  const normalizedExpected = normalizeOutput(expected);
  return {
    equal: normalizedActual === normalizedExpected,
    normalizedActual,
    normalizedExpected,
  };
}

/**
 * Classify a test without treating incomplete output capture as a valid pass
 * or mismatch. Runtime errors take precedence because execution did not finish.
 */
function classifyTestResult({ runtimeError = false, stdoutTruncated = false, incomplete = false, outputsEqual = false } = {}) {
  if (runtimeError) return 'runtime-error';
  if (incomplete) return 'incomplete';
  if (stdoutTruncated) return 'output-truncated';
  return outputsEqual ? 'passed' : 'failed';
}

module.exports = { normalizeOutput, compareOutput, classifyTestResult };
