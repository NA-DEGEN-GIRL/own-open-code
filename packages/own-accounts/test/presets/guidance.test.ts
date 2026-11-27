// The `own.preset` guidance entry (07 §3.3): role cards relative to the main (company, billing, rough relation; never a
// model name, account, slot, price or window), when the entry changes, and the self-HTTP writer against a fake own
// service on 127.0.0.1. Real slots and presets over the 2026-10-01 fixture catalog; every account and password is fake.

import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Account, Preset } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import { PresetGuidance } from "../../src/presets/guidance.js"
import {
  CLAUDE,
  CODEX_A,
  DEEPSEEK_KEY,
  OAI,
  OLLAMA,
  OPENAI_KEY,
  harness,
  type Harness,
} from "./fixtures/catalog-2026-10-01.js"

const decodeWorkers = Schema.decodeUnknownSync(Preset.Workers)

/** `by-role` workers whose roles have these targets. */
function roles(rows: Partial<Record<Preset.Role, ReadonlyArray<unknown>>>) {
  return decodeWorkers({
    mode: "by-role",
    roles: Object.fromEntries(Object.entries(rows).map(([role, targets]) => [role, { targets, effort: "inherit" }])),
  })
}

/** The cards of `workers` for this main Ref, the preset resolved like the apply path (lighter pairs decided). */
async function cardsFor(
  h: Harness,
  ref: { providerID: string; id: string; variant?: string },
  workers: Preset.Workers,
) {
  const resolver = h.presets.resolver
  const main = await resolver.main(ref)
  if (!main) throw new Error(`no main for ${ref.providerID}/${ref.id}`)
  const resolution = await resolver.resolve({ workers }, main, { write: true })
  return PresetGuidance.cards(resolver, workers, main, resolution)
}

const ASTRA = { providerID: CODEX_A, id: "gpt-6-astra", variant: "high" }
const SOL = { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" }
const LUNA = { providerID: CODEX_A, id: "gpt-6-luna" }
const OPUS_PIN = { pin: { account: CLAUDE, model: "claude-opus-5-5" } }

describe("role cards (07 §3.3)", () => {
  test("the lighter pair is lighter on the main account; a main already in the cheapest family runs like the main", async () => {
    await using h = await harness()
    const workers = roles({ explore: [{ rel: "lighter" }], general: [{ rel: "main" }] })
    expect(await cardsFor(h, ASTRA, workers)).toEqual({
      general: Preset.MAIN_CARD,
      explore: { relation: "lighter", runs: "main" },
    })
    expect((await cardsFor(h, LUNA, workers)).explore).toEqual(Preset.MAIN_CARD)
  })

  test("a pinned target: another company's subscription, related to the main by input price", async () => {
    await using h = await harness()
    const workers = roles({ "own-review": [OPUS_PIN] })
    // Opus 5.5 ($4) against Sol ($2) and Astra ($10): the relation follows the main, the company never changes.
    expect(await cardsFor(h, SOL, workers)).toEqual({
      "own-review": { relation: "stronger", runs: "subscription", company: "anthropic" },
    })
    expect(await cardsFor(h, ASTRA, workers)).toEqual({
      "own-review": { relation: "lighter", runs: "subscription", company: "anthropic" },
    })
    // Moving between models of one price tier keeps the card (and the cached prefix) the same.
    expect(await cardsFor(h, { providerID: CODEX_A, id: "gpt-6.1-sol", variant: "high" }, workers)).toEqual(
      await cardsFor(h, SOL, workers),
    )
  })

  test("paid APIs, the main account itself, a local model and an account that is gone", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const paid = roles({
      "own-quick": [{ pin: { account: DEEPSEEK_KEY, model: "deepseek-flash" } }],
      "own-deep": [{ pin: { account: OPENAI_KEY, model: "gpt-6-sol" } }],
      explore: [{ pin: { account: "local:ollama", model: "qwen3-coder:30b" } }],
      "own-review": [{ pin: { account: Account.ID.make("acc_gone"), model: "gpt-6-sol" } }],
    })
    expect(await cardsFor(h, SOL, paid)).toEqual({
      "own-quick": { relation: "lighter", runs: "paid", company: "deepseek" },
      // The main's own model on an OpenAI API key: the same model, from the main's own company.
      "own-deep": { relation: "same", runs: "paid" },
      // No price for a local model: lighter than a hosted main.
      explore: { relation: "lighter", runs: "local" },
      "own-review": Preset.MAIN_CARD,
    })
    // An OpenAI API key main with a lighter model pinned on that same account.
    const own = roles({ explore: [{ pin: { account: OPENAI_KEY, model: "gpt-6-luna" } }] })
    expect(await cardsFor(h, { providerID: OAI, id: "gpt-6-sol" }, own)).toEqual({
      explore: { relation: "lighter", runs: "main" },
    })
  })

  test("`same` has no cards; `single` gives every role the same card, so the LLM has nothing to pick", async () => {
    await using h = await harness()
    expect(await cardsFor(h, SOL, decodeWorkers({ mode: "same", roles: {} }))).toEqual({})
    const single = await cardsFor(h, SOL, decodeWorkers({ mode: "single", single: OPUS_PIN, roles: {} }))
    expect(Object.keys(single).toSorted()).toEqual([...Preset.ROLES].toSorted())
    expect(PresetGuidance.targeted(decodeWorkers({ mode: "same", roles: {} }))).toBe(false)
    expect(
      PresetGuidance.render({ preset: Preset.builtin("codex"), ultra: false, level: "recommended", cards: single }),
    ).toBeNull()
  })
})

