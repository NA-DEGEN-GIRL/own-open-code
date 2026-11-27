export * as Desktop from "./singleton.js"

import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { Home } from "@own/runtime"
import { Effect, Fiber, PubSub, Semaphore, Stream } from "effect"
import { Frames } from "./core/frames.js"
import { KillSwitch } from "./core/killswitch.js"
import { Lease } from "./core/lease.js"
import { Policy } from "./core/policy.js"
import type { Driver } from "./driver/driver.js"
import { FakeDriver } from "./driver/fake.js"
import { WindowsDriver } from "./driver/windows/driver.js"
import type { Options } from "./options.js"

/**
 * One physical desktop per process: every plugin instance (one per Location) of a build shares the driver, the kill
 * switch, the desktop lease, the action lock, the frames and the per-session grants through this singleton, kept on
 * `globalThis` under the build id with the live instances' options (like own-runtime's singleton). Overlapping builds
 * after a hot reload get separate entries; the desktop mutex (taken by the desktop worker or the helper) keeps them from
 * driving the desktop at once, and they share one kill switch (`KillSwitch.shared`), so a stop in either stops both and
 * lets go of the input both hold. Creating it is cheap: the worker threads (or the helper) start on the first request,
 * not here. The desktop runs with the live instances' options combined ({@link combine}), recomputed whenever an
 * instance joins or leaves, except `home`, which stays the first instance's. An engaged kill switch outlives the entry:
 * it is saved under `<OWN_HOME>\state` and every new desktop starts from it.
 */
export interface Desktop {
  /** The live instances' combined options; read on every call, so a changed policy applies to the next action. */
  readonly options: Options.Info
  /** The current driver: rebuilt, between actions, when an instance brings another `driver` or `helper` option. */
  readonly driver: Driver.Driver
  readonly killSwitch: KillSwitch.KillSwitch
  /** A new holder, its release and the lease lapsing go out as `status` notices. */
  readonly lease: Lease.Lease
  /** One computer action at a time across sessions and Locations. */
  readonly lock: Semaphore.Semaphore
  readonly frames: Frames.Store
  /** Apps approved per session in `question` mode (normalized names). */
  readonly grants: Map<string, ReadonlyArray<string>>
  /**
   * Sessions that left the left button down (`left_mouse_down`) until `left_mouse_up`, the kill switch or the
   * session's deletion. While it is non-empty a `mouse_move` drags, so the gate checks where it ends.
   */
  readonly held: Set<string>
  /** `<OWN_HOME>\audit`. */
  readonly auditDir: string
  /** What every instance republishes as `own.computer` events. */
  readonly notices: PubSub.PubSub<Notice>
  /** The desktop worker (`windows`) or the helper process (`helper`). */
  readonly helper: () => OwnComputer.Helper
  /**
   * Releases held input and stops the worker threads or the helper without engaging the kill switch. Waits for the
   * action lock, so it never cuts an action between a key down and its up.
   */
  readonly restart: Effect.Effect<void>
  /** Engages the kill switch and releases any held input. */
  readonly engage: (reason: KillSwitch.Reason) => Effect.Effect<void>
  readonly reset: Effect.Effect<void>
  readonly notify: (notice: Notice) => Effect.Effect<void>
}

export type Notice = { readonly _tag: "status" } | { readonly _tag: "action"; readonly action: OwnComputer.Action }

export interface Input {
  readonly buildId: string
  readonly options: Options.Info
}

/**
 * The desktop of `buildId`, created on first use and closed (driver `close`) when the last instance releases it. An
 * instance joining or leaving an existing desktop recomputes its options from the live instances (`adopt`).
 */
export const acquire = (input: Input) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const key = Symbol.for(`own-open-code.computer-use/${input.buildId}`)
      // A wrapper of its own, so a release removes exactly this instance even when two pass the same options.
      const instance = { options: input.options }
      const existing = registry()[key]
      if (existing !== undefined) {
        existing.live.push(instance)
        return { key, entry: existing, instance, joined: true }
      }
      const entry = { live: [instance], ...create(input.options) }
      registry()[key] = entry
      return { key, entry, instance, joined: false }
    }),
    (held) =>
      Effect.suspend(() => {
        held.entry.live.splice(held.entry.live.indexOf(held.instance), 1)
        if (held.entry.live.length > 0) return held.entry.adopt(combineLive(held.entry))
        if (registry()[held.key] === held.entry) delete registry()[held.key]
        return held.entry.close
      }),
  ).pipe(
    Effect.tap((held) => (held.joined ? held.entry.adopt(combineLive(held.entry)) : Effect.void)),
    Effect.map((held) => held.entry.desktop),
  )

