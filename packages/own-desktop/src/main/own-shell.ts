// What the vendored entry adds before the first window (05 §5.5, §5.6, §7.7). Kept to cheap, synchronous work (R-D1):
// one small manifest read, one existence check, the protocol registration, the menu, IPC channel registration whose
// service handlers load on first use, and the window's starting background and tone (a settings store read, written
// back only on a first start or for an older build's value).
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { app, ipcMain, Menu, nativeTheme, type IpcMainInvokeEvent } from "electron"
import { BACKGROUND_COLOR_KEY } from "@opencode/desktop/src/main/storage/keys"
import { getStore } from "@opencode/desktop/src/main/storage/store"
import { isRendererUrl } from "@opencode/desktop/src/main/windows/scheme"
import { OwnIpc, type OwnRendererSource, type OwnShellInfo } from "../preload/own-api"
import { TOAST_ACTIVATOR_CLSID, TOAST_ACTIVATOR_CLSID_LOCAL } from "../shared/identity"
import { clientOnly } from "./client-only"
import { debuggingPort } from "./debug-port"
import { readManifestSync } from "./manifest"
import { ownPaths, shellStartedAt } from "./own-env"
import { rasterSwitches } from "./raster"
import { registerMobilePreviewIpc, registerRemotePcIpc } from "./remote-pcs/ipc"
import { registerRendererRoot } from "./renderer-protocol"
import { clientRenderer, movedRoot, selectRenderer } from "./renderer-root"
import { initialAppearance } from "./window-tone"
import { prepareEarlyZoom, setZoom, stepWindowZoom, zoomFactor } from "./zoom"

let renderer: OwnRendererSource | undefined

/**
 * Before ready, right after upstream's configureApplication() (which sets the AUMID): the raster switches and the
 * fixed toast activator CLSID (src/shared/identity.ts, removed again by build/installer.nsh on uninstall).
 */
export function configureOwnApplication() {
  for (const [name, value] of rasterSwitches()) app.commandLine.appendSwitch(name, value)
  // Since v2.4 upstream's configureApplication removes every remote-debugging switch from a packaged release build:
  // the browser pane keeps sign-ins in the profile, and a debugging port reads them all. A run that moved the whole
  // profile to a test root (OPENCODE_DESKTOP_TEST_ROOT) gets its port back, on loopback only: nothing of the person's
  // own profile is there to read. Packaged-shell checks that drive the shell through CDP need to set it.
  const port = process.env.OPENCODE_DESKTOP_TEST_ROOT ? debuggingPort(process.argv) : undefined
  if (port) {
    app.commandLine.appendSwitch("remote-debugging-port", port)
    app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1")
  }
  // Automated runs of the development shell (scripts/tray-quit.ts) pass their own pid: every window starts off the
  // screen and the taskbar (`_init` emits this before the window is first shown), and the shell exits when the run's
  // process is gone, so a stopped run never leaves a window or a tray icon behind. Never in a packaged build.
  const run = Number(process.env.OWN_DESKTOP_TEST_RUN)
  if (!app.isPackaged && Number.isInteger(run) && run > 0) {
    app.on("browser-window-created", (_event, win) => {
      win.setPosition(-32000, -32000)
      win.setSkipTaskbar(true)
    })
    setInterval(() => {
      try {
        process.kill(run, 0)
      } catch {
        app.exit(0)
      }
    }, 2_000).unref()
  }
  if (process.platform !== "win32") return
  try {
    app.setToastActivatorCLSID(app.isPackaged ? TOAST_ACTIVATOR_CLSID : TOAST_ACTIVATOR_CLSID_LOCAL)
  } catch {
    // An Electron without it keeps its random per-run CLSID; notifications still work while the app runs.
  }
}

/**
 * Registers `oc://renderer` before upstream does (first-wins, `windows/protocol.ts` `isProtocolHandled`): upstream's
 * own registrations in `createEarlyWindow` and `prepareDesktop` become no-ops, and renderer-protocol.ts (upstream's
 * handler with a root per request: path containment, asset-served tracking for the main-bundle delay) serves our
 * root. The installed UI's root follows app\current.json on every page load (a window reloaded after
 * own update/rollback gets the new version's web, 01 §5.5 step 7).
 */
export function registerRenderer() {
  const paths = ownPaths()
  // The client build's choice is folded away in the full build, which keeps its bundle byte for byte.
  const choice = clientOnly
    ? clientRenderer(path.join(path.dirname(fileURLToPath(import.meta.url)), "../renderer"))
    : selectRenderer({
        devUrl: process.env.ELECTRON_RENDERER_URL,
        manifest: readManifestSync(paths.manifest),
        webIndexExists: existsSync(path.join(paths.web, "index.html")),
        webRoot: paths.web,
        fallbackRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../renderer"),
        rpcHash: import.meta.env.OWN_RPC_HASH,
      })
  renderer = choice.source
  let root = choice.root
  registerRendererRoot((document) => {
    if (!document || !renderer) return root
    const next = ownPaths()
    const moved = movedRoot({
      source: renderer,
      current: root,
      installedWeb: next.web,
      webIndexExists: (dir) => existsSync(path.join(dir, "index.html")),
    })
    if (moved) {
      root = moved
      renderer = { source: "installed", root, uiVersion: readManifestSync(next.manifest)?.version }
    }
    return root
  })
  return choice
}

