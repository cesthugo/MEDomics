import { app } from "electron"
import path from "path"
import fs from "fs"
import crypto from "crypto"
import { execFile, exec, execSync } from "child_process"
import util from "util"
import axios from "axios"
import decompress from "decompress"

const execAsync = util.promisify(exec)

// ── Registry ──────────────────────────────────────────────────────────────────
//
// Single source of truth for plugin metadata. A plugin can be installed two ways:
//
//   • "download" (default, public) — a prebuilt, per-platform bundle is downloaded
//     from the plugin repo's public GitHub Releases and extracted. No git / Node /
//     Go / Python toolchain is required on the machine.
//
//   • "source" (developer / fallback) — the plugin repo is cloned and built on the
//     machine (npm + go build + the plugin's own venv setup script). Requires the
//     full toolchain and GitHub access. Opt in with the env var
//     MEDOMICS_PLUGIN_SOURCE=1, or by passing { mode: "source" } to installPlugin.

export const PLUGIN_REGISTRY = {
  starhe: {
    id: "starhe",
    name: "STARHE",
    fullName: "Stratification of risk and deTection of Hepatocellular carcinoma by Echography",
    description:
      "Analysis of hepatic ultrasound DICOM cine-clips to screen for hepatocellular carcinoma (HCC). Uses two AI models: STARHE-RISK (HCC risk score [0-1]) and STARHE-DETECT (localization and classification of hepatic lesions).",
    version: "0.7.0", // display fallback — the real version comes from the Release / repo
    author: "MEDomicsLab",
    githubUrl: "https://github.com/cesthugo/PLUGIN1-MEDomics",
    githubRepo: "cesthugo/PLUGIN1-MEDomics", // used by "source" mode (clone)
    releaseRepo: "cesthugo/PLUGIN1-MEDomics", // used by "download" mode (Releases)
    bundlePrefix: "starhe-plugin", // asset name: {bundlePrefix}-{version}-{platformTag}.zip
    port: 8082,
    tags: ["DICOM", "Medical imaging", "AI", "Ultrasound", "Carcinoma"],
  },
}

// Chooses the install method. Explicit opts win; otherwise the MEDOMICS_PLUGIN_SOURCE
// env var opts into source builds; the default is the public "download" mode.
function resolveInstallMode(opts) {
  if (opts?.mode === "source" || opts?.mode === "download") return opts.mode
  const env = process.env.MEDOMICS_PLUGIN_SOURCE
  if (env && env !== "0" && env.toLowerCase() !== "false") return "source"
  return "download"
}

// ── State persistence ─────────────────────────────────────────────────────────

function getStateFile() {
  return path.join(app.getPath("userData"), "plugins-state.json")
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(getStateFile(), "utf8"))
  } catch {
    return {}
  }
}

function writeState(state) {
  fs.writeFileSync(getStateFile(), JSON.stringify(state, null, 2), "utf8")
}

function getPluginState(id) {
  const state = readState()
  return (
    state[id] ?? {
      installed: false,
      version: null,
      pluginPath: null,
      mode: null,
      entrypoints: null,
      serverRunning: false,
    }
  )
}

function setPluginState(id, patch) {
  const state = readState()
  state[id] = { ...getPluginState(id), ...patch }
  writeState(state)
}

// ── Running processes ─────────────────────────────────────────────────────────

