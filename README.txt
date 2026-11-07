TRACE — PYTHON EXECUTION VISUALIZER FOR VS CODE
================================================

See what your Python code actually does.

Trace is a Visual Studio Code extension that records a Python program's real
execution and lets you explore it beside your editor. Step through the run,
inspect variables and function scopes, visualize supported data structures,
and investigate runtime errors or unexpected output. Everything runs locally.

FEATURES
--------
- Step forward and backward through recorded execution; play, pause, and seek.
- Highlight the active source line in the original VS Code editor.
- Inspect variables, values, function scopes, and the full execution history.
- Visualize Python lists, common singly linked lists, binary trees, and simple
  graphs represented as adjacency dictionaries.
- Inspect the exact recorded event when an uncaught runtime exception occurs.
- Compare actual standard output with expected output using custom standard
  input and expected-output test cases.
- Trace user code in newly created threads and retain generator scopes across
  resumes.
- Skip virtual environments and installed Python packages so dependency
  internals do not consume the event budget.

SUPPORTED DATA STRUCTURES
-------------------------
Lists / arrays:
  Built-in Python lists, shown as indexed cells with supported access
  highlighting and change tracking.

Linked lists:
  User-defined node instances with a 'next' attribute and a value-like
  attribute named 'value', 'val', 'key', 'data', or 'label'.

Binary trees:
  User-defined node instances with 'left' and 'right' attributes and a
  value-like attribute.

Graphs:
  Dictionaries whose primitive node labels map to lists, tuples, or sets of
  primitive neighboring labels.

Dictionaries, sets, and frozensets are available in the variable and history
inspectors. Detection of custom structures is conservative; slot-only node
classes, general trees, adjacency matrices, weighted edges, NetworkX objects,
and arbitrary graph classes are not automatically visualized.

REQUIREMENTS
------------
- Visual Studio Code 1.90 or newer.
- Python 3.10 or newer.
- The Microsoft Python extension is recommended; Trace uses its selected
  interpreter automatically. Without it, Trace falls back to python3 on
  macOS/Linux or python on Windows.
- A trusted VS Code workspace. Execution is blocked in Restricted Mode.

QUICK START
-----------
1. Install Trace from the Visual Studio Code Extensions view once published,
   or install a local VSIX using Extensions > ... > Install from VSIX.
2. Open a Python project and trust the workspace.
3. Open and save a .py file.
4. Open the Command Palette (Cmd/Ctrl + Shift + P).
5. Run: Trace: Run Current Python File.
6. Explore the Trace panel beside the editor. The highlighted line is the
   next line to execute; the runtime snapshot is captured immediately before
   that line runs.

To test output, run 'Trace: Run with Test Case'. Enter standard input and
expected standard output. Type the two-character sequence \n in a prompt to
represent a line break. Trace compares standard output only; standard error is
shown separately.

SETTINGS
--------
trace.pythonPath
  Default: Auto
  Optional machine-specific interpreter override. When empty, Trace uses
  the Microsoft Python extension's selected interpreter.

trace.executionTimeoutMs
  Default: 15000
  Maximum run time in milliseconds. Allowed range: 1000–120000.

trace.maxEvents
  Default: 20000
  Maximum recorded execution events. Allowed range: 100–50000. When the limit
  is reached, Trace stops the program and keeps the history recorded so far,
  so later output is not produced.

trace.promptForInput
  Default: auto
  When to ask for standard input before a run: auto (only if the file appears
  to read input), always, or never.

Trace runs the saved file directly in its directory. Save changes before
starting a run. It captures standard output and standard error,
each up to 1,000,000 characters or 1 MB of JSON-encoded text, whichever comes
first. Each trace has a 16 MiB JSON size budget; object
changes are stored as compact deltas, and recording stops with available
history saved when the budget is reached. Runs also stop at the event-count
or execution-time limit, preserving the latest recoverable partial history
instead of continuing without recording. If standard output is truncated,
expected-output comparison is skipped. Up to 25 trace files are retained,
and files older than 30 days are removed when a new run starts.

SECURITY AND PRIVACY
--------------------
Trace runs Python as a child process with your current operating-system
permissions. THIS IS NOT A SECURITY SANDBOX. Code can access the files,
environment variables, processes, and network resources available to your
account. Do not run untrusted code on a machine containing sensitive data.
Use an isolated account, container, or virtual machine when appropriate.

Trace files can contain variable values, credentials, tokens, file paths,
personal information, or proprietary data. Treat trace files and screenshots
as sensitive. Trace stores traces in VS Code extension storage and does not
send source code or traces to a remote service. See SECURITY.md for details.

BUILD AND TEST FROM SOURCE
--------------------------
Development requirements: Node.js 20 or newer, npm, Python 3.10 or newer,
and Visual Studio Code.

    npm install
    npm run check:metadata
    npm run compile
    npm test

Press F5 in VS Code to launch the Extension Development Host.

To build a local VSIX:

    npm install -g @vscode/vsce
    npm run package:vsix

The VSIX can be installed from the VS Code Extensions view using
'Install from VSIX...'.

ACKNOWLEDGEMENTS
----------------
I would like to express my sincere gratitude to **[Kuhu Vilecha](https://www.linkedin.com/in/kuhu-vilecha/)** for her valuable guidance, mentorship, and support throughout the development of Trace.

Her insights, encouragement, and feedback played an important role in shaping this project and bringing it to completion.

Thank you for your continuous support and guidance.

ABOUT THE DEVELOPER
-------------------
Hi, I'm **Aditya**, a Computer Science student specializing in Artificial Intelligence and Machine Learning.

I'm passionate about exploring technology, building practical software projects and developing tools that make complex concepts easier to understand.

I built **Trace** with the goal of helping developers and students understand how programs execute through interactive visualizations, making debugging and learning algorithms more intuitive.

**Connect with me:**
- [GitHub](https://github.com/zdityz)
- [LinkedIn](www.linkedin.com/in/zdityz)

PROJECT LICENSE
---------------
MIT License. See the LICENSE file.

Trace is an execution-exploration companion. It is not an automatic code fixer,
AI assistant, notebook, or replacement for the native VS Code debugger.
