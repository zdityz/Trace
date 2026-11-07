const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, 'main.css'), 'utf8');

test('active tree and graph nodes use a visible theme-independent outline', () => {
  assert.match(css, /\.tree-svg \.tree-node\.node-active \.tree-node-circle/);
  assert.match(css, /\.graph-svg \.graph-node\.node-active \.graph-node-circle/);
  assert.match(css, /--trace-active-node-stroke:\s*color-mix\(in srgb, #58a6ff 82%, var\(--vscode-textLink-foreground, #58a6ff\)\)/);
  assert.match(css, /stroke:\s*var\(--trace-active-node-stroke\)\s*!important/);
  assert.match(css, /stroke-opacity:\s*1\s*!important/);
});

test('active-node outline does not use the possibly-transparent VS Code focusBorder token', () => {
  const activeRules = css.slice(css.lastIndexOf('/* 1.0.2: active nodes'));
  assert.doesNotMatch(activeRules, /stroke:\s*var\(--vscode-focusBorder/);
});
