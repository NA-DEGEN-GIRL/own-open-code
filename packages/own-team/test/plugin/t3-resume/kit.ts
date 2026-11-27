// The kit of TI-11 at every step (06 §8.3, §8.5; TG12 "resume at every step"): an op stopped right after one step's
// effect, before its result was written, is continued by the next controller (a new acquire over the same KV and
// folders), which observes that step again and goes on. Every step in turn is the one whose result is lost; each run
// ends as an uninterrupted op would, with no ref, owner conversation, team message, worktree or asset run made twice.
// Fake plugin contexts over one world, the real runtime on temp OWN_HOMEs, a manual clock, real git fixtures in temp
// folders and a fake own service on 127.0.0.1; fake values only.
//
// One test per (op, step), and the ops in several files (`t3-resume-*.test.ts`): each run is independent, so
// `--parallel` spreads them. As one file of one test per op it took 23 min on a loaded PC (2026-10-29, test-speed).

import { expect, onTestFinished, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Controller } from "../../../src/controller.js"
import { Worktree } from "../../../src/git/worktree.js"
import { Log } from "../../../src/log.js"
import { Areas } from "../../../src/registry/area.js"
import { Keys } from "../../../src/registry/keys.js"
import { TeamRpc } from "../../../src/rpc/handlers.js"
import { Services } from "../../../src/services.js"
import { git, init, temp, write } from "../../fixtures/repo.js"
import { manual } from "../../support/clock.js"
import { MAIN_SESSION, MODEL, TEAM_ID, World, area, buildId, call, context, team } from "../../support/context.js"
import { type FakeService, session, start } from "../../support/service.js"

/** One op on a fresh fixture, run twice up to a step: git process starts are slow on Windows. */
export const SLOW = 600_000
export const STAR = Preset.ID.create()

/** The running test's folders, services and controllers to close, newest last. */
const cleanups: Array<() => Promise<void> | void> = []

/**
 * Closes `cleanup` when the running test ends, after what came later. Per test, not an `afterEach` here: a hook
 * registered while this module loads binds to the first file importing it, so in a one-process run of several
 * `t3-resume*` files the others left their folders and controllers behind.
 */
function track(cleanup: () => Promise<void> | void) {
  if (cleanups.length === 0)
    onTestFinished(async () => {
      for (const done of cleanups.splice(0).reverse()) await done()
    })
  cleanups.push(cleanup)
}

/** The own service both controllers talk to: conversations, session create, moves, synthetic messages. */
class Backend {
  readonly service: FakeService = start()
  readonly sessions = new Map<string, { directory: string; metadata: Record<string, unknown> }>()
  readonly synthetic: string[] = []

  constructor() {
    const routes = this.service.routes
    routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    routes.set("GET /api/session", () =>
      Response.json({
        data: [...this.sessions].map(([id, stored]) => session({ id, directory: stored.directory })),
        cursor: {},
      }),
    )
    routes.set("POST /api/worktree/refresh", () => new Response(null, { status: 204 }))
    routes.set("GET /api/shell", () => Response.json({ data: [] }))
    routes.set("GET /api/pty", () => Response.json({ data: [] }))
  }

