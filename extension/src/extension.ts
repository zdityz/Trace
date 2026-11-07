import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
const traceProcessState = require(path.join(__dirname, '..', 'media', 'trace-process-state.cjs')) as {
  markTracePartial: (trace: TraceDocument, reason: 'timeout' | 'cancelled') => TraceDocument;
  partialTraceMessage: (reason: string | undefined) => string;
};

/** Thrown when the user cancels a run before Trace has anything worth showing. */
class RunCancelledError extends Error {
  constructor() {
    super('Execution cancelled.');
    this.name = 'RunCancelledError';
  }
}

interface TraceEvent {
  sequence: number;
  event: string;
  source?: { file?: string; line?: number; text?: string };
  function?: string;
  thread_id?: number;
  thread_name?: string;
  array_accesses?: Array<{
    array_name?: string;
    object_id?: string;
    index?: number;
    kind?: 'read' | 'write' | 'read_write';
  }>;
  state?: {
    frames?: Array<{
      scope_id?: string;
      function?: string;
      line?: number;
      thread_id?: number;
      thread_name?: string;
      locals?: Record<string, unknown>;
    }>;
    objects?: Record<string, unknown>;
    object_checkpoint?: boolean;
    object_delta?: { upserts?: Record<string, unknown>; removed?: string[] };
  };
  exception?: { type?: string; message?: string };
}

interface TraceDocument {
  schema_version: number;
  metadata: {
    script: string;
    python_version?: string;
    event_count?: number;
    truncated?: boolean;
    partial?: boolean;
    truncation_reason?: 'event_limit' | 'size_limit' | 'timeout' | 'cancelled';
    object_encoding?: 'delta-v1';
    line_state_timing?: 'before_execution';
    timed_out?: boolean;
    duration_ms?: number;
    exit_code?: number;
    stdout_truncated?: boolean;
    stderr_truncated?: boolean;
    program_error?: { type?: string; message?: string; kind?: 'runtime' | 'syntax'; location?: { file?: string; line?: number; column?: number; function?: string; source_text?: string }; event_sequence?: number; state_kind?: 'failure' | 'last_recorded' | 'none'; traceback?: string } | null;
  };
  stdout?: string;
  stderr?: string;
  events: TraceEvent[];
}

type OutputTestResult = {
  status: 'passed' | 'failed' | 'runtime-error' | 'output-truncated' | 'incomplete';
  stdin: string;
  expected: string;
  actual: string;
};

type OutputTestCase = {
  stdin: string;
  expectedOutput: string;
};

// Give the tracer time to flush file-descriptor capture and atomically commit
// the latest partial trace after SIGTERM. A forced kill remains as a fallback.
const PROCESS_TERMINATION_GRACE_MS = 5000;

export function activate(context: vscode.ExtensionContext): void {
  const runCommand = vscode.commands.registerCommand('trace.runCurrentFile', async () => {
    await runCurrentFile(context, false);
  });
  const runWithTestCaseCommand = vscode.commands.registerCommand('trace.runWithTestCase', async () => {
    await runCurrentFile(context, true);
  });
  context.subscriptions.push(runCommand, runWithTestCaseCommand);
}

