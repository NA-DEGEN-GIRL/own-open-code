import { createRequire } from "node:module"
import path from "node:path"

/**
 * own-desktop's Electron (`bun run electron:install`), for `electron-vite dev` as ELECTRON_EXEC_PATH: left to itself
 * electron-vite resolves `electron` from its own place in bun's store, which is upstream's version, and stops with
 * `Electron uninstall` in a checkout that never installed that one.
 */
export function electronExe() {
  const electron = path.dirname(createRequire(import.meta.url).resolve("electron/package.json"))
  return path.join(electron, "dist", process.platform === "win32" ? "electron.exe" : "electron")
}
