// Creator mode end to end (own/docs/17): a fake model in a `creator` session writes an extension of every C1 type
// through creator_manage, and the running service applies it without a restart; a broken version is refused, a
// tampered one stops applying, a rollback brings the earlier version back, project folders limit where it applies,
// writes ask outside full approval, allow rules wait for Settings, and C0's agents, commands, skills and 내 지시문 land.
// Run from a path without '#': `bun run test:e2e` in packages/own-creator.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { instructionEntries, waitUntil } from "../../../own-accounts/test/e2e-kit"
import { ASK, boot, BOOT_TIMEOUT, body, FULL, rpc, session, toolNames, toolResults, turn, type Rig } from "./kit.js"

setDefaultTimeout(180_000)

const FRAGMENT = "HOUSE-RULE-FRAGMENT: answer in one sentence."
const PI_ONLY = "PI-ONLY-FRAGMENT"
const ADDITION = "COMPACTION-ADDITION: keep the word pelican."

const EXTENSION = {
  format: "own.ext/1",
  id: "house-rules",
  title: "House rules",
  items: [
    { type: "prompt.fragment", id: "style", text: FRAGMENT },
    { type: "prompt.fragment", id: "pi-only", text: PI_ONLY, when: { harness: ["pi"] } },
    {
      type: "tool.command",
      name: "say",
      description: "Says a word back.",
      command: "echo {{word}}",
      params: { word: { type: "string", description: "The word" } },
    },
    {
      type: "tool.rule",
      rules: [
        { tool: "webfetch", effect: "deny", reason: "no web in this test" },
        { permission: "shell", pattern: "*forbidden*", effect: "deny", reason: "not that word" },
      ],
    },
    { type: "retry", maxRetries: 1, maxDelaySeconds: 2 },
    { type: "compaction.prompt", text: ADDITION },
  ],
}

let rig: Rig
let creator: string
let plain: string

type Listed = {
  extensions: Array<{
    id: string
    status: string
    active: number
    enabled: boolean
    versions: unknown[]
    loosenPending: boolean
  }>
}

const listed = async () => (await rpc(rig.server, "list", {})) as unknown as Listed
const extension = async (id: string) => (await listed()).extensions.find((item) => item.id === id)
const entryKeys = async (sessionID: string) =>
  (await instructionEntries(rig.server, sessionID)).map((entry) => String(entry.key))
const entryValue = async (sessionID: string, key: string) =>
  (await instructionEntries(rig.server, sessionID)).find((entry) => entry.key === key)?.value
const manage = (input: Record<string, unknown>) => ({ type: "tool-call" as const, name: "creator_manage", input })
const say = (word: string) => ({
  type: "tool-call" as const,
  name: "execute",
  input: { code: `return await tools.ext_say({ word: ${JSON.stringify(word)} })` },
})

beforeAll(async () => {
  rig = await boot()
  creator = await session(rig.server, { agent: "creator" })
  plain = await session(rig.server)
}, BOOT_TIMEOUT)

afterAll(async () => {
  await rig?.server.stop()
  await rig?.fake.stop()
}, 60_000)

