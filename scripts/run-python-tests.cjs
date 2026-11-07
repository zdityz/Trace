#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const candidates = process.env.TRACE_PYTHON
  ? [process.env.TRACE_PYTHON]
  : process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];

let lastError;
for (const executable of candidates) {
  const args = executable === 'py'
    ? ['-3', '-m', 'unittest', 'discover', '-s', 'tracer/tests', '-v']
    : ['-m', 'unittest', 'discover', '-s', 'tracer/tests', '-v'];
  const result = spawnSync(executable, args, { stdio: 'inherit' });
  if (!result.error) {
    process.exit(result.status ?? 1);
  }
  lastError = result.error;
}

process.stderr.write(`Trace tests could not start Python. Set TRACE_PYTHON to your interpreter path. ${lastError?.message ?? ''}\n`);
process.exit(1);
