// RH-20 (06 §8.5): no op holds the team's one op slot for good. A step that waits goes through `Wait.until`: the step
// records why and since when (`Step.wait`, `startedAt`, `op.progress{wait}`), `op.cancel` ends the op `cancelled` (never
// while a step acts), `op.force` runs the wait's fallback, a deadline gives up, and after 5 minutes a kept `op.stalled`
// notice tells the user. An answer to a confirm while the op waits elsewhere returns at once and survives a restart;
// an unanswered `yields` confirm gives way to the next op; a run that throws is tried again. A manual clock, fake KV.
// Live check 2 (2026-11-13): when a wait looks. An event during a check is looked at once that check is over, an event
// between checks at once, and every check is a `wait_check` line in the debug log.

import { afterAll, describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import type { Hub } from "../../src/hub.js"
import { Log } from "../../src/log.js"
import { Confirm } from "../../src/ops/confirm.js"
import { Runner } from "../../src/ops/runner.js"
import type { Steps } from "../../src/ops/steps.js"
import { Wait } from "../../src/ops/wait.js"
import { Settle } from "../../src/reorg/settle.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import type { Services } from "../../src/services.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, controller, team, tempHome } from "../support/context.js"

const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
afterAll(async () => {
  for (const home of homes) await home[Symbol.asyncDispose]()
})

const decodeKey = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }))
const keyOf = (input: Steps.Input) => Option.getOrThrow(decodeKey(input.step.args)).key

/**
 * Step kinds of a test: `mark` (marks `args.key`), `gate` (waits through `Wait.until` until `open` holds its key; its
 * fallback marks `forced:<key>`), and `ask` (a confirm that yields when unanswered).
 */
function kinds(services: Services.Context) {
  const state = {
    open: new Set<string>(),
    marked: [] as string[],
    cancelled: [] as string[],
    yielded: [] as string[],
    deadline: undefined as number | undefined,
  }
  services.steps.register({
    kind: "mark",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      state.marked.push(keyOf(input))
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  })
  services.steps.register({
    kind: "gate",
    observe: async (input) => {
      const key = keyOf(input)
      const answer = await Wait.until<Steps.Observed>(input, {
        why: "safe-point",
        text: "문이 열리기를 기다려요",
        wakes: () => false,
        check: async (report) => {
          if (state.open.has(key)) return { state: "satisfied" }
          report({ detail: "shell", text: `${key}: 실행 중인 명령이 끝나기를 기다려요` })
          return undefined
        },
        ...(state.deadline === undefined
          ? {}
          : { deadline: { ms: state.deadline, answer: async () => ({ state: "failed" as const, note: "늦었어요" }) } }),
        force: { answer: async () => ({ state: "satisfied" as const, note: `forced:${key}` }) },
      })
      return answer ?? { state: "failed", note: "멈췄어요" }
    },
    act: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
    cancel: async (input) => {
      state.cancelled.push(`${keyOf(input)}:${input.step.state}`)
    },
  })
  services.steps.register({
    kind: "ask",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      state.marked.push(`asked:${keyOf(input)}`)
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
    prepare: async () => ({ text: "큰 파일 폴더를 가져올까요?" }),
    yields: true,
    yielded: async (input) => {
      state.yielded.push(keyOf(input))
    },
  })
  return state
}

async function setup(world = new World(), clock = manual(), log: Log.Logger = Log.silent) {
  const home = await tempHome()
  homes.push(home)
  const harness = controller(world, { directory: home.root, clock, log })
  await harness.services.write(TEAM_ID, () => harness.services.registry.teams.put(team({ home: home.root })))
  // The start's resumes end first, so only what a test does drives its op.
  await harness.controller.resume()
  const state = kinds(harness.services)
  return { home: home.root, world, clock, state, ...harness }
}

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

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

async function start(
  h: Awaited<ReturnType<typeof setup>>,
  steps: ReadonlyArray<Steps.Spec>,
  kind: OwnTeam.OpKind = "reorg",
) {
  const started = await h.services.runner.start({ teamID: TEAM_ID, kind, by: "user", steps })
  if (!started.ok) throw new Error("busy")
  return started.op.id
}

