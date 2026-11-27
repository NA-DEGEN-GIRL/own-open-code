// What of a session's pending input reaches its running turn (src/reset-watch.ts, core P-035, 11 §7.2), so that only
// it ends a `clock.sleep` or a `wait_agent`: queued input does not until it is steered (as in Codex); input admitted
// behind a waiting reset does not until the reset is cancelled; a background notice crosses the reset; a passive notice
// reaches the turn only when the waiting reset it names is cancelled. A session older than this instance reads its
// inbox back (self-HTTP) at its first step here, again while the service gives no answer yet.
import { describe, expect, test } from "bun:test"
import { ServiceTarget } from "@own/runtime"
import { ResetWatch } from "../../src/reset-watch.js"

const user = (text: string, metadata?: Record<string, unknown>, delivery = "steer") => ({
  type: "user",
  delivery,
  payload: { text, ...(metadata === undefined ? {} : { metadata }) },
})
const notice = { type: "synthetic", delivery: "steer", payload: { text: "<shell>done</shell>", background: true } }
const passive = (resetID: string) => ({
  type: "synthetic",
  delivery: "steer",
  payload: { text: "old", background: true, beforeReset: resetID },
})

describe("ResetWatch.Watch", () => {
  test("pending lists the input that reached the running turn until it is delivered or cancelled", () => {
    const watch = new ResetWatch.Watch()
    expect(watch.pending("ses_1")).toEqual([])
    watch.enqueued("ses_1", "msg_steer", user("Steer", { source: "web" }))
    watch.enqueued("ses_1", "msg_queued", user("Later", undefined, "queue"))
    watch.enqueued("ses_1", "msg_notice", notice)
    expect(watch.pending("ses_1")).toEqual([{ source: "web" }, undefined])
    watch.settled("ses_1", "msg_steer", false)
    expect(watch.pending("ses_1")).toEqual([undefined])
    // Input behind a waiting reset is not the turn's.
    watch.enqueued("ses_1", "msg_reset", { type: "reset", delivery: "queue", payload: {} })
    watch.enqueued("ses_1", "msg_after", user("After"))
    watch.settled("ses_1", "msg_notice", true)
    expect(watch.pending("ses_1")).toEqual([])
    // Steering the queued input brings it in.
    watch.changed("ses_1", "msg_queued", "steer")
    expect(watch.pending("ses_1")).toEqual([undefined])
  })

  test("input behind a waiting reset is held; a background notice reaches the turn; a passive one does not", () => {
    const watch = new ResetWatch.Watch()
    expect(watch.enqueued("ses_1", "msg_before", user("Before", { source: "web" }))).toEqual({
      metadata: { source: "web" },
    })
    expect(watch.enqueued("ses_1", "msg_reset", { type: "reset", delivery: "queue", payload: {} })).toBeUndefined()
    expect(watch.enqueued("ses_1", "msg_after", user("After"))).toBeUndefined()
    expect(watch.enqueued("ses_1", "msg_compact", { type: "compaction", delivery: "steer" })).toBeUndefined()
    expect(watch.enqueued("ses_1", "msg_notice", notice)).toEqual({ metadata: undefined })
    expect(watch.enqueued("ses_1", "msg_passive", passive("msg_old_reset"))).toBeUndefined()
    // Another session has no reset waiting.
    expect(watch.enqueued("ses_2", "msg_other", user("Other"))).toEqual({ metadata: undefined })
    expect(watch.enqueued("ses_2", "msg_compact", { type: "compaction", delivery: "steer" })).toEqual({
      metadata: undefined,
    })
    expect(watch.enqueued("ses_2", "msg_passive", passive("msg_old_reset"))).toBeUndefined()
  })

  test("queued input reaches the turn only once it is steered, as in Codex", () => {
    const watch = new ResetWatch.Watch()
    expect(watch.enqueued("ses_1", "msg_queued", user("Queued", undefined, "queue"))).toBeUndefined()
    expect(
      watch.enqueued("ses_1", "msg_agent", user("Agent", { source: "own.harness.agent" }, "queue")),
    ).toBeUndefined()
    // The queue dock's `지금 보내기` (or its toggle back and forth).
    expect(watch.changed("ses_1", "msg_queued", "steer")).toEqual({ metadata: undefined })
    expect(watch.changed("ses_1", "msg_queued", "queue")).toBeUndefined()
    expect(watch.changed("ses_1", "msg_queued", "steer")).toEqual({ metadata: undefined })
    expect(watch.changed("ses_1", "msg_agent", "steer")).toEqual({ metadata: { source: "own.harness.agent" } })
    // Delivered, it is gone; an item this instance never saw admitted tells nothing.
    watch.settled("ses_1", "msg_queued", false)
    expect(watch.changed("ses_1", "msg_queued", "steer")).toBeUndefined()
    expect(watch.changed("ses_1", "msg_unknown", "steer")).toBeUndefined()
  })

  test("a cancelled reset lets the steered input and the notices it held in; queued input waits for a steer", () => {
    const watch = new ResetWatch.Watch()
    watch.enqueued("ses_1", "msg_reset", { type: "reset", delivery: "queue" })
    watch.enqueued("ses_1", "msg_a", user("A", { source: "own.harness.agent" }))
    watch.enqueued("ses_1", "msg_b", user("B"))
    watch.enqueued("ses_1", "msg_c", user("C"))
    // As own-web's composer sends while a reset waits.
    watch.enqueued("ses_1", "msg_q", user("Q", undefined, "queue"))
    // Named at admission while the reset waited with no execution, and one of an earlier reset.
    watch.enqueued("ses_1", "msg_passive", passive("msg_reset"))
    watch.enqueued("ses_1", "msg_older", passive("msg_old_reset"))
    // Steered while the reset still holds it: not yet.
    expect(watch.changed("ses_1", "msg_q", "steer")).toBeUndefined()
    expect(watch.changed("ses_1", "msg_q", "queue")).toBeUndefined()
    // The queue dock's `✕` on one of them.
    expect(watch.settled("ses_1", "msg_b", true)).toEqual([])
    expect(watch.settled("ses_1", "msg_reset", true)).toEqual([{ source: "own.harness.agent" }, undefined, undefined])
    // own-web steers what it queued only because of the reset: now it reaches the turn.
    expect(watch.changed("ses_1", "msg_q", "steer")).toEqual({ metadata: undefined })
    // No reset waits now: new input reaches the turn.
    expect(watch.enqueued("ses_1", "msg_d", user("D"))).toEqual({ metadata: undefined })

    watch.enqueued("ses_1", "msg_reset_2", { type: "reset", delivery: "queue" })
    watch.enqueued("ses_1", "msg_e", user("E"))
    watch.enqueued("ses_1", "msg_f", user("F", undefined, "queue"))
    // Delivered, the reset ended the turn: what it held starts the new context.
    expect(watch.settled("ses_1", "msg_reset_2", false)).toEqual([])
    expect(watch.settled("ses_1", "msg_e", false)).toEqual([])
    // Left parked (after a stop), steered in a later turn of the new context.
    expect(watch.changed("ses_1", "msg_f", "steer")).toEqual({ metadata: undefined })
  })

  test("a session older than the instance reads its waiting reset and the input behind it back once", async () => {
    const watch = new ResetWatch.Watch()
    const reads: Array<string> = []
    const inbox = [
      { id: "msg_before", type: "user", delivery: "steer", payload: { metadata: { source: "web" } } },
      { id: "msg_parked", type: "user", delivery: "queue", payload: {} },
      { id: "msg_reset", type: "reset", delivery: "queue", payload: {} },
      { id: "msg_held", type: "user", delivery: "steer", payload: {} },
      { id: "msg_queued", type: "user", delivery: "queue", payload: {} },
      { id: "msg_notice", type: "synthetic", delivery: "steer", payload: { background: true } },
    ]
    const read = (sessionID: string) => async () => {
      reads.push(sessionID)
      return inbox
    }
    await watch.readBack("ses_old", read("ses_old"))
    await watch.readBack("ses_old", read("ses_old"))
    expect(reads).toEqual(["ses_old"])
    expect(watch.enqueued("ses_old", "msg_new", user("New"))).toBeUndefined()
    // A prompt parked before the reset, steered: it was never behind the reset.
    expect(watch.changed("ses_old", "msg_parked", "steer")).toEqual({ metadata: undefined })
    expect(watch.settled("ses_old", "msg_reset", true)).toEqual([undefined, undefined])
    expect(watch.changed("ses_old", "msg_queued", "steer")).toEqual({ metadata: undefined })
    // A session created since the instance started is never read.
    watch.created("ses_new")
    await watch.readBack("ses_new", read("ses_new"))
    expect(reads).toEqual(["ses_old"])
  })

  test("an inbox event while the read runs drops its answer; the next step reads again", async () => {
    const watch = new ResetWatch.Watch()
    const answers: Array<(items: ReadonlyArray<ResetWatch.Listed>) => void> = []
    const read = () => new Promise<ReadonlyArray<ResetWatch.Listed>>((resolve) => void answers.push(resolve))
    const first = watch.readBack("ses_old", read)
    // The reset the read is about to answer is delivered before the answer arrives.
    watch.settled("ses_old", "msg_reset", false)
    answers[0]!([{ id: "msg_reset", type: "reset" }])
    await first
    expect(watch.enqueued("ses_old", "msg_after", user("After"))).toEqual({ metadata: undefined })
    const second = watch.readBack("ses_old", read)
    answers[1]!([
      { id: "msg_reset_2", type: "reset" },
      { id: "msg_after", type: "user" },
    ])
    await second
    expect(watch.enqueued("ses_old", "msg_later", user("Later"))).toBeUndefined()
  })

  test("without an answer yet the read is tried again after each pause, then given up; a refusal ends it", async () => {
    const watch = new ResetWatch.Watch()
    const answers: Array<ReadonlyArray<ResetWatch.Listed> | "retry"> = [
      "retry",
      "retry",
      [{ id: "msg_r", type: "reset" }],
    ]
    let asked = 0
    await watch.readBack(
      "ses_slow",
      async () => {
        asked++
        return answers.shift()!
      },
      [1, 1, 1],
    )
    expect(asked).toBe(3)
    expect(watch.enqueued("ses_slow", "msg_held", user("Held"))).toBeUndefined()

    let tries = 0
    const silent = async () => {
      tries++
      return "retry" as const
    }
    await watch.readBack("ses_down", silent, [1, 1])
    expect(tries).toBe(3)
    // Given up for this instance: the next step does not read again.
    await watch.readBack("ses_down", silent, [1, 1])
    expect(tries).toBe(3)

    let refused = 0
    const refusing = async () => void refused++
    await watch.readBack("ses_refused", refusing, [1, 1])
    await watch.readBack("ses_refused", refusing, [1, 1])
    expect(refused).toBe(1)

    // A session deleted while the read waits to try again is not read again.
    let deleted = 0
    const pending = watch.readBack(
      "ses_gone",
      async () => {
        deleted++
        return "retry" as const
      },
      [20],
    )
    watch.forget("ses_gone")
    await pending
    expect(deleted).toBe(1)
  })
})

