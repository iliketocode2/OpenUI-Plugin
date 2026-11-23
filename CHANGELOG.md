# Changelog

## Unreleased

Tool calling:

- The text-based tool protocol and the automatic fallback to it are gone, along with the per-model `toolMode` setting. The agent uses native tool calling only; a model whose server rejects tools now gets a clear error instead of a silent switch. The fallback could run a tool call the model had only shown as an example inside a code fence, and an unrelated error that mentioned "tool calling" switched the rest of the run to text mode.

Settings:

- Five settings are gone. VS Code ignores them if they are still in your settings file.
  - `owuiAgent.defaultModel`: the model you pick is remembered; the first model is used until you pick one.
  - `owuiAgent.request.maxRetries`: always 3.
  - `owuiAgent.scratchpad.retentionDays`: always 7 days.
  - `owuiAgent.web.confirmedEngine`: it only changed the wording of the web badge. When the engine cannot be read, check Admin Panel → Settings → Web Search yourself.
  - `owuiAgent.browser.allowExternalRequests`: pages opened by the browser tool can no longer load internet resources at all.

Conversation:

- When you rewind only the code, or revert files during review, the model now learns about it at the start of your next message. Before, the extension added a made-up exchange to the conversation, including a reply the model never wrote ("Understood…", "Noted."). The note is saved with the session, so it also survives a reload.

Search:

- `grep` no longer rewrites backslashes in the matched text. It turned every `\` in a result into `/`, so `/\d+/` came back as `/d+/` and the model copied the corrupted text into edits. ripgrep now prints paths with `/` itself.
- `glob` and `grep` use only ripgrep, which ships with VS Code. The JavaScript fallback is gone: it never ran in VS Code, ignored `.gitignore`, used different regex syntax and searched every same-named file in a folder when asked for one. Without ripgrep both tools now say so.

Commands:

- Command output is decoded as a stream and cleaned a whole line at a time. Before, each chunk was cleaned on its own: on Windows a chunk ending between `\r` and `\n` erased that whole line, and characters such as `é` or `✓` split across chunks became `�`.
- `run_command` and `start_process` share one implementation in the process manager, so a fix to how commands start, stream, time out or stop applies to both. While a command runs, its card also shows the line being written (for example a progress percentage), and a `start_process` wait pattern can match a prompt that has no newline yet.

Context:

- Token estimates are corrected by the server's own count. After each response the session compares the reported prompt tokens with its character-based estimate and scales every later estimate (the pre-send check, compaction and summary chunks) by that ratio. The persisted per-model calibration it replaces is gone.
- Requests ask for usage (`stream_options.include_usage`), so OpenAI-compatible backends behind Open WebUI report token counts too.
- One output budget, about a fifth of the context window (11k characters at the 16k default), sizes every tool result. `read_file` stops at a whole line when it is used up and says exactly where to continue; previously a long read lost its middle while the continuation hint pointed past it. Web search shares the budget between results, and `web_fetch` returns up to the budget instead of a fixed 20,000 characters.

Security:

- A dangling link in the workspace (one whose target does not exist yet) is classified by its target. Before, it counted as a workspace file, so in the auto-accept modes a write through it could create a file outside the workspace without asking.
- The permission-mode descriptions for the auto-accept modes now say that allow-listed commands such as `npm test` run code the agent can change without asking.
- Same-origin redirects from Open WebUI are followed up to three times, as intended; the limit was off by one.
- The permission mode is stored per workspace, so an auto-accept mode chosen in a trusted repository no longer carries over to others. Every workspace starts in **Ask before edits** once after updating.
- Changes to `.owui/` (project memory and skills, which later sessions load as instructions) always ask, as `.git/` and `.vscode/` already did. `update_memory` therefore asks even in the auto-accept modes.
- An approval card takes keyboard focus only when nothing else has it, so typing in the composer while the agent works can no longer approve a command by accident.
- `run_command` returns when the shell exits even if a process it started in the background (`cmd &`, `start /b`) still holds its output open; previously it waited for that process, forever for a server, and Stop could not end the wait. On macOS and Linux, stopping or timing out a command also stops the processes it left behind.

Reliability:

- Each tool result is added to the conversation as soon as the tool finishes, and an unexpected error (for example, saving an **Always allow** entry fails) now ends that tool with an error result instead of leaving the request unanswered and the next request malformed.
- Retries are limited to dropped or refused connections and HTTP 408, 429, 502, 503 and 504. HTTP 500, invalid responses and stalls are no longer retried, because each retry makes the server read the whole prompt again.
- Requests carry an output cap (`max_tokens`, the same room the context check keeps free), so a model stuck in a loop stops instead of generating until the context is full.
- New **OWUI Agent** output channel with connection results, per-request timings and token counts, retries and errors. Keys, prompts and file contents are never logged. Failed session saves are logged and retried.

Development:

- Browser tests run separately (`npm run test:browser`), one file at a time with longer timeouts, so `npm test` stays reliable while a local model is using the CPU.
- The CI workflow installs ripgrep (and fails instead of skipping the ripgrep tests without it), caches the VS Code test build, runs the browser tests and passes `--no-sandbox` to VS Code on Linux runners.

Checkpoints:

- Rewind now uses only the per-file backups of the agent's own edits. The private Git snapshot of the whole workspace is gone, along with the `owuiAgent.checkpoints.enabled` setting and Git as a requirement; old snapshot repositories are deleted on startup. Rewind no longer undoes changes made by shell commands, and no longer runs three Git processes before every message.
- Rewind and review no longer delete files over 20 MB or non-regular files that the agent touched; they are reported as not backed up and left alone.
- The rewind dialog marks files that changed after the agent's last edit, so you know your own later changes would be lost.
- Files that could not be restored are reported instead of being counted as restored.

Speed and context:

- The system prompt and tool list are fixed for the whole session, so Ollama can reuse its prompt cache between steps. The task list now comes back in the `todo_write` result, the permission mode is noted at the start of your message when it changes, and `AGENTS.md`, memory and skills are read once per session (start a new session to pick up edits you make to them).
- `num_ctx` is sent with every request. Without a configured size the extension uses 16384 (capped at the model's maximum) instead of assuming 4096, which made the first message fail.
- Fewer, shorter tool definitions: about 6,000 characters for the default 11 tools, down from about 10,000 for 18. `list_dir` is merged into `read_file` (pass a directory), the three background-process tools are now one `process` tool, and `browser_interact` is merged into `browser`. `view_image` is only offered to vision models, `load_skill` only when skills exist, and the `shell` option only lists shells installed on this machine.
- The browser tool is off by default.
- Plan mode no longer has a separate plan-approval card or `exit_plan_mode` tool. The agent stays read-only, replies with its plan, and you switch mode when you want it implemented. Plans in older saved sessions show as ordinary replies.

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
