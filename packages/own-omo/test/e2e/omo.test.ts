// own-omo end to end (own/docs/15 §8): a real server with own-harness and own-omo (the built omo runtime,
// OWN_OMO_RUNTIME or own/.out/omo; build it first with `bun script/bundle.ts`) and a fake DeepSeek chat provider whose
// replies a script picks per request. An `omo` session sends Sisyphus's prompt, ultrawork's block on the user's message
// (the stored text unchanged) and omo's tools; todos left open are continued until they are done; omo's task tool
// starts an explore child in the background on the parent's model and wakes the parent when it ends, and omo's record
// of that call is under OWN_HOME, not in OpenCode 1's storage; a sync category task runs Sisyphus-Junior on the
// parent's model and names it; /stop-continuation stops the continuation and /resume-continuation brings it back, with
// omo's markers under OWN_HOME, not in the project; a context reset, during a turn or in omo's countdown, continues
// nothing into the emptied context, and neither does a manual compaction in the countdown; after a request error the
// user's next message lets omo continue again; a failed edit gets omo's recovery reminder; each request of a session
// is a prefix of the next; an `opencode` session in the same server sends nothing of omo's.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  deepseekProvider,
  opencodeConfig,
  REPO_ROOT,
  sessionInfo,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { Checkpoint } from "../../../own-harness/src/checkpoint.js"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
/** Another model of the same provider: own's default stays MODEL. */
const FLASH = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const EXPLORE = "You are a codebase search specialist"
const JUNIOR = "Sisyphus-Junior"

type ChatMessage = {
  role: string
  content: unknown
  tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}
type Body = { messages: Array<ChatMessage>; tools?: Array<{ function: { name: string; description: string } }> }
type Reply = Parameters<FakeOpenAIChat["enqueue"]>[0]

let fake: FakeOpenAIChat
let server: OpencodeServer
/** Picks the fake's reply for each model request; undefined falls back to the fake's default. */
let script: (body: Body) => Reply | undefined = () => undefined

beforeAll(async () => {
  fake = startFakeOpenAIChat({
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    responder: (request) => script(request.json as Body),
  })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "Answer in one short sentence.\n")
      fs.writeFileSync(path.join(paths.workspace, "a.ts"), "export const add = (a: number, b: number) => a - b\n")
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-ds": deepseekProvider(fake, {
            apiKey: "fake-key-ds",
            models: {
              "deepseek-v4-pro": { name: "DeepSeek V4 Pro", limit: { context: 1_000_000, output: 393_216 } },
              "deepseek-v4-flash": { name: "DeepSeek V4 Flash", limit: { context: 1_000_000, output: 393_216 } },
            },
          }),
        },
        model: "fake-ds/deepseek-v4-pro",
        plugins: [
          { package: path.join(REPO_ROOT, "packages/own-harness/test/e2e/fixtures/cache-verdict"), options: {} },
          { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
          { package: path.join(REPO_ROOT, "packages/own-omo"), options: {} },
        ],
      })
    },
  })
  await server.waitForModels([MODEL, FLASH])
}, BOOT_TIMEOUT)

afterAll(async () => {
  if (process.env.OWN_OMO_E2E_LOGS === "1") process.stderr.write(server?.logs() ?? "")
  await server?.stop()
  await fake?.stop()
}, 60_000)

async function create(harness: OwnHarness.HarnessID, title = "omo e2e", model = MODEL) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title,
      model,
      location: { directory: server.paths.workspace },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
      permissions: FULL,
    },
  })) as { data: { id: string } }
  return created.data.id
}

function requests(from: number, marker?: string) {
  return fake.requests
    .slice(from)
    .filter((request) => request.method === "POST")
    .map((request) => request.json as Body)
    .filter((body) => marker === undefined || JSON.stringify(body.messages).includes(marker))
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part: { text?: string }) => part.text ?? "").join("")
  return ""
}

