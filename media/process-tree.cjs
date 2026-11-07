'use strict';

const { spawn } = require('node:child_process');

/**
 * Best-effort termination of the tracer and any child processes it launched.
 * This is process cleanup only; it does not sandbox the executed program.
 * Optional dependencies make the platform-specific behavior unit-testable.
 */
function terminateProcessTree(child, signal, dependencies = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;

  const platform = dependencies.platform || process.platform;
  const spawnProcess = dependencies.spawnProcess || spawn;
  const killProcess = dependencies.killProcess || process.kill.bind(process);

  if (platform === 'win32') {
    // Windows has no way to deliver SIGTERM to the Python tracer, and a
    // window-less console process normally refuses a non-forced taskkill, so a
    // "graceful" first pass would only add a delay. Terminate the tree right
    // away; the tracer's periodic atomic checkpoints are what preserve the
    // partial history on this platform.
    const force = true;
    const args = ['/pid', String(child.pid), '/t', '/f'];
    const killer = spawnProcess('taskkill', args, {
      windowsHide: true,
      stdio: 'ignore',
    });
    const fallback = () => {
      child.kill(signal);
    };
    killer.once('error', fallback);
    killer.once('close', (code) => {
      if (code !== 0) fallback();
    });
    if (typeof killer.unref === 'function') killer.unref();
    return;
  }

  try {
    // The extension launches the Python tracer as a detached process-group leader.
    killProcess(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

module.exports = { terminateProcessTree };
