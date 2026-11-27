// Code Mode's `notify(...)` on a real server (code-mode-tools.ts): the text is admitted while `exec` runs and reaches
// the next request as one more `custom_tool_call_output` of that `exec` call, after its own output, as Codex injects it
// (core/src/tools/code_mode/delegate.rs `notify`). The `exec` output itself no longer carries it.
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

describe("Code Mode notify", () => {
  test("the next request carries the notify text as another output of the exec call", async () => {
    const created = (await server.call("POST", "/api/session", {
      body: { title: "notify", model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)
    fake.enqueue(
      { type: "tool-call", name: "exec", input: {}, freeform: 'notify("half way there");\ntext("done");' },
      { type: "text", text: "Done." },
    )
    const before = fake.requests.length
    await server.prompt(sessionID, "Run the script.")
    await server.waitIdle(sessionID)
    const sent = fake.requests
      .slice(before)
      .map((request) => request.json as { input: Array<Item> })
      .filter((body) => JSON.stringify(body.input).includes("Run the script."))
    expect(sent).toHaveLength(2)
    const input = sent[1]!.input
    const call = input.find((item) => item.type === "custom_tool_call" && item.name === "exec")!
    const outputs = input.filter((item) => item.type === "custom_tool_call_output" && item.call_id === call.call_id)
    expect(outputs).toHaveLength(2)
    expect(JSON.stringify(outputs[0]!.output)).toContain("Script completed")
    expect(JSON.stringify(outputs[0]!.output)).not.toContain("half way there")
    expect(outputs[1]!.output).toBe("half way there")
    expect(input.indexOf(outputs[1]!)).toBeGreaterThan(input.indexOf(outputs[0]!))
    // Nothing of it stays a user message.
    expect(
      input.some(
        (item) => item.type === "message" && item.role === "user" && JSON.stringify(item).includes("exec_notify"),
      ),
    ).toBe(false)
  }, 120_000)
})
