// Vendored from packages/desktop/src/preload/index.ts @ 79349e840f (MIT). See own/ledger/vendored.yaml
// own: `window.own` (05 §5.6, plus 8.4 downloads, the 7.2 close guard, the 5.5 mismatch-screen support calls, the
// 08 §4.1 원격 PC calls, the 08 §4.3 모바일 미리보기 calls, the 7.9 window zoom and the 7.3 quit calls) next to the
// unchanged `window.electron`; the IPC port is handed over when the page asks for it (own-web loads the IPC client lazily);
// shared imports by package path. Still minimal (R-D2): electron only, no synchronous IPC, the shell info is asked
// once before the page runs like the storage snapshot. Marked "own:".
import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  DragCancelEvent,
  IpcTransportPort,
  WindowSnapshotChannel,
  storageSnapshotNames,
  type WindowSnapshot,
} from "@opencode/desktop/src/shared/ipc-transport"
import { windowBootstrapFromArguments } from "@opencode/desktop/src/shared/window-bootstrap"
import {
  OwnIpc,
  type OwnBrowserDownload,
  type OwnBrowserViewBounds,
  type OwnBrowserViewKey,
  type OwnMobilePreview,
  type OwnRemotePc,
  type OwnShellApi,
  type OwnShellInfo,
} from "./own-api"

// own: main's MessagePort is handed to the page when the page asks (OwnIpc.portRequest), not on arrival: own-web
// loads upstream's IPC client lazily and would miss a port posted before it listens. Main posts a new port on every
// load, and each document gets a fresh preload, so one pending port and one request flag are enough.
let pendingPort: MessagePort | undefined
let portRequested = false
const deliverPort = () => {
  if (!pendingPort || !portRequested) return
  const port = pendingPort
  pendingPort = undefined
  window.postMessage(IpcTransportPort, "*", [port])
}
ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]
  if (!port) return
  pendingPort = port
  deliverPort()
})
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== OwnIpc.portRequest) return
  portRequested = true
  deliverPort()
})

ipcRenderer.on(DragCancelEvent, () => window.dispatchEvent(new Event(DragCancelEvent)))

const bootstrap = windowBootstrapFromArguments(process.argv)
// Asked before the page runs, so the stores the shell reads are hydrated on the first render.
const snapshot: Promise<WindowSnapshot> = ipcRenderer
  .invoke(WindowSnapshotChannel, storageSnapshotNames(bootstrap.id))
  .catch(() => ({ storage: {} }))

contextBridge.exposeInMainWorld("electron", {
  windowID: bootstrap.id,
  bootstrap,
  storageSnapshot: snapshot.then((snapshot) => snapshot.storage),
  plugins: snapshot.then((snapshot) => snapshot.plugins),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
})

