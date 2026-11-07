'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePythonApiInvocation } = require('./python-interpreter.cjs');

const projectRoot = path.resolve(__dirname, '..');

test('uses the active interpreter selected in the Python extension', async () => {
  const resource = { fsPath: '/workspace/project/main.py' };
  const api = {
    environments: {
      getActiveEnvironmentPath: async (uri) => {
        assert.equal(uri, resource);
        return { path: '/workspace/project/.venv', id: 'selected-env' };
      },
      resolveEnvironment: async (environment) => {
        assert.equal(environment.id, 'selected-env');
        return { executable: { uri: { fsPath: '/workspace/project/.venv/bin/python' } } };
      },
    },
  };

  assert.deepEqual(await resolvePythonApiInvocation(api, resource), {
    command: '/workspace/project/.venv/bin/python',
    args: [],
  });
});

test('supports older Python extension execution details', async () => {
  const api = {
    settings: {
      getExecutionDetails: () => ({ execCommand: ['C:\\Python\\python.exe', '-X', 'utf8'] }),
    },
  };

  assert.deepEqual(await resolvePythonApiInvocation(api, {}), {
    command: 'C:\\Python\\python.exe',
    args: ['-X', 'utf8'],
  });
});

test('returns undefined when the Python extension has no usable interpreter', async () => {
  assert.equal(await resolvePythonApiInvocation({}, {}), undefined);
});

test('pythonPath is machine-scoped so workspace settings cannot override it', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['trace.pythonPath'].scope, 'machine');
});