/**
 * The options one shared desktop runs with while these instances (in acquire order) are live. Plugin options come from
 * each Location's config, so the app policy combines restrictively: a project config that lists this plugin again can
 * tighten it for every session but never loosen it for sessions another Location's config governs (01 §10.2). Denied
 * apps add up; terminals, subagents and `session` approval need every instance to allow them; audit is on when any
 * instance has it; exclusive `allowApps` lists intersect, and lists that share no app leave every app asking the user
 * (`question`). Everything else, the driver and the helper included, is the latest instance's: they are not a policy,
 * and a project config can already run code in the service through a project plugin (01 §13.2). Blocked chords need no
 * combining: each instance enforces its own on top of the built-in ones.
 */
export function combine(live: ReadonlyArray<Options.Info>): Options.Info {
  const latest = live.at(-1)
  if (latest === undefined) throw new Error("no live computer-use instance")
  const lists = live.map((options) => options.policy.allowApps).filter((apps) => apps.length > 0)
  const allowApps = (lists[0] ?? []).filter((app) =>
    lists.every((apps) => apps.some((item) => Policy.appName(item) === Policy.appName(app))),
  )
  const disjoint = lists.length > 0 && allowApps.length === 0
  return {
    ...latest,
    approval: disjoint || live.some((options) => options.approval === "question") ? "question" : "session",
    audit: live.some((options) => options.audit),
    policy: {
      ...latest.policy,
      allowApps,
      denyApps: [...new Set(live.flatMap((options) => options.policy.denyApps))],
      allowTerminals: live.every((options) => options.policy.allowTerminals),
      allowSubagents: live.every((options) => options.policy.allowSubagents),
    },
  }
}

function combineLive(entry: Entry) {
  return combine(entry.live.map((instance) => instance.options))
}

/** The `status` view of an available desktop. */
export const status = (desktop: Desktop, build: { readonly buildId: string; readonly version: string }) =>
  Effect.gen(function* () {
    const state = yield* desktop.killSwitch.state
    const holder = yield* desktop.lease.holder
    return {
      available: true,
      buildId: build.buildId,
      version: build.version,
      driver: desktop.options.driver,
      approval: desktop.options.approval,
      policy: {
        allowApps: appNames(desktop.options.policy.allowApps),
        denyApps: appNames(desktop.options.policy.denyApps),
        allowTerminals: desktop.options.policy.allowTerminals,
        allowSubagents: desktop.options.policy.allowSubagents,
      },
      helper: desktop.helper(),
      killSwitch: killSwitchView(state),
      lease: { holder: holder === undefined ? null : SessionID.make(holder) },
      grants: [...desktop.grants].map(([sessionID, apps]) => ({ sessionID: SessionID.make(sessionID), apps })),
    } satisfies OwnComputer.Status
  })

export function killSwitchView(state: KillSwitch.State): OwnComputer.KillSwitch {
  return state.engaged ? { engaged: true, reason: state.reason, at: state.at } : { engaged: false }
}

/** Option app names as the policy compares them (`Policy.appName`), without repeats. */
function appNames(apps: ReadonlyArray<string>) {
  return [...new Set(apps.map(Policy.appName))]
}

/** Drops everything kept for a deleted session, and lets go of a button it left down. */
export const forget = (desktop: Desktop, sessionID: string) =>
  Effect.gen(function* () {
    Frames.forget(desktop.frames, sessionID)
    const granted = desktop.grants.delete(sessionID)
    if (desktop.held.delete(sessionID))
      yield* desktop.lock.withPermits(1)(Effect.suspend(() => desktop.driver.releaseAll))
    yield* desktop.lease.release(sessionID)
    if (granted) yield* desktop.notify({ _tag: "status" })
  })

/**
 * A run of the session ended (succeeded, failed or interrupted): lets go of a button it left down and of its desktop
 * lease. Its frames and app grants stay, since the next turn may go on from them.
 */
