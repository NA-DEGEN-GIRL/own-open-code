// Subagents under every harness and approval mode, end to end on a real server with own-accounts (approval bundles and
// the read-only roles' permission hook, 07 §2.4) and own.harness, in the release's plugin order (decisions SA). A
// parent bound to a harness spawns an `explore` and a `general` child through core's `subagent` tool; the scripted
// child lists a folder, reads files and tries one write with that harness's own tools:
// - `explore` lists and reads in every harness and every mode, and never writes. Codex's exec_command and Pi's bash
//   answer its simple reads themselves (CodexReadOnly), since own-accounts denies its shell in every mode;
// - `general` lists and reads in every mode (Pi's bash answers reads in read-only and ask mode too, 12 §3.4) and writes
//   as the parent's mode allows: `full` without asking, `ask` after one approval, `read-only` never.
// The fake OpenAI Responses provider answers by script: a request's markers name the harness, agent and mode, and the
// number of tool results so far picks the step. `codex` runs GPT-5.6 Luna, a Code Mode model with MultiAgent v1, whose
// sessions keep core's `subagent` tool (codex/request.ts); its child reads through `tools.exec_command` inside `exec`.
// `omo` without own-omo and `claude-code` off the Claude Agent provider run core's tools, as `opencode` does.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  REPO_ROOT,
  openAIResponsesProvider,
  opencodeConfig,
  recordServerEvents,
  sessionInfo,
  startFakeOpenAIResponses,
  startOpencodeServer,
  toolParts,
  childOf,
  type EventRecorder,
  type FakeOpenAIResponses,
  type OpencodeServer,
  type RecordedRequest,
  type Reply,
} from "../../../own-accounts/test/e2e-kit"
import { registryWith } from "../../../own-accounts/test/slots/support.js"
import { Gate } from "../../src/gate.js"

setDefaultTimeout(120_000)

const BOOT_TIMEOUT = 240_000
const TURN_TIMEOUT = 180_000
const DIRECT = { providerID: "fake-a", id: "gpt-5.5" }
/** Code Mode with MultiAgent v1: the codex harness keeps core's `subagent` for it. */
const LUNA = { providerID: "fake-a", id: "gpt-5.6-luna" }
const HARNESSES = ["opencode", "codex", "pi", "dsh", "omo", "claude-code"] as const
const MODES = ["full", "ask", "read-only"] as const
const AGENTS = ["explore", "general"] as const
type Harness = (typeof HARNESSES)[number]
type Mode = (typeof MODES)[number]
type Agent = (typeof AGENTS)[number]

const ALPHA = "alpha content"
const BETA = "beta content"
const win = process.platform === "win32"

const fixture: { fake?: FakeOpenAIResponses; server?: OpencodeServer; events?: EventRecorder; temp?: string } = {}

beforeAll(async () => {
  const fake = startFakeOpenAIResponses({ models: ["gpt-5.5", "gpt-5.6-luna"], responder: reply })
  fixture.fake = fake
  const registry = await registryWith([])
  const server = await startOpencodeServer({
    startupTimeoutMs: BOOT_TIMEOUT - 10_000,
    env: { OWN_OPEN_CODE: "1" },
    workspaceFiles: { "data/a.txt": `${ALPHA}\n`, "data/sub/b.txt": `${BETA}\n` },
    config: (paths) => {
      fs.writeFileSync(path.join(paths.ownHome, "accounts.json"), JSON.stringify(registry, null, 2))
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { "gpt-5.5": { name: "gpt-5.5" }, "gpt-5.6-luna": { name: "gpt-5.6-luna" } },
          }),
        },
        plugins: [
          {
            package: path.join(REPO_ROOT, "packages/own-accounts"),
            options: { home: paths.ownHome, buildId: `e2e-subagents-${process.pid}`, vault: "memory" },
          },
          // Last, as in the release (10 §2).
          { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
        ],
      })
    },
  })
  fixture.server = server
  await server.waitForModels([DIRECT, LUNA])
  fixture.events = await recordServerEvents(server)
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.events?.close()
  await fixture.server?.stop()
  await fixture.fake?.stop()
}, 60_000)

