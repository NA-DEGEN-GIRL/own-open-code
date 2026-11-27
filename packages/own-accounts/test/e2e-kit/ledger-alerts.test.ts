import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ledgerAlerts } from "./index"

const alert = (message: string) =>
  JSON.stringify({
    eid: message,
    ts: 0,
    type: "alert",
    data: { code: "preset_needs_repair", severity: "warning", message },
  })

test("ledgerAlerts skips a half-written last line and fails on a broken complete line", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "own-ledger-alerts-"))
  const file = path.join(home, "ledger", "events-2026-10.jsonl")
  await Bun.write(file, `${alert("first")}\n${alert("second").slice(0, 30)}`)
  const torn = await ledgerAlerts(home, "preset_needs_repair")
  await Bun.write(file, `${alert("first").slice(0, 30)}\n${alert("second")}\n`)
  const broken = await ledgerAlerts(home, "preset_needs_repair").then(
    () => undefined,
    (error: unknown) => error,
  )
  await fs.rm(home, { recursive: true, force: true })

  expect(torn.map((line) => line.message)).toEqual(["first"])
  expect(broken).toBeInstanceOf(SyntaxError)
})
