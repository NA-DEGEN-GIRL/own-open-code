// Ops (06 §3.6, §8.5): observe → act → verify through registered step kinds, one active op per team (`busy`),
// resuming a running op after a simulated crash by observing again (TI-11), confirm steps with a 10-minute nonce that
// is renewed when it expires and bound to the confirmed list, `두기`, failures in `diagnostics.lastErrors`.

import { afterAll, describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { OwnID, OwnTeam } from "@own/protocol"
import { Confirm } from "../src/ops/confirm.js"
import { Keys } from "../src/registry/keys.js"
import { TeamRpc } from "../src/rpc/handlers.js"
import type { Services } from "../src/services.js"
import type { Steps } from "../src/ops/steps.js"
import { manual } from "./support/clock.js"
import { TEAM_ID, World, controller, team, tempHome } from "./support/context.js"

const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
afterAll(async () => {
  for (const home of homes) await home[Symbol.asyncDispose]()
})

const decodeKey = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }))

/**
 * A step kind that marks `args.key` in a set: observing an existing mark is the resume path (no second act).
 * `reverses`: `op.undo` could reverse a done one (`Steps.Kind.reverses`).
 */
function marks(services: Services.Context, name = "mark", options: { readonly reverses?: true } = {}) {
  const state = { marked: new Set<string>(), acts: [] as string[], confirmed: [] as string[] }
  const key = (input: Steps.Input) => Option.getOrThrow(decodeKey(input.step.args)).key
  services.steps.register({
    ...options,
    kind: name,
    observe: async (input) => (state.marked.has(key(input)) ? { state: "satisfied" } : { state: "pending" }),
    act: async (input) => {
      state.acts.push(key(input))
      if (input.confirmed) state.confirmed.push(key(input))
      state.marked.add(key(input))
      input.summary({ kind: "notes", text: `marked ${key(input)}` })
      return { ok: true }
    },
    verify: async (input) => (state.marked.has(key(input)) ? { ok: true } : { ok: false, note: "not marked" }),
  })
  return state
}

async function setup() {
  const home = await tempHome()
  homes.push(home)
  const world = new World()
  const clock = manual()
  const harness = controller(world, { directory: home.root, clock })
  await harness.services.write(TEAM_ID, () => harness.services.registry.teams.put(team({ home: home.root })))
  return { home: home.root, world, clock, ...harness }
}

/** RPC handlers of `services`, called with an error factory that returns the error object. */
function rpc(services: Services.Context) {
  const handlers = TeamRpc.create({ services, leader: () => true, log: services.log })
  // SAFETY (test): every handler takes its method's input and `{signal, error}`.
  const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
  return (method: string, input: unknown) =>
    loose[method]!(input, {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    })
}

async function settle(services: Services.Context, opID: string) {
  await services.runner.settled(opID)
  const op = await services.journal.find(opID)
  if (!op) throw new Error(`op ${opID} is gone`)
  return op
}

