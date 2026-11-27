// Transcript units (03 §4.5): markers (collapse of undone switches, UI-only), turn usage and cost units, output speed
// (t/s), footer placement, formats, switch-record matching, what the chat view toggles change, and the rule that the
// transcript (and the chat view) never writes to a session.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"
import type {
  SessionInboxInfo,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client/promise"
import type { Ledger } from "@own/protocol"
import type { TimelineRow } from "@/adapter/session-ui"
import { CHAT_META, viewOf, type ChatMeta } from "@/chat-view"
import { createI18n } from "@/i18n"
import { timelineView } from "@/timeline-settings/detail"
import { BODY_LIMIT, responseBody } from "./error-body"
import {
  formatCredits,
  formatClock,
  formatClockFull,
  formatClockTime,
  formatDuration,
  formatPercent,
  formatSeconds,
  formatSpeed,
  formatTokens,
  formatUsd,
  splitAt,
} from "./format"
import { markerText } from "./marker-strings"
import { markerIndex, sameRef, switchKind } from "./markers"
import { matchRecord, type SwitchRecord } from "./records"
import { isFooter, pendingInputIDs, queuedCompactionIDs, visibleMessages, withFooters, type FooterRow } from "./rows"
import { CONTINUE_PROMPT } from "@/queue/continue-action"
import { resumable, stoppedForInactivity } from "./stall"
import { fetchedHeavyFolder, MIN_SPEED_WINDOW_MS, stepSpeed, turnSpeed, turnUsage } from "./usage"
import { chatTimelineView, footerSlots, hiddenMeta } from "./view-filter"

const A = { providerID: "own-codex-a1", id: "gpt-5.6-sol", variant: "high" }
const B = { providerID: "own-oai-b2", id: "gpt-5.5" }

let seq = 0
const id = () => `msg_${String(seq++).padStart(4, "0")}`
const user = (): SessionMessageInfo => ({ id: id(), type: "user", text: "hi", time: { created: seq } })
const switched = (model: typeof A | typeof B, previous?: typeof A | typeof B): SessionMessageInfo => ({
  id: id(),
  type: "model-switched",
  model,
  previous,
  time: { created: 1_000 + seq },
})
const step = (
  model: typeof A | typeof B,
  tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 0 } },
  cost?: number,
): SessionMessageAssistant => ({
  id: id(),
  type: "assistant",
  agent: "build",
  model,
  content: [{ type: "text", text: "ok" }],
  tokens,
  cost,
  time: { created: 10, completed: 1_010 },
})

describe("switch and compaction markers (4.5)", () => {
  test("a run of switches without a step is one marker from the first previous to the last model", () => {
    const messages = [
      user(),
      step(A),
      switched(B, A),
      switched({ ...B, variant: "low" } as typeof B, B),
      user(),
      step(B),
    ]
    const index = markerIndex(messages)
    expect([...index.switches.keys()]).toEqual([messages[3]!.id])
    const marker = index.switches.get(messages[3]!.id)!
    expect(marker.from).toEqual(A)
    expect(marker.kind).toBe("account")
    expect(marker.beforeStepID).toBe(messages[1]!.id)
    expect(marker.firstStepID).toBe(messages[5]!.id)
  })

  test("an undone switch (A→B→A, e.g. switch.undo) and the first selection draw nothing", () => {
    const messages = [switched(A), user(), step(A), switched(B, A), switched(A, B), user(), step(A)]
    expect(markerIndex(messages).switches.size).toBe(0)
  })

  test("a step between two switches keeps both markers", () => {
    const messages = [user(), step(A), switched(B, A), user(), step(B), switched(A, B), user(), step(A)]
    expect(markerIndex(messages).switches.size).toBe(2)
  })

  test("kinds: account, model, variant", () => {
    expect(switchKind(A, B)).toBe("account")
    expect(switchKind(A, { ...A, id: "gpt-5.6-luna" })).toBe("model")
    expect(switchKind(A, { ...A, variant: "low" })).toBe("variant")
    expect(sameRef(A, { ...A })).toBe(true)
    expect(sameRef(B, { ...B, variant: undefined })).toBe(true)
  })

  test("compaction: context before (last step), after (next step) and a switch right after it", () => {
    const before = step(A)
    const compaction: SessionMessageInfo = {
      id: id(),
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "s",
      time: { created: seq },
    }
    const change = switched(B, A)
    const after = step(B)
    const index = markerIndex([user(), before, compaction, change, user(), after])
    expect(index.compactions.get(compaction.id)).toEqual({
      id: compaction.id,
      beforeStepID: before.id,
      afterStepID: after.id,
      switchID: change.id,
    })
  })
})

