// op.undo (06 §3.8 되돌리기, §9.3) and team.home (undoable): undo of enable removes only what that enable made — an
// untouched area worktree without --force and its branch at the base, a touched one kept with a notice, sessions
// archived through metadata read-modify-write, the home lock put back, the registry removed and the enable marked
// undone — and team.home moves the main folder and back. Adopted folders are covered by `test/adopt/undo-adopt.test.ts`
// and the undo of 팀에 넣기 by `test/adopt/unadopt.test.ts`. Fake service on 127.0.0.1, real git fixtures, fake values.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Symlinks } from "../../src/assets/symlinks.js"
import { Identity } from "../../src/git/identity.js"
import { Refs } from "../../src/git/refs.js"
import { Worktree } from "../../src/git/worktree.js"
import { Enable } from "../../src/ops/enable.js"
import { TeamHome } from "../../src/ops/home.js"
import { Undo } from "../../src/ops/undo.js"
import { Areas } from "../../src/registry/area.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import type { Services } from "../../src/services.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Permissions } from "../../src/tools/permissions.js"
import { f1, git, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { World, context, controller, tempHome } from "../support/context.js"
import { start, type FakeService } from "../support/service.js"

const SLOW = 180_000
const NOW = Date.UTC(2026, 9, 2, 3, 0, 0)
const MODEL = Schema.decodeUnknownSync(Model.Ref)({ id: "gpt-6-astra", providerID: "own-codex-aaaa", variant: "high" })

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
}, SLOW)

interface Stored {
  readonly id: string
  directory: string
  readonly model?: Model.Ref
  metadata: Record<string, unknown>
  messages: number
  /** Instruction entry keys the conversation holds. */
  entries: string[]
}

const OWNER_ENTRIES = [RoleInstructions.OWNER, RoleInstructions.HANDOFF]

/** The own service: sessions with metadata, messages and instruction entries, the judge, worktree refreshes. */
class Backend {
  readonly service: FakeService = start()
  readonly sessions = new Map<string, Stored>()
  answer = '{"version":1}'

  constructor() {
    cleanups.push(() => this.service.stop())
    this.service.routes.set("GET /api/session", (request) =>
      Response.json({
        data: [...this.sessions.values()]
          .filter(
            (item) => request.query.directory === undefined || Identity.same(item.directory, request.query.directory),
          )
          .map(view),
        cursor: {},
      }),
    )
    this.service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    this.service.routes.set("POST /api/worktree/refresh", () => new Response(null, { status: 204 }))
  }

  add(input: { readonly id: string; readonly directory: string; readonly model?: Model.Ref }) {
    const stored: Stored = { ...input, metadata: {}, messages: 0, entries: [] }
    this.sessions.set(stored.id, stored)
    const at = `/api/session/${stored.id}`
    const entries = `/api/experimental/session/${stored.id}/instructions/entries`
    this.service.routes.set(`GET ${entries}`, () =>
      Response.json({ data: stored.entries.map((key) => ({ key, value: "text" })) }),
    )
    for (const key of OWNER_ENTRIES)
      this.service.routes.set(`DELETE ${entries}/${key}`, () => {
        stored.entries = stored.entries.filter((item) => item !== key)
        return new Response(null, { status: 204 })
      })
    this.service.routes.set(`GET ${at}`, () => Response.json({ data: view(stored) }))
    this.service.routes.set(`PATCH ${at}`, (request) => {
      const body = Schema.decodeUnknownSync(Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) }))(
        request.body,
      )
      stored.metadata = { ...body.metadata }
      return new Response(null, { status: 204 })
    })
    this.service.routes.set(`GET ${at}/message`, () =>
      Response.json({
        data: Array.from({ length: stored.messages }, (_, index) => ({ id: `msg_${index}` })),
        cursor: {},
      }),
    )
    this.service.routes.set(`GET ${at}/inbox`, () => Response.json({ data: [] }))
    this.service.routes.set(`POST ${at}/generate`, () => Response.json({ data: { text: this.answer } }))
    return stored
  }
}

function view(item: Stored) {
  return {
    id: item.id,
    projectID: "prj_test",
    location: { directory: item.directory },
    time: { created: 1, updated: NOW },
    metadata: item.metadata,
    ...(item.model === undefined ? {} : { model: item.model }),
  }
}