const _procs = {}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emit(mainWindow, channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function emitProgress(mainWindow, id, step, progress, message) {
  emit(mainWindow, "plugin:progress", { id, step, progress, message })
}

function emitStateChanged(mainWindow) {
  emit(mainWindow, "plugin:state-changed", getPluginsState())
}

function exeSuffix() {
  return process.platform === "win32" ? ".exe" : ""
}

function goBinaryName() {
  return process.platform === "win32" ? "go_server.exe" : "go_server"
}

// Install directory (wiped and re-populated on every install/update).
function getPluginInstallDir(id) {
  return path.join(app.getPath("userData"), "plugins", id)
}

// Plugin DATA directory — outside the install dir, so it is PRESERVED across
// updates (which wipe and re-populate getPluginInstallDir). This is where the
// plugin stores the AI weights (.pth) that the user loads locally.
function getPluginDataDir(id) {
  return path.join(app.getPath("userData"), "plugins-data", id)
}

// Kills any process listening on the given port (even one we did not start — e.g.
// a dev server launched manually that squats the port). Without this, the fresh
// binary cannot bind the port and dies silently while the old process keeps
// serving a stale version.
async function killProcessOnPort(port) {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port} | findstr LISTENING`)
      const pids = [
        ...new Set(
          stdout
            .trim()
            .split("\n")
            .map((l) => l.trim().split(/\s+/).pop())
            .filter((p) => p && p !== "0")
        ),
      ]
      for (const pid of pids) {
        await execAsync(`taskkill /F /PID ${pid}`).catch(() => {})
      }
    } else {
      const { stdout } = await execAsync(`lsof -ti tcp:${port} -sTCP:LISTEN`)
      for (const pid of stdout.trim().split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL")
        } catch {}
      }
    }
    // Give the OS time to release the socket before re-binding
    await new Promise((r) => setTimeout(r, 500))
  } catch {
    // No process on the port — nothing to do
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  "download" mode — prebuilt bundle from public GitHub Releases (default)
// ════════════════════════════════════════════════════════════════════════════

const GH_HEADERS = { "User-Agent": "MEDomics", Accept: "application/vnd.github+json" }

// Maps the current Electron platform to the bundle asset tag (must match the
// plugin's CI matrix: mac-arm64, mac-x64, linux-x64, win-x64).
function platformTag() {
  const p = process.platform
  const a = process.arch
  if (p === "darwin") {
    if (a === "arm64") return "mac-arm64"
    if (a === "x64") return "mac-x64"
  }
  if (p === "linux" && a === "x64") return "linux-x64"
  if (p === "win32" && a === "x64") return "win-x64"
  throw new Error(`Unsupported platform for a prebuilt bundle: ${p}/${a}`)
}

// Default bundle entrypoints (fallback if plugin-bundle.json is missing).
function defaultBundleEntrypoints() {
  const exe = exeSuffix()
  return {
    goServer: path.join("go_server", `go_server${exe}`),
    uiDir: "ui",
    workerBin: path.join("starhe_worker", `starhe_worker${exe}`),
    weasisDir: "weasis-dcm2png",
    javaBin: path.join("jre", "bin", `java${exe}`),
  }
}

function readBundleManifest(pluginDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin-bundle.json"), "utf8"))
  } catch {
    return null
  }
}

// macOS only: applies a fresh ad-hoc code signature to the plugin's native
// Mach-O files. Unzipping invalidates the binaries' original signature on Apple
// Silicon, so the OS kills them right after launch; re-signing in place fixes
// it. Best-effort and idempotent (no-op if codesign is unavailable).
function resignMacBinaries(pluginDir, entry) {
  const sign = (p) => {
    try {
      execSync(`codesign --force --sign - "${p}"`, { stdio: "ignore" })
    } catch {}
  }
  // Entrypoint executables (Go server, PyInstaller worker, bundled JRE launcher)
  for (const rel of [entry.goServer, entry.workerBin, entry.javaBin]) {
    if (rel) sign(path.join(pluginDir, rel))
  }
  // Nested shared libraries shipped with the worker / JRE / Weasis
  for (const sub of ["starhe_worker", "jre", "weasis-dcm2png"]) {
    const dir = path.join(pluginDir, sub)
    if (!fs.existsSync(dir)) continue
    try {
      execSync(`find "${dir}" \\( -name "*.dylib" -o -name "*.so" \\) -exec codesign --force --sign - {} \\;`, {
        stdio: "ignore",
      })
    } catch {}
  }
}

// Returns the most recent Release (prereleases included, drafts excluded) that
// actually ships a bundle for the current platform. We do NOT use
// /releases/latest because it ignores prereleases (the plugin's betas).
async function resolveRelease(meta, tag) {
  const url = `https://api.github.com/repos/${meta.releaseRepo}/releases?per_page=30`
  const { data } = await axios.get(url, { headers: GH_HEADERS, timeout: 30_000 })
  const isBundle = (name) =>
    name.startsWith(`${meta.bundlePrefix}-`) && name.endsWith(`-${tag}.zip`)
  const rel = data.find((r) => !r.draft && (r.assets || []).some((a) => isBundle(a.name)))
  if (!rel) {
    throw new Error(
      `No bundle "${meta.bundlePrefix}-*-${tag}.zip" found in the Releases of ${meta.releaseRepo} ` +
        `(platform ${tag}). Make sure a published Release exposes this bundle, or install from source.`
    )
  }
  const bundle = rel.assets.find((a) => isBundle(a.name))
  const sums = rel.assets.find((a) => a.name === "SHA256SUMS.txt")
  return {
    version: String(rel.tag_name).replace(/^v/, ""),
    tagName: rel.tag_name,
    bundleAsset: bundle,
    sumsAsset: sums,
  }
}

