// `own:remote-pcs.*` (08 §4.1) and `own:mobile-preview.*` (08 §4.3) channels, registered with the other own channels
// before the first window (own-shell.ts). Cheap to register: each service (Electron sessions, a proxy, a store) loads
// on its first call. Inputs are checked here, at the IPC boundary, and only own-web's own top frame may call (`check`,
// the shell's sender check).
import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { OwnIpc } from "../../preload/own-api"

export function registerRemotePcIpc(check: (event: IpcMainInvokeEvent) => void) {
  const service = () => import("./service")
  ipcMain.handle(OwnIpc.remotePcsList, async (event) => {
    check(event)
    return (await service()).list()
  })
  ipcMain.handle(OwnIpc.remotePcsPair, async (event, input: unknown) => {
    check(event)
    return (await service()).pair(field(input, "link", 8192))
  })
  ipcMain.handle(OwnIpc.remotePcsPairWait, async (event, input: unknown) => {
    check(event)
    return (await service()).waitPairing(field(input, "pairingId", 64))
  })
  ipcMain.handle(OwnIpc.remotePcsPairCancel, async (event, input: unknown) => {
    check(event)
    ;(await service()).cancelPairing(field(input, "pairingId", 64))
  })
  ipcMain.handle(OwnIpc.remotePcsOpen, async (event, input: unknown) => {
    check(event)
    return (await service()).open(field(input, "pcKey", 64))
  })
  ipcMain.handle(OwnIpc.remotePcsRemove, async (event, input: unknown) => {
    check(event)
    return (await service()).remove(field(input, "pcKey", 64))
  })
}

export function registerMobilePreviewIpc(check: (event: IpcMainInvokeEvent) => void) {
  const preview = () => import("./preview")
  ipcMain.handle(OwnIpc.mobilePreviewStatus, async (event) => {
    check(event)
    return (await preview()).status()
  })
  ipcMain.handle(OwnIpc.mobilePreviewPair, async (event, input: unknown) => {
    check(event)
    return (await preview()).pair(field(input, "link", 8192))
  })
  ipcMain.handle(OwnIpc.mobilePreviewPairWait, async (event, input: unknown) => {
    check(event)
    return (await preview()).waitPairing(field(input, "pairingId", 64))
  })
  ipcMain.handle(OwnIpc.mobilePreviewPairCancel, async (event, input: unknown) => {
    check(event)
    ;(await preview()).cancelPairing(field(input, "pairingId", 64))
  })
  ipcMain.handle(OwnIpc.mobilePreviewOpen, async (event, input: unknown) => {
    check(event)
    const port = record(input).port
    // The app listener's port: anything else opens nothing.
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return false
    return (await preview()).open(port)
  })
  ipcMain.handle(OwnIpc.mobilePreviewRemove, async (event) => {
    check(event)
    return (await preview()).remove()
  })
}

/** A string member of an IPC payload, cut to `max` characters; "" when absent. */
function field(input: unknown, key: string, max: number) {
  const value = record(input)[key]
  return typeof value === "string" ? value.slice(0, max) : ""
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
}