/** The op once its step `stepID` records a wait. */
function waitingOn(h: Awaited<ReturnType<typeof setup>>, opID: string, stepID: string) {
  return eventually(async () => {
    const op = await h.services.journal.find(opID)
    const step = op?.steps.find((item) => item.id === stepID)
    return step?.wait !== undefined && step.wait.detail !== undefined ? { op: op!, step } : undefined
  })
}

describe("a step that waits (RH-20)", () => {
  test("records why and since when, and announces it with op.progress", async () => {
    const h = await setup()
    const opID = await start(h, [
      { kind: "mark", args: { key: "a" } },
      { kind: "gate", args: { key: "g" } },
    ])
    const found = await waitingOn(h, opID, "s2")
    expect(found.step.startedAt).toBe(h.clock.now())
    expect(found.step.wait).toEqual({
      why: "safe-point",
      detail: "shell",
      text: "g: 실행 중인 명령이 끝나기를 기다려요",
      since: h.clock.now(),
      actions: ["cancel", "force"],
    })
    expect(
      h.published.some(
        (event) => event.name === "op.progress" && event.data.opID === opID && event.data.wait?.detail === "shell",
      ),
    ).toBe(true)
    // The `busy` an op that waits answers says so.
    const second = await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by: "user", steps: [] })
    expect(second.ok).toBe(false)
    h.state.open.add("g")
    h.clock.advance(Wait.RECHECK_MS)
    expect(
      (
        await eventually(async () => {
          const op = await h.services.journal.find(opID)
          return op?.state === "done" ? op : undefined
        })
      ).steps[1],
    ).toMatchObject({ state: "done" })
    const done = (await h.services.journal.find(opID))!.steps[1]!
    expect(done.wait).toBeUndefined()
    expect(done.startedAt).toBeUndefined()
    await h.close()
  })

  test("op.cancel ends an op whose step waits: the remaining steps are skipped, the kinds' cancel hooks run", async () => {
    const h = await setup()
    const opID = await start(h, [
      { kind: "gate", args: { key: "g" } },
      { kind: "mark", args: { key: "after" } },
    ])
    await waitingOn(h, opID, "s1")
    const call = rpc(h.services)
    expect(await call("op.cancel", { opID })).toMatchObject({ op: { id: opID, state: "cancelled" } })
    const op = (await h.services.journal.find(opID))!
    expect(op.state).toBe("cancelled")
    expect(op.steps.map((step) => [step.state, step.note])).toEqual([
      ["skipped", Runner.CANCELLED],
      ["skipped", Runner.CANCELLED],
    ])
    expect(h.state.cancelled).toEqual(["g:pending"])
    expect(h.state.marked).toEqual([])
    expect(h.published.findLast((event) => event.name === "op.done")).toMatchObject({
      data: { opID, state: "cancelled" },
    })
    // The slot is free again.
    expect((await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by: "user", steps: [] })).ok).toBe(true)
    await h.close()
  })

  test("op.cancel never stops a step that acts; an op that waits only for confirms is cancelled", async () => {
    const h = await setup()
    const acting = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    h.services.steps.register({
      kind: "slow",
      observe: async () => ({ state: "pending" }),
      act: async () => {
        entered.resolve()
        await acting.promise
        return { ok: true }
      },
      verify: async () => ({ ok: true }),
    })
    const opID = await start(h, [{ kind: "slow" }, { kind: "ask", mode: "confirm", args: { key: "k" } }])
    await entered.promise
    expect(await h.services.runner.cancel(opID)).toMatchObject({ ok: false, error: "busy" })
    acting.resolve()
    await eventually(async () => ((await h.services.journal.find(opID))?.state === "waiting" ? true : undefined))
    expect(await h.services.runner.cancel(opID)).toMatchObject({ ok: true, op: { state: "cancelled" } })
    expect((await h.services.journal.find(opID))!.steps.map((step) => step.state)).toEqual(["done", "skipped"])
    await h.close()
  })

  test("op.force runs the wait's fallback; a deadline gives up on its own", async () => {
    const h = await setup()
    const opID = await start(h, [{ kind: "gate", args: { key: "g" } }])
    await waitingOn(h, opID, "s1")
    expect(await rpc(h.services)("op.force", { opID, action: "stop-shell" })).toMatchObject({ type: "unsupported" })
    expect(await rpc(h.services)("op.force", { opID })).toMatchObject({ op: { id: opID } })
    const forced = await eventually(async () => {
      const op = await h.services.journal.find(opID)
      return op?.state === "done" ? op : undefined
    })
    expect(forced.steps[0]).toMatchObject({ state: "done", note: "forced:g" })

    h.state.deadline = 60_000
    const late = await start(h, [{ kind: "gate", args: { key: "late" } }])
    await waitingOn(h, late, "s1")
    h.clock.advance(60_000)
    const failed = await eventually(async () => {
      const op = await h.services.journal.find(late)
      return op?.state === "failed" ? op : undefined
    })
    expect(failed.steps[0]).toMatchObject({ state: "failed", note: "늦었어요" })
    await h.close()
  })

  test("after 5 minutes the wait is a kept op.stalled notice, closed when the wait ends", async () => {
    const h = await setup()
    const opID = await start(h, [{ kind: "gate", args: { key: "g" } }])
    await waitingOn(h, opID, "s1")
    h.clock.advance(Wait.STALLED_MS)
    await eventually(async () =>
      (await h.services.notices.open(TEAM_ID)).some((notice) => notice.kind === "op.stalled") ? true : undefined,
    )
    const kept = (await h.services.notices.open(TEAM_ID)).find((notice) => notice.kind === "op.stalled")
    expect(kept).toMatchObject({ text: "g: 실행 중인 명령이 끝나기를 기다려요", data: { opID, stepID: "s1" } })
    h.state.open.add("g")
    h.clock.advance(Wait.RECHECK_MS)
    await eventually(async () => ((await h.services.journal.find(opID))?.state === "done" ? true : undefined))
    await eventually(async () =>
      (await h.services.notices.open(TEAM_ID)).some((notice) => notice.kind === "op.stalled") ? undefined : true,
    )
    await h.close()
  })
})

