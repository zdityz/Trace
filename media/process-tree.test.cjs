'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { terminateProcessTree } = require('./process-tree.cjs');

test('signals the detached POSIX process group', () => {
  const calls = [];
  const child = { pid: 1234, kill: (signal) => calls.push(['child', signal]) };
  terminateProcessTree(child, 'SIGTERM', {
    platform: 'darwin',
    killProcess: (pid, signal) => calls.push([pid, signal]),
  });
  assert.deepEqual(calls, [[-1234, 'SIGTERM']]);
});

test('falls back to direct child termination when POSIX group signaling fails', () => {
  const calls = [];
  const child = { pid: 1234, kill: (signal) => calls.push(signal) };
  terminateProcessTree(child, 'SIGKILL', {
    platform: 'linux',
    killProcess: () => { throw new Error('process group unavailable'); },
  });
  assert.deepEqual(calls, ['SIGKILL']);
});

test('terminates the Windows process tree forcefully because SIGTERM cannot be delivered', () => {
  const calls = [];
  const child = { pid: 1234, kill: (signal) => calls.push(['child', signal]) };
  let command;
  const killer = new EventEmitter();
  killer.unref = () => calls.push(['unref']);
  terminateProcessTree(child, 'SIGTERM', {
    platform: 'win32',
    spawnProcess: (...args) => { command = args; return killer; },
  });
  assert.equal(command[0], 'taskkill');
  assert.deepEqual(command[1], ['/pid', '1234', '/t', '/f']);
  killer.emit('close', 1);
  // If taskkill itself fails, fall back to terminating the direct child.
  assert.deepEqual(calls, [['unref'], ['child', 'SIGTERM']]);
});

test('uses the same forced Windows shutdown for the escalation pass', () => {
  const calls = [];
  const child = { pid: 1234, kill: (signal) => calls.push(['child', signal]) };
  let command;
  const killer = new EventEmitter();
  killer.unref = () => calls.push(['unref']);
  terminateProcessTree(child, 'SIGKILL', {
    platform: 'win32',
    spawnProcess: (...args) => { command = args; return killer; },
  });
  assert.equal(command[0], 'taskkill');
  assert.deepEqual(command[1], ['/pid', '1234', '/t', '/f']);
  killer.emit('close', 1);
  assert.deepEqual(calls, [['unref'], ['child', 'SIGKILL']]);
});

test('ignores missing or invalid child processes', () => {
  const calls = [];
  terminateProcessTree(undefined, 'SIGTERM', { killProcess: (...args) => calls.push(args) });
  terminateProcessTree({ pid: 0, kill: () => calls.push('bad') }, 'SIGTERM');
  assert.deepEqual(calls, []);
});