for (const harness of HARNESSES)
  describe(`${harness} harness`, () => {
    for (const mode of MODES)
      test(
        `a parent in \`${mode}\`: explore lists and reads and never writes; general reads and writes as \`${mode}\` allows`,
        async () => {
          const server = required(fixture.server)
          for (const agent of AGENTS) {
            // A parent per child, so each request carries one script's markers.
            const parent = await create(harness, mode)
            const asked = asks().length
            const child = await spawn(parent, harness, mode, agent)
            const outputs = childOutputs(harness, mode, agent)
            // The listing names the folder's file and subfolder (or, for dsh's recursive glob, the file inside it).
            expect([agent, outputs]).toEqual([agent, expect.stringContaining("a.txt")])
            expect([agent, outputs]).toEqual([agent, expect.stringContaining(harness === "dsh" ? "b.txt" : "sub")])
            expect([agent, outputs]).toEqual([agent, expect.stringContaining(ALPHA)])
            const written = fs.existsSync(path.join(server.paths.workspace, writeFile(harness, mode, agent)))
            const childAsks = asks()
              .slice(asked)
              .filter((event) => event.data.sessionID === child)
              .map((event) => String(event.data.action))
            if (agent === "explore" || mode === "read-only") {
              expect([agent, written]).toEqual([agent, false])
              // Nothing is asked: reads never are, and a write or a command is refused without a card.
              expect([agent, childAsks]).toEqual([agent, []])
              continue
            }
            expect([agent, written]).toEqual([agent, true])
            // In ask mode the write (or Codex's write command) is asked once; the reads are not.
            expect([agent, childAsks]).toEqual([agent, mode === "ask" ? [harness === "codex" ? "shell" : "edit"] : []])
          }
        },
        TURN_TIMEOUT,
      )
  })

test("no hook failed and own-accounts decided every read-only role", () => {
  expect(required(fixture.server).logs()).not.toMatch(/hook_failed|readonly_role_undecided|request_hook_failed/)
})

// ---------------------------------------------------------------------------------------------------------------

