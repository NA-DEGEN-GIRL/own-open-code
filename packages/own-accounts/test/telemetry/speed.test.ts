// 02 §4.8 in the ledger: a step sent at a speed tier records the tier sent and served, and is billed at the tier's
// price (plan credits times the tier's multiple, an API kind's or the Claude slot's mode price); a silent downgrade is
// billed at Standard. The speed module is a fake peer here (its own tests cover what it answers); prices are made up.

import { describe, expect, test } from "bun:test"
import { Home } from "@own/runtime"
import type { Ledger } from "@own/protocol"
import { Modules } from "../../src/modules.js"
import { ANTH, CODEX, SESSION, ok, setup, step } from "./support.js"

const CODEX_CARD = {
  match: { kind: "codex", model: "gpt-5.5" },
  unit: "credits",
  in: 125,
  read: 12.5,
  write: null,
  out: 750,
  ttl: { warmLowerSec: 300, coldUpperSec: null },
} as const

/** What the fake speed peer answers per provider: the step's tiers, the plan multiple and the mode price. */
function speedPeer(answers: {
  readonly step: Readonly<Record<string, Ledger.Line["speed"]>>
  readonly credits?: number
  readonly price?: { readonly input: number; readonly output: number }
}) {
  return (deps: Parameters<Modules.Factories["speed"]>[0], peers: Parameters<Modules.Factories["speed"]>[1]) => ({
    ...Modules.FACTORIES.speed(deps, peers),
    step: (input: { readonly providerID: string }) => answers.step[input.providerID],
    credits: async () => answers.credits,
    price: async () => answers.price,
  })
}

async function lineOf(
  t: Awaited<ReturnType<typeof setup>>,
  providerID: string,
  modelID: string,
  usage: { readonly input: number; readonly read?: number; readonly output?: number },
  cost = 0,
) {
  const directory = t.deps.location.directory
  for (const item of step({
    providerID,
    modelID,
    messageID: `msg_${providerID}`,
    at: t.clock.now(),
    directory,
    usage,
    cost,
  }))
    await t.telemetry.onEvent?.(item, { local: true })
  await t.telemetry.flush()
  await t.deps.runtime.ledger.flush()
  const lines = await t.deps.runtime.ledger.usageOf(Home.month(t.clock.now()))
  return lines.find((entry) => entry.line.providerID === providerID)?.line
}

describe("ledger: speed tiers (02 §4.8)", () => {
  test("a codex Fast step records its tiers and costs the rate-card credits times the tier's multiple", async () => {
    await using t = await setup({
      peers: { speed: speedPeer({ step: { [CODEX]: { requested: "priority", served: "priority" } }, credits: 2 }) },
    })
    await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    const line = await lineOf(t, CODEX, "gpt-5.5", { input: 2_000, read: 8_000, output: 100 })
    expect(line?.speed).toEqual({ requested: "priority", served: "priority" })
    // Standard: 2,000 × 125 + 8,000 × 12.5 + 100 × 750 per 1M = 0.425 credits; Fast bills twice that.
    expect(line?.cost).toEqual({ unit: "credits", amount: 0.85, source: "ratecard" })
  })

  test("a downgraded step is billed at Standard and keeps both tiers for the record", async () => {
    await using t = await setup({
      peers: { speed: speedPeer({ step: { [CODEX]: { requested: "priority", served: "default" } }, credits: 2 }) },
    })
    await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    const line = await lineOf(t, CODEX, "gpt-5.5", { input: 2_000, read: 8_000, output: 100 })
    expect(line?.speed).toEqual({ requested: "priority", served: "default" })
    expect(line?.cost).toEqual({ unit: "credits", amount: 0.425, source: "ratecard" })
  })

  test("an API Fast step is priced at the mode price instead of the base model's catalog USD", async () => {
    await using t = await setup({
      peers: {
        speed: speedPeer({ step: { [ANTH]: { requested: "fast", served: null } }, price: { input: 8, output: 40 } }),
      },
    })
    const line = await lineOf(t, ANTH, "claude-opus-5-5", { input: 1_000_000, output: 100_000 }, 6)
    expect(line?.speed).toEqual({ requested: "fast", served: null })
    expect(line?.cost).toEqual({ unit: "USD", amount: 12, source: "ratecard" })
    expect(line?.costUSDOpenCode).toBe(6)
  })

  test("the Claude subscription slot's Fast step costs usage credits, though claude-auth registers every cost as 0", async () => {
    await using t = await setup({
      claudeSlot: true,
      peers: {
        speed: speedPeer({
          step: { anthropic: { requested: "fast", served: "fast" } },
          price: { input: 8, output: 40 },
        }),
      },
    })
    const line = await lineOf(t, "anthropic", "claude-opus-5-5", { input: 500_000, output: 50_000 }, 0)
    expect(line?.speed).toEqual({ requested: "fast", served: "fast" })
    expect(line?.cost).toEqual({ unit: "USD", amount: 6, source: "ratecard" })
    expect(String(line?.sessionID)).toBe(SESSION)
  })

  test("a Standard step has no speed field and costs as before", async () => {
    await using t = await setup({ peers: { speed: speedPeer({ step: {} }) } })
    await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    const line = await lineOf(t, CODEX, "gpt-5.5", { input: 2_000, read: 8_000, output: 100 })
    expect(line).not.toHaveProperty("speed")
    expect(line?.cost).toEqual({ unit: "credits", amount: 0.425, source: "ratecard" })
  })
})
