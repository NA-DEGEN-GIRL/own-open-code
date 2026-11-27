// `/goal` per harness on a real server (source plugin, fake Responses provider; MR8-15): in a codex session it is
// Codex's own `/goal`, on the harness's goals, and its continuation turn finishes through Codex's `update_goal`; in an
// opencode session it stays core's `/goal` loop (upstream v2.2, #59437), whose kickoff is core's. The harness wraps
// core's command through core P-038.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  openAIResponsesProvider,
  opencodeConfig,
  sessionInfo,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { HARNESS_PLUGINS } from "./full-prefix.js"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-5.5" }
const CODEX_CONTINUE = "Continue working toward the active thread goal."
const OBJECTIVE = "Write the release notes"

let fake: FakeOpenAIResponses
let server: OpencodeServer

type Item = Record<string, any>
const items = (json: unknown) => ((json as { input?: Array<Item> }).input ?? []) as Array<Item>
const text = (json: unknown) => JSON.stringify(json)
const called = (json: unknown, name: string) =>
  items(json).some((item) => item.type === "function_call" && item.name === name)

beforeAll(async () => {
  fake = startFakeOpenAIResponses({
    models: ["gpt-5.5"],
    responder: (request) => {
      const json = request.json
      // Codex's continuation turn finishes the goal through its own tool.
      if (text(json).includes(CODEX_CONTINUE) && !called(json, "update_goal"))
        return { type: "tool-call", name: "update_goal", input: { status: "complete" } }
      return { type: "text", text: "Done." }
    },
  })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, { apiKey: "fake-key-a", models: { "gpt-5.5": { name: "gpt-5.5" } } }),
        },
        plugins: HARNESS_PLUGINS,
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

/** A session bound to `harness` once own.harness stamped it. */
async function create(harness: OwnHarness.HarnessID) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `goal ${harness}`,
      model: MODEL,
      location: { directory: server.paths.workspace },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
    },
  })) as { data: { id: string } }
  const sessionID = created.data.id
  const deadline = Date.now() + 15_000
  while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined) {
    if (Date.now() > deadline) throw new Error("own.harness did not bind the session")
    await Bun.sleep(50)
  }
  return sessionID
}

async function until(done: () => boolean | Promise<boolean>, what: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

const goal = (sessionID: string, input: string) =>
  server.call("POST", `/api/session/${sessionID}/command`, { body: { name: "goal", text: input } })

const sent = (start: number) =>
  fake.requests
    .slice(start)
    .filter((request) => request.method === "POST")
    .map((request) => text(request.json))

describe("/goal per harness", () => {
  test("a codex session runs Codex's goal: its continuation starts at once and update_goal completes it", async () => {
    const sessionID = await create("codex")
    const start = fake.requests.length
    await goal(sessionID, OBJECTIVE)
    await until(
      () => sent(start).some((body) => body.includes(CODEX_CONTINUE) && body.includes('"update_goal"')),
      "the goal turn",
    )
    await server.waitIdle(sessionID)
    const bodies = sent(start)
    // Codex's continuation names the objective; core's kickoff never went out.
    expect(bodies[0]).toContain(CODEX_CONTINUE)
    expect(bodies[0]).toContain(OBJECTIVE)
    expect(bodies.some((body) => body.includes("untrusted_objective"))).toBe(false)
    // An empty `/goal` answers with the goal, as a failed command whose message the composer shows.
    const shown = await goal(sessionID, "").then(
      () => "",
      (error: unknown) => String(error),
    )
    expect(JSON.stringify(JSON.parse(shown.slice(shown.indexOf("{"))))).toContain(`목표(이룸): ${OBJECTIVE}`)
  }, 180_000)

  test("an opencode session keeps core's /goal", async () => {
    const sessionID = await create("opencode")
    const start = fake.requests.length
    await goal(sessionID, OBJECTIVE)
    await until(() => sent(start).length > 0, "core's goal turn")
    await server.waitIdle(sessionID)
    // Core's kickoff wraps the objective as untrusted; Codex's continuation is not in it.
    expect(sent(start)[0]).toContain("untrusted_objective")
    expect(sent(start)[0]).not.toContain(CODEX_CONTINUE)
    await server.call("POST", `/api/session/${sessionID}/command`, { body: { name: "goal", text: "clear" } })
  }, 180_000)
})
