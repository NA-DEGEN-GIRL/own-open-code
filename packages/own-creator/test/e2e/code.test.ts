// Code extensions end to end (own/docs/17 §11, §12), on a fake model: creator mode authors a generated MCP server (C2)
// with an allow-listed dependency from a fake registry; staging installs, typechecks, runs its tests and smoke-tests
// it; calls ask (묻기 every time, 전체 허용 once per version), a refusal stops the call, the server reads only the
// project (never own's vault), a new version hot-reloads, a broken one keeps the previous, a rollback brings v1 back,
// and Settings stops and starts it. Then C3: refused while the switch is off; with it on, staging failures, the user's
// approval of the exact version, its config entry and trust approval, the hook in effect, a hook that throws in the
// service stops the plugin in that Location while the service goes on, and a rollback.
// Run from a path without '#': `bun run test:e2e` in packages/own-creator.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { waitUntil } from "../../../own-accounts/test/e2e-kit"
import { startRegistry, type FakeRegistry } from "../unit/registry.js"
import { ASK, boot, BOOT_TIMEOUT, FULL, READONLY, rpc, session, toolNames, toolResults, turn, type Rig } from "./kit.js"

setDefaultTimeout(240_000)

const helper = `import { serve } from "./own-mcp"
import { parse } from "yaml"

serve({
  name: "words",
  tools: {
    count_words: {
      description: "Counts the words of a text.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: (args) => \`__PREFIX__: \${String(args.text).split(" ").filter(Boolean).length}\`,
    },
    parse_yaml: {
      description: "Parses YAML.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: (args) => parse(String(args.text)),
    },
    read_file: {
      description: "Reads a file of the project.",
      input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      run: async (args, context) => context.files.read(String(args.path)),
    },
    where: { description: "The project folder.", run: (_, context) => context.project },
  },
})
`

const server = (prefix: string, extra = "") => ({
  format: "own.ext/1",
  id: "words",
  title: "Words",
  kind: "mcp",
  items: [
    {
      type: "mcp.server",
      name: "words",
      dependencies: { yaml: "9.9.9" },
      files: {
        "server.ts": helper.replace("__PREFIX__", prefix) + extra,
        "words.test.ts": `import { expect, test } from "./own-mcp"\ntest("arithmetic", () => expect(1 + 1).toBe(2))\n`,
      },
      smoke: [{ tool: "count_words", arguments: { text: "a b" }, expect: `${prefix}: 2` }],
    },
  ],
})

const PLUGIN_NOTE = "PLUGIN-NOTE: answer like a pirate."
const plugin = (body: string) => ({
  format: "own.ext/1",
  id: "pirate",
  title: "Pirate",
  kind: "plugin",
  items: [
    {
      type: "plugin.code",
      hooks: ["context"],
      files: {
        "plugin.ts": `import { definePlugin } from "./own-plugin.ts"\n\nexport default definePlugin({\n  hooks: {\n    context: (request) => {\n${body}\n      request.messages.push({ role: "user", content: [{ type: "text", text: ${JSON.stringify(PLUGIN_NOTE)} }] })\n    },\n  },\n})\n`,
      },
    },
  ],
})

let rig: Rig
let registry: FakeRegistry
let creator: string

const manage = (input: Record<string, unknown>) => ({ type: "tool-call" as const, name: "creator_manage", input })
const call = (tool: string, args: Record<string, unknown>) => ({
  type: "tool-call" as const,
  name: "execute",
  input: { code: `return await tools["creator-words-words"].${tool}(${JSON.stringify(args)})` },
})
const listed = async () =>
  (await rpc(rig.server, "list", {})) as unknown as {
    extensions: Array<{
      id: string
      status: string
      kind: string
      active: number
      confirmed: number[]
      trusted: number[]
      crashes: Array<{ directory: string; version: number; hook: string; message: string }>
    }>
    settings: { plugins: boolean }
    stages: { plugin: boolean }
    stopped: string[]
  }
const extension = async (id: string) => (await listed()).extensions.find((item) => item.id === id)
const resultOf = (run: Awaited<ReturnType<typeof turn>>) => toolResults(run.requests.at(-1)!).join("\n")
const configPlugins = () =>
  (JSON.parse(fs.readFileSync(path.join(rig.server.paths.config, "opencode.jsonc"), "utf8")) as { plugins: unknown[] })
    .plugins
const trustFile = () => {
  const file = path.join(rig.home, "trust.json")
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, string>>) : []
}

beforeAll(async () => {
  registry = await startRegistry()
  rig = await boot({ env: { OPENCODE_DISABLE_FILEWATCHER: undefined }, creator: { registry: registry.url } })
  creator = await session(rig.server, { agent: "creator", permissions: ASK })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await rig?.server.stop()
  await rig?.fake.stop()
  await registry?.stop()
}, 60_000)

