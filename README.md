# Trace

**See what your Python code actually does.**

Trace is a Visual Studio Code extension that records a Python program's real execution and lets you explore it beside your editor. Move through the run, inspect variables and function scopes, watch supported data structures change, and investigate runtime errors or unexpected output—all locally on your machine.

![Trace extension icon](media/icon.png)

## What you can do

- **Replay a run:** move forward or backward, play, pause, and jump through recorded execution events.
- **Follow the source:** the selected execution line is highlighted in the original editor.
- **Inspect runtime state:** examine variables, values, and function scopes at each recorded step.
- **Review execution history:** use the history table to compare state across the run and jump directly to an event.
- **Visualize data structures:** inspect Python lists, common singly linked lists, binary trees, and simple adjacency-dictionary graphs.
- **Investigate failures:** jump to the recorded exception with its source location, traceback, and captured state.
- **Check program output:** provide standard input and expected standard output, then compare the result with the program's actual output.
- **Trace Python threads and generators:** include user-code execution from newly created threads, identify the thread in each scope, and keep generator scopes stable across resumes.
- **Focus on project code:** skip virtual environments and installed Python packages so dependency internals do not consume the event budget.

Trace is an execution-exploration companion, not an automatic code fixer, AI assistant, notebook, or replacement for the native VS Code debugger. Your normal editing workflow stays in VS Code.

## Supported visualizations

| Python structure | How Trace recognizes it |
|---|---|
| Lists and arrays | Built-in `list` values, shown as indexed cells with supported read/write highlighting and change tracking. |
| Linked lists | User-defined node objects with a `next` attribute and a value-like attribute such as `value`, `val`, `key`, `data`, or `label`. |
| Binary trees | User-defined node objects with `left` and `right` attributes and a value-like attribute. |
| Graphs | Dictionaries whose primitive node labels map to lists, tuples, or sets of primitive neighboring labels. |
| Dictionaries and sets | Shown in the variable and execution-history inspectors. |

Recognition is intentionally conservative. Slot-only node classes, general trees, adjacency matrices, weighted-edge formats, NetworkX objects, and arbitrary custom graph classes are not automatically visualized. Unrecognized values remain available in the normal variable and history inspectors where they can be serialized.

## Requirements

- Visual Studio Code 1.90 or newer.
- Python 3.10 or newer.
- The Microsoft Python extension is recommended; Trace uses its selected interpreter automatically. Without it, Trace falls back to `python3` on macOS/Linux or `python` on Windows.
- A trusted VS Code workspace. Trace does not execute code while the workspace is in Restricted Mode.

## Install

Once Trace is published, search for **Trace** in the Visual Studio Code Extensions view and select **Install**.

To install a locally built VSIX instead:

1. Open the Extensions view in VS Code.
2. Open the **…** menu.
3. Select **Install from VSIX…**.
4. Choose the `trace-1.0.2.vsix` file.

## Use Trace

1. Open a Python project in VS Code and trust the workspace.
2. Open and save a `.py` file.
3. Open the Command Palette (`Cmd/Ctrl + Shift + P`).
4. Run **Trace: Run Current Python File**.
5. Explore the execution timeline, current variables, history table, visualizations, and console in the Trace panel beside the editor. The highlighted line is the next line to execute; its runtime snapshot is captured immediately before it runs.

To compare output against a known result, run **Trace: Run with Test Case**. Enter standard input and expected standard output when prompted. Use the two-character sequence `\n` in a prompt to represent a line break. Only standard output is compared; standard error is shown separately.

Trace runs the saved version of the file. Save your changes before starting a run, or choose the save-and-run option when prompted.

## Settings

Search for **Trace** in VS Code Settings, or add these values to your `settings.json`:

| Setting | Default | Description |
|---|---:|---|
| `trace.pythonPath` | Auto | Optional machine-specific interpreter override. By default, Trace uses the Microsoft Python extension's selected interpreter. |
| `trace.executionTimeoutMs` | `15000` | Maximum run time in milliseconds (1,000–120,000). |
| `trace.maxEvents` | `5000` | Maximum execution events recorded per run (100–50,000). |

Trace starts Python directly in the target file's directory, preserving ordinary relative-import behavior. It captures up to 1,000,000 characters each for standard output and standard error. Each trace has a 16 MiB JSON size budget; object changes are stored as compact deltas, and recording stops with the available history saved when the budget is reached. Runs also stop when the event-count or execution-time limit is reached; Trace preserves the latest recoverable partial history instead of continuing without recording. When standard output is truncated, output comparison is skipped to avoid reporting a false pass. Up to 25 recent trace files are retained; files older than 30 days are removed when a new run starts.

## Security and privacy

Trace executes your Python program as a separate child process, using your current operating-system account and permissions. **This is not a security sandbox.** A program may access files, environment variables, processes, and network resources available to your account. Do not use Trace to run untrusted code on a machine containing sensitive information. Use an isolated operating-system account, container, or virtual machine when necessary.

Execution traces can contain variable values, credentials, tokens, file paths, personal information, or proprietary data. Treat trace files and screenshots as sensitive. Trace stores trace files in VS Code extension storage and does not send your source code or traces to a remote service.

For additional security information, see [SECURITY.md](SECURITY.md).

## Build from source

Requirements for development: Node.js 20 or newer, npm, Python 3.10 or newer, and VS Code.

```bash
npm install
npm run check:metadata
npm run compile
npm test
```

To launch the Extension Development Host, open the project in VS Code and press **F5**. To create an installable package, install the VS Code packaging CLI and run:

```bash
npm install -g @vscode/vsce
npm run package:vsix
```

The generated VSIX can be installed using **Install from VSIX…**. Automated tests cover the Python tracer and the JavaScript history, output-comparison, structure-recognition, visualization-cache, trace-retention, styling, and process-tree modules.

## Acknowledgements

I would like to express my sincere gratitude to **[Kuhu Vilecha](https://www.linkedin.com/in/kuhu-vilecha/)** for her valuable guidance, mentorship, and support throughout the development of Trace.

Her insights, encouragement, and feedback played an important role in shaping this project and bringing it to completion.

Thank you for your continuous support and guidance.

## About Me

Hi, I'm **Aditya**, a Computer Science student specializing in Artificial Intelligence and Machine Learning.

I'm passionate about exploring technology, building practical software projects and developing tools that make complex concepts easier to understand.

I built **Trace** with the goal of helping developers and students understand how programs execute through interactive visualizations, making debugging and learning algorithms more intuitive.

**Connect with me:**
- [GitHub](https://github.com/zdityz)
- [LinkedIn](www.linkedin.com/in/zdityz)