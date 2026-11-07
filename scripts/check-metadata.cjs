#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packagePath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const errors = [];
const expected = {
  publisher: 'zdityz',
  repository: 'https://github.com/zdityz/Trace.git',
  bugs: 'https://github.com/zdityz/Trace/issues',
  homepage: 'https://github.com/zdityz/Trace#readme',
};

if (pkg.publisher !== expected.publisher) {
  errors.push(`publisher must be "${expected.publisher}" (found ${JSON.stringify(pkg.publisher)})`);
}
if (pkg.repository?.type !== 'git' || pkg.repository?.url !== expected.repository) {
  errors.push(`repository.url must be ${expected.repository}`);
}
if (pkg.bugs?.url !== expected.bugs) errors.push(`bugs.url must be ${expected.bugs}`);
if (pkg.homepage !== expected.homepage) errors.push(`homepage must be ${expected.homepage}`);
if (Object.prototype.hasOwnProperty.call(pkg, 'files')) {
  errors.push('package.json must not define "files" while .vscodeignore is present');
}
for (const [label, value] of [
  ['repository.url', pkg.repository?.url],
  ['bugs.url', pkg.bugs?.url],
  ['homepage', pkg.homepage],
]) {
  if (typeof value !== 'string' || /YOUR_GITHUB_USERNAME|CHANGE_ME|TODO/i.test(value)) {
    errors.push(`${label} contains a placeholder or is missing`);
  }
}

if (errors.length) {
  console.error('Trace release metadata validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Trace release metadata is valid.');
}
