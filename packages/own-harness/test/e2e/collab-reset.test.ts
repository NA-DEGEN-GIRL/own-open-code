// Codex's MultiAgentV2 agents and a context reset (core P-035, 11 §7.2) on a real server (source plugin, fake Responses
// provider): an agent's FINAL_ANSWER is background work of the root's turn. While a reset waits for that turn,
// `wait_agent` returns with it and the old turn reads it; after a stop applied the reset, it waits for the next input,
// labelled as from before the reset. Neither ever starts a model call in the new context on its own. A prompt typed
// behind the waiting reset is no input of that turn, until the reset is cancelled: then a steered one ends the wait as
// steered and reaches the old turn. A queued prompt, with or without a reset, ends no wait (as in Codex, where queued
// input stays in the client until the turn ends) until it is steered, as own-web does with what it queued behind a reset
// that is cancelled. The helper answers late, so the reset, the stop and the cancel land while the root waits.
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
  type FakeOpenAIResponses,
  type OpencodeServer,
  startOpencodeServer,
} from "../../../own-accounts/test/e2e-kit"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-6.1-sol" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
/** The helper's model answer starts this late: the root waits in `wait_agent` meanwhile. */
const HELPER_DELAY_MS = 5_000
const WAIT = "Delegate the greeting to a helper and wait for it."
const STOP = "Delegate the count to a helper and wait for it."
const CANCEL = "Delegate the poem to a helper and wait for it."
const QUEUED = "Delegate the list to a helper and wait for it."
const PLAIN = "Delegate the sum to a helper and wait for it."
const TASKS = {
  [WAIT]: "Say hi to the user.",
  [STOP]: "Count to three.",
  [CANCEL]: "Write a haiku.",
  [QUEUED]: "List two colours.",
  [PLAIN]: "Add two and two.",
}
const ANSWERS = {
  [WAIT]: "Hi from the helper.",
  [STOP]: "One, two, three.",
  [CANCEL]: "Leaves fall, quiet.",
  [QUEUED]: "Red and blue.",
  [PLAIN]: "Four.",
}
/** These helpers answer later still: the cases check that the wait goes on before they end it themselves. */
const SLOW = new Set<string>([QUEUED, PLAIN])
const BEFORE_RESET = "(This background task started before the context was reset.)"

let fake: FakeOpenAIResponses
let server: OpencodeServer

type Item = Record<string, any>
const items = (json: unknown) => ((json as { input?: Array<Item> }).input ?? []) as Array<Item>
const text = (json: unknown) => JSON.stringify(json)
const output = (json: unknown, name: string) => {
  const call = items(json).find((item) => item.type === "function_call" && item.name === name)
  return call && items(json).find((item) => item.type === "function_call_output" && item.call_id === call.call_id)
}
const prompts = [WAIT, STOP, CANCEL, QUEUED, PLAIN] as const

