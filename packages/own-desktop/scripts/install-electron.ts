// Puts the Electron binary into node_modules/electron/dist (05 §11.1): electron's own installer, which downloads
// through @electron/get unless the zip is already in the cache. Point ELECTRON_CACHE (or electron_config_cache) at a
// folder that holds electron-v44.10.2-win32-x64.zip to reuse it instead of downloading ~151 MB.
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const electron = path.dirname(require.resolve("electron/package.json"))
const cache = process.env.electron_config_cache || process.env.ELECTRON_CACHE
const child = Bun.spawn([process.execPath, path.join(electron, "install.js")], {
  cwd: electron,
  env: { ...process.env, ...(cache ? { electron_config_cache: cache } : {}) },
  stdout: "inherit",
  stderr: "inherit",
})
const code = await child.exited
const exe = path.join(electron, "dist", process.platform === "win32" ? "electron.exe" : "electron")
if (code !== 0 || !existsSync(exe)) {
  console.error(`own-desktop: Electron install failed (exit ${code})`)
  process.exit(code || 1)
}
console.log(`own-desktop: Electron ready at ${exe}${cache ? ` (cache ${cache})` : ""}`)
