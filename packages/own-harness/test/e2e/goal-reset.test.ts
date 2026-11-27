// Codex's goals and a context reset (core P-035, 11 §7.2) on a real server (source plugin, fake Responses provider):
// the goal's continuation reports the work of the turn that just ended. A reset requested during a goal turn applies
// at that turn's end; a prompt typed behind it then runs in the new context within the same run, and the goal
// continues there. With nothing behind the reset, the continuation reports the old turn: it waits, labelled as from
// before the reset, and rides with the next prompt instead of starting the new context. The first turn's answer comes
// late, so the reset and the prompt land while it runs.
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
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
/** The goal turn's answer starts this late: the reset (and a prompt) land while it runs. */
const ANSWER_DELAY_MS = 4_000
const CONTINUE = "Continue working toward the active thread goal."
const BEFORE_RESET = "(This background task started before the context was reset.)"
const BEHIND = "Set a goal to write the release notes."
const ALONE = "Set a goal to tidy the changelog."
const OBJECTIVES = { [BEHIND]: "Write the release notes", [ALONE]: "Tidy the changelog" }
const prompts = [BEHIND, ALONE] as const

let fake: FakeOpenAIResponses
let server: OpencodeServer

type Item = Record<string, any>
const items = (json: unknown) => ((json as { input?: Array<Item> }).input ?? []) as Array<Item>
const text = (json: unknown) => JSON.stringify(json)
const output = (json: unknown, name: string) => {
  const call = items(json).find((item) => item.type === "function_call" && item.name === name)
  return call && items(json).find((item) => item.type === "function_call_output" && item.call_id === call.call_id)
}

beforeAll(async () => {
  fake = startFakeOpenAIResponses({
    models: ["gpt-5.5"],
    responder: (request) => {
      const json = request.json
      // A continuation turn finishes the goal.
      if (text(json).includes(CONTINUE)) {
        if (output(json, "update_goal") === undefined)
          return { type: "tool-call", name: "update_goal", input: { status: "complete" } }
        return { type: "text", text: "Finished." }
      }
      const prompt = prompts.find((candidate) => text(json).includes(candidate))
      if (prompt === undefined) return { type: "text", text: "Answer." }
      if (output(json, "create_goal") === undefined)
        return { type: "tool-call", name: "create_goal", input: { objective: OBJECTIVES[prompt] } }
      return { type: "text", text: "Started.", delayMs: ANSWER_DELAY_MS }
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

/** A codex session, once own.harness has bound it. */
async function codex(title: string) {
  const created = (await server.call("POST", "/api/session", {
    body: { title, model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL },
  })) as { data: { id: string } }
  const sessionID = created.data.id
  const deadline = Date.now() + 15_000
  while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined) {
    if (Date.now() > deadline) throw new Error("own.harness did not bind the session")
    await Bun.sleep(50)
  }
  return sessionID
}

/** Polls until `done` holds. */
async function until(done: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

/** The model requests since `start`, as JSON text. */
const sent = (start: number) =>
  fake.requests
    .slice(start)
    .filter((request) => request.method === "POST")
    .map((request) => text(request.json))

async function inbox(sessionID: string) {
  return ((await server.call("GET", `/api/session/${sessionID}/inbox`)) as { data: Array<Item> }).data
}

/** Starts the goal turn and returns once its slow answer was requested (the turn runs until it arrives). */
async function goalTurn(sessionID: string, prompt: string, start: number) {
  await server.prompt(sessionID, prompt)
  await until(
    () => fake.requests.slice(start).some((request) => output(request.json, "create_goal") !== undefined),
    "the goal turn's answer request",
  )
  await Bun.sleep(500)
}

describe("goals and a context reset", () => {
  test("a prompt typed behind the reset runs in the new context in the same run, and the goal continues there", async () => {
    const sessionID = await codex("goal reset behind")
    const start = fake.requests.length
    await goalTurn(sessionID, BEHIND, start)
    await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })
    await server.prompt(sessionID, "Next question")
    // The continuation turn's second request carries its update_goal; a held-back continuation names the reset.
    const finished = () =>
      fake.requests
        .slice(start)
        .some((request) => text(request.json).includes(CONTINUE) && output(request.json, "update_goal") !== undefined)
    await until(
      async () =>
        finished() || (await inbox(sessionID)).some((item) => item.type === "synthetic" && item.payload.beforeReset),
      "the goal's continuation",
      90_000,
    )
    await server.waitIdle(sessionID)

    expect(finished()).toBe(true)
    const after = sent(start).filter((body) => !body.includes(BEHIND))
    // The prompt's turn, then the goal's continuation turn (update_goal, then its answer), all in the new context.
    expect(after[0]).toContain("Next question")
    expect(after.slice(1)).toHaveLength(2)
    expect(after.slice(1).every((body) => body.includes(CONTINUE) && !body.includes(BEFORE_RESET))).toBe(true)
    expect(await inbox(sessionID)).toEqual([])
  }, 150_000)

  test("with nothing behind the reset, the continuation waits labelled and rides with the next prompt", async () => {
    const sessionID = await codex("goal reset alone")
    const start = fake.requests.length
    await goalTurn(sessionID, ALONE, start)
    const reset = (await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })) as {
      data: { id: string }
    }
    // The turn ends, the reset applies, and the goal's continuation names it: it starts nothing.
    await until(
      async () =>
        (await inbox(sessionID)).some(
          (item) => item.type === "synthetic" && item.payload.beforeReset === reset.data.id,
        ),
      "the passive continuation",
      90_000,
    )
    await server.waitIdle(sessionID)
    const settled = sent(start).length
    await Bun.sleep(1_500)
    expect(sent(start)).toHaveLength(settled)
    expect(sent(start).every((body) => body.includes(ALONE))).toBe(true)

    await server.prompt(sessionID, "Another question")
    await server.waitIdle(sessionID)
    const next = sent(start)[settled]!
    expect(next).not.toContain(ALONE)
    expect(next).toContain(`${BEFORE_RESET}\\n`)
    expect(next.indexOf(CONTINUE)).toBeLessThan(next.indexOf("Another question"))
  }, 150_000)
})
