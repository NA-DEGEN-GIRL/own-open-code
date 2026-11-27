// The `codex` harness end to end on a real server (source plugin, fake OpenAI Responses provider): the request has
// Codex's shape (base instructions, context fragments, contextual user message, Codex's tools first), exec_command
// runs through own's shell approval and answers in Codex's format, an `apply_patch <<'EOF'` script is intercepted, and
// a session of the `opencode` harness never sees the Codex tools. In read-only mode exec_command answers simple reads
// itself under `read` rules, protected files stay unreadable, and every other command is refused; ask mode answers the
// same reads without an approval card and asks for everything else.
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
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import GRAMMAR from "../../codex-data/apply_patch.lark" with { type: "text" }
import { Checkpoint } from "../../src/checkpoint.js"
import { Catalog } from "../../src/codex/catalog.js"
import { CodexCompaction } from "../../src/codex/compaction.js"
import { expectFullPrefix, HARNESS_PLUGINS, keptPrompt } from "./full-prefix.js"
import { CodexTools } from "../../src/codex/tools.js"
import { Gate } from "../../src/gate.js"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-5.5" }
/** A Code Mode model (nested `tools.exec_command` inside `exec`). */
const CODE_MODE = { providerID: "fake-a", id: "gpt-6.1-sol" }
/** own's `full` approval bundle, so commands and edits run without an approval card. */
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const ASK = [
  { action: "edit", resource: "**", effect: "ask" },
  { action: "shell", resource: "**", effect: "ask" },
]
const READ_ONLY = [
  { action: "edit", resource: "**", effect: "deny" },
  { action: "shell", resource: "**", effect: "deny" },
]

/** An agent whose own rules deny `websearch`, as a user's config can (RL2-M2). */
const NO_SEARCH = "no-search"

let fake: FakeOpenAIResponses
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIResponses({ models: ["gpt-5.5", "gpt-6.1-sol"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    // Project config on: core discovers the workspace AGENTS.md only then.
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    // AGENTS.md exists before the server starts, so its Location discovers it.
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "Answer in one short sentence.\n")
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { "gpt-5.5": { name: "gpt-5.5" }, "gpt-6.1-sol": { name: "gpt-6.1-sol" } },
          }),
        },
        plugins: HARNESS_PLUGINS,
        extra: {
          agents: {
            [NO_SEARCH]: {
              mode: "primary",
              description: "No web search",
              permissions: [{ action: "websearch", resource: "*", effect: "deny" }],
            },
          },
        },
      })
    },
  })
  await server.waitForModels([MODEL, CODE_MODE])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

async function create(
  metadata?: Record<string, unknown>,
  permissions: ReadonlyArray<Record<string, unknown>> = FULL,
  model = MODEL,
  agent?: string,
) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: "codex e2e",
      model,
      location: { directory: server.paths.workspace },
      permissions,
      ...(agent === undefined ? {} : { agent }),
      ...(metadata === undefined ? {} : { metadata }),
    },
  })) as { data: { id: string } }
  const sessionID = created.data.id
  const deadline = Date.now() + 15_000
  while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined) {
    if (Date.now() > deadline) throw new Error("own.harness did not stamp the session")
    await Bun.sleep(50)
  }
  return sessionID
}

async function run(sessionID: string, text: string, replies: Parameters<FakeOpenAIResponses["enqueue"]>) {
  fake.enqueue(...replies)
  const before = fake.requests.length
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
  return fake.requests
    .slice(before)
    .filter((request) => request.method === "POST")
    .map((request) => request.json as { input: Array<Record<string, any>>; tools?: Array<Record<string, any>>; [key: string]: unknown })
    .filter((body) => JSON.stringify(body.input).includes(text))
}

