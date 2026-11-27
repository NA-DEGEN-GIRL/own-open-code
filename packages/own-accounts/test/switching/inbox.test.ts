// The switching module's self-HTTP read of a session's pending inbox (06 §2.6): the session in this Location, the
// service password only in `Authorization`, one retry after a 401, `undefined` when the service does not answer.
import { describe, expect, test } from "bun:test"
import { ServiceTarget } from "@own/runtime"
import { SwitchInbox } from "../../src/switching/inbox.js"

describe("SwitchInbox.reader", () => {
  test("reads the items of the session in this Location, again once after a 401", async () => {
    const seen: Array<{ readonly path: string; readonly directory: string | null; readonly authorization: string }> = []
    const answers = [401, 200]
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
        return Response.json({ data: [{ id: "msg_reset", type: "reset", payload: {}, delivery: "queue" }] })
      },
    })
    const source = ServiceTarget.fixed({ url: `http://127.0.0.1:${server.port}`, password: "fake-password" })
    const read = SwitchInbox.reader(() => source, "/work/repo")
    expect(await read("ses_one")).toEqual([{ id: "msg_reset", type: "reset" }])
    expect(seen.map((request) => [request.path, request.directory])).toEqual([
      ["/api/session/ses_one/inbox", "/work/repo"],
      ["/api/session/ses_one/inbox", "/work/repo"],
    ])
    expect(
      seen.every((request) => request.authorization !== "" && !request.authorization.includes("fake-password")),
    ).toBe(true)
    // Another failure answers nothing, as does no service at all.
    expect(await read("ses_one")).toBeUndefined()
    expect(await SwitchInbox.reader(() => ({ current: async () => undefined, invalidate: () => {} }), "/w")("s")).toBe(
      undefined,
    )
  })
})
