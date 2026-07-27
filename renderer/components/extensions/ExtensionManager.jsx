import React, { useCallback, useEffect, useRef, useState } from "react"
import { ipcRenderer } from "electron"
import { Button } from "primereact/button"
import { ProgressBar } from "primereact/progressbar"
import { Tag } from "primereact/tag"
import { MdLocalHospital, MdClose, MdExtension } from "react-icons/md"
import { FiDownload, FiRefreshCw, FiTrash2 } from "react-icons/fi"
import { BsCheckCircleFill, BsCircle, BsCircleFill } from "react-icons/bs"

// ── Plugin icons map ───────────────────────────────────────────────────────────
const PLUGIN_ICONS = {
  starhe: <MdLocalHospital style={{ fontSize: "2.2rem", color: "#4fc3f7" }} />,
}

// ── Install step labels ────────────────────────────────────────────────────────
// Two install modes coexist and emit different step sequences:
//   • "download" (default, public) — prebuilt bundle from public GitHub Releases,
//     no on-machine build (no Git, Node, Go, or Python).
//   • "source"   (developer / fallback) — clone + build on the machine.
// The AI weights (.pth) are never downloaded — the user loads them from the
// plugin's own UI (confidentiality).
const STEP_LABELS = {
  download: "Download",
  verify: "Verify",
  extract: "Extract",
  clone: "Clone",
  "build-react": "React frontend",
  "build-go": "Go server",
  python: "Python env",
  done: "Done",
}

const DOWNLOAD_STEPS = ["download", "verify", "extract", "done"]
const SOURCE_STEPS = ["clone", "build-react", "build-go", "python", "done"]

// Picks the sequence that contains the current step (defaults to download).
function stepSequenceFor(step) {
  return SOURCE_STEPS.includes(step) ? SOURCE_STEPS : DOWNLOAD_STEPS
}