/**
 * Right before the early window (window-tone.ts): the stored window background as `#rrggbb` (own-web's dark default
 * on a first start, an older build's `#rrggbbaa` cut to six digits) and nativeTheme in its tone, so upstream's
 * createEarlyWindow (storedBackgroundColor(), platformFrame(tone(), …)) opens in own-web's colors with caption buttons
 * that contrast with them. own-web's first themed paint reports its own background and scheme and takes over.
 */
export function prepareWindowAppearance() {
  const store = getStore()
  const initial = initialAppearance(store.get(BACKGROUND_COLOR_KEY))
  if (initial.write) {
    try {
      store.set(BACKGROUND_COLOR_KEY, initial.write)
    } catch {
      // The store takes the value in memory before it writes the file, so the early window still gets it.
    }
  }
  // Like upstream's setTitlebar: the native window controls follow nativeTheme on Windows and macOS only.
  if (process.platform === "win32" || process.platform === "darwin") nativeTheme.themeSource = initial.tone
  // The early window starts at upstream's saved level (v2.2): this PC's kept zoom where upstream has that level.
  prepareEarlyZoom()
  return initial
}

export function rendererSource() {
  return renderer
}

/**
 * 05 §7.7: Windows keeps Electron's default application menu (upstream `createMenu` returns early off macOS), whose
 * role accelerators close (Ctrl+W), reload (Ctrl+R), zoom outside `window.zoom` and open devtools even packaged.
 * Packaged builds get no menu; development builds keep only Ctrl+Shift+I.
 */
export function clearApplicationMenu() {
  if (process.platform !== "win32") return
  if (app.isPackaged) return Menu.setApplicationMenu(null)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Developer", submenu: [{ role: "toggleDevTools", accelerator: "Ctrl+Shift+I" }] },
    ]),
  )
}

/** The renderer's own top frame only (05 §5.6): browser-pane tabs have another partition and no preload anyway. */
function fromRenderer(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null || !isRendererUrl(frame.url)) throw new Error("own IPC: not the renderer")
}

export function shellInfo(): OwnShellInfo {
  const paths = ownPaths()
  return {
    startedAt: shellStartedAt,
    controlDir: paths.control,
    renderer: renderer ?? { source: "fallback", reason: "missing" },
    channel: paths.channel,
  }
}

export function registerOwnIpc() {
  ipcMain.handle(OwnIpc.shellInfo, (event) => {
    fromRenderer(event)
    return shellInfo()
  })
  ipcMain.handle(OwnIpc.serviceStatus, async (event) => {
    fromRenderer(event)
    return (await import("./own-ipc")).serviceStatus()
  })
  // 5.5 mismatch screens (own-web's and the fallback page): the only calls they make, so the contract stays tiny.
  ipcMain.handle(OwnIpc.openLogs, async (event) => {
    fromRenderer(event)
    return (await import("./own-ipc")).openLogs()
  })
  // The client build has no service of this PC to restart or open in a browser (client-only.ts): its page never asks,
  // and nothing it loads can reach the launcher through these (decisions RL5-2).
  if (!clientOnly) {
    ipcMain.handle(OwnIpc.serviceRestart, async (event, input: unknown) => {
      fromRenderer(event)
      return (await import("./own-ipc")).serviceRestart(input)
    })
    ipcMain.handle(OwnIpc.openInBrowser, async (event) => {
      fromRenderer(event)
      return (await import("./own-ipc")).openInBrowser()
    })
  }
  // 08 §4.1 원격 PC and §4.3 모바일 미리보기: each service loads on its first call.
  registerRemotePcIpc(fromRenderer)
  registerMobilePreviewIpc(fromRenderer)
  // 7.9: this PC's window zoom (zoom.ts clamps whatever comes in).
  ipcMain.handle(OwnIpc.zoomGet, (event) => {
    fromRenderer(event)
    return zoomFactor()
  })
  ipcMain.handle(OwnIpc.zoomSet, (event, input: unknown) => {
    fromRenderer(event)
    return setZoom(member(input, "factor"))
  })
  ipcMain.handle(OwnIpc.zoomStep, (event, input: unknown) => {
    fromRenderer(event)
    const direction = member(input, "direction")
    return direction === "in" || direction === "out" ? stepWindowZoom(direction) : zoomFactor()
  })
  // 05 §7.3: 앱 종료, 완전 종료 (main asks first) and what the last window's X does.
  ipcMain.handle(OwnIpc.appQuit, async (event, input: unknown) => {
    fromRenderer(event)
    return (await import("./quit")).quitFromRenderer(event.sender, input)
  })
  ipcMain.handle(OwnIpc.appCloseAction, async (event, input: unknown) => {
    fromRenderer(event)
    return (await import("./quit")).closeActionFromRenderer(input)
  })
}

function member(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined
}