function mainFeature(backend: Backend, mains: Services.MainCreate[]): Services.Factories["main"] {
  return () => ({
    create: async (input) => {
      mains.push(input)
      if (!backend.sessions.has(input.sessionID)) backend.add({ id: input.sessionID, directory: input.directory })
      return { ok: true, sessionID: input.sessionID }
    },
    model: async () => undefined,
  })
}

const AreaArgs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  base: Schema.String,
  directory: Schema.String,
})

/** New areas as a fake of T1.14: a real locked worktree, an owner session and the record. */
function areasFeature(backend: Backend): Services.Factories["areas"] {
  return (services) => {
    services.steps.register({
      kind: "test.area",
      observe: async (input) => {
        const args = Schema.decodeUnknownSync(AreaArgs)(input.step.args)
        return (await services.registry.areas.get(input.op.teamID, Areas.id(args.slug)))
          ? { state: "satisfied" }
          : { state: "pending" }
      },
      act: async (input) => {
        const args = Schema.decodeUnknownSync(AreaArgs)(input.step.args)
        const team = await services.registry.teams.get(input.op.teamID)
        if (!team) return { ok: false, note: "no team" }
        const areaID = Areas.id(args.slug)
        const made = await Worktree.create(
          {
            home: team.home.directory,
            directory: args.directory,
            branch: args.slug,
            base: args.base,
            areaID,
            shape: "plain",
            cone: [],
            heavy: [],
          },
          { askDownloadBytes: Number.MAX_SAFE_INTEGER },
        )
        if (!made.ok || made.state !== "ready") return { ok: false, note: "worktree" }
        const owner = SessionID.create()
        backend.add({ id: owner, directory: args.directory })
        await services.write(team.id, () =>
          services.registry.areas.put({
            id: areaID,
            teamID: team.id,
            name: args.name,
            goal: "",
            origin: "created",
            state: "active",
            branch: args.slug,
            gitDir: made.gitDir,
            base: { sha: args.base, at: NOW },
            directory: args.directory,
            shape: "plain",
            cone: { extra: {}, kept: {} },
            owner: { sessionID: owner, previous: [], attached: true },
            preset: Preset.builtinID("codex"),
            paused: false,
            status: { kind: "idle", at: NOW, text: "" },
            handoff: null,
          }),
        )
        return { ok: true }
      },
      verify: async () => ({ ok: true }),
    })
    return {
      plan: async (input) => {
        const base = await Refs.read(input.team.commonDir, `refs/heads/${input.team.target}`)
        if (!base) return { ok: false, error: "not_git", message: "no target", data: { directory: "" } }
        return {
          ok: true,
          areaID: Areas.id(input.slug),
          steps: [
            {
              kind: "test.area",
              args: {
                slug: input.slug,
                name: input.name,
                base,
                directory: path.join(input.team.worktreeRoot, input.slug),
              },
            },
          ],
        }
      },
    }
  }
}

async function setup() {
  const ownHome = await tempHome()
  cleanups.push(() => ownHome[Symbol.asyncDispose]())
  const backend = new Backend()
  const mains: Services.MainCreate[] = []
  const world = new World()
  const harness = controller(world, {
    directory: ownHome.root,
    clock: manual(NOW),
    home: ownHome.root,
    source: backend.service.source,
    features: { main: mainFeature(backend, mains), areas: areasFeature(backend) },
  })
  cleanups.push(() => harness.close())
  return { ...harness, backend, mains, world }
}

type Harness = Awaited<ReturnType<typeof setup>>

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

const Started = Schema.Struct({ opID: OwnTeam.OpID })

async function started(h: Harness, method: string, input: unknown) {
  const answer = await rpc(h.services)(method, input)
  const found = Schema.decodeUnknownOption(Started)(answer)
  if (found._tag === "None") throw new Error(`${method} failed: ${JSON.stringify(answer)}`)
  return found.value.opID
}

/** The op once it left `running`; read by team, because undo removes the team record `op.get` looks through. */
async function settle(h: Harness, teamID: string, opID: string) {
  const deadline = Date.now() + 120_000
  const read = () => h.services.journal.get(teamID, opID)
  while ((await read())?.state === "running" || (await read()) === undefined) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
  const op = await read()
  if (!op) throw new Error(`op ${opID} is gone`)
  return op
}

/** F1 with `main` in a linked worktree `work` (the primary on `dev`), a user session there. */
function linkedF1() {
  const root = temp("own-team-undo-")
  cleanups.push(() => root.dispose())
  const repo = f1(root.root)
  git(repo.home, ["checkout", "-q", "-b", "dev"])
  const work = path.join(root.root, "work")
  git(repo.home, ["worktree", "add", "-q", work, "main"])
  return { root: root.root, primary: repo.home, work }
}