async function runCurrentFile(context: vscode.ExtensionContext, withTestCase: boolean): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage(
      'Trace can only execute code in a trusted VS Code workspace. Use "Workspaces: Manage Workspace Trust" to trust this folder.'
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Open a Python file before running Trace.');
    return;
  }

  const document = editor.document;
  if (document.languageId !== 'python' && !document.fileName.toLowerCase().endsWith('.py')) {
    void vscode.window.showWarningMessage('Trace V1 currently supports Python files only.');
    return;
  }
  if (document.isUntitled || document.uri.scheme !== 'file') {
    void vscode.window.showWarningMessage('Save this Python file to disk before running Trace.');
    return;
  }
  if (document.isDirty) {
    const save = await vscode.window.showInformationMessage(
      'Trace runs the saved version of this file. Save your changes first?',
      'Save and Run',
      'Cancel'
    );
    if (save !== 'Save and Run') return;
    const saved = await document.save();
    if (!saved) return;
  }

  let testCase: OutputTestCase | undefined;
  let stdinText = '';
  if (withTestCase) {
    const stdinValue = await vscode.window.showInputBox({
      title: 'Trace Test Case · 1 of 2',
      prompt: 'Standard input (stdin). Type \\n to represent line breaks; leave blank if the program does not read input.',
      placeHolder: 'Example: 4\\n2 7 11 15\\n9',
      ignoreFocusOut: true,
    });
    if (stdinValue === undefined) return;

    const expectedValue = await vscode.window.showInputBox({
      title: 'Trace Test Case · 2 of 2',
      prompt: 'Expected standard output (stdout). Type \\n to represent line breaks. An empty output is allowed.',
      placeHolder: 'Example: 0 1',
      ignoreFocusOut: true,
    });
    if (expectedValue === undefined) return;

    stdinText = expandInputEscapes(stdinValue);
    testCase = {
      stdin: stdinText,
      expectedOutput: expandInputEscapes(expectedValue),
    };
  } else {
    const inputDetection = require(context.asAbsolutePath(path.join('media', 'input-detection.cjs'))) as {
      shouldPromptForInput: (mode: string, source: string) => boolean;
    };
    const promptMode = vscode.workspace.getConfiguration('trace').get<string>('promptForInput', 'auto');
    if (inputDetection.shouldPromptForInput(promptMode, document.getText())) {
      const memoryKey = `trace.lastStdin:${document.uri.fsPath}`;
      const stdinValue = await vscode.window.showInputBox({
        title: 'Trace Program Input',
        prompt: 'Standard input for this run. Type \\n to represent line breaks; leave blank for empty input.',
        placeHolder: 'Example: Alice\\n3',
        value: context.workspaceState.get<string>(memoryKey, ''),
        ignoreFocusOut: true,
      });
      if (stdinValue === undefined) return;
      void context.workspaceState.update(memoryKey, stdinValue);
      stdinText = expandInputEscapes(stdinValue);
    }
  }

  const scriptPath = document.uri.fsPath;
  const tracerPath = context.asAbsolutePath(path.join('tracer', 'tracer.py'));
  const settings = vscode.workspace.getConfiguration('trace');
  const pythonInvocation = await resolvePythonInvocation(document.uri, settings);
  const timeoutMs = clampInteger(settings.get<number>('executionTimeoutMs', 15000), 1000, 120000, 15000);
  const maxEvents = clampInteger(settings.get<number>('maxEvents', 20000), 100, 50000, 20000);

  const storageDirectory = context.globalStorageUri.fsPath;
  await fs.mkdir(storageDirectory, { recursive: true });
  const traceRetention = require(context.asAbsolutePath(path.join('media', 'trace-retention.cjs'))) as {
    pruneStoredTraces: (directory: string) => Promise<unknown>;
  };
  await traceRetention.pruneStoredTraces(storageDirectory);
  const tracePath = path.join(storageDirectory, `trace-${Date.now()}-${randomUUID()}.json`);

  try {
    const trace = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Trace: ${withTestCase ? 'Testing' : 'Running'} ${path.basename(scriptPath)}`,
        cancellable: true,
      },
      async (_progress, cancellation) => {
        const execution = executeTracer({
          pythonPath: pythonInvocation.command,
          pythonArgs: pythonInvocation.args,
          tracerPath,
          scriptPath,
          tracePath,
          timeoutMs,
          maxEvents,
          stdinText,
        });
        const cancellationSubscription = cancellation.onCancellationRequested(() => execution.cancel());
        try {
          return await execution.promise;
        } finally {
          cancellationSubscription.dispose();
        }
      }
    );

    const source = await fs.readFile(scriptPath, 'utf8');
    let outputTestResult: OutputTestResult | undefined;
    if (testCase) {
      const outputComparator = require(context.asAbsolutePath(path.join('media', 'output-comparison.cjs'))) as {
        compareOutput: (actual: string, expected: string) => { equal: boolean };
        classifyTestResult: (input: { runtimeError: boolean; stdoutTruncated: boolean; incomplete: boolean; outputsEqual: boolean }) => OutputTestResult['status'];
      };
      const comparison = trace.metadata.stdout_truncated || trace.metadata.truncated
        ? { equal: false }
        : outputComparator.compareOutput(trace.stdout ?? '', testCase.expectedOutput);
      outputTestResult = {
        status: outputComparator.classifyTestResult({
          runtimeError: Boolean(trace.metadata.program_error),
          stdoutTruncated: Boolean(trace.metadata.stdout_truncated),
          incomplete: Boolean(trace.metadata.truncated),
          outputsEqual: comparison.equal,
        }),
        stdin: testCase.stdin,
        expected: testCase.expectedOutput,
        actual: trace.stdout ?? '',
      };
    }
    openTracePanel(context, document, editor, trace, source, outputTestResult);

    if (trace.metadata.program_error) {
      const failureLine = trace.metadata.program_error.location?.line;
      const where = Number.isInteger(failureLine) ? ` at line ${failureLine}` : '';
      void vscode.window.showWarningMessage(
        `Trace captured the failed run. Python raised ${trace.metadata.program_error.type}${where}: ${trace.metadata.program_error.message}`
      );
    } else if (trace.metadata.truncated) {
      void vscode.window.showWarningMessage(traceProcessState.partialTraceMessage(trace.metadata.truncation_reason));
    } else if (outputTestResult?.status === 'failed') {
      void vscode.window.showWarningMessage('Trace: The program completed, but its standard output did not match the expected output.');
    } else if (outputTestResult?.status === 'passed') {
      void vscode.window.showInformationMessage('Trace: Test passed. Actual output matches the expected output.');
    } else {
      void vscode.window.showInformationMessage(`Trace recorded ${trace.events.length} execution events.`);
    }
  } catch (error) {
    if (error instanceof RunCancelledError) {
      void vscode.window.setStatusBarMessage('Trace: run cancelled.', 4000);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Trace: ${message}`);
  }
}

