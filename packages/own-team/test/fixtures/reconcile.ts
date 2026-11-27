/**
 * Reconcile fixtures (06 §8.8, §11.2): a team over a real repository and a fake own service.
 *
 *   <root>/home                 the home: the main worktree on `main`, `.worktrees/` ignored
 *     .worktrees/nest           a nested area (4.3: without its `.git` file, git would find the home around it)
 *   <root>/home-team/ui, save   two areas beside it
 *
 * Each area is a linked worktree on its own branch (named after it) with one commit of its own and an owner
 * conversation. The own service runs on 127.0.0.1 and holds the conversations (location, metadata, inbox, active
 * runs); the controller's control instance moves a conversation the way core's `session.move` does for an idle
 * session whose folder is gone (the location changes at once). Team news goes to {@link Fixture.news}. Fake values and
 * temp folders only; git runs with the fixture repository's local settings.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Controller } from "../../src/controller.js"
import { Identity } from "../../src/git/identity.js"
import type { Hub } from "../../src/hub.js"
import { Log } from "../../src/log.js"
import { Reconcile } from "../../src/reconcile/area.js"
import type { Services } from "../../src/services.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, TEAM_ID, World, area, buildId, context, team } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"
import { commit, files, git, init, temp, write } from "./repo.js"

export const SLUGS = ["ui", "save", "nest"] as const
export type Slug = (typeof SLUGS)[number]

export const OWNERS: Readonly<Record<Slug, SessionID>> = {
  ui: SessionID.make("ses_owner_ui_0000000000000000001"),
  save: SessionID.make("ses_owner_save_00000000000000001"),
  nest: SessionID.make("ses_owner_nest_00000000000000001"),
}

export function areaID(slug: string) {
  return OwnTeam.AreaID.make(`ar_${slug}`)
}

interface Stored {
  directory: string
  metadata: Record<string, unknown>
}

/** The own service's session routes a reconcile reads: sessions, active runs, inboxes and permission requests. */
export class Backend {
  readonly service: FakeService = start()
  readonly sessions = new Map<string, Stored>()
  /** Ids in `session.active`. */
  readonly active = new Set<string>()
  readonly inbox = new Map<string, unknown[]>()
  /** Every `ctx.session.move` call, in order. */
  readonly moves: Array<{ readonly sessionID: string; readonly directory: string; readonly delivery?: string }> = []

  constructor() {
    this.service.routes.set("GET /api/session/active", () =>
      Response.json({ data: Object.fromEntries([...this.active].map((id) => [id, { type: "running" }])) }),
    )
    this.service.routes.set("GET /api/session", (request) =>
      Response.json({
        data: [...this.sessions]
          .filter(
            ([, stored]) =>
              request.query.directory === undefined || Identity.same(stored.directory, request.query.directory),
          )
          .map(([id, stored]) => session({ id, directory: stored.directory, metadata: stored.metadata })),
        cursor: {},
      }),
    )
  }

  add(id: string, directory: string) {
    const stored: Stored = { directory, metadata: {} }
    this.sessions.set(id, stored)
    const at = `/api/session/${id}`
    this.service.routes.set(`GET ${at}`, () =>
      Response.json({ data: session({ id, directory: stored.directory, metadata: stored.metadata }) }),
    )
    this.service.routes.set(`PATCH ${at}`, (request) => {
      stored.metadata = { ...Schema.decodeUnknownSync(Patch)(request.body).metadata }
      return new Response(null, { status: 204 })
    })
    this.service.routes.set(`GET ${at}/inbox`, () => Response.json({ data: this.inbox.get(id) ?? [] }))
    this.service.routes.set(`GET ${at}/permission`, () => Response.json({ data: [] }))
    this.service.routes.set(`GET ${at}/form`, () => Response.json({ data: [] }))
    return stored
  }

  /** core's `session.move` of an idle session whose old folder is gone: the location changes at once. */
  move(input: { readonly sessionID: string; readonly directory: string; readonly delivery?: string }) {
    this.moves.push(input)
    const stored = this.sessions.get(input.sessionID)
    if (stored) stored.directory = input.directory
  }
}

const Patch = Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) })

export interface Fixture {
  readonly root: string
  readonly home: string
  readonly commonDir: string
  /** The area folders as registered (native paths). */
  readonly folders: Readonly<Record<Slug, string>>
  readonly world: World
  readonly backend: Backend
  readonly controller: Controller.Service
  readonly services: Services.Context
  /** Events the controller published (`area.changed`, `notice`, …). */
  readonly published: Hub.Outgoing[]
  /** Team news added to the digest. */
  readonly news: Services.DigestEntry[]
  readonly reconcile: Reconcile.Service
  run(): Promise<Reconcile.Outcome>
  area(slug: string): Promise<OwnTeam.Area>
  /** git in an area folder. */
  git(slug: Slug, args: readonly string[]): string
  /** The `notice` events published so far. */
  notices(): ReadonlyArray<Hub.Body<"notice">>
  close(): Promise<void>
}