const TWO_AREAS = JSON.stringify({
  version: 1,
  areas: [
    { slug: "inventory-ui", name: "인벤토리 화면", create: { from: "main" } },
    { slug: "save-v3", name: "세이브 v3", create: { from: "main" } },
  ],
})

async function lockOf(commonDir: string, name: string) {
  const held = (await TeamHome.snapshot(commonDir)) ?? {}
  return Object.entries(held).find(([where]) => path.basename(where) === name)?.[1] ?? null
}

/** Writes the F1 link copies into every area of the team as `worktree-create` does, and records them. */
async function linkCopies(h: Harness, teamID: string) {
  const areas = await h.services.registry.areas.list(teamID)
  return Promise.all(
    areas.map(async (area) => {
      const applied = await Symlinks.apply({ area, fix: "skip-worktree" })
      if (!applied.ok) throw new Error(applied.message)
      const recorded = { ...area, linkCopies: { ...applied.linkCopies } }
      await h.services.write(area.teamID, () => h.services.registry.areas.put(recorded))
      return recorded
    }),
  )
}

async function worktreeNames(commonDir: string) {
  const listed = await Worktree.list(commonDir)
  return listed.ok ? listed.worktrees.map((item) => path.basename(item.path)).toSorted() : []
}

describe("undo of enable", () => {
  test(
    "removes only what the enable made; a touched area stays; the next enable starts fresh",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      h.backend.answer = TWO_AREAS
      const enabled = await started(h, "enable", { directory: repo.work, sessionID: "ses_user" })
      const teamID = (await h.services.journal.find(enabled))!.teamID
      const op = await settle(h, teamID, enabled)
      expect(op.state).toBe("done")
      const team = (await h.services.registry.teams.get(teamID))!
      const areas = await h.services.registry.areas.list(teamID)
      const kept = areas.find((area) => area.id === "ar_save-v3")!
      const removed = areas.find((area) => area.id === "ar_inventory-ui")!
      expect(await lockOf(team.commonDir, "work")).toBe(TeamHome.reason(teamID))
      // The user worked in one area: an untracked file there.
      write(kept.directory, { "notes.txt": "mine\n" })

      const undoID = await started(h, "op.undo", { opID: enabled })
      const undo = await settle(h, teamID, undoID)
      expect(undo.state).toBe("done")
      expect(undo.kind).toBe("undo")
      expect(undo.undo).toEqual({ available: false, of: enabled })
      // 06 §4.12 (2026-10-27): the areas were made inside the main folder, so the kept one stays nested in it.
      expect(undo.summary?.lines).toEqual([
        { kind: "area", areaID: kept.id, change: "touched" },
        { kind: "lock-kept", directory: expect.stringMatching(/[\\/]work$/) },
      ])
      // The untouched area's folder and branch are gone, the touched one is kept and no longer locked.
      expect(await worktreeNames(team.commonDir)).toEqual(["home", "save-v3", "work"])
      expect(fs.existsSync(removed.directory)).toBe(false)
      expect(await Refs.read(team.commonDir, "refs/heads/inventory-ui")).toBeNull()
      expect(await Refs.read(team.commonDir, "refs/heads/save-v3")).toBe(kept.base.sha)
      expect(await lockOf(team.commonDir, "save-v3")).toBeNull()
      expect(fs.readFileSync(path.join(kept.directory, "notes.txt"), "utf8")).toBe("mine\n")
      // Sessions are archived, never deleted; the touched area's conversation is left as it was.
      expect(h.backend.sessions.get(removed.owner.sessionID!)?.metadata).toEqual({ [Undo.ARCHIVED]: true })
      expect(h.backend.sessions.get(team.main.sessionID)?.metadata).toEqual({ [Undo.ARCHIVED]: true })
      expect(h.backend.sessions.get(kept.owner.sessionID!)?.metadata).toEqual({})
      expect(h.backend.sessions.has(team.main.sessionID)).toBe(true)
      // The home had no lock before, but the kept area is nested in it: it keeps the nested-worktrees lock (3.8, TI-12),
      // so removing the home cannot take the area's work along. The registry is gone, the enable is marked undone.
      expect(await lockOf(team.commonDir, "work")).toBe(TeamHome.NESTED)
      expect(await h.services.registry.teams.get(teamID)).toBeUndefined()
      expect(await h.services.registry.areas.list(teamID)).toEqual([])
      expect(await rpc(h.services)("team.get", { directory: repo.work })).toMatchObject({ team: null })
      expect((await h.services.journal.get(teamID, enabled))?.undo).toEqual({ available: false, by: undoID })
      expect(await rpc(h.services)("op.undo", { opID: enabled })).toMatchObject({ type: "not_found" })
      // The op records stay, so the undo's result card still reads its op.
      expect(await rpc(h.services)("op.get", { opID: undoID })).toMatchObject({ op: { id: undoID, state: "done" } })

      // Enabling again makes a new team main: the archived one is never adopted again.
      fs.rmSync(kept.directory, { recursive: true, force: true })
      git(repo.primary, ["worktree", "prune"])
      h.backend.answer = '{"version":1}'
      const again = await started(h, "enable", { directory: repo.work, sessionID: "ses_user" })
      const second = await settle(h, teamID, again)
      expect(second.state).toBe("done")
      expect(Enable.context(second).mainSessionID).not.toBe(team.main.sessionID)
      expect(h.mains).toHaveLength(2)
    },
    SLOW,
  )

  test(
    "an ignored file the user made in an area counts as touched: the undo keeps the area and the file",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      h.backend.answer = TWO_AREAS
      const enabled = await started(h, "enable", { directory: repo.work, sessionID: "ses_user" })
      const teamID = (await h.services.journal.find(enabled))!.teamID
      expect((await settle(h, teamID, enabled)).state).toBe("done")
      const team = (await h.services.registry.teams.get(teamID))!
      const kept = (await h.services.registry.areas.list(teamID)).find((area) => area.id === "ar_save-v3")!
      // A local config the user keeps out of git (`info/exclude` of the shared repository): `worktree remove` would
      // delete it without listing it.
      fs.mkdirSync(path.join(team.commonDir, "info"), { recursive: true })
      fs.appendFileSync(path.join(team.commonDir, "info", "exclude"), "\n.env.local\n")
      write(kept.directory, { ".env.local": "TOKEN=fake-local-value\n" })

      const undo = await settle(h, teamID, await started(h, "op.undo", { opID: enabled }))
      expect(undo.state).toBe("done")
      expect(undo.summary?.lines).toEqual([
        { kind: "area", areaID: kept.id, change: "touched" },
        { kind: "lock-kept", directory: expect.stringMatching(/[\\/]work$/) },
      ])
      expect(fs.readFileSync(path.join(kept.directory, ".env.local"), "utf8")).toBe("TOKEN=fake-local-value\n")
    },
    SLOW,
  )

  test(
    "link copies (06 §4.12): an edited file copy keeps its area; clean copies, a folder copy included, do not",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      h.backend.answer = TWO_AREAS
      const enabled = await started(h, "enable", { directory: repo.work, sessionID: "ses_user" })
      const teamID = (await h.services.journal.find(enabled))!.teamID
      expect((await settle(h, teamID, enabled)).state).toBe("done")
      const team = (await h.services.registry.teams.get(teamID))!
      const exclude = path.join(team.commonDir, "info", "exclude")
      // The copies as `worktree-create` writes them (skip-worktree, the folder copy excluded), recorded on each area.
      const areas = await linkCopies(h, teamID)
      expect(fs.readFileSync(exclude, "utf8")).toContain("/src/app/lib/")
      const kept = areas.find((area) => area.id === "ar_save-v3")!
      const removed = areas.find((area) => area.id === "ar_inventory-ui")!
      // The flag hides this edit from `status`; only the record shows it.
      write(kept.directory, { "README-link.md": "the user's edit\n" })

      const undo = await settle(h, teamID, await started(h, "op.undo", { opID: enabled }))
      expect(undo.state).toBe("done")
      expect(undo.summary?.lines).toEqual([
        { kind: "area", areaID: kept.id, change: "touched" },
        { kind: "lock-kept", directory: expect.stringMatching(/[\\/]work$/) },
      ])
      expect(fs.existsSync(removed.directory)).toBe(false)
      expect(fs.readFileSync(path.join(kept.directory, "README-link.md"), "utf8")).toBe("the user's edit\n")
      // The kept folder still holds its folder copy, so its exclude line stays.
      expect(fs.readFileSync(exclude, "utf8")).toContain("/src/app/lib/")
    },
    SLOW,
  )

  test(
    "untouched areas with link copies are removed, and own's exclude lines go with the last folder copy",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      h.backend.answer = TWO_AREAS
      const enabled = await started(h, "enable", { directory: repo.work, sessionID: "ses_user" })
      const teamID = (await h.services.journal.find(enabled))!.teamID
      expect((await settle(h, teamID, enabled)).state).toBe("done")
      const team = (await h.services.registry.teams.get(teamID))!
      const exclude = path.join(team.commonDir, "info", "exclude")
      fs.mkdirSync(path.dirname(exclude), { recursive: true })
      fs.appendFileSync(exclude, "\n.env.local\n")
      await linkCopies(h, teamID)

      const undo = await settle(h, teamID, await started(h, "op.undo", { opID: enabled }))
      expect(undo.state).toBe("done")
      expect(undo.summary?.lines ?? []).toEqual([])
      expect(await worktreeNames(team.commonDir)).toEqual(["home", "work"])
      // The user's line stays; own's header and folder line are gone.
      const text = fs.readFileSync(exclude, "utf8")
      expect(text).toContain(".env.local")
      expect(text).not.toContain("/src/app/lib/")
      expect(text).not.toContain(Symlinks.EXCLUDE_HEADER)
    },
    SLOW,
  )

  test(
    "a conversation with messages counts as touched; ops other than enable, adopt and home cannot be undone",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      h.backend.answer = TWO_AREAS
      const enabled = await started(h, "enable", { directory: repo.work, sessionID: "ses_user" })
      const teamID = (await h.services.journal.find(enabled))!.teamID
      await settle(h, teamID, enabled)
      const commonDir = (await h.services.registry.teams.get(teamID))!.commonDir
      const areas = await h.services.registry.areas.list(teamID)
      for (const area of areas) h.backend.sessions.get(area.owner.sessionID!)!.messages = 1
      const undo = await settle(h, teamID, await started(h, "op.undo", { opID: enabled }))
      // Both areas stay inside the main folder (06 §4.12), which keeps the nested-worktrees lock: a `lock-kept` line.
      expect(undo.summary?.lines?.map((line) => (line.kind === "area" ? line.change : line.kind))).toEqual([
        "touched",
        "touched",
        "lock-kept",
      ])
      expect(await worktreeNames(commonDir)).toEqual(["home", "inventory-ui", "save-v3", "work"])
      expect(await lockOf(commonDir, "inventory-ui")).toBeNull()

      // A disable op is not undoable (turning the team on again is its way back).
      const other = linkedF1()
      const g = await setup()
      g.backend.add({ id: "ses_user", directory: other.work, model: MODEL })
      const on = await started(g, "enable", { directory: other.work, sessionID: "ses_user" })
      const otherTeam = (await g.services.journal.find(on))!.teamID
      await settle(g, otherTeam, on)
      const off = await started(g, "disable", { teamID: otherTeam })
      await settle(g, otherTeam, off)
      await settle(g, otherTeam, await started(g, "enable", { directory: other.work }))
      expect(await rpc(g.services)("op.undo", { opID: off })).toMatchObject({
        type: "unsupported",
        data: { feature: "undo" },
      })
    },
    SLOW,
  )

  test(
    "담당 대화 바꾸기: a kept area's seat loses the team's things, and talk in an earlier seat keeps the area",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      h.backend.answer = TWO_AREAS
      const enabled = await started(h, "enable", { directory: repo.work, sessionID: "ses_user" })
      const teamID = (await h.services.journal.find(enabled))!.teamID
      expect((await settle(h, teamID, enabled)).state).toBe("done")
      const areas = await h.services.registry.areas.list(teamID)
      // The area's seat as a seat move leaves it: the user's conversation seated with the owner's allows and
      // entries, the team-made one in `owner.previous`.
      const seat = async (area: OwnTeam.Area, release: boolean) => {
        const from = area.owner.sessionID!
        const to = SessionID.create()
        h.backend.add({ id: to, directory: area.directory })
        const held = [...(release ? [from] : []), to]
        for (const id of [from, to])
          h.world.sessions.set(id, {
            id,
            directory: area.directory,
            permissions: Permissions.merge([{ action: "computer", resource: "*", effect: "allow" }], "owner"),
          })
        for (const id of held) h.backend.sessions.get(id)!.entries = [...OWNER_ENTRIES, "user.note"]
        if (!release) h.world.sessions.get(from)!.permissions = [{ action: "computer", resource: "*", effect: "allow" }]
        await h.services.write(teamID, () =>
          h.services.registry.areas.put({
            ...area,
            owner: {
              sessionID: to,
              previous: [{ sessionID: from, endedAt: NOW, why: "seat" }],
              attached: true,
              ...(release ? { release: [from] } : {}),
            },
          }),
        )
        return { from, to, held }
      }
      // One area: the user talked in the new seat, and the old one is still to be released. The other: only the
      // old seat was talked in, before the move.
      const talked = await seat(areas[0]!, true)
      h.backend.sessions.get(talked.to)!.messages = 1
      const earlier = await seat(areas[1]!, false)
      h.backend.sessions.get(earlier.from)!.messages = 1

      const undo = await settle(h, teamID, await started(h, "op.undo", { opID: enabled }))
      expect(undo.state).toBe("done")
      expect(undo.summary?.lines?.map((line) => (line.kind === "area" ? line.change : line.kind))).toEqual([
        "touched",
        "touched",
        "lock-kept",
      ])
      for (const id of [...talked.held, ...earlier.held]) {
        expect(h.world.sessions.get(id)?.permissions).toEqual([{ action: "computer", resource: "*", effect: "allow" }])
        expect(h.backend.sessions.get(id)?.entries).toEqual(["user.note"])
        expect(h.backend.sessions.get(id)?.metadata).toEqual({})
      }
    },
    SLOW,
  )
})

