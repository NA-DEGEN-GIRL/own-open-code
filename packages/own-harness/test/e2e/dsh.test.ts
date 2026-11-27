// The `dsh` harness end to end on a real server (source plugin, fake DeepSeek chat completions): a session created with
// the dsh binding sends dsh's system prompt, dsh's tools under dsh's names and dsh's added messages after the first user
// message; a scripted model runs read → edit → write → shell through own's approvals with dsh's result texts; DeepSeek
// gets core's max_tokens and dsh's default thinking effort. Failures answer dsh's texts, an opencode session never lists
// dsh's tools, compaction is own's common one, and a codex session switched to dsh carries the switch notice and its
// exec_command call as dsh's shell. The first request's bytes are kept as a golden (test/golden/dsh/), refreshed with
// OWN_UPDATE_GOLDEN=1.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  deepseekProvider,
  opencodeConfig,
  sessionInfo,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { Checkpoint } from "../../src/checkpoint.js"
import { expectFullPrefix, HARNESS_PLUGINS, keptPrompt } from "./full-prefix.js"
import { DshFs } from "../../src/dsh/fs.js"
import { DshPrompt } from "../../src/dsh/prompt.js"
import { DshReminder } from "../../src/dsh/reminder.js"
import { DshShell } from "../../src/dsh/shell.js"
import { DshShellTool } from "../../src/dsh/shell-tool.js"
import { Gate } from "../../src/gate.js"
import { Notice } from "../../src/notice.js"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const SHELL = DshShell.kind()
const GOLDEN = path.join(import.meta.dir, "..", "golden", "dsh", `first-request.${SHELL}.json`)
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const ASK = [
  { action: "edit", resource: "**", effect: "ask" },
  { action: "shell", resource: "**", effect: "ask" },
]

type Chat = {
  model: string
  messages: Array<{ role: string; content?: unknown; tool_calls?: Array<Record<string, any>>; tool_call_id?: string }>
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
  [key: string]: unknown
}

let fake: FakeOpenAIChat
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIChat({ models: ["deepseek-v4-pro"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "Answer in one short sentence.\n")
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-ds": deepseekProvider(fake, {
            apiKey: "fake-key-ds",
            models: { "deepseek-v4-pro": { name: "DeepSeek V4 Pro", limit: { context: 1_000_000, output: 393_216 } } },
          }),
        },
        plugins: HARNESS_PLUGINS,
      })
    },
  })
  await server.waitForModels([MODEL])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

async function create(harness: OwnHarness.HarnessID, permissions?: ReadonlyArray<Record<string, unknown>>) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: "dsh e2e",
      model: MODEL,
      location: { directory: server.paths.workspace },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
      ...(permissions === undefined ? {} : { permissions }),
    },
  })) as { data: { id: string } }
  return created.data.id
}

async function gated(sessionID: string, rule: Record<string, unknown>) {
  const deadline = Date.now() + 15_000
  while (!JSON.stringify((await sessionInfo(server, sessionID)).permissions ?? []).includes(JSON.stringify(rule))) {
    if (Date.now() > deadline) throw new Error(`session ${sessionID} has no ${JSON.stringify(rule)}`)
    await Bun.sleep(50)
  }
}

/** Runs one prompt with the scripted replies, answering every permission request `once`; the requests and asks. */
async function run(sessionID: string, text: string, replies: Parameters<FakeOpenAIChat["enqueue"]>) {
  fake.enqueue(...replies)
  const before = fake.requests.length
  const asked: Array<{ action: string; resources: ReadonlyArray<string> }> = []
  const state = { done: false }
  const approving = (async () => {
    while (!state.done) {
      const body = (await server.call("GET", `/api/session/${sessionID}/permission`)) as {
        data?: Array<Record<string, any>>
      }
      await Promise.all(
        (body.data ?? []).map((request) => {
          asked.push({ action: String(request.action), resources: request.resources as ReadonlyArray<string> })
          return server.call("POST", `/api/session/${sessionID}/permission/${String(request.id)}/reply`, {
            body: { decision: "once" },
          })
        }),
      )
      await Bun.sleep(100)
    }
  })()
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
  state.done = true
  await approving
  const requests = fake.requests
    .slice(before)
    .filter((request) => request.method === "POST")
    .map((request) => request.json as Chat)
    .filter((body) => JSON.stringify(body.messages).includes(text))
  return { requests, asked }
}

