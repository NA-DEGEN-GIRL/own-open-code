// OWN-PATCH(P-054) begin
// own: plugins read single messages by index (`ctx.session.messages`) instead of the whole context.
import { expect } from "bun:test"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.live("Effect plugins read a session's messages with Core's paging", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const context = yield* PluginHost.make(plugins, "test")
    const created = yield* context.session.create({ title: "Plugin messages" })
    yield* sessions.synthetic({ sessionID: created.id, text: "first", resume: false })
    yield* sessions.synthetic({ sessionID: created.id, text: "second", resume: false })
    const all = yield* sessions.messages({ sessionID: created.id })

    expect(yield* context.session.messages({ sessionID: created.id })).toEqual(all)
    expect(yield* context.session.messages({ sessionID: created.id, type: "user", limit: 1 })).toEqual(
      yield* sessions.messages({ sessionID: created.id, type: "user", limit: 1 }),
    )
    expect(
      yield* context.session.messages({ sessionID: Session.ID.create() }).pipe(Effect.flip),
    ).toMatchObject({ _tag: "Session.NotFoundError" })
  }),
)

it.live("Promise plugins read a session's messages", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const context = yield* PluginHost.make(plugins, "test")
    const created = yield* context.session.create({ title: "Promise plugin messages" })
    const all = yield* sessions.messages({ sessionID: created.id, order: "asc" })

    yield* PluginPromise.fromPromise({
      id: "test.session-messages",
      async setup(ctx) {
        expect(await ctx.session.messages({ sessionID: created.id, order: "asc" })).toEqual(all)
        const missing = SessionMessage.ID.create()
        expect(
          await ctx.session.messages({ sessionID: created.id, cursor: { id: missing, direction: "next" } }),
        ).toEqual([])
        await expect(ctx.session.messages({ sessionID: Session.ID.create() })).rejects.toThrow()
      },
    }).effect(context)
  }),
)
// OWN-PATCH(P-054) end