// Streams a URL to a file, reporting download progress.
async function downloadTo(url, dest, onFraction) {
  const resp = await axios.get(url, {
    responseType: "stream",
    maxRedirects: 5,
    headers: { "User-Agent": "MEDomics", Accept: "application/octet-stream" },
    timeout: 0,
  })
  const total = Number(resp.headers["content-length"]) || 0
  let received = 0
  const writer = fs.createWriteStream(dest)
  await new Promise((resolve, reject) => {
    resp.data.on("data", (chunk) => {
      received += chunk.length
      if (total && onFraction) onFraction(received / total)
    })
    resp.data.on("error", reject)
    writer.on("error", reject)
    writer.on("finish", resolve)
    resp.data.pipe(writer)
  })
  return { size: received }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    const stream = fs.createReadStream(filePath)
    stream.on("data", (d) => hash.update(d))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

// Verifies the zip checksum against SHA256SUMS.txt (best-effort: if the sums file
// is absent from the Release, warn and continue).
async function verifyChecksum(zipPath, assetName, sumsPath, mainWindow, id) {
  emitProgress(mainWindow, id, "verify", 0, "Verifying integrity (SHA-256)…")
  if (!sumsPath || !fs.existsSync(sumsPath)) {
    console.warn(`[pluginManager] SHA256SUMS.txt missing — skipping verification for ${assetName}`)
    emitProgress(mainWindow, id, "verify", 100, "No checksums published — step skipped")
    return
  }
  const sums = fs.readFileSync(sumsPath, "utf8")
  let expected = null
  for (const line of sums.split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m && path.basename(m[2]) === assetName) {
      expected = m[1].toLowerCase()
      break
    }
  }
  if (!expected) {
    console.warn(`[pluginManager] ${assetName} absent from SHA256SUMS.txt — skipping verification`)
    emitProgress(mainWindow, id, "verify", 100, "Checksum not found — step skipped")
    return
  }
  const actual = (await sha256File(zipPath)).toLowerCase()
  if (actual !== expected) {
    throw new Error(
      `Integrity check failed for ${assetName}: expected SHA-256 ${expected}, got ${actual}. ` +
        `Corrupted or tampered download — installation aborted.`
    )
  }
  emitProgress(mainWindow, id, "verify", 100, "Integrity verified ✓")
}

