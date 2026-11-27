// Playwright stops the backend with a hard kill on Windows: ask it to stop first (the stop file), then kill the remote
// services registered under the fake /proc and remove the temp roots the backend recorded.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { readState, STATE_FILE } from "./support"

export default async function teardown() {
  const state = readState()
  if (!state) return
  const stop = path.join(path.dirname(STATE_FILE), "stop")
  fs.writeFileSync(stop, "")
  for (let i = 0; i < 120 && fs.existsSync(STATE_FILE); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  const proc = path.join(state.testRoot, "proc")
  for (const entry of fs.existsSync(proc) ? fs.readdirSync(proc) : [])
    if (/^\d+$/.test(entry)) spawnSync("taskkill", ["/PID", entry, "/T", "/F"], { windowsHide: true, stdio: "ignore" })
  for (const root of [path.dirname(state.testRoot), state.serverRoot])
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  fs.rmSync(STATE_FILE, { force: true })
  fs.rmSync(stop, { force: true })
}
