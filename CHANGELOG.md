# Changelog

## Unreleased

Security:

- The command allowlist and the model, shell, checkpoint, skills, web and browser settings are now read from user settings only; values in a workspace's `.vscode/settings.json` are ignored. **Always allow** now saves to user settings. Entries you previously allowed in a workspace need to be added again.
- Allow-listed commands no longer run without asking when they use redirection to a file, environment prefixes (other than `CI`, `NODE_ENV` and similar), PowerShell or cmd expansion, control or non-ASCII characters, code-loading flags such as `--script-shell`, or paths outside the workspace. `*` can no longer stand for the program name.
- Git history and configuration commands, app launchers and nested shells (`cmd /c`, `bash -c`, `powershell -EncodedCommand`) are recognised however the program is spelled (`git.exe`, `"git"`, `/usr/bin/git`, `git --no-pager push`).
- **Always allow** no longer offers shells, interpreters, package installs or bare `git`.
- `edit_file` no longer quotes files outside the workspace or secrets files in its error messages, which reached the model before any approval.
- `grep` skips secrets files (`.env`, keys, credentials) in directory-wide searches, even when its glob names them.
- NTFS alternate data stream paths (`file::$DATA`) are rejected, and a link to a secrets file counts as a secrets file.
- Changes to `.git/` and `.vscode/` always ask, in every mode.
- `npx` no longer installs missing packages without asking (`npm_config_yes=false`).

## 0.1.0

First release.

- Chat panel connected to a self-hosted Open WebUI, with streaming, reasoning display, context meter and sovereignty indicator.
- Autonomous agent loop with file, search, shell, background-process, image, task-list and question tools; native and text-based tool calling.
- Permission modes (Plan, Ask before edits, Auto-accept edits, Review at end), command allowlist and always-ask rules.
- Workspace checkpoints in a private Git repository with rewind; native diff view; per-file review.
- Project memory, skills (with an example data-visualisation skill), automatic context compaction and local conversation history.
- Optional web search and fetch through Open WebUI (SearXNG) and a localhost-only headless browser tool.