describe("C2: a generated MCP server", () => {
  test("a server that imports node:fs is refused before anything is asked", async () => {
    const bad = server("words")
    bad.items[0]!.files["server.ts"] = `import fs from "node:fs"\n${bad.items[0]!.files["server.ts"]}`
    const run = await turn(rig, creator, "make it", [manage({ action: "create", extension: bad }), { type: "text", text: "no" }])
    expect(run.asked).toEqual([])
    expect(resultOf(run)).toContain("may not import 'node:fs'")
    expect(await extension("words")).toBeUndefined()
  })

  test("authoring asks with the install on the card, then stages and activates it; Code Mode keeps the tool list", async () => {
    const plain = await session(rig.server, { permissions: ASK })
    const before = await turn(rig, plain, "hello", [{ type: "text", text: "hi" }])
    const run = await turn(rig, creator, "make a words server", [
      manage({ action: "create", extension: server("words") }),
      { type: "text", text: "made" },
    ])
    const ask = run.asked.find((item) => item.action === "creator")
    expect(ask?.resources.join("\n")).toContain("의존성 설치(words): yaml@9.9.9")
    expect(ask?.resources.join("\n")).toContain("샌드박스")
    const result = resultOf(run)
    expect(result).toContain('"ok": true')
    for (const name of ["words: install", "words: typecheck", "words: tests", "words: smoke"]) expect(result).toContain(name)
    expect(await extension("words")).toMatchObject({ status: "active", kind: "mcp", active: 1 })
    expect(registry.requests).toContain("/yaml")
    const after = await turn(rig, plain, "again", [{ type: "text", text: "hi" }])
    expect(toolNames(after.requests[0]!)).toEqual(toolNames(before.requests[0]!))
  })

  test("묻기 asks every call; a refusal stops it; the server works in the project and reads no vault", async () => {
    const plain = await session(rig.server, { permissions: ASK })
    fs.mkdirSync(path.join(rig.home, "vault"), { recursive: true })
    fs.writeFileSync(path.join(rig.home, "vault", "acc_x.dpapi"), "VAULT-SECRET")
    fs.writeFileSync(path.join(rig.server.paths.workspace, "notes.txt"), "PROJECT-NOTES")
    const first = await turn(rig, plain, "count", [call("count_words", { text: "one two three" }), { type: "text", text: "ok" }])
    expect(first.asked.map((item) => item.action)).toEqual(["creator-words-words_count_words"])
    expect(resultOf(first)).toContain("words: 3")
    const second = await turn(rig, plain, "count again", [call("count_words", { text: "x" }), { type: "text", text: "ok" }])
    expect(second.asked.map((item) => item.action)).toEqual(["creator-words-words_count_words"])
    const parsed = await turn(rig, plain, "parse", [call("parse_yaml", { text: "a: 1" }), { type: "text", text: "ok" }])
    expect(resultOf(parsed)).toContain("parsed:a: 1")

    const refused = await turn(
      rig,
      plain,
      "count, refused",
      [call("count_words", { text: "no" }), { type: "text", text: "ok" }],
      { decision: "reject" },
    )
    expect(refused.asked.map((item) => item.action)).toEqual(["creator-words-words_count_words"])
    // The declined call never reaches the server: its tool result is the refusal, not a count.
    const declined = refused.requests.flatMap((request) => toolResults(request)).at(-1) ?? ""
    expect(declined).toContain("Declined")
    expect(declined).not.toContain("words:")

    const where = await turn(rig, plain, "where", [call("where", {}), { type: "text", text: "ok" }])
    expect(resultOf(where)).toContain(path.basename(rig.server.paths.workspace))
    const notes = await turn(rig, plain, "notes", [call("read_file", { path: "notes.txt" }), { type: "text", text: "ok" }])
    expect(resultOf(notes)).toContain("PROJECT-NOTES")
    const vault = path.relative(rig.server.paths.workspace, path.join(rig.home, "vault", "acc_x.dpapi"))
    const stolen = await turn(rig, plain, "vault", [call("read_file", { path: vault }), { type: "text", text: "ok" }])
    expect(resultOf(stolen)).toContain("leaves the project")
    const absolute = await turn(rig, plain, "vault2", [
      call("read_file", { path: path.join(rig.home, "vault", "acc_x.dpapi") }),
      { type: "text", text: "ok" },
    ])
    expect(resultOf(absolute)).not.toContain("VAULT-SECRET")
    expect(resultOf(stolen)).not.toContain("VAULT-SECRET")
  })

  test("전체 허용 lets calls of a version through once the user approved one of its calls", async () => {
    const full = await session(rig.server, { permissions: FULL })
    // The calls approved under 묻기 above were version 1's first use; a new version asks again (next test).
    await waitUntil(async () => (await extension("words"))?.confirmed.includes(1) === true, "version 1 confirmed")
    const first = await turn(rig, full, "count", [call("count_words", { text: "a" }), { type: "text", text: "ok" }])
    expect(first.asked).toEqual([])
    const second = await turn(rig, full, "count", [call("count_words", { text: "a b" }), { type: "text", text: "ok" }])
    expect(second.asked).toEqual([])
    expect(resultOf(second)).toContain("words: 2")
  })

  test("읽기 전용 refuses a confirmed C2 tool outright, without asking (F4; servers.ts deny)", async () => {
    // own-creator's servers hook denies a C2 tool under read-only approval, whatever the version's confirmed state;
    // own-accounts' read-only roles (explore, own-review) also deny by the `creator-` prefix (readonly.test.ts).
    await waitUntil(async () => (await extension("words"))?.confirmed.includes(1) === true, "version 1 confirmed")
    const readonly = await session(rig.server, { permissions: READONLY })
    const run = await turn(rig, readonly, "count readonly", [call("count_words", { text: "a b c" }), { type: "text", text: "ok" }])
    expect(run.asked).toEqual([])
    const result = resultOf(run)
    expect(result).not.toContain("words: 3")
    expect(result).toContain("읽기 전용")
  })

  test("a new version hot-reloads; a broken one keeps it; a rollback brings v1 back", async () => {
    const full = await session(rig.server, { permissions: FULL })
    const updated = await turn(rig, creator, "v2", [
      manage({ action: "update", extension: server("count"), note: "count prefix" }),
      { type: "text", text: "ok" },
    ])
    expect(resultOf(updated)).toContain('"ok": true')
    expect(await extension("words")).toMatchObject({ active: 2, status: "active" })
    // A new version asks its first call again under 전체 허용.
    const v2 = await turn(rig, full, "count v2", [call("count_words", { text: "a b" }), { type: "text", text: "ok" }])
    expect(v2.asked.map((item) => item.action)).toEqual(["creator-words-words_count_words"])
    expect(resultOf(v2)).toContain("count: 2")

    const broken = await turn(rig, creator, "v3", [
      manage({ action: "update", extension: server("broken", "\nconst wrong: string = 1\n") }),
      { type: "text", text: "hm" },
    ])
    expect(resultOf(broken)).toContain("stage_failed")
    expect(resultOf(broken)).toContain("TS2322")
    expect(await extension("words")).toMatchObject({ active: 2, status: "active" })
    const still = await turn(rig, full, "count v2 still", [call("count_words", { text: "a" }), { type: "text", text: "ok" }])
    expect(resultOf(still)).toContain("count: 1")

    const back = await turn(rig, creator, "rollback", [
      manage({ action: "rollback", id: "words", version: 1 }),
      { type: "text", text: "ok" },
    ])
    expect(resultOf(back)).toContain('"ok": true')
    const v1 = await turn(rig, full, "count v1", [call("count_words", { text: "a b c d" }), { type: "text", text: "ok" }])
    expect(v1.asked).toEqual([])
    expect(resultOf(v1)).toContain("words: 4")
  })

  test("Settings stops and starts the server, and its log shows starts, stderr and the stop", async () => {
    const full = await session(rig.server, { permissions: FULL })
    const stopped = (await rpc(rig.server, "mcp.stop", { id: "words" })) as { stopped: string[] }
    expect(stopped.stopped).toEqual(["words"])
    const off = await turn(rig, full, "count stopped", [call("count_words", { text: "a" }), { type: "text", text: "ok" }])
    expect(resultOf(off)).not.toContain("words: 1")
    await rpc(rig.server, "mcp.start", { id: "words" })
    await waitUntil(async () => {
      const on = await turn(rig, full, "count started", [call("count_words", { text: "a" }), { type: "text", text: "ok" }])
      return resultOf(on).includes("words: 1")
    }, "the server answers again")
    const log = (await rpc(rig.server, "log.get", { id: "words" })) as { lines: string[] }
    const text = log.lines.join("\n")
    expect(text).toContain("start words v1 words")
    expect(text).toContain("stopped by the user")
    expect(text).toContain("stage words: smoke ok")
  })
})

