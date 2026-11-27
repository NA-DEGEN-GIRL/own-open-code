export * as Controller from "./controller.js"

import fs from "node:fs"
import type { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Lock, type ServiceTarget } from "@own/runtime"
import { Drift } from "./assets/drift.js"
import { Heavy } from "./assets/heavy.js"
import { Release } from "./assets/release.js"
import { Shared } from "./assets/shared.js"
import { Symlinks } from "./assets/symlinks.js"
import { AssetsVerify } from "./assets/verify.js"
import { Decisions } from "./docs/decisions.js"
import { Inventory } from "./git/inventory.js"
import { Git } from "./git/run.js"
import { Advance } from "./integrate/advance.js"
import { IntegrateOp } from "./integrate/op.js"
import { Push } from "./integrate/push.js"
import { IntegrateUndo } from "./integrate/undo.js"
import { Adopt } from "./ops/adopt.js"
import { Disable } from "./ops/disable.js"
import { Reconcile } from "./reconcile/area.js"
import { RemoteLfs } from "./remote/lfs.js"
import { Convert } from "./reorg/convert.js"
import { AreaMerge } from "./reorg/merge.js"
import { ReorgPropose } from "./reorg/propose.js"
import { Rehome } from "./reorg/rehome.js"
import { Retire } from "./reorg/retire.js"
import { AreaSplit } from "./reorg/split.js"
import { Fold } from "./report/fold.js"
import { AreaMain } from "./sessions/area-main.js"
import { AreaCreate } from "./ops/area-create.js"
import { Admit } from "./dispatch/admit.js"
import { Direct } from "./dispatch/direct.js"
import { WorktreeChatFeature } from "./worktree-chat/feature.js"
import { Digest } from "./report/digest.js"
import { Handoff } from "./docs/handoff.js"
import { Hub } from "./hub.js"
import { Identity } from "./git/identity.js"
import { Intake } from "./intake.js"
import type { Log } from "./log.js"
import { MainSession } from "./sessions/main.js"
import { Notices } from "./notices.js"
import { OwnerSession } from "./sessions/owner.js"
import { Peers } from "./sessions/peer.js"
import { Pause } from "./dispatch/pause.js"
import { Talk } from "./dispatch/talk.js"
import { ReportEvents } from "./report/events.js"
import { Rotation } from "./sessions/rotate.js"
import { Seat } from "./sessions/seat.js"
import { SafePoint } from "./sessions/safe-point.js"
import { TeamContext } from "./sessions/team-context.js"
import { Undo } from "./ops/undo.js"
import { Wake } from "./report/wake.js"
import { AccountsRpc } from "./sessions/accounts-rpc.js"
import { Journal } from "./ops/journal.js"
import { Locate } from "./sessions/locate.js"
import { Runner } from "./ops/runner.js"
import { SessionHttp } from "./sessions/http.js"
import { Steps } from "./ops/steps.js"
import { Areas } from "./registry/area.js"
import { Dispatches } from "./registry/dispatch.js"
import { Keys } from "./registry/keys.js"
import { Teams } from "./registry/team.js"
import { Services } from "./services.js"

/**
 * The own.team controller (06 §2.2, §2.6): one per process and build (`singleton.ts`), shared by every plugin
 * instance. It owns the registry, the op journal and runner, the event hub and the feature services, and it is the
 * only KV writer, one team at a time (a mutex per team, after it holds `OWN_HOME\locks\team-controller.lock`).
 *
 * It has no plugin context of its own: KV writes, own.accounts calls and session writes go through a live instance's
 * `ctx`, and when none is left the work resumes with the next instance (06 §2.6 "수명의 한계"). Instances attach and
 * detach; every attach triggers `resume` (running ops, catch-up, timers, waiting requests).
 */

export interface Input {
  readonly buildId: string
  /** OWN_HOME. */
  readonly home: string
  readonly log: Log.Logger
  readonly clock: Services.Clock
  /** The self-HTTP service (installed registration file or the plugin option `service`). */
  readonly source: ServiceTarget.Source
  /**
   * A remote service's tools folder (06 §4.13, `RemoteEnv.tools`): the controller holds remote mode for its own git
   * calls (`Git.useTools`) as long as it lives. Plugin modules are imported again per Location and the controller runs
   * on the module copy of the instance that created it, so that instance's own `RemoteEnv.enter` ends with its Location
   * while the controller may outlive it.
   */
  readonly tools?: string
  /** Replaces single feature modules (tests). */
  readonly features?: Partial<Services.Factories>
}

/**
 * The feature modules. T2 composes adoption, area reconcile, integration and decision records from their modules
 * here (below), with the triggers that call them: reconcile at start, after an enable and after a team session's run;
 * the integration's follow-ups; a waiting integration tried again when the main wakes (`report/wake.ts`) or a git
 * operation it waited for ended. T3 adds shared folders (`Shared.create`: links again at safe points after runs end)
 * and the reorganization wiring (`reorganizing`: the step kinds, 팀 구성 다시 보기, the 끝낼 수 있음 scan at acquire and
 * daily, the team update after a reorganization, 끝난 영역 정리하고 끄기's turning off), and the integration's first
 * `.assets` confirm (`integrating`).
 */
export const FACTORIES: Services.Factories = {
  main: MainSession.create,
  owner: OwnerSession.create,
  areas: AreaCreate.create,
  safePoint: SafePoint.create,
  rotate: Rotation.create,
  teamContext: TeamContext.create,
  areaMain: AreaMain.create,
  admit: Admit.create,
  pause: Pause.create,
  events: ReportEvents.create,
  digest: Digest.create,
  wake: Wake.create,
  handoff: Handoff.create,
  undo: Undo.create,
  adopt: (services) => ({
    adopt: (input) => Adopt.adoptOp(services, input),
    unadopt: (input) => Adopt.unadoptOp(services, input),
  }),
  reconcile: reconciling,
  integrate: integrating,
  decisions: (services) => ({
    add: (input) => Decisions.add(services, input),
    list: (teamID) => Decisions.list(services, teamID),
  }),
  drift: Drift.create,
  shared: Shared.create,
  reorg: reorganizing,
  heavy: (services) => Heavy.create(services),
  peers: Peers.create,
  seat: Seat.create,
  direct: Direct.create,
  worktreeChat: WorktreeChatFeature.create,
}