describe("runner", () => {
  test("runs auto steps in order through observe, act and verify, and announces progress and the end", async () => {
    const h = await setup()
    const state = marks(h.services, "mark", { reverses: true })
    const started = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "reorg",
      by: "user",
      steps: [
        { kind: "mark", args: { key: "a" } },
        { kind: "mark", args: { key: "b" } },
      ],
      undo: { available: true },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const op = await settle(h.services, started.op.id)
    expect(op.state).toBe("done")
    expect(op.steps.map((step) => [step.id, step.state])).toEqual([
      ["s1", "done"],
      ["s2", "done"],
    ])
    expect(op.summary?.lines).toEqual([
      { kind: "notes", text: "marked a" },
      { kind: "notes", text: "marked b" },
    ])
    expect(state.acts).toEqual(["a", "b"])
    expect(h.published.filter((event) => event.name === "op.progress")).toHaveLength(2)
    expect(h.published.find((event) => event.name === "op.done")).toMatchObject({
      data: { opID: op.id, state: "done", undoable: true, pending: 0 },
    })
    expect(h.world.kv.has(Keys.op(TEAM_ID, op.id))).toBe(true)
    await h.close()
  })

  test("a team has one active op: another start is busy while one waits", async () => {
    const h = await setup()
    marks(h.services)
    h.services.steps.register({
      kind: "remove",
      observe: async () => ({ state: "pending" }),
      act: async () => ({ ok: true }),
      verify: async () => ({ ok: true }),
      prepare: async () => ({ text: "지울까요?" }),
    })
    const first = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "retire",
      by: "user",
      steps: [{ kind: "remove", mode: "confirm" }],
    })
    if (!first.ok) throw new Error("not started")
    expect((await settle(h.services, first.op.id)).state).toBe("waiting")
    const second = await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by: "main", steps: [] })
    expect(second).toMatchObject({ ok: false, error: "busy", op: { id: first.op.id } })
    await h.close()
  })

  test("a running op is resumed after a crash: done effects are observed, not repeated", async () => {
    const h = await setup()
    const opID = OwnTeam.OpID.create()
    // What a controller that died during step 2 leaves: step 1 done, step 2's effect already there, step 3 not.
    const crashed: OwnTeam.Op = {
      id: opID,
      teamID: TEAM_ID,
      kind: "reorg",
      by: "auto",
      state: "running",
      createdAt: h.clock.now(),
      steps: [
        { id: "s1", kind: "mark", args: { key: "a" }, mode: "auto", state: "done" },
        { id: "s2", kind: "mark", args: { key: "b" }, mode: "auto", state: "pending" },
        { id: "s3", kind: "mark", args: { key: "c" }, mode: "auto", state: "pending" },
      ],
    }
    h.world.kv.set(Keys.op(TEAM_ID, opID), Keys.toJson(Schema.encodeSync(OwnTeam.Op)(crashed)))
    await h.close()

    // A new controller (a restart) on the same KV.
    const restarted = controller(h.world, { directory: h.home, clock: h.clock })
    const state = marks(restarted.services)
    state.marked.add("a")
    state.marked.add("b")
    await restarted.controller.resume()
    const op = await settle(restarted.services, opID)
    expect(op.state).toBe("done")
    expect(state.acts).toEqual(["c"])
    await restarted.close()
  })

  test("closing the controller mid-step leaves the op running; the next controller acts again", async () => {
    const h = await setup()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const done = { value: false }
    const block = (services: Services.Context, wait: boolean) =>
      services.steps.register({
        kind: "block",
        observe: async () => (done.value ? { state: "satisfied" } : { state: "pending" }),
        act: async () => {
          if (wait) {
            entered.resolve()
            await gate.promise
            return { ok: true }
          }
          done.value = true
          return { ok: true }
        },
        verify: async () => ({ ok: true }),
      })
    block(h.services, true)
    const started = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "reorg",
      by: "user",
      steps: [{ kind: "block" }],
    })
    if (!started.ok) throw new Error("not started")
    await entered.promise
    await h.close()
    gate.resolve()
    await h.services.runner.settled(started.op.id)
    const stored = Schema.decodeUnknownSync(OwnTeam.Op)(h.world.kv.get(Keys.op(TEAM_ID, started.op.id)))
    expect(stored.state).toBe("running")
    expect(stored.steps[0]?.state).toBe("pending")

    const restarted = controller(h.world, { directory: h.home, clock: h.clock })
    block(restarted.services, false)
    await restarted.controller.resume()
    expect((await settle(restarted.services, started.op.id)).state).toBe("done")
    expect(done.value).toBe(true)
    await restarted.close()
  })

  test("an unknown step kind fails the op and is listed in diagnostics", async () => {
    const h = await setup()
    const started = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "reorg",
      by: "user",
      steps: [{ kind: "nothing-registers-this" }, { kind: "mark", args: { key: "x" } }],
    })
    if (!started.ok) throw new Error("not started")
    const op = await settle(h.services, started.op.id)
    expect(op.state).toBe("failed")
    expect(op.steps.map((step) => step.state)).toEqual(["failed", "pending"])
    expect(h.services.errors(TEAM_ID)).toMatchObject([{ opID: op.id, stepID: "s1" }])
    // A failed op is not active: the team can start the next one.
    expect((await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by: "user", steps: [] })).ok).toBe(true)
    await h.close()
  })

  test("a failed step's note without Korean gets a Korean lead (03 §14.1); a Korean one stays as it is", async () => {
    const h = await setup()
    h.services.steps.register({
      kind: "throws",
      observe: async () => ({ state: "pending" }),
      act: async () => {
        throw new TypeError("x is undefined")
      },
      verify: async () => ({ ok: true }),
    })
    h.services.steps.register({
      kind: "refuses",
      observe: async () => ({ state: "failed", note: "폴더가 없어요" }),
      act: async () => ({ ok: true }),
      verify: async () => ({ ok: true }),
    })
    const notes = async (kind: string) => {
      const started = await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by: "user", steps: [{ kind }] })
      if (!started.ok) throw new Error("not started")
      return (await settle(h.services, started.op.id)).steps.map((step) => step.note)
    }
    expect(await notes("throws")).toEqual(["예상하지 못한 문제로 이 단계를 마치지 못했어요: x is undefined"])
    expect(await notes("refuses")).toEqual(["폴더가 없어요"])
    await h.close()
  })
})

