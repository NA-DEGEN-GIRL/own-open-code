// Cache-preserving compaction (P-034, CC 2026-10-24): own-accounts' verdict on sending the whole history, counted from
// the last primary request's start, only on the Anthropic engine's breakpoint cache (CC-16) and, on the second run,
// only for a kept part the older request would miss (CC-12, live 2026-10-24); and the compaction ledger line's record
// of the request the summary came from, with the cache entry of the request sent last.

import { describe, expect, test } from "bun:test"
import { Message } from "@opencode/ai/effect"
import type { SessionHttpRequest, SessionModelRequest } from "@opencode/plugin/promise/session"
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import { Account, CompactionCache } from "@own/protocol"
import type { Module } from "../../src/module.js"
import { Modules } from "../../src/modules.js"
import {
  ANTH,
  CODEX,
  DEFAULT_SEEDS,
  DS,
  SESSION,
  event,
  httpEvent,
  ok,
  registry,
  setup,
  step,
} from "./support.js"

const ANTH_CARD = {
  match: { kind: "anth" },
  unit: "USD",
  in: 4,
  read: 0.2,
  write: 5,
  out: 20,
  ttl: { warmLowerSec: 300, coldUpperSec: 300 },
} as const
const DS_CARD = { match: { kind: "ds" }, unit: "USD", in: 1, read: 0.1, ttl: { warmLowerSec: 0, coldUpperSec: null } } as const
const OAI = "own-oai-tst6"
const OAI_NEW = {
  match: { kind: "oai", modelGte: "gpt-5.6" },
  unit: "USD",
  in: 2,
  read: 0.2,
  ttl: { warmLowerSec: 1800, coldUpperSec: 1800 },
  lookback: { messageEnds: 20 },
} as const
const OAI_OLD = {
  match: { kind: "oai", modelLt: "gpt-5.6" },
  unit: "USD",
  in: 2,
  read: 0.2,
  ttl: { warmLowerSec: 1800, coldUpperSec: 86_400 },
} as const
const WITH_OAI = registry([...DEFAULT_SEEDS, { id: "acc_01TESTOAI0000000000000000", kind: "oai", providerID: OAI }])
const ref = Schema.decodeUnknownSync(Model.Ref)
const OPUS = ref({ providerID: ANTH, id: "claude-opus-5-5" })
const CL01 = Account.ID.make("acc_01CLAUDEONE000000000000000")
const CL03 = Account.ID.make("acc_01CLAUDETHREE0000000000000")

function primary(model: { readonly providerID: string; readonly id: string; readonly variant?: string }) {
  // SAFETY: the fields telemetry reads of the model.request hook event.
  return { sessionID: SESSION, agent: "build", model, kind: "primary", headers: {} } as unknown as SessionModelRequest
}

