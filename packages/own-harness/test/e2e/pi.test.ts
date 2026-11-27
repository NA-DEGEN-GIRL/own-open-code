// The `pi` harness end to end on a real server (source plugin, fake OpenAI Responses provider): a session created with
// the pi binding sends Pi's system prompt and Pi's tools under Pi's names (core's file and shell tools gone, own's
// other tools kept), and a scripted model runs read → edit → write → bash through own's approvals with Pi's result
// texts. Compaction is own's common one. A codex session switched to pi carries the switch notice and its
// exec_command call as Pi's bash. A session reached through a junction gets its project's AGENTS.md files as Pi's
// project context (core lists them by real path, 10 §3.3).
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  openAIResponsesProvider,
  opencodeConfig,
  sessionInfo,
  startFakeOpenAIResponses,
  type FakeOpenAIResponses,
  type OpencodeServer,
  startOpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { Checkpoint } from "../../src/checkpoint.js"
import { expectFullPrefix, HARNESS_PLUGINS, keptPrompt } from "./full-prefix.js"
import { Gate } from "../../src/gate.js"
import { Notice } from "../../src/notice.js"
import { PiBash } from "../../src/pi/bash.js"
import { PiEdit } from "../../src/pi/edit.js"
import { PiPrompt } from "../../src/pi/prompt.js"
import { PiRead } from "../../src/pi/read.js"
import { PiWrite } from "../../src/pi/write.js"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-5.5" }
/** own's `full` approval bundle, so commands run without an approval card. */
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
/** own's `ask` approval bundle (own-accounts `switching/approval.ts`): edits and commands ask first. */
const ASK = [
  { action: "edit", resource: "**", effect: "ask" },
  { action: "shell", resource: "**", effect: "ask" },
]

type Body = { input: Array<Record<string, any>>; tools?: Array<Record<string, any>>; [key: string]: unknown }

let fake: FakeOpenAIResponses
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIResponses({ models: ["gpt-5.5"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    // Project config on: core discovers the workspace AGENTS.md only then.
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "Answer in one short sentence.\n")
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, { apiKey: "fake-key-a", models: { "gpt-5.5": { name: "gpt-5.5" } } }),
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

async function create(
  harness: OwnHarness.HarnessID,
  permissions?: ReadonlyArray<Record<string, unknown>>,
  directory = server.paths.workspace,
) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: "pi e2e",
      model: MODEL,
      location: { directory },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
      ...(permissions === undefined ? {} : { permissions }),
    },
  })) as { data: { id: string } }
  return created.data.id
}

/** Polls until the session's rules carry `rule` (own.harness gates a session after its `session.created` event). */
async function gated(sessionID: string, rule: Record<string, unknown>) {
  const deadline = Date.now() + 15_000
  while (!JSON.stringify((await sessionInfo(server, sessionID)).permissions ?? []).includes(JSON.stringify(rule))) {
    if (Date.now() > deadline) throw new Error(`session ${sessionID} has no ${JSON.stringify(rule)}`)
    await Bun.sleep(50)
  }
}

/** Runs one prompt with the scripted replies, answering every permission request `once`; the requests and asks. */
async function run(sessionID: string, text: string, replies: Parameters<FakeOpenAIResponses["enqueue"]>) {
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
    .map((request) => request.json as Body)
    .filter((body) => JSON.stringify(body.input).includes(text))
  return { requests, asked }
}

function outputs(body: Body) {
  return body.input.filter((item) => item.type === "function_call_output").map((item) => item.output as string)
}