/** An instance whose `session.move` moves the fake session (the test context has no `move`). */
function mover(world: World, backend: Backend, directory: string): Plugin.Context {
  const base = context(world, { directory }).ctx
  const session = {
    ...base.session,
    move: async (input: { readonly sessionID: string; readonly directory: string }) => {
      const found = backend.sessions.get(input.sessionID)
      if (found) found.directory = input.directory
    },
  }
  return { ...base, session }
}

describe("team.home", () => {
  test(
    "moves the main folder (lock, main session, record, old lock) and undo moves it back",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      const enabled = await started(h, "enable", { directory: repo.work, sessionID: "ses_user" })
      const teamID = (await h.services.journal.find(enabled))!.teamID
      await settle(h, teamID, enabled)
      const team = (await h.services.registry.teams.get(teamID))!
      const other = path.join(repo.root, "other")
      git(repo.primary, ["worktree", "add", "-q", "-b", "other-home", other, "main"])
      for (const directory of [repo.work, other])
        h.controller.attach({
          ctx: mover(h.world, h.backend, directory),
          directory,
          control: false,
          leader: () => false,
        })

      const call = rpc(h.services)
      expect(await call("team.home", { teamID, directory: path.join(repo.root, "nowhere") })).toMatchObject({
        type: "not_git",
      })
      const outside = temp("own-team-home-other-")
      cleanups.push(() => outside.dispose())
      const stranger = f1(outside.root)
      expect(await call("team.home", { teamID, directory: stranger.home })).toMatchObject({
        type: "path_forbidden",
        data: { why: "invalid" },
      })

      const moved = await settle(h, teamID, await started(h, "team.home", { teamID, directory: other }))
      expect(moved.state).toBe("done")
      expect(moved.steps.map((step) => [step.kind, step.state])).toEqual([
        ["team.lock", "done"],
        ["home.move", "done"],
        ["home.registry", "done"],
        ["team.release", "done"],
      ])
      const after = (await h.services.registry.teams.get(teamID))!
      expect(after.home).toMatchObject({ linked: true, chosenBy: "user" })
      expect(Identity.same(after.home.directory, other)).toBe(true)
      expect(Identity.same(h.backend.sessions.get(team.main.sessionID)!.directory, other)).toBe(true)
      expect(await lockOf(team.commonDir, "other")).toBe(TeamHome.reason(teamID))
      expect(await lockOf(team.commonDir, "work")).toBeNull()

      const undo = await settle(h, teamID, await started(h, "op.undo", { opID: moved.id }))
      expect(undo.state).toBe("done")
      const back = (await h.services.registry.teams.get(teamID))!
      expect(back.home).toEqual(team.home)
      expect(Identity.same(h.backend.sessions.get(team.main.sessionID)!.directory, repo.work)).toBe(true)
      expect(await lockOf(team.commonDir, "work")).toBe(TeamHome.reason(teamID))
      expect(await lockOf(team.commonDir, "other")).toBeNull()
      expect((await h.services.journal.get(teamID, moved.id))?.undo).toEqual({ available: false, by: undo.id })
    },
    SLOW,
  )
})
