import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Policy, Ratecard, Registry } from "../src/index.js"
import { CODEX_ACCOUNT, policyFile, ratecardsFile, roundTrip } from "./fixtures.js"

describe("policy.json", () => {
  const decode = Schema.decodeUnknownSync(Policy.File)

  test("decodes the 02 §2.4.3 example and encodes it back unchanged", () => {
    expect(roundTrip(Policy.File, policyFile)).toEqual(policyFile)
    expect<string | undefined>(decode(policyFile).defaults.byKind.codex).toBe(CODEX_ACCOUNT)
  })

  test("an older file's defaults.global is no policy field any more and survives a rewrite unread (07 §2.2)", () => {
    const old = {
      ...policyFile,
      defaults: { ...policyFile.defaults, global: { providerID: "own-codex-7k2m", id: "x" } },
    }
    expect(Object.keys(decode(old).defaults)).toEqual(["byKind"])
    expect(roundTrip(Policy.File, old, { keepUnknown: true })).toEqual(old)
    expect(Schema.decodeUnknownSync(Policy.Patch)({ defaults: { global: { providerID: "p", id: "x" } } })).toEqual({
      defaults: {},
    })
  })

  test("built-in defaults are a valid policy", () => {
    expect(roundTrip(Policy.File, Policy.defaults)).toEqual(Policy.defaults)
    expect(Policy.defaults.autoSwitch.subscriptionToApi).toBe("ask")
  })

  test("stored policy never auto-switches away from subscriptions", () => {
    const autoSwitch = policyFile.autoSwitch
    expect(() => decode({ ...policyFile, autoSwitch: { ...autoSwitch, subscriptionToApi: "auto" } })).toThrow()
    expect(() => decode({ ...policyFile, autoSwitch: { ...autoSwitch, subscriptionToSubscription: "auto" } })).toThrow()
    expect(() => decode({ ...policyFile, autoSwitch: { ...autoSwitch, toClaudeSlot: "ask" } })).toThrow()
  })

  test("patches accept forbidden modes so the handler can answer policy_denied", () => {
    const patch = Schema.decodeUnknownSync(Policy.Patch)({
      autoSwitch: { subscriptionToApi: "auto", toClaudeSlot: "ask" },
      thresholds: { confirm: { dialogAtTokens: 50000 } },
    })
    expect(patch.autoSwitch?.subscriptionToApi).toBe("auto")
    expect(patch.thresholds?.confirm?.dialogAtTokens).toBe(50000)
    expect(roundTrip(Policy.Patch, {})).toEqual({})
    expect(() => Schema.decodeUnknownSync(Policy.Patch)({ horizonRequests: 0 })).toThrow()
  })

  test("siwc has a default-account slot and a compaction kind setting", () => {
    const byKind = { codex: "acc_01JAX3ABCDEFGHJKMNPQRSTVWX", siwc: "acc_01JAXBABCDEFGHJKMNPQRSTVWX" }
    expect(roundTrip(Policy.ByKind, byKind)).toEqual(byKind)
    const patch = { compaction: { byKind: { siwc: { triggerPercent: 80 } } } }
    expect(roundTrip(Policy.Patch, patch)).toEqual(patch)
    const file = { ...policyFile, defaults: { ...policyFile.defaults, byKind } }
    expect(roundTrip(Policy.File, file)).toEqual(file)
  })

  test("hideBuiltinProviders is auto, false, or a provider list", () => {
    for (const value of ["auto", false, ["openai", "deepseek"]])
      expect(roundTrip(Policy.HideBuiltinProviders, value)).toEqual(value)
    expect(() => Schema.decodeUnknownSync(Policy.HideBuiltinProviders)(true)).toThrow()
  })
})

describe("ratecards.json", () => {
  test("decodes the 02 §2.4.4 example and encodes it back unchanged", () => {
    expect(roundTrip(Ratecard.File, ratecardsFile)).toEqual(ratecardsFile)
    const file = Schema.decodeUnknownSync(Ratecard.File)(ratecardsFile)
    expect(file.cards[2].ttl.oneHour?.coldUpperSec).toBe(3600)
    expect(file.cards[3].lookback).toEqual({ messageEnds: 20 })
  })

  test("rejects negative rates and unknown units", () => {
    const card = ratecardsFile.cards[0]
    expect(() => Schema.decodeUnknownSync(Ratecard.Card)({ ...card, in: -1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(Ratecard.Card)({ ...card, unit: "EUR" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Ratecard.Card)({ ...card, ttl: { warmLowerSec: 300 } })).toThrow()
  })
})
