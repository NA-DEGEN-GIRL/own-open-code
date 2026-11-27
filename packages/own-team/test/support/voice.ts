// Test support for the voice tools (06 §2.9): a team on a real git home in a temp folder, a fake own service on
// 127.0.0.1 that serves the conversations (their messages as a turn log, inbox, permissions, forms, instructions,
// moves), a controller on a manual clock whose features a test may replace (recording what the tools call), the RPC
// groups (they register the step kinds) and the registered team tools called by session id, as Code Mode would.
// A conversation's turns are written by the test: `turn` (a user message and the step that calls the tool), `idle`
// (the turn ended), `reply` (the user's next message, optionally with metadata such as the gateway's device stamp).
// Fake values only; nothing reads this PC's accounts.

import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Controller } from "../../src/controller.js"
import { Worktree } from "../../src/git/worktree.js"
import { Log } from "../../src/log.js"
import { Areas } from "../../src/registry/area.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { Services } from "../../src/services.js"
import { Tools } from "../../src/tools/index.js"
import type { MainTools } from "../../src/tools/main.js"
import { git, init, temp, write } from "../fixtures/repo.js"
import { manual, type Manual } from "./clock.js"
import { MAIN_SESSION, MODEL, TEAM_ID, World, area, buildId, call, context, team } from "./context.js"
import { type FakeService, start } from "./service.js"

export const STAR = Preset.ID.create()

type Message = Readonly<Record<string, unknown>>

/** A conversation the fake service knows. */
export interface Conversation {
  readonly id: string
  directory: string
  title: string
  parentID?: string
  metadata: Record<string, unknown>
  /** Its messages, oldest first (`GET /api/session/:id/message` pages them newest first). */
  readonly messages: Message[]
  /** Its inbox items (`GET …/inbox`); `DELETE …/inbox/:id` removes one. */
  readonly inbox: Array<{
    readonly id: string
    readonly type: "user" | "synthetic"
    readonly payload: { readonly text: string; readonly metadata?: Record<string, unknown> }
  }>
}

const Patch = Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) })

/** The instruction entries own.team writes. */
const ENTRIES = ["own.team.main.role", "own.team.role", "own.team.peer.role", "own.team.handoff"]

/** The own service: conversations, their message logs, inbox, moves, `session.list`. */
export class Backend {
  readonly service: FakeService = start()
  readonly conversations = new Map<string, Conversation>()
  readonly moves: Array<{ readonly sessionID: string; readonly directory: string }> = []
  #next = 0

  constructor() {
    const routes = this.service.routes
    routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    routes.set("GET /api/session", (request) =>
      Response.json({
        data: [...this.conversations.values()]
          .filter((item) => request.query.search === undefined || item.title.includes(request.query.search))
          .map((item) => view(item)),
        cursor: {},
      }),
    )
    routes.set("POST /api/worktree/refresh", () => new Response(null, { status: 204 }))
    routes.set("GET /api/shell", () => Response.json({ data: [] }))
    routes.set("GET /api/pty", () => Response.json({ data: [] }))
  }

  add(id: string, directory: string, title = "대화") {
    const item: Conversation = { id, directory, title, metadata: {}, messages: [], inbox: [] }
    this.conversations.set(id, item)
    const at = `/api/session/${id}`
    const routes = this.service.routes
    routes.set(`GET ${at}`, () => Response.json({ data: view(item) }))
    routes.set(`PATCH ${at}`, (request) => {
      item.metadata = { ...Schema.decodeUnknownSync(Patch)(request.body).metadata }
      return new Response(null, { status: 204 })
    })
    routes.set(`GET ${at}/inbox`, () =>
      Response.json({
        data: item.inbox.map((entry) => ({ ...entry, sessionID: id, delivery: "queue" })),
      }),
    )
    routes.set(`GET ${at}/permission`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/form`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/message`, (request) => {
      const limit = Number(request.query.limit ?? "50")
      const page = request.query.order === "asc" ? [...item.messages] : item.messages.toReversed()
      return Response.json({ data: page.slice(0, limit), cursor: {} })
    })
    routes.set(`GET /api/experimental/session/${id}/instructions/entries`, () => Response.json({ data: [] }))
    for (const key of ENTRIES)
      routes.set(`PUT /api/experimental/session/${id}/instructions/entries/${key}`, () => new Response(null, { status: 204 }))
    return item
  }

