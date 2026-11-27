// Substitutes packages/desktop/src/main/lifecycle/environment.ts @ 698800f59c (MIT). See own/ledger/vendored.yaml
// Swapped in at build time for every importer (electron.vite.config.ts, 05 §4.3); keeps all five exports.
// own:
//  - prepareDesktop never calls app.setAsDefaultProtocolClient("opencode"): packaged upstream builds claim
//    HKCU\Software\Classes\opencode at runtime, and electron-builder `protocols: []` cannot stop that (G-D2).
//  - preferApplicationEnvironment does nothing: upstream deletes XDG_STATE_HOME on Windows (the launcher honors it,
//    so discovery would diverge) and injects OPENCODE_CLIENT=desktop and two experimental flags meant for a service
//    the shell spawns. The own service is started by the launcher with the launcher's env (01 §5.3).
//  - prepareDesktop does not remove a colliding `Electron.lnk` (upstream's removeCollidingDevShortcut): it repairs
//    upstream's unpackaged runs that shared `ai.opencode.desktop.dev`; own's local and packaged ids never shared one.
//  - Upstream modules by package path. Everything else is upstream's.
import http from "node:http"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { Effect, Path } from "effect"
import { DesktopPaths } from "@opencode/desktop/src/main/paths"
import { registerRendererProtocol, setDockIcon, setProtocolReporter } from "@opencode/desktop/src/main/windows"
import { scoped } from "@opencode/desktop/src/main/native/logging"
import { applySpellcheck, spellcheckMenuItems } from "@opencode/desktop/src/main/native/spellcheck"
import { nativeT } from "@opencode/desktop/src/main/native/translations"

// electron-context-menu attaches to every existing and future window, so it can load once the first
// window is up instead of holding up startup with its dependency tree.
export const installContextMenu = Effect.gen(function* () {
  const { default: contextMenu } = yield* Effect.promise(() => import("electron-context-menu"))
  contextMenu({
    showSaveImageAs: true,
    showLookUpSelection: false,
    showSearchWithGoogle: false,
    // Getters, because electron-context-menu reads the labels each time the menu opens.
    labels: {
      get cut() {
        return nativeT("desktop.menu.cut")
      },
      get copy() {
        return nativeT("desktop.menu.copy")
      },
      get paste() {
        return nativeT("desktop.menu.paste")
      },
      get selectAll() {
        return nativeT("desktop.menu.selectAll")
      },
    },
    append: (_actions, params) => (params.isEditable ? spellcheckMenuItems() : []),
  })
})

export const prepareApplicationEnvironment = Effect.gen(function* () {
  yield* loadSystemCertificates
  yield* loadProxyEnvironment
})

// own: no-op (see header).
export const preferApplicationEnvironment = Effect.void

export const prepareDesktop = Effect.gen(function* () {
  const path = yield* Path.Path
  const paths = yield* DesktopPaths.resolve
  // own: no protocol client registration.
  const runFork = Effect.runForkWith(yield* Effect.context())
  setProtocolReporter((level, message, data) =>
    runFork(scoped("protocol", level === "error" ? Effect.logError(message, data) : Effect.logWarning(message, data))),
  )
  // A no-op for own-desktop: the entry registered the renderer root first (first-wins, 05 §5.5).
  registerRendererProtocol(paths.rendererRoot)
  setDockIcon(path, paths)
  applySpellcheck()
})

export const loadProxyEnvironment = Effect.gen(function* () {
  yield* Effect.try(() => {
    ensureLoopbackNoProxy()
    // SAFETY: Electron 41.2 ships a Node with http.setGlobalProxyFromEnv, which the current @types/node lacks.
    const proxyAwareHttp = http as typeof http & { setGlobalProxyFromEnv(): void }
    proxyAwareHttp.setGlobalProxyFromEnv()
  }).pipe(Effect.catch((error) => Effect.logWarning("failed to load proxy environment", { error })))
})

const loadSystemCertificates = Effect.try({
  try: () => {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  },
  catch: (error) => error,
}).pipe(Effect.catch((error) => Effect.logWarning("failed to load system certificates", { error })))

// Bun reads lowercase `no_proxy` alone whenever it is set, so both spellings get the same merged list.
function ensureLoopbackNoProxy() {
  const noProxy = [
    ...new Set(
      [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1,localhost,::1"].flatMap((value) =>
        (value ?? "").split(",").flatMap((entry) => entry.trim() || []),
      ),
    ),
  ].join(",")

  process.env.NO_PROXY = noProxy
  process.env.no_proxy = noProxy
}
