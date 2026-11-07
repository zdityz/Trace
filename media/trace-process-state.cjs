'use strict';

/**
 * Marks a successfully recovered trace as a user-cancelled or timed-out run.
 * The Python tracer commits the partial JSON atomically before it exits; this
 * helper adds the extension-level reason without mutating its event history.
 */
function markTracePartial(trace, reason) {
  if (!trace || typeof trace !== 'object' || !trace.metadata || typeof trace.metadata !== 'object') {
    throw new TypeError('A valid Trace document is required.');
  }
  if (reason !== 'timeout' && reason !== 'cancelled') {
    throw new TypeError(`Unsupported partial-trace reason: ${reason}`);
  }
  trace.metadata.truncated = true;
  trace.metadata.partial = true;
  trace.metadata.timed_out = reason === 'timeout';
  trace.metadata.truncation_reason = reason;
  return trace;
}

/**
 * User-facing notice for a trace that stopped before the program finished.
 * Every reason the tracer or extension can record has its own wording, so a
 * cancelled run is never reported as an event-limit stop.
 */
function partialTraceMessage(reason) {
  switch (reason) {
    case 'timeout':
      return 'Trace reached the execution time limit. The partial execution history has been preserved.';
    case 'cancelled':
      return 'Trace run was cancelled. The execution history recorded up to that point has been kept.';
    case 'size_limit':
      return 'Trace reached its storage limit. The partial execution history has been preserved.';
    case 'event_limit':
      return 'Trace reached the event limit and stopped the program. The partial execution history has been preserved.';
    default:
      return 'Trace stopped before the program finished. The partial execution history has been preserved.';
  }
}

module.exports = { markTracePartial, partialTraceMessage };
