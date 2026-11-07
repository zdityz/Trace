'use strict';

/**
 * Heuristic: does this Python source appear to read standard input?
 * Used only to decide whether to show the stdin prompt in "auto" mode.
 * A false negative is harmless (the user can choose "always" or use
 * "Run with Test Case"); a false positive only shows one extra prompt.
 * Comments and string literals are not parsed, so the check is deliberately
 * permissive.
 */
const READS_INPUT_PATTERN = /(^|[^\w.])input\s*\(|\bsys\s*\.\s*stdin\b|\bfileinput\b|\bstdin\b|\braw_input\s*\(/m;

function programReadsInput(source) {
  return READS_INPUT_PATTERN.test(String(source ?? ''));
}

/**
 * @param {'auto'|'always'|'never'|string} mode value of trace.promptForInput
 * @param {string} source Python source text
 */
function shouldPromptForInput(mode, source) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return programReadsInput(source);
}

module.exports = { programReadsInput, shouldPromptForInput };
