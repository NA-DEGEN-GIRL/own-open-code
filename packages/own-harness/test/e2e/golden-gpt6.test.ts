// Golden comparison (10 §4.1) for Code Mode: the `exec-gpt6` scenario run through own's `codex` harness against the
// request Codex CLI 0.171.0 sends for gpt-6.1-sol (test/golden/codex/exec-gpt6.json, script/codex-golden.ts), and the
// same scenario on gpt-6.1-terra (exec-terra.json) and gpt-6.2-sol (exec-gpt62.json): Responses Lite, the freeform
// JavaScript `exec` whose program calls `tools.exec_command`, its output items, and the first-window
// `configuration_update` after the user's message. All are captures of the real CLI (0.165.0 since merge round 8,
// MR8-18; 0.166.0 since merge round 9, CX166; 0.167.0 since CX167; 0.171.0 since CX171). The 0.162.1-derived
// versions before them matched.
// Normalized as in golden.test.ts. What own does not have yet is listed in KNOWN_GAPS, so closing a gap fails this
// test until the list is updated.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { expectCodeModeParity, normalize, type Body } from "./golden-code-mode.js"
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

const GOLDENS = path.join(import.meta.dir, "..", "golden", "codex")
const BOOT_TIMEOUT = 180_000
const SCENES = [
  { golden: "exec-gpt6", model: "gpt-6.1-sol" },
  { golden: "exec-terra", model: "gpt-6.1-terra" },
  // GPT-6.2 Sol (catalog since rust-v0.169.1): `send_message_to_user_async` after `request_user_input_async`.
  { golden: "exec-gpt62", model: "gpt-6.2-sol" },
]
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]

let fake: FakeOpenAIResponses
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIResponses({ models: SCENES.map((scene) => scene.model) })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "Answer in one short sentence.\n")
      fs.writeFileSync(path.join(paths.workspace, "hello.txt"), "hello from the workspace\n")
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: Object.fromEntries(SCENES.map((scene) => [scene.model, { name: scene.model }])),
          }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  await server.waitForModels(SCENES.map((scene) => ({ providerID: "fake-a", id: scene.model })))
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

describe.each(SCENES)("codex harness vs Codex 0.171.0 ($golden)", (scene) => {
  test("the same scenario gives the same request, except the known gaps", async () => {
    const golden: { model: string; requests: Array<{ body: Body }> } = await Bun.file(
      path.join(GOLDENS, `${scene.golden}.json`),
    ).json()
    expect(golden.model).toBe(scene.model)
    const model = { providerID: "fake-a", id: scene.model }
    const created = (await server.call("POST", "/api/session", {
      body: { title: "golden", model, location: { directory: server.paths.workspace }, permissions: FULL },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)
    const theirs = golden.requests.map((request) => normalize(request.body) as Body)
    const program = theirs[1]!.input.find((item) => item.type === "custom_tool_call")!.input as string
    fake.enqueue(
      { type: "tool-call", name: "exec", input: {}, freeform: program },
      { type: "text", text: "It says hello from the workspace." },
    )
    const before = fake.requests.length
    await server.prompt(sessionID, "Show me what is in hello.txt.")
    await server.waitIdle(sessionID)
    const ours = fake.requests
      .slice(before)
      .map((request) => request.json as Body)
      .filter((body) => JSON.stringify(body.input).includes("Show me what is in hello.txt."))
    expect(ours).toHaveLength(2)
    const mine = ours.map((body) => normalize(body, server.paths.workspace) as Body)

    expectCodeModeParity(mine, theirs)
  }, 180_000)
})