describe("turn usage (4.5 footer)", () => {
  const line = (messageID: string, cost: Ledger.Line["cost"], cacheWrite1h: number | null = null) =>
    ({ messageID, cost, tokens: { cacheWrite1h } }) as unknown as Ledger.Line

  test("sums request size, cache ratio, billed output; first-step ratio for the rewrite tag", () => {
    const first = step(A, { input: 800, output: 10, reasoning: 0, cache: { read: 200, write: 0 } })
    const second = step(A, { input: 100, output: 30, reasoning: 20, cache: { read: 900, write: 0 } })
    const usage = turnUsage([first, second], { lineOf: () => undefined, accountKind: "codex" })
    expect(usage.input).toBe(2_000)
    expect(usage.output).toBe(60)
    expect(usage.hit).toBe(0.55)
    expect(usage.firstHit).toBe(0.2)
    expect(usage.steps.map((item) => item.durationMs)).toEqual([1_000, 1_000])
    // No ledger line yet for a subscription account: unknown, never $0 (P4).
    expect(usage.cost).toEqual({ kind: "unknown" })
  })

  test("credits come from the router ledger", () => {
    const first = step(A)
    const lines = new Map([[first.id, line(first.id, { unit: "credits", amount: 1.25, source: "ratecard" })]])
    expect(turnUsage([first], { lineOf: (key) => lines.get(key), accountKind: "codex" }).cost).toEqual({
      kind: "credits",
      value: 1.25,
    })
  })

  test("USD is core's step cost; a router-recomputed 1h-cache line replaces it and is tagged", () => {
    const first = step(B, undefined, 0.5)
    const second = step(B, undefined, 0.25)
    expect(turnUsage([first, second], { lineOf: () => undefined, accountKind: "oai" }).cost).toEqual({
      kind: "usd",
      value: 0.75,
      recomputed: false,
    })
    const lines = new Map([[second.id, line(second.id, { unit: "USD", amount: 1, source: "ratecard" }, 5_000)]])
    expect(turnUsage([first, second], { lineOf: (key) => lines.get(key), accountKind: "anth" }).cost).toEqual({
      kind: "usd",
      value: 1.5,
      recomputed: true,
    })
    expect(turnUsage([step(B, undefined, 0)], { lineOf: () => undefined, accountKind: "oai" }).cost.kind).toBe("usd")
  })

  test("a DeepSeek step priced from its time-of-day card replaces core's catalog cost and is tagged", () => {
    const priced = step(B, undefined, 0.05)
    const lines = new Map([[priced.id, line(priced.id, { unit: "USD", amount: 0.2112, source: "ratecard" })]])
    expect(turnUsage([priced], { lineOf: (key) => lines.get(key), accountKind: "ds" }).cost).toEqual({
      kind: "usd",
      value: 0.2112,
      recomputed: true,
    })
    const core = new Map([[priced.id, line(priced.id, { unit: "USD", amount: 0.05, source: "opencode" })]])
    expect(turnUsage([priced], { lineOf: (key) => core.get(key), accountKind: "ds" }).cost).toEqual({
      kind: "usd",
      value: 0.05,
      recomputed: false,
    })
  })

  test("a turn fetched a big-file folder when a Code Mode call of team.need_paths completed (06 §4.14)", () => {
    const call = (tool: string, status: string, name = "execute"): SessionMessageAssistant => ({
      ...step(A),
      content: [
        { type: "text", text: "ok" },
        {
          type: "tool",
          id: "call_1",
          name,
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text: "" }],
            metadata: { toolCalls: [{ tool, status }] },
          },
          time: { created: 1 },
        },
      ],
    })
    expect(fetchedHeavyFolder([step(A), call("team.need_paths", "completed")])).toBe(true)
    expect(fetchedHeavyFolder([call("team.need_paths", "error")])).toBe(false)
    expect(fetchedHeavyFolder([call("team.status", "completed")])).toBe(false)
    expect(fetchedHeavyFolder([call("team.need_paths", "completed", "shell")])).toBe(false)
    expect(fetchedHeavyFolder([step(A)])).toBe(false)
  })

  test("the Claude subscription slot has no price", () => {
    expect(turnUsage([step(A, undefined, 0.3)], { lineOf: () => undefined, accountKind: "claude-sub" }).cost).toEqual({
      kind: "unknown",
    })
  })
})