describe("full-prefix verdict (P-034)", () => {
  test("full while the last primary request on the model started less than TTL_lo ago, older after", async () => {
    await using t = await setup()
    await ok(t.telemetry.ratecardsSet, { cards: [ANTH_CARD, DS_CARD] })
    expect(await t.telemetry.prefixVerdict({ sessionID: SESSION, model: OPUS })).toEqual({
      prefix: "older",
      reason: "model",
    })
    t.telemetry.onModelRequest(primary(OPUS))
    t.clock.advance(299_000)
    expect(await t.telemetry.prefixVerdict({ sessionID: SESSION, model: OPUS })).toEqual({
      prefix: "full",
      reason: "warm",
      ageMs: 299_000,
      ttlMs: 300_000,
    })
    t.clock.advance(1_000)
    expect(await t.telemetry.prefixVerdict({ sessionID: SESSION, model: OPUS })).toMatchObject({
      prefix: "older",
      reason: "cold",
    })
    // Another variant is another cache.
    t.telemetry.onModelRequest(primary(OPUS))
    expect(await t.telemetry.prefixVerdict({ sessionID: SESSION, model: ref({ ...OPUS, variant: "high" }) })).toEqual({
      prefix: "older",
      reason: "model",
    })
  })

  test("only the Anthropic engine: a longest-prefix cache and unmeasured OpenAI keep the older request", async () => {
    await using t = await setup({ registry: WITH_OAI })
    await ok(t.telemetry.ratecardsSet, { cards: [ANTH_CARD, DS_CARD, OAI_NEW, OAI_OLD] })
    const verdict = async (model: { readonly providerID: string; readonly id: string; readonly variant?: string }) => {
      t.telemetry.onModelRequest(primary(model))
      return (await t.telemetry.prefixVerdict({ sessionID: SESSION, model: ref(model) })).reason
    }
    // ChatGPT (over HTTP too), DeepSeek with or without thinking, OpenAI before 5.6, a built-in provider.
    expect(await verdict({ providerID: CODEX, id: "gpt-5.5" })).toBe("longest-prefix")
    expect(await verdict({ providerID: DS, id: "deepseek-v4-pro", variant: "high" })).toBe("longest-prefix")
    expect(await verdict({ providerID: DS, id: "deepseek-v4-pro", variant: "none" })).toBe("longest-prefix")
    expect(await verdict({ providerID: OAI, id: "gpt-5.5" })).toBe("longest-prefix")
    expect(await verdict({ providerID: "openai", id: "gpt-6-astra" })).toBe("longest-prefix")
    // OpenAI GPT-5.6+ has a breakpoint lookback on its card, but the full request was not measured there (CC-16).
    expect(await verdict({ providerID: OAI, id: "gpt-5.6-sol" })).toBe("unmeasured")
    // The `anth` slot and the Claude subscription slot (no own slot, 20 blocks, 5 minutes).
    expect(await verdict({ providerID: ANTH, id: "claude-opus-5-5" })).toBe("warm")
    expect(await verdict({ providerID: "anthropic", id: "claude-opus-5-5" })).toBe("warm")
  })

  // SL-8: the Claude accounts share `anthropic`, each with its own cache. The last primary request ran on AC-03; after
  // the conversation moved to AC-01 the compaction runs there, where nothing is cached.
  test("right after a Claude account switch the compaction's cache is cold: it runs on the new account", async () => {
    const tree = { accountID: CL03 }
    const claude = (deps: Parameters<Modules.Factories["claude"]>[0], peers: Module.Peers) => ({
      ...Modules.FACTORIES.claude(deps, peers),
      accountOf: async () => tree.accountID,
      peek: () => tree.accountID,
    })
    await using t = await setup({ claudeSlot: true, peers: { claude } })
    const model = ref({ providerID: "anthropic", id: "claude-opus-5-5" })
    t.telemetry.onModelRequest(primary(model))
    t.deps.runtime.claude.remember(SESSION, CL03)
    t.clock.advance(60_000)
    expect(await t.telemetry.prefixVerdict({ sessionID: SESSION, model })).toEqual({
      prefix: "full",
      reason: "warm",
      ageMs: 60_000,
      ttlMs: 300_000,
    })
    tree.accountID = CL01
    expect(await t.telemetry.prefixVerdict({ sessionID: SESSION, model })).toEqual({
      prefix: "older",
      reason: "account",
      ageMs: 60_000,
    })
    expect((await t.telemetry.primaryCache(SESSION))?.moved).toBe(true)
    // Back on AC-03 within its lifetime: its cache is still there.
    tree.accountID = CL03
    expect((await t.telemetry.prefixVerdict({ sessionID: SESSION, model })).reason).toBe("warm")
  })

  test("an OpenAI card without a lookback is no breakpoint cache", async () => {
    await using t = await setup({ registry: WITH_OAI })
    const { lookback: _, ...plain } = OAI_NEW
    await ok(t.telemetry.ratecardsSet, { cards: [plain] })
    const model = ref({ providerID: OAI, id: "gpt-5.6-sol" })
    t.telemetry.onModelRequest(primary(model))
    expect((await t.telemetry.prefixVerdict({ sessionID: SESSION, model })).reason).toBe("longest-prefix")
  })
})

/**
 * The kept part of a long agent turn (study S1) after an older question: the kept question, `steps` tool rounds (a
 * call, then its result: two positions each) and the final answer.
 */
function longTurn(steps: number, prefix = "msg_a") {
  const rounds = Array.from({ length: steps }, (_, index) => [
    Message.make({
      id: `${prefix}${index + 1}`,
      role: "assistant",
      content: [{ type: "tool-call", id: `call_${index}`, name: "read", input: {} }],
    }),
    Message.tool({ id: `call_${index}`, name: "read", result: "line" }),
  ]).flat()
  return [
    Message.make({ id: "msg_old", role: "user", content: "Earlier question" }),
    Message.make({ id: "msg_u", role: "user", content: "Read the files." }),
    ...rounds,
    Message.make({ id: "msg_end", role: "assistant", content: "Done." }),
  ]
}

describe("full-prefix second run (CC-12)", () => {
  const kept = { messageID: "msg_u" }

  test("a kept part within the lookback is short; a longer one is fresh while its covering entry is warm", async () => {
    await using t = await setup()
    await ok(t.telemetry.ratecardsSet, { cards: [ANTH_CARD] })
    const directory = t.deps.location.directory
    const verdict = (messages: ReadonlyArray<Message>) =>
      t.telemetry.recentVerdict({ sessionID: SESSION, model: OPUS, messages, kept })
    // The question, one round and the answer: 4 positions.
    expect(await verdict(longTurn(1))).toBe("short")
    // 11 rounds: 24 positions. The request of step 10 ended 19 positions after the older end, step 11's at 21: the
    // older request reads step 10's entry.
    const base = t.clock.now()
    for (const index of Array.from({ length: 11 }, (_, i) => i))
      for (const item of step({
        providerID: ANTH,
        modelID: "claude-opus-5-5",
        messageID: `msg_a${index + 1}`,
        at: base + index * 30_000,
        directory,
        usage: { input: 1_000 },
      }))
        await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    t.clock.advance(11 * 30_000)
    // Step 10 started 60 s ago: fresh.
    expect(await verdict(longTurn(11))).toBe("fresh")
    // A covering step this process never saw start may be stale.
    expect(await verdict(longTurn(11, "msg_b"))).toBeUndefined()
    // Five minutes after it started the entry may be gone: the whole history goes.
    t.clock.advance(4 * 60_000)
    expect(await verdict(longTurn(11))).toBeUndefined()
  })
})