describe("confirm steps", () => {
  async function confirmSetup() {
    const h = await setup()
    const state = marks(h.services)
    const list = { manifest: "m1", prepared: 0 }
    h.services.steps.register({
      kind: "remove",
      observe: async () => ({ state: "pending" }),
      act: async (input) => {
        state.confirmed.push(input.confirmed ? "remove:confirmed" : "remove")
        return { ok: true }
      },
      verify: async () => ({ ok: true }),
      prepare: async () => {
        list.prepared++
        return {
          text: "'cl-perf' 폴더를 지울까요?",
          bytes: 2_500,
          files: [{ path: "node_modules", bytes: 2_500 }],
          manifest: list.manifest,
        }
      },
    })
    const started = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "retire",
      by: "user",
      steps: [
        { kind: "remove", mode: "confirm" },
        { kind: "mark", args: { key: "after" } },
      ],
    })
    if (!started.ok) throw new Error("not started")
    const op = await settle(h.services, started.op.id)
    return { ...h, state, list, op }
  }

  test("a confirm step waits with a nonce while the later auto steps run", async () => {
    const h = await confirmSetup()
    expect(h.op.state).toBe("waiting")
    expect(h.op.steps.map((step) => step.state)).toEqual(["needs_confirm", "done"])
    const confirm = h.op.steps[0]!.confirm!
    expect(confirm).toMatchObject({ text: "'cl-perf' 폴더를 지울까요?", manifest: "m1", bytes: 2_500 })
    expect(confirm.expiresAt).toBe(h.clock.now() + Confirm.TTL_MS)
    expect(Confirm.pending(h.op)).toEqual([
      { teamID: TEAM_ID, opID: h.op.id, stepID: "s1", kind: "remove", ...confirm },
    ])
    expect(h.published.find((event) => event.name === "op.confirm")).toMatchObject({
      data: { opID: h.op.id, stepID: "s1", nonce: confirm.nonce },
    })
    expect(h.published.find((event) => event.name === "op.done")).toMatchObject({
      data: { state: "waiting", pending: 1 },
    })
    expect(
      await h.services.runner.confirm({ opID: h.op.id, stepID: "s1", choice: "do", nonce: "wrong-nonce-0000000000" }),
    ).toMatchObject({ ok: false, error: "nonce_invalid" })
    // Every event the runner published passes its event schema with the leader's envelope (no invalid emits).
    const events = TeamRpc.definition().events as unknown as Record<
      string,
      { readonly schema: { readonly "~standard": { validate(value: unknown): { readonly issues?: unknown } } } }
    >
    for (const event of h.published) {
      const payload = { eventId: OwnID.EventID.create(), origin: "global", ...event.data }
      expect(events[event.name]!.schema["~standard"].validate(payload).issues).toBeUndefined()
    }
    await h.close()
  })

  test("an expired nonce is refused and shown again with a new one; a changed list is asked again", async () => {
    const h = await confirmSetup()
    const first = h.op.steps[0]!.confirm!
    h.clock.advance(Confirm.TTL_MS)
    expect(
      await h.services.runner.confirm({ opID: h.op.id, stepID: "s1", choice: "do", nonce: first.nonce }),
    ).toMatchObject({ ok: false, error: "nonce_invalid" })
    const renewed = (await h.services.journal.find(h.op.id))!.steps[0]!.confirm!
    expect(renewed.nonce).not.toBe(first.nonce)
    expect(renewed.expiresAt).toBe(h.clock.now() + Confirm.TTL_MS)
    expect(h.published.filter((event) => event.name === "op.confirm")).toHaveLength(2)

    // 06 §8.6: the list changed between the dialog and the step; the confirm is bound to the old list.
    h.list.manifest = "m2"
    expect(
      await h.services.runner.confirm({ opID: h.op.id, stepID: "s1", choice: "do", nonce: renewed.nonce }),
    ).toMatchObject({ ok: false, error: "nonce_invalid" })
    const relisted = (await h.services.journal.find(h.op.id))!.steps[0]!.confirm!
    expect(relisted.manifest).toBe("m2")
    expect(h.state.confirmed).toEqual([])

    const confirmed = await h.services.runner.confirm({
      opID: h.op.id,
      stepID: "s1",
      choice: "do",
      nonce: relisted.nonce,
    })
    expect(confirmed).toMatchObject({ ok: true, op: { state: "done" } })
    expect(h.state.confirmed).toEqual(["remove:confirmed"])
    expect(h.published.filter((event) => event.name === "op.done").at(-1)).toMatchObject({
      data: { state: "done", pending: 0 },
    })
    // The nonce was used: a second answer is refused.
    expect(
      await h.services.runner.confirm({ opID: h.op.id, stepID: "s1", choice: "do", nonce: relisted.nonce }),
    ).toMatchObject({ ok: false, error: "nonce_invalid" })
    await h.close()
  })

  test("두기 skips the step and ends the op", async () => {
    const h = await confirmSetup()
    const nonce = h.op.steps[0]!.confirm!.nonce
    const skipped = await h.services.runner.confirm({ opID: h.op.id, stepID: "s1", choice: "skip", nonce })
    expect(skipped).toMatchObject({ ok: true, op: { state: "done" } })
    if (skipped.ok) expect(skipped.op.steps[0]).toMatchObject({ state: "skipped" })
    expect(h.state.confirmed).toEqual([])
    expect(
      await h.services.runner.confirm({ opID: OwnTeam.OpID.create(), stepID: "s1", choice: "skip", nonce }),
    ).toMatchObject({ ok: false, error: "not_found" })
    await h.close()
  })

  test("op.get and op.confirm over RPC, and team_off once the team is off", async () => {
    const h = await confirmSetup()
    const call = rpc(h.services)
    expect(await call("op.get", { opID: h.op.id })).toMatchObject({ op: { id: h.op.id, state: "waiting" } })
    const nonce = h.op.steps[0]!.confirm!.nonce
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home, state: "off" })))
    expect(await call("op.confirm", { opID: h.op.id, stepID: "s1", choice: "do", nonce })).toMatchObject({
      type: "team_off",
    })
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home })))
    expect(await call("op.confirm", { opID: h.op.id, stepID: "s1", choice: "do", nonce })).toMatchObject({
      op: { state: "done" },
    })
    expect(await call("op.confirm", { opID: h.op.id, stepID: "s1", choice: "do", nonce })).toMatchObject({
      type: "nonce_invalid",
    })
    await h.close()
  })
})

