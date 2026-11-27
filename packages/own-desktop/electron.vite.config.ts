// own-desktop build (05 §4.4): upstream's electron-vite config function, called and overridden, never edited.
//  - main: the vendored entry (src/main/index.ts) plus the substitution plugin (build/overrides.ts) for constants.ts,
//    lifecycle/environment.ts, the GUI plugin host's built-in list, enable state and bundle evaluation (the browser
//    pane alone; no plugin of the service runs its GUI bundle in the shell), the browser pane's attachments (one
//    client per server), ipc-handlers/files.ts (the folder dialog modal to its window, one at a time) and
//    windows/appearance.ts (the kept window zoom); the rest of upstream's main config (Effect bundling, node-pty
//    narrowing, electron-vite's ESM shim switched off since v2.2.5 (Rolldown's own createRequire), externalized
//    runtime deps) is kept. Upstream's config function is async since v2.2 (the beta notes).
//  - preload: the vendored preload (window.own).
//  - main and preload get the rpcHash and shell version as build constants. The hash is recomputed from the contract
//    files here and must equal the committed src/shared/rpc-hash.ts (own-web's desktop host imports that constant)
//    and, when set, env OWN_RPC_HASH (build-own.ps1, 05 §10.1).
//  - OWN_DEV_SHELL "1" only under `electron-vite dev` (src/main/own-env.ts `devShell`): a build drops a runtime
//    ELECTRON_RENDERER_URL before anything reads it (decisions RL5-3).
//  - main bundles only the target's ffi-rs binding (build/ffi-binding.ts; OPENCODE_TARGET, else this PC).
//  - OWN_DESKTOP_CLIENT_ONLY=1 (own/scripts/build-desktop-client.ps1): the 원격 PC 전용 build. main gets
//    OWN_CLIENT_ONLY="1" (src/main/client-only.ts) and the renderer is the remote-client page (src/client) in place of
//    the fallback page, in the same out/renderer folder. Unset, everything is as before (OWN_CLIENT_ONLY "").
//  - renderer: only the fallback page in a build. No renderer while serving: electron-vite would start its own dev
//    server and overwrite ELECTRON_RENDERER_URL, hiding own-web's Vite server (05 §4.4, 11.2).
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "electron-vite"
import upstream from "../desktop/electron.vite.config.ts"
import { previewBinding } from "../desktop/script/preview-binding.ts"
import { getCurrentCli } from "../desktop/script/utils.ts"
import { ffiBinding } from "./build/ffi-binding.ts"
import { ownOverrides } from "./build/overrides.ts"
import { committedRpcHash, rpcHash } from "./scripts/rpc-hash.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ONLY = process.env.OWN_DESKTOP_CLIENT_ONLY === "1"
/** The page the shell's own renderer root serves: the fallback page, or the remote-client page in a client build. */
const rendererPage = path.join(here, CLIENT_ONLY ? "src/client" : "src/fallback")
const desktop = path.resolve(here, "../desktop")
const guiPlugins = path.resolve(here, "../gui-plugins")

/** Upstream module → own replacement (own/ledger/vendored.yaml, kind "substitute"). */
export const OVERRIDES: Readonly<Record<string, string>> = {
  [path.join(desktop, "src/main/constants.ts")]: path.join(here, "src/overrides/constants.ts"),
  [path.join(desktop, "src/main/lifecycle/environment.ts")]: path.join(here, "src/overrides/environment.ts"),
  // 05 §8.1: the browser pane is the only GUI plugin; a service plugin's `./gui-experimental` bundle never runs here.
  [path.join(guiPlugins, "src/main.ts")]: path.join(here, "src/overrides/gui-plugins.ts"),
  [path.join(guiPlugins, "src/browser/pane.ts")]: path.join(here, "src/overrides/browser-pane.ts"),
  [path.join(desktop, "src/main/plugin/manager.ts")]: path.join(here, "src/overrides/plugin-manager.ts"),
  [path.join(desktop, "src/main/plugin/module.ts")]: path.join(here, "src/overrides/plugin-module.ts"),
  // 03 §18.3: the folder dialog modal to the asking window, one per window (`폴더 열기…` single flight).
  [path.join(desktop, "src/main/ipc-handlers/files.ts")]: path.join(here, "src/overrides/ipc-files.ts"),
  // 05 §7.9: every window starts at this PC's kept zoom, and Ctrl+wheel steps it, instead of a reset to 100 %.
  [path.join(desktop, "src/main/windows/appearance.ts")]: path.join(here, "src/overrides/appearance.ts"),
}

function shellConstants(command: string) {
  const hash = rpcHash({ expect: process.env.OWN_RPC_HASH || undefined })
  const committed = committedRpcHash()
  if (committed !== hash)
    throw new Error(
      `own-desktop: src/shared/rpc-hash.ts (${committed ?? "missing"}) does not match the IPC contract (${hash}). ` +
        "Run `bun run rpc-hash --write` and rebuild own-web too (05 §5.5).",
    )
  const version: string =
    process.env.OWN_VERSION || JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).version || "0.0.0-local"
  return {
    "import.meta.env.OWN_RPC_HASH": JSON.stringify(hash),
    "import.meta.env.OWN_SHELL_VERSION": JSON.stringify(version),
    "import.meta.env.OWN_CLIENT_ONLY": JSON.stringify(CLIENT_ONLY ? "1" : ""),
    "import.meta.env.OWN_DEV_SHELL": JSON.stringify(command === "serve" ? "1" : ""),
  }
}

export default defineConfig(async (env) => {
  const base = await upstream(env)
  const constants = shellConstants(env.command)
  const target = getCurrentCli()
  return {
    ...base,
    main: {
      ...base.main,
      plugins: [
        ownOverrides(OVERRIDES),
        ffiBinding(previewBinding(target.os, target.cpu)),
        ...(base.main?.plugins ?? []),
      ],
      define: { ...base.main?.define, ...constants },
      build: {
        ...base.main?.build,
        rolldownOptions: {
          ...base.main?.build?.rolldownOptions,
          input: { index: path.join(here, "src/main/index.ts") },
        },
      },
    },
    preload: {
      ...base.preload,
      define: { ...base.preload?.define, ...constants },
      build: {
        ...base.preload?.build,
        rolldownOptions: {
          ...base.preload?.build?.rolldownOptions,
          input: { index: path.join(here, "src/preload/index.ts") },
        },
      },
    },
    renderer:
      env.command === "serve"
        ? undefined
        : {
            root: rendererPage,
            build: {
              outDir: path.join(here, "out/renderer"),
              emptyOutDir: true,
              minify: true,
              sourcemap: false,
              rolldownOptions: { input: { main: path.join(rendererPage, "index.html") } },
            },
          },
  }
})