describe("codex harness", () => {
  test(
    "the request has Codex's shape and exec_command answers in Codex's format",
    async () => {
      const sessionID = await create()
      expect((await sessionInfo(server, sessionID)).permissions).toContainEqual(Gate.ALLOW)
      const command = process.platform === "win32" ? "Write-Output 'hi from codex'" : "echo 'hi from codex'"
      const [first, second] = await run(sessionID, "say hi", [
        { type: "tool-call", name: "exec_command", input: { cmd: command } },
        { type: "text", text: "done" },
      ])
      expect(first).toBeDefined()
      expect(first!.instructions).toBeUndefined()
      expect(first!.input[0]).toMatchObject({ type: "message", role: "developer" })
      expect(first!.input[0]!.content).toEqual([{ type: "input_text", text: Catalog.instructions(Catalog.lookup("gpt-5.5")) }])
      const developer = (first!.input[1]!.content as Array<{ text: string }>).map((item) => item.text)
      expect(developer.at(-3)).toStartWith("<permissions instructions>")
      expect(developer.at(-2)).toStartWith("<collaboration_mode># Collaboration Mode: Default")
      // Codex 0.167.0: gpt-5.5 keeps the v1 agent tools behind tool_search and names their namespace in `<tools>`.
      expect(developer.at(-1)).toBe(
        "<tools>\nDeferred tool namespaces:\n- multi_agent_v1: Tools for spawning and managing sub-agents.\n</tools>",
      )
      expect(first!.input[1]!.role).toBe("developer")
      expect(developer.at(-3)).toContain("`sandbox_mode` is `danger-full-access`")
      expect(first!.input[2]!.role).toBe("user")
      const context = JSON.stringify(first!.input[2]!.content)
      expect(context).toContain("# AGENTS.md instructions for")
      expect(context).toContain("Answer in one short sentence.")
      expect(context).toContain("<environment_context>")
      expect(first!.input[3]).toMatchObject({ role: "user" })
      const names = (first!.tools ?? []).map((tool) => tool.name)
      expect(names.slice(0, 5)).toEqual(["exec_command", "write_stdin", "request_user_input", "apply_patch", "view_image"])
      // Codex's definitions, apply_patch as a freeform grammar tool (P-020).
      expect(first!.tools![3]).toEqual({
        type: "custom",
        name: "apply_patch",
        description: CodexTools.definition("apply_patch").description,
        format: { type: "grammar", syntax: "lark", definition: GRAMMAR },
      })
      expect(first!.tools![0]).toMatchObject({
        type: "function",
        description: CodexTools.definition("exec_command").description,
        parameters: CodexTools.definition("exec_command").parameters,
      })
      expect(names).not.toContain("shell")
      expect(names).not.toContain("read")
      expect(first!.parallel_tool_calls).toBe(true)
      expect(first!.text).toEqual({ verbosity: "low" })
      const output = second!.input.find((item) => item.type === "function_call_output")
      expect(output?.output).toMatch(/^Chunk ID: [0-9a-f]{6}\nWall time: \d+\.\d{4} seconds\nProcess exited with code 0\nOriginal token count: \d+\nOutput:\n/)
      expect(output?.output).toContain("hi from codex")
    },
    120_000,
  )

  test(
    "an apply_patch heredoc through exec_command is intercepted and applied",
    async () => {
      const sessionID = await create()
      const patch = "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: added.txt\n+added by codex\n*** End Patch\nEOF"
      const [, second] = await run(sessionID, "add a file", [
        { type: "tool-call", name: "exec_command", input: { cmd: patch } },
        { type: "text", text: "added" },
      ])
      const output = second!.input.find((item) => item.type === "function_call_output")
      // The patch's own wall time is real (tenths of a second): a busy PC takes 0.1 s or more.
      expect(output?.output).toMatch(
        /^Wall time: 0\.0000 seconds\nOutput:\nExit code: 0\nWall time: \d+(\.\d)? seconds\nOutput:\nSuccess\. Updated the following files:\nA added\.txt\n$/,
      )
      expect(fs.readFileSync(path.join(server.paths.workspace, "added.txt"), "utf8")).toBe("added by codex\n")
    },
    120_000,
  )

  test(
    "a freeform apply_patch call edits the file and replays as custom tool items",
    async () => {
      const sessionID = await create()
      fs.writeFileSync(path.join(server.paths.workspace, "notes.txt"), "one\ntwo\n")
      const patch = "*** Begin Patch\n*** Update File: notes.txt\n@@\n one\n-two\n+three\n*** End Patch"
      const [, second] = await run(sessionID, "edit notes", [
        { type: "tool-call", name: "apply_patch", input: {}, freeform: patch },
        { type: "text", text: "edited" },
      ])
      expect(fs.readFileSync(path.join(server.paths.workspace, "notes.txt"), "utf8")).toBe("one\nthree\n")
      const call = second!.input.find((item) => item.type === "custom_tool_call")
      expect(call).toMatchObject({ name: "apply_patch", input: patch })
      const output = second!.input.find((item) => item.type === "custom_tool_call_output")
      expect(output?.output).toMatch(
        /^Exit code: 0\nWall time: [\d.]+ seconds\nOutput:\nSuccess\. Updated the following files:\nM notes\.txt\n$/,
      )
    },
    120_000,
  )

  test(
    "an opencode session keeps core's request and never lists the Codex tools",
    async () => {
      const sessionID = await create({ [OwnHarness.META_KEY]: OwnHarness.value("opencode") })
      const [first] = await run(sessionID, "plain request", [{ type: "text", text: "ok" }])
      const names = (first!.tools ?? []).map((tool) => tool.name)
      expect(names).not.toContain("exec_command")
      expect(names).toContain("shell")
      // Core's system prompt: a leading developer message on Responses routes since upstream v2.3.2 (#64542).
      expect(first!.instructions).toBeUndefined()
      expect(first!.input[0]).toMatchObject({ type: "message", role: "developer" })
    },
    120_000,
  )
})