export const settle = (desktop: Desktop, sessionID: string) =>
  Effect.gen(function* () {
    if (desktop.held.delete(sessionID))
      yield* desktop.lock.withPermits(1)(Effect.suspend(() => desktop.driver.releaseAll))
    yield* desktop.lease.release(sessionID)
  })

/** The in-memory desktop of `driver: "fake"`: one 1080p display with a Notepad window in front. */
export const FAKE_DESKTOP: FakeDriver.Scenario = {
  displays: FakeDriver.DISPLAYS.single,
  windows: [
    {
      id: "0x10",
      exe: "C:\\Windows\\System32\\notepad.exe",
      title: "Untitled - Notepad",
      className: "Notepad",
      bounds: { x: 200, y: 120, width: 1200, height: 800 },
      focus: { isPassword: false, controlType: "Document" },
    },
  ],
  foreground: "0x10",
}

/** The engaged kill switch, under `<OWN_HOME>\state` (`KillSwitch.save`); removed by a reset. */
export const STOP_FILE = "computer-use-stop.json"

/** How long an engage waits for the stop file to be written before it lets go of held input anyway. */
const SAVE_TIMEOUT = "300 millis"

export interface Entry {
  /** The options of every instance holding the desktop, in acquire order. */
  readonly live: Array<{ readonly options: Options.Info }>
  readonly desktop: Desktop
  /**
   * Makes `options` (the live instances' {@link combine}d options) the desktop's. A different `driver` or `helper`
   * replaces the driver under the action lock, so no action is cut between a key down and its up; any other change
   * applies to the next call.
   */
  readonly adopt: (options: Options.Info) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

function registry() {
  return globalThis as unknown as Record<symbol, Entry | undefined>
}

/**
 * A desktop, its closer and `adopt`; `injected` replaces the driver `options.driver` names (tests drive a FakeDriver
 * scenario) and is never rebuilt. Synchronous on purpose: two instances acquiring at once must never both create a
 * desktop.
 */
export function create(options: Options.Info, injected?: Driver.Driver): Omit<Entry, "live"> {
  const home = Home.resolve({ home: options.home })
  const stopFile = path.join(home, "state", STOP_FILE)
  const notices = Effect.runSync(PubSub.unbounded<Notice>())
  const lock = Effect.runSync(Semaphore.make(1))
  const held = new Set<string>()
  const notify = (notice: Notice) => Effect.asVoid(PubSub.publish(notices, notice))
  // What an engaged switch does to this desktop, whichever build engaged it: let go of held input, tell the clients.
  const stopped = Effect.suspend(() => current.backend.driver.releaseAll).pipe(
    Effect.andThen(Effect.sync(() => held.clear())),
    Effect.andThen(notify({ _tag: "status" })),
  )
  // Another build calls this from its own runtime, so it only starts the effect in this build's.
  const shared = KillSwitch.shared(stopFile, () => void Effect.runFork(stopped))
  const killSwitch = shared.killSwitch
  const save = Effect.flatMap(killSwitch.state, (state) => KillSwitch.save(stopFile, state))
  // Saved before the input is released, so a crash in between cannot lose the stop, but only for a bounded time: a
  // slow or hung write (a scanner, a network share) must never keep keys or buttons down.
  const engage = (reason: KillSwitch.Reason): Effect.Effect<void> =>
    killSwitch
      .engage(reason)
      .pipe(
        Effect.andThen(save.pipe(Effect.timeout(SAVE_TIMEOUT), Effect.ignore)),
        Effect.andThen(stopped),
        Effect.andThen(Effect.sync(shared.others)),
      )
  const backend = (from: Options.Info) => {
    const windows =
      injected !== undefined || from.driver === "fake"
        ? undefined
        : Effect.runSync(
            from.driver === "helper"
              ? WindowsDriver.helper({
                  command: WindowsDriver.command({ ...from.helper, home: options.home }),
                  timeoutMs: from.helper.timeoutMs,
                })
              : WindowsDriver.ffi({ timeoutMs: from.helper.timeoutMs }),
          )
    const driver = injected ?? windows ?? Effect.runSync(FakeDriver.make(FAKE_DESKTOP))
    // The stop chord and an unexpected end of the desktop worker or helper stop computer use for every session until
    // an explicit reset. Started synchronously, so it is subscribed before the first event can arrive.
    const watcher = Effect.runSync(
      driver.events.pipe(
        Stream.runForEach((event) => {
          if (event._tag === "kill_chord") return engage("user_chord")
          if (event._tag === "exited") return engage("helper_exit")
          return Effect.void
        }),
        Effect.forkDetach({ startImmediately: true }),
      ),
    )
    return { from, windows, driver, watcher }
  }
  const current = { options, backend: backend(options) }
  // The watcher stops before the driver, so the worker's or helper's own exit on close never engages the kill switch.
  const stop = (old: typeof current.backend) => Fiber.interrupt(old.watcher).pipe(Effect.andThen(old.driver.close))
  const rebuild = (next: Options.Info) =>
    injected === undefined &&
    (next.driver !== current.backend.from.driver || !sameHelper(next.helper, current.backend.from.helper))
  const idleMs = () => current.options.leaseIdleSeconds * 1000
  const lease = Effect.runSync(Lease.make(idleMs))
  // The holder is part of `status` (the team view's `데스크톱 사용 중`, 06 §9.4): a new holder, its release and the
  // lease lapsing after `leaseIdleSeconds` go out as a status notice; a holder renewing its lease does not.
  const lapse: { fiber?: Fiber.Fiber<void> } = {}
  const stopLapse = Effect.suspend(() => (lapse.fiber ? Fiber.interrupt(lapse.fiber) : Effect.void))
  const desktop: Desktop = {
    get options() {
      return current.options
    },
    get driver() {
      return current.backend.driver
    },
    killSwitch,
    lease: {
      acquire: (sessionID) =>
        Effect.gen(function* () {
          const before = yield* lease.holder
          const result = yield* lease.acquire(sessionID)
          if (result._tag === "Busy") return result
          yield* stopLapse
          lapse.fiber = yield* Effect.sleep(idleMs()).pipe(
            Effect.andThen(notify({ _tag: "status" })),
            Effect.forkDetach(),
          )
          if (before !== sessionID) yield* notify({ _tag: "status" })
          return result
        }),
      release: (sessionID) =>
        Effect.gen(function* () {
          const before = yield* lease.holder
          yield* lease.release(sessionID)
          if (before === sessionID) yield* notify({ _tag: "status" })
        }),
      holder: lease.holder,
    },
    lock,
    frames: Frames.make(),
    grants: new Map(),
    held,
    auditDir: path.join(home, "audit"),
    notices,
    helper: () => {
      const windows = current.backend.windows
      if (windows === undefined) return { running: true, version: "fake", protocol: 1, killChord: true }
      const info = windows.info()
      return info === undefined
        ? { running: windows.running() }
        : {
            running: windows.running(),
            version: info.version,
            protocol: info.protocol,
            killChord: info.killChord ?? false,
          }
    },
    restart: lock
      .withPermits(1)(Effect.suspend(() => current.backend.windows?.restart ?? Effect.void))
      .pipe(Effect.andThen(Effect.sync(() => held.clear())), Effect.andThen(notify({ _tag: "status" }))),
    engage,
    reset: killSwitch.reset.pipe(Effect.andThen(save), Effect.andThen(notify({ _tag: "status" }))),
    notify,
  }
  return {
    desktop,
    adopt: (next) =>
      Effect.suspend(() => {
        current.options = next
        if (!rebuild(next)) return notify({ _tag: "status" })
        // Built from the options current once the lock is free, so overlapping adopts end on the latest one.
        return lock
          .withPermits(1)(
            Effect.suspend(() => {
              if (!rebuild(current.options)) return Effect.void
              const old = current.backend
              current.backend = backend(current.options)
              held.clear()
              return stop(old)
            }),
          )
          .pipe(Effect.andThen(notify({ _tag: "status" })))
      }),
    // Leaves the shared switch first, so another build's stop never reaches a closed desktop.
    close: Effect.sync(shared.release).pipe(
      Effect.andThen(stopLapse),
      Effect.andThen(Effect.suspend(() => stop(current.backend))),
      Effect.andThen(PubSub.shutdown(notices)),
    ),
  }
}

function sameHelper(a: Options.Info["helper"], b: Options.Info["helper"]) {
  return a.exePath === b.exePath && a.timeoutMs === b.timeoutMs && a.command?.join("\0") === b.command?.join("\0")
}