const system = (body: Body) => text(body.messages[0]?.content)
const last = (body: Body) => body.messages.at(-1)!

/** The tool a `tool` message answers, by its call id. */
function answered(body: Body, message: ChatMessage) {
  for (const entry of body.messages)
    for (const call of entry.tool_calls ?? []) if (call.id === message.tool_call_id) return call.function.name
  return undefined
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${server.logs().split("\n").filter((line) => line.includes("own.omo")).join("\n")}`)
    await Bun.sleep(100)
  }
}

async function children(parentID: string) {
  const listed = (await server.call("GET", "/api/session", { query: { parentID } })) as {
    data: Array<{ id: string; agent?: string; model?: { id: string; providerID: string } }>
  }
  return listed.data
}

async function messages(sessionID: string) {
  return (await server.messages(sessionID)) as ReadonlyArray<Record<string, any>>
}

/** Runs an omo command; until omo has started in this Location its commands are not registered (404), so it retries. */
async function command(sessionID: string, name: string) {
  await until(
    async () => {
      const response = await server.request("POST", `/api/session/${sessionID}/command`, { body: { name, text: "" } })
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`)
      return true
    },
    60_000,
    `the ${name} command`,
  )
}

/** OWN_HOME of the server: the default under its LOCALAPPDATA (the harness sets no OWN_HOME). */
const ownHome = () => path.join(server.paths.localAppData, "own-open-code")

/** omo's countdown notices so far in own's log (`Todo Continuation: Resuming in 2s…`). */
function countdowns() {
  const file = path.join(ownHome(), "logs", "own-omo.log")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((line) => line.includes("Resuming in 2s")).length : 0
}

/** The requests that list or continue the todos named `prefix-…` (a continuation into an emptied context names only them). */
const naming = (from: number, prefix: string) => requests(from).filter((body) => JSON.stringify(body.messages).includes(prefix))

const twoTodos = (prefix: string, status: string) => ({
  todos: [
    { content: `${prefix}-one`, status, priority: "high" },
    { content: `${prefix}-two`, status, priority: "low" },
  ],
})

/** Prints the requests since `from` (OWN_OMO_E2E_LOGS=1): system start and each message's role, text and calls. */
function dump(from: number) {
  for (const body of requests(from))
    process.stderr.write(
      `REQ ${system(body).slice(0, 60).replace(/\s+/g, " ")} | ${JSON.stringify(
        body.messages.slice(1).map((message) => [message.role, text(message.content).slice(0, 120), message.tool_calls?.map((call) => call.function.name)]),
      )}\n`,
    )
}

/** Each request of a conversation is the previous one with only messages after it (same system and tools). */
function expectPrefixes(list: ReadonlyArray<Body>) {
  for (let index = 1; index < list.length; index++) {
    const before = list[index - 1]!
    const after = list[index]!
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools))
    expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
  }
}