  /** Writes a message of `type` into `sessionID`'s log. */
  message(sessionID: string, type: string, metadata?: Record<string, unknown>) {
    const item = this.conversations.get(sessionID)
    if (!item) throw new Error(`no conversation ${sessionID}`)
    const id = `msg_${String(++this.#next).padStart(26, "0")}`
    item.messages.push({ id, type, time: { created: this.#next }, ...(metadata === undefined ? {} : { metadata }) })
    return id
  }

  /** A user message and the step that calls a tool: what the log holds while the tool runs. */
  turn(sessionID: string) {
    this.message(sessionID, "user")
    this.message(sessionID, "assistant")
  }

  /** The turn ended. */
  idle(sessionID: string) {
    this.message(sessionID, "idle")
  }

  /** The user's next message (after the turn ended), and the step of the turn it opens. */
  reply(sessionID: string, metadata?: Record<string, unknown>) {
    this.idle(sessionID)
    this.message(sessionID, "user", metadata)
    this.message(sessionID, "assistant")
  }

  /** A queued inbox item of `sessionID`; `DELETE` removes it. */
  queue(sessionID: string, text: string, metadata?: Record<string, unknown>) {
    const item = this.conversations.get(sessionID)
    if (!item) throw new Error(`no conversation ${sessionID}`)
    const id = `msg_inbox${String(++this.#next).padStart(21, "0")}`
    item.inbox.push({ id, type: "user", payload: { text, ...(metadata === undefined ? {} : { metadata }) } })
    this.service.routes.set(`DELETE /api/session/${sessionID}/inbox/${id}`, () => {
      const index = item.inbox.findIndex((entry) => entry.id === id)
      if (index >= 0) item.inbox.splice(index, 1)
      return new Response(null, { status: 204 })
    })
    return id
  }

  /** core's `session.move` of an idle conversation: its location changes. */
  move(input: { readonly sessionID: string; readonly directory: string }) {
    this.moves.push({ sessionID: input.sessionID, directory: input.directory })
    const item = this.conversations.get(input.sessionID)
    if (item) item.directory = input.directory
  }
}

function view(item: Conversation) {
  return {
    id: item.id,
    projectID: "prj_test",
    title: item.title,
    location: { directory: item.directory },
    time: { created: 1, updated: 1 },
    metadata: item.metadata,
    ...(item.parentID === undefined ? {} : { parentID: item.parentID }),
  }
}

export interface AreaOptions {
  /** A commit of its own. */
  readonly commit?: boolean
  /** That commit merged into `main`. */
  readonly merged?: boolean
  readonly origin?: OwnTeam.Area["origin"]
  readonly paused?: OwnTeam.Area["paused"]
  /** An owner conversation (default yes). */
  readonly owner?: boolean
  readonly peers?: ReadonlyArray<OwnTeam.Peer>
  /** The area's role (`goal`). */
  readonly goal?: string
  /** The user set it up (`Area.userMade`, 2026-10-26). */
  readonly userMade?: boolean
  /** The user works with it directly (`Area.directWork`, 2026-11-14). */
  readonly direct?: boolean
}

export type Reply = MainTools.Reply

/** Records `call` (its input) and answers `answer` (default `{ok: true}`). */
export type Calls = Array<{ readonly name: string; readonly input: unknown }>

export async function voiceTeam(input: {
  readonly features?: (calls: Calls) => Partial<Services.Factories>
  readonly policy?: Partial<OwnTeam.Policy>
  readonly clock?: Manual
  readonly cleanups: Array<() => Promise<void> | void>
}) {
  const box = temp("own-team-voice-")
  input.cleanups.push(box.dispose)
  const home = init(path.join(box.root, "home"))
  write(home, { ".gitignore": "node_modules/\n", "README.md": "# voice\n", "src/app.ts": "export const app = 1\n" })
  git(home, ["add", "-A"])
  git(home, ["commit", "-q", "-m", "base"])
  const base = git(home, ["rev-parse", "HEAD"]).trim()
  const shared = team({ home })
  const record: OwnTeam.Team = { ...shared, policy: { ...shared.policy, ...input.policy } }
  const backend = new Backend()
  input.cleanups.push(() => backend.service.stop())
  backend.add(MAIN_SESSION, home, "팀 메인")
  const world = new World()
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai", label: "ChatGPT", billing: "subscription" }],
  }))
  world.accounts.set("presets.list", () => ({ groups: [{ group: "codex", defaultModel: null, star: STAR }] }))
  world.accounts.set("session.preset.get", () => ({ binding: null }))
  world.accounts.set("session.preset.apply", () => ({}))
  const calls: Calls = []
  const features: Partial<Services.Factories> = {
    safePoint: () => ({ check: async () => ({ ok: true }) }),
    main: () => ({
      create: async () => Services.failure("internal_error", "not in this test", {}),
      model: async () => MODEL,
    }),
    ...input.features?.(calls),
  }
  const clock = input.clock ?? manual()
  const own = temp("own-team-voice-home-")
  input.cleanups.push(own.dispose)
  const plain = context(world, { directory: home }).ctx
  // The control instance moves a conversation the way core's `session.move` does (the test context has no `move`).
  const ctx: Plugin.Context = {
    ...plain,
    session: {
      ...plain.session,
      move: async (moved: { readonly sessionID: string; readonly directory: string }) => backend.move(moved),
    },
  } as Plugin.Context
  const controller = new Controller.Service({
    buildId: buildId("voice"),
    home: own.root,
    log: Log.silent,
    clock,
    source: backend.service.source,
    features,
  })
  const detach = controller.attach({ ctx, directory: home, control: true, leader: () => true })
  controller.start()
  input.cleanups.push(async () => {
    detach()
    await controller.close()
  })
  const services = controller.services
  // The RPC groups register the paths, integrate, reorganization and adoption step kinds while the plugin sets up.
  const handlers = TeamRpc.create({ services, leader: () => true, log: Log.silent })
  // SAFETY (test): every handler takes its method's input and a call context; erased to call them by name.
  const registered = { definition: { methods: {} }, handlers, emitted: [], disposed: false } as never
  const rpc = (method: string, request: unknown) => call(registered, method, request)
  await services.write(TEAM_ID, () => services.registry.teams.put(record))

