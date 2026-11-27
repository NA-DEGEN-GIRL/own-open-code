// Fail-closed grace arithmetic (04 §8.7): a deadline from the first failure, spread over core's remaining retries,
// capped at 30 s per attempt; the turn stops within grace + the first attempt's broker wait.
import { describe, expect, test } from "bun:test"
import { Broker } from "@own/protocol"
import { Grace } from "../../src/remote/grace.js"

describe("Grace.decide", () => {
  test("spreads the remaining grace over the remaining attempts, 30 s at most", () => {
    const deadline = 300_000
    expect(Grace.decide({ now: 0, deadline, attempt: 2 })).toEqual({ retry: true, delay: 30_000 })
    expect(Grace.decide({ now: 280_000, deadline, attempt: 10 })).toEqual({ retry: true, delay: 10_000 })
    expect(Grace.decide({ now: 299_000, deadline, attempt: 11 })).toEqual({ retry: true, delay: 1_000 })
    expect(Grace.decide({ now: 300_000, deadline, attempt: 3 })).toEqual({ retry: false })
  })

  test("grace 0 stops at once", () => {
    expect(Grace.decide({ now: 5, deadline: 5, attempt: 2 })).toEqual({ retry: false })
  })

  test("the sum of the delays never passes the deadline (default 300 s grace, 10 retries)", () => {
    let now = 0
    const deadline = Broker.GRACE_SECONDS_DEFAULT * 1000
    let attempts = 0
    for (let attempt = 2; attempt <= Broker.CORE_RETRIES + 1; attempt++) {
      const decision = Grace.decide({ now, deadline, attempt })
      if (!decision.retry) break
      attempts++
      now += decision.delay
    }
    expect(now).toBeLessThanOrEqual(deadline)
    expect(attempts).toBeLessThanOrEqual(Broker.CORE_RETRIES)
    expect(Grace.bound(300, 10_000)).toBe(310_000)
  })
})
