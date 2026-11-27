// Vendored from packages/desktop/src/main/index.ts @ bd55d4895f (MIT). See own/ledger/vendored.yaml
// own: (1) ./own-env is the first import: env snapshot and shell start time before anything touches process.env
// (05 §5.2); (2) the Windows application menu is cleared (7.7); (3) the own IPC channels exist before the first
// window asks (5.6); (4) the renderer protocol is registered first with the installed version's web (app\current.json,
// followed on every page load) or the fallback page (first-wins, 5.5), and the bundle waits on that handler's served
// requests (renderer-protocol.ts rendererAssetsServed, upstream's code); (5) startSidecarProbe() is gone: the own
// BackgroundService discovers the service itself (5.3);
// (6) upstream modules by package path; (7) right after configureApplication(): the raster switches and the fixed
// toast activator CLSID (own-shell.ts configureOwnApplication, 05 §9.2 R-D13, §7.4); (8) right before the early
// window: its stored background as #rrggbb (own-web's dark default on a first start) and nativeTheme in that tone
// (own-shell.ts prepareWindowAppearance, window-tone.ts). The order of everything else is upstream's. Marked "own:".
import "./own-env"
// Imported first so its evaluation stamps the moment Electron handed control to this module.
import { marks } from "@opencode/desktop/src/main/lifecycle/marks"
import { app } from "electron"
import { acquireApplicationLock, configureApplication } from "@opencode/desktop/src/main/lifecycle/configure"
import { registerStorageSnapshotHandler } from "@opencode/desktop/src/main/storage/snapshot"
import { createEarlyWindow, earlyWindowClosed } from "@opencode/desktop/src/main/windows/early"
import { registerRendererScheme } from "@opencode/desktop/src/main/windows/scheme"
// own: the handler own-shell.ts registers first counts the served requests (upstream's never runs).
import { rendererAssetsServed } from "./renderer-protocol"
import {
  clearApplicationMenu,
  configureOwnApplication,
  prepareWindowAppearance,
  registerOwnIpc,
  registerRenderer,
} from "./own-shell"

// This module stays small on purpose. Electron holds the ready event until the entry module has
// finished, and the first window should be on screen before the rest of the main process — a few
// hundred milliseconds of module evaluation and layers — loads. Configuration and the scheme must
// precede ready; the window is created the moment ready fires; everything else is imported after.
configureApplication()
// own: Chromium switches and the toast activator, which must be set before ready.
configureOwnApplication()
if (acquireApplicationLock()) {
  registerRendererScheme()
  // Window first, then the bundle: starting the import before ready delays ready itself, because the
  // module graph evaluates on the same thread Chromium needs to finish initialising.
  void app.whenReady().then(async () => {
    marks.ready = Date.now()
    registerStorageSnapshotHandler()
    // own: menu, own IPC and the renderer root, all before the first window loads.
    clearApplicationMenu()
    registerOwnIpc()
    registerRenderer()
    // own: the early window opens in own-web's colors (dark by default) with caption buttons to match.
    prepareWindowAppearance()
    createEarlyWindow()
    marks.window = Date.now()
    // The window's renderer is already loading. Its HTML and preloaded chunks are served from this
    // thread, so the bundle waits for that burst to be answered (or a cap) before it evaluates.
    if (!process.env.ELECTRON_RENDERER_URL) await rendererAssetsServed({ quietMs: 40, capMs: 400 })
    marks.served = Date.now()

    // Closing the first window before now quit the app; loading the layers would only start work it interrupts.
    if (earlyWindowClosed()) return

    return import("./desktop")
  })
}