/** Recent failures kept per team for `diagnostics.lastErrors`. */
const ERRORS_KEPT = 20

export class Service {
  readonly services: Services.Context
  readonly hub: Hub.Bus
  /** Event ids already forwarded by some instance (`intake.ts`). */
  readonly dedup = new Intake.Dedup()
  readonly #log: Log.Logger
  readonly #instances: Services.Instance[] = []
  readonly #mutexes = new Map<string, Lock.Mutex>()
  readonly #errors = new Map<string, Services.ErrorEntry[]>()
  readonly #started = Promise.withResolvers<void>()
  #ready = false
  /** The controller lock while another process holds it (RH-20, `singleton.ts`). */
  #lock: { readonly holder: { readonly pid: number; readonly buildId: string }; readonly since: number } | undefined
  readonly #intakes = new Map<number, { readonly state: "reading" | "restarting"; readonly restarts: number }>()
  #resuming: Promise<void> = Promise.resolve()
  #next = 1
  #closed = false
  /** Leaves the remote mode this controller holds (`Input.tools`). */
  readonly #leaveTools: () => void

  constructor(input: Input) {
    const log = input.log
    this.#log = log
    this.#leaveTools = input.tools === undefined ? () => {} : Git.useTools(input.tools)
    const kv = Keys.store(() => this.instance()?.ctx.storage)
    const teams = Teams.create(kv, log.child("registry"))
    const registry: Services.Registry = {
      teams,
      areas: Areas.create(kv, teams, log.child("registry")),
      dispatches: Dispatches.create(kv, log.child("registry")),
    }
    const journal = Journal.create(kv, log.child("journal"))
    const steps = new Steps.Registry()
    const hub = new Hub.Bus(log.child("hub"))
    this.hub = hub
    const write = <T>(teamID: string, section: () => Promise<T>) =>
      this.#started.promise.then(() => this.#mutex(teamID).run(section))
    const failed = (teamID: string, entry: Services.ErrorEntry) => {
      this.#errors.set(teamID, [...(this.#errors.get(teamID) ?? []), entry].slice(-ERRORS_KEPT))
      log.warn("team_failure", { teamID, opID: entry.opID, stepID: entry.stepID, message: entry.message })
    }
    const services: Services.Context = {
      buildId: input.buildId,
      home: input.home,
      log,
      clock: input.clock,
      kv,
      registry,
      journal,
      steps,
      runner: new Runner.Engine({
        journal,
        steps,
        hub,
        clock: input.clock,
        log: log.child("runner"),
        write,
        failed,
        services: () => services,
      }),
      hub,
      notices: Notices.create(hub, log.child("notices"), { kv, write }),
      http: SessionHttp.create({ source: input.source }),
      accounts: AccountsRpc.create((directory) => this.instance(directory)?.ctx),
      locate: Locate.create(registry),
      write,
      started: () => this.#ready,
      instance: (directory) => this.instance(directory),
      failed,
      errors: (teamID) => this.#errors.get(teamID) ?? [],
      ready: async (ms) => {
        if (this.#ready) return true
        const waited = Promise.withResolvers<boolean>()
        const cancel = input.clock.schedule(ms, () => waited.resolve(false))
        const ready = await Promise.race([this.#started.promise.then(() => true), waited.promise])
        cancel()
        return ready
      },
      status: {
        controller: () =>
          this.#ready
            ? { state: "running" }
            : this.#lock
              ? { state: "lock", holder: this.#lock.holder, since: this.#lock.since }
              : { state: "starting" },
        intake: () => {
          const all = [...this.#intakes.values()]
          if (all.length === 0) return undefined
          return {
            state: all.some((item) => item.state === "restarting") ? "restarting" : "reading",
            restarts: all.reduce((sum, item) => sum + item.restarts, 0),
          }
        },
        setIntake: (id, state) => {
          if (state === undefined) this.#intakes.delete(id)
          else this.#intakes.set(id, state)
        },
      },
      features: () => features,
    }
    const factories = { ...FACTORIES, ...input.features }
    const features: Services.Features = {
      main: factories.main(services),
      owner: factories.owner(services),
      areas: factories.areas(services),
      safePoint: factories.safePoint(services),
      rotate: factories.rotate(services),
      teamContext: factories.teamContext(services),
      areaMain: factories.areaMain(services),
      admit: factories.admit(services),
      pause: factories.pause(services),
      events: factories.events(services),
      digest: factories.digest(services),
      wake: factories.wake(services),
      handoff: factories.handoff(services),
      undo: factories.undo(services),
      adopt: factories.adopt(services),
      reconcile: factories.reconcile(services),
      integrate: factories.integrate(services),
      decisions: factories.decisions(services),
      drift: factories.drift(services),
      shared: factories.shared(services),
      reorg: factories.reorg(services),
      heavy: factories.heavy(services),
      peers: factories.peers(services),
      seat: factories.seat(services),
      direct: factories.direct(services),
      worktreeChat: factories.worktreeChat(services),
    }
    this.services = services
  }

  /** Another live process holds the controller lock (RH-20): `health` and `team_status` say so. */
  waitingForLock(holder: { readonly pid: number; readonly buildId: string } | undefined) {
    this.#lock = holder === undefined ? undefined : { holder, since: this.#lock?.since ?? Date.now() }
  }

  /**
   * Called once this controller holds the controller lock: writes may start, and the first resume runs. The start
   * reconcile reads the teams first, before any write section runs (06 §8.8).
   */
  start() {
    this.#lock = undefined
    this.#ready = true
    this.#log.info("controller_started", { buildId: this.services.buildId })
    void this.services.features().reconcile.start()
    this.#started.resolve()
    void this.resume()
  }

  /** A plugin instance joins; returns the function that removes it. Every attach resumes (06 §2.6). */
  attach(input: Omit<Services.Instance, "id">) {
    const instance: Services.Instance = { ...input, id: this.#next++ }
    this.#instances.push(instance)
    void this.resume()
    return () => {
      const index = this.#instances.indexOf(instance)
      if (index >= 0) this.#instances.splice(index, 1)
      this.#intakes.delete(instance.id)
    }
  }

  /** The id `attach` gave the instance at `directory` last (its event stream reports under it). */
  instanceID(directory: string) {
    return this.#instances.findLast((item) => Identity.same(item.directory, directory))?.id
  }

  /** A live instance: the one at `directory` when alive, else the control location's, else the leader, else any. */
  instance(directory?: string): Services.Instance | undefined {
    const live = this.#instances
    const here = directory === undefined ? undefined : live.find((item) => Identity.same(item.directory, directory))
    return here ?? live.find((item) => item.control) ?? live.find((item) => item.leader()) ?? live[0]
  }

  /**
   * Continues interrupted work once the lock is held and an instance is alive: starts the running ops again (06 §8.5,
   * not awaited), then every feature's `resume` (catch-up, timers, waiting requests). Runs one at a time; each request
   * runs once more after the one in progress.
   */
  resume() {
    this.#resuming = this.#resuming
      .then(async () => {
        await this.#started.promise
        if (this.#closed || !this.instance()) return
        await this.services.runner.resume()
        await Promise.all(
          Object.entries(this.services.features()).map(([name, feature]) =>
            feature.resume?.().catch((error: unknown) => this.#log.warn("feature_resume_failed", { name, error })),
          ),
        )
      })
      .catch((error: unknown) => this.#log.warn("resume_failed", { error }))
    return this.#resuming
  }

  async close() {
    this.#closed = true
    this.#log.info("controller_closed", { buildId: this.services.buildId })
    this.services.runner.close()
    await Promise.all(
      Object.entries(this.services.features()).map(([name, feature]) =>
        feature.close?.().catch((error: unknown) => this.#log.warn("feature_close_failed", { name, error })),
      ),
    )
    this.hub.clear()
    this.#leaveTools()
  }

  #mutex(teamID: string) {
    const existing = this.#mutexes.get(teamID)
    if (existing) return existing
    const created = new Lock.Mutex()
    this.#mutexes.set(teamID, created)
    return created
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Area reconcile (06 §8.8)

/** A team session's run ended: its area may be at a safe point now (8.8 "안전 지점마다"). */
const RUN_ENDS: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

/**
 * Reconcile runs once when the controller starts (every team that is on then, `start`), after an `enable` op ends, and
 * after an owner's run ends. A team's runs never overlap: a trigger while one runs makes one more run after it, however many
 * came. The module keeps its `reconcile-move` kind in a registry of its own until `register` adds it to the
 * controller's (see `Services.Reconcile`).
 */
function reconciling(services: Services.Context): Services.Reconcile {
  const kinds = new Steps.Registry()
  const service = Reconcile.create({ ...services, steps: kinds })
  const running = new Map<string, Promise<void>>()
  const again = new Map<string, Services.ReconcileTrigger>()
  const state: { closed: boolean; start?: Promise<void> } = { closed: false }

  const run = (teamID: OwnTeam.TeamID, trigger: Services.ReconcileTrigger): Promise<void> => {
    if (state.closed) return Promise.resolve()
    const current = running.get(teamID)
    if (current) {
      again.set(teamID, trigger)
      return current
    }
    const started = service
      .run({ id: teamID }, { trigger })
      .then(
        () => undefined,
        (error: unknown) => services.log.warn("reconcile_failed", { teamID, trigger, error }),
      )
      .finally(() => {
        running.delete(teamID)
        const next = again.get(teamID)
        again.delete(teamID)
        if (next !== undefined) void run(teamID, next)
      })
    running.set(teamID, started)
    return started
  }

  const stopRuns = services.hub.on(async (event) => {
    if (!RUN_ENDS.has(event.type) || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const found = await services.locate.session(event.data.sessionID)
    // A peer's run ends in the area's folder too (동료).
    if ((found?.role !== "owner" && found?.role !== "peer") || found.team.state !== "on") return
    await run(found.team.id, "safe-point")
  })
  const stopOps = services.hub.subscribe((event) => {
    if (event.name !== "op.done" || (event.data.state !== "done" && event.data.state !== "waiting")) return
    void services.journal
      .find(event.data.opID)
      .then((op) => (op?.kind === "enable" ? run(op.teamID, "enable") : undefined))
      .catch((error: unknown) => services.log.warn("reconcile_trigger_failed", { error }))
  })

  return {
    run: (input) => run(input.teamID, input.trigger),
    register: () => {
      const move = kinds.get(Reconcile.MOVE)
      if (move && !services.steps.get(move.kind)) services.steps.register(move)
    },
    start: () => {
      // The KV read starts here, synchronously: what is there before the controller's first write.
      state.start ??= services.registry.teams
        .list()
        .then((teams) => Promise.all(teams.filter((team) => team.state === "on").map((team) => run(team.id, "start"))))
        .then(
          () => undefined,
          (error: unknown) => services.log.warn("reconcile_start_failed", { error }),
        )
      return state.start
    },
    close: async () => {
      state.closed = true
      stopRuns()
      stopOps()
      again.clear()
      // A run's git commands end within their timeouts; nothing of it outlives the controller.
      await Promise.all(running.values())
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Integration (06 §7)

/**
 * How often an integration that waits for a git operation in progress (a rebase from the target) or for the folder with
 * the target checked out to reach its safe point (`in-use`) looks again.
 */
export const RECHECK_MS = 30_000

/** The waits {@link RECHECK_MS} looks at again on its own; the others need a change only the user or an owner makes. */
const RECHECKED: ReadonlyArray<string> = ["in-progress", "in-use"]

/**
 * Integration over `integrate/*.ts`: one op of steps 0-7 (`IntegrateOp`) then 8-9 (`Advance`), at most one per team.
 * After the target advanced, the team update gets the `반영함` line, and at the area's safe point the cone follows the
 * new HEAD (4.8) and the link copies are applied again (4.12); the fetched heavy folders go later (4.7, an op of their
 * own). An integration that ends `done` takes the area's candidate and `반영 준비됨` away (`ReportEvents.integrated`);
 * one that is undone gets its `반영 되돌림` line. A waiting integration ended its op; it is tried again by
 * `area.integrate`, when the main wakes, and every {@link RECHECK_MS} once its wait is over: a git operation in progress
 * whose marker is gone, or a folder in use that reached its safe point. The last matters for the main's own call: the
 * main is still running when its `team_integrate` reaches step 8, so the home is in use until that turn ends, and a
 * retry when the main wakes meets the same running main (live team test, 2026-10-14). An undo that waits outside its
 * op (7.4, `Integration.undoing`) goes before all of them (RH-31, `IntegrateOp.undoWaits`): its reset to B would take
 * out an integration that landed meanwhile.
 *
 * The first `.assets` (4.10, 0.3): when the asset check will run, the folder is not there yet and making it reaches
 * `askDiskBytes` or `askDownloadBytes`, step 7 has to ask. A confirm step does not hold back the auto steps after it,
 * so such an integration runs steps 0-6 in an op of their own; when that op ended, {@link onward} goes on in the next
 * op: step 7 as a confirm (asked again with the real K) or as an auto step with steps 8-9, then steps 8-9 after a
 * confirmed check, or the integration ends `failed` (`assets`) when the user answered 두기. It goes on whenever the
 * team's op ends and on resume, so neither a restart nor another op in between loses the integration.
 */
function integrating(services: Services.Context): Services.Integrate {
  const log = services.log.child("integrate")
  const push = Push.defaults()
  const safePoint = Advance.safePoint(services)
  const deps: Advance.Deps = {
    safePoint,
    restart: (input) => IntegrateOp.restart(services, input),
    onAdvanced: (input) => advanced(services, input),
  }
  const register = () => {
    IntegrateOp.register(services)
    Advance.register(services, deps)
    IntegrateUndo.register(services, { safePoint })
    Push.register(services, push)
  }
  /** Rechecks of integrations that wait for a git operation in progress or a folder in use, by integration id. */
  const polls = new Map<string, () => void>()
  /** What held the folder of each `in-use` integration at its last look (`free`), logged when it changes. */
  const holders = new Map<string, string>()
  const state = { closed: false }

  /** Steps 8-9 again for a waiting integration (7.2 기다림과 다시 시도); an undo that waits goes first (RH-31). */
  const again = async (team: OwnTeam.Team, integration: OwnTeam.Integration, by: OwnTeam.Op["by"]) => {
    const undo = await IntegrateOp.undoWaits(services, team.id, integration.target)
    if (undo) return undo
    register()
    const started = await services.runner.start({
      teamID: team.id,
      kind: "integrate",
      by,
      areaID: integration.areaID,
      undo: { available: false },
      steps: Advance.steps({ integrationID: integration.id, mergeLocal: team.policy.mergeLocal }),
    })
    if (!started.ok) return busy(started.op)
    return { ok: true as const, opID: started.op.id, integrationID: integration.id }
  }

  const retry = async (teamID: OwnTeam.TeamID) => {
    const team = await services.registry.teams.get(teamID)
    if (!team || team.state !== "on") return
    const areas = await services.registry.areas.list(team.id)
    const waiting = (await IntegrateOp.list(services, team.id)).filter(
      (item) => item.state === "waiting" && !held(areas, item),
    )
    await Promise.all(
      waiting.map(async (item) => {
        const started = await again(team, item, "auto")
        if (!started.ok) log.info("integrate_retry_busy", { teamID, integrationID: item.id })
      }),
    )
  }

  const watch = (integration: OwnTeam.Integration) => {
    if (state.closed || polls.has(integration.id)) return
    const undoing = integration.state === "done" && integration.undoing !== undefined
    if (!undoing && (integration.state !== "waiting" || !RECHECKED.includes(integration.waiting?.why ?? ""))) return
    polls.set(
      integration.id,
      services.clock.schedule(RECHECK_MS, () => {
        polls.delete(integration.id)
        void recheck(integration).catch((error: unknown) =>
          log.warn("integrate_recheck_failed", { integrationID: integration.id, error }),
        )
      }),
    )
  }

  const recheck = async (stale: OwnTeam.Integration) => {
    const [team, integration] = await Promise.all([
      services.registry.teams.get(stale.teamID),
      IntegrateOp.get(services, stale.teamID, stale.id),
    ])
    if (!team || team.state !== "on" || !integration) return
    if (integration.state === "done" && integration.undoing !== undefined) return undoAgain(team, integration)
    if (integration.state !== "waiting") return
    const why = integration.waiting?.why
    if (why === "in-progress" && (await inProgress(team, integration))) return watch(integration)
    // Asked without an op, so a folder in use for long (a main or a user working there) adds no op every 30 s.
    if (why === "in-use" && !(await free(team, integration))) return watch(integration)
    if (why !== "in-progress" && why !== "in-use") return
    // Held by direct work: the hand-back tries it again (`Direct.end`).
    if (held(await services.registry.areas.list(team.id), integration)) return
    const started = await again(team, integration, "auto")
    // Another op of the team runs: look again later.
    if (!started.ok) watch(integration)
  }

  /**
   * RH-20: an undo that waits outside its op (`Integration.undoing`) runs again once `IntegrateUndo.waits` finds nothing
   * to wait for (asked without an op, so a long wait adds no op every 30 s); one that can no longer run (the target
   * moved on) ends its wait, and the main reads why.
   */
  const undoAgain = async (team: OwnTeam.Team, integration: OwnTeam.Integration) => {
    const undoing = integration.undoing
    if (!undoing) return
    register()
    const waiting = await IntegrateUndo.waits(services, { team, integration })
    if (waiting) {
      const { since: _since, by: _by, ...was } = undoing
      if (JSON.stringify(was) !== JSON.stringify(waiting)) {
        const updated = await IntegrateOp.update(services, team.id, integration.id, (current) =>
          current.undoing
            ? { ...current, undoing: { since: current.undoing.since, by: current.undoing.by, ...waiting } }
            : undefined,
        )
        // 되돌리기 취소 dropped `undoing` since this look read it (RH-42): its notice is closed, nothing waits any more.
        if (updated?.undoing === undefined) return
        await Advance.announce(services, team, updated, waiting, "undo")
      }
      return watch(integration)
    }
    const started = await IntegrateUndo.again(services, { integration, by: undoing.by, waited: true })
    if (started.ok) return log.info("integrate_undo_again", { integrationID: integration.id, opID: started.opID })
    if (started.error === "busy") return watch(integration)
    await IntegrateOp.update(services, team.id, integration.id, (current) =>
      current.undoing ? IntegrateUndo.withoutUndoing(current) : undefined,
    )
    await Advance.announce(services, team, integration, undefined, "undo")
    const area = await services.registry.areas.get(team.id, integration.areaID)
    await services.features().digest.add(
      team.id,
      Fold.entry({
        at: services.clock.now(),
        reason: "integrated",
        areaID: integration.areaID,
        text: `${area?.name ?? integration.areaID}: 반영 되돌리기를 하지 못했습니다 · ${started.message}`,
      }),
    )
  }

  /**
   * Whether the folder an `in-use` integration waits for is at its safe point now (the check step 8 makes). What holds
   * it (the safe point's `why` and its sessions) is logged when it changes, so a wait that never ends names its holder
   * without a line every {@link RECHECK_MS}.
   */
  const free = async (team: OwnTeam.Team, integration: OwnTeam.Integration) => {
    const directory = integration.waiting?.directory
    if (directory === undefined) return true
    const place = await services.locate.directory(directory)
    const safe = await safePoint({ teamID: team.id, ...(place?.area ? { areaID: place.area.id } : {}), directory })
    if (safe.ok) {
      holders.delete(integration.id)
      return true
    }
    const holder = `${safe.why}:${safe.sessionIDs.join(",")}`
    if (holder !== holders.get(integration.id))
      log.info("integrate_still_in_use", { integrationID: integration.id, directory, holder })
    holders.set(integration.id, holder)
    return false
  }

  const changed = async (data: Hub.Body<"integration.changed">) => {
    const integration = await IntegrateOp.get(services, data.teamID, data.integrationID)
    if (!integration || integration.state !== data.state) return
    if (integration.state === "waiting") return watch(integration)
    if (integration.state === "done" && integration.undoing !== undefined) return watch(integration)
    if (integration.state === "done") {
      await ReportEvents.integrated(services, {
        teamID: integration.teamID,
        areaID: integration.areaID,
        source: integration.source,
      })
      // Watches on the area for its integration (06 §5.8); failures are logged there.
      return Talk.fire(services, { teamID: integration.teamID, areaID: integration.areaID, on: "integrated" })
    }
    if (integration.state !== "undone") return
    const area = await services.registry.areas.get(integration.teamID, integration.areaID)
    const line = OwnTeamText.integrationLine({ area: area?.name ?? integration.areaID, state: "undone" })
    await services
      .features()
      .digest.add(
        integration.teamID,
        Fold.entry({ at: services.clock.now(), reason: "integrated", text: line.replace(/^- /, "") }),
      )
  }
  const stop = services.hub.subscribe((event) => {
    if (event.name === "op.done" && pending.has(event.data.teamID))
      void onward(event.data.teamID).catch((error: unknown) =>
        log.warn("integrate_onward_failed", { teamID: event.data.teamID, error }),
      )
    if (event.name !== "integration.changed") return
    void changed(event.data).catch((error: unknown) =>
      log.warn("integration_changed_failed", { integrationID: event.data.integrationID, error }),
    )
  })

  /** Teams with a running integration that may need its next op: only their ops' ends are looked at. */
  const pending = new Set<string>()
  /** One continuation per team at a time; calls meanwhile make it look once more. */
  const following = new Map<string, Promise<void>>()
  const more = new Set<string>()
  const onward = (teamID: OwnTeam.TeamID): Promise<void> => {
    const running = following.get(teamID)
    if (running) {
      more.add(teamID)
      return running
    }
    const run = (async () => {
      do {
        more.delete(teamID)
        await next(teamID)
      } while (more.has(teamID))
    })().finally(() => following.delete(teamID))
    following.set(teamID, run)
    return run
  }

  /** The next op of an integration whose steps 0-6 ran in an op of their own (see the function's comment). */
  const next = async (teamID: OwnTeam.TeamID) => {
    if (state.closed) return
    const team = await services.registry.teams.get(teamID)
    const running =
      team?.state === "on" ? (await IntegrateOp.list(services, team.id)).filter((item) => item.state === "running") : []
    if (!team || running.length === 0) {
      pending.delete(teamID)
      return
    }
    pending.add(teamID)
    if (await services.journal.active(team.id)) return
    const ops = await services.journal.list(team.id)
    for (const integration of running) {
      const last = ops.findLast(
        (op) => op.kind === "integrate" && op.steps.some((step) => step.args?.integrationID === integration.id),
      )
      if (last?.state !== "done") continue
      const asked = last.steps.find((step) => step.kind === IntegrateOp.KIND.assets)
      const advance = Advance.steps({ integrationID: integration.id, mergeLocal: team.policy.mergeLocal })
      const steps = await (async () => {
        if (last.steps.some((step) => step.kind === Advance.STEP)) return undefined
        if (!asked) return assetsStep(team, integration, advance)
        if (asked.mode !== "confirm") return undefined
        if (asked.state === "skipped") {
          await declined(team, integration)
          return undefined
        }
        const assets = integration.verify.assets
        return assets === "skipped" || assets?.ok === true ? advance : undefined
      })()
      if (!steps) continue
      // RH-31: an undo that waits for the target's folder goes first; the end of its op looks again.
      if (await IntegrateOp.undoWaits(services, team.id, integration.target)) return
      register()
      const started = await services.runner.start({
        teamID: team.id,
        kind: "integrate",
        by: last.by,
        areaID: integration.areaID,
        undo: { available: false },
        steps,
      })
      // Another op began meanwhile: its end looks again.
      if (!started.ok) return
      log.info("integrate_onward", { integrationID: integration.id, opID: started.op.id })
      return
    }
  }

  /** Step 7 after steps 0-6 ran alone: asked when making `.assets` still needs the user, else with steps 8-9. */
  const assetsStep = async (
    team: OwnTeam.Team,
    integration: OwnTeam.Integration,
    advance: ReadonlyArray<Steps.Spec>,
  ): Promise<ReadonlyArray<Steps.Spec> | undefined> => {
    // Steps 0-6 did not record K: nothing goes on (the record's state says why, or a later op does).
    if (integration.base === undefined || integration.candidate === undefined) return undefined
    const area = await services.registry.areas.get(team.id, integration.areaID)
    if (!area) return undefined
    const args = { integrationID: integration.id, areaID: integration.areaID }
    const ask = await asks(team, area, {
      source: integration.source,
      base: integration.base,
      candidate: integration.candidate,
    })
    if (ask) return [{ id: "assets", kind: IntegrateOp.KIND.assets, mode: "confirm", args }]
    return [{ id: "assets", kind: IntegrateOp.KIND.assets, args }, ...advance]
  }

  /** The user answered 두기 to making `.assets`: the integration stops (`assets`) and the main reads why. */
  const declined = async (team: OwnTeam.Team, integration: OwnTeam.Integration) => {
    // The markers go first (7.2: an integration that stops leaves no `refs/own/integrate`), then the record ends.
    await Advance.clearMarkers(team.commonDir, integration.id)
    const ended = await IntegrateOp.update(services, team.id, integration.id, (current) =>
      current.state === "running" ? { ...current, state: "failed", failure: "assets", checks: undefined } : undefined,
    )
    if (ended?.state !== "failed" || ended.failure !== "assets") return
    const area = await services.registry.areas.get(team.id, integration.areaID)
    const line = OwnTeamText.integrationLine({
      area: area?.name ?? integration.areaID,
      state: "failed",
      detail: DECLINED,
    })
    // The user decided: the main reads it in the next team update and is not woken for it.
    await services.features().digest.add(team.id, {
      ...Fold.entry({ at: services.clock.now(), reason: "integration-failed", text: line.replace(/^- /, "") }),
      wake: false,
    })
  }

  /**
   * Whether step 7 has to ask before it runs (4.10, 0.3): the check runs for this candidate, `.assets` is not there,
   * and making it reaches the team's limits. Unsure (git cannot answer) counts as yes: the next op asks with the
   * real K.
   */
  const asks = async (
    team: OwnTeam.Team,
    area: OwnTeam.Area,
    input: { readonly source: string; readonly base: string; readonly candidate: string },
  ) => {
    if (team.heavy.dirs.length === 0 || team.commands.assets.length === 0) return false
    if (fs.existsSync(AssetsVerify.directory(team))) return false
    const needed = await AssetsVerify.needed({ team, area, ...input })
    if (!needed.ok) return true
    if (!needed.needed) return false
    const creation = await AssetsVerify.creation(team, input.candidate)
    return !creation.ok || creation.confirm
  }

  /** Steps 0-7 and 8-9 in one op, or steps 0-6 alone when step 7 will have to ask (see the function's comment). */
  const first = async (team: OwnTeam.Team, areaID: OwnTeam.AreaID, planned: IntegrateOp.Planned) => {
    const advance = Advance.steps({ integrationID: planned.integrationID, mergeLocal: team.policy.mergeLocal })
    const area = await services.registry.areas.get(team.id, areaID)
    const checks = team.heavy.dirs.length > 0 && team.commands.assets.length > 0
    if (!area || !checks || fs.existsSync(AssetsVerify.directory(team))) return [...planned.steps, ...advance]
    // K is not known before step 4: the prediction takes the candidate and where it leaves the target.
    const base = await Git.run(["merge-base", `refs/heads/${team.target}`, planned.source], {
      cwd: team.commonDir,
      worktree: true,
    })
    const ask =
      !base.ok ||
      (await asks(team, area, { source: planned.source, base: base.stdout.trim(), candidate: planned.source }))
    if (ask) return planned.steps.filter((step) => step.kind !== IntegrateOp.KIND.assets)
    return [...planned.steps, ...advance]
  }

  return {
    start: async (input) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return Services.failure("not_found", "팀을 찾지 못했습니다", { what: "team", id: input.teamID })
      if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있습니다", { teamID: team.id })
      // An integration whose next op is still to start goes first: it holds the team (`busy` below) like any op.
      await onward(team.id)
      const waiting = (await IntegrateOp.list(services, team.id)).find(
        (item) => item.state === "waiting" && item.areaID === input.areaID,
      )
      if (waiting) {
        if (input.source !== undefined && waiting.source !== input.source)
          return Services.failure("conflict", "another integration of the area waits", {
            ref: waiting.target,
            expected: input.source,
            actual: waiting.source,
          })
        return again(team, waiting, input.by)
      }
      const planned = await IntegrateOp.plan(services, {
        teamID: team.id,
        areaID: input.areaID,
        tip: input.tip,
        ...(input.source === undefined ? {} : { source: input.source }),
      })
      if (!planned.ok) return planned
      register()
      const started = await services.runner.start({
        teamID: team.id,
        kind: "integrate",
        by: input.by,
        areaID: input.areaID,
        undo: { available: false },
        steps: await first(team, input.areaID, planned),
      })
      if (!started.ok) return busy(started.op)
      // Steps 0-6 alone: their op's end starts the next one.
      if (!started.op.steps.some((step) => step.kind === Advance.STEP)) pending.add(team.id)
      return { ok: true, opID: started.op.id, integrationID: planned.integrationID }
    },
    retry,
    undo: (input) => {
      register()
      return IntegrateUndo.start(services, input)
    },
    undoCancel: async (input) => {
      const cancelled = await IntegrateUndo.cancel(services, input.integrationID)
      if (!cancelled.ok) return cancelled
      const integration = cancelled.integration
      log.info("integrate_undo_cancelled", { integrationID: integration.id })
      const area = await services.registry.areas.get(integration.teamID, integration.areaID)
      // The user decided: the main reads it in the next team update and is not woken for it.
      await services.features().digest.add(integration.teamID, {
        ...Fold.entry({
          at: services.clock.now(),
          reason: "integrated",
          areaID: integration.areaID,
          text: `${area?.name ?? integration.areaID}: 사용자가 기다리던 반영 되돌리기를 취소했습니다`,
        }),
        wake: false,
      })
      // RH-31's hold ends: the integrations into the same target that waited for the undo go on now.
      void Promise.all([retry(integration.teamID), onward(integration.teamID)]).catch((error: unknown) =>
        log.warn("integrate_after_undo_cancel_failed", { integrationID: integration.id, error }),
      )
      return cancelled
    },
    plan: (input) => Push.plan(services, push, input),
    push: (input) => {
      register()
      return Push.execute(services, input)
    },
    register,
    resume: async () => {
      const teams = (await services.registry.teams.list()).filter((team) => team.state === "on")
      const records = await Promise.all(teams.map((team) => IntegrateOp.list(services, team.id)))
      records.flat().forEach(watch)
      // An integration whose next op had not started when the last controller stopped goes on now.
      await Promise.all(teams.map((team) => onward(team.id)))
    },
    close: async () => {
      state.closed = true
      polls.forEach((cancel) => cancel())
      polls.clear()
      stop()
    },
  }
}

/** The integration line's detail when the user answered 두기 to making `.assets` (4.10, 0.3). */
export const DECLINED = "큰 파일 검사 폴더를 만들지 않아 큰 파일 검사를 하지 못했습니다"

/** The target advanced and the area sync ran (7.2 step 9): the team update line, cone drift, link copies, release. */
async function advanced(services: Services.Context, input: Parameters<Advance.Deps["onAdvanced"]>[0]) {
  const team = input.team
  const area = input.area
  const integration = input.integration
  const skipped = integration.newerSkipped ?? 0
  const line = OwnTeamText.integrationLine({
    area: area?.name ?? integration.areaID,
    state: "done",
    detail: [
      `${integration.target} ${integration.candidate?.slice(0, 7) ?? ""}`.trim(),
      ...(skipped > 0 ? [`그 뒤 저장 지점 ${skipped}개는 넣지 않았습니다`] : []),
    ].join(" · "),
  })
  // Another area's reported work still waits to go in: the line wakes the main. The team integrates one area at a
  // time, so the main's call for that area met `busy` while this one ran, and nothing else would tell it this one is
  // in (`integrated` alone never wakes, 5.6; live team test, 2026-10-14).
  const next = (await services.registry.areas.list(team.id)).some(
    (item) => item.id !== integration.areaID && item.state === "active" && item.candidate !== undefined,
  )
  // The main started this one and was told the checks and the result come with its next team update
  // (tools/integrate.ts STARTED): the last one of its batch wakes it too, or it never says that the area went in
  // (real-host phase E, 2026-10-18). One integrated by the user's card or an owner does not.
  const byMain = (await services.journal.list(team.id)).some(
    (op) =>
      op.kind === "integrate" &&
      op.by === "main" &&
      op.steps.some((step) => step.args.integrationID === integration.id),
  )
  // A team note is written `- <text>`: the shared integration line, which own-web counts (`OwnTeamText.countOf`).
  const entry = Fold.entry({ at: services.clock.now(), reason: "integrated", text: line.replace(/^- /, "") })
  await services.features().digest.add(team.id, next || byMain ? { ...entry, wake: true } : entry)
  if (!area || area.state !== "active") return
  const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id })
  if (safe.ok) {
    const drifted = await services.features().drift.check({ teamID: team.id, areaID: area.id })
    if (!drifted.ok) services.log.warn("integrate_drift_failed", { areaID: area.id, error: drifted.error })
    // 4.12 "링크 대상이 바뀌는 동기화 뒤에는 다시 적용한다": a changed copy is kept, never overwritten.
    const relinked = await Symlinks.refresh(services, { teamID: team.id, areaID: area.id })
    if (!relinked.ok) services.log.warn("integrate_relink_failed", { areaID: area.id, message: relinked.message })
  }
  const released = await Release.afterIntegrate(services, { teamID: team.id, areaID: area.id })
  services.log.info("integrate_release", { areaID: area.id, state: released.state })
}

// ---------------------------------------------------------------------------------------------------------------
// Reorganization (06 §8, §3.8 끝난 영역 정리하고 끄기)

/** How long git's facts of 끝낼 수 있음 are used before they are read again (8.1: 7 quiet days; a day is fine enough). */
export const RETIRE_SCAN_MS = 24 * 60 * 60 * 1000

/** Ops whose skipped actions and unsent main requests the main is told of (the cleanup op turns the team off). */
const TOLD: ReadonlySet<OwnTeam.OpKind> = new Set(["reorg", "retire"])

/**
 * The reorganization wiring: `register` adds the kinds of `reorg/*` (끝내기's removal with `Shared.unlink` for own's
 * shared-folder links, 4.11) and `lfs-remote`, once; `propose` is 팀 구성 다시 보기 (8.1). Its duties:
 *
 *   끝낼 수 있음  git's facts of a team's active areas (`Retire.facts`) are read by the first `team.get` after the
 *                 controller started and again once they are a day old ({@link RETIRE_SCAN_MS}); the signal
 *                 (`Retire.retirable`) takes the area record and the clock of the moment (8.1). No timer and nothing in
 *                 the background: an idle controller reads no area folder
 *   team update   a reorganization or 끝내기 that ended, or waits for its confirms, adds what no step told the main: the
 *                 actions skipped for their area (Main 멈춤, work, broken) and the main requests it did not send
 *                 (5.6: folded, no wake)
 *   cleanup       끝난 영역 정리하고 끄기 turns the team off once its retirements ended (`Disable.after`), also after a
 *                 restart (`Disable.resume`)
 */
function reorganizing(services: Services.Context): Services.Reorg {
  const log = services.log.child("reorg")
  const register = () => {
    Retire.register(services, { unlink: (link) => unlinkShared(services, link) })
    AreaSplit.register(services)
    AreaMerge.register(services)
    Convert.register(services)
    Rehome.register(services)
    RemoteLfs.register(services)
  }
  /** git's facts of each team's active areas and when they were read. */
  const facts = new Map<OwnTeam.TeamID, { readonly at: number; readonly areas: ReadonlyMap<string, Retire.Facts> }>()
  /** One read per team at a time. */
  const reading = new Map<OwnTeam.TeamID, Promise<ReadonlyMap<string, Retire.Facts>>>()
  /** Ops whose team update was added (a restart may add one again only while the main was not told yet). */
  const told = new Set<string>()
  const state = { closed: false }

  const read = async (team: OwnTeam.Team) => {
    const areas = (await services.registry.areas.list(team.id)).filter((area) => area.state === "active")
    const now = services.clock.now()
    const found = await Promise.all(
      areas.map(async (area) => ({ areaID: area.id, found: await Retire.facts({ team, area, now }) })),
    )
    const known = new Map(found.flatMap((item) => (item.found ? [[item.areaID, item.found] as const] : [])))
    facts.set(team.id, { at: now, areas: known })
    return known
  }
  /** The team's facts: the last read while it is less than a day old, else a new one. */
  const current = (team: OwnTeam.Team) => {
    const known = facts.get(team.id)
    if (known && services.clock.now() - known.at < RETIRE_SCAN_MS) return Promise.resolve(known.areas)
    const running = reading.get(team.id)
    if (running) return running
    const run = read(team).finally(() => reading.delete(team.id))
    reading.set(team.id, run)
    return run
  }

  const ended = async (data: Hub.Body<"op.done">) => {
    const op = await services.journal.get(data.teamID, data.opID)
    if (!op) return
    if (Disable.cleaning(op)) await Disable.after(services, op)
    if (!TOLD.has(op.kind) || told.has(op.id) || answered(op)) return
    told.add(op.id)
    await tell(services, op)
  }
  const stop = services.hub.subscribe((event) => {
    if (event.name !== "op.done" || state.closed) return
    void ended(event.data).catch((error: unknown) => log.warn("reorg_ended_failed", { opID: event.data.opID, error }))
  })

  return {
    register,
    propose: (input) => {
      register()
      return ReorgPropose.propose(services, input)
    },
    retirable: async (teamID) => {
      const team = await services.registry.teams.get(teamID)
      if (!team || team.state !== "on" || state.closed) return new Map()
      const known = await current(team)
      const areas = await services.registry.areas.list(teamID)
      const now = services.clock.now()
      return new Map(
        areas.flatMap((area) => {
          const found = known.get(area.id)
          if (!found || !Retire.retirable(area, { ...found, now })) return []
          return [[area.id, Math.max(found.changedAt, area.status.at, Direct.touched(area))] as const]
        }),
      )
    },
    resume: () => Disable.resume(services),
    close: async () => {
      state.closed = true
      stop()
      await Promise.all(reading.values())
    },
  }
}

/** The user answered one of the op's confirms: its team update went out when it first ended or waited. */
function answered(op: OwnTeam.Op) {
  return op.steps.some((step) => step.mode === "confirm" && (step.state === "done" || step.state === "skipped"))
}

/** The team update lines of a reorganization that ended or waits (`Digest.reorganized`), as team notes. */
async function tell(services: Services.Context, op: OwnTeam.Op) {
  const lines = op.summary?.lines ?? []
  const areas = await services.registry.areas.list(op.teamID)
  const name = (areaID: OwnTeam.AreaID) => areas.find((area) => area.id === areaID)?.name ?? areaID.slice("ar_".length)
  const cancelled = await Promise.all(
    lines.flatMap((line) =>
      line.kind === "cancelled"
        ? [
            services.registry.dispatches
              .find(op.teamID, line.dispatchID)
              .then((record) => ({ area: name(line.areaID), text: record?.task ?? record?.text ?? "" })),
          ]
        : [],
    ),
  )
  const skipped = lines.flatMap((line) =>
    line.kind === "skipped" && line.areaID !== undefined && Digest.SKIPPED.has(line.why)
      ? [{ area: name(line.areaID), why: line.why }]
      : [],
  )
  const at = services.clock.now()
  for (const text of Digest.reorganized({ skipped, cancelled }))
    await services.features().digest.add(op.teamID, Fold.entry({ at, reason: "reorganized", text }))
}

/** `Remove.Unlink` through `Shared.unlink`: own's link to the recorded original only, never followed (06 §4.11). */
async function unlinkShared(services: Services.Context, link: { readonly directory: string; readonly name: string }) {
  const team = await services.locate.team(link.directory)
  const shared = (team?.shared ?? []).filter((record) => record.name === link.name)
  const unlinked = await services.features().shared.unlink({ directory: link.directory, shared })
  if (!unlinked.ok) services.log.warn("shared_unlink_failed", { directory: link.directory, message: unlinked.message })
}

/** The target is still used by a git operation: a rebase or bisect from it, or one stopped in the folder that has it. */
async function inProgress(team: OwnTeam.Team, integration: OwnTeam.Integration) {
  const used = await Inventory.branchInUse(team.commonDir, integration.target)
  if (!used.ok) return true
  return used.users.some(
    (use) => use.how !== "checkout" || (use.gitDir !== null && Inventory.operations(use.gitDir).length > 0),
  )
}

function busy(op: OwnTeam.Op) {
  return Services.failure("busy", "이 팀에서 다른 작업이 진행 중입니다", Journal.busy(op))
}

/**
 * 직접 작업 (2026-11-14): a waiting integration started before the user began working with its area directly waits
 * for the hand-back, which tries it again (`Direct.end`); one the user started during the stretch goes as usual.
 */
function held(areas: ReadonlyArray<OwnTeam.Area>, integration: OwnTeam.Integration) {
  const area = areas.find((item) => item.id === integration.areaID)
  return area !== undefined && Direct.live(area) && integration.createdAt < (area.directWork?.since ?? 0)
}