describe("codex harness in read-only mode", () => {
  const win = process.platform === "win32"
  /** The protected folder outside the workspace, denied the way own-accounts writes it (absolute, forward slashes). */
  const secretDir = () => path.join(server.paths.root, "protected")
  const protectedRules = () => [
    { action: "read", resource: `${secretDir().replaceAll("\\", "/")}/**`, effect: "deny" },
    { action: "edit", resource: `${secretDir().replaceAll("\\", "/")}/**`, effect: "deny" },
  ]
  const readOnly = () => [...READ_ONLY, ...protectedRules()]
  /** own's ask bundle as own-accounts writes it. */
  const ask = () => [...ASK, ...protectedRules()]
  const workspace = (name: string) => path.join(server.paths.workspace, name)
  const readHello = win ? "Get-Content hello.txt" : "cat hello.txt"

  beforeAll(() => {
    fs.writeFileSync(workspace("hello.txt"), "hello from the workspace\n")
    fs.mkdirSync(workspace("src"), { recursive: true })
    fs.writeFileSync(workspace(path.join("src", "a.ts")), "export const a = 1\n")
    fs.mkdirSync(secretDir(), { recursive: true })
    fs.writeFileSync(path.join(secretDir(), "secret.json"), '{"token":"token-123"}\n')
  })

  const prompts = { count: 0 }

  /** One exec_command per prompt: its output, and the permission requests (each answered `reply`, `once` by default). */
  async function exec(sessionID: string, cmd: string, reply: Record<string, unknown> = { decision: "once" }) {
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
              body: reply,
            })
          }),
        )
        await Bun.sleep(100)
      }
    })()
    prompts.count++
    const requests = await run(sessionID, `Run exec ${prompts.count}.`, [
      { type: "tool-call", name: "exec_command", input: { cmd } },
      { type: "text", text: "done" },
    ]).finally(() => {
      state.done = true
    })
    await approving
    const output = requests.at(-1)!.input.findLast((item) => item.type === "function_call_output")?.output
    return { output: typeof output === "string" ? output : JSON.stringify(output), asked }
  }

  test("exec_command reads a file, searches and lists without starting a process", async () => {
    const sessionID = await create(undefined, readOnly())
    const read = await exec(sessionID, readHello)
    expect(read.output).toMatch(/^Chunk ID: [0-9a-f]{6}\nWall time: \d+\.\d{4} seconds\nProcess exited with code 0\n/)
    expect(read.output).toContain("hello from the workspace")
    const search = await exec(sessionID, "rg -n hello")
    expect(search.output).toContain("hello.txt:1:hello from the workspace")
    const files = await exec(sessionID, "rg --files")
    expect(files.output).toContain(path.join("src", "a.ts"))
    expect(files.output).toContain("hello.txt")
    const listing = await exec(sessionID, win ? "Get-ChildItem src" : "ls src")
    expect(listing.output).toContain("a.ts")
    const part = await exec(sessionID, win ? "Get-Content src/a.ts -TotalCount 1" : "head -n 1 src/a.ts")
    expect(part.output).toContain("export const a = 1")
    expect([read, search, files, listing, part].flatMap((done) => done.asked)).toEqual([])
  }, 180_000)

  test("protected files stay unreadable: directly, through a search, an absolute path and a link", async () => {
    const sessionID = await create(undefined, readOnly())
    const link = workspace("linked")
    const linked =
      Bun.spawnSync(win ? ["cmd", "/c", "mklink", "/J", link, secretDir()] : ["ln", "-s", secretDir(), link])
        .exitCode === 0
    const secret = path.join(secretDir(), "secret.json")
    // A file operand is checked like a read; a folder outside the project is not searched at all.
    const denied = /Permission denied: read/
    const outside = /searches folders only inside the project/
    const attempts: Array<readonly [string, RegExp]> = [
      [win ? "Get-Content ../protected/secret.json" : "cat ../protected/secret.json", denied],
      ["rg PATTERN ..", outside],
      [`rg PATTERN '${secretDir()}'`, outside],
      [`rg PATTERN '${secret}'`, denied],
      ...(win ? [[`Select-String -Pattern PATTERN -Path '${secret}'`, denied] as const] : []),
      ...(linked
        ? [
            [win ? "Get-Content linked/secret.json" : "cat linked/secret.json", denied] as const,
            ["rg PATTERN linked", outside] as const,
            [`rg PATTERN ${path.join("linked", "secret.json")}`, denied] as const,
          ]
        : []),
    ]
    // The answer must not depend on the pattern: one that matches the file and one that does not. Neither spells
    // the secret, so no request can carry it unless a line of the file leaks.
    const settled = (output: string) => output.replace(/^Chunk ID: \w+\nWall time: [\d.]+ seconds\n/, "")
    for (const [cmd, expected] of attempts) {
      const [hit, miss] = [
        await exec(sessionID, cmd.replace("PATTERN", "'token-12[3]'")),
        await exec(sessionID, cmd.replace("PATTERN", "'token-12[0-2]'")),
      ]
      expect([cmd, hit.output.includes("token-123")]).toEqual([cmd, false])
      expect([cmd, hit.output]).toEqual([cmd, expect.stringMatching(expected)])
      expect([cmd, settled(miss.output)]).toEqual([cmd, settled(hit.output).replace("token-12[3]", "token-12[0-2]")])
    }
    expect(fake.requests.some((request) => JSON.stringify(request.json).includes("token-123"))).toBe(false)
    if (linked) fs.rmSync(link, { recursive: false, force: true })
  }, 420_000)

  test("anything else is refused with the reads own still answers, and nothing is written", async () => {
    const sessionID = await create(undefined, readOnly())
    const writes = win
      ? [
          "Set-Content new.txt hi",
          "Get-Content hello.txt > copy.txt",
          "rg --pre x hello",
          "Get-Content hello.txt; Remove-Item hello.txt",
          // Statements the shell scanner finds no command in (P-019 asks them as a whole).
          "[IO.File]::WriteAllText('zero.txt', 'hi')",
          "'hi' > zero2.txt",
          // PowerShell ends a statement at a lone CR (P-019 scans it as a line break and asks the whole).
          "cd .\rSet-Content cr.txt hi",
        ]
      : [
          "echo hi > new.txt",
          "cat hello.txt > copy.txt",
          "rg --pre x hello",
          "cat hello.txt; rm hello.txt",
          "> zero.txt",
          "X=1",
          "cd .\rtouch cr.txt",
        ]
    for (const cmd of writes) {
      const done = await exec(sessionID, cmd)
      expect([cmd, done.output]).toEqual([cmd, expect.stringContaining("exec_command was refused")])
      expect(done.output).toContain("`Get-Content`")
    }
    ;["new.txt", "copy.txt", "zero.txt", "zero2.txt", "cr.txt"].forEach((name) =>
      expect([name, fs.existsSync(workspace(name))]).toEqual([name, false]),
    )
    expect(fs.readFileSync(workspace("hello.txt"), "utf8")).toBe("hello from the workspace\n")
  }, 240_000)

  test("the tools are those of ask mode; rules without own's protected denies serve nothing; a declined card keeps its note", async () => {
    const first = async (permissions: ReadonlyArray<Record<string, unknown>>, text: string) =>
      (await run(await create(undefined, permissions), text, [{ type: "text", text: "ok" }]))[0]!.tools
    // Only web search differs by mode: Codex's hosted web_search in full approval, own's websearch (which asks, when a
    // search service is set) otherwise (request.ts `hostedSearch`, MR12-5).
    const names = (tools: Array<Record<string, any>> | undefined) => (tools ?? []).map((tool) => tool.name ?? tool.type)
    const search = (tools: Array<Record<string, any>> | undefined) =>
      names(tools).filter((name) => name !== "web_search" && name !== "websearch")
    const readOnlyTools = await first(readOnly(), "Tools in read-only.")
    expect(readOnlyTools).toEqual(await first(ASK, "Tools in ask."))
    expect(readOnlyTools).toEqual(await first(ask(), "Tools in own's ask."))
    const fullTools = await first(FULL, "Tools in full.")
    expect(search(readOnlyTools)).toEqual(search(fullTools))
    expect(names(fullTools)).toContain("web_search")
    expect(names(readOnlyTools)).not.toContain("web_search")
    // An agent whose rules deny a search never gets the hosted search in full approval: it cannot meet the deny
    // own-accounts keeps (RL2-M2). Here the deny of `*` is the last websearch rule, so core leaves own's websearch out
    // too (with a full bundle's websearch allow after it, own's websearch goes and the hook denies each query).
    const denied = (await run(await create(undefined, FULL, MODEL, NO_SEARCH), "Tools without search.", [
      { type: "text", text: "ok" },
    ]))[0]!.tools
    expect(names(denied)).not.toContain("web_search")
    expect(search(denied)).toEqual(search(fullTools))

    // Ask rules without own's protected denies serve no reads: the read asks like any command.
    const asked = await exec(await create(undefined, ASK), readHello)
    expect(asked.asked.map((request) => request.action)).toEqual(["shell"])
    expect(asked.output).toContain("hello from the workspace")

    const custom = await exec(await create(undefined, READ_ONLY), readHello)
    expect(custom.output).not.toContain("hello from the workspace")
    expect(custom.output).not.toContain("exec_command was refused")
    expect(custom.output).toMatch(/denied/i)

    // Only a rule's deny becomes the refused text: a user's decline with a note reaches the model as the note.
    const declined = await exec(
      await create(undefined, [...readOnly(), { action: "shell", resource: "git status *", effect: "ask" }]),
      "git status",
      { decision: "reject", message: "Read the files instead." },
    )
    expect(declined.asked.map((request) => request.action)).toEqual(["shell"])
    expect(declined.output).toContain("Read the files instead.")
    expect(declined.output).not.toContain("exec_command was refused")
  }, 240_000)

  test("ask mode answers the same reads without a card; protected files stay denied; anything else still asks (RO-D4)", async () => {
    const sessionID = await create(undefined, ask())
    const read = await exec(sessionID, readHello)
    expect(read.output).toMatch(/^Chunk ID: [0-9a-f]{6}\nWall time: \d+\.\d{4} seconds\nProcess exited with code 0\n/)
    expect(read.output).toContain("hello from the workspace")
    const search = await exec(sessionID, "rg -n hello")
    expect(search.output).toContain("hello.txt:1:hello from the workspace")
    const listing = await exec(sessionID, win ? "Get-ChildItem src" : "ls src")
    expect(listing.output).toContain("a.ts")
    expect([read, search, listing].flatMap((done) => done.asked)).toEqual([])

    // The protected deny holds in ask mode too, with no card that could let the read through.
    const secret = await exec(sessionID, win ? "Get-Content ../protected/secret.json" : "cat ../protected/secret.json")
    expect(secret.output).toMatch(/Permission denied: read/)
    expect(secret.output).not.toContain("token-123")
    expect(secret.asked).toEqual([])
    const outside = await exec(sessionID, "rg token ..")
    expect(outside.output).toMatch(/searches folders only inside the project/)
    expect(outside.asked).toEqual([])

    // A write is no read: it asks, and the user's note reaches the model as in any ask session.
    const write = win ? "Set-Content asked.txt hi" : "echo hi > asked.txt"
    const declined = await exec(sessionID, write, { decision: "reject", message: "Not now." })
    expect(declined.asked.map((request) => request.action)).toEqual(["shell"])
    expect(declined.output).toContain("Not now.")
    expect(declined.output).not.toContain("exec_command was refused")
    expect(fs.existsSync(workspace("asked.txt"))).toBe(false)
    expect(fake.requests.some((request) => JSON.stringify(request.json).includes("token-123"))).toBe(false)
  }, 240_000)

  test("write_stdin reaches no process started before the switch to read-only", async () => {
    const sessionID = await create()
    const marker = workspace("stdin.txt")
    // A process that writes what it reads; Windows PowerShell's first collection waits 10 s (manager.ts).
    const cmd = win
      ? "$line = [Console]::In.ReadLine(); Set-Content -Path stdin.txt -Value $line"
      : 'read line; printf "%s" "$line" > stdin.txt'
    const started = await run(sessionID, "Start the reader.", [
      { type: "tool-call", name: "exec_command", input: { cmd, tty: true, yield_time_ms: 500 } },
      { type: "text", text: "started" },
    ])
    const id = Number(
      /Process running with session ID (\d+)/.exec(
        String(started.at(-1)!.input.findLast((item) => item.type === "function_call_output")?.output),
      )?.[1],
    )
    expect(id).toBeGreaterThan(0)
    const switchTo = async (bundle: ReadonlyArray<Record<string, unknown>>) => {
      const own = [...FULL, ...readOnly()].map((rule) => JSON.stringify(rule))
      const rules = ((await sessionInfo(server, sessionID)).permissions ?? []) as Array<Record<string, unknown>>
      const permissions = [...rules.filter((rule) => !own.includes(JSON.stringify(rule))), ...bundle]
      await server.call("PATCH", `/api/session/${sessionID}`, { body: { permissions } })
    }
    const write = async (chars: string, text: string) => {
      const requests = await run(sessionID, text, [
        { type: "tool-call", name: "write_stdin", input: { session_id: id, chars, yield_time_ms: 2_000 } },
        { type: "text", text: "written" },
      ])
      return String(requests.at(-1)!.input.findLast((item) => item.type === "function_call_output")?.output)
    }
    await switchTo(readOnly())
    expect(await write("hi\n", "Type into it.")).toStartWith("write_stdin failed: in read-only approval mode")
    expect(await write("", "Poll it.")).toStartWith("write_stdin failed: in read-only approval mode")
    await Bun.sleep(1_000)
    expect(fs.existsSync(marker)).toBe(false)
    // Back in full access the same process takes the line, so only the mode stood in the way.
    await switchTo(FULL)
    await write("hi\n", "Type into it again.")
    const deadline = Date.now() + 15_000
    while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(100)
    expect(fs.readFileSync(marker, "utf8").trim()).toBe("hi")
    fs.rmSync(marker, { force: true })
  }, 180_000)

  test("view_image asks `read` like any file read, so a protected image is refused in every mode", async () => {
    // Full access with own's protected denies after it, as own-accounts writes the bundle.
    const sessionID = await create(undefined, [...FULL, ...protectedRules()])
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    )
    fs.writeFileSync(workspace("dot.png"), png)
    fs.writeFileSync(path.join(secretDir(), "dot.png"), png)
    const view = async (file: string, text: string) => {
      const requests = await run(sessionID, text, [
        { type: "tool-call", name: "view_image", input: { path: file } },
        { type: "text", text: "seen" },
      ])
      return JSON.stringify(requests.at(-1)!.input.findLast((item) => item.type === "function_call_output")?.output)
    }
    const seen = await view("dot.png", "Look at the dot.")
    expect(seen).not.toMatch(/denied/i)
    expect(seen).toContain("image")
    expect(await view(path.join(secretDir(), "dot.png"), "Look at the protected dot.")).toContain(
      "Permission denied: read",
    )
  }, 180_000)

  test("Code Mode's nested exec_command is served and refused the same way", async () => {
    const sessionID = await create(undefined, readOnly(), CODE_MODE)
    const write = win ? "Set-Content new.txt hi" : "echo hi > new.txt"
    const program = [
      `const read = await tools.exec_command({ cmd: ${JSON.stringify(readHello)} });`,
      "text(read.output);",
      `text(await tools.exec_command({ cmd: ${JSON.stringify(write)} }).then(() => "ran", (error) => String(error)));`,
    ].join("\n")
    const requests = await run(sessionID, "Read in Code Mode.", [
      { type: "tool-call", name: "exec", input: {}, freeform: program },
      { type: "text", text: "done" },
    ])
    const output = JSON.stringify(
      requests.at(-1)!.input.findLast((item) => item.type === "custom_tool_call_output")?.output,
    )
    expect(output).toContain("hello from the workspace")
    expect(output).toContain("exec_command was refused")
    expect(fs.existsSync(workspace("new.txt"))).toBe(false)
  }, 180_000)
})
describe("codex goals", () => {
  test(
    "an active goal continues the session with Codex's hidden message until update_goal completes it",
    async () => {
      const sessionID = await create()
      fake.enqueue(
        { type: "tool-call", name: "create_goal", input: { objective: "Write the release notes" } },
        { type: "text", text: "Started." },
        { type: "tool-call", name: "update_goal", input: { status: "complete" } },
        { type: "text", text: "Finished." },
      )
      const before = fake.requests.length
      await server.prompt(sessionID, "Set a goal to write the release notes.")
      const bodies = () =>
        fake.requests
          .slice(before)
          .filter((request) => request.method === "POST")
          .map((request) => JSON.stringify(request.json))
      const deadline = Date.now() + 60_000
      while (bodies().length < 4 && Date.now() < deadline) await Bun.sleep(100)
      await server.waitIdle(sessionID)
      const sent = bodies()
      expect(sent).toHaveLength(4)
      // The second request carries create_goal's output; the third starts the automatic turn.
      expect(sent[1]).toContain('\\"objective\\":\\"Write the release notes\\"')
      expect(sent[2]).toContain('<codex_internal_context source=\\"goal\\">')
      expect(sent[2]).toContain("Continue working toward the active thread goal.")
      expect(sent[3]).toContain('\\"status\\":\\"complete\\"')
      // A complete goal does not continue.
      await Bun.sleep(1_500)
      expect(bodies()).toHaveLength(4)
    },
    120_000,
  )
})