beforeAll(async () => {
  fake = startFakeOpenAIResponses({
    models: ["gpt-6.1-sol"],
    responder: (request) => {
      const json = request.json
      if (text(json).includes("Message Type: NEW_TASK")) {
        const task = prompts.find((prompt) => text(json).includes(TASKS[prompt]))
        const delayMs = task !== undefined && SLOW.has(task) ? 2 * HELPER_DELAY_MS : HELPER_DELAY_MS
        return { type: "text", text: task === undefined ? "ok" : ANSWERS[task], delayMs }
      }
      const prompt = prompts.find((candidate) => text(json).includes(candidate))
      if (prompt === undefined) return { type: "text", text: "ok" }
      if (output(json, "spawn_agent") === undefined)
        return {
          type: "tool-call",
          name: "collaboration__spawn_agent",
          input: { task_name: "helper", message: TASKS[prompt], fork_turns: "none" },
        }
      if (output(json, "wait_agent") === undefined)
        return { type: "tool-call", name: "collaboration__wait_agent", input: { timeout_ms: 60_000 } }
      return { type: "text", text: "The helper answered." }
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
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { "gpt-6.1-sol": { name: "gpt-6.1-sol" } },
          }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  await server.waitForModels([MODEL])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

/** A codex root session, once own.harness has bound it. */
async function root(title: string) {
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

/** The model requests since `start`: the helper's carry its NEW_TASK, every other one is the root's. */
function sent(start: number) {
  const posts = fake.requests.slice(start).filter((request) => request.method === "POST")
  return {
    helper: posts.filter((request) => text(request.json).includes("Message Type: NEW_TASK")),
    root: posts.filter((request) => !text(request.json).includes("Message Type: NEW_TASK")),
  }
}

async function context(sessionID: string) {
  return ((await server.call("GET", `/api/session/${sessionID}/context`)) as { data: Array<Item> }).data
}

async function inbox(sessionID: string) {
  return ((await server.call("GET", `/api/session/${sessionID}/inbox`)) as { data: Array<Item> }).data
}

describe("codex agents and a context reset", () => {
  test("wait_agent returns with the helper's FINAL_ANSWER in the turn a reset waits for; nothing runs after the reset", async () => {
    const sessionID = await root("collab reset wait")
    const start = fake.requests.length
    await server.prompt(sessionID, WAIT)
    await until(() => sent(start).helper.length > 0, "the helper's request")
    // The root asked for `wait_agent` (its request after `spawn_agent`) and waits; the helper still answers.
    await until(
      () => sent(start).root.some((request) => output(request.json, "spawn_agent") !== undefined),
      "the root's wait_agent",
    )
    await Bun.sleep(1_500)
    // The reset waits for the running turn, and is no input that ends the wait.
    const reset = (await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })) as {
      data: { id: string; type: string }
    }
    expect(reset.data.type).toBe("reset")
    expect((await inbox(sessionID)).map((item) => item.type)).toEqual(["reset"])
    await until(async () => (await inbox(sessionID)).length === 0, "the reset to apply", 90_000)
    await server.waitIdle(sessionID)
    // Long enough for a model call of a notice left behind the reset.
    await Bun.sleep(1_500)

    const requests = sent(start).root
    const last = requests.at(-1)!.json
    expect(JSON.parse(output(last, "wait_agent")!.output)).toEqual({ message: "Wait completed.", timed_out: false })
    expect(text(last)).toContain(
      "Message Type: FINAL_ANSWER\\nTask name: /root\\nSender: /root/helper\\nPayload:\\nHi from the helper.",
    )
    // Every root request belongs to the old context: the FINAL_ANSWER started none in the new one.
    expect(requests.every((request) => text(request.json).includes(WAIT))).toBe(true)
    const after = await context(sessionID)
    expect(after[0]).toMatchObject({ id: reset.data.id, type: "compaction", reason: "reset" })
    expect(after.some((message) => message.type === "synthetic" || message.type === "assistant")).toBe(false)
  }, 150_000)

  test("after a stop applied the reset, the FINAL_ANSWER waits labelled and rides with the next prompt", async () => {
    const sessionID = await root("collab reset stop")
    const start = fake.requests.length
    await server.prompt(sessionID, STOP)
    await until(() => sent(start).helper.length > 0, "the helper's request")
    await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })
    // The composer's `중단`: the stop applies the waiting reset at once.
    await server.call("POST", `/api/session/${sessionID}/interrupt`)
    await server.waitIdle(sessionID)
    expect((await context(sessionID))[0]).toMatchObject({ type: "compaction", reason: "reset" })
    // The helper finishes later; its result names the reset and starts nothing.
    await until(
      async () => (await inbox(sessionID)).some((item) => item.type === "synthetic" && item.payload.beforeReset),
      "the helper's FINAL_ANSWER",
      90_000,
    )
    const settled = sent(start).root.length
    await Bun.sleep(1_500)
    expect(sent(start).root).toHaveLength(settled)
    expect(sent(start).root.every((request) => text(request.json).includes(STOP))).toBe(true)

    await server.prompt(sessionID, "Next question")
    await server.waitIdle(sessionID)
    const next = sent(start).root.at(-1)!.json
    expect(text(next)).not.toContain(STOP)
    expect(text(next)).toContain(`${BEFORE_RESET}\\nMessage Type: FINAL_ANSWER`)
    expect(text(next)).toContain("One, two, three.")
    expect(text(next).indexOf("FINAL_ANSWER")).toBeLessThan(text(next).indexOf("Next question"))
    expect(await inbox(sessionID)).toEqual([])
  }, 150_000)

  test("cancelling the reset lets the prompt held behind it in: wait_agent ends as steered", async () => {
    const sessionID = await root("collab reset cancel")
    const start = fake.requests.length
    const waited = () => sent(start).root.find((request) => output(request.json, "wait_agent") !== undefined)
    await server.prompt(sessionID, CANCEL)
    await until(() => sent(start).helper.length > 0, "the helper's request")
    await until(
      () => sent(start).root.some((request) => output(request.json, "spawn_agent") !== undefined),
      "the root's wait_agent",
    )
    await Bun.sleep(1_000)
    const reset = (await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })) as {
      data: { id: string }
    }
    await server.prompt(sessionID, "Held question")
    await Bun.sleep(500)
    // Behind the waiting reset the prompt is no input of the running turn: the wait goes on.
    expect(waited()).toBeUndefined()
    // The queue dock's `✕`: the prompt now reaches the running turn.
    await server.call("DELETE", `/api/session/${sessionID}/reset/${reset.data.id}`)
    await until(() => waited() !== undefined, "the wait to end", 30_000)
    const answered = waited()!.json
    expect(JSON.parse(output(answered, "wait_agent")!.output)).toEqual({
      message: "Wait interrupted by new input.",
      timed_out: false,
    })
    expect(text(answered)).toContain("Held question")
    expect(text(answered)).toContain(CANCEL)
    await server.waitIdle(sessionID)
  }, 150_000)

  test("a prompt queued behind the reset ends nothing at the cancel; steered then, it ends the wait", async () => {
    const sessionID = await root("collab reset queued")
    const start = fake.requests.length
    const waited = () => sent(start).root.find((request) => output(request.json, "wait_agent") !== undefined)
    await server.prompt(sessionID, QUEUED)
    await until(() => sent(start).helper.length > 0, "the helper's request")
    await until(
      () => sent(start).root.some((request) => output(request.json, "spawn_agent") !== undefined),
      "the root's wait_agent",
    )
    await Bun.sleep(1_000)
    const reset = (await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })) as {
      data: { id: string }
    }
    // own-web's composer queues every send while a reset waits (03 §18.18).
    await server.prompt(sessionID, "Queued question", { delivery: "queue" })
    await Bun.sleep(500)
    await server.call("DELETE", `/api/session/${sessionID}/reset/${reset.data.id}`)
    await Bun.sleep(1_500)
    // Queued, the prompt is still no input of the running turn: the wait goes on.
    expect(waited()).toBeUndefined()
    // own-web steers what it queued only because of the reset; the prompt now reaches the running turn.
    const queued = (await inbox(sessionID)).find((item) => item.type === "user")!
    expect(queued).toMatchObject({ delivery: "queue", payload: { text: "Queued question" } })
    await server.call("PATCH", `/api/session/${sessionID}/inbox/${queued.id}`, { body: { delivery: "steer" } })
    await until(() => waited() !== undefined, "the wait to end", 30_000)
    const answered = waited()!.json
    expect(JSON.parse(output(answered, "wait_agent")!.output)).toEqual({
      message: "Wait interrupted by new input.",
      timed_out: false,
    })
    expect(text(answered)).toContain("Queued question")
    expect(text(answered)).not.toContain(ANSWERS[QUEUED])
    await server.waitIdle(sessionID)
  }, 150_000)

  test("without a reset a queued prompt ends no wait either: it runs once the turn ends", async () => {
    const sessionID = await root("collab queued plain")
    const start = fake.requests.length
    const waited = () => sent(start).root.find((request) => output(request.json, "wait_agent") !== undefined)
    await server.prompt(sessionID, PLAIN)
    await until(() => sent(start).helper.length > 0, "the helper's request")
    await until(
      () => sent(start).root.some((request) => output(request.json, "spawn_agent") !== undefined),
      "the root's wait_agent",
    )
    await Bun.sleep(1_000)
    await server.prompt(sessionID, "Later question", { delivery: "queue" })
    await Bun.sleep(1_500)
    expect(waited()).toBeUndefined()
    await until(() => waited() !== undefined, "the helper's answer", 60_000)
    const answered = waited()!.json
    expect(JSON.parse(output(answered, "wait_agent")!.output)).toEqual({ message: "Wait completed.", timed_out: false })
    expect(text(answered)).toContain(ANSWERS[PLAIN])
    expect(text(answered)).not.toContain("Later question")
    await until(
      () => sent(start).root.some((request) => text(request.json).includes("Later question")),
      "the queued prompt's turn",
      30_000,
    )
    await server.waitIdle(sessionID)
  }, 150_000)
})
