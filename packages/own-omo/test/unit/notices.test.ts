// omo's toasts in own's log (15 §3.4): `info` lines of `<OWN_HOME>/logs/own-omo.log`; a `Skill load error` for a
// skill folder that does not exist is left out; a full log moves to `.1` first.
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Runtime } from "../../src/runtime.js"

async function until(probe: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

test("omo's notices are info lines of own's log, without missing skill folders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-omo-notices-"))
  try {
    const file = Runtime.paths(root).notices
    expect(file).toBe(path.join(root, "logs", "own-omo.log"))
    Runtime.toast(file, {
      title: "Skill load error",
      message: `Failed to load skill C:\\own\\config\\skills: ENOENT: no such file or directory, realpath 'C:\\own\\config\\skills'`,
      variant: "warning",
    })
    Runtime.toast(file, { title: "Todo Continuation", message: "Resuming in 2s... (2 tasks remaining)", variant: "warning" })
    await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("\n"))
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toEqual([
      {
        ts: expect.any(Number),
        level: "info",
        scope: "own.omo",
        msg: "omo notice",
        title: "Todo Continuation",
        message: "Resuming in 2s... (2 tasks remaining)",
        variant: "warning",
      },
    ])
    fs.writeFileSync(file, Buffer.alloc(Runtime.NOTICE_LOG_MAX_BYTES))
    Runtime.toast(file, { title: "Ultrawork Mode Activated", message: "All agents at your disposal.", variant: "success" })
    await until(() => fs.existsSync(`${file}.1`) && fs.existsSync(file) && fs.statSync(file).size > 0)
    expect(fs.statSync(`${file}.1`).size).toBe(Runtime.NOTICE_LOG_MAX_BYTES)
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ title: "Ultrawork Mode Activated" })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