describe("answers that hold back, fail in a bundle, or come while the controller closes", () => {
  /** `remove` confirms that fail when `args.key` is in `failing`; `ask` a confirm that holds the later steps back. */
  async function bundle(steps: ReadonlyArray<Steps.Spec>, failing: ReadonlySet<string> = new Set()) {
    const h = await setup()
    const state = marks(h.services, "mark", { reverses: true })
    const confirmKind = (kind: string, extra: Partial<Steps.Kind> = {}): Steps.Kind => ({
      kind,
      observe: async () => ({ state: "pending" }),
      act: async (input) => {
        const key = Option.getOrThrow(decodeKey(input.step.args)).key
        if (failing.has(key)) return { ok: false, note: `${key}: 다른 프로그램이 폴더를 쓰고 있습니다` }
        state.confirmed.push(key)
        return { ok: true }
      },
      verify: async () => ({ ok: true }),
      prepare: async (input) => ({ text: `${Option.getOrThrow(decodeKey(input.step.args)).key}?` }),
      ...extra,
    })
    h.services.steps.register(confirmKind("remove"))
    h.services.steps.register(confirmKind("ask", { holds: true }))
    const started = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "reorg",
      by: "user",
      steps,
      undo: { available: true },
    })
    if (!started.ok) throw new Error("not started")
    const op = await settle(h.services, started.op.id)
    const answer = async (stepID: string, choice: "do" | "skip") => {
      const current = (await h.services.journal.find(op.id))!
      const nonce = current.steps.find((step) => step.id === stepID)!.confirm!.nonce
      const result = await h.services.runner.confirm({ opID: op.id, stepID, choice, nonce })
      await h.services.runner.settled(op.id)
      return result
    }
    return { ...h, state, op, answer }
  }

  test("06 §8.6: a failing removal of a bundle leaves the others answerable; the op fails once all are answered", async () => {
    const h = await bundle(
      [
        { kind: "remove", mode: "confirm", args: { key: "a" } },
        { kind: "remove", mode: "confirm", args: { key: "b" } },
      ],
      new Set(["a"]),
    )
    expect(h.op.state).toBe("waiting")
    expect(await h.answer("s1", "do")).toMatchObject({ ok: true, op: { state: "waiting" } })
    // The second removal is still asked with its own nonce and runs.
    const second = await h.answer("s2", "do")
    expect(second).toMatchObject({ ok: true, op: { state: "failed" } })
    if (second.ok) expect(second.op.steps.map((step) => step.state)).toEqual(["failed", "done"])
    expect(h.state.confirmed).toEqual(["b"])
    await h.close()
  })

  test("a holding confirm keeps the steps after it until do; 두기 skips the pending steps of its area", async () => {
    const run = (areaID: string) => [
      { kind: "ask", mode: "confirm" as const, args: { key: "ask", areaID } },
      { kind: "mark", args: { key: `after-${areaID}`, areaID } },
    ]
    const held = await bundle(run("ar_a"))
    expect(held.op.state).toBe("waiting")
    expect(held.op.steps.map((step) => step.state)).toEqual(["needs_confirm", "pending"])
    expect(held.state.acts).toEqual([])
    expect((await held.answer("s1", "do")).ok).toBe(true)
    const done = (await held.services.journal.find(held.op.id))!
    expect(done.state).toBe("done")
    expect(held.state.acts).toEqual(["after-ar_a"])
    // The confirm it was answered with stays on the done step for the steps after it to read.
    expect(done.steps[0]?.confirm?.text).toBe("ask?")
    await held.close()

    const declined = await bundle([...run("ar_a"), { kind: "mark", args: { key: "other", areaID: "ar_b" } }])
    expect(declined.state.acts).toEqual([])
    expect((await declined.answer("s1", "skip")).ok).toBe(true)
    const after = (await declined.services.journal.find(declined.op.id))!
    expect(after.steps.map((step) => step.state)).toEqual(["skipped", "skipped", "done"])
    expect(declined.state.acts).toEqual(["other"])
    await declined.close()
  })

  test("a reorganization is undoable only when a done step can be reversed", async () => {
    const h = await bundle([{ kind: "remove", mode: "confirm", args: { key: "a" } }])
    await h.answer("s1", "do")
    // The removal is done, but nothing of it reverses: 되돌리기 is not offered.
    expect((await h.services.journal.find(h.op.id))?.undo?.available).toBe(false)
    expect(h.published.filter((event) => event.name === "op.done").at(-1)).toMatchObject({
      data: { undoable: false },
    })
    await h.close()
  })

  test("a confirm answered while the controller closes records nothing; the same answer runs it later", async () => {
    const h = await setup()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    h.services.steps.register({
      kind: "slow",
      observe: async () => ({ state: "pending" }),
      act: async () => {
        entered.resolve()
        await gate.promise
        return { ok: true }
      },
      verify: async () => ({ ok: true }),
      prepare: async () => ({ text: "slow?" }),
    })
    const started = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "retire",
      by: "user",
      steps: [{ kind: "slow", mode: "confirm" }],
    })
    if (!started.ok) throw new Error("not started")
    const op = await settle(h.services, started.op.id)
    const nonce = op.steps[0]!.confirm!.nonce
    const answered = h.services.runner.confirm({ opID: op.id, stepID: "s1", choice: "do", nonce })
    await entered.promise
    await h.close()
    gate.resolve()
    expect(await answered).toMatchObject({ ok: false, error: "nonce_invalid" })
    const stored = Schema.decodeUnknownSync(OwnTeam.Op)(h.world.kv.get(Keys.op(TEAM_ID, op.id)))
    expect(stored.state).toBe("waiting")
    expect(stored.steps[0]).toMatchObject({ state: "needs_confirm", confirm: { nonce } })
  })
})

describe("op.undo", () => {
  test("answers not_found for an unknown op, and delegates to the undo service", async () => {
    const h = await setup()
    expect(await rpc(h.services)("op.undo", { opID: OwnTeam.OpID.create() })).toMatchObject({
      type: "not_found",
      data: { what: "op" },
    })
    await h.close()

    const undone: string[] = []
    const undoID = OwnTeam.OpID.create()
    const replaced = controller(h.world, {
      directory: h.home,
      clock: h.clock,
      features: {
        undo: () => ({
          start: async (input) => {
            undone.push(input.opID)
            return { ok: true, opID: undoID }
          },
        }),
      },
    })
    const target = OwnTeam.OpID.create()
    expect(await rpc(replaced.services)("op.undo", { opID: target })).toEqual({ opID: undoID })
    expect(undone).toEqual([target])
    await replaced.close()
  })
})