describe("a safe-point wait's first actions (RH-41)", () => {
  test("offers only 취소 until a check names commands left running, also while the check throws", async () => {
    const h = await setup()
    const checks: Array<PromiseWithResolvers<"throw" | "shell">> = []
    const shell = { id: "sh_dev", command: "bun run dev", kind: "shell" as const }
    h.services.steps.register({
      kind: "settle",
      observe: async (input) =>
        (await Settle.until(
          input,
          async (report) => {
            const next = Promise.withResolvers<"throw" | "shell">()
            checks.push(next)
            if ((await next.promise) === "throw") throw new Error("the service went away")
            report(Settle.reason("g: ", { ok: false, why: "shell", sessionIDs: [], shells: [shell] }))
            return undefined
          },
          { force: async () => ({ state: "satisfied", note: "forced" }) },
        )) ?? { state: "failed", note: "멈췄어요" },
      act: async () => ({ ok: true }),
      verify: async () => ({ ok: true }),
    })
    const opID = await start(h, [{ kind: "settle" }])
    const call = rpc(h.services)
    const wait = () => h.services.journal.find(opID).then((op) => op?.steps[0]?.wait)
    // The first check has not answered yet: 바로 진행 would go past a folder nobody looked at.
    expect((await eventually(wait)).actions).toEqual(["cancel"])
    expect(await call("op.force", { opID })).toMatchObject({ type: "unsupported" })
    // A check that throws says nothing about the folder either.
    checks[0]!.resolve("throw")
    h.clock.advance(Wait.RECHECK_MS)
    await eventually(() => (checks.length > 1 ? true : undefined))
    expect((await wait())?.actions).toEqual(["cancel"])
    expect(await call("op.force", { opID })).toMatchObject({ type: "unsupported" })
    // Only commands left running hold the folder: now both are offered.
    checks[1]!.resolve("shell")
    const named = await eventually(async () => {
      const current = await wait()
      return current?.shells === undefined ? undefined : current
    })
    expect(named.actions).toEqual(["cancel", "force", "stop-shell"])
    expect(await call("op.force", { opID })).toMatchObject({ op: { id: opID } })
    const op = await eventually(async () => {
      const current = await h.services.journal.find(opID)
      return current?.state === "done" ? current : undefined
    })
    expect(op.steps[0]).toMatchObject({ state: "done", note: "forced" })
    await h.close()
  })
})

