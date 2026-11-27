import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OutputLimit, Policy } from "../src/index.js"
import { policyFile, roundTrip } from "./fixtures.js"

describe("policy.outputLimit (02 §4.9)", () => {
  test("the default is core's own: cap at 256,000", () => {
    expect(OutputLimit.DEFAULT).toEqual({ mode: "cap", maxTokens: 256_000 })
    expect(OutputLimit.resolve(undefined)).toEqual(OutputLimit.DEFAULT)
    expect(OutputLimit.resolve({ mode: "omit", maxTokens: 9_000 })).toEqual({ mode: "omit", maxTokens: 9_000 })
  })

  test("a stored setting round-trips; a file without one stays without one", () => {
    const file = { ...policyFile, outputLimit: { mode: "omit", maxTokens: 120_000 } }
    expect(roundTrip(Policy.File, file)).toEqual(file)
    expect(roundTrip(Policy.File, policyFile)).not.toHaveProperty("outputLimit")
    expect(() =>
      Schema.decodeUnknownSync(Policy.File)({ ...policyFile, outputLimit: { mode: "cap", maxTokens: 0 } }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Policy.File)({ ...policyFile, outputLimit: { mode: "all", maxTokens: 1 } }),
    ).toThrow()
  })

  test("a patch takes any integer or null, so the handler can answer setting_out_of_range", () => {
    const decode = Schema.decodeUnknownSync(Policy.Patch)
    expect(decode({ outputLimit: { mode: "cap", maxTokens: 12 } })).toEqual({
      outputLimit: { mode: "cap", maxTokens: 12 },
    })
    expect(decode({ outputLimit: null })).toEqual({ outputLimit: null })
    expect(() => decode({ outputLimit: { mode: "cap", maxTokens: 1.5 } })).toThrow()
  })

  test("check bounds the number to 4,096..1,000,000", () => {
    const problem = { field: "outputLimit.maxTokens", min: 4_096, max: 1_000_000 }
    expect(OutputLimit.check({ mode: "cap", maxTokens: 4_095 })).toEqual(problem)
    expect(OutputLimit.check({ mode: "omit", maxTokens: 1_000_001 })).toEqual(problem)
    expect(OutputLimit.check({ mode: "cap", maxTokens: 4_096 })).toBeUndefined()
    expect(OutputLimit.check({ mode: "cap", maxTokens: 1_000_000 })).toBeUndefined()
  })
})