describe("compaction ledger line (CC 2026-10-24)", () => {
  test("records the request its summary came from, and an idle trigger", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const now = t.clock.now()
    for (const item of step({ providerID: CODEX, messageID: "m1", at: now, directory, usage: { input: 1_000 } }))
      await t.telemetry.onEvent?.(item, { local: true })
    const ended = (at: number, metadata: Record<string, unknown>) => ({
      ...event({
        type: "session.compaction.ended",
        at,
        directory,
        data: {
          sessionID: SESSION,
          reason: "manual",
          model: { providerID: CODEX, id: "gpt-5.5" },
          text: "summary",
          recent: "",
          cost: 0,
          tokens: { input: 100, output: 300, reasoning: 0, cache: { read: 900, write: 0 } },
        },
      }),
      metadata,
    })
    await t.telemetry.onEvent?.(
      ended(now + 5_000, {
        [CompactionCache.PREFIX_KEY]: { request: "full" },
        [CompactionCache.CACHE_KEY]: { prefix: "full", reason: "warm", ageMs: 1_000, ttlMs: 300_000 },
        [CompactionCache.TRIGGER_KEY]: "idle",
      }),
      { local: true },
    )
    await t.telemetry.onEvent?.(
      ended(now + 9_000, { [CompactionCache.CACHE_KEY]: { prefix: "older", reason: "cold", ageMs: 400_000 } }),
      { local: true },
    )
    await t.telemetry.onEvent?.(ended(now + 12_000, {}), { local: true })
    // The model-free digest after a failed full request: the record stays in the metadata, the line claims no request.
    await t.telemetry.onEvent?.(
      ended(now + 15_000, {
        [CompactionCache.PREFIX_KEY]: { request: "older", reason: "failed" },
        fallback: { failed: `${CODEX}/gpt-5.5`, reason: "refused" },
      }),
      { local: true },
    )
    // A stand-in wrote it: its own older request on another model read nothing the session cached, even where core
    // recorded `full` for the session model's attempt (nothing kept, CC-16).
    await t.telemetry.onEvent?.(
      ended(now + 18_000, {
        [CompactionCache.PREFIX_KEY]: { request: "full" },
        fallback: { failed: `${CODEX}/gpt-5.5`, reason: "refused", model: `${DS}/deepseek-v4-pro` },
      }),
      { local: true },
    )
    await t.telemetry.flush()
    const lines = (await ok(t.telemetry.ledgerSession, { sessionID: SESSION })).steps
    expect(lines.filter((line) => line.kind === "compaction").map((line) => [line.hit, line.compaction])).toEqual([
      [0.9, { request: "full", trigger: "idle" }],
      [0.9, { request: "older", reason: "cold" }],
      [0.9, undefined],
      [0.9, undefined],
      [0.9, { request: "older", reason: "stand-in" }],
    ])
  })

  test("the cache entry is the request sent last: its start and its own size, not the sum", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const start = t.clock.now()
    for (const item of step({ providerID: CODEX, messageID: "m1", at: start, directory, usage: { input: 1_000 } }))
      await t.telemetry.onEvent?.(item, { local: true })
    const sent = async (input: number) => {
      // SAFETY: the fields telemetry reads of the http.request hook event.
      t.telemetry.onHttpRequest({ sessionID: SESSION, kind: "compaction" } as unknown as SessionHttpRequest)
      const usage = { input_tokens: input, input_tokens_details: { cached_tokens: input - 100 }, output_tokens: 10 }
      const body = `data: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`
      await t.telemetry.onHttpResponse(httpEvent({ providerID: CODEX, kind: "compaction", response: new Response(body) }))
    }
    // The full request (50k) failed after its reply; the older one (30k) went a minute later and failed too.
    t.clock.advance(10_000)
    await sent(50_000)
    t.clock.advance(60_000)
    const last = t.clock.now()
    await sent(30_000)
    await t.telemetry.onEvent?.(
      event({
        type: "session.compaction.failed",
        at: last + 5_000,
        directory,
        data: {
          sessionID: SESSION,
          reason: "manual",
          model: { providerID: CODEX, id: "gpt-5.5" },
          error: { type: "compaction.failed", message: "x" },
          cost: 0,
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 79_800, write: 0 } },
        },
      }),
      { local: true },
    )
    await t.telemetry.flush()
    const line = (await ok(t.telemetry.ledgerSession, { sessionID: SESSION })).steps.find(
      (item) => item.kind === "compaction",
    )
    expect(line?.P).toBe(80_000)
    const slot = (await ok(t.telemetry.cacheState, { sessionID: SESSION })).slots.find(
      (item) => item.providerID === CODEX,
    )
    expect([slot?.L, slot?.lastReqAt]).toEqual([30_000, last])
  })
})