describe("render and plan (07 §3.3, §5.2)", () => {
  const review = { "own-review": { relation: "stronger", runs: "subscription", company: "anthropic" } } as const

  test("평소대로 has no entry; ultra delegates actively with the ultra level's caps", () => {
    expect(
      PresetGuidance.render({ preset: Preset.builtin("codex"), ultra: false, level: "recommended", cards: {} }),
    ).toBeNull()
    const ultra = PresetGuidance.render({
      preset: Preset.builtin("codex"),
      ultra: true,
      level: "recommended",
      cards: {},
    })
    expect(ultra?.text).toContain("Delegation mode: active.")
    expect(ultra?.text).toContain("at most 8 subagents running at once, at most 24 per user message")
    const large = PresetGuidance.render({ preset: Preset.builtin("codex"), ultra: true, level: "large", cards: review })
    expect(large?.text).toContain("at most 64 subagents running at once, at most 128 per user message")
  })

  test("the entry changes only when the hash does", () => {
    const one = PresetGuidance.render({
      preset: { ...Preset.builtin("codex"), delegation: "when-useful" },
      ultra: false,
      level: "recommended",
      cards: review,
    })
    expect(PresetGuidance.plan(null, null)).toBe("unchanged")
    expect(PresetGuidance.plan(null, one)).toBe("written")
    expect(PresetGuidance.plan(one?.hash ?? null, one)).toBe("unchanged")
    expect(PresetGuidance.plan("fnv1a64:0000000000000000", one)).toBe("written")
    expect(PresetGuidance.plan(one?.hash ?? null, null)).toBe("removed")
  })
})

interface Seen {
  readonly method: string
  readonly path: string
  readonly directory: string | null
  readonly authorization: string | null
  readonly body: string
}

const servers: Array<{ stop: (force?: boolean) => unknown }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/** A fake own service on 127.0.0.1; `answer` decides each response (default 204). */
function serve(answer: (request: Request) => Response = () => new Response(null, { status: 204 })) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seen.push({
        method: request.method,
        path: url.pathname,
        directory: url.searchParams.get("location[directory]"),
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      })
      return answer(request)
    },
  })
  servers.push(server)
  return { seen, url: `http://127.0.0.1:${server.port}` }
}

const PLACE = { sessionID: "ses_one", directory: process.platform === "win32" ? "C:\\work\\a b" : "/work/a b" }

