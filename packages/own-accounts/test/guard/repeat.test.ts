// Repeated identical tool-call reminder (external-repos report P1-1, decision D4 option A): own-slot sessions get a
// short fixed note before the result text of the 3rd, 5th and 8th identical call in a row; nothing is ever blocked.
// The unit tests drive `Repeat` with fake events; the last block goes through `Hooks.register` with the real slots
// module and policy store. Every account is fake; nothing reaches a network.

import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode/schema/tool"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Policy } from "@own/protocol"
import { Repeat } from "../../src/guard/repeat.js"
import { Hooks } from "../../src/hooks.js"
import { Logger } from "../../src/logger.js"
import { authSetup } from "../auth/support.js"
import { registryWith } from "../slots/support.js"

const OWN = "own-ds-dddd"
const SESSION = "ses_repeat_main"
const OTHER = "ses_repeat_other"
const READ = { filePath: "src/app.ts" }

function setup(exclude?: ReadonlyArray<string>) {
  const logs: string[] = []
  const repeat = Repeat.create({
    own: (providerID) => providerID.startsWith("own-"),
    exclude: () => exclude ?? Repeat.EXCLUDE,
    log: Logger.create({ scope: "test", sink: (line) => logs.push(line) }),
  })
  return { repeat, logs }
}

function request(providerID: string, input: { sessionID?: string; agent?: string; kind?: string } = {}) {
  return {
    sessionID: input.sessionID ?? SESSION,
    agent: input.agent ?? "build",
    model: { providerID },
    kind: input.kind ?? "primary",
  }
}

type At = { sessionID?: string; agent?: string; id?: string; codemode?: boolean }

function completed(
  tool: string,
  input: unknown,
  result: Tool.Result = { content: [{ type: "text", text: "ok" }] },
  at: At = {},
) {
  return {
    tool,
    sessionID: at.sessionID ?? SESSION,
    agent: at.agent ?? "build",
    id: at.id ?? `call_${crypto.randomUUID()}`,
    input,
    codemode: at.codemode ?? false,
    status: "completed" as const,
    result,
  }
}

function failed(tool: string, input: unknown, error: Tool.Error, at: At = {}) {
  return {
    tool,
    sessionID: at.sessionID ?? SESSION,
    agent: at.agent ?? "build",
    id: at.id ?? `call_${crypto.randomUUID()}`,
    input,
    codemode: at.codemode ?? false,
    status: "error" as const,
    error,
  }
}

/** The first text the model reads of a completed call. */
function head(event: ReturnType<typeof completed>) {
  const content = event.result.content
  if (typeof content === "string") return content
  const first = content?.[0]
  return first?.type === "text" ? first.text : ""
}

/** Runs `count` identical calls and answers the counts the notes they got name (the chain's, not this run's). */
function noted(repeat: ReturnType<typeof setup>["repeat"], tool: string, input: unknown, count: number, at: At = {}) {
  return Array.from({ length: count }).flatMap(() => {
    const event = completed(tool, input, undefined, at)
    repeat.after(event)
    return Repeat.THRESHOLDS.filter((n) => head(event).startsWith(Repeat.note(tool, n)))
  })
}

