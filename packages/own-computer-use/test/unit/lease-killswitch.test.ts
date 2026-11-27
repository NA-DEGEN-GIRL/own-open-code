import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { KillSwitch } from "../../src/core/killswitch.js"
import { Lease } from "../../src/core/lease.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

describe("lease", () => {
  test("reducer: the holder renews, others are busy until release or idle expiry", () => {
    const granted = Lease.acquire(Lease.initial, "ses_a", 1_000, 120_000)
    expect(granted).toEqual({ _tag: "Granted", state: { holder: "ses_a", lastActionAt: 1_000 } })
    if (granted._tag !== "Granted") throw new Error("unreachable")
    expect(Lease.acquire(granted.state, "ses_b", 61_000, 120_000)).toEqual({
      _tag: "Busy",
      holder: "ses_a",
      retryAfterMs: 60_000,
    })
    expect(Lease.acquire(granted.state, "ses_a", 61_000, 120_000)).toMatchObject({ _tag: "Granted" })
    expect(Lease.acquire(granted.state, "ses_b", 121_000, 120_000)).toEqual({
      _tag: "Granted",
      state: { holder: "ses_b", lastActionAt: 121_000 },
    })
    expect(Lease.release(granted.state, "ses_b")).toBe(granted.state)
    expect(Lease.release(granted.state, "ses_a")).toEqual(Lease.initial)
    expect(Lease.holder(granted.state, 50_000, 120_000)).toBe("ses_a")
    expect(Lease.holder(granted.state, 121_000, 120_000)).toBeUndefined()
  })

  test("service: idle expiry follows the clock", async () => {
    const result = await run(
      Effect.gen(function* () {
        const lease = yield* Lease.make(() => 120_000)
        const first = yield* lease.acquire("ses_a")
        yield* TestClock.adjust("60 seconds")
        const busy = yield* lease.acquire("ses_b")
        const renewed = yield* lease.acquire("ses_a")
        yield* TestClock.adjust("119 seconds")
        const stillBusy = yield* lease.acquire("ses_b")
        yield* TestClock.adjust("1 second")
        const holderBefore = yield* lease.holder
        const takeover = yield* lease.acquire("ses_b")
        const holderAfter = yield* lease.holder
        yield* lease.release("ses_a")
        const notReleased = yield* lease.holder
        yield* lease.release("ses_b")
        return {
          first,
          busy,
          renewed,
          stillBusy,
          holderBefore,
          takeover,
          holderAfter,
          notReleased,
          end: yield* lease.holder,
        }
      }),
    )
    expect(result.first._tag).toBe("Granted")
    expect(result.busy).toEqual({ _tag: "Busy", holder: "ses_a", retryAfterMs: 60_000 })
    expect(result.renewed._tag).toBe("Granted")
    expect(result.stillBusy).toEqual({ _tag: "Busy", holder: "ses_a", retryAfterMs: 1_000 })
    expect(result.holderBefore).toBeUndefined()
    expect(result.takeover._tag).toBe("Granted")
    expect(result.holderAfter).toBe("ses_b")
    expect(result.notReleased).toBe("ses_b")
    expect(result.end).toBeUndefined()
  })
})

describe("kill switch", () => {
  test("reducer keeps the first reason and time", () => {
    const engaged = KillSwitch.engage(KillSwitch.initial, "user_chord", 5)
    expect(engaged).toEqual({ engaged: true, reason: "user_chord", at: 5 })
    expect(KillSwitch.engage(engaged, "rpc", 9)).toBe(engaged)
  })

  test("service: check fails while engaged and passes after an explicit reset", async () => {
    const result = await run(
      Effect.gen(function* () {
        const killSwitch = yield* KillSwitch.make()
        const before = yield* Effect.exit(killSwitch.check)
        yield* TestClock.adjust("2 seconds")
        yield* killSwitch.engage("user_chord")
        yield* TestClock.adjust("1 second")
        yield* killSwitch.engage("rpc")
        const state = yield* killSwitch.state
        const stopped = yield* Effect.flip(killSwitch.check)
        yield* killSwitch.reset
        const after = yield* Effect.exit(killSwitch.check)
        return { before, state, stopped, after }
      }),
    )
    expect(result.before._tag).toBe("Success")
    expect(result.state).toEqual({ engaged: true, reason: "user_chord", at: 2_000 })
    expect(result.stopped.code).toBe("stopped")
    expect(result.stopped.message.startsWith("[computer.stopped]")).toBe(true)
    expect(result.after._tag).toBe("Success")
  })
})
