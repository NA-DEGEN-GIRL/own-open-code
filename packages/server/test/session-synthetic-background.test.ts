// OWN-PATCH(P-035) begin
// `session.synthetic` takes a background job's `startedAt` and `background` (11 §7.2), which plugins reach as
// `ctx.session.synthetic`: a notice of work started before a context reset that applies is passive and names it.
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    config: { project: false },
    models: { fetch: false },
    fs: { filewatcher: false },
  })
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })
  return { api }
})

it.live("a background notice through the HttpApi follows a reset that applied since its job started", () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    yield* Effect.promise(async () => {
      const session = await fixture.api.session.create({ title: "Background notice" })
      // Idle: the reset applies at once.
      const reset = await fixture.api.session.reset.create({ sessionID: session.id })
      const old = await fixture.api.session.synthetic({ sessionID: session.id, text: "old job", startedAt: 0 })
      const unknown = await fixture.api.session.synthetic({
        sessionID: session.id,
        text: "recovered job",
        background: true,
        resume: false,
      })
      expect(old.payload).toMatchObject({ background: true, beforeReset: reset.id })
      expect(unknown.payload).toEqual({ text: "recovered job", background: true })
      const pending = await fixture.api.session.inbox.list({ sessionID: session.id })
      expect(pending.map((item) => (item.type === "synthetic" ? item.payload.beforeReset : item.type))).toEqual([
        reset.id,
        undefined,
      ])
    })
  }),
)
// OWN-PATCH(P-035) end
