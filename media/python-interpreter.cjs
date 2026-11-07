'use strict';

async function resolvePythonApiInvocation(api, resource) {
  if (!api || typeof api !== 'object') return undefined;

  try {
    const environments = api.environments;
    if (environments && typeof environments.getActiveEnvironmentPath === 'function'
      && typeof environments.resolveEnvironment === 'function') {
      const activeEnvironment = await environments.getActiveEnvironmentPath(resource);
      if (activeEnvironment) {
        const resolved = await environments.resolveEnvironment(activeEnvironment);
        const executable = resolved && resolved.executable && resolved.executable.uri
          ? resolved.executable.uri.fsPath
          : undefined;
        if (typeof executable === 'string' && executable.trim()) {
          return { command: executable, args: [] };
        }
      }
    }
  } catch {
    // Continue to the compatibility API below when environment resolution fails.
  }

  try {
    const details = api.settings && typeof api.settings.getExecutionDetails === 'function'
      ? await api.settings.getExecutionDetails(resource)
      : undefined;
    const command = details && details.execCommand;
    if (Array.isArray(command) && command.length > 0
      && typeof command[0] === 'string' && command[0].trim()) {
      return { command: command[0], args: command.slice(1).filter((item) => typeof item === 'string') };
    }
  } catch {
    // A missing or older Python extension should not prevent the fallback.
  }

  return undefined;
}

module.exports = { resolvePythonApiInvocation };