type PythonInvocation = { command: string; args: string[] };

async function resolvePythonInvocation(
  resource: vscode.Uri,
  settings: vscode.WorkspaceConfiguration,
): Promise<PythonInvocation> {
  // A user-level Trace override is explicit and takes precedence. The setting
  // is machine-scoped, so repository workspace settings cannot replace it.
  const configured = settings.inspect<string>('pythonPath')?.globalValue?.trim();
  if (configured) return { command: configured, args: [] };

  const pythonExtension = vscode.extensions.getExtension<unknown>('ms-python.python');
  if (pythonExtension) {
    try {
      const exports = pythonExtension.isActive ? pythonExtension.exports : await pythonExtension.activate();
      const raw = exports as {
        getAPI?: (version: number) => unknown;
        getApi?: (version: number) => unknown;
        environments?: unknown;
        settings?: unknown;
      };
      let api = raw;
      if (!api.environments && typeof raw.getAPI === 'function') {
        try { const candidate = raw.getAPI(2) as typeof raw | undefined; if (candidate) api = candidate; } catch { /* use compatibility API on raw exports */ }
      }
      if (!api.environments && typeof raw.getApi === 'function') {
        try { const candidate = raw.getApi(2) as typeof raw | undefined; if (candidate) api = candidate; } catch { /* use compatibility API on raw exports */ }
      }

      const interpreterResolver = require(path.join(__dirname, '..', 'media', 'python-interpreter.cjs')) as {
        resolvePythonApiInvocation: (api: unknown, resource: vscode.Uri) => Promise<PythonInvocation | undefined>;
      };
      const selected = await interpreterResolver.resolvePythonApiInvocation(api, resource);
      if (selected?.command) return selected;
    } catch {
      // The Python extension may still be initializing or may not expose its
      // environment API. Fall back to the platform's conventional executable.
    }
  }

  return { command: process.platform === 'win32' ? 'python' : 'python3', args: [] };
}

function executeTracer(options: {
  pythonPath: string;
  pythonArgs: string[];
  tracerPath: string;
  scriptPath: string;
  tracePath: string;
  timeoutMs: number;
  maxEvents: number;
  stdinText?: string;
}): { promise: Promise<TraceDocument>; cancel: () => void } {
  let child: ReturnType<typeof spawn> | undefined;
  let timedOut = false;
  let cancelled = false;
  let timeout: NodeJS.Timeout | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  let childClosed = false;
  const processTree = require(path.join(__dirname, '..', 'media', 'process-tree.cjs')) as {
    terminateProcessTree: (child: ReturnType<typeof spawn> | undefined, signal: NodeJS.Signals) => void;
  };

  const promise = new Promise<TraceDocument>((resolve, reject) => {
    child = spawn(
      options.pythonPath,
      [...options.pythonArgs, options.tracerPath, options.scriptPath, '--output', options.tracePath, '--max-events', String(options.maxEvents)],
      {
        cwd: path.dirname(options.scriptPath),
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      }
    );
    if (child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdinText ?? '', 'utf8');
    }

    let launcherStdout = '';
    let launcherStderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (launcherStdout.length < 4000) launcherStdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (launcherStderr.length < 8000) launcherStderr += chunk.toString('utf8');
    });

    timeout = setTimeout(() => {
      timedOut = true;
      processTree.terminateProcessTree(child, 'SIGTERM');
      forceKill = setTimeout(() => {
        processTree.terminateProcessTree(child, 'SIGKILL');
        forceKill = undefined;
      }, PROCESS_TERMINATION_GRACE_MS);
    }, options.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timeout);
      if (forceKill && !timedOut && !cancelled) clearTimeout(forceKill);
      reject(new Error(`Could not start Python (${options.pythonPath}): ${error.message}`));
    });

    child.on('close', async (code) => {
      childClosed = true;
      clearTimeout(timeout);
      // Keep the escalation timer after timeout/cancellation: descendants may
      // outlive the Python parent, and the process group still needs SIGKILL.
      if (forceKill && !timedOut && !cancelled) clearTimeout(forceKill);
      try {
        const raw = await fs.readFile(options.tracePath, 'utf8');
        const parsed = JSON.parse(raw) as TraceDocument;
        validateTrace(parsed);
        if (timedOut || cancelled) {
          if (parsed.events.length === 0) {
            // The run was stopped before a single event was recorded (for
            // example while stuck in one long native call), so there is no
            // history to show.
            if (cancelled && !timedOut) {
              reject(new RunCancelledError());
            } else {
              reject(new Error(`Execution exceeded the ${options.timeoutMs} ms time limit before Trace recorded any events. The program may be blocked in a long native call; try a smaller input.`));
            }
            return;
          }
          traceProcessState.markTracePartial(parsed, timedOut ? 'timeout' : 'cancelled');
        }
        resolve(parsed);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const launcherDetail = [launcherStdout.trim(), launcherStderr.trim()].filter(Boolean).join('\n');
        if (cancelled && !timedOut) {
          // The user asked to stop and no recoverable history exists: nothing to report.
          reject(new RunCancelledError());
          return;
        }
        if (timedOut) {
          reject(new Error(
            `Execution exceeded the ${options.timeoutMs} ms time limit. Trace could not recover a partial history: ${detail}${launcherDetail ? `\n${launcherDetail}` : ''}`
          ));
          return;
        }
        reject(new Error(
          code === 0
            ? `Python finished, but Trace could not read its trace: ${detail}${launcherDetail ? `\n${launcherDetail}` : ''}`
            : `Python tracer exited with code ${code ?? 'unknown'} and did not produce a valid trace: ${detail}${launcherDetail ? `\n${launcherDetail}` : ''}`
        ));
      }
    });
  });

  return {
    promise,
    cancel: () => {
      if (childClosed || cancelled || timedOut) return;
      cancelled = true;
      processTree.terminateProcessTree(child, 'SIGTERM');
      forceKill = setTimeout(() => {
        processTree.terminateProcessTree(child, 'SIGKILL');
        forceKill = undefined;
      }, PROCESS_TERMINATION_GRACE_MS);
    },
  };
}

