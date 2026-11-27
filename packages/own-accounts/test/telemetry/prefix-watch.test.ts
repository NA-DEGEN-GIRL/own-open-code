// P0-2b (02 §7.8): the opt-in per-block prefix fingerprint. Requests go through the real auth module the way core makes
// them (the shaping hook, then `model.request` with the request's kind) and the real capture switches the watch on.
// Every credential and request here is fake.

import { describe, expect, test } from "bun:test"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { SessionID } from "@opencode/schema/session-id"
import type { SessionContext, SessionModelRequest } from "@opencode/plugin/promise/session"
import { Home } from "@own/runtime"
import type { Module } from "../../src/module.js"
import { Resets } from "../../src/resets.js"
import { authSetup, httpResponse, message, modelRequest, ref } from "../auth/support.js"
import { registryWith } from "../slots/support.js"
import { ok } from "./support.js"

const KEY = "sk-proj-fakeprefix00000000000000000000001"
const SESSION = "ses_prefix_watch_test"
const OAI = ref("own-oai-aaaa", "gpt-5.5")
const SYSTEM = [
  "You are OpenCode.",
  "# Your Model\n- Name: GPT-5.5\n- Provider ID: own-oai-aaaa\n- Model ID: gpt-5.5",
  "<instructions>baseline</instructions>",
]
const TOOLS: SessionContext["tools"] = {
  read: { description: "Read a file.", input: { type: "object", properties: { path: { type: "string" } } } },
}

type Message = SessionContext["messages"][number]

const user = (id: string, text: string) => message({ id, role: "user", content: [{ type: "text", text }] })
const assistant = (id: string, text: string) =>
  message({
    id,
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking", encrypted: `enc_fake_${id}` },
      { type: "text", text },
    ],
  })
/** A user message with an inline image of `mib` MiB of raw bytes (core counts it as their base64 length). */
const image = (id: string, mib: number) =>
  message({
    id,
    role: "user",
    content: [
      {
        type: "media",
        media: { mediaType: "image/png", source: { type: "bytes", data: new Uint8Array(mib * 1024 * 1024) } },
      },
    ],
  })

const HISTORY = [user("msg_01", "one"), assistant("msg_02", "1"), user("msg_03", "two")]

