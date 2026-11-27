// Playwright hard-kills the web server on Windows, so the backend's own cleanup never runs: ask it to stop first (the
// stop file), wait for it, then remove what is left (the fake home, the state file, the team harness's temp root).
import fs from "node:fs"
import path from "node:path"
import { HOME, NAME, STATE_FILE, STOP_FILE, TOOLS_TMP } from "./paths"

export default async function teardown() {
  // A backend started by hand for repeated runs stays up.
  if (process.env.OWN_WEB_TOOLS_E2E_REUSE === "1") return
  if (fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STOP_FILE, "")
    for (let i = 0; i < 120 && fs.existsSync(STATE_FILE); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const left = fs.existsSync(TOOLS_TMP)
    ? fs
        .readdirSync(TOOLS_TMP, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(`own-team-e2e-${NAME}-`))
        .map((entry) => path.join(TOOLS_TMP, entry.name))
    : []
  for (const folder of [HOME, ...left])
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  for (const file of [STATE_FILE, STOP_FILE]) fs.rmSync(file, { force: true })
}
