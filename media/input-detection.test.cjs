'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { programReadsInput, shouldPromptForInput } = require('./input-detection.cjs');

test('detects input(), sys.stdin and fileinput usage', () => {
  assert.equal(programReadsInput('n = int(input())\n'), true);
  assert.equal(programReadsInput('x = input ("name: ")'), true);
  assert.equal(programReadsInput('import sys\nfor l in sys.stdin:\n  pass\n'), true);
  assert.equal(programReadsInput('from sys import stdin\n'), true);
  assert.equal(programReadsInput('import fileinput\n'), true);
});

test('does not flag programs that never read input', () => {
  assert.equal(programReadsInput('print("hello")\n'), false);
  assert.equal(programReadsInput('def my_input(x):\n    return x\nmy_input(1)\n'), false);
  assert.equal(programReadsInput('data.input(3)\n'), false);
  assert.equal(programReadsInput(''), false);
  assert.equal(programReadsInput(undefined), false);
});

test('promptForInput modes: always, never and auto', () => {
  assert.equal(shouldPromptForInput('always', 'print(1)'), true);
  assert.equal(shouldPromptForInput('never', 'input()'), false);
  assert.equal(shouldPromptForInput('auto', 'input()'), true);
  assert.equal(shouldPromptForInput('auto', 'print(1)'), false);
  assert.equal(shouldPromptForInput('something-else', 'print(1)'), false);
});
