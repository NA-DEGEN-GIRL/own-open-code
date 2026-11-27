// The process singleton: one desktop per build id, shared by every instance, closed with the last release.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, PubSub, Scope } from "effect"
import { TestClock } from "effect/testing"
import { FakeDriver } from "../../src/driver/fake.js"
import { Gate } from "../../src/gate.js"
import { Options } from "../../src/options.js"
import { Desktop } from "../../src/singleton.js"
import { ON, context, until } from "./support.js"

describe("desktop singleton", () => {
  test("instances of one build share a desktop; the last release closes its driver; other builds are separate", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-singleton-"))
    try {
      const options = Options.decode({ driver: "fake", home })
      const buildId = `test-${crypto.randomUUID()}`
      const scope = () => Effect.runPromise(Scope.make())
      const first = await scope()
      const second = await scope()
      const other = await scope()
      const acquire = (scope: Scope.Closeable, id: string) =>
        Effect.runPromise(Desktop.acquire({ buildId: id, options }).pipe(Scope.provide(scope)))
      const a = await acquire(first, buildId)
      const b = await acquire(second, buildId)
      const c = await acquire(other, `${buildId}-next`)
      expect(b).toBe(a)
      expect(c).not.toBe(a)
      expect(a.auditDir).toBe(path.join(home, "audit"))
      await Effect.runPromise(Scope.close(first, Exit.void))
      expect(Exit.isSuccess(await Effect.runPromiseExit(b.driver.displays))).toBe(true)
      await Effect.runPromise(Scope.close(second, Exit.void))
      expect(Exit.isFailure(await Effect.runPromiseExit(b.driver.displays))).toBe(true)
      const third = await scope()
      expect(await acquire(third, buildId)).not.toBe(a)
      await Effect.runPromise(Scope.close(third, Exit.void))
      await Effect.runPromise(Scope.close(other, Exit.void))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a stricter instance's policy applies at once; only another driver or helper replaces the driver", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-options-"))
    try {
      const buildId = `test-${crypto.randomUUID()}`
      const acquire = async (options: Record<string, unknown>) => {
        const scope = await Effect.runPromise(Scope.make())
        const desktop = await Effect.runPromise(
          Desktop.acquire({ buildId, options: Options.decode({ driver: "fake", home, ...options }) }).pipe(
            Scope.provide(scope),
          ),
        )
        return { desktop, release: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
      }
      const notepad = async (desktop: Desktop.Desktop) => {
        const deps = {
          desktop,
          session: () => Effect.succeed({ permissions: ON }),
          question: () => undefined,
          blocked: [],
        }
        const result = await Effect.runPromise(Gate.run(deps, "list_windows", {}, context()))
        return (result.output as { windows: Array<{ app: string; allowed: string }> }).windows.find(
          (row) => row.app === "notepad",
        )?.allowed
      }
      const first = await acquire({})
      const driver = first.desktop.driver
      expect(await notepad(first.desktop)).toBe("yes")
      // Another Location's config reload tightens the policy: the shared desktop follows without a restart.
      const second = await acquire({ policy: { denyApps: ["notepad"] }, approval: "question" })
      expect(second.desktop).toBe(first.desktop)
      expect(await notepad(first.desktop)).toBe("no")
      const status = await Effect.runPromise(Desktop.status(first.desktop, { buildId, version: "v" }))
      expect([status.approval, status.policy.denyApps]).toEqual(["question", ["notepad"]])
      expect(first.desktop.driver).toBe(driver)
      // Another driver replaces the old one, which closes; creating the helper driver starts no process.
      const third = await acquire({ driver: "helper" })
      expect(first.desktop.driver.kind).toBe("helper")
      expect(first.desktop.helper().running).toBe(false)
      expect(Exit.isFailure(await Effect.runPromiseExit(driver.displays))).toBe(true)
      for (const instance of [third, second, first]) await instance.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a looser instance never loosens the shared policy; a release recomputes it from the live instances", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-strict-"))
    try {
      const buildId = `test-${crypto.randomUUID()}`
      const acquire = async (options: Record<string, unknown>) => {
        const scope = await Effect.runPromise(Scope.make())
        const desktop = await Effect.runPromise(
          Desktop.acquire({ buildId, options: Options.decode({ driver: "fake", home, ...options }) }).pipe(
            Scope.provide(scope),
          ),
        )
        return { desktop, release: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
      }
      const view = async (desktop: Desktop.Desktop) => {
        const status = await Effect.runPromise(Desktop.status(desktop, { buildId, version: "v" }))
        return { approval: status.approval, audit: desktop.options.audit, ...status.policy }
      }
      const strict = await acquire({ policy: { denyApps: ["notepad"], allowApps: ["Paint.exe", "notepad"] } })
      // A project config that lists the plugin again with looser options, opened later.
      const loose = await acquire({
        approval: "session",
        audit: false,
        policy: { allowTerminals: true, allowSubagents: true, allowApps: ["paint", "cmd"] },
      })
      expect(loose.desktop).toBe(strict.desktop)
      expect(await view(strict.desktop)).toEqual({
        approval: "session",
        audit: true,
        allowApps: ["paint"],
        denyApps: ["notepad"],
        allowTerminals: false,
        allowSubagents: false,
      })
      // Exclusive lists that share no app leave every app asking the user.
      const other = await acquire({ policy: { allowApps: ["mspaint"] } })
      expect(await view(strict.desktop)).toMatchObject({ approval: "question", allowApps: [] })
      await other.release()
      // Once the strict Location closes, only the remaining instance governs.
      await strict.release()
      expect(await view(loose.desktop)).toEqual({
        approval: "session",
        audit: false,
        allowApps: ["paint", "cmd"],
        denyApps: [],
        allowTerminals: true,
        allowSubagents: true,
      })
      await loose.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an engaged kill switch outlives the last release and a restart; only a reset clears it", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-stop-"))
    try {
      const options = Options.decode({ driver: "fake", home })
      const buildId = `test-${crypto.randomUUID()}`
      const stopFile = path.join(home, "state", Desktop.STOP_FILE)
      const acquire = async () => {
        const scope = await Effect.runPromise(Scope.make())
        const desktop = await Effect.runPromise(Desktop.acquire({ buildId, options }).pipe(Scope.provide(scope)))
        return { desktop, release: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
      }
      const first = await acquire()
      await Effect.runPromise(first.desktop.engage("rpc"))
      const engaged = await Effect.runPromise(first.desktop.killSwitch.state)
      expect(engaged).toMatchObject({ engaged: true, reason: "rpc" })
      expect(existsSync(stopFile)).toBe(true)
      // The last instance lets go (Location eviction or reload): the next desktop is new but still stopped.
      await first.release()
      const second = await acquire()
      expect(second.desktop).not.toBe(first.desktop)
      expect(await Effect.runPromise(second.desktop.killSwitch.state)).toEqual(engaged)
      expect((await Effect.runPromiseExit(second.desktop.killSwitch.check))._tag).toBe("Failure")
      await second.release()
      // A new process reads the same file.
      const restarted = Desktop.create(options)
      expect(await Effect.runPromise(restarted.desktop.killSwitch.state)).toEqual(engaged)
      await Effect.runPromise(restarted.desktop.reset)
      expect(existsSync(stopFile)).toBe(false)
      await Effect.runPromise(restarted.close)
      const third = await acquire()
      expect(await Effect.runPromise(third.desktop.killSwitch.state)).toEqual({ engaged: false })
      await third.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a stop file that does not decode still counts as engaged", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-stop-"))
    try {
      const created = Desktop.create(Options.decode({ driver: "fake", home }))
      expect(await Effect.runPromise(created.desktop.killSwitch.state)).toEqual({ engaged: false })
      await Effect.runPromise(created.close)
      const stopFile = path.join(home, "state", Desktop.STOP_FILE)
      mkdirSync(path.dirname(stopFile), { recursive: true })
      writeFileSync(stopFile, "{")
      const again = Desktop.create(Options.decode({ driver: "fake", home }))
      expect(await Effect.runPromise(again.desktop.killSwitch.state)).toMatchObject({ engaged: true, reason: "rpc" })
      await Effect.runPromise(again.close)
      // A stop file that exists but cannot be read (here a directory: EISDIR) is not proof of "never engaged".
      rmSync(stopFile)
      mkdirSync(stopFile)
      const unreadable = Desktop.create(Options.decode({ driver: "fake", home }))
      expect(await Effect.runPromise(unreadable.desktop.killSwitch.state)).toMatchObject({ engaged: true })
      await Effect.runPromise(unreadable.close)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("builds overlapping after a hot reload share one kill switch; the stop file is written before input is let go", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-shared-stop-"))
    try {
      const options = Options.decode({ driver: "fake", home })
      const stopFile = path.join(home, "state", Desktop.STOP_FILE)
      const driver = await Effect.runPromise(FakeDriver.make(Desktop.FAKE_DESKTOP))
      const saved: Array<boolean> = []
      const old = Desktop.create(options, {
        ...driver,
        releaseAll: Effect.sync(() => saved.push(existsSync(stopFile))).pipe(Effect.andThen(driver.releaseAll)),
      })
      const nextDriver = await Effect.runPromise(FakeDriver.make(Desktop.FAKE_DESKTOP))
      const next = Desktop.create(options, nextDriver)
      // The old build holds a button (`left_mouse_down`) when a Stop is pressed in the new one.
      await Effect.runPromise(driver.button("left", "down"))
      old.desktop.held.add("ses_old")
      const listening = await Effect.runPromise(Scope.make())
      const notices = await Effect.runPromise(PubSub.subscribe(old.desktop.notices).pipe(Scope.provide(listening)))
      await Effect.runPromise(next.desktop.engage("rpc"))
      expect((await Effect.runPromiseExit(old.desktop.killSwitch.check))._tag).toBe("Failure")
      await until(() => driver.held().buttons.length === 0 && old.desktop.held.size === 0)
      expect(saved).toEqual([true])
      expect(await Effect.runPromise(PubSub.take(notices))).toEqual({ _tag: "status" })
      await Effect.runPromise(Scope.close(listening, Exit.void))
      await Effect.runPromise(next.desktop.reset)
      expect((await Effect.runPromiseExit(old.desktop.killSwitch.check))._tag).toBe("Success")
      // And the other way round: a Stop in the old build lets go of what the new one holds.
      await Effect.runPromise(nextDriver.button("left", "down"))
      await Effect.runPromise(old.desktop.engage("rpc"))
      expect(saved).toEqual([true, true])
      await until(() => nextDriver.held().buttons.length === 0)
      expect(await Effect.runPromise(next.desktop.killSwitch.state)).toMatchObject({ engaged: true, reason: "rpc" })
      // A closed desktop leaves the switch: a later Stop no longer reaches it.
      await Effect.runPromise(old.close)
      await Effect.runPromise(next.desktop.reset)
      await Effect.runPromise(next.desktop.engage("rpc"))
      expect(saved).toEqual([true, true])
      await Effect.runPromise(next.close)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an unexpected helper exit engages the kill switch and releases held input; closing does not", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-exit-"))
    try {
      const options = Options.decode({ driver: "fake", home })
      const driver = await Effect.runPromise(FakeDriver.make(Desktop.FAKE_DESKTOP))
      const created = Desktop.create(options, driver)
      await Effect.runPromise(driver.button("left", "down"))
      created.desktop.held.add("ses_x")
      await Effect.runPromise(driver.emit({ _tag: "exited", code: 1 }))
      await until(() => created.desktop.held.size === 0)
      expect(await Effect.runPromise(created.desktop.killSwitch.state)).toMatchObject({
        engaged: true,
        reason: "helper_exit",
      })
      expect(driver.held().buttons).toEqual([])
      expect(created.desktop.held.size).toBe(0)
      await Effect.runPromise(created.desktop.reset)
      await Effect.runPromise(created.close)

      // close stops the watcher before the driver, so the helper's own exit on close never engages.
      const other = await Effect.runPromise(FakeDriver.make(Desktop.FAKE_DESKTOP))
      const closed = Desktop.create(options, other)
      await Effect.runPromise(closed.close)
      await Bun.sleep(20)
      expect(await Effect.runPromise(closed.desktop.killSwitch.state)).toEqual({ engaged: false })
      expect(existsSync(path.join(home, "state", Desktop.STOP_FILE))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("the driver option picks the Windows driver; creating it starts no worker or helper", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-drivers-"))
    try {
      for (const [driver, kind] of [
        ["windows", "windows"],
        ["helper", "helper"],
        ["fake", "fake"],
      ] as const) {
        const created = Desktop.create(Options.decode({ driver, home }))
        expect(created.desktop.driver.kind).toBe(kind)
        const status = await Effect.runPromise(Desktop.status(created.desktop, { buildId: "b", version: "v" }))
        expect(status.driver).toBe(driver)
        expect(status.helper.running).toBe(driver === "fake")
        await Effect.runPromise(created.close)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a new holder, its release and the lease lapsing are status notices; renewing is not (06 §9.4)", async () => {
    const created = Desktop.create(Options.decode({ driver: "fake", home: os.tmpdir(), leaseIdleSeconds: 5 }))
    const desktop = created.desktop
    const counts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const notices = yield* PubSub.subscribe(desktop.notices)
          const count = () => Effect.map(PubSub.takeUpTo(notices, 10), (taken) => taken.length)
          yield* desktop.lease.acquire("ses_a")
          const taken = yield* count()
          yield* TestClock.adjust("2 seconds")
          yield* desktop.lease.acquire("ses_a")
          const renewed = yield* count()
          yield* desktop.lease.acquire("ses_b")
          const busy = yield* count()
          yield* TestClock.adjust("4 seconds")
          const early = yield* count()
          yield* TestClock.adjust("1 second")
          const lapsed = yield* count()
          const holder = yield* desktop.lease.holder
          yield* desktop.lease.acquire("ses_b")
          const next = yield* count()
          yield* desktop.lease.release("ses_a")
          const foreign = yield* count()
          yield* desktop.lease.release("ses_b")
          const released = yield* count()
          return { taken, renewed, busy, early, lapsed, holder, next, foreign, released }
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(counts).toEqual({
      taken: 1,
      renewed: 0,
      busy: 0,
      early: 0,
      lapsed: 1,
      holder: undefined,
      next: 1,
      foreign: 0,
      released: 1,
    })
    await Effect.runPromise(created.close)
  })

  test("forget drops the session's frames, grants and lease", async () => {
    const created = Desktop.create(Options.decode({ driver: "fake", home: os.tmpdir() }))
    const desktop = created.desktop
    desktop.grants.set("ses_x", ["notepad"])
    await Effect.runPromise(desktop.lease.acquire("ses_x"))
    desktop.frames.sessions.set("ses_x", [])
    await Effect.runPromise(Desktop.forget(desktop, "ses_x"))
    expect(desktop.grants.has("ses_x")).toBe(false)
    expect(desktop.frames.sessions.has("ses_x")).toBe(false)
    expect(await Effect.runPromise(desktop.lease.holder)).toBeUndefined()
    await Effect.runPromise(created.close)
  })
})
