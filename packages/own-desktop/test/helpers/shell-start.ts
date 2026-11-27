// The shell's start as the main entry runs it (src/main/index.ts: ./own-env first, then the own IPC), with Electron
// stubbed: test/shell-start.test.ts runs this in a process of its own, so the stub never reaches another test. The
// build constants come from the environment here (Bun's import.meta.env): OWN_CLIENT_ONLY and OWN_DEV_SHELL. Prints
// one JSON line: the IPC channels registered, ELECTRON_RENDERER_URL after own-env, and what upstream's window code
// does with a page of that origin.
import { plugin } from "bun"

const channels: string[] = []
const loaded: string[] = []
plugin({
  name: "electron-stub",
  setup(build) {
    build.module("electron", () => {
      const ipcMain = { handle: (channel: string) => channels.push(channel), on() {}, removeHandler() {} }
      const app = { isPackaged: false, getPath: () => process.env.TEMP ?? ".", on() {}, whenReady: () => new Promise(() => {}) }
      const exports = { ipcMain, app, Menu: {}, nativeTheme: {}, protocol: {}, net: {}, shell: {} }
      return { loader: "object", exports: { ...exports, default: exports } }
    })
  },
})

const url = process.env.ELECTRON_RENDERER_URL
await import("../../src/main/own-env")
const scheme = await import("@opencode/desktop/src/main/windows/scheme")
const shell = await import("../../src/main/own-shell")
shell.registerOwnIpc()
scheme.loadWindow({ loadURL: async (target: string) => void loaded.push(target) } as never, "index.html")
console.log(
  JSON.stringify({
    channels,
    rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
    trusted: url ? scheme.isRendererUrl(new URL("/index.html", url).toString()) : false,
    loaded,
  }),
)