  add(id: string, directory: string) {
    const stored = { directory, metadata: {} as Record<string, unknown> }
    this.sessions.set(id, stored)
    const at = `/api/session/${id}`
    const routes = this.service.routes
    routes.set(`GET ${at}`, () =>
      Response.json({ data: session({ id, directory: stored.directory, metadata: stored.metadata }) }),
    )
    routes.set(`PATCH ${at}`, (request) => {
      stored.metadata = { ...Schema.decodeUnknownSync(Patch)(request.body).metadata }
      return new Response(null, { status: 204 })
    })
    routes.set(`GET ${at}/inbox`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/permission`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/form`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/message`, () => Response.json({ data: [], cursor: {} }))
    routes.set(`GET /api/experimental/session/${id}/instructions/entries`, () => Response.json({ data: [] }))
    routes.set(`POST ${at}/synthetic`, (request) => {
      this.synthetic.push(id)
      const body = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(request.body)
      return Response.json({ data: { id: body.id, sessionID: id, type: "synthetic", delivery: "queue", payload: {} } })
    })
  }
}

const Patch = Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) })
const Started = Schema.Struct({ opID: OwnTeam.OpID })
const decodeOp = Schema.decodeUnknownOption(OwnTeam.Op)

/** The asset commands' stand-in for an engine run: appends one line to the file it is given. */
export function counter(root: string) {
  const script = path.join(root, "engine.js")
  fs.writeFileSync(script, 'require("node:fs").appendFileSync(process.argv[2], "x\\n")\n')
  const file = path.join(root, "runs.txt")
  return { command: { argv: [process.execPath, script, file] }, runs: () => lines(file) }
}

function lines(file: string) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0
}

export interface Options {
  readonly owner?: boolean
  readonly commit?: boolean
  readonly merged?: boolean
  readonly shape?: OwnTeam.Area["shape"]
  /** Files of the area's own commit (default `src/<slug>.ts`). */
  readonly files?: Readonly<Record<string, string>>
}

/** A repository with a team (heavy folder `assets/`) and the world, service and KV both controllers share. */
export async function fixture(input: { readonly team?: (record: OwnTeam.Team) => OwnTeam.Team } = {}) {
  const box = temp("own-team-t3-resume-")
  track(box.dispose)
  const home = init(path.join(box.root, "home"))
  write(home, {
    ".gitignore": "node_modules/\nweights/\n",
    "README.md": "# t3 resume\n",
    "src/app.ts": "export const app = 1\n",
    "assets/textures/rock.bin": "rock\n",
  })
  git(home, ["add", "-A"])
  git(home, ["commit", "-q", "-m", "base"])
  const base = git(home, ["rev-parse", "HEAD"]).trim()
  const plain: OwnTeam.Team = { ...team({ home }), heavy: { dirs: ["assets"], measuredAt: base, forcedBytes: 0 } }
  const record = input.team ? input.team(plain) : plain
  const backend = new Backend()
  track(() => backend.service.stop())
  backend.add(MAIN_SESSION, home)
  const world = new World()
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai" }],
  }))
  world.accounts.set("presets.list", () => ({ groups: [{ group: "codex", defaultModel: null, star: STAR }] }))
  world.accounts.set("session.preset.get", () => ({ binding: null }))
  world.accounts.set("session.preset.apply", () => ({}))
  /** Owner conversations made by the fake owner feature, over both controllers. */
  const owners: string[] = []
  const clock = manual()
  return { box: box.root, home, base, record, backend, world, owners, clock, controllers: 0 }
}

export type Fixture = Awaited<ReturnType<typeof fixture>>

/** An area worktree beside the home (locked as own locks it) and its record. */
export async function makeArea(fx: Fixture, services: Services.Context, slug: string, options: Options = {}) {
  const areaID = Areas.id(slug)
  const directory = path.join(fx.record.worktreeRoot, slug)
  git(fx.home, ["worktree", "add", "-q", "--lock", "--reason", Worktree.lockReason(areaID), "-b", slug, directory])
  if (options.commit) {
    write(directory, options.files ?? { [`src/${slug}.ts`]: `export const ${slug.replace(/-/g, "_")} = 1\n` })
    git(directory, ["add", "-A"])
    git(directory, ["commit", "-q", "-m", slug])
  }
  if (options.merged) git(fx.home, ["merge", "-q", "--no-ff", "--no-edit", slug])
  const owner = options.owner ? SessionID.create() : null
  if (owner !== null) fx.backend.add(owner, directory)
  const made: OwnTeam.Area = {
    ...area({ slug, directory }),
    origin: "adopted",
    gitDir: git(directory, ["rev-parse", "--absolute-git-dir"]).trim(),
    base: { sha: fx.base, at: 0 },
    shape: options.shape ?? "plain",
    preset: STAR,
    owner: { sessionID: owner, previous: [], attached: false },
  }
  await services.write(TEAM_ID, () => services.registry.areas.put(made))
  return made
}

/**
 * A controller over the fixture (a new acquire: its own OWN_HOME, the same KV and folders), with the plugin's RPC
 * groups (they register the step kinds) and the fake features of a test. `stopAfter`: the runner stops right after
 * the step at that index recorded its result, as a process that dies there would.
 */
export function boot(fx: Fixture, stopAfter?: number) {
  const own = temp("own-team-t3-resume-home-")
  track(own.dispose)
  const base = context(fx.world, { directory: fx.home }).ctx
  const ctx: Plugin.Context = {
    ...base,
    session: { ...base.session, move: async () => {} },
  } as Plugin.Context
  const features: Partial<Services.Factories> = {
    safePoint: () => ({ check: async () => ({ ok: true }) }),
    main: () => ({
      create: async () => Services.failure("internal_error", "not in this test", {}),
      model: async () => MODEL,
    }),
    owner: (services) => ({
      create: async (made) => {
        const found = await services.registry.areas.get(made.teamID, made.areaID)
        if (!found) return Services.failure("not_found", "no area", { what: "area", id: made.areaID })
        const sessionID = SessionID.create()
        fx.backend.add(sessionID, found.directory)
        fx.owners.push(sessionID)
        await services.write(made.teamID, async () => {
          const current = await services.registry.areas.get(made.teamID, made.areaID)
          if (current)
            await services.registry.areas.put({ ...current, owner: { ...current.owner, sessionID, attached: true } })
        })
        return { ok: true, sessionID }
      },
      attach: async () => ({ ok: true }),
    }),
  }
  const controller = new Controller.Service({
    buildId: buildId(`t3-resume-${++fx.controllers}`),
    home: own.root,
    log: Log.silent,
    clock: fx.clock,
    source: fx.backend.service.source,
    features,
  })
  const detach = controller.attach({ ctx, directory: fx.home, control: true, leader: () => true })
  const services = controller.services
  const handlers = TeamRpc.create({ services, leader: () => true, log: Log.silent })
  // SAFETY (test): every handler takes its method's input and a call context; erased to call them by name.
  const registered = { definition: { methods: {} }, handlers, emitted: [], disposed: false } as never
  const state = { stopped: false }
  if (stopAfter !== undefined)
    controller.hub.subscribe((event) => {
      if (event.name !== "op.progress" || (event.data.state !== "done" && event.data.state !== "skipped")) return
      const op = Option.getOrUndefined(decodeOp(fx.world.kv.get(Keys.op(TEAM_ID, event.data.opID))))
      if (op?.steps.findIndex((step) => step.id === event.data.stepID) !== stopAfter) return
      state.stopped = true
      services.runner.close()
    })
  controller.start()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    detach()
    await controller.close()
  }
  track(close)
  return {
    controller,
    services,
    state,
    close,
    rpc: (method: string, input: unknown) => call(registered, method, input),
  }
}

export type Booted = ReturnType<typeof boot>

/** Runs the op until it stops (the runner stopped) or ends, answering each confirm `do`. */
export async function drive(booted: Booted, opID: string): Promise<OwnTeam.Op> {
  await booted.services.runner.settled(opID)
  const op = await booted.services.journal.get(TEAM_ID, opID)
  if (!op) throw new Error(`op ${opID} is gone`)
  if (op.state !== "waiting") return op
  const step = op.steps.find((item) => item.state === "needs_confirm")
  if (!step) return op
  await booted.rpc("op.confirm", { opID, stepID: step.id, choice: "do", nonce: step.confirm?.nonce })
  return drive(booted, opID)
}

export interface Scenario {
  /** The areas and records the op works on (with the first controller). */
  readonly prepare: (fx: Fixture, booted: Booted) => Promise<void>
  /** Starts the op; its id. */
  readonly start: (fx: Fixture, booted: Booted) => Promise<string>
  /** What the op left, the same whichever step's result was lost. */
  readonly check: (fx: Fixture, booted: Booted, op: OwnTeam.Op) => Promise<void>
}

/**
 * The op of `scenario` with step `index`'s result lost: the first controller stops right after that step, the step is
 * written back as not run (its effect stays), and a second controller continues the op from the KV. Returns how many
 * steps the op has.
 */
export async function resumed(scenario: Scenario, index: number, setup: Parameters<typeof fixture>[0] = {}) {
  const fx = await fixture(setup)
  const first = boot(fx, index)
  await first.services.write(TEAM_ID, () => first.services.registry.teams.put(fx.record))
  await scenario.prepare(fx, first)
  const opID = await scenario.start(fx, first)
  const stopped = await drive(first, opID)
  const step = stopped.steps[index]
  // The first controller stopped right after that step (every later auto step is still to run).
  expect({ index, stopped: first.state.stopped }).toEqual({ index, stopped: true })
  expect(stopped.steps.slice(index + 1).every((item) => item.state === "pending" || item.mode === "confirm")).toBe(true)
  if (step && (step.state === "done" || step.state === "skipped")) {
    await first.services.write(TEAM_ID, async () => {
      const current = await first.services.journal.get(TEAM_ID, opID)
      if (!current) throw new Error("op is gone")
      await first.services.journal.put({
        ...current,
        state: "running",
        steps: current.steps.map((item, at) =>
          at === index ? { id: item.id, kind: item.kind, args: item.args, mode: item.mode, state: "pending" } : item,
        ),
      })
    })
  }
  await first.close()
  const second = boot(fx)
  await second.controller.resume()
  const op = await drive(second, opID)
  expect({ index, kind: step?.kind, state: op.state }).toEqual({ index, kind: step?.kind, state: "done" })
  await scenario.check(fx, second, op)
  await second.close()
  return stopped.steps.length
}

/**
 * One test per step of the scenario's op, each losing that step's result. `count` is the op's step count; with
 * `atLeast` the op may have more, and the last test goes on through every step from `count` on.
 */
export function eachStep(
  title: string,
  count: number,
  scenario: Scenario,
  options: { readonly setup?: Parameters<typeof fixture>[0]; readonly atLeast?: boolean } = {},
) {
  const rest = async (index: number, total: number): Promise<void> => {
    if (index >= total) return
    await resumed(scenario, index, options.setup)
    return rest(index + 1, total)
  }
  for (const index of Array.from({ length: count }, (_, at) => at))
    test(
      `${title}: step ${index} of 0-${count - 1}${options.atLeast ? "+" : ""}`,
      async () => {
        const total = await resumed(scenario, index, options.setup)
        if (!options.atLeast) return expect(total).toBe(count)
        expect(total).toBeGreaterThanOrEqual(count)
        if (index === count - 1) await rest(count, total)
      },
      SLOW,
    )
}

export function apply(proposal: Omit<OwnTeam.Proposal, "version">) {
  return async (_fx: Fixture, booted: Booted) => {
    const answer = await booted.rpc("reorg.apply", { teamID: TEAM_ID, proposal: { version: 1, ...proposal } })
    return Schema.decodeUnknownSync(Started)(answer).opID
  }
}

/** `refs/own/*` of the repository, one per line. */
export function ownRefs(home: string) {
  return git(home, ["for-each-ref", "--format=%(refname)", "refs/own"]).split("\n").filter(Boolean)
}

export function worktrees(home: string) {
  return git(home, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
}

export const areaOf = (services: Services.Context, slug: string) => services.registry.areas.get(TEAM_ID, Areas.id(slug))