describe("omo harness (own-omo)", () => {
  test("an omo session sends Sisyphus, ultrawork on the user's message and omo's tools; opencode sends none of it", async () => {
    script = (body) => (JSON.stringify(body.messages).includes("fix the bug in a.ts") ? { type: "text", text: "done" } : undefined)
    const sessionID = await create("omo")
    const before = fake.requests.length
    await server.prompt(sessionID, "ulw fix the bug in a.ts")
    await server.waitIdle(sessionID)
    const [omo] = requests(before, "fix the bug in a.ts")
    expect(omo).toBeDefined()
    expect(system(omo!)).toContain('Your designated identity for this session is "Sisyphus"')
    const user = omo!.messages.findLast((message) => message.role === "user")!
    expect(text(user.content).startsWith("ulw fix the bug in a.ts")).toBe(true)
    expect(text(user.content)).toContain("<ultrawork-mode>")
    // The stored message is what the user typed; omo's block lives in its metadata.
    const stored = (await messages(sessionID)).find((message) => message.type === "user")!
    expect(stored.text).toBe("ulw fix the bug in a.ts")
    expect(JSON.stringify(stored.metadata)).toContain("<ultrawork-mode>")
    const names = (omo!.tools ?? []).map((tool) => tool.function.name)
    for (const name of ["task", "background_output", "background_cancel", "call_omo_agent", "todowrite"])
      expect(names).toContain(name)
    expect(names).not.toContain("subagent")
    expect(names.some((name) => name.startsWith("omo_"))).toBe(false)

    script = (body) =>
      JSON.stringify(body.messages).includes("plain question about a.ts") ? { type: "text", text: "done" } : undefined
    const plain = await create("opencode")
    const second = fake.requests.length
    await server.prompt(plain, "plain question about a.ts")
    await server.waitIdle(plain)
    const [opencode] = requests(second, "plain question about a.ts")
    const plainNames = (opencode!.tools ?? []).map((tool) => tool.function.name)
    expect(plainNames).toContain("subagent")
    for (const name of ["task", "background_output", "call_omo_agent", "todowrite"]) expect(plainNames).not.toContain(name)
    expect(system(opencode!)).not.toContain("Sisyphus")
    // Everything after core's base prompt is the same: omo replaces system[0] only.
    const env = system(opencode!).slice(system(opencode!).indexOf("\n# Your Model"))
    expect(system(omo!)).toContain(env)
    expect(text(opencode!.messages.at(-1)!.content)).toBe("plain question about a.ts")
  }, 120_000)

  test("todos left open are continued until they are done, then nothing more is sent", async () => {
    const todos = (status: string) => ({
      todos: [
        { content: "write the test", status, priority: "high" },
        { content: "fix the bug", status, priority: "medium" },
      ],
    })
    script = (body) => {
      if (!JSON.stringify(body.messages).includes("plan two todos")) return undefined
      const message = last(body)
      if (message.role === "tool") return { type: "text", text: "noted" }
      if (text(message.content).includes("TODO CONTINUATION"))
        return { type: "tool-call", name: "todowrite", input: todos("completed") }
      return { type: "tool-call", name: "todowrite", input: todos("pending") }
    }
    const sessionID = await create("omo")
    const before = fake.requests.length
    await server.prompt(sessionID, "plan two todos")
    await server.waitIdle(sessionID)
    const continued = await until(
      () => requests(before, "plan two todos").find((body) => text(last(body).content).includes("TODO CONTINUATION")),
      15_000,
      "the todo continuation",
    )
    expect(text(last(continued).content)).toContain("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]")
    await until(() => (requests(before, "plan two todos").length >= 4 ? true : undefined), 15_000, "the completed todos")
    await server.waitIdle(sessionID)
    const stored = await messages(sessionID)
    expect(stored.some((message) => message.type === "synthetic" && message.metadata?.source === "own.omo")).toBe(true)
    const count = requests(before, "plan two todos").length
    await Bun.sleep(10_000)
    expect(requests(before, "plan two todos").length).toBe(count)
    if (process.env.OWN_OMO_E2E_LOGS === "1") dump(before)
    expectPrefixes(requests(before, "plan two todos"))
  }, 120_000)

  test("task in the background starts an explore child on the parent's model and wakes the parent", async () => {
    script = (body) => {
      if (system(body).includes(EXPLORE)) return { type: "text", text: "add is defined in a.ts on line 1" }
      if (!JSON.stringify(body.messages).includes("look for add in the background")) return undefined
      const message = last(body)
      if (message.role === "tool") {
        const name = answered(body, message)
        return { type: "text", text: name === "background_output" ? "got the result" : "waiting for explore" }
      }
      if (text(message.content).includes("BACKGROUND TASK")) {
        const id = JSON.stringify(body.messages).match(/bg_[0-9a-f]{8}/)?.[0]
        return { type: "tool-call", name: "background_output", input: { task_id: id } }
      }
      return {
        type: "tool-call",
        name: "task",
        input: {
          subagent_type: "explore",
          run_in_background: true,
          load_skills: [],
          description: "find add",
          prompt: "Find where add is defined",
        },
      }
    }
    const parentID = await create("omo")
    const before = fake.requests.length
    await server.prompt(parentID, "look for add in the background")
    const child = await until(async () => (await children(parentID))[0], 30_000, "the explore child")
    const childInfo = await sessionInfo(server, child.id)
    expect(childInfo.agent).toBe("omo-explore")
    expect((childInfo.model as { id?: string } | undefined)?.id).toBe(MODEL.id)
    await until(() => requests(before).find((body) => system(body).includes(EXPLORE)), 30_000, "the explore request")
    expect(system(requests(before).find((body) => system(body).includes(EXPLORE))!).startsWith(EXPLORE)).toBe(true)
    const done = await until(
      () => requests(before, "look for add in the background").find((body) => last(body).role === "tool" && answered(body, last(body)) === "background_output"),
      60_000,
      "background_output",
    )
    expect(text(last(done).content)).toContain("add is defined in a.ts on line 1")
    await server.waitIdle(parentID)
    const stored = await messages(parentID)
    expect(stored.some((message) => message.type === "synthetic" && String(message.text).includes("BACKGROUND TASK"))).toBe(true)
    // omo deletes a finished child after a while; own keeps it (session.delete does nothing).
    expect((await sessionInfo(server, child.id)).id).toBe(child.id)
    // omo's agent-usage-reminder recorded the task under OWN_HOME (OMO-P2), not in OpenCode 1's storage, which an
    // installed OpenCode 1 or omo uses too (XDG_DATA_HOME, else ~/.local/share).
    const storage = path.join(server.paths.data, "storage")
    expect(fs.existsSync(storage) ? fs.readdirSync(storage, { recursive: true }) : []).toEqual([])
    const reminder = path.join(ownHome(), "thirdparty", "omo", "data", "opencode", "storage", "agent-usage-reminder", `${parentID}.json`)
    expect(JSON.parse(fs.readFileSync(reminder, "utf8"))).toMatchObject({ sessionID: parentID, agentUsed: true })
  }, 180_000)

  // deep-low is a category omo opens only on its own models (gpt-6.1-sol…): own's config names own's default model for
  // every category, and omo reads that config, not its files again, when the task runs (OMO-P5). The parent runs on
  // another model than that default: the child runs on the parent's, and omo's result names it (OMO-P7), not the
  // category's configured one in a `Model routing` line.
  test("a sync category task, even one omo gates on a model, runs Sisyphus-Junior on the parent's model inline", async () => {
    script = (body) => {
      if (system(body).includes(JUNIOR) && JSON.stringify(body.messages).includes("Reply with hi")) return { type: "text", text: "hi from junior" }
      if (!JSON.stringify(body.messages).includes("delegate a quick task")) return undefined
      if (last(body).role === "tool") return { type: "text", text: "done" }
      return {
        type: "tool-call",
        name: "task",
        input: { category: "deep-low", run_in_background: false, load_skills: [], description: "say hi", prompt: "Reply with hi" },
      }
    }
    const parentID = await create("omo", "omo e2e", FLASH)
    const before = fake.requests.length
    await server.prompt(parentID, "delegate a quick task")
    const result = await until(
      () => requests(before, "delegate a quick task").find((body) => last(body).role === "tool"),
      90_000,
      "the task result",
    )
    if (process.env.OWN_OMO_E2E_LOGS === "1") {
      dump(before)
      await Bun.sleep(3000)
      process.stderr.write(`STORED ${JSON.stringify(await messages(parentID)).slice(0, 6000)}\n`)
    }
    expect(text(last(result).content)).toContain("hi from junior")
    expect(text(last(result).content)).toContain("Model: fake-ds/deepseek-v4-flash (category: deep-low)")
    expect(text(last(result).content)).not.toContain("Model routing")
    expect(requests(before).find((body) => system(body).includes(JUNIOR))).toBeDefined()
    await server.waitIdle(parentID)
    const [child] = await children(parentID)
    expect(child?.agent).toBe("omo-sisyphus-junior")
    expect<unknown>(child?.model).toEqual((await sessionInfo(server, parentID)).model)
    expect(child?.model?.id).toBe(FLASH.id)
  }, 180_000)

  // omo's explore turns writing off (write, edit, task) but keeps core's read, glob and grep: it lists a folder and
  // reads a file in an omo session (decisions SA, the subagent check of every harness).
  test("a sync explore task lists the folder and reads a file with core's tools", async () => {
    const marker = "list and read the workspace"
    script = (body) => {
      const sent = JSON.stringify(body.messages)
      if (system(body).includes(EXPLORE) && sent.includes(marker)) {
        const step = body.messages.filter((message) => message.role === "tool").length
        if (step === 0) return { type: "tool-call", name: "read", input: { path: "." } }
        if (step === 1) return { type: "tool-call", name: "read", input: { path: "a.ts" } }
        return { type: "text", text: "explored the workspace" }
      }
      if (!sent.includes("explore the workspace now")) return undefined
      if (last(body).role === "tool") return { type: "text", text: "done" }
      return {
        type: "tool-call",
        name: "task",
        input: {
          subagent_type: "explore",
          run_in_background: false,
          load_skills: [],
          description: "explore",
          prompt: marker,
        },
      }
    }
    const parentID = await create("omo")
    const before = fake.requests.length
    await server.prompt(parentID, "explore the workspace now")
    const result = await until(
      () => requests(before, "explore the workspace now").find((body) => last(body).role === "tool"),
      90_000,
      "the task result",
    )
    expect(text(last(result).content)).toContain("explored the workspace")
    const explored = requests(before, marker)
      .filter((body) => system(body).includes(EXPLORE))
      .at(-1)!
    const outputs = explored.messages
      .filter((message) => message.role === "tool")
      .map((message) => text(message.content))
    expect(outputs).toHaveLength(2)
    expect(outputs[0]).toContain("a.ts")
    expect(outputs[0]).toContain("AGENTS.md")
    expect(outputs[1]).toContain("export const add")
    await server.waitIdle(parentID)
    const [child] = await children(parentID)
    expect(child?.agent).toBe("omo-explore")
  }, 180_000)

  // omo keeps its per-session continuation markers under OWN_HOME (OMO-P6), and `/resume-continuation` (OMO-P8) lets
  // an idle session with open todos continue without a restart.
  test("/stop-continuation stops the todo continuation; /resume-continuation brings it back", async () => {
    script = (body) => {
      const all = JSON.stringify(body.messages)
      if (all.includes("Stop all continuation mechanisms") && !all.includes("stopped-todo")) return { type: "text", text: "stopped" }
      if (!all.includes("stopped-todo")) return undefined
      if (last(body).role === "tool") return { type: "text", text: "noted" }
      if (text(last(body).content).includes("TODO CONTINUATION")) return { type: "tool-call", name: "todowrite", input: twoTodos("stopped-todo", "completed") }
      return { type: "tool-call", name: "todowrite", input: twoTodos("stopped-todo", "pending") }
    }
    const sessionID = await create("omo")
    await command(sessionID, "stop-continuation")
    await server.waitIdle(sessionID)
    const before = fake.requests.length
    await server.prompt(sessionID, "plan the stopped-todo pair")
    await server.waitIdle(sessionID)
    const count = naming(before, "stopped-todo").length
    await Bun.sleep(10_000)
    expect(naming(before, "stopped-todo").length).toBe(count)
    expect(fs.existsSync(path.join(server.paths.workspace, ".omo"))).toBe(false)
    const projects = path.join(ownHome(), "thirdparty", "omo", "projects")
    const [project] = fs.readdirSync(projects)
    expect(project).toMatch(/^workspace-[0-9a-f]{12}$/)
    const marker = path.join(projects, project!, "run-continuation", `${sessionID}.json`)
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ sources: { stop: { state: "stopped" } } })

    await command(sessionID, "resume-continuation")
    const continued = await until(
      () => naming(before, "stopped-todo").find((body) => text(last(body).content).includes("TODO CONTINUATION")),
      30_000,
      "the continuation after /resume-continuation",
    )
    expect(text(last(continued).content)).toContain("- [pending] stopped-todo-one")
    // The continuation's turn completes the todos.
    await server.waitIdle(sessionID)
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ sources: { stop: { state: "idle" } } })
  }, 180_000)

  // A context reset (core P-035) starts no model call of its own; omo sees it as a compaction and continues nothing into
  // the emptied context, whether the reset waited for the running turn or landed in omo's 2 s countdown after it.
  test("a context reset while a turn with open todos runs continues nothing", async () => {
    script = (body) => {
      const all = JSON.stringify(body.messages)
      if (!all.includes("reset-a")) return undefined
      if (last(body).role === "tool") return { type: "text", text: "working on it", delayMs: 4000 }
      return { type: "tool-call", name: "todowrite", input: twoTodos("reset-a", "pending") }
    }
    const sessionID = await create("omo")
    const before = fake.requests.length
    await server.prompt(sessionID, "plan the reset-a pair")
    await until(() => naming(before, "reset-a").find((body) => last(body).role === "tool"), 30_000, "the slow step")
    await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })
    await server.waitIdle(sessionID)
    const count = naming(before, "reset-a").length
    await Bun.sleep(10_000)
    expect(naming(before, "reset-a").length).toBe(count)
    expect(naming(before, "reset-a").some((body) => text(last(body).content).includes("TODO CONTINUATION"))).toBe(false)
    expect((await messages(sessionID)).some((message) => message.type === "compaction" && message.reason === "reset")).toBe(true)
  }, 120_000)

  test("a context reset in omo's countdown continues nothing", async () => {
    script = (body) => {
      const all = JSON.stringify(body.messages)
      if (!all.includes("reset-b")) return undefined
      if (last(body).role === "tool") return { type: "text", text: "noted" }
      return { type: "tool-call", name: "todowrite", input: twoTodos("reset-b", "pending") }
    }
    const sessionID = await create("omo")
    const before = fake.requests.length
    const shown = countdowns()
    await server.prompt(sessionID, "plan the reset-b pair")
    await server.waitIdle(sessionID)
    await until(() => (countdowns() > shown ? true : undefined), 15_000, "omo's countdown")
    await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })
    const count = naming(before, "reset-b").length
    await Bun.sleep(10_000)
    expect(naming(before, "reset-b").length).toBe(count)
    expect(naming(before, "reset-b").some((body) => text(last(body).content).includes("TODO CONTINUATION"))).toBe(false)
  }, 120_000)

  // A manual compaction that ends inside omo's 2 s countdown: on OpenCode 1 its user message and part cancel the
  // countdown, and the next idle finds the compaction as the latest message, so nothing is continued.
  test("a manual compaction in omo's countdown continues nothing", async () => {
    const checkpoint = Checkpoint.SECTIONS.map((heading) => `${heading}\n- ${heading.replace(/#/g, "").trim()} item`).join("\n")
    const compacting = (body: Body) => text(last(body).content).includes("CONTEXT CHECKPOINT REQUEST")
    script = (body) => {
      if (!JSON.stringify(body.messages).includes("compact-e")) return undefined
      if (compacting(body)) return { type: "text", text: `<checkpoint>\n${checkpoint}\n</checkpoint>` }
      if (last(body).role === "tool") return { type: "text", text: "noted" }
      return { type: "tool-call", name: "todowrite", input: twoTodos("compact-e", "pending") }
    }
    const sessionID = await create("omo")
    const before = fake.requests.length
    const shown = countdowns()
    await server.prompt(sessionID, "plan the compact-e pair")
    await server.waitIdle(sessionID)
    await until(() => (countdowns() > shown ? true : undefined), 15_000, "omo's countdown")
    await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
    await server.waitIdle(sessionID)
    expect(naming(before, "compact-e").filter(compacting)).toHaveLength(1)
    const count = naming(before, "compact-e").length
    await Bun.sleep(10_000)
    if (process.env.OWN_OMO_E2E_LOGS === "1") dump(before)
    expect(naming(before, "compact-e").length).toBe(count)
    expect(naming(before, "compact-e").some((body) => text(last(body).content).includes("TODO CONTINUATION"))).toBe(false)
    expect((await messages(sessionID)).some((message) => message.type === "compaction" && message.status === "completed")).toBe(true)
  }, 120_000)

  // A provider's 400 makes omo stop continuing (re-sending would rebuild the same request). As on OpenCode 1, the user's
  // next message, which omo now hears of (message.updated and its text part), lifts that: its turn's open todos go on.
  test("after a request error, the user's next message lets omo continue again", async () => {
    let failed = false
    script = (body) => {
      const all = JSON.stringify(body.messages)
      if (!all.includes("error-c")) return undefined
      const message = last(body)
      if (message.role === "tool" && !failed) {
        failed = true
        return { type: "error", status: 400, body: { error: { message: "Invalid request: error-c", type: "invalid_request_error" } } }
      }
      if (message.role === "tool") return { type: "text", text: "done" }
      if (text(message.content).includes("TODO CONTINUATION")) return { type: "tool-call", name: "todowrite", input: twoTodos("error-c", "completed") }
      if (text(message.content).includes("go on with error-c")) return { type: "text", text: "on it" }
      return { type: "tool-call", name: "todowrite", input: twoTodos("error-c", "pending") }
    }
    const sessionID = await create("omo")
    const before = fake.requests.length
    await server.prompt(sessionID, "plan the error-c pair")
    await server.waitIdle(sessionID)
    await Bun.sleep(5_000)
    expect(naming(before, "error-c").some((body) => text(last(body).content).includes("TODO CONTINUATION"))).toBe(false)
    await server.prompt(sessionID, "go on with error-c")
    const continued = await until(
      () => naming(before, "error-c").find((body) => text(last(body).content).includes("TODO CONTINUATION")),
      30_000,
      "the continuation after the user's message",
    )
    expect(text(last(continued).content)).toContain("- [pending] error-c-one")
    await server.waitIdle(sessionID)
  }, 120_000)

  // omo's edit-error-recovery: OpenCode 2's edit failure is told to omo in OpenCode 1's words, and omo's reminder
  // follows OpenCode 2's message in the tool result the model gets.
  test("a failed edit gets omo's recovery reminder", async () => {
    script = (body) => {
      if (!JSON.stringify(body.messages).includes("edit-d")) return undefined
      if (last(body).role === "tool") return { type: "text", text: "sorry" }
      return { type: "tool-call", name: "edit", input: { path: "a.ts", oldString: "not in the file (edit-d)", newString: "x" } }
    }
    const sessionID = await create("omo")
    const before = fake.requests.length
    await server.prompt(sessionID, "make the edit-d change")
    const answered = await until(() => naming(before, "edit-d").find((body) => last(body).role === "tool"), 30_000, "the edit result")
    expect(text(last(answered).content)).toContain("Could not find oldString in")
    expect(text(last(answered).content)).toContain("[EDIT ERROR - IMMEDIATE ACTION REQUIRED]")
    await server.waitIdle(sessionID)
  }, 120_000)
})
