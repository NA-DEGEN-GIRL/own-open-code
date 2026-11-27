// 압축 내용 (03 §4.5 "압축 내용 보기", UC 2026-10-18): the entries over stored compaction messages (order, the current
// one, summary / native / failed / running, own's checkpoint metadata, the request usage, the context sizes from the
// loaded steps), the strings, and where the dialog is opened (the `⋯` menu, the compaction marker, the shell layer).
// Every message is fake.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { CompactionCache } from "@own/protocol/compaction-cache"
import { compactionEntries, USER_MESSAGES_KEY, type CompactionMessage } from "./model"
import { compactionDialogEn, compactionDialogKo, compactionDialogText } from "./dialog-strings"
import { compactionsEn, compactionsKo } from "./strings"

const SRC = path.join(import.meta.dir, "..")
const source = (file: string) => Bun.file(path.join(SRC, file)).text()
const MODEL = { providerID: "own-codex-a1", id: "gpt-5.6-sol" }
const tokens = (input: number, output: number, read = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write: 0 },
})

const user = (id: string, at: number) =>
  ({ id, type: "user", text: "요청", time: { created: at } }) as SessionMessageInfo
const step = (id: string, at: number, used: ReturnType<typeof tokens>) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: MODEL,
    content: [],
    tokens: used,
    time: { created: at, completed: at + 10 },
  }) as unknown as SessionMessageInfo

const summary = (id: string, at: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: "compaction",
    status: "completed",
    reason: "auto",
    model: MODEL,
    summary: `## 요약 ${id}`,
    tokens: tokens(150_000, 3_000, 20_000),
    time: { created: at },
    ...extra,
  }) as CompactionMessage

const native = (id: string, at: number) =>
  ({
    id,
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "",
    model: { providerID: "openai", id: "gpt-5.5" },
    native: {
      messages: [
        { role: "user", content: [{ type: "text", text: "보이는 글" }] },
        { role: "assistant", content: [{ type: "compaction", provider: "openai", encrypted: "gAAAAB1234" }] },
        { role: "assistant", content: [{ type: "compaction", provider: "openai", id: "c2", encrypted: "gAAAAB56" }] },
      ],
    },
    time: { created: at },
  }) as unknown as CompactionMessage

