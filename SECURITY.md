# Security Policy

## Supported versions

Security fixes are intended for the latest V1 release. Earlier experimental development ZIPs are not maintained release channels.

## Running code safely

Trace executes the selected Python file in a child process. The extension requires a trusted VS Code workspace and enforces a configurable wall-clock timeout and event-count limit. These controls are operational safeguards, **not a sandbox**.

The Python program still runs as the current operating-system user. It can access files, environment variables, processes, and network resources available to that user. On timeout or cancellation, Trace attempts to terminate the launched process tree (POSIX process group or Windows `taskkill /T`). This is cleanup behavior, not a sandbox. Only run code you trust, or use a separate OS account/container/VM with no sensitive credentials when testing untrusted code.

## Trace contents

Trace snapshots include local variable values and serialized containers/user-defined instance attributes. These can contain passwords, tokens, file paths, personal data, or proprietary information. Trace files are stored in VS Code extension global storage. Trace retains up to 25 recent trace files and removes files older than 30 days when a new run starts. Captured stdout and stderr are each limited to 1,000,000 characters; when stdout is truncated, expected-output comparison is skipped. Do not publish raw traces or screenshots without inspecting them for sensitive values.

Trace V1 does not upload source code or traces to a remote service.

## Reporting a vulnerability

Do not disclose exploitable vulnerabilities in a public issue. Contact the repository maintainer privately with the affected version, environment, reproduction steps, and impact. Remove credentials and sensitive user data from reports.