describe("output speed (4.5 footer t/s)", () => {
  const T = 1_000_000
  const timed = (input: {
    tokens?: { output: number; reasoning: number }
    content: SessionMessageAssistant["content"]
    created?: number
    streamed?: number
    completed?: number
  }): SessionMessageAssistant => ({
    ...step(A),
    content: input.content,
    tokens: input.tokens && { input: 100, cache: { read: 0, write: 0 }, ...input.tokens },
    time: { created: input.created ?? T, streamed: input.streamed, completed: input.completed },
  })
  const reasoning = (created: number): SessionMessageAssistantReasoning => ({
    type: "reasoning",
    text: "…",
    time: { created, completed: created },
  })
  const text: SessionMessageAssistantText = { type: "text", text: "ok" }
  const call = (created: number): SessionMessageAssistantTool => ({
    type: "tool",
    id: "call_1",
    name: "read",
    state: { status: "completed", input: {}, content: [{ type: "text", text: "x" }] },
    time: { created, ran: created + 10, completed: created + 8_000 },
  })

  test("output + reasoning tokens from the first thinking chunk to the end of the response body", () => {
    const speed = stepSpeed(
      timed({
        tokens: { output: 60, reasoning: 20 },
        content: [reasoning(T + 1_200), text],
        streamed: T + 3_200,
        completed: T + 3_250,
      }),
    )
    expect(speed).toEqual({ tokens: 80, ms: 2_000, basis: "decode", firstTokenMs: 1_200 })
  })

  test("tool execution is left out: the window ends when the response body ended, not when tools settled", () => {
    const speed = stepSpeed(
      timed({
        tokens: { output: 50, reasoning: 0 },
        content: [call(T + 500)],
        streamed: T + 1_500,
        completed: T + 9_500,
      }),
    )
    expect(speed).toEqual({ tokens: 50, ms: 1_000, basis: "decode", firstTokenMs: 500 })
    // Without `streamed` a tool step's completion includes the tool run: not timed.
    expect(
      stepSpeed(timed({ tokens: { output: 50, reasoning: 0 }, content: [call(T + 500)], completed: T + 9_500 })),
    ).toBe(null)
  })

  test("text first (no time on text parts): request start to response end, the wait for the first token included", () => {
    const speed = stepSpeed(timed({ tokens: { output: 100, reasoning: 0 }, content: [text], streamed: T + 2_000 }))
    expect(speed).toEqual({ tokens: 100, ms: 2_000, basis: "request", firstTokenMs: null })
    // An older step without `streamed` and without tool calls falls back to its completion.
    expect(stepSpeed(timed({ tokens: { output: 100, reasoning: 0 }, content: [text], completed: T + 4_000 }))?.ms).toBe(
      4_000,
    )
  })

  test("hidden reasoning (reasoning tokens, no thinking block first) is timed from the request start", () => {
    const speed = stepSpeed(
      timed({ tokens: { output: 40, reasoning: 400 }, content: [call(T + 6_000)], streamed: T + 7_000 }),
    )
    expect(speed).toEqual({ tokens: 440, ms: 7_000, basis: "request", firstTokenMs: null })
  })

  test("missing tokens, missing end, or a window under 200 ms: unknown", () => {
    expect(stepSpeed(timed({ content: [text], streamed: T + 2_000 }))).toBe(null)
    expect(stepSpeed(timed({ tokens: { output: 0, reasoning: 0 }, content: [text], streamed: T + 2_000 }))).toBe(null)
    expect(stepSpeed(timed({ tokens: { output: 10, reasoning: 0 }, content: [text] }))).toBe(null)
    expect(
      stepSpeed(
        timed({ tokens: { output: 10, reasoning: 0 }, content: [text], streamed: T + MIN_SPEED_WINDOW_MS - 1 }),
      ),
    ).toBe(null)
    // A decode window too short to time (one buffered chunk) falls back to the request window.
    const short = stepSpeed(
      timed({ tokens: { output: 10, reasoning: 5 }, content: [reasoning(T + 900), text], streamed: T + 1_000 }),
    )
    expect(short).toEqual({ tokens: 15, ms: 1_000, basis: "request", firstTokenMs: 900 })
  })

  test("a multi-step turn: all timed tokens over all timed windows; ≈ when any step is request-timed", () => {
    const first = timed({
      tokens: { output: 30, reasoning: 30 },
      content: [reasoning(T + 1_500), call(T + 2_000)],
      streamed: T + 3_500,
      completed: T + 12_000,
    })
    const second = timed({
      tokens: { output: 200, reasoning: 0 },
      content: [text],
      created: T + 12_100,
      streamed: T + 16_100,
    })
    const untimed = timed({ content: [text], created: T + 16_200, completed: T + 16_300 })
    const usage = turnUsage([first, second, untimed], { lineOf: () => undefined, accountKind: "compat" })
    expect(usage.steps.map((item) => item.speed?.basis ?? null)).toEqual(["decode", "request", null])
    // (60 + 200) tokens over (2 s + 4 s); the first token came 1.5 s after the turn's first request.
    expect(usage.speed).toEqual({ tokensPerSecond: 260 / 6, basis: "request", firstTokenMs: 1_500 })
    expect(turnSpeed([first, first].map(stepSpeed))).toEqual({
      tokensPerSecond: 30,
      basis: "decode",
      firstTokenMs: 1_500,
    })
    expect(turnSpeed([null, stepSpeed(second)])?.firstTokenMs).toBe(null)
    expect(turnSpeed([null])).toBe(null)
    expect(turnUsage([untimed], { lineOf: () => undefined, accountKind: "compat" }).speed).toBe(null)
  })

  test("formats: one decimal under 10 t/s, whole numbers above; seconds to the first token", () => {
    expect([7.44, 9.96, 42.4, 130.6].map(formatSpeed)).toEqual(["7.4", "10", "42", "131"])
    expect(formatSpeed(5)).toBe("5")
    expect([450, 1_234, 12_600].map(formatSeconds)).toEqual(["0.5", "1.2", "13"])
  })
})

