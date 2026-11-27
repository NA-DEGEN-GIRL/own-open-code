// The context/compaction prune hooks through a fake session hook registry and an in-memory plugin storage.
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Effect, type Schema } from "effect"
import { Budget } from "../../src/core/budget.js"
import { Hooks } from "../../src/hooks.js"

type Message = SessionContext["messages"][number]
type Hook = (input: Pick<SessionContext, "sessionID" | "messages">) => Effect.Effect<void>

function plugin(storage = new Map<string, Schema.Json>()) {
  const hooks = new Map<string, Hook>()
  const reads: Array<string> = []
  const ctx = {
    session: {
      hook: (name: string, callback: Hook) =>
        Effect.sync(() => {
          hooks.set(name, callback)
          return { dispose: Effect.void }
        }),
    },
    storage: {
      get: (key: string) =>
        Effect.sync(() => {
          reads.push(key)
          return storage.get(key)
        }),
      set: (key: string, value: Schema.Json) => Effect.sync(() => void storage.set(key, value)),
      remove: (key: string) => Effect.sync(() => void storage.delete(key)),
    },
  } as unknown as Pick<Context, "session" | "storage">
  return { ctx, hooks, storage, reads }
}

const conversation = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: `call_${index}`,
            name: "execute",
            result: {
              type: "content",
              value: [
                { type: "text", text: `cap_${index}` },
                {
                  type: "file",
                  uri: "data:image/png;base64,QUJD",
                  mime: "image/png",
                  name: `${Budget.IMAGE_PREFIX}cap_${index}.png`,
                },
              ],
            },
          },
        ],
      }) as unknown as Message,
  )

const run = (hook: Hook | undefined, sessionID: string, messages: Array<Message>) =>
  Effect.runPromise(hook!({ sessionID: sessionID as SessionContext["sessionID"], messages }))

describe("prune hooks", () => {
  test("the context hook prunes in batches and stores the session's (keep, batch) on first use", async () => {
    const env = plugin()
    const hooks = await Effect.runPromise(Effect.scoped(Hooks.register(env.ctx, { keep: 2, batch: 2 })))
    expect([...env.hooks.keys()]).toEqual(["context", "compaction"])
    // No screenshots: no storage access at all.
    await run(env.hooks.get("context"), "ses_a", [])
    expect(env.reads).toEqual([])
    const messages = conversation(4)
    await run(env.hooks.get("context"), "ses_a", messages)
    expect(Budget.count(messages)).toBe(2)
    expect(env.storage.get(Hooks.key("ses_a"))).toEqual({ keep: 2, batch: 2 })
    const compacted = conversation(5)
    await run(env.hooks.get("compaction"), "ses_a", compacted)
    expect(Budget.count(compacted)).toBe(3)
    await Effect.runPromise(hooks.forget("ses_a"))
    expect(env.storage.has(Hooks.key("ses_a"))).toBe(false)
  })

  test("stored parameters win over later options, so an existing session keeps its prefix", async () => {
    const storage = new Map<string, Schema.Json>([[Hooks.key("ses_b"), { keep: 8, batch: 7 }]])
    const env = plugin(storage)
    await Effect.runPromise(Effect.scoped(Hooks.register(env.ctx, { keep: 1, batch: 1 })))
    const messages = conversation(14)
    await run(env.hooks.get("context"), "ses_b", messages)
    expect(Budget.count(messages)).toBe(14)
    const fresh = conversation(3)
    await run(env.hooks.get("context"), "ses_c", fresh)
    expect(Budget.count(fresh)).toBe(1)
    expect(storage.get(Hooks.key("ses_c"))).toEqual({ keep: 1, batch: 1 })
  })
})