describe("C3: a code plugin, off by default", () => {
  test("is refused while the switch is off", async () => {
    expect((await listed()).settings.plugins).toBe(false)
    const run = await turn(rig, creator, "plugin", [manage({ action: "create", extension: plugin("") }), { type: "text", text: "no" }])
    expect(resultOf(run)).toContain("plugins_off")
    expect(run.asked).toEqual([])
    expect(await extension("pirate")).toBeUndefined()
  })

  test("with the switch on, staging failures write nothing", async () => {
    const on = await rpc(rig.server, "plugins.set", { enabled: true })
    expect(on).toMatchObject({ settings: { plugins: true }, stages: { plugin: true } })
    const throws = await turn(rig, creator, "throws", [
      manage({ action: "create", extension: plugin(`      throw new Error("boom in staging")`) }),
      { type: "text", text: "no" },
    ])
    expect(resultOf(throws)).toContain("stage.e2e context")
    const untyped = await turn(rig, creator, "untyped", [
      manage({ action: "create", extension: plugin(`      const wrong: string = 1`) }),
      { type: "text", text: "no" },
    ])
    expect(resultOf(untyped)).toContain("stage.typecheck")
    expect(await extension("pirate")).toBeUndefined()
  })

  test("a staged version waits for the user's approval; approved, it loads at the end of plugins with its trust", async () => {
    const plain = await session(rig.server)
    const made = await turn(rig, creator, "make", [manage({ action: "create", extension: plugin("") }), { type: "text", text: "ok" }])
    expect(resultOf(made)).toContain('"ok": true')
    expect(resultOf(made)).toContain("golden context prefix")
    expect(await extension("pirate")).toMatchObject({ status: "pending", kind: "plugin" })
    const before = await turn(rig, plain, "hello", [{ type: "text", text: "hi" }])
    expect(before.requests[0]!.body).not.toContain(PLUGIN_NOTE)
    expect(JSON.stringify(configPlugins())).not.toContain("creator/ext/pirate")

    await rpc(rig.server, "trust.set", { id: "pirate", version: 1, trusted: true })
    expect(await extension("pirate")).toMatchObject({ status: "active", trusted: [1] })
    const last = configPlugins().at(-1) as { package: string; options: { version: number } }
    expect(last.package).toContain("creator/ext/pirate/v1")
    expect(last.options.version).toBe(1)
    const approvals = trustFile().filter((entry) => entry.source.includes(path.join("ext", "pirate", "v1")))
    expect(approvals.map((entry) => entry.location)).toContain(rig.server.paths.workspace)
    const folderHash = (await rpc(rig.server, "list", {})) as unknown as {
      extensions: Array<{ id: string; versions: Array<{ n: number; hash: string }> }>
    }
    expect(approvals[0]!.sha256).toBe(folderHash.extensions.find((item) => item.id === "pirate")!.versions[0]!.hash)
    await waitUntil(async () => {
      const run = await turn(rig, plain, "ahoy", [{ type: "text", text: "arr" }])
      return run.requests[0]!.body.includes(PLUGIN_NOTE)
    }, "the plugin's note reaches the request")
  })

  test("a hook that throws in the service stops the plugin in that Location; the service goes on; rollback", async () => {
    const plain = await session(rig.server)
    const v2 = plugin(`      if (JSON.stringify(request.messages).includes("CRASH-NOW")) throw new Error("boom in the service")`)
    const made = await turn(rig, creator, "v2", [manage({ action: "update", extension: v2 }), { type: "text", text: "ok" }])
    expect(resultOf(made)).toContain('"ok": true')
    expect(await extension("pirate")).toMatchObject({ status: "pending", active: 2 })
    await rpc(rig.server, "trust.set", { id: "pirate", version: 2, trusted: true })
    await waitUntil(async () => {
      const run = await turn(rig, plain, "ahoy v2", [{ type: "text", text: "arr" }])
      return run.requests[0]!.body.includes(PLUGIN_NOTE)
    }, "v2 loads")
    const crashed = await turn(rig, plain, "CRASH-NOW please", [{ type: "text", text: "survived" }])
    expect(crashed.requests).toHaveLength(1)
    expect(crashed.requests[0]!.body).not.toContain(PLUGIN_NOTE)
    await waitUntil(async () => ((await extension("pirate"))?.crashes.length ?? 0) > 0, "the crash is reported")
    expect((await extension("pirate"))!.crashes[0]).toMatchObject({
      directory: rig.server.paths.workspace,
      version: 2,
      hook: "context",
    })
    const after = await turn(rig, plain, "and now", [{ type: "text", text: "still here" }])
    expect(after.requests[0]!.body).not.toContain(PLUGIN_NOTE)

    await rpc(rig.server, "rollback", { id: "pirate", version: 1 })
    await waitUntil(async () => {
      const run = await turn(rig, plain, "back to v1", [{ type: "text", text: "arr" }])
      return run.requests[0]!.body.includes(PLUGIN_NOTE)
    }, "v1 is back")
    expect((configPlugins().at(-1) as { package: string }).package).toContain("creator/ext/pirate/v1")
  })

  test("the switch off unloads it: its config entry and trust approval go", async () => {
    await rpc(rig.server, "plugins.set", { enabled: false })
    expect(await extension("pirate")).toMatchObject({ status: "unavailable" })
    expect(JSON.stringify(configPlugins())).not.toContain("creator/ext/pirate")
    expect(trustFile().filter((entry) => entry.source.includes(path.join("ext", "pirate")))).toEqual([])
  })
})