export async function setup(): Promise<Fixture> {
  const box = temp("own-team-reconcile-")
  const root = box.root
  const home = init(path.join(root, "home"))
  write(home, { ".gitignore": ".worktrees/\n", "README.md": "# reconcile\n", "src/app.ts": "export const app = 1\n" })
  commit(home, "base")
  const folders: Record<Slug, string> = {
    ui: path.join(root, "home-team", "ui"),
    save: path.join(root, "home-team", "save"),
    nest: path.join(home, ".worktrees", "nest"),
  }
  const gitDirs = Object.fromEntries(
    SLUGS.map((slug) => {
      const folder = folders[slug]
      git(home, ["worktree", "add", "-q", "-b", slug, folder, "main"])
      write(folder, { [`${slug}.md`]: `${slug}\n` })
      commit(folder, slug)
      return [slug, git(folder, ["rev-parse", "--absolute-git-dir"]).trim()]
    }),
  )

  const backend = new Backend()
  backend.add(MAIN_SESSION, home)
  SLUGS.forEach((slug) => backend.add(OWNERS[slug], folders[slug]))
  const world = new World()
  const published: Hub.Outgoing[] = []
  const news: Services.DigestEntry[] = []
  const controller = new Controller.Service({
    buildId: buildId("reconcile"),
    home: path.join(root, "own-home"),
    log: Log.silent,
    clock: manual(),
    source: backend.service.source,
    features: {
      digest: () => ({
        add: async (_teamID, entry) => {
          news.push(entry)
        },
        render: async () => "",
      }),
    },
  })
  const detach = controller.attach({
    ctx: mover(world, backend, home),
    directory: home,
    control: true,
    leader: () => true,
  })
  controller.hub.subscribe((event) => published.push(event))
  controller.start()
  const services = controller.services
  await services.write(TEAM_ID, async () => {
    await services.registry.teams.put({ ...team({ home }), worktreeRoot: path.join(root, "home-team") })
    for (const slug of SLUGS)
      await services.registry.areas.put({
        ...area({ slug, directory: folders[slug] }),
        gitDir: gitDirs[slug],
        owner: { sessionID: OWNERS[slug], previous: [], attached: true },
      })
  })
  // The features' resumes run on attach; let them settle before a test looks at what changed.
  await controller.resume()
  const reconcile = Reconcile.create(services)
  return {
    root,
    home,
    commonDir: path.join(home, ".git"),
    folders,
    world,
    backend,
    controller,
    services,
    published,
    news,
    reconcile,
    run: () => reconcile.run({ id: TEAM_ID }, { trigger: "safe-point" }),
    area: async (slug) => {
      const found = await services.registry.areas.get(TEAM_ID, areaID(slug))
      if (!found) throw new Error(`area ${slug} is not in the registry`)
      return found
    },
    git: (slug, args) => git(folders[slug], args),
    notices: () => published.flatMap((event) => (event.name === "notice" ? [event.data] : [])),
    close: async () => {
      detach()
      await controller.close()
      await backend.service.stop()
      box.dispose()
    },
  }
}

/** An instance whose `session.move` moves the backend's session (the test context has no `move`). */
function mover(world: World, backend: Backend, directory: string): Plugin.Context {
  const base = context(world, { directory }).ctx
  const session = {
    ...base.session,
    move: async (input: { readonly sessionID: string; readonly directory: string; readonly delivery?: string }) =>
      backend.move(input),
  }
  return { ...base, session }
}

/**
 * What reconcile must never change: every file in the home and the area folders (the common dir aside, where keep refs
 * go), each worktree's HEAD, branch and lock (`worktree list`), the local branches, and the sparse-checkout state
 * (configuration and pattern files).
 */
export function snapshot(fixture: Pick<Fixture, "root" | "home" | "commonDir">) {
  const tree = (dir: string) =>
    fs.existsSync(dir)
      ? files(dir).map(
          (file) => `${path.relative(fixture.root, dir)}/${file} ${digest(fs.readFileSync(path.join(dir, file)))}`,
        )
      : []
  const sparse = [
    path.join(fixture.commonDir, "config"),
    path.join(fixture.commonDir, "info", "sparse-checkout"),
    ...listed(path.join(fixture.commonDir, "worktrees")).flatMap((name) => [
      path.join(fixture.commonDir, "worktrees", name, "config.worktree"),
      path.join(fixture.commonDir, "worktrees", name, "info", "sparse-checkout"),
    ]),
  ].map((file) => `${path.relative(fixture.root, file)} ${fs.existsSync(file) ? digest(fs.readFileSync(file)) : "-"}`)
  return {
    files: [...tree(fixture.home), ...tree(path.join(fixture.root, "home-team"))],
    worktrees: git(fixture.home, ["worktree", "list", "--porcelain"]),
    branches: git(fixture.home, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
    sparse,
  }
}

function digest(bytes: Uint8Array) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

function listed(dir: string) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}