describe("creator mode", () => {
  test("its tools, skills and guidance are only in creator sessions", async () => {
    const other = await turn(rig, plain, "hello", [{ type: "text", text: "hi" }])
    expect(toolNames(other.requests[0]!).filter((name) => name.startsWith("creator_"))).toEqual([])
    expect(other.requests[0]!.body).not.toContain("own-creator-extensions")
    const mine = await turn(rig, creator, "what can I make?", [{ type: "text", text: "much" }])
    expect(toolNames(mine.requests[0]!)).toEqual(expect.arrayContaining(["creator_inspect", "creator_manage"]))
    expect(mine.requests[0]!.body).toContain("own-creator-extensions")
    expect(mine.requests[0]!.body).toContain("You are in creator mode")
    expect(await entryKeys(creator)).toContain("own.creator.mode")
    expect(await entryKeys(plain)).not.toContain("own.creator.mode")
  })

  test("inspect shows the format's schema without asking", async () => {
    const run = await turn(rig, creator, "show the schema", [
      { type: "tool-call", name: "creator_inspect", input: { topic: "schema" } },
      { type: "text", text: "seen" },
    ])
    expect(run.asked).toEqual([])
    const result = toolResults(run.requests.at(-1)!).join("\n")
    expect(result).toContain("own.ext/1")
    expect(result).toContain("prompt.fragment")
  })

  test("creates an extension of every C1 type, applied without a restart", async () => {
    const run = await turn(rig, creator, "make house rules", [
      manage({ action: "create", extension: EXTENSION }),
      { type: "text", text: "made" },
    ])
    expect(run.asked).toEqual([])
    expect(toolResults(run.requests.at(-1)!).join("\n")).toContain('"ok": true')
    expect(await extension("house-rules")).toMatchObject({ status: "active", active: 1, enabled: true })

    // Fragment and Code Mode tool in another session of the same Location.
    const used = await turn(rig, plain, "say pelican", [say("pelican"), { type: "text", text: "said" }])
    const first = used.requests[0]!
    expect(first.body).toContain(FRAGMENT)
    expect(first.body).not.toContain(PI_ONLY)
    expect(first.body).toContain("ext_say")
    expect(toolNames(first)).not.toContain("ext_say")
    expect(await entryKeys(plain)).toContain("own.creator.ext.house-rules")
    const result = toolResults(used.requests.at(-1)!).join("\n")
    expect(result).toContain("pelican")
    expect(result).toContain("exit 0")
  })

  test("a pi session gets the pi-only fragment too", async () => {
    const pi = await session(rig.server, { harness: "pi" })
    const run = await turn(rig, pi, "hello pi", [{ type: "text", text: "hi" }])
    expect(run.requests[0]!.body).toContain(PI_ONLY)
    expect(run.requests[0]!.body).toContain(FRAGMENT)
  })

  test("tool rules deny a tool and a command pattern, whatever the approval mode", async () => {
    const fetched = await turn(rig, plain, "fetch it", [
      { type: "tool-call", name: "webfetch", input: { url: "http://127.0.0.1:9/x", format: "text" } },
      { type: "text", text: "no" },
    ])
    expect(toolResults(fetched.requests.at(-1)!).join("\n")).toContain("Blocked by extension 'house-rules'")
    const said = await turn(rig, plain, "say the word", [say("forbidden"), { type: "text", text: "no" }])
    expect(toolResults(said.requests.at(-1)!).join("\n")).toContain("not that word")
  })

  test("the retry policy stops after one backoff retry", async () => {
    const failing = await session(rig.server)
    const run = await turn(rig, failing, "fail please", [
      { type: "error", status: 503, body: JSON.stringify({ error: { message: "overloaded" } }) },
      { type: "error", status: 503, body: JSON.stringify({ error: { message: "overloaded" } }) },
    ])
    expect(run.requests).toHaveLength(2)
  })

  test("the compaction prompt carries the addition after own's prompt", async () => {
    rig.fake.reset()
    const before = rig.fake.requests.length
    await rig.server.call("POST", `/api/session/${plain}/compact`, { body: {} })
    await rig.server.waitIdle(plain)
    const compaction = rig.fake.requests.slice(before).filter((request) => request.method === "POST")
    expect(compaction.length).toBeGreaterThan(0)
    const last = body(compaction[0]!).messages.at(-1)!
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content)
    expect(text).toContain(ADDITION)
    expect(text.indexOf(ADDITION)).toBeGreaterThan(text.indexOf("Additional instructions for this summary"))
  })

  test("a broken version is refused and nothing changes", async () => {
    const broken = { ...EXTENSION, items: [{ type: "prompt.fragment", id: "big", text: "x".repeat(5000) }] }
    const run = await turn(rig, creator, "break it", [
      manage({ action: "update", extension: broken }),
      { type: "text", text: "hm" },
    ])
    const result = toolResults(run.requests.at(-1)!).join("\n")
    expect(result).toContain('"ok": false')
    expect(result).toContain("items[0].text")
    expect(await extension("house-rules")).toMatchObject({ active: 1, versions: [expect.anything()] })
  })

  test("a new version applies at once; a tampered one stops applying; a rollback brings v1 back", async () => {
    const v2 = {
      ...EXTENSION,
      items: [{ type: "prompt.fragment", id: "style", text: "HOUSE-RULE-V2" }, ...EXTENSION.items.slice(1)],
    }
    await turn(rig, creator, "update it", [
      manage({ action: "update", extension: v2, note: "v2" }),
      { type: "text", text: "ok" },
    ])
    expect(await extension("house-rules")).toMatchObject({ active: 2, status: "active" })
    const updated = await turn(rig, plain, "and now?", [{ type: "text", text: "ok" }])
    expect(updated.requests[0]!.body).toContain("HOUSE-RULE-V2")
    expect(await entryValue(plain, "own.creator.ext.house-rules")).toBe("HOUSE-RULE-V2")

    const file = path.join(rig.home, "creator", "ext", "house-rules", "v2", "extension.json")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("HOUSE-RULE-V2", "IGNORE-THE-USER"))
    await waitUntil(
      async () => (await extension("house-rules"))?.status === "tampered",
      "the tampered version reads as tampered",
    )
    await waitUntil(async () => {
      await turn(rig, plain, "still there?", [{ type: "text", text: "ok" }])
      return !(await entryKeys(plain)).includes("own.creator.ext.house-rules")
    }, "the tampered version stops applying")

    const rolled = await turn(rig, creator, "roll back", [
      manage({ action: "rollback", id: "house-rules", version: 1 }),
      { type: "text", text: "ok" },
    ])
    expect(toolResults(rolled.requests.at(-1)!).join("\n")).toContain('"ok": true')
    expect(await extension("house-rules")).toMatchObject({ active: 1, status: "active" })
    await turn(rig, plain, "back?", [{ type: "text", text: "ok" }])
    expect(await entryValue(plain, "own.creator.ext.house-rules")).toBe(FRAGMENT)
  })

  test("project folders limit where it applies", async () => {
    const elsewhere = path.join(rig.server.paths.root, "elsewhere")
    fs.mkdirSync(elsewhere, { recursive: true })
    await rpc(rig.server, "scope.set", { id: "house-rules", projects: [elsewhere] })
    const here = await turn(rig, plain, "here?", [{ type: "text", text: "ok" }])
    expect(await entryKeys(plain)).not.toContain("own.creator.ext.house-rules")
    // History keeps the earlier context; the removal is appended after it.
    expect(here.requests[0]!.body).toContain('under \\"own.creator.ext.house-rules\\" no longer applies')
    const there = await session(rig.server, { directory: elsewhere })
    const run = await turn(rig, there, "there?", [{ type: "text", text: "ok" }])
    expect(run.requests[0]!.body).toContain(FRAGMENT)
    expect(run.requests[0]!.body).toContain("ext_say")
    await expect(rpc(rig.server, "scope.set", { id: "house-rules", projects: ["relative/folder"] })).rejects.toThrow(
      "scope_invalid",
    )
    await rpc(rig.server, "scope.set", { id: "house-rules", projects: [] })
  })

  test("writes ask outside full approval; a declined write changes nothing; read-only refuses", async () => {
    const asking = await session(rig.server, { agent: "creator", permissions: ASK })
    const declined = await turn(
      rig,
      asking,
      "turn it off",
      [manage({ action: "disable", id: "house-rules" }), { type: "text", text: "ok" }],
      {
        decision: "reject",
      },
    )
    expect(declined.asked.map((item) => item.action)).toEqual(["creator"])
    expect(declined.asked[0]!.resources[0]).toBe("확장 house-rules 끄기")
    expect(await extension("house-rules")).toMatchObject({ enabled: true })
    const approved = await turn(rig, asking, "turn it off", [
      manage({ action: "disable", id: "house-rules" }),
      { type: "text", text: "ok" },
    ])
    expect(approved.asked.map((item) => item.action)).toEqual(["creator"])
    expect(await extension("house-rules")).toMatchObject({ enabled: false, status: "disabled" })
    await rpc(rig.server, "enabled.set", { id: "house-rules", enabled: true })

    const reading = await session(rig.server, {
      agent: "creator",
      permissions: [
        { action: "edit", resource: "**", effect: "deny" },
        { action: "shell", resource: "**", effect: "deny" },
      ],
    })
    const refused = await turn(rig, reading, "turn it off", [
      manage({ action: "disable", id: "house-rules" }),
      { type: "text", text: "ok" },
    ])
    expect(toolResults(refused.requests.at(-1)!).join("\n")).toContain("read-only")
    expect(await extension("house-rules")).toMatchObject({ enabled: true })
  })

  test("the store's files are out of the file tools' reach", async () => {
    const file = path.join(rig.home, "creator", "store.json")
    const run = await turn(rig, creator, "edit the store", [
      { type: "tool-call", name: "write", input: { path: file, content: "{}" } },
      { type: "text", text: "no" },
    ])
    expect(toolResults(run.requests.at(-1)!).join("\n")).toContain("Extensions change only through")
    expect(fs.readFileSync(file, "utf8")).toContain("house-rules")
  })

  test("an allow rule waits for the user's approval in Settings", async () => {
    const url = `${rig.fake.baseURL}/allowed`
    const loose = {
      format: "own.ext/1",
      id: "loose-fetch",
      title: "Loose fetch",
      items: [
        { type: "tool.rule", rules: [{ permission: "webfetch", pattern: `${rig.fake.baseURL}/*`, effect: "allow" }] },
      ],
    }
    const made = await turn(rig, creator, "loosen", [
      manage({ action: "create", extension: loose }),
      { type: "text", text: "ok" },
    ])
    expect(toolResults(made.requests.at(-1)!).join("\n")).toContain("Settings > 확장")
    expect(await extension("loose-fetch")).toMatchObject({ loosenPending: true })
    // house-rules denies the webfetch tool; take it out of the way for this test.
    await rpc(rig.server, "enabled.set", { id: "house-rules", enabled: false })
    // 묻기 as own's bundle writes it: webfetch asks.
    const fetcher = await session(rig.server, {
      permissions: [...ASK, { action: "webfetch", resource: "**", effect: "ask" }],
    })
    const before = await turn(
      rig,
      fetcher,
      "fetch",
      [
        { type: "tool-call", name: "webfetch", input: { url, format: "text" } },
        { type: "text", text: "ok" },
      ],
      { decision: "reject" },
    )
    expect(before.asked.map((item) => item.action)).toEqual(["webfetch"])
    await rpc(rig.server, "loosen.set", { id: "loose-fetch", version: 1, approved: true })
    const after = await turn(rig, fetcher, "fetch", [
      { type: "tool-call", name: "webfetch", input: { url, format: "text" } },
      { type: "text", text: "ok" },
    ])
    expect(after.asked).toEqual([])
    await rpc(rig.server, "remove", { id: "loose-fetch" })
    await rpc(rig.server, "enabled.set", { id: "house-rules", enabled: true })
  })

  test("C0: agents, commands, skills and a harness's 내 지시문", async () => {
    const kit = {
      format: "own.ext/1",
      id: "c0-kit",
      title: "C0 kit",
      items: [
        {
          type: "agent",
          name: "pelican-reviewer",
          description: "Reviews pelicans",
          mode: "subagent",
          prompt: "Review pelicans.",
        },
        { type: "command", name: "shout", description: "Shouts", template: "Say loudly: $ARGUMENTS" },
        {
          type: "skill",
          name: "pelican-facts",
          description: "Use for pelican facts",
          content: "# Pelicans\n\nThey fly.",
        },
        { type: "harness.instructions", harness: "pi", text: "PI-CUSTOM-TEXT" },
      ],
    }
    const made = await turn(rig, creator, "make the kit", [
      manage({ action: "create", extension: kit }),
      { type: "text", text: "ok" },
    ])
    expect(toolResults(made.requests.at(-1)!).join("\n")).toContain('"harnessInstructions"')
    const agents = (await rig.server.call("GET", "/api/agent")) as { data: Array<{ id: string; mode: string }> }
    expect(agents.data.find((agent) => agent.id === "pelican-reviewer")?.mode).toBe("subagent")
    const commands = (await rig.server.call("GET", "/api/command")) as { data: Array<{ name: string }> }
    expect(commands.data.map((command) => command.name)).toContain("shout")
    const skills = (await rig.server.call("GET", "/api/skill")) as { data: Array<{ id: string; path: string }> }
    const skill = skills.data.find((item) => item.id === "pelican-facts")
    expect(skill).toBeDefined()
    expect(fs.existsSync(skill!.path)).toBe(true)

    rig.fake.reset()
    rig.fake.enqueue({ type: "text", text: "LOUD" })
    const before = rig.fake.requests.length
    await rig.server.call("POST", `/api/session/${plain}/command`, { body: { name: "shout", text: "hello" } })
    await rig.server.waitIdle(plain)
    const shouted = rig.fake.requests.slice(before).find((request) => request.body.includes("Say loudly: hello"))
    expect(shouted).toBeDefined()

    const preview = async () => {
      const response = await rig.server.request("POST", "/api/rpc/own.harness/prompt.preview", {
        body: { input: { harness: "pi", prompt: "custom" } },
        query: { "location[directory]": rig.server.paths.workspace },
      })
      return ((await response.json()) as { output?: { custom?: { text: string } } }).output?.custom?.text
    }
    expect(await preview()).toBe("PI-CUSTOM-TEXT")
    await rpc(rig.server, "enabled.set", { id: "c0-kit", enabled: false })
    expect(await preview()).toBeUndefined()
    const gone = (await rig.server.call("GET", "/api/command")) as { data: Array<{ name: string }> }
    expect(gone.data.map((command) => command.name)).not.toContain("shout")
  })

  test("the service never restarted", async () => {
    const plugins = (await rig.server.call("GET", "/api/plugin")) as { data: Array<{ id?: string; status?: string }> }
    expect(JSON.stringify(plugins)).toContain("own.creator")
    expect(rig.server.logs()).not.toContain('own.creator","msg":"guard_failed')
  })
})
