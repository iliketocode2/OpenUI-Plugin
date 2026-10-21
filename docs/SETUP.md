# Setting up OWUI Agent

OWUI Agent is a coding agent for VS Code that talks **only** to your own [Open WebUI](https://docs.openwebui.com) server. This guide covers installing the extension, connecting it to Open WebUI, choosing a model, and optionally enabling web search through a self-hosted SearXNG.

## 1. Install the extension

1. Build the package (`npm ci && npm run package`) or use a `.vsix` you were given.
2. In VS Code: **Extensions** view → `…` menu → **Install from VSIX…** → pick `owui-agent-<version>.vsix`.
3. Open the **OWUI Agent** view from the activity bar.

Requirements: VS Code 1.96 or newer, Git (for checkpoints), and optionally Google Chrome or Microsoft Edge (for the local browser tool; no browser is ever downloaded).

## 2. Connect to Open WebUI

### Create an API key

1. As an administrator, enable API keys: **Admin Panel → Settings → General → Authentication → API Keys** (toggle on, Save).
   Non-admin users also need the **API Keys** permission: **Admin Panel → Users → Groups → (group or Default Permissions) → Features Permissions → API Keys**.
2. Create the key: click your profile picture → **Settings → Account → API keys → Show → Create new secret key**. Copy it (it starts with `sk-`).

### Allow the endpoints the extension uses

If **API Key Endpoint Restrictions** is turned on (same Authentication settings page), add these paths, comma-separated:

```
/api/models,/api/chat/completions,/api/version,/api/config
```

and, if you enable web search (section 5):

```
/api/v1/retrieval/process/web/search,/api/v1/retrieval/process/web,/api/v1/retrieval/config
```

`/api/v1/retrieval/config` is optional and only readable with an admin key; it lets the extension confirm which search engine Open WebUI uses.

### Configure the extension

1. **Settings → OWUI Agent → Base URL**: your Open WebUI address, e.g. `http://localhost:8080`. The extension sends network requests to this origin and nowhere else.
2. Command Palette → **OWUI Agent: Set API Key** and paste the key. It is stored in your operating system's keychain via VS Code SecretStorage, never in `settings.json`.
3. The chat view should show your models. If not, the banner explains what failed.

Use HTTPS if Open WebUI is not on the same machine; the panel warns about plain HTTP to a non-local address.

## 3. Choose and tune a model

The agent needs a model that is good at **tool calling**. Recent Qwen, Llama 3.1+, Mistral and similar instruction-tuned models work; very small models (under ~7B parameters) often struggle with multi-step work. Models without native tool calling are supported through a text-based fallback, which the extension enables automatically when the server rejects tools.

For Ollama-backed models, set these in **Admin Panel → Settings → Models → (your model) → Advanced Params / Capabilities**:

| Setting | Why |
|---|---|
| **Context Length (num_ctx)**: optional | The extension sends `num_ctx` with every request: `contextSize` from the `owuiAgent.models` setting (also set by clicking the context meter), otherwise the size set here if Open WebUI reports it, otherwise 16384. Keep it the same across requests, because Ollama reloads the model whenever it changes (about 45 s on CPU). |
| **Capabilities → Usage**: on | Lets the extension read token counts, calibrate its estimates and warn when a prompt was truncated. |
| **Capabilities → Vision**: on (vision models only) | Lets the agent look at screenshots. |

In the chat panel, tick **Runs on infrastructure I control** for models that really are local; this drives the sovereignty indicator. The **Thinking** toggle turns off a reasoning model's thinking phase (much faster on CPU, sometimes less careful).

### Hardware notes

On CPU-only machines a 27B model may generate only a few tokens per second, so a single agent step can take minutes. Prefer a smaller model (7–14B) or a mixture-of-experts model, make sure Ollama uses your GPU (`ollama ps` shows the CPU/GPU split), and make sure the model plus its context fits in free RAM. If the first response is slow, raise `owuiAgent.request.firstResponseTimeoutSeconds` (default 1200).

## 4. Permissions and safety

- **Modes** (bottom of the chat panel): *Plan* (read-only, produces a plan for approval), *Ask before edits* (default), *Auto-accept edits*, *Auto-accept, review at end*.
- Commands always ask unless they match `owuiAgent.commands.allowlist` (read from your user settings only). Commands that change Git history or configuration, publish packages, open desktop apps, start containers or services, or use `sudo` always ask, and so do commands with redirection, substitution, nested shells, environment prefixes or paths outside the workspace.
- Before each message the workspace is snapshotted into a private Git repository in VS Code's extension storage (never your repository), so you can **Rewind** from any of your messages.
- The agent's commands run on your machine and *can* reach the internet (for example `npm install`); the extension's own traffic goes only to Open WebUI (and, for the browser tool, to `localhost`).

## 5. Optional: web search through a self-hosted SearXNG

The extension never contacts the internet itself. With `owuiAgent.web.enabled`, the agent gets `web_search` and `web_fetch`, which ask **your Open WebUI server** to search or load a page. Point Open WebUI at your own SearXNG so searches don't go through a commercial search API. Every query and URL is shown to you for approval (you can edit it); searches can be auto-approved with `owuiAgent.web.autoApproveSearches`, page fetches always ask.

### Run SearXNG next to Open WebUI (Docker Compose)

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    volumes:
      - ./searxng:/etc/searxng:rw
    restart: unless-stopped
    networks: [webui]
    # No "ports:" — only Open WebUI needs to reach SearXNG. Publish it on 127.0.0.1 if you want to test it from the host:
    # ports: ["127.0.0.1:8081:8080"]

  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      ENABLE_WEB_SEARCH: "True"
      WEB_SEARCH_ENGINE: "searxng"
      SEARXNG_QUERY_URL: "http://searxng:8080/search"
      WEB_SEARCH_RESULT_COUNT: "5"
      WEB_SEARCH_CONCURRENT_REQUESTS: "5"
    volumes:
      - open-webui:/app/backend/data
    networks: [webui]

networks:
  webui: {}
volumes:
  open-webui: {}
```

Notes:

- **Enable JSON output in SearXNG** — Open WebUI needs it. In `./searxng/settings.yml`:
  ```yaml
  search:
    formats:
      - html
      - json
  ```
  Without it, searches fail with `403 Client Error: Forbidden`.
- Relax SearXNG's bot detection for this internal client by creating `./searxng/limiter.toml`:
  ```toml
  [botdetection.ip_limit]
  link_token = false

  [botdetection.ip_lists]
  block_ip = []
  pass_ip = []
  ```
- Containers reach each other by service name on a shared network; `127.0.0.1` inside the Open WebUI container is the container itself, not your host.
- Variable names changed between Open WebUI versions. Current releases use `ENABLE_WEB_SEARCH`, `WEB_SEARCH_ENGINE` and `SEARXNG_QUERY_URL`; older releases used `ENABLE_RAG_WEB_SEARCH` / `RAG_WEB_SEARCH_ENGINE`, and older guides show the query URL as `http://searxng:8080/search?q=<query>`. Use the form your version's admin panel shows. Environment variables only seed the settings on first start; afterwards the Admin Panel values win.
- Optional: in **Admin Panel → Settings → Web Search**, enable **Bypass Embedding and Retrieval** so search results include page text directly (otherwise the agent gets titles, links and snippets and uses `web_fetch` to read a page).

### Verify

1. From the Open WebUI container: `docker exec -it open-webui curl "http://searxng:8080/search?q=test&format=json"` should print JSON.
2. **Admin Panel → Settings → Web Search**: web search on, engine **searxng**, the query URL above. Save.
3. In VS Code, set `owuiAgent.web.enabled` to `true`. The chat header shows **Web: SearXNG ✓** when the extension could verify the engine (admin key with access to `/api/v1/retrieval/config`). If it shows **Web: unverified**, set `owuiAgent.web.confirmedEngine` to `searxng` once you have checked the admin panel yourself.

Search queries still leave your infrastructure through SearXNG to the search engines it queries. The agent is instructed to keep queries generic, refuses queries that look like they contain secrets, and treats everything it reads from the web as untrusted data.

## 6. The local browser tool

With your installed Chrome or Edge, the agent can open your dev server (for example `http://localhost:3000`), take screenshots, read the rendered page, check console errors, click and type, resize the viewport and switch light/dark mode. It only opens `localhost`, `127.0.0.1` and `::1` (add LAN dev hosts with `owuiAgent.browser.extraHosts`), uses a fresh temporary profile per session, and blocks every request to other hosts — including the browser's own background traffic to Google or Microsoft, which is sent to a local proxy that refuses it. Turn it off with `owuiAgent.browser.enabled`.

## 7. Where your data lives

Everything stays on your machine:

| Data | Location |
|---|---|
| API key | OS keychain (VS Code SecretStorage) |
| Conversation history, file backups | VS Code workspace storage for this folder |
| Checkpoint snapshots | A private Git repository in VS Code workspace storage |
| Scratchpad, temporary browser profiles | VS Code global extension storage (cleaned up automatically) |
| Project memory and skills | `.owui/` in your workspace (you are offered a `.gitignore` entry) and `~/.owui-agent/skills` |