async function setup(slugs: ReadonlyArray<string> = ["aaaa"]) {
  const registry = await registryWith(slugs.map((slug) => ({ kind: "oai" as const, label: slug, slug })))
  const s = await authSetup({ registry })
  await s.t.deps.runtime.credentials.store("acc_aaaa", { type: "key", key: KEY })
  const capture = s.modules.telemetry.capture
  const records = async () => {
    await s.t.deps.runtime.ledger.flush()
    const events = await s.t.deps.runtime.ledger.eventsOf(Home.month(s.t.clock.now()))
    return events.filter((event) => event.type === "prefix")
  }
  return {
    ...s,
    start: (input: { readonly sessionID?: string; readonly providerIDs?: ReadonlyArray<string> } = {}) =>
      ok(capture.start, { mode: "hash", ...input }),
    stop: () => ok(capture.stop, {}),
    /** The `prefix` lines of `events.jsonl`, oldest first. */
    records,
    causes: async () => (await records()).map((event) => event.data?.cause),
    diverged: () => s.alerts.filter((alert) => alert.code === "prefix_diverged"),
    async [Symbol.asyncDispose]() {
      // The capture window is a process singleton: end it so the next test starts without one.
      await capture.close()
      await s[Symbol.asyncDispose]()
    },
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

function request(
  input: {
    readonly sessionID?: string
    readonly model?: Model.Ref
    readonly agent?: string
    readonly tools?: SessionContext["tools"]
    readonly system?: ReadonlyArray<string>
    readonly messages?: ReadonlyArray<Message>
  } = {},
): SessionContext {
  return {
    // SAFETY: branded ids built from test literals.
    sessionID: (input.sessionID ?? SESSION) as SessionID,
    agent: (input.agent ?? "build") as Agent.ID,
    model: input.model ?? OAI,
    system: (input.system ?? SYSTEM).map((text) => ({ type: "text" as const, text })),
    // Core builds new objects for every request; so does this.
    messages: structuredClone([...(input.messages ?? HISTORY)]),
    options: {},
    tools: structuredClone(input.tools ?? TOOLS),
  }
}

/** One request as core makes it: the shaping hook, then `model.request` with the request's kind. */
async function send(s: Setup, event: SessionContext, kind: SessionModelRequest["kind"] = "primary") {
  await s.auth.onRequestShape(event)
  await requested(s, { ...modelRequest(event.sessionID, event.model), agent: event.agent, kind })
}

/** The auth module's part of `model.request` as `Hooks.register` runs it: the comparisons, then the injection. */
async function requested(s: Setup, event: SessionModelRequest) {
  s.auth.settle(event)
  await s.auth.onModelRequest(event)
}

/** The dispatcher's reset tracker (events.ts), which names a context reset or its undo in the event's meta. */
const resets = new Resets.Tracker()

/** A local session event, as the event dispatcher hands it to the auth module. */
async function happened(s: Setup, type: string, data: Record<string, unknown>) {
  // SAFETY: the fields the auth module reads of these session events.
  const event = { type, data: { sessionID: SESSION, ...data } } as unknown as Module.OpenCodeEvent
  const reset = await resets.observe(event)
  await s.auth.onEvent?.(event, { local: true, ...(reset === undefined ? {} : { reset }) })
}

function variant(model: Model.Ref, value: string) {
  // SAFETY: a branded variant id built from a test literal.
  return { ...model, variant: value } as Model.Ref
}

describe("off by default", () => {
  test("no capture window: nothing is recorded or raised, whatever the requests do", async () => {
    await using s = await setup()
    await send(s, request())
    await send(s, request({ messages: [user("msg_01", "one (rewritten)"), ...HISTORY.slice(1)] }))
    await send(s, request({ tools: {} }))
    expect(await s.records()).toEqual([])
    expect(s.diverged()).toEqual([])
  })

  test("a window for another session or slot records nothing here; after a window the slot starts again", async () => {
    await using s = await setup()
    await s.start({ sessionID: "ses_prefix_other" })
    await send(s, request())
    await s.start({ providerIDs: ["own-oai-zzzz"] })
    await send(s, request())
    expect(await s.records()).toEqual([])

    await s.start()
    await send(s, request())
    await s.stop()
    // Not recorded, and the slot's last fingerprint is forgotten: a later window never compares across the gap.
    const rewritten = [user("msg_01", "one (rewritten)")]
    await send(s, request({ messages: rewritten }))
    await s.start()
    await send(s, request({ messages: rewritten }))
    expect(await s.causes()).toEqual(["first", "first"])
  })

  test("a request shaped in a window whose `model.request` never came is not recorded after the window", async () => {
    await using s = await setup()
    await s.start()
    await s.auth.onRequestShape(request())
    await s.stop()
    await send(s, request())
    expect(await s.records()).toEqual([])
  })
})

describe("prefix lines and causes", () => {
  test("first, then append: the previous request is reused whole; envelope, counts and time on the line", async () => {
    await using s = await setup()
    await s.start()
    await send(s, request({ messages: HISTORY.slice(0, 1) }))
    await send(s, request())
    await send(s, request())
    const records = await s.records()
    expect(records.map((event) => event.data)).toEqual([
      expect.objectContaining({ cause: "first", lcp: 0, previous: null, blocks: 5, at: null }),
      expect.objectContaining({ cause: "append", lcp: 5, previous: 5, blocks: 7, at: null }),
      expect.objectContaining({ cause: "append", lcp: 7, previous: 7, blocks: 7, at: null }),
    ])
    expect(records[0]).toMatchObject({
      type: "prefix",
      sessionID: SESSION,
      providerID: OAI.providerID,
      accountID: "acc_aaaa",
      data: { modelID: "gpt-5.5", variant: null, agent: "build" },
    })
    const ms = records.map((event) => event.data?.ms)
    expect(ms.every((value) => typeof value === "number" && value >= 0 && value < 1_000)).toBe(true)
    expect(s.diverged()).toEqual([])
  })

  test("an earlier message rewritten for no known reason: `unexplained` and one prefix_diverged (info)", async () => {
    await using s = await setup()
    await s.start()
    await send(s, request())
    await send(s, request({ messages: [HISTORY[0]!, assistant("msg_02", "1 (rewritten)"), HISTORY[2]!] }))
    expect((await s.records()).at(-1)?.data).toMatchObject({ cause: "unexplained", lcp: 5, previous: 7, at: "message" })
    expect(s.diverged()).toEqual([
      expect.objectContaining({
        code: "prefix_diverged",
        severity: "info",
        sessionID: SESSION,
        accountID: "acc_aaaa",
        fields: {
          providerID: OAI.providerID,
          modelID: "gpt-5.5",
          agent: "build",
          at: "message",
          lcp: "5",
          previous: "7",
        },
      }),
    ])
  })

  test("a compaction request or a compaction.ended event in between explains the rewrite", async () => {
    await using s = await setup()
    await s.start()
    await send(s, request())
    await send(s, request(), "compaction")
    const summary = [user("msg_10", "summary of what came before"), user("msg_11", "next")]
    await send(s, request({ messages: summary }))
    await happened(s, "session.compaction.ended", {})
    await send(s, request({ messages: summary.slice(1) }))
    expect(await s.causes()).toEqual(["first", "compaction", "compaction"])
    expect(s.diverged()).toEqual([])
  })

  test("a committed revert, an instruction update: each explains the next rewrite once", async () => {
    await using s = await setup()
    await s.start()
    await send(s, request())
    await happened(s, "session.revert.committed", { to: "msg_02" })
    const reverted = [HISTORY[0]!, user("msg_04", "instead")]
    await send(s, request({ messages: reverted }))
    await happened(s, "session.instructions.updated", {})
    await send(s, request({ messages: [user("msg_01", "one (rendered again)"), reverted[1]!] }))
    // Explained once: the same kind of rewrite again is not.
    await send(s, request({ messages: [user("msg_01", "one (and again)"), reverted[1]!] }))
    expect(await s.causes()).toEqual(["first", "revert", "instructions", "unexplained"])
    expect(s.diverged()).toHaveLength(1)
  })

  test("a context reset and its undo each explain the next rewrite once (11 §7)", async () => {
    await using s = await setup()
    await s.start()
    await send(s, request())
    await happened(s, "session.inbox.enqueued", {
      inboxID: "msg_reset",
      item: { type: "reset", payload: {}, delivery: "queue" },
    })
    await happened(s, "session.inbox.delivered", { inboxID: "msg_reset" })
    const fresh = [user("msg_05", "new start")]
    await send(s, request({ messages: fresh }))
    await happened(s, "session.reset.undone", { messageID: "msg_reset" })
    await send(s, request({ messages: [...HISTORY, assistant("msg_04", "3"), ...fresh] }))
    expect(await s.causes()).toEqual(["first", "reset", "reset-undo"])
    expect(s.diverged()).toEqual([])
  })

  test("another model or variant, then another agent alone, then changed tools", async () => {
    await using s = await setup()
    await s.start()
    const other = ref(OAI.providerID, "gpt-5.4")
    await send(s, request())
    await send(s, request({ model: other, system: ["Another prompt.", ...SYSTEM.slice(1)] }))
    await send(s, request({ model: variant(other, "high") }))
    // An agent change that rewrites nothing is an append.
    await send(s, request({ model: variant(other, "high"), agent: "plan" }))
    const tools = { ...TOOLS, shell: { description: "Run a command.", input: { type: "object" } } }
    await send(s, request({ model: variant(other, "high"), agent: "plan", tools }))
    expect((await s.records()).map((event) => [event.data?.cause, event.data?.at])).toEqual([
      ["first", null],
      ["model", "system"],
      ["model", "system"],
      ["append", null],
      ["toolset", "tools"],
    ])
    // D10 raises `toolset_changed` for the system and tool changes it sees; the watch adds no alert of its own.
    expect(s.alerts.at(-1)?.fields?.changed).toBe("tools")
    expect(new Set(s.alerts.map((alert) => alert.code))).toEqual(new Set(["toolset_changed"]))
  })

  test("another agent's prompt rewrites the system: `agent`", async () => {
    await using s = await setup()
    await s.start()
    await send(s, request())
    await send(s, request({ agent: "plan", system: ["You plan.", ...SYSTEM.slice(1)] }))
    expect((await s.records()).at(-1)?.data).toMatchObject({ cause: "agent", lcp: 1, at: "system" })
  })

  test("a strip rule rewrites the earlier turns once: `strip`, then append again", async () => {
    await using s = await setup()
    await s.start()
    await send(s, request())
    // That request failed on provider-bound state: a strip rule up to its newest message (02 §4.4).
    await s.auth.onHttpResponse(
      httpResponse(SESSION, OAI, {
        requestHeaders: { authorization: `Bearer ${KEY}` },
        status: 400,
        body: '{"error":{"code":"invalid_encrypted_content"}}',
      }),
    )
    await send(s, request())
    await send(s, request({ messages: [...HISTORY, assistant("msg_04", "2"), user("msg_05", "three")] }))
    expect((await s.records()).map((event) => [event.data?.cause, event.data?.lcp])).toEqual([
      ["first", 0],
      ["strip", 5],
      ["append", 7],
    ])
    expect(s.alerts).toEqual([])
  })

  test("core's image cut moving to a newer image rewrites from that image: `image-trim`", async () => {
    await using s = await setup()
    await s.start()
    // Two images of 10 MiB count 13.3 MiB each: 26.7 MiB passes 25 MiB, so core drops the oldest.
    const first = [image("msg_01", 10), assistant("msg_02", "1"), image("msg_03", 10)]
    await send(s, request({ messages: first }))
    await send(s, request({ messages: [...first, assistant("msg_04", "2")] }))
    // A third makes 40 MiB, so core drops the two oldest: the request differs from the second image (block 6) on.
    await send(s, request({ messages: [...first, assistant("msg_04", "2"), image("msg_05", 10)] }))
    expect((await s.records()).map((event) => [event.data?.cause, event.data?.lcp])).toEqual([
      ["first", 0],
      ["append", 7],
      ["image-trim", 6],
    ])
    expect(s.diverged()).toEqual([])
  })

  test("generate and title requests are not compared; the next primary compares with the last primary", async () => {
    await using s = await setup()
    await s.start()
    await send(s, request())
    await send(s, request({ messages: [...HISTORY, user("msg_09", "a side question")] }), "generate")
    await requested(s, { ...modelRequest(SESSION, OAI), kind: "title" })
    await send(s, request({ messages: [...HISTORY, assistant("msg_04", "2")] }))
    expect(await s.causes()).toEqual(["first", "append"])
  })

  test("each session and slot has its own previous request", async () => {
    await using s = await setup(["aaaa", "bbbb"])
    await s.start()
    const later = [...HISTORY, assistant("msg_04", "2")]
    await send(s, request())
    await send(s, request({ model: ref("own-oai-bbbb", "gpt-5.5"), messages: later }))
    await send(s, request({ sessionID: "ses_prefix_two", messages: [user("msg_01", "elsewhere")] }))
    await send(s, request({ messages: [...later, user("msg_05", "back")] }))
    expect(await s.causes()).toEqual(["first", "first", "first", "append"])
  })
})