describe("counting", () => {
  test("the 3rd, 5th and 8th identical call get the note before the text; output and metadata stay", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    const shown = Array.from({ length: 10 }, (_, index) => index + 1).flatMap((n) => {
      const event = completed("read", READ, {
        output: { lines: 2 },
        content: [{ type: "text", text: "1: import x\n2: export y" }],
        metadata: { truncated: false },
      })
      s.repeat.after(event)
      if (n !== 3 && n !== 5 && n !== 8) {
        expect(event.result.content).toEqual([{ type: "text", text: "1: import x\n2: export y" }])
        return []
      }
      expect(event.result).toEqual({
        output: { lines: 2 },
        content: [{ type: "text", text: `${Repeat.note("read", n)}\n\n1: import x\n2: export y` }],
        metadata: { truncated: false },
      })
      return [n]
    })
    expect(shown).toEqual([3, 5, 8])
    expect(s.logs.filter((line) => line.includes("repeat_reminder"))).toHaveLength(3)
  })

  test("the note is short, fixed and names the tool and the count", () => {
    const text = Repeat.note("shell", 5)
    expect(text.startsWith("<system-reminder>\n")).toBe(true)
    expect(text.endsWith("\n</system-reminder>")).toBe(true)
    expect(text).toContain("called shell 5 times in a row with the same arguments")
    expect(text.length).toBeLessThan(400)
    expect(Repeat.note("shell", 5)).toBe(text)
  })

  test("argument key order does not matter at any depth; array order and values do", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    const inputs = [
      { a: 1, b: { c: 2, d: [{ x: 1, y: 2 }] } },
      { b: { d: [{ y: 2, x: 1 }], c: 2 }, a: 1 },
      { b: { c: 2, d: [{ x: 1, y: 2 }] }, a: 1 },
    ]
    const events = inputs.map((input) => completed("grep", input))
    for (const event of events) s.repeat.after(event)
    expect(head(events[2])).toStartWith(Repeat.note("grep", 3))

    const t = setup()
    t.repeat.onModelRequest(request(OWN))
    expect(noted(t.repeat, "grep", { list: [1, 2] }, 2)).toEqual([])
    expect(noted(t.repeat, "grep", { list: [2, 1] }, 2)).toEqual([])
    expect(noted(t.repeat, "grep", { list: [2, 1], n: 1 }, 2)).toEqual([])
  })

  test("another tool or other arguments start a new chain at 1", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    expect(noted(s.repeat, "read", READ, 2)).toEqual([])
    expect(noted(s.repeat, "glob", READ, 1)).toEqual([])
    expect(noted(s.repeat, "read", READ, 2)).toEqual([])
    expect(noted(s.repeat, "read", { filePath: "src/other.ts" }, 3)).toEqual([3])
  })

  test("each (session, agent) has its own chain", () => {
    const s = setup()
    for (const at of [{}, { agent: "plan" }, { sessionID: OTHER }]) s.repeat.onModelRequest(request(OWN, at))
    const call = (at: At) => {
      const event = completed("read", READ, undefined, at)
      s.repeat.after(event)
      return head(event).startsWith("<system-reminder>")
    }
    const order: Array<At> = [{}, { agent: "plan" }, { sessionID: OTHER }, {}, { agent: "plan" }, {}]
    expect(order.map(call)).toEqual([false, false, false, false, false, true])
    expect(call({ agent: "plan" })).toBe(true)
    expect(call({ sessionID: OTHER })).toBe(false)
  })

  test("a user prompt resets every chain of its session and no other", () => {
    const s = setup()
    for (const at of [{}, { agent: "plan" }, { sessionID: OTHER }]) s.repeat.onModelRequest(request(OWN, at))
    for (const at of [{}, { agent: "plan" }, { sessionID: OTHER }])
      expect(noted(s.repeat, "read", READ, 2, at)).toEqual([])
    s.repeat.onPrompt({ sessionID: SESSION })
    expect(noted(s.repeat, "read", READ, 2)).toEqual([])
    expect(noted(s.repeat, "read", READ, 2, { agent: "plan" })).toEqual([])
    expect(noted(s.repeat, "read", READ, 1, { sessionID: OTHER })).toEqual([3])
    expect(noted(s.repeat, "read", READ, 1)).toEqual([3])
  })
})