describe("pi harness", () => {
  test("a pi session sends Pi's prompt and tools; read → edit → write → bash run through own's approvals", async () => {
    fs.writeFileSync(path.join(server.paths.workspace, "notes.txt"), "one\ntwo\n")
    const sessionID = await create("pi", ASK)
    await gated(sessionID, Gate.PI_ALLOW)
    expect((await sessionInfo(server, sessionID)).permissions).not.toContainEqual(Gate.ALLOW)
    const { requests, asked } = await run(sessionID, "update the notes", [
      { type: "tool-call", name: "read", input: { path: "notes.txt" } },
      { type: "tool-call", name: "edit", input: { path: "notes.txt", edits: [{ oldText: "two", newText: "three" }] } },
      { type: "tool-call", name: "write", input: { path: "out/new.txt", content: "hello pi\n" } },
      { type: "tool-call", name: "bash", input: { command: "cat out/new.txt" } },
      { type: "text", text: "done" },
    ])
    expect(requests).toHaveLength(5)
    const first = requests[0]!
    // Pi's prompt is the leading developer message on OpenAI Responses, as Pi sends it.
    expect(first.instructions).toBeUndefined()
    expect(first.input[0]).toMatchObject({ type: "message", role: "developer" })
    const prompt = first.input[0]!.content as string
    expect(prompt).toStartWith(`${PiPrompt.PREAMBLE}\n\n<tools>\n- read: Read file contents\n`)
    expect(prompt).toContain("<rules>\n- Use bash for file operations like ls, rg, find\n")
    expect(prompt).toContain("Project-specific instructions and guidelines:")
    expect(prompt).toContain("Answer in one short sentence.")
    expect(prompt).toEndWith(`<cwd>\n${server.paths.workspace.replace(/\\/g, "/")}\n</cwd>`)
    expect(prompt).not.toContain("Today's date")
    expect(first.input[1]).toMatchObject({ role: "user" })

    const names = (first.tools ?? []).map((tool) => tool.name)
    expect(names.slice(0, 4)).toEqual(["read", "bash", "edit", "write"])
    for (const name of ["shell", "patch", "glob", "grep", "pi_read", "pi_bash", "exec_command", "apply_patch"])
      expect(names).not.toContain(name)
    // own's other tools stay as Pi's "other custom tools".
    expect(names.length).toBeGreaterThan(4)
    const definitions = Object.fromEntries((first.tools ?? []).map((tool) => [tool.name, tool]))
    expect(definitions.read).toMatchObject({
      type: "function",
      description: PiRead.DESCRIPTION,
      parameters: PiRead.SCHEMA,
    })
    expect(definitions.bash).toMatchObject({ description: PiBash.DESCRIPTION, parameters: PiBash.SCHEMA })
    expect(definitions.edit).toMatchObject({ description: PiEdit.DESCRIPTION, parameters: PiEdit.SCHEMA })
    expect(definitions.write).toMatchObject({ description: PiWrite.DESCRIPTION, parameters: PiWrite.SCHEMA })

    expect(outputs(requests[4]!)).toEqual([
      "one\ntwo\n",
      "Successfully replaced 1 block(s) in notes.txt.",
      "Successfully wrote to out/new.txt",
      "hello pi\n",
    ])
    expect(fs.readFileSync(path.join(server.paths.workspace, "notes.txt"), "utf8")).toBe("one\nthree\n")
    expect(fs.readFileSync(path.join(server.paths.workspace, "out", "new.txt"), "utf8")).toBe("hello pi\n")
    // The edit and the write asked `edit` with the file, the command asked `shell`.
    expect(asked.filter((ask) => ask.action === "edit").map((ask) => ask.resources)).toEqual([
      ["notes.txt"],
      ["out/new.txt"],
    ])
    expect(asked.some((ask) => ask.action === "shell")).toBe(true)
    // The calls keep Pi's names in the session, for the transcript's tool cards.
    const messages = await server.messages(sessionID)
    const tools = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((part: Record<string, any>) => (part.type === "tool" ? [part.name as string] : []))
        : [],
    )
    expect(tools.toSorted()).toEqual(["bash", "edit", "read", "write"])
  }, 180_000)

  test("a failing command answers Pi's text, and an opencode session never lists Pi's tools", async () => {
    const sessionID = await create("pi", FULL)
    await gated(sessionID, Gate.PI_ALLOW)
    const { requests } = await run(sessionID, "fail on purpose", [
      { type: "tool-call", name: "bash", input: { command: "echo out; exit 3" } },
      { type: "tool-call", name: "edit", input: { path: "notes.txt", edits: [{ oldText: "absent", newText: "x" }] } },
      { type: "text", text: "failed" },
    ])
    expect(outputs(requests[2]!)).toEqual([
      "out\n\n\nCommand exited with code 3",
      "Could not find the exact text in notes.txt. The old text must match exactly including all whitespace and newlines.",
    ])

    const plain = await create("opencode")
    const [request] = (await run(plain, "plain request", [{ type: "text", text: "ok" }])).requests
    const names = (request!.tools ?? []).map((tool) => tool.name)
    expect(names).toContain("shell")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("pi_read")
    // Core's system prompt: a leading developer message on Responses routes since upstream v2.3.2 (#64542).
    expect(request!.instructions).toBeUndefined()
    expect(request!.input[0]).toMatchObject({ type: "message", role: "developer" })
  }, 180_000)

  test("compaction is the common one: the previous request plus own's checkpoint prompt (P-034), then the checkpoint", async () => {
    const sessionID = await create("pi", FULL)
    await gated(sessionID, Gate.PI_ALLOW)
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
      .map((request) => request.json as Body)
    expect(compaction).toHaveLength(1)
    expect(compaction[0]!.input[0]!.content as string).toStartWith(PiPrompt.PREAMBLE)
    expect(compaction[0]!.input.at(-1)).toMatchObject({
      role: "user",
      content: [{ text: keptPrompt("Second question about the lexer.") }],
    })
    expect((compaction[0]!.tools ?? []).map((tool) => tool.name).slice(0, 4)).toEqual(["read", "bash", "edit", "write"])
    expectFullPrefix(previous!, compaction[0]!, "input")

    const [next] = (await run(sessionID, "Third question.", [{ type: "text", text: "Third answer." }])).requests
    expect(next!.input[0]!.content as string).toStartWith(PiPrompt.PREAMBLE)
    const texts = next!.input.flatMap((item) =>
      item.type === "message" && item.role === "user"
        ? (item.content as Array<{ text: string }>).map((part) => part.text)
        : [],
    )
    const rendered = texts.find((text) => Checkpoint.isCheckpoint(text))
    expect(rendered).toContain("## Next step\n- Next step item")
    expect(rendered).toContain("<message>\nFirst question about the parser.\n</message>")
    expect(texts.at(-1)).toBe("Third question.")
  }, 180_000)

  test("a codex session switched to pi gets the notice and its exec_command call as bash", async () => {
    const sessionID = await create("codex", FULL)
    await gated(sessionID, Gate.ALLOW)
    const command = process.platform === "win32" ? "Write-Output 'hi from codex'" : "echo 'hi from codex'"
    await run(sessionID, "say hi", [
      { type: "tool-call", name: "exec_command", input: { cmd: command } },
      { type: "text", text: "said hi" },
    ])
    const switched = (await server.call("POST", `/api/rpc/${OwnHarness.ID}/session.set`, {
      body: { input: { sessionID, harness: "pi" } },
      query: { "location[directory]": server.paths.workspace },
    })) as { output?: unknown }
    expect(switched.output).toEqual({ sessionID, harness: "pi", explicit: true, prompt: "reference" })
    const permissions = (await sessionInfo(server, sessionID)).permissions
    expect(permissions).toContainEqual(Gate.PI_ALLOW)
    expect(permissions).not.toContainEqual(Gate.ALLOW)

    const [request] = (await run(sessionID, "now in pi", [{ type: "text", text: "ok" }])).requests
    expect(request!.input[0]!.content as string).toStartWith(PiPrompt.PREAMBLE)
    expect((request!.tools ?? []).map((tool) => tool.name).slice(0, 4)).toEqual(["read", "bash", "edit", "write"])
    const call = request!.input.find((item) => item.type === "function_call")
    expect(call).toMatchObject({ name: "bash" })
    expect(JSON.parse(call!.arguments as string)).toEqual({ command })
    expect(outputs(request!)[0]).toContain("hi from codex")
    const body = JSON.stringify(request!.input)
    const notice = JSON.stringify(Notice.text("codex", "pi")).slice(1, -1)
    expect(body.indexOf(notice)).toBeGreaterThan(-1)
    expect(body.indexOf(notice)).toBeLessThan(body.indexOf("now in pi"))
    expect(body).not.toContain('"exec_command"')
  }, 180_000)

  test("a session reached through a junction gets its project's AGENTS.md files as Pi's project context", async () => {
    // Core walks from the real folder and lists each AGENTS.md by its real path; the Location keeps the junction's
    // spelling, so own reads them against the real working directory (Baseline.sources).
    const real = path.join(server.paths.root, "linked")
    fs.mkdirSync(path.join(real, "pkg"), { recursive: true })
    fs.writeFileSync(path.join(real, "AGENTS.md"), "Root rules.\n")
    fs.writeFileSync(path.join(real, "pkg", "AGENTS.md"), "Package rules.\n")
    Bun.spawnSync(["git", "init", "-q"], { cwd: real })
    const link = path.join(server.paths.root, "link")
    fs.symlinkSync(real, link, "junction")
    const cwd = path.join(link, "pkg")
    const sessionID = await create("pi", FULL, cwd)
    await gated(sessionID, Gate.PI_ALLOW)
    const [request] = (await run(sessionID, "through the junction", [{ type: "text", text: "ok" }])).requests
    const prompt = request!.input[0]!.content as string
    const context = prompt.indexOf("Project-specific instructions and guidelines:")
    expect(context).toBeGreaterThan(-1)
    // Both files in Pi's project context from the root down; neither in the addendum before it.
    expect(prompt.indexOf("Root rules.")).toBeGreaterThan(context)
    expect(prompt.indexOf("Root rules.")).toBeLessThan(prompt.indexOf("Package rules."))
    expect(prompt).toEndWith(`<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`)
  }, 180_000)
})