describe("when a wait looks (live check 2)", () => {
  test("an event during a check is looked at once that check is over, one between checks at once; each check is logged", async () => {
    const lines: Array<Record<string, unknown>> = []
    const h = await setup(
      new World(),
      manual(),
      Log.create({ level: "debug", scope: "test", sink: (line) => lines.push(JSON.parse(line)) }),
    )
    const checks: Array<PromiseWithResolvers<boolean>> = []
    h.services.steps.register({
      kind: "turn",
      observe: async (input) =>
        (await Wait.until<Steps.Observed>(input, {
          why: "safe-point",
          text: "지금 일이 끝나면 바꿔요",
          wakes: (event) => event.type.startsWith("session.execution."),
          check: async () => {
            const next = Promise.withResolvers<boolean>()
            checks.push(next)
            return (await next.promise) ? { state: "satisfied" } : undefined
          },
        })) ?? { state: "failed", note: "멈췄어요" },
      act: async () => ({ ok: true }),
      verify: async () => ({ ok: true }),
    })
    // SAFETY (test): a core event with the one field a wait reads (`type`).
    const event = (type: string) =>
      ({ id: `evt_${type}_${checks.length}`, created: 1, type, data: {} }) as never as Hub.Incoming
    const opID = await start(h, [{ kind: "turn" }])
    await eventually(() => (checks.length === 1 ? true : undefined))
    // The turn ends while the first check still reads: no second check runs beside it, and the clock never moves.
    h.controller.hub.receive(event("session.execution.succeeded"))
    h.controller.hub.receive(event("session.execution.started"))
    await Bun.sleep(20)
    expect(checks.length).toBe(1)
    checks[0]!.resolve(false)
    // Both events are one more look.
    await eventually(() => (checks.length === 2 ? true : undefined))
    checks[1]!.resolve(false)
    await Bun.sleep(20)
    expect(checks.length).toBe(2)
    // An event the wait does not ask for is no look; one it asks for is, at once.
    h.controller.hub.receive(event("message.updated"))
    await Bun.sleep(20)
    expect(checks.length).toBe(2)
    h.controller.hub.receive(event("session.execution.succeeded"))
    await eventually(() => (checks.length === 3 ? true : undefined))
    checks[2]!.resolve(true)
    await eventually(async () => ((await h.services.journal.find(opID))?.state === "done" ? true : undefined))
    expect(checks.length).toBe(3)
    expect(
      lines
        .filter((line) => line.msg === "wait_check")
        .map((line) => ({ check: line.check, answered: line.answered, again: line.again, why: line.why })),
    ).toEqual([
      { check: 1, answered: false, again: true, why: "safe-point" },
      { check: 2, answered: false, again: false, why: "safe-point" },
      { check: 3, answered: true, again: false, why: "safe-point" },
    ])
    await h.close()
  })
})