// Downloads, verifies and extracts the prebuilt bundle. Does NOT start the server.
async function installFromDownload(id, mainWindow) {
  const meta = PLUGIN_REGISTRY[id]
  const tag = platformTag()
  const pluginDir = getPluginInstallDir(id)
  const tmpDir = path.join(app.getPath("userData"), "plugins", ".dl")
  fs.mkdirSync(tmpDir, { recursive: true })

  // 1. Resolve the Release + the asset for the current platform
  emitProgress(mainWindow, id, "download", 0, "Looking up the latest published version…")
  const rel = await resolveRelease(meta, tag)
  const zipPath = path.join(tmpDir, rel.bundleAsset.name)
  const sumsPath = rel.sumsAsset ? path.join(tmpDir, "SHA256SUMS.txt") : null

  // 2. Download the bundle (+ SHA256SUMS.txt if present)
  emitProgress(mainWindow, id, "download", 0, `Downloading ${rel.bundleAsset.name} (${rel.version})…`)
  await downloadTo(rel.bundleAsset.browser_download_url, zipPath, (f) =>
    emitProgress(mainWindow, id, "download", Math.round(f * 100), `Downloading… ${Math.round(f * 100)}%`)
  )
  if (rel.sumsAsset) {
    await downloadTo(rel.sumsAsset.browser_download_url, sumsPath).catch(() => {})
  }
  emitProgress(mainWindow, id, "download", 100, "Download complete ✓")

  // 3. Verify integrity
  await verifyChecksum(zipPath, rel.bundleAsset.name, sumsPath, mainWindow, id)

  // 4. Extract (clean install: wipe the old install dir, NOT the data dir)
  emitProgress(mainWindow, id, "extract", 0, "Extracting the bundle…")
  if (fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true })
  fs.mkdirSync(pluginDir, { recursive: true })
  await decompress(zipPath, pluginDir)
  fs.rmSync(zipPath, { force: true })

  // 5. Make the binaries executable (Unix — the +x bit can be lost through zip)
  const entry = { ...defaultBundleEntrypoints(), ...(readBundleManifest(pluginDir)?.entrypoints || {}) }
  if (process.platform !== "win32") {
    for (const relPath of [entry.goServer, entry.workerBin, entry.javaBin]) {
      try {
        fs.chmodSync(path.join(pluginDir, relPath), 0o755)
      } catch {}
    }
  }

  // 5b. macOS: re-sign the extracted native binaries ad-hoc. On Apple Silicon,
  // unzipping invalidates the binary's original (linker/ad-hoc) code signature,
  // so macOS SIGKILLs it shortly after the packaged app spawns it (the plugin
  // server then "closes (code null)" ~9s after launch and never becomes
  // reachable). `codesign --force --sign -` applies a fresh ad-hoc signature in
  // the new location. We sign the entrypoint executables plus the nested
  // dylibs/.so inside the PyInstaller worker and the JRE. No-op if codesign is
  // absent. See main/utils/server.js for the equivalent core-backend concern.
  if (process.platform === "darwin") {
    resignMacBinaries(pluginDir, entry)
  }

  emitProgress(mainWindow, id, "extract", 100, "Bundle extracted ✓")

  // 6. Persist state
  fs.mkdirSync(getPluginDataDir(id), { recursive: true })
  setPluginState(id, {
    installed: true,
    version: rel.version,
    pluginPath: pluginDir,
    mode: "download",
    entrypoints: entry,
  })
  emitProgress(mainWindow, id, "done", 100, `Plugin ${meta.name} ${rel.version} installed!`)
  return rel
}

// ════════════════════════════════════════════════════════════════════════════
//  "source" mode — clone the repo and build on the machine (developer / fallback)
// ════════════════════════════════════════════════════════════════════════════

// Finds the gh binary in common locations (Homebrew macOS, Linux, Windows).
// Necessary because Electron apps launched from Finder/Dock do NOT inherit the
// user's shell PATH.
function findGhBinary() {
  const candidates = [
    "gh",
    "/opt/homebrew/bin/gh", // Homebrew Apple Silicon
    "/usr/local/bin/gh", // Homebrew Intel
    "/usr/bin/gh", // Linux
    "C:\\Program Files\\GitHub CLI\\gh.exe", // Windows
  ]
  for (const bin of candidates) {
    try {
      execSync(`"${bin}" --version`, { stdio: "ignore" })
      return bin
    } catch {}
  }
  return null
}

