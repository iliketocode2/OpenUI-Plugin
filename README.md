# OWUI Agent

An autonomous coding agent for VS Code whose only model backend is **your own Open WebUI server**. Give it a multi-step task; it plans, asks clarifying questions, edits files, runs commands and tests, fixes its own mistakes, and finishes with an honest report of what it built, what it tested and what it did not.

Full installation and server setup: see `docs/SETUP.md` in the source repository.

## Data sovereignty

- **One destination.** The extension's network traffic goes only to the Open WebUI URL you configure. All requests pass through a single module that refuses any other origin and any redirect away from it. There is no telemetry, analytics, crash reporting, update check, CDN or font download.
- **Local storage.** History, checkpoints, file backups and memory stay on your machine (VS Code storage and your workspace). The API key is kept in the OS keychain via VS Code SecretStorage.
- **Local browser only.** The browser tool opens `localhost` pages in your installed Chrome or Edge with a throwaway profile. Every HTTP and WebSocket request to another host is blocked, including the browser's own background traffic to Google or Microsoft. WebRTC (UDP) traffic from a page is not blocked yet.
- **Web access is opt-in and goes through your server.** Web search and page fetches are off by default. When enabled they run on your Open WebUI server (ideally backed by a self-hosted SearXNG), and you approve or edit every query and URL first.

What the extension cannot guarantee:

- **The model's location.** It cannot tell whether a model in Open WebUI runs locally or is proxied to a cloud provider. Mark models that run on your own hardware as *local*; the header shows **Local** or **Unverified** accordingly.
- **Commands the agent runs.** Commands you approve, and allow-listed commands that run without asking, execute in your shell with your privileges and can reach the internet like any program you run (for example `npm install` or `git push`).

## Features

- **Chat panel** with streaming Markdown, code highlighting, collapsible reasoning, timestamps and a context-usage meter.
- **Agent loop** with tools to read, list, find and search files (ripgrep), write and edit files, run commands (Git Bash, PowerShell, cmd, bash, zsh), manage background processes (dev servers), view images, keep a task list, and ask you questions.
- **Native or text tool calling.** Native tool calling is used when the model supports it, with an automatic fallback to a text-based protocol.
- **Permission modes:**
  - **Plan:** read-only. The agent investigates and asks questions, then replies with a plan. Switch to another mode when you want it implemented.
  - **Ask before edits** (default): each change is shown as a diff to Apply or Deny.
  - **Auto-accept edits:** workspace changes apply immediately.
  - **Auto-accept, review at end:** changes apply immediately, then you keep or revert each file.

  Use the auto-accept modes only on repositories you trust. File changes apply without asking and allow-listed commands run with your privileges, and instructions hidden in files, command output or web pages can steer the model. Changes to `.git/` and `.vscode/` always ask.
- **Command safety.** Commands always ask unless allow-listed. Commands that change Git history or configuration, publish, launch apps, start containers or services, or use `sudo` always ask, with a warning, however the program name is spelled. Commands with redirection, substitution, nested shells, environment prefixes or paths outside the workspace also always ask. The allowlist is read from your user settings only, so a repository cannot add to it.
- **Checkpoints and rewind.** Before the agent first changes a file after each of your messages, the file's previous content is backed up in extension storage. Rewind code, conversation or both from any message: this undoes the agent's file edits (not changes made by shell commands), warns about files you changed after the agent did, and never deletes a file it could not back up. Any change can be opened in VS Code's diff view.
- **Project memory.** `.owui/memory/MEMORY.md` plus topic files, loaded at the start of each session and kept up to date by the agent with your approval. A root `AGENTS.md` is loaded as project instructions.
- **Skills.** Folders with a `SKILL.md`, in `.owui/skills/` or `~/.owui-agent/skills/`. The model sees their names and descriptions and loads one when it is relevant. Run **OWUI Agent: Install Example Skill** for a data-visualisation guide with a colour-palette validator.
- **Context management.** The context size (16k by default, or what you or Open WebUI set) is sent to Ollama as `num_ctx` with every request, so the model always runs with the size the extension plans for. Token usage is tracked per model. Prompts that would not fit are compacted automatically (old tool output first, then a model-written summary), or on demand with `/compact`. Truncation by the server is detected and reported.
- **Fast on slow hardware.** The instructions and tool list stay byte-identical for the whole session (the task list, permission mode and memory updates go into the conversation instead), so Ollama can reuse its prompt cache instead of re-reading the conversation on every step.
- **History.** Conversations are saved locally. Search, resume, rename, delete and export them (Markdown or JSON) from the History view.
- **Accessible, theme-aware UI.** Follows your VS Code theme (light, dark, high contrast) and is fully keyboard accessible: `Ctrl+Enter` sends, `Esc` stops, and **OWUI Agent: Add Selection to Chat** is bound to `Ctrl+Alt+K`.

## Requirements

