import React, { useContext, useEffect, useRef, useState } from "react"
import { ipcRenderer } from "electron"
import { MdLocalHospital } from "react-icons/md"
import { ProgressBar } from "primereact/progressbar"
import { WorkspaceContext } from "../workspace/workspaceContext"

const STARHE_PORT = 8082 // port direct pour le health check (Node.js, pas Chromium)
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = null // pas de timeout — on attend indéfiniment le serveur

const StarhePage = () => {
  const [serverStatus, setServerStatus] = useState("starting") // "starting" | "ready" | "error"
  const [loadAttempts, setLoadAttempts] = useState(0)
  // iframeKey change à chaque redémarrage du serveur → force un nouvel élément
  // iframe (+ cache-bust via le paramètre ?v=) pour charger la nouvelle version
  // Date.now() évite que Chromium serve index.html depuis son cache lors d'un
  // re-montage du composant (iframeKey=0 identique à la visite précédente = hit cache)
  const [iframeKey, setIframeKey] = useState(() => Date.now())
  const { port: medomicsPort } = useContext(WorkspaceContext)
  const pollingRef = useRef(false) // évite les boucles de poll concurrentes

  // ── Polling /health depuis le main process ──────────────────────────────────
  const startPolling = () => {
    if (pollingRef.current) return // déjà en cours
    pollingRef.current = true
    setServerStatus("starting")
    setLoadAttempts(0)

    let attempt = 0
    const poll = async () => {
      if (!pollingRef.current) return
      const { ok } = await ipcRenderer.invoke("plugin:check-health", STARHE_PORT)
      if (ok) {
        pollingRef.current = false
        setServerStatus("ready")
        return
      }
      attempt++
      setLoadAttempts(attempt)
      // Pas de timeout maximal : on attend que le serveur réponde
      // (le build React + Go peut prendre plusieurs minutes)
      setTimeout(poll, POLL_INTERVAL_MS)
    }

    poll()
  }

  const stopPolling = () => {
    pollingRef.current = false
  }

  // ── Au montage : démarrer le serveur puis lancer le polling ─────────────────
  useEffect(() => {
    ipcRenderer.invoke("plugin:start-server", "starhe").then((result) => {
      if (!result.success) {
        setServerStatus("error")
      } else {
        startPolling()
      }
    })
    return () => stopPolling()
  }, [])

  // ── Réagir aux changements d'état du plugin ─────────────────────────────────
  useEffect(() => {
    const onStateChanged = (_e, state) => {
      const starhe = state?.starhe
      if (!starhe) return

      if (!starhe.serverRunning) {
        // Serveur arrêté (mise à jour ou crash) → lancer le polling
        // Le polling attend indéfiniment → détectera le redémarrage automatiquement
        stopPolling()
        setIframeKey(Date.now()) // invalide le cache dès maintenant
        startPolling()
      } else if (starhe.serverRunning && serverStatus !== "ready") {
        // Serveur (re)démarré alors qu'on n'était pas encore "ready"
        // (ex: mise à jour longue, le polling tournait encore)
        // → s'assurer que le polling est actif
        if (!pollingRef.current) {
          setIframeKey(Date.now())
          startPolling()
        }
      }
    }

    ipcRenderer.on("plugin:state-changed", onStateChanged)
    return () => ipcRenderer.removeListener("plugin:state-changed", onStateChanged)
  }, [serverStatus])

  // ── Rendu ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0c1018" }}>
      {serverStatus !== "ready" && (
        <div className="starhe-loading-overlay">
          <MdLocalHospital style={{ fontSize: "3.5rem", color: "#4fc3f7", marginBottom: "1rem" }} />
          <div className="starhe-loading-title">STARHE</div>
          <div className="starhe-loading-sub">
            {serverStatus === "error"
              ? "Impossible de démarrer le serveur STARHE. Vérifiez l'installation."
              : `Démarrage du serveur (${loadAttempts} tentatives)…`}
          </div>
          {serverStatus === "starting" && (
            <ProgressBar
              mode="indeterminate"
              style={{ width: "220px", height: "4px", marginTop: "1rem" }}
            />
          )}
          {serverStatus === "error" && (
            <button
              className="starhe-retry-btn"
              onClick={() => {
                setIframeKey(Date.now())
                startPolling()
              }}
            >
              Réessayer
            </button>
          )}
        </div>
      )}

      {serverStatus === "ready" && medomicsPort && (
        <iframe
          key={iframeKey}
          src={`http://localhost:${medomicsPort}/starhe/ui/?v=${iframeKey}`}
          style={{ flex: 1, border: "none", width: "100%", height: "100%" }}
          title="STARHE Plugin"
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  )
}

export default StarhePage