describe("compaction entries", () => {
  test("in conversation order; the newest completed one is what the model gets now", () => {
    const failed = {
      id: "msg_c",
      type: "compaction",
      status: "failed",
      reason: "auto",
      error: { type: "provider", message: "context_length_exceeded" },
      time: { created: 30 },
    } as CompactionMessage
    const running = {
      id: "msg_d",
      type: "compaction",
      status: "running",
      reason: "manual",
      summary: "## 지금까지",
      time: { created: 40 },
    } as CompactionMessage
    const entries = compactionEntries([running, failed, summary("msg_b", 20), summary("msg_a", 10)], [])
    expect(entries.map((entry) => [entry.id, entry.current, entry.content.kind])).toEqual([
      ["msg_a", false, "summary"],
      ["msg_b", true, "summary"],
      ["msg_c", false, "failed"],
      ["msg_d", false, "running"],
    ])
    expect(entries[2]?.content).toEqual({ kind: "failed", error: "context_length_exceeded" })
    expect(entries[3]?.reason).toBe("manual")
    expect(compactionEntries([], [])).toEqual([])
  })

  test("a summary keeps its text, the recent messages and own's put-back user messages; the request usage is its own", () => {
    const [entry] = compactionEntries(
      [
        summary("msg_a", 10, {
          metadata: {
            // Written before upstream v2.1 (or rebuilt from `keepID` by session.context): the kept text itself.
            recent: "<최근 대화>",
            [USER_MESSAGES_KEY]: ["첫 요청", 7, "둘째 요청"],
            "own.harness.compaction.format": "checkpoint-v1",
          },
        }),
      ],
      [],
    )
    expect(entry?.content).toEqual({
      kind: "summary",
      summary: "## 요약 msg_a",
      recent: "<최근 대화>",
      userMessages: ["첫 요청", "둘째 요청"],
    })
    expect(entry?.model).toEqual(MODEL)
    // The compaction request's input with its cache; its output. Not the context before or after.
    expect(entry?.usage).toEqual({ input: 170_000, output: 3_000 })
    expect(entry?.before).toBeUndefined()
  })

  test("a summary since upstream v2.1 stores where its kept messages start: their count among the loaded ones", () => {
    const loaded = [
      { id: "msg_1" },
      { id: "msg_2" },
      { id: "msg_3" },
      { id: "msg_c" },
    ] as unknown as SessionMessageInfo[]
    const [entry] = compactionEntries([summary("msg_c", 10, { metadata: { keepID: "msg_2" } })], loaded)
    expect(entry?.content).toEqual({ kind: "summary", summary: "## 요약 msg_c", recent: "", kept: 2, userMessages: [] })
    // Not loaded: nothing is said about them.
    const [unknown] = compactionEntries([summary("msg_c", 10, { metadata: { keepID: "msg_0" } })], loaded)
    expect(unknown?.content).toEqual({ kind: "summary", summary: "## 요약 msg_c", recent: "", userMessages: [] })
  })

  test("a provider-native one is encrypted: only the model that made it and the size are known", () => {
    const [entry] = compactionEntries([native("msg_n", 10)], [])
    expect(entry?.content).toEqual({
      kind: "native",
      providerID: "openai",
      modelID: "gpt-5.5",
      items: 2,
      size: "gAAAAB1234".length + "gAAAAB56".length,
    })
    expect(entry?.current).toBe(true)
  })

  test("own's fallback: a stand-in model, or none when code made the checkpoint", () => {
    const entries = compactionEntries(
      [
        summary("msg_a", 10, {
          metadata: { fallback: { failed: "a/b", reason: "timeout", model: "own-oai-c3/gpt-5.5" } },
        }),
        summary("msg_b", 20, { metadata: { fallback: { failed: "a/b", reason: "rate limit" } } }),
        summary("msg_c", 30, { metadata: { fallback: "weird" } }),
      ],
      [],
    )
    expect(entries.map((entry) => entry.fallback)).toEqual([
      { model: "own-oai-c3/gpt-5.5", reason: "timeout" },
      { reason: "rate limit" },
      undefined,
    ])
  })

  test("the context before and after come from the loaded steps around it, like the marker", () => {
    const loaded = [
      user("msg_1", 1),
      step("msg_2", 2, tokens(1_000, 500, 149_000)),
      summary("msg_3", 3),
      user("msg_4", 4),
      step("msg_5", 5, tokens(30_000, 200, 11_000)),
    ]
    const [entry] = compactionEntries([summary("msg_3", 3)], loaded)
    expect(entry?.before).toBe(150_500)
    expect(entry?.after).toBe(41_000)
    // Not loaded around it: no sizes, the request usage still there.
    const [alone] = compactionEntries([summary("msg_9", 9)], loaded)
    expect(alone?.before).toBeUndefined()
    expect(alone?.usage).toBeDefined()
  })

  test("the request it came from (P-034), its cached share and an idle trigger (CC 2026-10-24)", () => {
    const full = summary("msg_1", 1, {
      metadata: { prefix: { request: "full" }, "own.compaction.trigger": "idle" },
      tokens: tokens(1_000, 3_000, 99_000),
    })
    const cold = summary("msg_2", 2, {
      metadata: { "own.compaction.cache": { prefix: "older", reason: "cold", ageMs: 400_000, ttlMs: 300_000 } },
    })
    const [first, second, third] = compactionEntries([full, cold, summary("msg_3", 3)], [])
    expect(first).toMatchObject({ request: { request: "full", trigger: "idle" }, cached: 0.99 })
    expect(second?.request).toEqual({ request: "older", reason: "cold" })
    expect(second?.cached).toBeCloseTo(20_000 / 170_000)
    expect(third?.request).toBeUndefined()
    expect(compactionDialogText.text("ko", "own.compactions.request.olderBecause", { reason: "캐시가 식어서" })).toBe(
      "앞부분만 요청(캐시가 식어서)",
    )
    expect(compactionsKo["own.compactions.idle"]).toBe("자리를 비운 사이 압축했어요")
  })

  test("every reason own-accounts and core record has words; the digest shows no request (CC-12)", async () => {
    const reasons = [
      ...CompactionCache.CacheReason.literals.filter((reason) => reason !== "warm"),
      ...CompactionCache.RecentReason.literals,
      ...["overflow", "thinking", "fit", "tier", "failed", "flattened", "declined", "stand-in"],
    ]
    const dialog = await source("compactions/dialog.tsx")
    for (const reason of reasons) {
      expect(Object.hasOwn(compactionDialogKo, `own.compactions.reason.${reason}`)).toBe(true)
      expect(Object.hasOwn(compactionDialogEn, `own.compactions.reason.${reason}`)).toBe(true)
      expect(dialog).toContain(`"${reason}"`)
    }
    const digest = summary("msg_4", 4, {
      metadata: {
        prefix: { request: "older", reason: "failed" },
        fallback: { failed: "own-anth-a/claude-opus-5-5", reason: "refused" },
      },
    })
    expect(compactionEntries([digest], [])[0]?.request).toBeUndefined()
    // A stand-in's summary read nothing the session cached, whatever core recorded for the session model (CC-16).
    const standIn = summary("msg_5", 5, {
      metadata: {
        prefix: { request: "full" },
        fallback: { failed: "own-anth-a/claude-opus-5-5", reason: "refused", model: "own-ds-b/deepseek-v4-pro" },
      },
    })
    expect(compactionEntries([standIn], [])[0]?.request).toEqual({ request: "older", reason: "stand-in" })
    expect(compactionDialogText.text("ko", "own.compactions.reason.stand-in")).toBe("다른 모델이 대신 요약해서")
  })
})