- VS Code 1.96 or newer.
- An Open WebUI server you can reach, an API key, and a model that is good at tool calling (see `docs/SETUP.md`).
- Google Chrome or Microsoft Edge, optionally, for the browser tool.

## Quick start

1. Install the `.vsix` (Extensions view → `…` → **Install from VSIX…**).
2. Set **OWUI Agent › Base URL** to your Open WebUI address.
3. Run **OWUI Agent: Set API Key**.
4. Open the **OWUI Agent** view, pick a model, and describe what you want built.

For models served by Ollama, turn on the model's **Usage** capability in Open WebUI. The extension asks Ollama for a 16k context unless you set another size (click the context meter). Both are explained in `docs/SETUP.md`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `owuiAgent.baseUrl` | `http://localhost:3000` | Your Open WebUI URL; the only network destination. |
| `owuiAgent.defaultModel` | | Model selected by default. |
| `owuiAgent.models` | `{}` | Per model: `toolMode` (`auto`, `native`, `text`), `contextSize` (sent to Ollama as `num_ctx`; default 16384), `vision`, `local`, `thinking`. |
| `owuiAgent.shell.windows` / `.posix` | `auto` | Shell for commands. On Windows, `auto` uses Git Bash when installed, otherwise PowerShell. |
| `owuiAgent.commands.allowlist` | `[]` | Command prefixes that run without asking, for example `npm test`. User settings only. |
| `owuiAgent.commands.timeoutSeconds` | `120` | Default command timeout. |
| `owuiAgent.agent.maxIterations` | `50` | Model turns before the agent pauses and asks to continue. |
| `owuiAgent.skills.userDir` | `~/.owui-agent/skills` | Personal skills folder. |
| `owuiAgent.web.enabled` | `false` | Web search and fetch through Open WebUI. |
| `owuiAgent.web.autoApproveSearches` | `false` | Send searches without asking; page fetches always ask. |
| `owuiAgent.web.confirmedEngine` | | Declare the search engine when the API key cannot read it. |
| `owuiAgent.browser.enabled` | `false` | Localhost browser tool. |
| `owuiAgent.browser.channel` | `auto` | Chrome or Edge. |
| `owuiAgent.browser.extraHosts` | `[]` | Extra dev hosts the browser may open. |
| `owuiAgent.browser.allowExternalRequests` | `false` | Let pages load internet resources. Not recommended. |
| `owuiAgent.request.firstResponseTimeoutSeconds` | `1200` | Wait for a slow (for example CPU-only) model to start answering. |
| `owuiAgent.request.stallTimeoutSeconds` | `300` | Abort when a running response goes silent. |
| `owuiAgent.request.maxRetries` | `3` | Retries for connection errors, 429 and 5xx responses. |
| `owuiAgent.scratchpad.retentionDays` | `7` | Lifetime of the agent's throwaway scratchpad folders. |

## Limitations

- **Model quality.** Agent quality depends on the model. Small or heavily quantised models lose track of multi-step tasks.
- **Slow hardware.** On CPU-only machines each step can take minutes; turning off a reasoning model's **Thinking** in the header helps a lot.
- **Command safety rules are a guardrail, not a sandbox.** The checks recognise common risky commands by their text. Review approvals carefully. Allow-listing a test or build runner (for example `npm test`) lets whatever the project defines as that script run without asking.
- **Rewind covers the agent's file edits only.** Files that commands create, change or delete (installs, generators, formatters, `rm`), files over 20 MB, and databases or services are not rewound. Use Git for anything you need to get back.
- **Platforms.** Tested on Windows 11. macOS and Linux are supported by the code and the CI workflow but have not been tested on real machines yet.

## Development

```bash
npm ci
npm run build           # dist/extension.js and dist/webview
npm run check           # type-check, lint, unit and egress tests, VS Code integration tests
npm run package         # owui-agent-<version>.vsix (never published)
```

- **Unit and egress tests** (Vitest): tool layer, stream parser, text tool-call parser, compaction, permissions, history, the network-egress guards, and a real headless-browser egress test.
- **Integration tests:** run inside VS Code 1.96 against a mock Open WebUI that replays scripted tool-calling conversations.
- **Live checks** against a real server (reads `OWUI_BASE_URL`, `OWUI_MODEL` and `OWUI_API_KEY` from the environment):
  - `npm run smoke:live` covers protocol details.
  - `npm run smoke:agent` runs a short agent task; set `OWUI_TASK=web` for a search-and-fetch task.
  - `npm run smoke:web` checks web search and fetch.
- **Runtime dependencies:**
  - Bundled into the extension: `preact`, `markdown-it` (and its small dependencies), `highlight.js`, `diff`.
  - Shipped unbundled: `playwright-core`, used only for the browser tool. It never downloads browsers.
  - A test fails if the dependency list changes without review, and another fails if any source file outside `src/net/` imports a network module.
