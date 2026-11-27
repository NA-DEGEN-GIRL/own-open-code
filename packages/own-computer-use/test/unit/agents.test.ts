// The agent-wide computer deny as a moving agent transform: registered in setup, registered again after each
// `plugin.updated` of this Location with the previous one dropped, one move at a time, and dropped on stop. The plugin
// context is a fake: `agent.transform` records registrations in the scope core would hand it, the event stream is a
// queue the test feeds, and the agents are plain records with core's editor semantics.
import { afterEach, describe, expect, test } from "bun:test"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Permission } from "@opencode/schema/permission"
import { Effect, Exit, Queue, Scope, Stream } from "effect"
import { Agents } from "../../src/agents.js"
import { Gate } from "../../src/gate.js"
import { until } from "./support.js"

const DIRECTORY = "D:\\work\\game"

interface Registration {
  readonly fold: (editor: AgentEditor) => void
  disposed: boolean
}

interface AgentRecord {
  readonly id: string
  readonly mode: "primary" | "subagent"
  readonly permissions: Array<Permission.Rule>
}

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))))
})

/** The fake plugin context; `slow` keeps each registration in flight for a few milliseconds. */
function plugin(input: { readonly slow?: boolean } = {}) {
  const registrations: Array<Registration> = []
  const events = Effect.runSync(Queue.unbounded<unknown>())
  const flight = { now: 0, max: 0 }
  const ctx = {
    location: { directory: DIRECTORY },
    agent: {
      transform: (fold: (editor: AgentEditor) => void) =>
        Effect.gen(function* () {
          flight.now += 1
          flight.max = Math.max(flight.max, flight.now)
          if (input.slow) yield* Effect.sleep("5 millis")
          const registration: Registration = { fold, disposed: false }
          registrations.push(registration)
          yield* Effect.addFinalizer(() => Effect.sync(() => void (registration.disposed = true)))
          flight.now -= 1
          return { dispose: Effect.sync(() => void (registration.disposed = true)) }
        }),
    },
    event: { subscribe: () => Stream.fromQueue(events) },
  } as unknown as Pick<Context, "agent" | "event" | "location">
  const start = async () => {
    const scope = await Effect.runPromise(Scope.make())
    scopes.push(scope)
    await Effect.runPromise(Agents.register(ctx).pipe(Scope.provide(scope)))
    return scope
  }
  return {
    registrations,
    flight,
    start,
    live: () => registrations.filter((registration) => !registration.disposed),
    /** Feeds one event; `null` sends it without a location. */
    emit: (type: string, directory: string | null = DIRECTORY) =>
      Effect.runSync(
        Queue.offer(events, {
          id: "evt_test",
          type,
          ...(directory === null ? {} : { location: { directory } }),
          data: {},
        }),
      ),
  }
}

/** Core's agents as a transform sees them: two built-ins and one the config defines. */
function agents(): Array<AgentRecord> {
  return [
    { id: "build", mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    { id: "explore", mode: "subagent", permissions: [{ action: "edit", resource: "*", effect: "deny" }] },
    { id: "helper", mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
  ]
}

function editor(records: Array<AgentRecord>) {
  const value = {
    list: () => records,
    get: (id: string) => records.find((record) => record.id === id),
    default: () => {},
    update: (id: string, update: (agent: AgentRecord) => void) => {
      const found = records.find((record) => record.id === id)
      if (found) update(found)
    },
    remove: () => {},
  }
  // SAFETY: the transform uses `list` and `update`; the records carry the fields it edits.
  return value as unknown as AgentEditor
}

describe("the agent-wide deny", () => {
  test("setup registers it once; a fold appends exactly {computer,*,deny} to every agent and nothing else", async () => {
    const fake = plugin()
    await fake.start()
    expect(fake.registrations).toHaveLength(1)
    const records = agents()
    fake.registrations[0]?.fold(editor(records))
    const before = agents()
    expect(records.map((record) => record.permissions)).toEqual(
      before.map((record) => [...record.permissions, Gate.DENY]),
    )
    expect(records.map((record) => [record.id, record.mode])).toEqual(before.map((record) => [record.id, record.mode]))
  })

  test("each plugin.updated of this Location registers it again (now last) and drops the previous one", async () => {
    const fake = plugin()
    await fake.start()
    fake.emit("plugin.updated")
    await until(() => fake.registrations[0]?.disposed === true)
    expect(fake.registrations).toHaveLength(2)
    expect(fake.live()).toEqual([fake.registrations[1]!])
    fake.emit("plugin.updated")
    await until(() => fake.registrations[1]?.disposed === true)
    expect(fake.live()).toEqual([fake.registrations[2]!])
    // The latest registration folds the config's agents the same way.
    const records = agents()
    fake.registrations[2]?.fold(editor(records))
    expect(records.find((record) => record.id === "helper")?.permissions.at(-1)).toEqual(Gate.DENY)
  })

  test("other Locations' plugin.updated and other events leave it where it is", async () => {
    const fake = plugin()
    await fake.start()
    fake.emit("plugin.updated", "D:\\work\\elsewhere")
    fake.emit("plugin.updated", null)
    fake.emit("session.deleted")
    fake.emit("agent.updated")
    // Events are handled in order: once this one moved it, the ones before it were seen and ignored.
    fake.emit("plugin.updated")
    await until(() => fake.registrations.length === 2)
    await Bun.sleep(20)
    expect(fake.registrations).toHaveLength(2)
    expect(fake.live()).toEqual([fake.registrations[1]!])
  })

  test("moves run one after another: the setup registration and an early plugin.updated never overlap", async () => {
    const fake = plugin({ slow: true })
    // Queued before the plugin subscribes: handled while the setup registration is still in flight.
    fake.emit("plugin.updated")
    fake.emit("plugin.updated")
    await fake.start()
    await until(() => fake.registrations.length === 3 && fake.live().length === 1)
    expect(fake.flight.max).toBe(1)
    expect(fake.live()).toEqual([fake.registrations[2]!])
  })

  test("stop drops the last registration, and nothing registers after it", async () => {
    const fake = plugin()
    const scope = await fake.start()
    fake.emit("plugin.updated")
    await until(() => fake.registrations.length === 2)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(fake.live()).toEqual([])
    fake.emit("plugin.updated")
    await Bun.sleep(20)
    expect(fake.registrations).toHaveLength(2)
  })
})