describe("codex compaction", () => {
  test(
    "compaction sends the previous request byte for byte plus the checkpoint prompt naming the kept start (P-034); later requests carry the checkpoint",
    async () => {
      const sessionID = await create()
      await run(sessionID, "First question about the parser.", [{ type: "text", text: "First answer." }])
      const [previous] = await run(sessionID, "Second question about the lexer.", [{ type: "text", text: "Second answer." }])
      const checkpoint = Checkpoint.SECTIONS.map((heading) => `${heading}\n- ${heading.replace(/#/g, "").trim()} item`).join("\n")
      fake.enqueue({ type: "text", text: `<checkpoint>\n${checkpoint}\n</checkpoint>` })
      const before = fake.requests.length
      await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
      await server.waitIdle(sessionID)
      const compaction = fake.requests
        .slice(before)
        .filter((request) => request.method === "POST")
        .map((request) => request.json as { input: Array<Record<string, any>>; tools?: unknown[] })
      expect(compaction).toHaveLength(1)
      expect(compaction[0]!.input.at(-1)).toMatchObject({
        role: "user",
        content: [{ text: keptPrompt("Second question about the lexer.") }],
      })
      expect((compaction[0]!.tools ?? []).length).toBeGreaterThan(0)
      expectFullPrefix(previous!, compaction[0]!, "input")

      const [next] = await run(sessionID, "Third question.", [{ type: "text", text: "Third answer." }])
      const texts = next!.input.flatMap((item) =>
        item.type === "message" && item.role === "user" ? (item.content as Array<{ text: string }>).map((part) => part.text) : [],
      )
      expect(texts.some((text) => text.startsWith(`${CodexCompaction.SUMMARY_PREFIX}\n`))).toBe(false)
      const rendered = texts.find((text) => Checkpoint.isCheckpoint(text))
      expect(rendered).toContain("## Next step\n- Next step item")
      expect(rendered).toContain("<message>\nFirst question about the parser.\n</message>")
      expect(texts.at(-1)).toBe("Third question.")
    },
    120_000,
  )
})
