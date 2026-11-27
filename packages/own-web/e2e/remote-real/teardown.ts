// Playwright stops the backend with a hard kill on Windows: ask it to stop through the stop file first (it disconnects
// the host, stops this PC's service, the fakes and the helper ssh), and wait until it is gone.
import fs from "node:fs"
import path from "node:path"
import { readState, STATE_FILE } from "./support"

export default async function teardown() {
  if (!readState()) return
  const stop = path.join(path.dirname(STATE_FILE), "stop")
  fs.writeFileSync(stop, "")
  for (let i = 0; i < 120 && fs.existsSync(STATE_FILE); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  fs.rmSync(STATE_FILE, { force: true })
  fs.rmSync(stop, { force: true })
}