describe("scope", () => {
  test("a session on another provider, or one this process saw no request of, is untouched", () => {
    const s = setup()
    s.repeat.onModelRequest(request("deepseek"))
    s.repeat.onModelRequest(request("anthropic", { sessionID: OTHER }))
    expect(noted(s.repeat, "read", READ, 8)).toEqual([])
    expect(noted(s.repeat, "read", READ, 8, { sessionID: OTHER })).toEqual([])
    expect(noted(s.repeat, "read", READ, 8, { sessionID: "ses_unseen" })).toEqual([])
    expect(s.logs).toEqual([])
  })

  test("the primary request decides: a switch away stops counting, and back starts a new chain", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    expect(noted(s.repeat, "read", READ, 2)).toEqual([])
    // Title, compaction and generate requests produce no tool calls and change nothing.
    for (const kind of ["title", "compaction", "generate"]) s.repeat.onModelRequest(request("deepseek", { kind }))
    expect(noted(s.repeat, "read", READ, 1)).toEqual([3])
    s.repeat.onModelRequest(request("deepseek"))
    expect(noted(s.repeat, "read", READ, 4)).toEqual([])
    s.repeat.onModelRequest(request(OWN))
    expect(noted(s.repeat, "read", READ, 3)).toEqual([3])
    // Another request on an own slot (the next step, or another own account) keeps the chain.
    s.repeat.onModelRequest(request("own-codex-cccc"))
    expect(noted(s.repeat, "read", READ, 2)).toEqual([5])
  })

  test("excluded tools neither count nor break a chain; the policy list replaces the default one", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    expect(noted(s.repeat, "computer_screenshot", {}, 8)).toEqual([])
    expect(noted(s.repeat, "read", READ, 2)).toEqual([])
    expect(noted(s.repeat, "computer_key", { text: "Page_Down" }, 3)).toEqual([])
    expect(noted(s.repeat, "read", READ, 1)).toEqual([3])

    const t = setup(["read", "web*"])
    t.repeat.onModelRequest(request(OWN))
    expect(noted(t.repeat, "read", READ, 8)).toEqual([])
    expect(noted(t.repeat, "webfetch", { url: "https://example.test" }, 8)).toEqual([])
    expect(noted(t.repeat, "computer_screenshot", {}, 3)).toEqual([3])
    // Regex characters in a pattern are literal.
    const u = setup(["team.status"])
    u.repeat.onModelRequest(request(OWN))
    expect(noted(u.repeat, "team_status", {}, 3)).toEqual([3])
  })

  test("calls a Code Mode program makes are transparent and keep their text; the execute call itself counts", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    expect(noted(s.repeat, "read", READ, 2)).toEqual([])
    const program = () => {
      // Each call a program makes has an ID of its own (upstream #64324) and `codemode: true`.
      const nested = Array.from({ length: 5 }, () =>
        completed("github_search", { q: "x" }, undefined, { codemode: true }),
      )
      for (const event of nested) s.repeat.after(event)
      for (const event of nested) expect(event.result.content).toEqual([{ type: "text", text: "ok" }])
      const event = completed(Repeat.CODE_MODE, { code: "await tools.github.search({ q: 'x' })" })
      s.repeat.after(event)
      return head(event).startsWith("<system-reminder>")
    }
    expect([program(), program(), program()]).toEqual([false, false, true])
    // The model's own call of the same tool counts.
    expect(noted(s.repeat, "github_search", { q: "x" }, 3)).toEqual([3])
  })

  test("memory is bounded: the oldest session is forgotten first", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    expect(noted(s.repeat, "read", READ, 2)).toEqual([])
    for (const index of Array.from({ length: Repeat.MEMORY_KEYS }, (_, item) => item))
      s.repeat.onModelRequest(request(OWN, { sessionID: `ses_repeat_${index}` }))
    // The first session is no longer known (untouched until its next primary request).
    expect(noted(s.repeat, "read", READ, 3)).toEqual([])
    s.repeat.onModelRequest(request(OWN, { sessionID: OTHER }))
    expect(noted(s.repeat, "read", READ, 3, { sessionID: OTHER })).toEqual([3])
    // The newest sessions are kept.
    expect(noted(s.repeat, "read", READ, 3, { sessionID: `ses_repeat_${Repeat.MEMORY_KEYS - 1}` })).toEqual([3])
  })
})