// ── PluginCard ────────────────────────────────────────────────────────────────
const PluginCard = ({ plugin, onInstall, onUninstall, onUpdate, progress }) => {
  const isInstalling = progress && progress.step !== "done"
  const installDone = progress?.step === "done"

  const steps = stepSequenceFor(progress?.step ?? "")
  const stepIndex = steps.indexOf(progress?.step ?? "")
  const totalSteps = steps.length - 1 // exclude "done" from progress calc

  return (
    <div className="ext-plugin-card">
      {/* Header */}
      <div className="ext-plugin-header">
        <div className="ext-plugin-icon">{PLUGIN_ICONS[plugin.id] ?? <MdExtension style={{ fontSize: "2.2rem", color: "#9e9e9e" }} />}</div>
        <div className="ext-plugin-title-block">
          <div className="ext-plugin-name">{plugin.name}</div>
          <div className="ext-plugin-fullname">{plugin.fullName}</div>
          <div className="ext-plugin-meta">
            <span className="ext-plugin-author">{plugin.author}</span>
            {plugin.version && <Tag value={`v${plugin.version}`} severity="info" style={{ fontSize: "0.7rem" }} />}
            {plugin.tags?.slice(0, 3).map((tag) => (
              <Tag key={tag} value={tag} severity="secondary" style={{ fontSize: "0.65rem" }} />
            ))}
          </div>
        </div>

        {/* Status badge */}
        <div className="ext-status-badge">
          {plugin.installed ? (
            <>
              <BsCheckCircleFill style={{ color: "#66bb6a", fontSize: "1rem" }} />
              <span style={{ color: "#66bb6a", fontSize: "0.75rem" }}>Installed</span>
              {plugin.serverRunning ? (
                <span className="ext-server-dot ext-server-dot--on" title="Server running" />
              ) : (
                <span className="ext-server-dot ext-server-dot--off" title="Server stopped" />
              )}
            </>
          ) : (
            <>
              <BsCircle style={{ color: "#9e9e9e", fontSize: "1rem" }} />
              <span style={{ color: "#9e9e9e", fontSize: "0.75rem" }}>Not installed</span>
            </>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="ext-plugin-description">{plugin.description}</p>

      {/* Install progress */}
      {isInstalling && (
        <div className="ext-progress-block">
          <div className="ext-progress-steps">
            {steps.filter((s) => s !== "done").map((step, i) => {
              const done = i < stepIndex
              const active = i === stepIndex
              return (
                <div key={step} className={`ext-progress-step ${done ? "done" : active ? "active" : ""}`}>
                  {done ? (
                    <BsCheckCircleFill style={{ color: "#66bb6a" }} />
                  ) : active ? (
                    <BsCircleFill style={{ color: "#4fc3f7" }} />
                  ) : (
                    <BsCircle style={{ color: "#555" }} />
                  )}
                  <span>{STEP_LABELS[step]}</span>
                </div>
              )
            })}
          </div>
          <div className="ext-progress-message">{progress.message}</div>
          <ProgressBar
            value={Math.round((stepIndex / totalSteps) * 100)}
            style={{ height: "6px", marginTop: "0.5rem" }}
            showValue={false}
          />
        </div>
      )}

      {installDone && (
        <div className="ext-install-done">
          <BsCheckCircleFill style={{ color: "#66bb6a", fontSize: "1.1rem" }} />
          <span>Plugin installed successfully!</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="ext-plugin-actions">
        {!plugin.installed && !isInstalling && !installDone && (
          <Button
            label="Install"
            icon={<FiDownload style={{ marginRight: "0.4rem" }} />}
            className="p-button-sm p-button-primary ext-btn-install"
            onClick={onInstall}
          />
        )}

        {plugin.installed && (
          <>
            <Button
              label="Update"
              icon={<FiRefreshCw style={{ marginRight: "0.4rem" }} />}
              className="p-button-sm p-button-outlined ext-btn-update"
              onClick={onUpdate}
              disabled={isInstalling}
            />
            <Button
              label="Uninstall"
              icon={<FiTrash2 style={{ marginRight: "0.4rem" }} />}
              className="p-button-sm p-button-outlined p-button-danger ext-btn-uninstall"
              onClick={onUninstall}
              disabled={isInstalling}
            />
          </>
        )}
      </div>
    </div>
  )
}

// ── ExtensionManager (main panel) ─────────────────────────────────────────────
const ExtensionManager = ({ open, onClose }) => {
  const [plugins, setPlugins] = useState({})
  const [progresses, setProgresses] = useState({}) // { [id]: { step, progress, message } }
  const [errors, setErrors] = useState({}) // { [id]: string }
  const panelRef = useRef(null)

  // Load plugins state on open
  useEffect(() => {
    if (!open) return
    ipcRenderer.invoke("plugin:get-state").then(setPlugins).catch(console.error)
  }, [open])

  // Listen for state changes from main process
  useEffect(() => {
    const onStateChanged = (_e, state) => setPlugins(state)
    const onProgress = (_e, data) => {
      setProgresses((prev) => ({ ...prev, [data.id]: data }))
      if (data.step === "done") {
        // Clear progress after a delay
        setTimeout(() => setProgresses((prev) => {
          const copy = { ...prev }
          delete copy[data.id]
          return copy
        }), 3000)
      }
    }

    ipcRenderer.on("plugin:state-changed", onStateChanged)
    ipcRenderer.on("plugin:progress", onProgress)
    return () => {
      ipcRenderer.removeListener("plugin:state-changed", onStateChanged)
      ipcRenderer.removeListener("plugin:progress", onProgress)
    }
  }, [])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, onClose])

  const handleInstall = useCallback(async (id) => {
    setErrors((prev) => ({ ...prev, [id]: null }))
    const res = await ipcRenderer.invoke("plugin:install", id)
    if (!res.success) setErrors((prev) => ({ ...prev, [id]: res.error }))
  }, [])

  const handleUninstall = useCallback(async (id) => {
    const res = await ipcRenderer.invoke("plugin:uninstall", id)
    if (!res.success) setErrors((prev) => ({ ...prev, [id]: res.error }))
  }, [])

  const handleUpdate = useCallback(async (id) => {
    setErrors((prev) => ({ ...prev, [id]: null }))
    const res = await ipcRenderer.invoke("plugin:update", id)
    if (!res.success) setErrors((prev) => ({ ...prev, [id]: res.error }))
  }, [])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div className="ext-backdrop" onClick={onClose} />

      {/* Panel */}
      <div className="ext-panel" ref={panelRef}>
        {/* Header */}
        <div className="ext-panel-header">
          <div className="ext-panel-title">
            <MdExtension style={{ fontSize: "1.4rem", color: "#4fc3f7" }} />
            <span>MEDomics Extensions</span>
          </div>
          <button className="ext-close-btn" onClick={onClose} title="Close">
            <MdClose />
          </button>
        </div>

        <p className="ext-panel-subtitle">
          Install plugins to extend the MEDomics platform.
        </p>

        {/* Plugin list */}
        <div className="ext-plugin-list">
          {Object.values(plugins).length === 0 && (
            <div className="ext-empty">Loading extensions…</div>
          )}
          {Object.values(plugins).map((plugin) => (
            <div key={plugin.id}>
              <PluginCard
                plugin={plugin}
                progress={progresses[plugin.id]}
                onInstall={() => handleInstall(plugin.id)}
                onUninstall={() => handleUninstall(plugin.id)}
                onUpdate={() => handleUpdate(plugin.id)}
              />
              {errors[plugin.id] && (
                <div className="ext-error-msg">
                  Error: {errors[plugin.id]}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

export default ExtensionManager