describe("ResetWatch.reader", () => {
  test("reads the session's items in this Location; a 401 or 503 asks to try again, another refusal does not", async () => {
    const seen: Array<{ readonly path: string; readonly directory: string | null; readonly authorization: string }> = []
    const answers = [401, 200, 503, 404]
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        seen.push({
          path: url.pathname,
          directory: url.searchParams.get("location[directory]"),
          authorization: request.headers.get("authorization") ?? "",
        })
        const status = answers.shift() ?? 500
        if (status !== 200) return new Response("no", { status })
        return Response.json({
          data: [
            { id: "msg_reset", type: "reset", payload: {}, delivery: "queue" },
            {
              id: "msg_notice",
              type: "synthetic",
              delivery: "steer",
              payload: { text: "done", background: true, metadata: { source: "shell" } },
            },
          ],
        })
      },
    })
    let invalidated = 0
    const fixed = ServiceTarget.fixed({ url: `http://127.0.0.1:${server.port}`, password: "fake-password" })
    const source = { current: () => fixed.current(), invalidate: () => void invalidated++ }
    const read = ResetWatch.reader(() => source, "/work/repo")
    expect(await read("ses_one")).toBe("retry")
    expect(invalidated).toBe(1)
    expect(await read("ses_one")).toEqual([
      { id: "msg_reset", type: "reset", delivery: "queue", payload: {} },
      {
        id: "msg_notice",
        type: "synthetic",
        delivery: "steer",
        payload: { background: true, metadata: { source: "shell" } },
      },
    ])
    expect(await read("ses_one")).toBe("retry")
    expect(await read("ses_one")).toBeUndefined()
    expect(seen.map((request) => [request.path, request.directory])).toEqual(
      Array.from({ length: 4 }, () => ["/api/session/ses_one/inbox", "/work/repo"]),
    )
    expect(
      seen.every((request) => request.authorization !== "" && !request.authorization.includes("fake-password")),
    ).toBe(true)
    // No service at all (yet): try again later.
    expect(await ResetWatch.reader(() => ({ current: async () => undefined, invalidate: () => {} }), "/w")("s")).toBe(
      "retry",
    )
  })
})