function validateTrace(trace: TraceDocument): void {
  if (!trace || trace.schema_version !== 1 || !Array.isArray(trace.events) || !trace.metadata) {
    throw new Error('Unsupported or malformed Trace trace format.');
  }
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index];
    if (event.sequence !== index || !event.state || !Array.isArray(event.state.frames) || !event.state.objects) {
      throw new Error(`Trace event ${index} is incomplete or out of sequence.`);
    }
    if (event.state.object_delta && typeof event.state.object_delta.upserts !== 'object') {
      throw new Error(`Trace event ${index} contains an invalid object delta.`);
    }
  }
  const failureSequence = trace.metadata.program_error?.event_sequence;
  if (failureSequence !== undefined && (!Number.isInteger(failureSequence) || failureSequence < 0 || failureSequence >= trace.events.length)) {
    throw new Error('The recorded program-error event points outside the execution history.');
  }
}

function openTracePanel(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
  trace: TraceDocument,
  source: string,
  testResult?: OutputTestResult
): void {
  const lineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editorOverviewRuler.currentContentForeground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.currentContentForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  const panel = vscode.window.createWebviewPanel(
    'trace.execution',
    `Trace: ${path.basename(document.fileName)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    }
  );

  const messageSubscription = panel.webview.onDidReceiveMessage((message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const payload = message as { type?: string; line?: number };
    if (payload.type === 'ready') {
      void panel.webview.postMessage({
        type: 'loadTrace',
        trace,
        source,
        testResult: testResult ?? null,
      });
    } else if (payload.type === 'cursorChanged' && Number.isInteger(payload.line)) {
      const line = payload.line as number;
      if (document.isClosed) return;
      if (line < 1 || line > document.lineCount) {
        editor.setDecorations(lineDecoration, []);
        return;
      }
      const range = new vscode.Range(line - 1, 0, line - 1, document.lineAt(line - 1).text.length);
      editor.setDecorations(lineDecoration, [range]);
    }
  });

  panel.onDidDispose(() => {
    messageSubscription.dispose();
    if (!document.isClosed) editor.setDecorations(lineDecoration, []);
    lineDecoration.dispose();
  }, undefined, context.subscriptions);

  // Register the message listener before the webview script can announce readiness.
  panel.webview.html = getWebviewHtml(context, panel.webview);
}

function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = randomToken();
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.css'));
  const historyModelUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'history-model.js'));
  const traceStateUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'trace-state.js'));
  const structureModelUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'structure-model.js'));
  const visualizationCacheUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'visualization-cache.js'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Trace</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="app" class="loading">Waiting for Trace trace…</div>
  <script nonce="${nonce}" src="${traceStateUri}"></script>
  <script nonce="${nonce}" src="${historyModelUri}"></script>
  <script nonce="${nonce}" src="${structureModelUri}"></script>
  <script nonce="${nonce}" src="${visualizationCacheUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function randomToken(): string {
  return randomUUID().replace(/-/g, '');
}

function expandInputEscapes(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