// own: the shell half of the desktop OwnHost. Main answers only the renderer's own top frame (own-ipc.ts).
const info: Promise<OwnShellInfo> = ipcRenderer.invoke(OwnIpc.shellInfo)
info.catch(() => undefined)
contextBridge.exposeInMainWorld("own", {
  shell: {
    rpcHash: import.meta.env.OWN_RPC_HASH,
    version: import.meta.env.OWN_SHELL_VERSION,
    startedAt: info.then((value) => value.startedAt),
    controlDir: info.then((value) => value.controlDir),
    renderer: info.then((value) => value.renderer),
  },
  service: {
    status: () => ipcRenderer.invoke(OwnIpc.serviceStatus),
    restart: (input) =>
      ipcRenderer.invoke(OwnIpc.serviceRestart, {
        force: input?.force === true,
        claudeConfigDir: typeof input?.claudeConfigDir === "string" ? input.claudeConfigDir : undefined,
      }),
  },
  // Browser-pane downloads of this window (05 §8.4): main sends only its own window's, without file paths.
  browser: {
    onDownload(listener) {
      const handler = (_event: Electron.IpcRendererEvent, download: OwnBrowserDownload) => listener(download)
      ipcRenderer.on(OwnIpc.browserDownload, handler)
      return () => void ipcRenderer.off(OwnIpc.browserDownload, handler)
    },
    saveDownload: (id) => ipcRenderer.invoke(OwnIpc.browserSaveDownload, { id: typeof id === "string" ? id : "" }),
    guardClose: (on) => ipcRenderer.send(OwnIpc.browserCloseGuard, on === true),
    // 03 §4.1.1 split panes: which pane view the user clicked into, and the pane chords typed there.
    onViewFocus(listener) {
      const handler = (_event: Electron.IpcRendererEvent, bounds: OwnBrowserViewBounds) => listener(bounds)
      ipcRenderer.on(OwnIpc.browserViewFocus, handler)
      return () => void ipcRenderer.off(OwnIpc.browserViewFocus, handler)
    },
    onViewKey(listener) {
      const handler = (_event: Electron.IpcRendererEvent, key: OwnBrowserViewKey) => listener(key)
      ipcRenderer.on(OwnIpc.browserViewKey, handler)
      return () => void ipcRenderer.off(OwnIpc.browserViewKey, handler)
    },
  },
  // The 5.5 mismatch screens' [로그 폴더] and [브라우저로 열기] (own-web's and the fallback page).
  support: {
    openLogs: () => ipcRenderer.invoke(OwnIpc.openLogs),
    openInBrowser: () => ipcRenderer.invoke(OwnIpc.openInBrowser),
  },
  // own: 원격 PC (08 §4.1): main keeps pins, routes and device tokens; the page sees names and states.
  remotePcs: {
    list: () => ipcRenderer.invoke(OwnIpc.remotePcsList),
    pair: (link) => ipcRenderer.invoke(OwnIpc.remotePcsPair, { link: typeof link === "string" ? link : "" }),
    waitPairing: (pairingId) =>
      ipcRenderer.invoke(OwnIpc.remotePcsPairWait, { pairingId: typeof pairingId === "string" ? pairingId : "" }),
    cancelPairing: (pairingId) =>
      ipcRenderer.invoke(OwnIpc.remotePcsPairCancel, { pairingId: typeof pairingId === "string" ? pairingId : "" }),
    open: (pcKey) => ipcRenderer.invoke(OwnIpc.remotePcsOpen, { pcKey: typeof pcKey === "string" ? pcKey : "" }),
    remove: (pcKey) => ipcRenderer.invoke(OwnIpc.remotePcsRemove, { pcKey: typeof pcKey === "string" ? pcKey : "" }),
    onChange(listener) {
      const handler = (_event: Electron.IpcRendererEvent, pcs: readonly OwnRemotePc[]) => listener(pcs)
      ipcRenderer.on(OwnIpc.remotePcsChanged, handler)
      return () => void ipcRenderer.off(OwnIpc.remotePcsChanged, handler)
    },
  },
  // own: 모바일 미리보기 (08 §4.3): main keeps the pairing link, the token and the route; the page sees the state.
  mobilePreview: {
    status: () => ipcRenderer.invoke(OwnIpc.mobilePreviewStatus),
    pair: (link) => ipcRenderer.invoke(OwnIpc.mobilePreviewPair, { link: typeof link === "string" ? link : "" }),
    waitPairing: (pairingId) =>
      ipcRenderer.invoke(OwnIpc.mobilePreviewPairWait, { pairingId: typeof pairingId === "string" ? pairingId : "" }),
    cancelPairing: (pairingId) =>
      ipcRenderer.invoke(OwnIpc.mobilePreviewPairCancel, { pairingId: typeof pairingId === "string" ? pairingId : "" }),
    open: (input) => ipcRenderer.invoke(OwnIpc.mobilePreviewOpen, { port: input?.port }),
    remove: () => ipcRenderer.invoke(OwnIpc.mobilePreviewRemove),
    onChange(listener) {
      const handler = (_event: Electron.IpcRendererEvent, preview: OwnMobilePreview) => listener(preview)
      ipcRenderer.on(OwnIpc.mobilePreviewChanged, handler)
      return () => void ipcRenderer.off(OwnIpc.mobilePreviewChanged, handler)
    },
  },
  // own: this PC's window zoom (05 §7.9): main keeps one factor for every own-web window and announces each change.
  zoom: {
    get: () => ipcRenderer.invoke(OwnIpc.zoomGet),
    set: (factor) => ipcRenderer.invoke(OwnIpc.zoomSet, { factor }),
    step: (direction) => ipcRenderer.invoke(OwnIpc.zoomStep, { direction: direction === "out" ? "out" : "in" }),
    onChange(listener) {
      const handler = (_event: Electron.IpcRendererEvent, factor: number) => listener(factor)
      ipcRenderer.on(OwnIpc.zoomChanged, handler)
      return () => void ipcRenderer.off(OwnIpc.zoomChanged, handler)
    },
  },
  // own: 05 §7.3 앱 종료 / 완전 종료 (main asks first) and what the last window's X does.
  app: {
    quit: (mode) => ipcRenderer.invoke(OwnIpc.appQuit, { mode: mode === "all" ? "all" : "app" }),
    closeAction: () => ipcRenderer.invoke(OwnIpc.appCloseAction, {}),
    setCloseAction: (action) =>
      ipcRenderer.invoke(OwnIpc.appCloseAction, { action: action === "quit" ? "quit" : "tray" }),
  },
} satisfies OwnShellApi)