describe("압축 내용 strings and wiring", () => {
  test("Korean and English words", () => {
    for (const key of Object.keys(compactionsEn)) expect(Object.hasOwn(compactionsKo, key)).toBe(true)
    for (const key of Object.keys(compactionDialogEn)) expect(Object.hasOwn(compactionDialogKo, key)).toBe(true)
    expect(compactionsKo["own.compactions.open"]).toBe("압축 내용 보기")
    expect(compactionDialogText.text("ko", "own.compactions.native", { provider: "OpenAI" })).toBe(
      "OpenAI가 자체 방식으로 압축해 암호화해 두었어요. 그 회사만 읽을 수 있어 내용을 보여 드릴 수 없어요.",
    )
  })

  test("opened from the ⋯ menu and the compaction marker; the shell mounts the lazy layer", async () => {
    const menu = await source("shell/session-menu.tsx")
    expect(menu).toContain('label: compactions("own.compactions.open")')
    expect(menu).toContain("onSelect: () => openCompactions({ serverKey, sessionID })")
    const marker = await source("transcript/compaction-marker.tsx")
    expect(marker).toContain('data-testid="compaction-open-view"')
    expect(marker).toContain("messageID: props.message().id")
    expect(await source("shell/app-shell.tsx")).toContain("<CompactionsLayer />")
    expect(await source("compactions/layer.tsx")).toContain('lazy(() => import("./dialog"))')
    // The server's list, every page; nothing is written.
    const dialog = await source("compactions/dialog.tsx")
    expect(dialog).toContain('type: "compaction", order: "asc", limit: 200, cursor')
    expect(dialog).not.toMatch(/rpc\.call|\.prompt\(|session\.compact/)
  })
})
