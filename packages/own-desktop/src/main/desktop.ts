// Vendored from packages/desktop/src/main/desktop.ts @ 79349e840f (MIT). See own/ledger/vendored.yaml
// own: BackgroundService and DesktopCli layers are the own implementations (05 §5.3, §5.4); the renderer windows get
// the close confirmation (7.2) and the manifest re-check on navigation (5.5); browser-pane downloads get the user's
// side (8.4, own-browser.ts) and the bridge that shows a pane on a paired device (8.10, remote-browser.ts); upstream
// modules by package path. The GUI plugins upstream starts here are own's list
// (src/overrides/gui-plugins.ts: the browser pane alone; no updater, SSH, WSL or pairing), and no plugin of the
// service runs its GUI bundle (src/overrides/plugin-module.ts, plugin-manager.ts), 05 §8.1; the tray icon comes with
// the crash reporter, after the first paint (7.3, quit.ts). The layer order and everything else is upstream's.
// Marked "own:".
import { NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node"
import { app } from "electron"
import { Effect, Layer } from "effect"
import { Plugins } from "@opencode/desktop/src/main/plugin"
import { Ipc } from "@opencode/desktop/src/main/ipc"
import { DesktopInitialization } from "@opencode/desktop/src/main/lifecycle/desktop-initialization"
import { installContextMenu } from "@opencode/desktop/src/main/lifecycle/environment"
import { ApplicationLifecycle } from "@opencode/desktop/src/main/lifecycle"
import { DesktopLogging } from "@opencode/desktop/src/main/native/logging"
import { marks } from "@opencode/desktop/src/main/lifecycle/marks"
import { BackgroundServiceOwn } from "./service/background-service-own"
import { DesktopCliOwn } from "./service/desktop-cli-own"
import { wireBrowserDownloads, wireBrowserViews, wireRemoteBrowser } from "./own-browser"
import { wireTray } from "./quit"
import { wireRendererWindows } from "./windows-own"

// Everything above has been loaded and evaluated by now; the layers start below.
marks.bundle = Date.now()

const runIpc = Effect.fn("Desktop.runIpc")(function* () {
  const lifecycle = yield* ApplicationLifecycle.Service
  const plugins = yield* Plugins.Service
  marks.layers = Date.now()
  yield* Effect.logInfo("layers ready", { marks })
  // own: the user's side of browser-pane downloads (05 §8.4), hooked before any pane can register.
  yield* Effect.acquireRelease(Effect.sync(wireBrowserDownloads), (dispose) => Effect.sync(dispose))
  // own: pane views report focus and hand the pane chords to their window (03 §4.1.1 split panes).
  yield* Effect.acquireRelease(Effect.sync(wireBrowserViews), (dispose) => Effect.sync(dispose))
  // own: the bridge to paired devices (05 §8.10): it polls the service's hub whether or not a pane exists yet.
  yield* Effect.acquireRelease(Effect.sync(wireRemoteBrowser), (dispose) => Effect.sync(dispose))
  const ipc = yield* Ipc.registerIpcHandlers
  // Main GUI plugins start with the window: servers they restore feed the first paint's server
  // list, and menu items they contribute are present at startup. Their heavy modules load lazily on
  // first use.
  // own: the built-in list is the browser pane alone (src/overrides/gui-plugins.ts). Its main entry only provides
  // the `browser.pane` Ipc; the pane module (CDP driver, RPC client) loads when own-web first registers a session.
  yield* Effect.forkScoped(plugins.start)
  // own: close confirmation and manifest re-check for every renderer window, including the adopted early one.
  yield* wireRendererWindows
  if (lifecycle.restoreWindows().length) ipc.installMenu()
  // The first window's renderer now has its IPC port and is hydrating its stores over it. The crash
  // reporter (spawns a process) and the context menu (a dependency tree) are not worth answering late.
  yield* Effect.sleep("500 millis")
  const logging = yield* DesktopLogging.Service
  yield* logging.startCrashReporter
  yield* installContextMenu
  // own: the tray icon (05 §7.3) after the first paint; it opens, or makes, an app window and holds the quit menu.
  yield* Effect.acquireRelease(
    Effect.sync(() => wireTray(lifecycle.createWindow)),
    (dispose) => Effect.sync(dispose),
  )
  yield* Effect.callback<void>((resume) => {
    const quit = () => resume(Effect.void)
    app.once("will-quit", quit)
    return Effect.sync(() => app.off("will-quit", quit))
  })
})

runIpc().pipe(
  Effect.provide(Ipc.layer),
  // own: discover + launcher delegation instead of Service.ensure; the installed release's CLI instead of a copy.
  Effect.provide(BackgroundServiceOwn.layer),
  Effect.provide(DesktopCliOwn.layer),
  Effect.provide(DesktopInitialization.layer),
  Effect.provide(ApplicationLifecycle.layer),
  Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
  Effect.scoped,
  NodeRuntime.runMain,
)
