// Code Mode interrupt on a real server (Codex 0.163.0, #51835, code-mode-tools.ts `Runtimes.interrupt`): a cell yields
// while its nested exec_command still runs, the model waits on it, and the user stops the turn. The stop ends the cell
// an earlier `exec` left running and its nested call, whose process is gone; the next turn finds the cell gone and the
// stored value kept, as Codex's `code_mode_interrupt_terminates_active_cells_and_nested_tools`.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  openAIResponsesProvider,
  opencodeConfig,
  REPO_ROOT,
  sessionInfo,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-6.1-sol" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
// The nested command records its shell's pid, then runs far longer than the test.
const COMMAND =
  process.platform === "win32"
    ? "Set-Content -Path pid.txt -Value $PID; Start-Sleep -Seconds 300"
    : "echo $$ > pid.txt; sleep 300"

type Item = Record<string, any>

let fake: FakeOpenAIResponses
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIResponses({ models: ["gpt-6.1-sol"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { "gpt-6.1-sol": { name: "gpt-6.1-sol" } },
          }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  // Right after a boot the model list can answer 503 while the Location's plugins activate (5 s limit, slow under load).
  const deadline = Date.now() + 60_000
  while (
    !(await server.waitForModels([MODEL]).then(
      () => true,
      (error: unknown) => {
        if (Date.now() > deadline || !String(error).includes("503")) throw error
        return false
      },
    ))
  )
    await Bun.sleep(250)
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

/** Whether a process with this id runs. */
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) return false
    await Bun.sleep(100)
  }
  return true
}

describe("Code Mode interrupt", () => {
  test("a user's stop ends a yielded cell and its nested exec_command process; the store stays", async () => {
    const created = (await server.call("POST", "/api/session", {
      body: { title: "interrupt", model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)
    const pidFile = path.join(server.paths.workspace, "pid.txt")
    fake.enqueue(
      // A completed cell stores a value; the next one yields while its nested exec_command runs.
      { type: "tool-call", name: "exec", input: {}, freeform: 'store("persisted", "preserved")' },
      {
        type: "tool-call",
        name: "exec",
        input: {},
        freeform: [
          '// @exec: {"yield_time_ms": 1000}',
          'text("started")',
          `const result = await tools.exec_command({ cmd: ${JSON.stringify(COMMAND)}, yield_time_ms: 30000 })`,
          "text(result.output)",
        ].join("\n"),
      },
      // The model waits on the cell; the user stops the turn during the wait.
      { type: "tool-call", name: "wait", input: { cell_id: "2", yield_time_ms: 30_000 } },
      // The next turn: the cell is gone, the stored value is not.
      { type: "tool-call", name: "wait", input: { cell_id: "2", yield_time_ms: 1 } },
      { type: "tool-call", name: "exec", input: {}, freeform: 'text(load("persisted"))' },
      { type: "text", text: "Recovered." },
    )
    const before = fake.requests.length
    const posts = () => fake.requests.slice(before).filter((request) => request.method === "POST")
    await server.prompt(sessionID, "Start the long job.")
    // The exec yielded and the wait is running: the third request carries the yielded cell.
    expect(
      await until(
        () =>
          posts().length >= 3 &&
          JSON.stringify(posts()[2]!.json).includes("Script running with cell ID 2") &&
          fs.existsSync(pidFile) &&
          fs.readFileSync(pidFile, "utf8").trim() !== "",
        60_000,
      ),
    ).toBe(true)
    const pid = Number(fs.readFileSync(pidFile, "utf8").replace(/^﻿/, "").trim())
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    expect(alive(pid)).toBe(true)
    await Bun.sleep(500)

    const stopped = (await server.call("POST", `/api/session/${sessionID}/interrupt`)) as {
      readonly interrupted?: boolean
      readonly data?: { readonly interrupted: boolean }
    }
    expect((stopped.data ?? stopped).interrupted).toBe(true)
    await server.waitIdle(sessionID)
    // The nested exec_command was cut off with its cell: its process ends long before its 300 s sleep.
    expect(await until(() => !alive(pid), 20_000)).toBe(true)

    const resumed = posts().length
    await server.prompt(sessionID, "Check the job.")
    await server.waitIdle(sessionID)
    const sent = posts()
      .slice(resumed)
      .map((request) => request.json as { input: Array<Item> })
    expect(sent).toHaveLength(3)
    const waited = sent[1]!.input.findLast((item) => item.type === "function_call_output")!
    expect(JSON.stringify(waited.output)).toContain("exec cell 2 not found")
    const loaded = sent[2]!.input.findLast((item) => item.type === "custom_tool_call_output")!
    expect(JSON.stringify(loaded.output)).toContain("Script completed")
    expect(JSON.stringify(loaded.output)).toContain("preserved")
  }, 240_000)
})