describe("the self-HTTP writer (06 §2.6, 07 §3.3)", () => {
  test("PUT carries the text as the entry value, DELETE removes it; both name the session's location", async () => {
    const service = serve()
    const writer = PresetGuidance.writer(() => ServiceTarget.fixed({ url: service.url, password: "fake-one" }))
    expect(await writer.put(PLACE, "guidance text")).toEqual({ ok: true })
    expect(await writer.remove(PLACE)).toEqual({ ok: true })
    const path = "/api/experimental/session/ses_one/instructions/entries/own.preset"
    expect(service.seen).toEqual([
      {
        method: "PUT",
        path,
        directory: PLACE.directory,
        authorization: ServiceTarget.basic("fake-one"),
        body: JSON.stringify({ value: "guidance text" }),
      },
      { method: "DELETE", path, directory: PLACE.directory, authorization: ServiceTarget.basic("fake-one"), body: "" },
    ])
  })

  test("a 401 reads the registration again once; other failures and a missing service are reported, never thrown", async () => {
    const service = serve((request) =>
      request.headers.get("authorization") === ServiceTarget.basic("fake-new")
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 401 }),
    )
    const passwords = ["fake-old", "fake-new"]
    const source: ServiceTarget.Source = {
      current: async () => ({ url: service.url, authorization: ServiceTarget.basic(passwords[0] ?? "") }),
      invalidate: () => void passwords.shift(),
    }
    expect(await PresetGuidance.writer(() => source).put(PLACE, "x")).toEqual({ ok: true })
    expect(service.seen.map((request) => request.authorization)).toEqual([
      ServiceTarget.basic("fake-old"),
      ServiceTarget.basic("fake-new"),
    ])

    const failing = serve(() => new Response(null, { status: 404, statusText: "Not Found" }))
    const writer = PresetGuidance.writer(() => ServiceTarget.fixed({ url: failing.url, password: "fake" }))
    expect(await writer.remove(PLACE)).toEqual({ ok: false, status: 404, message: "Not Found" })
    // Not loopback, or no registration file: nothing is sent.
    const none = PresetGuidance.writer(() => ServiceTarget.fixed({ url: "http://example.com", password: "fake" }))
    expect(await none.put(PLACE, "x")).toMatchObject({ ok: false, status: null })
  })
})

describe("PresetGuidance.pool (07 §3.3 모델 묶음, T4)", () => {
  const workers = Schema.decodeUnknownSync(Preset.Workers)({
    mode: "same",
    roles: {},
    pool: [
      { key: "gpt-6-luna", model: "gpt-6-luna", card: { name: "GPT-6 Luna", at: 1 } },
      { key: "claude-opus-5-5", model: "claude-opus-5-5", account: "acc_claude_slot", note: "reviews" },
    ],
  })
  const resolution = (skip: boolean) =>
    Schema.decodeUnknownSync(Preset.Resolution)({
      main: { providerID: "own-codex-aaaa", id: "gpt-6-sol" },
      roles: {},
      pool: {
        main: { runs: "main", company: "openai", price: 2, local: false },
        entries: [
          { key: "gpt-6-luna", ref: { providerID: "own-codex-aaaa", id: "gpt-6-luna" }, runs: "main", price: 0.1 },
          {
            key: "claude-opus-5-5",
            ...(skip ? { skip: "r4" } : { ref: { providerID: "anthropic", id: "claude-opus-5-5" } }),
            runs: "subscription",
            company: "anthropic",
            price: 4,
          },
        ],
      },
    })

  test("the block reads the frozen cards and the facts; a skip (team R4, a limit, a budget) never changes it", () => {
    const ok = PresetGuidance.pool(workers, resolution(false))
    expect(ok).toEqual(PresetGuidance.pool(workers, resolution(true)))
    expect(ok?.defaults).toEqual({
      explore: "gpt-6-luna",
      "own-quick": "gpt-6-luna",
      "own-review": "claude-opus-5-5",
      "own-deep": "claude-opus-5-5",
    })
    expect(ok?.entries[1]).toEqual({
      key: "claude-opus-5-5",
      note: "reviews",
      side: { runs: "subscription", company: "anthropic", price: 4 },
    })
    const text = PresetGuidance.render({
      preset: { delegation: "model", caps: Preset.CAPS, ultraCaps: null },
      ultra: false,
      level: Preset.ULTRA_LEVEL,
      cards: {},
      ...(ok ? { pool: ok } : {}),
    })?.text
    expect(text).toContain("- claude-opus-5-5: Anthropic, on the user's subscription. Note from the user: 'reviews'")
  })

  test("no block for a preset that is no pool, or without a resolved main", () => {
    expect(PresetGuidance.pool({ mode: "same", roles: {} }, resolution(false))).toBeUndefined()
    expect(PresetGuidance.pool(workers, undefined)).toBeUndefined()
    expect(PresetGuidance.targeted(workers)).toBe(true)
    expect(PresetGuidance.targeted({ mode: "same", roles: {}, pool: [] })).toBe(false)
  })
})