/** A parent session bound to `harness`, in `mode` through own-accounts' RPC, gated for its harness's tools. */
async function create(harness: Harness, mode: Mode) {
  const server = required(fixture.server)
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `subagents ${harness} ${mode}`,
      model: harness === "codex" ? LUNA : DIRECT,
      location: { directory: server.paths.workspace },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
    },
  })) as { data: { id: string } }
  const sessionID = created.data.id
  const gate = { codex: Gate.ALLOW, pi: Gate.PI_ALLOW, dsh: Gate.DSH_ALLOW }[harness as "codex" | "pi" | "dsh"]
  const deadline = Date.now() + 15_000
  while (true) {
    const info = await sessionInfo(server, sessionID)
    const bound = OwnHarness.bound(info.metadata as Record<string, unknown>) !== undefined
    const gated = gate === undefined || JSON.stringify(info.permissions ?? []).includes(JSON.stringify(gate))
    if (bound && gated) break
    if (Date.now() > deadline) throw new Error(`own.harness did not bind ${sessionID}`)
    await Bun.sleep(50)
  }
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/session.approval.set`, {
    body: { input: { sessionID, mode } },
    query: { "location[directory]": server.paths.workspace },
    directory: server.paths.workspace,
  })
  expect([mode, response.status]).toEqual([mode, 200])
  return sessionID
}

/** One parent turn that spawns `agent`; every permission asked meanwhile is answered `once`. The child's id. */
async function spawn(parent: string, harness: Harness, mode: Mode, agent: Agent) {
  const server = required(fixture.server)
  const state = { done: false }
  const answered = new Set<string>()
  const from = asks().length
  const approving = (async () => {
    while (!state.done) {
      const pending = asks()
        .slice(from)
        .filter((event) => !answered.has(String(event.data.id)))
      await Promise.all(
        pending.map((event) => {
          answered.add(String(event.data.id))
          return server.call(
            "POST",
            `/api/session/${String(event.data.sessionID)}/permission/${String(event.data.id)}/reply`,
            { body: { decision: "once" } },
          )
        }),
      )
      await Bun.sleep(100)
    }
  })()
  await server.prompt(parent, `Delegate ${parentMarker(harness, mode, agent)}`)
  // Subagents run in the background since upstream v2.3.0 (#63382): the call returns at once, so the child's asks are
  // answered until it idles, and its report then wakes the parent.
  const child = await (async () => {
    await server.waitIdle(parent)
    const call = (await toolParts(server, parent, "subagent")).at(-1)
    expect(call?.state.status).toBe("completed")
    const found = await childOf(server, required(call))
    await server.waitIdle(found.id)
    await server.waitIdle(parent)
    return found
  })().finally(() => {
    state.done = true
  })
  await approving
  expect(child.parentID).toBe(parent)
  expect(child.agent).toBe(agent)
  return child.id
}

function asks() {
  return required(fixture.events).events.filter((event) => event.type === "permission.asked")
}

/** Every tool result the child's last request carried, as one text. */
function childOutputs(harness: Harness, mode: Mode, agent: Agent) {
  const marker = childMarker(harness, mode, agent)
  const last = required(fixture.fake)
    .requests.filter((request) => request.method === "POST" && request.body.includes(marker) && !isParent(request))
    .at(-1)
  return outputsOf(required(last)).join("\n")
}

// The scripted model ------------------------------------------------------------------------------------------------

const parentMarker = (harness: Harness, mode: Mode, agent: Agent) => `<<parent:${harness}:${mode}:${agent}>>`
const childMarker = (harness: Harness, mode: Mode, agent: Agent) => `<<child:${harness}:${mode}:${agent}>>`
const writeFile = (harness: Harness, mode: Mode, agent: Agent) => `w-${harness}-${mode}-${agent}.txt`

function isParent(request: RecordedRequest) {
  return request.body.includes("<<parent:")
}

/** The reply to a model request: the parent spawns, the child runs its script; titles and anything else get text. */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.method !== "POST") return undefined
  if (request.body.includes("You name conversations")) return { type: "text", text: "Subagents" }
  const parent = /<<parent:([a-z-]+):([a-z-]+):([a-z]+)>>/.exec(request.body)
  const child = /<<child:([a-z-]+):([a-z-]+):([a-z]+)>>/.exec(request.body)
  const step = outputsOf(request).length
  if (parent !== null) {
    const [, harness, mode, agent] = parent as unknown as [string, Harness, Mode, Agent]
    if (step > 0) return { type: "text", text: "Delegated." }
    return {
      type: "tool-call",
      name: "subagent",
      input: {
        agent,
        description: "List and read the data folder",
        prompt: `List the data folder, read its files and try one write. ${childMarker(harness, mode, agent)}`,
      },
    }
  }
  if (child === null) return { type: "text", text: "Nothing scripted." }
  const [, harness, mode, agent] = child as unknown as [string, Harness, Mode, Agent]
  return script(harness, writeFile(harness, mode, agent), toolNames(request))[step] ?? { type: "text", text: "Done." }
}

/** A child's calls in its harness's own tools: list `data`, read its files, write one file. */
function script(harness: Harness, file: string, tools: ReadonlyArray<string>): ReadonlyArray<Reply> {
  const call = (name: string, input: Record<string, unknown>): Reply => ({ type: "tool-call", name, input })
  if (harness === "codex") {
    const command = win ? `Set-Content ${file} written` : `echo written > ${file}`
    return [
      {
        type: "tool-call",
        name: "exec",
        input: {},
        freeform: [
          'text((await tools.exec_command({ cmd: "ls data" })).output);',
          'text((await tools.exec_command({ cmd: "cat data/a.txt" })).output);',
        ].join("\n"),
      },
      {
        type: "tool-call",
        name: "exec",
        input: {},
        freeform: `text(await tools.exec_command({ cmd: ${JSON.stringify(command)} }).then((r) => r.output, (e) => String(e)));`,
      },
    ]
  }
  if (harness === "pi")
    return [
      call("bash", { command: "ls data" }),
      call("read", { path: "data/a.txt" }),
      call("bash", { command: "cat data/sub/b.txt" }),
      call("write", { path: file, content: "written\n" }),
    ]
  if (harness === "dsh")
    return [
      call("glob", { pattern: "*", path: "data" }),
      call("read", { file_path: "data/a.txt" }),
      call("write", { file_path: file, content: "written\n" }),
    ]
  // opencode, omo without own-omo and claude-code off the Claude Agent provider: core's tools.
  const write = tools.includes("patch")
    ? call("patch", { patchText: ["*** Begin Patch", `*** Add File: ${file}`, "+written", "*** End Patch"].join("\n") })
    : call("write", { path: file, content: "written\n" })
  return [call("read", { path: "data" }), call("read", { path: "data/a.txt" }), write]
}

function items(request: RecordedRequest): ReadonlyArray<Record<string, unknown>> {
  const body = request.json as { input?: unknown } | undefined
  return Array.isArray(body?.input) ? (body.input as Array<Record<string, unknown>>) : []
}

/** Every tool result in a request (function and custom tool outputs), as text. */
function outputsOf(request: RecordedRequest) {
  return items(request)
    .filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output")
    .map((item) => (typeof item.output === "string" ? item.output : JSON.stringify(item.output)))
}

function toolNames(request: RecordedRequest) {
  const body = request.json as { tools?: unknown } | undefined
  return (Array.isArray(body?.tools) ? (body.tools as Array<Record<string, unknown>>) : []).map((tool) =>
    String(tool.name ?? ""),
  )
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