const texts = (body: Chat) =>
  body.messages.flatMap((message) =>
    typeof message.content === "string"
      ? [message.content]
      : Array.isArray(message.content)
        ? (message.content as Array<{ text?: string }>).flatMap((part) =>
            typeof part.text === "string" ? [part.text] : [],
          )
        : [],
  )

function outputs(body: Chat) {
  return body.messages
    .filter((message) => message.role === "tool")
    .map((message) => texts({ ...body, messages: [message] }).join(""))
}

/** What differs between any two runs or PCs: the workspace path, call ids, the time read and the installed skills. */
function normalize(body: Chat) {
  const workspace = server.paths.workspace
  const text = JSON.stringify(body)
    .replaceAll(JSON.stringify(workspace).slice(1, -1), "<WORKSPACE>")
    .replaceAll(JSON.stringify(JSON.stringify(workspace)).slice(1, -1), "<WORKSPACE_JSON>")
    .replaceAll(workspace.replace(/\\/g, "/"), "<WORKSPACE>")
    .replace(/preparing turn (\d+), step (\d+): [^\\]+\\n/g, "preparing turn $1, step $2: <TIME>\\n")
    .replace(/Elapsed since the preceding ([a-z -]+): [^."]+\./g, "Elapsed since the preceding $1: <ELAPSED>.")
    .replace(/"call_[A-Za-z0-9_-]+"/g, '"<CALL>"')
    // The skills this PC has installed (the user's own besides core's built-in ones).
    .replace(/<available_skills>.*?<\/available_skills>/g, "<available_skills>\\n<SKILLS>\\n</available_skills>")
  return JSON.parse(text) as unknown
}

describe("dsh harness", () => {
  test("a dsh session sends dsh's prompt, tools and added messages; read → edit → write → shell run through own's approvals", async () => {
    fs.writeFileSync(path.join(server.paths.workspace, "notes.txt"), "one\ntwo\n")
    const sessionID = await create("dsh", ASK)
    await gated(sessionID, Gate.DSH_ALLOW)
    expect((await sessionInfo(server, sessionID)).permissions).not.toContainEqual(Gate.PI_ALLOW)
    const command = SHELL === "pwsh" ? "Get-Content out/new.txt" : "cat out/new.txt"
    const { requests, asked } = await run(sessionID, "update the notes", [
      { type: "tool-call", name: "read", input: { file_path: "notes.txt" } },
      { type: "tool-call", name: "edit", input: { file_path: "notes.txt", old_string: "two", new_string: "three" } },
      { type: "tool-call", name: "write", input: { file_path: "out/new.txt", content: "hello dsh\n" } },
      { type: "tool-call", name: SHELL, input: { description: "Show the new file", command } },
      { type: "text", text: "done" },
    ])
    expect(requests).toHaveLength(5)
    const first = requests[0]!
    // DeepSeek: core's output limit (min(catalog 393,216, 256,000)), dsh's thinking effort for a session without a variant.
    expect(first.max_tokens).toBe(256_000)
    expect(first.reasoning_effort).toBe("high")
    // None of dsh's DeepSeek wire extensions (`dsh_session_log` and the like): own's chat request fields only.
    expect(Object.keys(first).toSorted()).toEqual(
      ["max_tokens", "messages", "model", "reasoning_effort", "stream", "stream_options", "tools"].toSorted(),
    )
    expect(JSON.stringify(first)).not.toMatch(/"dsh_[a-z_]+"\s*:/)
    expect(first.messages[0]!.role).toBe("system")
    const prompt = first.messages[0]!.content as string
    expect(prompt).toStartWith(
      `${DshPrompt.IDENTITY}\n\nYou are a coding agent powered by the deepseek-v4-pro model.\n\n`,
    )
    expect(prompt).toContain(SHELL === "pwsh" ? DshShellTool.PWSH_SECTION : DshShellTool.BASH_SECTION)
    expect(prompt).toContain(DshFs.READ_SECTION)
    expect(prompt).not.toContain("Today's date")
    const added = texts(first).slice(1)
    expect(added[0]).toBe("update the notes")
    expect(added[1]).toContain("Instructions from: AGENTS.md\n\nAnswer in one short sentence.")
    expect(added[2]).toStartWith("Current runtime context. This snapshot supersedes earlier runtime-context snapshots.")
    expect(added[2]).toContain(`Current working directory: ${JSON.stringify(server.paths.workspace)}.`)
    expect(added.at(-1)).toStartWith("Time sampled while preparing turn 1, step 1: ")

    // dsh's tools first in dsh's name order, own's other tools (Code Mode's `execute` among them) after.
    const names = (first.tools ?? []).map((tool) => tool.function.name)
    expect(names.slice(0, 7)).toEqual([SHELL, "read", "write", "edit", "glob", "grep", "todo_write"].toSorted())
    expect(names.length).toBeGreaterThan(7)
    for (const name of ["shell", "patch", "dsh_read", "exec_command", "apply_patch"]) expect(names).not.toContain(name)
    const definitions = Object.fromEntries((first.tools ?? []).map((tool) => [tool.function.name, tool.function]))
    expect(definitions.read).toMatchObject({ description: DshFs.READ_DESCRIPTION, parameters: DshFs.READ_SCHEMA })
    expect(definitions[SHELL]).toMatchObject({ description: DshShellTool.description(SHELL) })

    const results = outputs(requests[4]!)
    expect(results[0]).toBe(
      `<path>${path.join(server.paths.workspace, "notes.txt")}</path>\n<type>file</type>\n<content>\n1: one\n2: two\n\n(End of file - total 2 lines)\n</content>`,
    )
    expect(results[1]).toBe(`The file ${path.join(server.paths.workspace, "notes.txt")} has been updated successfully.`)
    expect(results[2]).toContain("Created file")
    expect(results[3]!.replaceAll("\r\n", "\n")).toBe("hello dsh\n")
    expect(fs.readFileSync(path.join(server.paths.workspace, "notes.txt"), "utf8")).toBe("one\nthree\n")
    expect(asked.filter((ask) => ask.action === "edit").map((ask) => ask.resources)).toEqual([
      ["notes.txt"],
      ["out/new.txt"],
    ])
    expect(asked.some((ask) => ask.action === "shell")).toBe(true)
    // The calls keep dsh's names in the session, for the transcript's tool cards.
    const messages = await server.messages(sessionID)
    const tools = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((part: Record<string, any>) => (part.type === "tool" ? [part.name as string] : []))
        : [],
    )
    expect(tools.toSorted()).toEqual(["edit", "read", SHELL, "write"].toSorted())

    // The first request's bytes, normalized, as the golden for this platform's shell.
    const normalized = normalize(first)
    if (process.env.OWN_UPDATE_GOLDEN === "1") {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
      fs.writeFileSync(GOLDEN, `${JSON.stringify(normalized, null, 2)}\n`)
    }
    // The Windows golden (pwsh) is recorded; elsewhere the bash one is made with OWN_UPDATE_GOLDEN=1.
    if (fs.existsSync(GOLDEN)) expect(normalized).toEqual(JSON.parse(fs.readFileSync(GOLDEN, "utf8")))
  }, 180_000)

  test("failures answer dsh's texts; repeated calls get dsh's reminder; an opencode session never lists dsh's tools", async () => {
    const sessionID = await create("dsh", FULL)
    await gated(sessionID, Gate.DSH_ALLOW)
    const failing = SHELL === "pwsh" ? "Write-Output 'out'; exit 3" : "echo out; exit 3"
    const same = { file_path: "missing.txt" }
    const { requests } = await run(sessionID, "fail on purpose", [
      { type: "tool-call", name: SHELL, input: { description: "Fail", command: failing } },
      { type: "tool-call", name: "edit", input: { file_path: "notes.txt", old_string: "absent", new_string: "x" } },
      { type: "tool-call", name: "read", input: same },
      { type: "tool-call", name: "read", input: same },
      { type: "tool-call", name: "read", input: same },
      { type: "text", text: "failed" },
    ])
    const results = outputs(requests.at(-1)!)
    expect(results[0]!.replaceAll("\r\n", "\n")).toBe("out\n[exit code: 3]")
    expect(results[1]).toBe(
      `Error: cannot modify "${path.join(server.paths.workspace, "notes.txt")}": file has not been read — read the file, then retry`,
    )
    expect(results[2]).toBe(`Error: cannot read "${path.join(server.paths.workspace, "missing.txt")}": not found`)
    // The third identical read: dsh's gentle reminder right after its result.
    const last = requests.at(-1)!.messages
    const reminder = last.findIndex((message) => message.role === "user" && message.content === DshReminder.GENTLE)
    expect(reminder).toBeGreaterThan(0)
    expect(last[reminder - 1]!.role).toBe("tool")

    const plain = await create("opencode")
    const [request] = (await run(plain, "plain request", [{ type: "text", text: "ok" }])).requests
    const names = (request!.tools ?? []).map((tool) => tool.function.name)
    expect(names).toContain("shell")
    expect(names).not.toContain("dsh_read")
    expect(names).not.toContain("todo_write")
    expect(request!.reasoning_effort).toBeUndefined()
  }, 180_000)

  test("compaction is the common one: the previous request plus own's checkpoint prompt (P-034), then the checkpoint", async () => {
    const sessionID = await create("dsh", FULL)
    await gated(sessionID, Gate.DSH_ALLOW)
    await run(sessionID, "First question about the parser.", [{ type: "text", text: "First answer." }])
    const [previous] = (await run(sessionID, "Second question about the lexer.", [{ type: "text", text: "Second answer." }]))
      .requests
    const checkpoint = Checkpoint.SECTIONS.map(
      (heading) => `${heading}\n- ${heading.replace(/#/g, "").trim()} item`,
    ).join("\n")
    fake.enqueue({ type: "text", text: `<checkpoint>\n${checkpoint}\n</checkpoint>` })
    const before = fake.requests.length
    await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
    await server.waitIdle(sessionID)
    const compaction = fake.requests
      .slice(before)
      .filter((request) => request.method === "POST")
      .map((request) => request.json as Chat)
    expect(compaction).toHaveLength(1)
    expect(compaction[0]!.messages[0]!.content as string).toStartWith(DshPrompt.IDENTITY)
    expect(texts(compaction[0]!).at(-1)).toBe(keptPrompt("Second question about the lexer."))
    expect((compaction[0]!.tools ?? []).map((tool) => tool.function.name)).toContain("read")
    expectFullPrefix(previous!, compaction[0]!, "messages")

    const [next] = (await run(sessionID, "Third question.", [{ type: "text", text: "Third answer." }])).requests
    const all = texts(next!)
    const rendered = all.find((text) => Checkpoint.isCheckpoint(text))
    expect(rendered).toContain("## Next step\n- Next step item")
    // dsh adds its messages again after the compaction, at the first step after the checkpoint: after the new request.
    const at = all.indexOf(rendered!)
    const third = all.indexOf("Third question.")
    expect(third).toBeGreaterThan(at)
    expect(all[third + 1]).toContain("Instructions from: AGENTS.md")
    expect(all[third + 2]).toStartWith("Current runtime context.")
  }, 180_000)

  test("a codex session switched to dsh gets the notice and its exec_command call as dsh's shell", async () => {
    const sessionID = await create("codex", FULL)
    await gated(sessionID, Gate.ALLOW)
    const command = process.platform === "win32" ? "Write-Output 'hi from codex'" : "echo 'hi from codex'"
    await run(sessionID, "say hi", [
      { type: "tool-call", name: "exec_command", input: { cmd: command } },
      { type: "text", text: "said hi" },
    ])
    const switched = (await server.call("POST", `/api/rpc/${OwnHarness.ID}/session.set`, {
      body: { input: { sessionID, harness: "dsh" } },
      query: { "location[directory]": server.paths.workspace },
    })) as { output?: unknown }
    expect(switched.output).toEqual({ sessionID, harness: "dsh", explicit: true, prompt: "reference" })
    const permissions = (await sessionInfo(server, sessionID)).permissions
    expect(permissions).toContainEqual(Gate.DSH_ALLOW)
    expect(permissions).not.toContainEqual(Gate.ALLOW)

    const [request] = (await run(sessionID, "now in dsh", [{ type: "text", text: "ok" }])).requests
    expect(request!.messages[0]!.content as string).toStartWith(DshPrompt.IDENTITY)
    const call = request!.messages.flatMap((message) => message.tool_calls ?? [])[0]!
    expect(call.function.name).toBe(SHELL)
    expect(JSON.parse(call.function.arguments)).toEqual({ command })
    expect(outputs(request!)[0]).toContain("hi from codex")
    const body = JSON.stringify(request!.messages)
    const notice = JSON.stringify(Notice.text("codex", "dsh")).slice(1, -1)
    expect(body.indexOf(notice)).toBeGreaterThan(-1)
    expect(body.indexOf(notice)).toBeLessThan(body.indexOf("now in dsh"))
    expect(body).not.toContain('"exec_command"')
  }, 180_000)
})