// Clones from GitHub — three strategies in order (gh CLI, SSH, HTTPS), collecting
// errors for a meaningful failure message. Handles private repos when the user is
// authenticated (gh login, SSH key, or a git credential helper).
async function cloneRepo(githubRepo, githubUrl, destDir) {
  const sshUrl = `git@github.com:${githubRepo}.git`
  const errors = []

  const ghBin = findGhBinary()
  if (ghBin) {
    try {
      await execAsync(`"${ghBin}" repo clone "${githubRepo}" "${destDir}"`, { timeout: 180_000 })
      return
    } catch (err) {
      errors.push(`gh: ${err.message}`)
    }
  }

  try {
    await execAsync(`git clone "${sshUrl}" "${destDir}"`, { timeout: 180_000 })
    return
  } catch (err) {
    errors.push(`SSH: ${err.message}`)
  }

  try {
    await execAsync(`git clone "${githubUrl}" "${destDir}"`, { timeout: 180_000 })
    return
  } catch (err) {
    errors.push(`HTTPS: ${err.message}`)
  }

  throw new Error(
    `Could not clone the repository. Make sure you are authenticated (gh auth login or an SSH key).\n${errors.join("\n")}`
  )
}

// Runs the plugin's OWN venv provisioning script (scripts/setup.sh|ps1).
// Idempotent: creates the venv if absent, installs requirements.txt, mmaction2
// (--no-deps + venv patches) and the vendored prepUS/sonocrop. We do NOT build the
// venv ourselves: a plain `pip install -r requirements.txt` misses mmaction2 and
// prepUS, and the AI pipeline then fails with ModuleNotFoundError.
async function runPluginSetup(pluginDir, mainWindow, id) {
  const isWin = process.platform === "win32"
  const script = path.join(pluginDir, "scripts", isWin ? "setup.ps1" : "setup.sh")
  if (!fs.existsSync(script)) {
    throw new Error(`Plugin setup script not found: ${script}`)
  }
  emitProgress(mainWindow, id, "python", 0, "Python environment (venv + AI — may take several minutes)…")
  const cmd = isWin
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`
    : `bash "${script}"`
  await execAsync(cmd, { cwd: pluginDir, timeout: 1_800_000, maxBuffer: 10 * 1024 * 1024 })
  emitProgress(mainWindow, id, "python", 100, "Python environment ready ✓")
}

// Clones the repo and builds React + Go + the venv on the machine. Does NOT start
// the server.
async function installFromSource(id, mainWindow) {
  const meta = PLUGIN_REGISTRY[id]
  const pluginDir = getPluginInstallDir(id)

  // 1. Clone from GitHub
  emitProgress(mainWindow, id, "clone", 0, `Cloning from ${meta.githubUrl}…`)
  if (fs.existsSync(pluginDir)) fs.rmSync(pluginDir, { recursive: true, force: true })
  fs.mkdirSync(pluginDir, { recursive: true })
  await cloneRepo(meta.githubRepo, meta.githubUrl, pluginDir)
  emitProgress(mainWindow, id, "clone", 100, "Repository cloned ✓")

  // 2. Build the React UI (Vite — renderer/)
  const reactDir = path.join(pluginDir, "renderer")
  if (fs.existsSync(reactDir)) {
    emitProgress(mainWindow, id, "build-react", 0, "Installing React dependencies…")
    await execAsync("npm install", { cwd: reactDir, timeout: 180_000 })
    emitProgress(mainWindow, id, "build-react", 55, "Building the React frontend (Vite)…")
    await execAsync("npm run build", { cwd: reactDir, timeout: 180_000 })
    emitProgress(mainWindow, id, "build-react", 100, "React frontend built ✓")
  }

  // 3. Build the Go server
  emitProgress(mainWindow, id, "build-go", 0, "Building the Go server…")
  await execAsync(`go build -o ${goBinaryName()} .`, {
    cwd: path.join(pluginDir, "go_server"),
    timeout: 120_000,
  })
  emitProgress(mainWindow, id, "build-go", 100, "Go server built ✓")

  // 4. Python environment — via the plugin's own setup script (venv + requirements
  //    + patched mmaction2 + vendored prepUS). AI weights (.pth) are NOT fetched
  //    here — the user loads them from the plugin UI.
  await runPluginSetup(pluginDir, mainWindow, id)

  // 5. Persist state
  setPluginState(id, {
    installed: true,
    version: meta.version,
    pluginPath: pluginDir,
    mode: "source",
    entrypoints: null,
  })
  emitProgress(mainWindow, id, "done", 100, `Plugin ${meta.name} installed from source!`)
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getPluginsState() {
  const result = {}
  for (const [id, meta] of Object.entries(PLUGIN_REGISTRY)) {
    const persisted = getPluginState(id)
    result[id] = {
      ...meta,
      installed: persisted.installed ?? false,
      version: persisted.version ?? null,
      pluginPath: persisted.pluginPath ?? null,
      mode: persisted.mode ?? null,
      serverRunning: !!_procs[id] && !_procs[id].killed,
    }
  }
  return result
}

export async function installPlugin(id, mainWindow, opts) {
  const meta = PLUGIN_REGISTRY[id]
  if (!meta) throw new Error(`Unknown plugin: ${id}`)
  if (resolveInstallMode(opts) === "source") {
    await installFromSource(id, mainWindow)
  } else {
    await installFromDownload(id, mainWindow)
  }
  emitStateChanged(mainWindow)
}

export async function uninstallPlugin(id, mainWindow) {
  await stopPluginServer(id, mainWindow)

  // Remove the install dir. We KEEP getPluginDataDir (AI weights loaded by the
  // user) — an uninstall must not silently destroy them.
  const pluginDir = getPluginInstallDir(id)
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true })
  }

  setPluginState(id, {
    installed: false,
    version: null,
    pluginPath: null,
    mode: null,
    entrypoints: null,
    serverRunning: false,
  })
  emitStateChanged(mainWindow)
}

export async function updatePlugin(id, mainWindow, opts) {
  const meta = PLUGIN_REGISTRY[id]
  const state = getPluginState(id)
  const pluginDir = state.pluginPath ?? getPluginInstallDir(id)

  // If nothing is installed, an "update" is really an install.
  if (!state.installed || !fs.existsSync(pluginDir)) {
    await installPlugin(id, mainWindow, opts)
    return
  }

  // Update follows the mode the plugin was installed with (unless overridden).
  const mode = opts?.mode ?? state.mode ?? resolveInstallMode(opts)

  if (mode === "source") {
    await updateFromSource(id, mainWindow, pluginDir)
  } else {
    await updateFromDownload(id, mainWindow, state)
  }
  emitStateChanged(mainWindow)
}

async function updateFromDownload(id, mainWindow, state) {
  const meta = PLUGIN_REGISTRY[id]
  emitProgress(mainWindow, id, "download", 0, "Checking for updates…")
  const rel = await resolveRelease(meta, platformTag())
  if (rel.version === state.version) {
    emitProgress(mainWindow, id, "done", 100, `Plugin already up to date (${state.version}).`)
    if (!_procs[id] || _procs[id].killed) {
      await startPluginServer(id, mainWindow).catch(() => {})
    }
    return
  }
  // Stop before replacing files (Windows can't overwrite a running binary), then
  // re-download + re-extract (keeps the data/weights in getPluginDataDir).
  await stopPluginServer(id, mainWindow)
  await installFromDownload(id, mainWindow)
  await startPluginServer(id, mainWindow)
}

async function updateFromSource(id, mainWindow, pluginDir) {
  // 1. Stop the server first (Windows can't overwrite a running binary; the
  //    restart is needed to load the new code anyway).
  await stopPluginServer(id, mainWindow)

  // 2. Sync deterministically — NOT `git pull`. The install dir is a managed
  //    artifact that gets dirty on its own (npm rewrites package-lock.json), which
  //    makes `git pull` fail. fetch + reset --hard only touches tracked files and
  //    leaves renderer/dist/, .venv/, models/ intact (they are gitignored).
  emitProgress(mainWindow, id, "clone", 0, "Updating from GitHub…")
  await execAsync("git fetch origin", { cwd: pluginDir, timeout: 120_000 })
  await execAsync("git reset --hard @{u}", { cwd: pluginDir, timeout: 120_000 })
  emitProgress(mainWindow, id, "clone", 100, "Repository updated ✓")

  // 3. Rebuild the React frontend (dependencies may have changed)
  const reactDir = path.join(pluginDir, "renderer")
  if (fs.existsSync(reactDir)) {
    emitProgress(mainWindow, id, "build-react", 0, "Updating React dependencies…")
    await execAsync("npm install", { cwd: reactDir, timeout: 180_000 })
    emitProgress(mainWindow, id, "build-react", 55, "Rebuilding the React frontend (Vite)…")
    await execAsync("npm run build", { cwd: reactDir, timeout: 180_000 })
    emitProgress(mainWindow, id, "build-react", 100, "React frontend rebuilt ✓")
  }

  // 4. Rebuild the Go server
  emitProgress(mainWindow, id, "build-go", 0, "Rebuilding the Go server…")
  await execAsync(`go build -o ${goBinaryName()} .`, {
    cwd: path.join(pluginDir, "go_server"),
    timeout: 120_000,
  })
  emitProgress(mainWindow, id, "build-go", 100, "Go server rebuilt ✓")

  // 5. Python environment — the plugin's setup script again (idempotent)
  await runPluginSetup(pluginDir, mainWindow, id)

  // 6. Persist and restart
  setPluginState(id, { version: PLUGIN_REGISTRY[id].version, pluginPath: pluginDir, mode: "source" })
  emitProgress(mainWindow, id, "done", 100, `Plugin ${PLUGIN_REGISTRY[id].name} updated!`)
  await startPluginServer(id, mainWindow)
}

export async function startPluginServer(id, mainWindow) {
  if (_procs[id] && !_procs[id].killed) return

  const state = getPluginState(id)
  if (!state.installed || !state.pluginPath) throw new Error("Plugin not installed")

  const meta = PLUGIN_REGISTRY[id]
  const pluginDir = state.pluginPath
  const mode = state.mode ?? "download"

  // AI weights directory: OUTSIDE the install dir, preserved across updates.
  const weightsDir = path.join(getPluginDataDir(id), "models")
  fs.mkdirSync(weightsDir, { recursive: true })

  let binaryPath
  let env

  if (mode === "source") {
    // Built-from-source layout: renderer/dist for the UI, a venv Python for the
    // pipeline (no PyInstaller worker).
    binaryPath = path.join(pluginDir, "go_server", goBinaryName())
    const venvBase = path.join(pluginDir, "pythonCode", "modules", "starhe_plugin", ".venv")
    const venvPython =
      process.platform === "win32"
        ? path.join(venvBase, "Scripts", "python.exe")
        : path.join(venvBase, "bin", "python")
    env = {
      ...process.env,
      PORT: String(meta.port),
      STARHE_SERVER_PORT: String(meta.port),
      STARHE_UI_DIR: path.join(pluginDir, "renderer", "dist"),
      STARHE_PYTHON_PATH: path.join(pluginDir, "pythonCode", "modules"),
      PYTHON_MOD_PATH: path.join(pluginDir, "pythonCode", "modules"),
      STARHE_WEIGHTS_DIR: weightsDir,
      ...(fs.existsSync(venvPython) ? { MED_ENV: venvPython, STARHE_PYTHON_EXE: venvPython } : {}),
    }
  } else {
    // Prebuilt-bundle layout: ui/, PyInstaller worker, embedded JRE, Weasis.
    // (see go_server/config.go + renderer/electron/main.ts on the plugin side).
    const entry = {
      ...defaultBundleEntrypoints(),
      ...(state.entrypoints || readBundleManifest(pluginDir)?.entrypoints || {}),
    }
    binaryPath = path.join(pluginDir, entry.goServer)
    env = {
      ...process.env,
      PORT: String(meta.port),
      STARHE_SERVER_PORT: String(meta.port),
      STARHE_UI_DIR: path.join(pluginDir, entry.uiDir),
      STARHE_WORKER_BIN: path.join(pluginDir, entry.workerBin),
      STARHE_WEASIS_DIR: path.join(pluginDir, entry.weasisDir),
      STARHE_JAVA_BIN: path.join(pluginDir, entry.javaBin),
      STARHE_WEIGHTS_DIR: weightsDir,
    }
  }

  if (!fs.existsSync(binaryPath)) {
    throw new Error("Plugin binary not found — reinstall the plugin.")
  }

  // Free the port before starting — a foreign server (e.g. a manually launched
  // dev server) occupying the port would make the bind fail silently, and the old
  // version would keep being served in its place.
  await killProcessOnPort(meta.port)

  _procs[id] = execFile(binaryPath, [], {
    env,
    cwd: path.dirname(binaryPath),
    windowsHide: true,
  })

  _procs[id].stdout?.on("data", (d) => console.log(`[plugin:${id}]`, d.toString().trim()))
  _procs[id].stderr?.on("data", (d) => console.error(`[plugin:${id} ERR]`, d.toString().trim()))
  _procs[id].on("close", (code) => {
    console.log(`[plugin:${id}] server closed (code ${code})`)
    delete _procs[id]
    setPluginState(id, { serverRunning: false })
    emitStateChanged(mainWindow)
  })
  _procs[id].on("error", (err) => {
    console.error(`[plugin:${id}] start error`, err.message)
    delete _procs[id]
    emitStateChanged(mainWindow)
  })

  await new Promise((r) => setTimeout(r, 1500))

  // If the process already died (e.g. port taken, corrupted binary), the 'close'
  // handler removed it from _procs — fail clearly instead of pretending the
  // server is running.
  if (!_procs[id] || _procs[id].killed) {
    setPluginState(id, { serverRunning: false })
    emitStateChanged(mainWindow)
    throw new Error(`The ${meta.name} server stopped immediately after starting — check the logs.`)
  }

  setPluginState(id, { serverRunning: true })
  emitStateChanged(mainWindow)
}

export async function stopPluginServer(id, mainWindow) {
  if (_procs[id]) {
    try {
      _procs[id].kill()
    } catch {}
    delete _procs[id]
  }
  // Also sweep the port: kill any residual process still occupying it (an orphan
  // server from a previous session, a dev server, etc.)
  const meta = PLUGIN_REGISTRY[id]
  if (meta?.port) {
    await killProcessOnPort(meta.port)
  }
  setPluginState(id, { serverRunning: false })
  if (mainWindow) emitStateChanged(mainWindow)
}

export async function stopAllPlugins() {
  for (const id of Object.keys(_procs)) {
    await stopPluginServer(id, null)
  }
}

export async function autoStartInstalledPlugins(mainWindow) {
  const state = readState()
  for (const [id, pluginState] of Object.entries(state)) {
    if (pluginState.installed) {
      try {
        await startPluginServer(id, mainWindow)
        console.log(`[pluginManager] ${id} auto-started`)
      } catch (err) {
        console.warn(`[pluginManager] could not start ${id}:`, err.message)
      }
    }
  }
}
