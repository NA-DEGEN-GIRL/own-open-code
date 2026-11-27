// Playwright hard-kills the backend on Windows: ask it to stop first (the stop file), wait, then clean what is left
// (the fake host's services are detached on purpose, 04 §6.2).
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { readState, remotePids, STATE_DIR, STATE_FILE } from "./support"

export default async function teardown() {
  // A backend started by hand for repeated runs stays up with `OWN_WEB_E2E_KEEP=1`.
  if (process.env.OWN_WEB_E2E_KEEP === "1") return
  const state = readState()
  if (!state) return
  fs.writeFileSync(path.join(STATE_DIR, "stop"), "")
  for (let i = 0; i < 120 && fs.existsSync(STATE_FILE); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  if (state.testRoot)
    for (const pid of remotePids(state.testRoot))
      spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true, stdio: "ignore" })
  for (const root of [state.testRoot ? path.dirname(state.testRoot) : "", state.serverRoot])
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  fs.rmSync(STATE_FILE, { force: true })
  fs.rmSync(path.join(STATE_DIR, "stop"), { force: true })
}