describe("confirms while the op is busy (RH-20)", () => {
  test("an answer while a later step waits returns at once, is recorded, and is applied after that step", async () => {
    const h = await setup()
    const opID = await start(h, [
      { kind: "ask", mode: "confirm", args: { key: "k" } },
      { kind: "gate", args: { key: "g" } },
    ])
    const found = await waitingOn(h, opID, "s2")
    const confirm = found.op.steps[0]!.confirm!
    const answered = await h.services.runner.confirm({ opID, stepID: "s1", choice: "do", nonce: confirm.nonce })
    expect(answered).toMatchObject({ ok: true })
    if (!answered.ok) throw new Error("refused")
    expect(answered.op.steps[0]).toMatchObject({ state: "needs_confirm", answer: { choice: "do", at: h.clock.now() } })
    expect(h.state.marked).toEqual([])
    h.state.open.add("g")
    h.clock.advance(Wait.RECHECK_MS)
    const op = await eventually(async () => {
      const current = await h.services.journal.find(opID)
      return current?.state === "done" ? current : undefined
    })
    expect(op.steps.map((step) => step.state)).toEqual(["done", "done"])
    expect(h.state.marked).toEqual(["asked:k"])
    await h.close()
  })

  test("a recorded answer survives a restart and is applied by the next controller", async () => {
    const world = new World()
    const clock = manual()
    const h = await setup(world, clock)
    const opID = await start(h, [
      { kind: "ask", mode: "confirm", args: { key: "k" } },
      { kind: "gate", args: { key: "g" } },
    ])
    const found = await waitingOn(h, opID, "s2")
    const nonce = found.op.steps[0]!.confirm!.nonce
    expect(await h.services.runner.confirm({ opID, stepID: "s1", choice: "do", nonce })).toMatchObject({ ok: true })
    await h.close()
    const next = controller(world, { directory: h.home, clock })
    const state = kinds(next.services)
    state.open.add("g")
    const op = await eventually(async () => {
      const current = await next.services.journal.find(opID)
      return current?.state === "done" ? current : undefined
    })
    expect(op.steps.map((step) => step.state)).toEqual(["done", "done"])
    expect(state.marked).toEqual(["asked:k"])
    await next.close()
  })

  test("a yields confirm nobody answered in its 10 minutes gives way to the next op", async () => {
    const h = await setup()
    const opID = await start(h, [{ kind: "ask", mode: "confirm", args: { key: "paths" } }], "paths")
    await eventually(async () => ((await h.services.journal.find(opID))?.state === "waiting" ? true : undefined))
    const early = await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by: "user", steps: [] })
    expect(early).toMatchObject({ ok: false, error: "busy" })
    h.clock.advance(Confirm.TTL_MS)
    const later = await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by: "user", steps: [] })
    expect(later.ok).toBe(true)
    expect(h.state.yielded).toEqual(["paths"])
    expect((await h.services.journal.find(opID))!.steps[0]).toMatchObject({
      state: "skipped",
      note: Runner.UNANSWERED,
    })
    await h.close()
  })
})

describe("a run that throws (RH-20)", () => {
  test("is tried again after 30 s instead of leaving the op running with nothing driving it", async () => {
    const h = await setup()
    const get = h.world.kv.get.bind(h.world.kv)
    const broken = { reads: 0, acted: false }
    h.services.steps.register({
      kind: "flaky",
      observe: async () => ({ state: "pending" }),
      act: async () => {
        // The runner's next read of the op record throws once (a disposed context, KV without an instance).
        if (!broken.acted) broken.reads = 1
        broken.acted = true
        return { ok: true }
      },
      verify: async () => ({ ok: true }),
    })
    h.world.kv.get = (key: string) => {
      if (broken.reads > 0 && key.startsWith("op:")) {
        broken.reads--
        throw new Error("no live plugin instance for KV access")
      }
      return get(key)
    }
    const opID = await start(h, [{ kind: "flaky" }, { kind: "mark", args: { key: "after" } }])
    await eventually(async () => (h.services.errors(TEAM_ID).length > 0 ? true : undefined))
    expect((await h.services.journal.find(opID))!.state).toBe("running")
    expect(h.state.marked).toEqual([])
    h.clock.advance(Runner.RETRY_MS)
    const op = await eventually(async () => {
      const current = await h.services.journal.find(opID)
      return current?.state === "done" ? current : undefined
    })
    expect(op.steps.map((step) => step.state)).toEqual(["done", "done"])
    expect(h.state.marked).toEqual(["after"])
    await h.close()
  })
})