describe("chat view in the transcript (4.5 대화 보기)", () => {
  const all = viewOf({ hidden: [] })
  const without = (...keys: ChatMeta[]) => viewOf({ hidden: keys })
  const speed = { tokensPerSecond: 42, basis: "decode" as const, firstTokenMs: 1_200 }

  test("footer parts follow each toggle; nothing left draws no footer", () => {
    const input = { speed, duration: true, rewrote: true, clock: true }
    expect(footerSlots(all, input)).toEqual([
      "account",
      "model",
      "input",
      "output",
      "cost",
      "rewrite",
      "speed",
      "firstToken",
      "time",
    ])
    expect(footerSlots(without("usage"), input)).toEqual(["account", "model", "speed", "firstToken", "time"])
    expect(footerSlots(without("speed"), input)).not.toContain("speed")
    expect(footerSlots(without("speed"), input)).not.toContain("firstToken")
    expect(footerSlots(without("model"), input).slice(0, 1)).toEqual(["input"])
    expect(footerSlots(without("time"), input)).not.toContain("time")
    // 날짜·시각 is off until turned on, and then comes after the elapsed time (UC 2026-10-18).
    expect(footerSlots(viewOf({ hidden: [], shown: ["clock"] }), input).slice(-2)).toEqual(["time", "clock"])
    expect(footerSlots(viewOf({ hidden: ["time"], shown: ["clock"] }), input).slice(-1)).toEqual(["clock"])
    expect(footerSlots(all, { speed: null, duration: false, rewrote: false, clock: true })).toEqual([
      "account",
      "model",
      "input",
      "output",
      "cost",
    ])
    expect(
      footerSlots(all, { speed: { ...speed, firstTokenMs: null }, duration: true, rewrote: false, clock: false }),
    ).not.toContain("firstToken")
    expect(footerSlots(viewOf({ hidden: [...CHAT_META] }), input)).toEqual([])
  })

  test("session-ui meta spans: model and time as data-hide words; the meta line's speed has none (US6-20)", () => {
    expect(hiddenMeta(all)).toBeUndefined()
    expect(hiddenMeta(without("model"))).toBe("model")
    expect(hiddenMeta(without("model", "time"))).toBe("model time")
    expect(hiddenMeta(without("speed"))).toBeUndefined()
    expect(hiddenMeta(without("usage", "thinking"))).toBeUndefined()
    // 날짜·시각 on: own's line above a prompt has the date and time, so session-ui's hover time goes.
    expect(hiddenMeta(viewOf({ hidden: [], shown: ["clock"] }))).toBe("stamp")
    expect(hiddenMeta(viewOf({ hidden: ["model"], shown: ["clock"] }))).toBe("model stamp")
  })

  test("날짜·시각 formats (UC 2026-10-18): the date always, the year only when not this year's, seconds in the tooltip", () => {
    const ko = createI18n("ko")
    const en = createI18n("en")
    const at = new Date(2026, 9, 18, 15, 42, 8).getTime()
    const now = new Date(2026, 9, 19, 9, 0).getTime()
    expect(formatClock(ko, at, now)).toBe("10월 18일 오후 3:42")
    expect(formatClock(ko, at, at)).toBe("10월 18일 오후 3:42")
    expect(formatClock(ko, new Date(2025, 9, 18, 15, 42).getTime(), now)).toBe("2025년 10월 18일 오후 3:42")
    expect(formatClockFull(ko, at)).toBe("2026년 10월 18일 일요일 오후 3:42:08")
    expect(formatClockTime(ko, at)).toBe("오후 3:42:08")
    expect(formatClock(en, at, now)).toBe("Oct 18, 3:42 PM")
  })

  test("thinking, tools and subagents become hidden session-ui categories on top of the timeline preset", () => {
    const compact = timelineView("compact")
    expect(chatTimelineView(compact, all)).toBe(compact)
    const thinking = chatTimelineView(compact, without("thinking"))
    expect(thinking.detail.thinking.placement).toBe("hidden")
    expect(thinking.reasoningMode).toBe("hidden")
    expect(thinking.detail.tools.placement).toBe("grouped")
    const tools = chatTimelineView(timelineView("detailed"), without("tools"))
    expect([tools.detail.tools, tools.detail.shell, tools.detail.edit].map((item) => item.placement)).toEqual([
      "hidden",
      "hidden",
      "hidden",
    ])
    expect(tools.detail.thinking.placement).toBe("grouped")
    expect(chatTimelineView(compact, without("subagents")).detail.subagents.placement).toBe("hidden")
    // Notices (errors, failed shells, running compactions) are the preset's.
    expect(chatTimelineView(compact, viewOf({ hidden: [...CHAT_META] })).detail.notices).toEqual(compact.detail.notices)
    const keys = [all, without("thinking"), without("tools"), without("thinking", "tools")].map(
      (shown) => chatTimelineView(compact, shown).presentationKey,
    )
    expect(new Set(keys).size).toBe(4)
  })

  test("the transcript wires the toggles: footer, markers, change summary, meta CSS", async () => {
    const source = (file: string) => Bun.file(path.join(import.meta.dir, file)).text()
    const session = await source("session.tsx")
    expect(session).toContain("chatTimelineView(timelineView(timelinePreset()), chatView())")
    expect(session).toContain("data-hide={hiddenMeta(chatView())}")
    expect(session).toContain("chatView().markers && marker()")
    expect(session).toContain("<Show when={chatView().markers}>")
    expect(session).toContain("chatView().changes && lastTurnID()")
    expect(session).toContain("chatView().changes &&")
    const footer = await source("footer.tsx")
    expect(footer).toContain("<Show when={slots().length > 0}>")
    const css = await source("transcript.css")
    for (const selector of [
      '[data-hide~="model"]',
      '[data-hide~="time"] [data-slot="text-part-meta"]',
      ":not([data-pending])",
    ])
      expect(css).toContain(selector)
    // One speed per answer (US6-20): session-ui's meta-line speed is hidden whatever 대화 보기 says.
    expect(css).toMatch(
      /\.own-transcript-body \[data-component="text-part"\] \[data-slot="text-part-meta-speed"\] \{\s*display: none;/,
    )
    // Upstream v2.2.5 moved a prompt's time into its menu: nothing of own's hides a slot that no longer exists.
    expect(css).not.toContain("user-message-meta-tail")
  })
})

describe("rows", () => {
  const row = (tag: string, turn: string, extra: Record<string, unknown> = {}) =>
    ({ _tag: tag, userMessageID: turn, ...extra }) as unknown as TimelineRow.TimelineRow

  test("a footer follows the last content row; trailing notices of the turn stay below it", () => {
    const rows = [
      row("UserMessage", "t1"),
      row("AssistantPart", "t1"),
      row("Notice", "t1", { messageID: "sw" }),
      row("TurnGap", "t2"),
      row("UserMessage", "t2"),
      row("AssistantPart", "t2"),
    ]
    const footers = new Map<string, FooterRow>()
    const next = withFooters(rows, (turn) => turn === "t1", footers)
    expect(next.map((item) => item._tag)).toEqual([
      "UserMessage",
      "AssistantPart",
      "OwnTurnFooter",
      "Notice",
      "TurnGap",
      "UserMessage",
      "AssistantPart",
    ])
    expect(isFooter(next[2]!)).toBe(true)
    // Unchanged input keeps the previous array and the same footer object (keyed rows are not re-created).
    expect(withFooters(rows, (turn) => turn === "t1", footers, next)).toBe(next)
  })

  test("queued prompts are hidden; pending steers move to the end", () => {
    const [a, b, c] = [user(), user(), user()]
    const pending = [
      { id: a!.id, type: "user", delivery: "steer" },
      { id: b!.id, type: "user", delivery: "queue" },
    ] as unknown as SessionInboxInfo[]
    expect(visibleMessages([a!, b!, c!], pending).map((item) => item.id)).toEqual([c!.id, a!.id])
    const list = [a!, b!]
    expect(visibleMessages(list, [])).toBe(list)
  })

  test("a queued compaction is its own row below the turn's footer, in admission order", () => {
    const pending = [
      { id: "cmp_2", type: "compaction", delivery: "queue" },
      { id: "msg_x", type: "user", delivery: "steer" },
      { id: "cmp_1", type: "compaction", delivery: "steer" },
    ] as unknown as SessionInboxInfo[]
    // The ids session-ui draws as `CompactionQueued` rows (upstream 2db9c2e1b3).
    expect(queuedCompactionIDs(pending)).toEqual(["cmp_2", "cmp_1"])
    expect(queuedCompactionIDs([])).toEqual([])
    const rows = [
      row("UserMessage", "t1"),
      row("AssistantPart", "t1"),
      row("CompactionQueued", "t1", { inboxID: "cmp_2" }),
    ]
    const next = withFooters(rows, () => true, new Map<string, FooterRow>())
    expect(next.map((item) => item._tag)).toEqual(["UserMessage", "AssistantPart", "OwnTurnFooter", "CompactionQueued"])
  })

  test("a pending synthetic item rides below the active work with the steers", () => {
    const [a, b, c, d] = [user(), user(), user(), user()]
    const pending = [
      { id: b!.id, type: "synthetic" },
      { id: a!.id, type: "user", delivery: "steer" },
      { id: d!.id, type: "user", delivery: "queue" },
    ] as unknown as SessionInboxInfo[]
    // The ids session-ui places at the end of the active turn (upstream 2db9c2e1b3).
    expect([...pendingInputIDs(pending)]).toEqual([b!.id, a!.id])
    expect(visibleMessages([a!, b!, c!, d!], pending).map((item) => item.id)).toEqual([c!.id, a!.id, b!.id])
  })
})

describe("response body of a failed turn (4.5, upstream c14a1f5acf)", () => {
  test("JSON is pretty-printed; plain text stays; nothing for no body or a body equal to the message", () => {
    expect(responseBody('{"error":{"message":"bad","code":400}}', "bad")).toBe(
      '{\n  "error": {\n    "message": "bad",\n    "code": 400\n  }\n}',
    )
    expect(responseBody("  <html>Bad Gateway</html>\n", "502")).toBe("<html>Bad Gateway</html>")
    expect(responseBody(undefined, "x")).toBeUndefined()
    expect(responseBody("   ", "x")).toBeUndefined()
    expect(responseBody("Rate limited ", "Rate limited")).toBeUndefined()
  })

  test("a large body is cut with an ellipsis", () => {
    const shown = responseBody("x".repeat(BODY_LIMIT + 50), "m")!
    expect(shown).toHaveLength(BODY_LIMIT + 1)
    expect(shown.endsWith("…")).toBe(true)
  })
})

describe("이어서 after a stalled or stopped turn (4.5, core patch P-018)", () => {
  test("stalls, timeouts, broken streams and inactivity stops are resumable; other failures are not", () => {
    for (const type of ["provider.transport", "provider.timeout", "provider.invalid-output", "session.inactivity"])
      expect(resumable({ type })).toBe(true)
    for (const type of ["provider.auth", "provider.rate-limit", "provider.invalid-request", "aborted", "unknown"])
      expect(resumable({ type })).toBe(false)
    expect(resumable(undefined)).toBe(false)
    expect(CONTINUE_PROMPT).toEqual({ ko: "계속", en: "Continue" })
  })

  test("only the newest idle row of an inactivity failure counts", () => {
    const idle = (outcome: "failed" | "interrupted", metadata?: Record<string, string>) =>
      ({
        id: `msg_${outcome}`,
        type: "idle",
        outcome,
        time: { created: 1 },
        ...(metadata ? { metadata } : {}),
      }) as SessionMessageInfo
    const user = { id: "msg_user", type: "user", text: "계속", time: { created: 2 } } as unknown as SessionMessageInfo
    expect(stoppedForInactivity([idle("failed", { reason: "inactivity" })])).toBe(true)
    expect(stoppedForInactivity([idle("failed", { reason: "inactivity" }), user])).toBe(false)
    expect(stoppedForInactivity([idle("failed")])).toBe(false)
    expect(stoppedForInactivity([idle("interrupted", { reason: "inactivity" })])).toBe(false)
    expect(stoppedForInactivity([])).toBe(false)
  })
})

describe("formats (7.5)", () => {
  test("tokens, money, credits, percent", () => {
    expect([940, 2_140, 9_940, 118_400, 999_400, 1_230_000].map(formatTokens)).toEqual([
      "940",
      "2.1k",
      "9.9k",
      "118k",
      "999k",
      "1.2M",
    ])
    expect(formatUsd(0.724)).toBe("0.72")
    expect(formatUsd(12.34)).toBe("12.3")
    expect(formatCredits(15.84)).toBe("15.8")
    expect(formatPercent(0.955)).toBe("96%")
    expect(formatPercent(null)).toBe("—")
  })

  test("durations and phrase splitting", () => {
    const i18n = createI18n("ko")
    expect(formatDuration(i18n, 42_300)).toBe("42초")
    expect(formatDuration(i18n, 192_000)).toBe("3분 12초")
    expect(formatDuration(i18n, 3_720_000)).toBe("1시간 2분")
    expect(splitAt(i18n.t("own.child.breadcrumb", { agent: "explore" }), "{parent}")).toEqual([
      "",
      " › 하위 에이전트 explore",
    ])
    expect(splitAt(markerText.text("ko", "own.marker.compactBy"), "{account}")).toEqual(["", "에서 요약"])
  })
})

describe("switch records", () => {
  test("a marker takes the record with the same target closest in time, within five minutes", () => {
    const record = (at: number, to = B): SwitchRecord => ({
      from: A,
      to,
      strategy: "compact-then-switch",
      reason: "manual",
      estimate: null,
      at,
    })
    const marker = {
      id: "m",
      from: A,
      to: B,
      kind: "account" as const,
      at: 100_000,
      beforeStepID: undefined,
      firstStepID: undefined,
    }
    expect(matchRecord([record(10_000), record(99_000), record(101_500)], marker)?.at).toBe(99_000)
    expect(matchRecord([record(100_000, A)], marker)).toBeUndefined()
    expect(matchRecord([record(100_000 + 6 * 60_000)], marker)).toBeUndefined()
  })
})

describe("UI-only (03 0-6, S8)", () => {
  test("the transcript, its adapter and the chat view never write to a session", async () => {
    const root = path.join(import.meta.dir, "..")
    const files = [
      ...new Glob("transcript/**/*.{ts,tsx}").scanSync(root),
      ...new Glob("adapter/**/*.{ts,tsx}").scanSync(root),
      ...new Glob("chat-view/**/*.{ts,tsx}").scanSync(root),
    ].filter((file) => !file.endsWith(".test.ts"))
    const writes =
      /\.(prompt|shell|compact|fork|update|revert|interrupt|create|remove|remember)\(|synthetic\(|inbox\.(enqueue|send)|rpc\.call\(\s*"(switch\.apply|switch\.schedule|compaction\.setSession|session\.approval\.set)/
    // Read at once: awaited one after another, each read waited for the event loop again (seconds on a loaded PC).
    const offenders = await Promise.all(
      files.map(async (file) => (writes.test(await Bun.file(path.join(root, file)).text()) ? [file] : [])),
    )
    expect(offenders.flat()).toEqual([])
  })
})