describe("results", () => {
  test("a failure counts; its message gets the note when it has no cause, and one with a cause is left as is", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    const plain = Array.from({ length: 3 }, () =>
      failed("read", READ, new Tool.Error({ message: "File not found", metadata: { path: "x" } })),
    )
    for (const event of plain) s.repeat.after(event)
    expect(plain[1].error.message).toBe("File not found")
    expect(plain[2].error).toBeInstanceOf(Tool.Error)
    expect(plain[2].error.message).toBe(`${Repeat.note("read", 3)}\n\nFile not found`)
    expect(plain[2].error.metadata).toEqual({ path: "x" })
    expect(plain[2].error.error).toBeUndefined()

    const caused = new Tool.Error({ message: "denied", error: new Error("blocked by permission") })
    const events = [failed("write", READ, caused), failed("write", READ, caused), failed("write", READ, caused)]
    for (const event of events) s.repeat.after(event)
    expect(events[2].error).toBe(caused)
    // A completed call after failures of the same call continues the chain.
    expect(noted(s.repeat, "write", READ, 2)).toEqual([5])
  })

  test("string, file-first and output-only results keep everything after the note", () => {
    const s = setup()
    s.repeat.onModelRequest(request(OWN))
    const third = (tool: string, result: Tool.Result) => {
      const events = Array.from({ length: 3 }, () => completed(tool, READ, structuredClone(result)))
      for (const event of events) s.repeat.after(event)
      return events[2].result
    }
    expect(third("a", { content: "plain text" })).toEqual({
      content: [{ type: "text", text: `${Repeat.note("a", 3)}\n\nplain text` }],
    })
    const image = { type: "file" as const, uri: "data:image/png;base64,AAAA", mime: "image/png" }
    expect(third("b", { content: [image, { type: "text", text: "caption" }] })).toEqual({
      content: [{ type: "text", text: Repeat.note("b", 3) }, image, { type: "text", text: "caption" }],
    })
    expect(
      third("c", {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toEqual({
      content: [
        { type: "text", text: `${Repeat.note("c", 3)}\n\none` },
        { type: "text", text: "two" },
      ],
    })
    // The `opencode_models` filter leaves only `output`: core would render it as JSON text, so that text follows.
    const listing = { providers: [{ id: OWN, models: [] }], total: 0, next: null }
    expect(third("d", { output: listing, metadata: { m: 1 } })).toEqual({
      output: listing,
      content: [{ type: "text", text: `${Repeat.note("d", 3)}\n\n${JSON.stringify(listing)}` }],
      metadata: { m: 1 },
    })
    expect(third("e", { output: "text output", content: [] })).toEqual({
      output: "text output",
      content: [{ type: "text", text: `${Repeat.note("e", 3)}\n\ntext output` }],
    })
  })
})

describe("registration (hooks.ts)", () => {
  function ref(providerID: string, id: string) {
    return Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })
  }

  async function registered() {
    const s = await authSetup({ registry: await registryWith([{ kind: "ds", label: "D", slug: "dddd" }]) })
    const session = new Map<string, (event: unknown) => unknown>()
    const tool = new Map<string, (event: unknown) => unknown>()
    const registration = { dispose: async () => {} }
    const none = async () => registration
    const ctx = {
      ...s.t.deps.ctx,
      provider: { transform: none },
      model: { transform: none },
      agent: { transform: none },
      skill: { transform: none },
      session: {
        hook: async (name: string, callback: (event: unknown) => unknown) => {
          session.set(name, callback)
          return registration
        },
      },
      tool: {
        hook: async (name: string, callback: (event: unknown) => unknown) => {
          tool.set(name, callback)
          return registration
        },
      },
      permission: { hook: none },
    }
    // SAFETY: the context parts `Hooks.register` touches; the session and tool hooks are kept.
    await Hooks.register({ ...s.t.deps, ctx: ctx as unknown as typeof s.t.deps.ctx }, s.modules)
    const hook = (map: Map<string, (event: unknown) => unknown>, name: string) => {
      const found = map.get(name)
      if (!found) throw new Error(`${name} was not registered`)
      return found
    }
    const call = async (sessionID: string) => {
      const event = completed("read", READ, undefined, { sessionID })
      await hook(tool, "execute.before")(event)
      await hook(tool, "execute.after")(event)
      return head(event).startsWith("<system-reminder>")
    }
    const calls = async (sessionID: string, count: number) => {
      const shown: number[] = []
      for (let n = 1; n <= count; n++) if (await call(sessionID)) shown.push(n)
      return shown
    }
    return {
      s,
      calls,
      request: (sessionID: string, providerID: string) =>
        hook(
          session,
          "model.request",
        )({
          sessionID,
          agent: "build",
          model: ref(providerID, "deepseek-v4-pro"),
          kind: "primary",
          headers: {},
        }),
      prompt: (sessionID: string) =>
        hook(
          session,
          "prompt",
        )({
          sessionID,
          messageID: "msg_repeat",
          prompt: { text: "try again" },
          delivery: "steer",
        }),
      async [Symbol.asyncDispose]() {
        await s[Symbol.asyncDispose]()
      },
    }
  }

  test("an own slot's session gets the note, the built-in provider's does not; a prompt resets", async () => {
    await using r = await registered()
    await r.request(SESSION, OWN)
    await r.request(OTHER, "deepseek")
    expect(await r.calls(SESSION, 3)).toEqual([3])
    expect(await r.calls(OTHER, 8)).toEqual([])
    await r.prompt(SESSION)
    expect(await r.calls(SESSION, 3)).toEqual([3])
    expect(r.s.logs.some((line) => line.includes("hook_failed") && line.includes("repeat"))).toBe(false)
  })

  test("the policy's exclusion list applies without a restart", async () => {
    await using r = await registered()
    await r.request(SESSION, OWN)
    await r.s.t.deps.runtime.policy.write({ ...Policy.defaults, repeatReminderExclude: ["read"] })
    expect(await r.calls(SESSION, 8)).toEqual([])
    await r.s.t.deps.runtime.policy.write({ ...Policy.defaults })
    expect(await r.calls(SESSION, 3)).toEqual([3])
  })
})
