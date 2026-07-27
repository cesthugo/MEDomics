# STARHE Plugin Integration — Technical Documentation

This document describes every modification made to the MEDomics codebase to support the
installation, execution, and lifecycle management of the **STARHE plugin**
(*Stratification of risk and deTection of Hepatocellular carcinoma by Echography*),
a standalone application hosted at `https://github.com/cesthugo/PLUGIN1-MEDomics`.

It is written for developers who need to understand, maintain, or extend the plugin
system. It covers the architecture, every file added or modified, the design decisions
behind them, and the pitfalls encountered along the way.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [The Plugin Being Integrated (STARHE)](#2-the-plugin-being-integrated-starhe)
3. [Files Added](#3-files-added)
4. [Files Modified](#4-files-modified)
5. [Plugin Lifecycle in Detail](#5-plugin-lifecycle-in-detail)
6. [Design Decisions and Rationale](#6-design-decisions-and-rationale)
7. [Cross-Platform Notes](#7-cross-platform-notes)
8. [How to Add Another Plugin](#8-how-to-add-another-plugin)

---

## 1. Architecture Overview

MEDomics is an Electron application composed of three layers:

- **Electron main process** (`main/`) — Node.js; owns windows, IPC, and child processes.
- **React/Next.js renderer** (`renderer/`) — the UI, sandboxed Chromium.
- **Go server** (`go_server/`) — the backend, spawned by the main process, which itself
  orchestrates Python scripts.

The STARHE plugin is itself a full-stack application with the same shape: a React/Vite
frontend (`renderer/`), a Go HTTP server (`go_server/`, listening on **port 8082**),
and Python AI code (`pythonCode/modules/starhe_plugin/`).

**Integration strategy: run the plugin as-is, side by side, behind a reverse proxy.**
Rather than merging the plugin's code into MEDomics (rewriting its React app as MEDomics
components, merging Go routers, unifying Python environments), the plugin is installed
into a dedicated directory and executed as an independent child process. The MEDomics UI
displays it inside an `<iframe>`, and the MEDomics Go server proxies all plugin traffic
so that **the renderer only ever talks to a single port** (the MEDomics server port).

**Two install modes coexist.** The manager can populate the plugin directory two ways;
both produce the same runtime shape (a Go server serving `ui/` + a Python backend), and
`startPluginServer` branches on the recorded `mode`:

- **`download` — prebuilt bundle (default, public).** A slim, per-platform bundle
  `starhe-plugin-<version>-<platform>.zip` (compiled Go server, built Vite UI `ui/`,
  PyInstaller worker `starhe_worker/`, Weasis tooling and an embedded JRE) is downloaded
  from the plugin's **public GitHub Releases**, SHA-256-verified, and extracted. This
  removes every machine prerequisite (no git, Node, Go, or Python toolchain) and makes the
  plugin installable by the general public. The bundle is produced by the plugin's own CI
  (a slim subset of what its standalone Electron app already builds).

- **`source` — clone + build (developer / fallback).** The plugin repo is cloned and
  built on the machine (`npm` + `go build` + the plugin's own venv setup script), exactly
  as before. Requires the full toolchain and GitHub access. Opt in with the env var
  `MEDOMICS_PLUGIN_SOURCE=1` (or `installPlugin(id, win, { mode: "source" })`).

The default is `download`; nothing about the source path was removed. The rest of this
document notes, per step, how the two modes differ.

```
┌──────────────────────────── Electron ────────────────────────────┐
│                                                                  │
│  Renderer (React/Next.js)                Main process (Node.js)  │
│  ┌──────────────────────┐   IPC          ┌────────────────────┐  │
│  │ starhe.jsx (iframe)  │◄──────────────►│ pluginManager.js   │  │
│  │ ExtensionManager.jsx │  plugin:*      │ (clone/build/run)  │  │
│  └─────────┬────────────┘                └─────────┬──────────┘  │
│            │ http://localhost:{medomicsPort}       │ spawns      │
└────────────┼────────────────────────────────────── ┼─────────────┘
             ▼                                       ▼
  ┌─────────────────────┐  reverse proxy   ┌──────────────────────┐
  │ MEDomics Go server  │─────────────────►│ STARHE Go server     │
  │ blueprints/starhe/  │  /starhe/* →     │ (port 8082)          │
  │ (proxy blueprint)   │  localhost:8082  │ serves UI + API      │
  └─────────────────────┘                  └──────────┬───────────┘
                                                      │ subprocess
                                                      ▼
                                           ┌──────────────────────┐
                                           │ Python venv          │
                                           │ starhe_plugin (AI)   │
                                           └──────────────────────┘
```

**Installation location.** The plugin is cloned and built inside Electron's user-data
directory, keeping the MEDomics source tree untouched:

- macOS: `~/Library/Application Support/medomics-platform (development)/plugins/starhe/`
- Windows: `%APPDATA%\medomics-platform (development)\plugins\starhe\`
- Linux: `~/.config/medomics-platform (development)/plugins/starhe/`

Resolved at runtime via `path.join(app.getPath("userData"), "plugins", id)`.

**State persistence.** Installed/version/path state is stored in
`{userData}/plugins-state.json`, read and written synchronously by `pluginManager.js`.

---

## 2. The Plugin Being Integrated (STARHE)

Relevant structure of the plugin repository (only the parts MEDomics interacts with):

```
PLUGIN1-MEDomics/
├── renderer/                      # React 18 + TypeScript + Vite frontend
│   ├── src/
│   ├── vite.config.ts             # base: './', outDir: 'dist'
│   └── dist/                      # produced by `npm run build` (not committed)
├── go_server/                     # standalone Go HTTP server
│   ├── main.go, handlers*.go, config.go, health.go
│   └── go_server                  # binary produced by `go build` (not committed)
├── scripts/
│   ├── setup.sh / setup.ps1       # canonical venv provisioning (see §3.6)
│   └── download_models.py         # legacy AI weights downloader — no longer invoked by MEDomics (§3.6)
└── pythonCode/modules/starhe_plugin/
    ├── requirements.txt
    ├── models/                    # AI checkpoints (.pth) — user-loaded at runtime, not committed
    └── .venv/                     # created at install time (not committed)
```

The plugin's Go server exposes:

- `GET /health` — dependency-aware health probe (see §3.7). Returns `{"status":"ok"}`
  or `{"status":"degraded","missing":[…],"python_error":"…"}`.
- `GET /ui/*` — serves the built Vite frontend (`renderer/dist/`).
- `POST/GET /starhe/*` — REST + SSE API (DICOM analysis pipeline). The `/starhe/analyze`,
  `/starhe/live` and `/starhe/mp4/analyze` endpoints stream Server-Sent Events.

**The plugin is fully self-contained.** It embeds its own Go server, its own Python
venv and its own `models/` directory, and carries its own provisioning scripts.
MEDomics never re-implements plugin internals — it invokes the plugin's own
`scripts/setup.sh|ps1` so the provisioning logic has a single source of truth, inside
the plugin repository. The AI model weights are **not** provisioned by MEDomics: for
confidentiality reasons they are no longer distributed online, and the user loads them
locally from the plugin's own React UI, which prompts for them when they are missing
(see §3.6).

---

## 3. Files Added

### 3.1 `main/utils/pluginManager.js` — plugin lifecycle manager (new)

The heart of the integration. An ES module running in the Electron main process that
owns the entire plugin lifecycle. Its public API:

| Function | Role |
|---|---|
| `getPluginsState()` | Merges the static registry with persisted state + live process status |
| `installPlugin(id, mainWindow, opts)` | Dispatches by mode: `download` (fetch + verify + extract) or `source` (clone → build) |
| `updatePlugin(id, mainWindow, opts)` | Follows the installed mode: re-download a newer Release, or `git fetch`/`reset` + rebuild |
| `uninstallPlugin(id, mainWindow)` | Stop server → `fs.rmSync` the install dir (keeps the data dir) → clear state |
| `startPluginServer(id, mainWindow)` | Free the port, spawn the Go binary with a mode-specific env |
| `stopPluginServer(id, mainWindow)` | Kill tracked process **and sweep the port** |
| `stopAllPlugins()` | Called on app quit |
| `autoStartInstalledPlugins(mainWindow)` | Called once the MEDomics server is up |

Internal helpers worth knowing — **download mode**: `resolveRelease()` (finds the newest
Release with a bundle for this platform), `downloadTo()` (streamed download with progress),
`verifyChecksum()` (SHA-256 against `SHA256SUMS.txt`), `readBundleManifest()`
(`plugin-bundle.json` entrypoints). **Source mode**: `runPluginSetup()` (delegates venv
provisioning to the plugin's own `scripts/setup.sh|ps1`), `findGhBinary()` and
`cloneRepo()` (GitHub access). **Both**: `killProcessOnPort()` (port hygiene, §3.1 below).

#### Install modes: `download` (default) vs `source`

`resolveInstallMode(opts)` decides: an explicit `opts.mode` wins, else
`MEDOMICS_PLUGIN_SOURCE=1` selects `source`, else the default is `download`. The chosen
mode is persisted in `plugins-state.json` (`mode` field) so `updatePlugin` and
`startPluginServer` stay consistent with how the plugin was installed.

- **`download`** — `installFromDownload()` resolves the newest published Release exposing
  a `starhe-plugin-<version>-<platformTag>.zip` for the current `process.platform`/`arch`
  (tags: `mac-arm64`, `mac-x64`, `linux-x64`, `win-x64`), downloads it (+ `SHA256SUMS.txt`),
  verifies the SHA-256 (best-effort: a warning if the sums file is absent), extracts it into
  the install dir, and `chmod +x`'s the binaries. Progress steps:
  `download → verify → extract → done`. The Release lookup uses the `/releases` list (not
  `/releases/latest`, which skips the plugin's prerelease betas) and is unauthenticated —
  the repo and its Releases are public.
- **`source`** — `installFromSource()` clones and builds on the machine (see the cloning
  strategy and build steps below). Progress steps:
  `clone → build-react → build-go → python → done`.

**Weights live outside the install dir.** In both modes `STARHE_WEIGHTS_DIR` points to
`{userData}/plugins-data/{id}/models`, a sibling of the install dir. Updates and
reinstalls wipe and repopulate the install dir but never touch `plugins-data`, so the
`.pth` checkpoints the user loaded survive.

#### The plugin registry

Plugins are declared statically in `PLUGIN_REGISTRY`. This is the single source of truth
for metadata (no remote registry, no marketplace):

```javascript
export const PLUGIN_REGISTRY = {
  starhe: {
    id: "starhe",
    name: "STARHE",
    version: "0.7.0",                          // display fallback; real version from the Release/repo
    githubUrl: "https://github.com/cesthugo/PLUGIN1-MEDomics",
    githubRepo: "cesthugo/PLUGIN1-MEDomics",   // source mode (clone)
    releaseRepo: "cesthugo/PLUGIN1-MEDomics",  // download mode (Releases)
    bundlePrefix: "starhe-plugin",             // asset: {bundlePrefix}-{version}-{platformTag}.zip
    port: 8082,
    // ...description, tags, author
  },
}
```

#### Cloning strategy (`cloneRepo`) — source mode only

> Applies to `source` mode. In the default `download` mode nothing is cloned — the bundle
> is fetched from the repo's **public** Releases with no authentication.

The three authentication strategies below matter for `source` mode (and for the download
API only if the repo is private — the STARHE repo is now public). They are attempted in
order, collecting errors for a meaningful
failure message:

1. **GitHub CLI** — `gh repo clone owner/repo dest`. `findGhBinary()` probes `gh` in
   `PATH`, then `/opt/homebrew/bin/gh` (Apple Silicon), `/usr/local/bin/gh` (Intel Mac),
   `/usr/bin/gh` (Linux), and `C:\Program Files\GitHub CLI\gh.exe` (Windows), by running
   `"{bin}" --version` with `execSync`. This probing is necessary because Electron apps
   launched from the Finder/Dock do **not** inherit the user's shell `PATH`.
2. **SSH** — `git clone git@github.com:owner/repo.git`, works if the user has an SSH key
   registered with GitHub.
3. **HTTPS** — `git clone https://github.com/...`, works if a git credential helper is
   configured.

If all three fail, the error surfaced to the UI aggregates the three underlying messages.

#### Build steps at install time

All commands run through `util.promisify(exec)` with generous timeouts:

1. **React frontend** — `npm install` then `npm run build` in `{pluginDir}/renderer/`
   (3-minute timeouts each). Output lands in `renderer/dist/`.
   ⚠️ The plugin's frontend lives in `renderer/`, *not* `react_ui/` — an early version of
   this code looked for `react_ui/` and silently skipped the build, producing 404s.
2. **Go server** — `go build -o go_server .` (`go_server.exe` on Windows) in
   `{pluginDir}/go_server/` (2-minute timeout). Requires the Go toolchain on the machine.
3. **Python environment** — `runPluginSetup()` executes the **plugin's own provisioning
   script** (`scripts/setup.sh` on macOS/Linux, `scripts/setup.ps1` on Windows;
   30-minute timeout). See the warning below — a plain `pip install -r requirements.txt`
   is *not* sufficient for this plugin.

The Python environment is the **last** build step: the AI model weights are no longer
downloaded here (they are user-loaded — see §3.6).

Progress is streamed to the renderer at every step via `webContents.send("plugin:progress",
{ id, step, progress, message })`, where
`step` ∈ `clone | build-react | build-go | python | done`.

> ⚠️ **Why the venv must be built by the plugin's script, not by MEDomics.**
> An earlier version of `installPlugin` created the venv itself
> (`python3 -m venv` + `pip install -r requirements.txt`). That produces a venv that
> *looks* complete but is missing three things that only `setup.sh` provides:
> `mmaction2==1.2.0` installed with `--no-deps` (deliberately excluded from
> requirements.txt because pip would drag incompatible mm* dependencies), **three
> compatibility patches applied to the installed mmaction package** (removal of the DRN
> import absent from the wheel; `AssertionError` added to the `except` clauses of
> `roi_heads/__init__.py` and `task_modules/__init__.py` to survive the mmdet↔mmengine
> registry conflict under Python 3.13), and the **vendored `prepUS` + `sonocrop`**
> packages (installed `--no-deps` from `third_party/prepUS`). Without them the AI
> pipeline dies at import time (`ModuleNotFoundError: No module named 'mmaction'`).
> The setup scripts are idempotent: safe to re-run on an existing venv, they only fill
> in what is missing. `setup.sh` also *requires Python 3.13* and fails loudly otherwise.

#### `updatePlugin` — full-stack update

The update path mirrors installation but on an existing clone. **Order matters**:

1. `stopPluginServer(id)` — *first*, because on Windows a running binary cannot be
   replaced on disk, and the restart is needed anyway to load the new code.
2. `git fetch origin` then `git reset --hard @{u}` in the plugin directory — **not**
   `git pull`. The install directory is a managed artifact, not a dev checkout, and it
   gets dirty on its own (`npm install` rewrites `renderer/package-lock.json`), which
   makes `git pull` fail; `fetch` + `reset --hard` synchronises deterministically and
   only touches tracked files, leaving `renderer/dist/`, `.venv/` and `models/` intact
   (they are gitignored).
3. `npm install && npm run build` in `renderer/` (dependencies may have changed).
4. `go build` in `go_server/`.
5. `runPluginSetup()` — the plugin's setup script again (idempotent: creates the venv if
   missing, completes dependencies/mmaction2/prepUS if a new version added some).
6. Persist the new state, `startPluginServer(id)`, and broadcast `plugin:state-changed`.

If the plugin directory does not exist at all, `updatePlugin` falls back to a full
`installPlugin`.

#### AI model weights — user-provided (no longer downloaded)

The two model checkpoints (~750 MB total: `best_acc_mean_cls_f1_epoch_14.pth` for
STARHE-RISK/C3D, `best_coco_bbox_mAP_50_iter_2100.pth` for STARHE-DETECT/RTMDet) used
to be pulled from a private GitHub Release by a `runModelsDownload()` helper at install
and update time. **This is gone.** For confidentiality reasons the weights are no longer
distributed online, so MEDomics no longer attempts to fetch them — the helper was
removed together with the `models` progress step.

Instead, the plugin ships without weights and its own React UI detects when the
checkpoints are absent (via the dependency-aware `/health`, §3.7b) and prompts the user
to load them locally. The plugin's `scripts/download_models.py` still exists in the repo
but is no longer invoked by the integration.

#### `startPluginServer` — spawning with an explicit environment

The Go binary is spawned with `execFile` (no shell) and a carefully constructed `env`:

```javascript
const env = {
  ...process.env,
  PORT: String(meta.port),
  STARHE_SERVER_PORT: String(meta.port),
  STARHE_UI_DIR: path.join(state.pluginPath, "renderer", "dist"),
  STARHE_PYTHON_PATH: path.join(state.pluginPath, "pythonCode", "modules"),
  PYTHON_MOD_PATH: path.join(state.pluginPath, "pythonCode", "modules"),
  MED_ENV: venvPython,          // + STARHE_PYTHON_EXE — only if the venv python exists
}
```

`STARHE_UI_DIR` is passed **explicitly** because the plugin's Go code otherwise derives
its UI directory from `os.Executable()`, which resolves incorrectly when the binary is
launched by Electron rather than from its own directory. The same applies to the Python
module path and interpreter.

`stdout`/`stderr` are piped to the Electron console with a `[plugin:starhe]` prefix.
A `close` handler removes the process from the internal `_procs` map and broadcasts the
state change, so the UI reflects crashes immediately.

**Startup failure detection**: after spawning, the manager waits 1.5 s and then checks
whether the process is still alive. If it already exited (port bind failure, corrupted
binary…), a clear error is thrown instead of reporting a running server:

```javascript
if (!_procs[id] || _procs[id].killed) {
  throw new Error(`Le serveur ${meta.name} s'est arrêté immédiatement après le démarrage…`)
}
```

#### `killProcessOnPort` — port hygiene (critical)

Before every start, and on every stop, any process listening on the plugin's port is
killed:

```javascript
async function killProcessOnPort(port) {
  if (process.platform === "win32") {
    // netstat -ano | findstr :{port} | findstr LISTENING  → taskkill /F /PID {pid}
  } else {
    // lsof -ti tcp:{port} -sTCP:LISTEN  → process.kill(pid, "SIGKILL")
  }
  await new Promise((r) => setTimeout(r, 500)) // let the OS release the socket
}
```

**Why this exists**: during development, a STARHE dev server launched manually from a
separate working copy was left running on port 8082. Every plugin update then went
through flawlessly (pull, builds, restart) — but the freshly started plugin binary could
not bind the port and **died silently**, while the stale dev server kept answering the
health check and serving a weeks-old UI. The symptom ("updates do nothing") pointed
everywhere except the real cause.

### 3.2 `go_server/blueprints/starhe/starhe.go` — reverse proxy blueprint (new)

MEDomics' Go server registers HTTP handlers through per-module "blueprints". This new
blueprint does not implement any plugin logic — it is a pure **reverse proxy** built on
`net/http/httputil.ReverseProxy`, forwarding to the STARHE server:

| Route on the MEDomics server | Forwarded to | Path rewrite |
|---|---|---|
| `/starhe/ui/*` | `http://localhost:8082/ui/*` | strips the `/starhe` prefix |
| `/starhe/*` | `http://localhost:8082/starhe/*` | none (passed through) |

Registration order does not matter: Go's `ServeMux` picks the longest matching pattern,
so `/starhe/ui/` always wins over `/starhe/`.

Key implementation details:

- **Target resolution** — `STARHE_SERVER_PORT` env var, defaulting to `8082`.
- **`FlushInterval: 50 * time.Millisecond`** — mandatory. The `/starhe/analyze` endpoint
  streams SSE; without a short flush interval the proxy buffers the stream and the UI
  receives all progress events at once at the end of the analysis.
- **`ModifyResponse`** — forces `Cache-Control: no-store, no-cache, must-revalidate` on
  every proxied response. Without it, Chromium (inside Electron) caches the plugin's
  `index.html` and keeps serving a stale UI after an update even though the files on disk
  changed.
- **`ErrorHandler`** — returns a JSON `502 {"error":"STARHE server unavailable — start
  the plugin first"}` instead of Go's default plain-text error, so the frontend can
  handle the "plugin not running" case gracefully.
- **CORS** — a small wrapper adds permissive CORS headers and answers `OPTIONS`
  preflights with `204`.

### 3.3 `renderer/components/mainPages/starhe.jsx` — plugin page (new)

The page rendered when the user opens the STARHE module. It has two jobs: make sure the
plugin server is running, and embed the plugin UI in an `<iframe>`.

**Startup sequence** (on mount):

1. `ipcRenderer.invoke("plugin:start-server", "starhe")` — idempotent; the main process
   returns immediately if the server is already running.
2. Poll `plugin:check-health` (an IPC round-trip — see below) every 2 s until the plugin
   answers `/health`, then switch `serverStatus` to `"ready"` and render the iframe.

**Health polling goes through IPC, not `fetch`.** Chromium's renderer sandbox blocks
`fetch()` to `localhost` in this configuration; every request failed instantly and the
page stayed stuck at "0/20 attempts" forever. The probe therefore runs in the **main
process** (Node.js, no sandbox) via the `plugin:check-health` handler, which uses axios
with a 2 s timeout.

**Polling is unbounded but guarded.** An earlier version gave up after 20 attempts
(40 s); a plugin update rebuilds React + Go and can take several minutes, so the timeout
made every update look like a failure. The current implementation polls indefinitely
using a recursive `setTimeout`, guarded by a `pollingRef` (a `useRef` boolean) so that
concurrent polling loops can never stack up.

**Cache-busting via `iframeKey`.** The iframe is rendered as:

```jsx
<iframe
  key={iframeKey}
  src={`http://localhost:${medomicsPort}/starhe/ui/?v=${iframeKey}`}
  ...
/>
```

`iframeKey` is initialized to `Date.now()` (never `0` — a constant initial value produced
identical URLs across page mounts, which Chromium served from its HTTP cache), and reset
to a fresh `Date.now()` whenever the plugin server restarts. Changing the React `key`
destroys and recreates the iframe DOM node; changing the `?v=` query defeats URL-based
caching. Combined with the proxy's `no-store` header this guarantees a fresh UI after
every update.

**Reacting to lifecycle events.** The page listens to `plugin:state-changed`:

- If the server *stopped* (update in progress, crash): stop the current poll, bump
  `iframeKey`, and start polling again — the unbounded poll naturally picks the server
  back up when it returns.
- If the server *started* while the page wasn't `"ready"`: ensure a polling loop is
  active.

Note the iframe points to the **MEDomics port** (obtained from `WorkspaceContext`), not
to 8082: all plugin traffic flows through the reverse proxy. The health poll is the one
exception — it targets port 8082 directly, but from the main process.

### 3.4 `renderer/components/extensions/ExtensionManager.jsx` — extensions panel (new)

A modal panel (opened from the sidebar's extensions icon) that lists the plugins declared
in the registry with their install state, and exposes **Install / Update / Uninstall /
Start / Stop** actions, each mapped 1:1 to an IPC handler.

During installation/update it renders a step tracker driven by `plugin:progress` events:

```javascript
const INSTALL_STEPS = ["clone", "build-react", "build-go", "python", "done"]
const STEP_LABELS = {
  clone: "Clonage GitHub",
  "build-react": "Frontend React",
  "build-go": "Serveur Go",
  python: "Environnement Python",
  done: "Terminé",
}
```

The overall progress bar position is computed from the current step index plus the
within-step percentage carried by the event.

### 3.5 `renderer/styles/extensions.css` (new)

Styling for the extensions panel and the STARHE loading overlay (`.starhe-loading-*`,
`.ext-btn-*` classes). Imported globally in `_app.js`.

### 3.6 Plugin-side provisioning scripts (in the plugin repository)

These files live in the **plugin repo**, not in MEDomics, but they are integral to the
integration because `pluginManager.js` invokes them:

- **`scripts/setup.sh` / `scripts/setup.ps1`** — canonical, idempotent venv
  provisioning: locate Python 3.13 → create `.venv` if absent → `pip install -r
  requirements.txt` → `pip install mmaction2==1.2.0 --no-deps` + apply the three
  compatibility patches to the installed package → `pip install sonocrop --no-deps` +
  `pip install third_party/prepUS --no-deps`. The PowerShell version was brought to
  parity with the bash version (it was originally missing the mmaction2 step).
- **`scripts/download_models.py`** — *no longer used by the integration.* It still lives
  in the plugin repo (a stdlib-only downloader that verifies a pinned SHA-256), but the
  AI weights are no longer distributed online for confidentiality reasons, so
  `pluginManager.js` does not call it anymore. The user loads the checkpoints locally
  from the plugin's React UI instead (see §3.7b).

### 3.7 Plugin-side failure reporting (in the plugin repository)

Three defects made the plugin report **false successes**: a batch analysis whose Python
pipeline crashed (missing weights, broken venv) showed every file as ✓ *done* with
`Risk: — · 0 lesion(s)`, nothing was saved to MongoDB, and no error reached the user.
The DICOM thumbnail loading worked, masking the problem. Fixed at three levels:

**(a) Go server — SSE error propagation (`handlers.go`, `handlers_mp4.go`).**
Previously, when `cmd.Wait()` returned an error, it was only logged server-side and
`[DONE]` was still sent — the frontend could not distinguish success from crash. A new
`finishSSE(w, f, waitErr, ctxErr, what)` helper now closes every analysis stream: if
the Python subprocess exited non-zero *and* the HTTP context was not cancelled (i.e.
not a client disconnect), it emits
`{"level":"error","message":"pipeline exit code N — …"}` **before** `[DONE]`. Applied
to all three streaming endpoints: `/starhe/analyze`, `/starhe/live`,
`/starhe/mp4/analyze`. (This is the safety net for crashes where Python dies without
emitting its own `GO_PRINT|error|…` line; when Python does emit one, it is forwarded
as before.)

**(b) Go server — dependency-aware `/health` (`health.go`, new file).**
At boot the server logs the resolved `PythonExe` and `WeightsDir`, checks that both
`.pth` checkpoints exist, and verifies in a background goroutine that the venv's
critical imports work (`numpy, pydicom, torch, mmengine, prepUS` plus the exact C3D
import used by `_c3d_runner.py`, which validates patched mmaction2 — takes ~2 s, so it
must not block server startup). `GET /health` reflects the real state:

```json
{"status":"ok"}                                          // everything present
{"status":"ok","python_check":"pending"}                 // import check still running
{"status":"degraded","missing":["best_acc_….pth"],
 "python_error":"ModuleNotFoundError: No module named 'mmaction'"}
```

Weights presence is re-checked on every call (a cheap `stat`), so downloading weights
mid-session flips health back to `ok` without a restart. The HTTP status stays 200 —
the server *is* reachable — so MEDomics' liveness polling is unaffected; the body is
for UIs that want to warn before launching a doomed analysis. In PyInstaller-bundle
mode (`STARHE_WORKER_BIN` set) the import check is skipped: dependencies are frozen in.

**(c) React frontend — error events no longer swallowed
(`BatchModal.tsx`, `usePipelineSSE.ts`).**
Both SSE consumers previously handled `progress`/`info`/`result` payloads but ignored
`level === "error"`, then their `onDone` callback unconditionally marked the item
*done* / committed an empty result. Both now track two booleans across the stream —
*was an error event received?* and *was a `result` event received?* — and in `onDone`:

- if an error was received **or no `result` ever arrived** → status `error` with the
  Python error message (or `"Pipeline terminé sans résultat (crash Python ?)"`), no
  result committed;
- otherwise → status `done` as before.

User cancellation is unaffected: `streamAnalysis`'s abort raises an `AbortError`,
which calls neither `onDone` nor `onError`. A side benefit: a network-severed stream
(ended without `[DONE]`) is now reported as an error instead of a silent fake success.

---

## 4. Files Modified

### 4.1 `main/background.js`

Three kinds of changes:

**(a) IPC surface.** Seven handlers bridge the renderer to `pluginManager.js`
(lines ~1008–1075). All of them follow the same pattern — delegate, catch, return
`{ success, error? }` so renderer code never deals with thrown IPC errors:

```javascript
ipcMain.handle("plugin:get-state",    async ()            => getPluginsState())
ipcMain.handle("plugin:install",      async (_e, id)      => { ... installPlugin(id, mainWindow) ... })
ipcMain.handle("plugin:uninstall",    async (_e, id)      => { ... })
ipcMain.handle("plugin:update",       async (_e, id)      => { ... })
ipcMain.handle("plugin:start-server", async (_e, id)      => { ... })
ipcMain.handle("plugin:stop-server",  async (_e, id)      => { ... })
ipcMain.handle("plugin:check-health", async (_e, port)    => {
  try {
    const response = await axios.get(`http://localhost:${port}/health`, { timeout: 2000 })
    return { ok: response.status >= 200 && response.status < 300 }
  } catch { return { ok: false } }
})
```

`plugin:check-health` exists solely because the sandboxed renderer cannot `fetch`
localhost (see §3.3).

**(b) Auto-start.** Once the MEDomics Go server is up (in the `.then()` of the server
startup promise, ~line 319), `autoStartInstalledPlugins(mainWindow)` starts every plugin
marked `installed` in `plugins-state.json`. Failures are logged as warnings and do not
block app startup.

**(c) Clean shutdown.** In the quit path (~line 692), `stopAllPlugins()` kills all
tracked plugin processes so no orphan Go server survives the app.

Events flowing main → renderer (via `webContents.send`):

| Channel | Payload | Consumers |
|---|---|---|
| `plugin:progress` | `{ id, step, progress, message }` | ExtensionManager (step tracker) |
| `plugin:state-changed` | full `getPluginsState()` map | layoutManager, starhe.jsx, ExtensionManager |

### 4.2 `go_server/main.go`

Two lines: import the blueprint and register it alongside the existing module blueprints.

```go
import (
    // ...
    Starhe "go_module/blueprints/starhe"
)

func main() {
    // ...
    Starhe.AddHandleFunc()
    // ...
}
```

The MEDomics Go binary was rebuilt (`go build -o main .` in `go_server/`). Note that the
committed `go_server/main` binary must be rebuilt whenever the blueprint changes.

### 4.3 `renderer/components/layout/layoutManager.jsx`

- Imports `StarhePage` and `ExtensionManager`.
- Owns the plugin state for the whole layout: fetches `plugin:get-state` on mount and
  subscribes to `plugin:state-changed`, keeping an `installedPlugins` state object that
  it passes down to the sidebar (lines ~38–48, ~302–303).
- Renders `case "starhe": return <StarhePage />` in the page switch (~line 187).
- Renders `<ExtensionManager open={showExtensions} …/>`, toggled by the sidebar's
  extensions icon.

### 4.4 `renderer/components/layout/iconSidebar.jsx`

- Adds a STARHE icon in a dedicated "plugins" section, **conditionally rendered** only
  when `installedPlugins?.starhe?.installed` is true (~line 415).
- The icon carries a live status indicator: blue (`#4fc3f7`) with a dot when the plugin
  server is running, grey otherwise — driven by `installedPlugins.starhe.serverRunning`.
- Adds the extensions (puzzle-piece) icon that opens the ExtensionManager.
- **Deliberately omits the `disabled={isDisabled}` prop** used by the core module icons:
  MEDomics disables its modules until a workspace is selected, but the plugin does not
  depend on the workspace, so it must stay clickable at all times. (This was an actual
  bug: with the prop copied over, the icon was unclickable on a fresh launch.)

### 4.5 `renderer/components/layout/layoutContext.jsx`

Adds the `openStarheModule` action to the layout dispatcher, following the exact pattern
of the existing modules (`openMED3paModule`, `openMEDflModule`, …):

```javascript
case "openStarheModule":
  return openStarhe(action)
// ...
const openStarhe = (action) => {
  openGeneric(action, "STARHE", "starhePage")
}
```

### 4.6 `renderer/pages/_app.js`

One line — imports the new global stylesheet: `import "../styles/extensions.css"`.

---

## 5. Plugin Lifecycle in Detail

### Install — `download` mode (default, user clicks *Install*)

```
renderer                     main process                          disk / network
────────                     ────────────                          ──────────────
plugin:install ──────────►  installPlugin("starhe")  → installFromDownload()
                             ├─ resolveRelease()      ──────────►   GET /repos/…/releases (public)
◄─ plugin:progress(download) ├─ downloadTo(bundle.zip + SHA256SUMS.txt)
                             ├─ verifyChecksum()      ──────────►   SHA-256 vs SHA256SUMS.txt
◄─ plugin:progress(verify)   │
                             ├─ rm -rf installDir; decompress(zip) → installDir/
◄─ plugin:progress(extract)  │    (go_server/ ui/ starhe_worker/ jre/ weasis-dcm2png/)
                             ├─ chmod +x go_server, worker, java
                             └─ setPluginState({installed, mode:"download", entrypoints})
◄─ plugin:state-changed
(sidebar icon appears — weights loaded later from the plugin UI, into plugins-data/)
```

### Install — `source` mode (developer, `MEDOMICS_PLUGIN_SOURCE=1`)

```
renderer                     main process                          disk / network
────────                     ────────────                          ──────────────
plugin:install ──────────►  installPlugin("starhe")  → installFromSource()
                             ├─ rm -rf installDir (clean re-install)
                             ├─ cloneRepo()          ──────────►   gh / git clone → installDir
◄─ plugin:progress (clone)   │
                             ├─ npm install + build  ──────────►   renderer/dist/
◄─ plugin:progress (react)   │
                             ├─ go build             ──────────►   go_server/go_server
◄─ plugin:progress (go)      │
                             ├─ runPluginSetup()     ──────────►   .venv/ (via plugin's
◄─ plugin:progress (python)  │    bash setup.sh | powershell setup.ps1 — venv +
                             │    requirements + patched mmaction2 + prepUS)
                             └─ setPluginState({installed, mode:"source"})
◄─ plugin:state-changed
(sidebar icon appears)
```

### Open the plugin (user clicks the STARHE sidebar icon)

```
starhe.jsx mounts
  ├─ plugin:start-server ─► killProcessOnPort(8082) → spawn go_server (env: STARHE_UI_DIR…)
  └─ poll plugin:check-health every 2 s (main-process axios → localhost:8082/health)
        └─ on ok → render <iframe src="http://localhost:{medomicsPort}/starhe/ui/?v={ts}">
                            └─ MEDomics Go proxy → STARHE Go server → renderer/dist/
```

### Update (user clicks *Update*) — follows the installed `mode`

```
plugin:update ─► updatePlugin("starhe")

  download mode → updateFromDownload():
    1. resolveRelease() → if version == installed: "already up to date", ensure running, stop
    2. stopPluginServer()   (kill tracked proc + sweep port 8082)
    3. installFromDownload()  (fetch + verify + extract newer bundle; keeps plugins-data/)
    4. startPluginServer()  (spawn new binary, verify it survives 1.5 s)
    5. plugin:state-changed ─► starhe.jsx bumps iframeKey → iframe reloads fresh UI

  source mode → updateFromSource():
    1. stopPluginServer()
    2. git fetch origin + git reset --hard @{u}   (deterministic sync — not git pull)
    3. npm install + npm run build   (renderer/dist refreshed)
    4. go build                      (binary replaced — possible because server is stopped)
    5. runPluginSetup()              (plugin's setup script — idempotent venv completion)
    6. startPluginServer() ─► plugin:state-changed ─► iframe reloads fresh UI
```

### Quit

`app` quit path calls `stopAllPlugins()` → every tracked plugin process is killed.

---

## 6. Design Decisions and Rationale

**Why an iframe + reverse proxy instead of merging the codebases?**
The plugin is a living standalone project with its own release cycle. Merging its React
app into MEDomics' Next.js tree would mean porting Vite-specific code, deduplicating
dependency versions, and re-doing that work at every plugin release. The iframe keeps
the plugin's build pipeline intact; the proxy removes the two problems iframes usually
bring (multiple ports, CORS).

**Why a single visible port?**
The renderer only ever addresses `http://localhost:{medomicsPort}`. Port 8082 is an
internal detail between the two Go servers. This avoids CORS entirely for the embedded
UI, survives a future change of the plugin port with no frontend impact, and mirrors how
the app would be deployed behind a real gateway.

**Why download prebuilt bundles by default (keeping source build as an option)?**
Building on the machine at install time guarantees platform-correct artifacts, but it
requires Node, Go, and Python 3.13 plus the whole patched mmaction2 stack — fine for
developers, a non-starter for the general public. So the default `download` mode ships a
slim, per-platform bundle from the plugin's public Releases (produced by the plugin's own
CI, a subset of its standalone Electron build) — no toolchain, SHA-256-verified. The
`source` mode is kept for developers and as a fallback when no bundle exists for a
platform; it is the original clone-and-build path, unchanged.

**Why spawn the plugin server from the main process (not the Go server)?**
The Electron main process already owns the MEDomics Go server lifecycle; reusing that
pattern keeps a single supervisor for all child processes, gives free access to
`app.getPath("userData")`, and lets process state changes propagate to the UI through
the existing IPC event mechanism.

**Why a static registry?**
One known plugin does not justify a dynamic marketplace. `PLUGIN_REGISTRY` centralizes
metadata so a second plugin is a matter of adding one entry (plus, today, its proxy
blueprint — see §8).

---

## 7. Cross-Platform Notes

The manager is written to run on macOS, Linux, and Windows:

| Concern | macOS / Linux | Windows |
|---|---|---|
| Go binary name | `go_server` | `go_server.exe` |
| venv interpreter | `.venv/bin/python` | `.venv\Scripts\python.exe` |
| venv provisioning | `bash scripts/setup.sh` | `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` |
| Port sweep | `lsof -ti tcp:{port} -sTCP:LISTEN` + `SIGKILL` | `netstat -ano` + `taskkill /F` |
| gh CLI discovery (source) | Homebrew paths, `/usr/bin` | `C:\Program Files\GitHub CLI\gh.exe` |
| Bundle platform tag | `mac-arm64` / `mac-x64` / `linux-x64` | `win-x64` |

**Machine prerequisites depend on the install mode:**

- **`download` mode (default): none.** Everything the plugin needs (Go server, UI,
  PyInstaller Python worker, JRE, Weasis) ships inside the prebuilt bundle. No git, Node,
  Go, or Python is required, and no GitHub authentication either — the bundle is fetched
  from the repo's **public** Releases.
- **`source` mode (developer/fallback):** `git`, Node.js/npm, the Go toolchain, and
  **Python 3.13** (enforced by the plugin's setup scripts — the AI stack is pinned to it),
  plus GitHub access able to clone the repo (gh CLI login, an SSH key, or a git credential
  helper). Now that the repo is public, an anonymous clone works too.

In both modes the AI weights are **not** provisioned by MEDomics — the user loads them
from the plugin UI (see §3.6), and they are stored in `{userData}/plugins-data/{id}/models`.

---

## 8. How to Add Another Plugin

1. **Registry** — add an entry to `PLUGIN_REGISTRY` in `main/utils/pluginManager.js`
   with a unique `id` and a **unique port**.
2. **Proxy** — add a blueprint under `go_server/blueprints/{id}/` mapping
   `/{id}/ui/*` and `/{id}/*` to the plugin's port (copy `blueprints/starhe/starhe.go`
   and adjust), register it in `go_server/main.go`, rebuild the Go binary.
3. **Page** — create `renderer/components/mainPages/{id}.jsx` (copy `starhe.jsx`; the
   health-poll port and iframe path are the only plugin-specific parts), and wire it in
   `layoutManager.jsx` (import + `case "{id}"`) and `layoutContext.jsx` (open action).
4. **Sidebar** — add a conditional icon block in `iconSidebar.jsx` keyed on
   `installedPlugins?.{id}?.installed`.
5. The ExtensionManager, IPC handlers, and lifecycle logic are already generic — they
   iterate over the registry and require no change, **as long as the plugin follows the
   distribution contract for the mode(s) you want to support**:
   - **`download` mode:** each Release publishes a per-platform bundle named
     `{bundlePrefix}-{version}-{platformTag}.zip` (tags `mac-arm64`/`mac-x64`/`linux-x64`/
     `win-x64`), plus a `SHA256SUMS.txt`. The zip's contents (at its root) mirror the
     entrypoints in `plugin-bundle.json`: a Go server, a `ui/` directory, and whatever
     backend the server spawns (for STARHE: a PyInstaller worker, a JRE, Weasis). The Go
     server honors `PORT` and `STARHE_UI_DIR` (or the plugin's equivalents).
   - **`source` mode:** the repo has `renderer/` with a Vite build, `go_server/` with a
     buildable main package, and `scripts/setup.sh` + `scripts/setup.ps1` for Python
     provisioning.
   - **Both modes:** a Go server honoring the `PORT`/`*_UI_DIR` env vars, exposing
     `/health`, and emitting an SSE `{"level":"error"}` event before `[DONE]` when an
     analysis subprocess fails. Model weights are **not** part of the install contract —
     a plugin's own UI provisions them at runtime into `{userData}/plugins-data/{id}/`.

If a future plugin deviates from this layout, generalize the hardcoded paths in
`installPlugin`/`updatePlugin`/`startPluginServer` (e.g., move the build/run recipe into
each registry entry) rather than forking the manager.