  const makeArea = async (slug: string, options: AreaOptions = {}) => {
    const areaID = Areas.id(slug)
    const directory = path.join(record.worktreeRoot, slug)
    git(home, ["worktree", "add", "-q", "--lock", "--reason", Worktree.lockReason(areaID), "-b", slug, directory])
    if (options.commit) {
      write(directory, { [`src/${slug}.ts`]: `export const ${slug.replace(/-/g, "_")} = 1\n` })
      git(directory, ["add", "-A"])
      git(directory, ["commit", "-q", "-m", slug])
    }
    if (options.merged) git(home, ["merge", "-q", "--no-ff", "--no-edit", slug])
    const owner = options.owner === false ? null : SessionID.make(`ses_owner${slug.padEnd(21, "0").slice(0, 21)}`)
    if (owner !== null) backend.add(owner, directory, `${slug} 담당`)
    const made: OwnTeam.Area = {
      ...area({ slug, directory }),
      origin: options.origin ?? "created",
      gitDir: git(directory, ["rev-parse", "--absolute-git-dir"]).trim(),
      base: { sha: base, at: 0 },
      preset: STAR,
      owner: { sessionID: owner, previous: [], attached: true },
      paused: options.paused ?? false,
      ...(options.peers === undefined ? {} : { peers: [...options.peers] }),
      ...(options.goal === undefined ? {} : { goal: options.goal }),
      ...(options.userMade ? { userMade: { at: 1 } } : {}),
      ...(options.direct ? { directWork: { since: 1, at: 1 } } : {}),
    }
    await services.write(TEAM_ID, () => services.registry.areas.put(made))
    return made
  }

  /** A team tool, called by `sessionID` as Code Mode would (the registry decides who it is). */
  const tool = (name: string) => {
    const definition = Tools.DEFINITIONS.find((item) => item.name === name)
    if (!definition) throw new Error(`no tool ${name}`)
    return (sessionID: string, raw: unknown) => definition.execute(services, sessionID, raw)
  }

  /** Waits (real time) until the op stops running. */
  const settled = async (opID: string) => {
    const deadline = Date.now() + 240_000
    for (;;) {
      const op = await services.journal.find(opID)
      if (op && op.state !== "running") return op
      if (Date.now() > deadline) throw new Error(`op ${opID} still runs`)
      await Bun.sleep(25)
    }
  }

  /** Waits for the op; answers each confirm with `choice` until it ends. */
  const finish = async (opID: string, choice: "do" | "skip" | "none" = "do"): Promise<OwnTeam.Op> => {
    const op = await settled(opID)
    if (op.state !== "waiting" || choice === "none") return op
    const step = op.steps.find((item) => item.state === "needs_confirm")
    if (!step) return op
    await rpc("op.confirm", { opID, stepID: step.id, choice, nonce: step.confirm?.nonce })
    return finish(opID, choice)
  }

  /** What changes when a plan is made: none of it may. */
  const snapshot = async () => ({
    team: await services.registry.teams.get(TEAM_ID),
    areas: await services.registry.areas.list(TEAM_ID),
    ops: await services.journal.list(TEAM_ID),
    dispatches: await services.registry.dispatches.waiting(TEAM_ID),
  })

  return {
    home,
    base,
    record,
    backend,
    world,
    calls,
    clock,
    controller,
    services,
    rpc,
    makeArea,
    tool,
    settled,
    finish,
    snapshot,
    areaOf: async (slug: string) => services.registry.areas.get(TEAM_ID, Areas.id(slug)),
  }
}

export type VoiceTeam = Awaited<ReturnType<typeof voiceTeam>>

/** Plan, then (after the user's reply in the next turn) the same call with its token. */
export async function approve(
  h: VoiceTeam,
  sessionID: string,
  name: string,
  input: Readonly<Record<string, unknown>>,
  metadata?: Record<string, unknown>,
) {
  h.backend.turn(sessionID)
  const plan = await h.tool(name)(sessionID, input)
  if (plan.plan !== true) throw new Error(`no plan: ${JSON.stringify(plan)}`)
  h.backend.reply(sessionID, metadata)
  const done = await h.tool(name)(sessionID, { ...input, token: plan.token })
  return { plan, done }
}
