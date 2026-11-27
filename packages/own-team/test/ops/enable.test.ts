// enable (06 §3.1, §3.6, §3.7 새 프로젝트, §3.8 다시 켜기; TG2 at plugin level): the main first, then the judge on it
// (self-HTTP `session.generate`, one retry, then the rule-based proposal), V-rules, new areas through the areas service,
// the summary card's lines (the heavy line, adopted folders). F1 and F2 with a fake judge proposing 0 and 2 areas, a
// crash between steps resuming to the same result, a second enable converging, a failed enable retried with its own
// ids. Every value is fake; the service is a fake on 127.0.0.1 and nothing reads this PC's accounts.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, Preset } from "@own/protocol"
import { Identity } from "../../src/git/identity.js"
import { Measure } from "../../src/git/measure.js"
import { Refs } from "../../src/git/refs.js"
import { Worktree } from "../../src/git/worktree.js"
import { JudgeFallback } from "../../src/judge/fallback.js"
import { JudgePrompt } from "../../src/judge/prompt.js"
import { Enable } from "../../src/ops/enable.js"
import { TeamHome } from "../../src/ops/home.js"
import { Areas } from "../../src/registry/area.js"
import { Teams } from "../../src/registry/team.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import type { Services } from "../../src/services.js"
import { F4_REFS, f4Accounts } from "../fixtures/f4-layout.js"
import { f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { commit, f1, git, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { World, controller, tempHome } from "../support/context.js"
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
  readonly projectID: string
  readonly model?: Model.Ref
  readonly parentID?: string
  readonly updated: number
  metadata: Record<string, unknown>
}

/** The own service as enable sees it: sessions, the judge's answers, metadata writes and worktree refreshes. */
class Backend {
  readonly service: FakeService = start()
  readonly sessions = new Map<string, Stored>()
  readonly prompts: string[] = []
  readonly refreshes: unknown[] = []
  answer: (prompt: string) => Response | string | Promise<Response | string> = () => '{"version":1}'

  constructor() {
    cleanups.push(() => this.service.stop())
    this.service.routes.set("GET /api/session", (request) => {
      const rows = [...this.sessions.values()]
        .filter(
          (item) => request.query.directory === undefined || Identity.same(item.directory, request.query.directory),
        )
        .filter((item) => request.query.project === undefined || item.projectID === request.query.project)
        .filter((item) => request.query.parentID !== "null" || item.parentID === undefined)
        .toSorted((a, b) => b.updated - a.updated)
        .slice(0, Number(request.query.limit ?? 100))
      return Response.json({ data: rows.map(view), cursor: {} })
    })
    this.service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    this.service.routes.set("POST /api/worktree/refresh", (request) => {
      this.refreshes.push(request.body)
      return new Response(null, { status: 204 })
    })
  }

  add(input: Omit<Stored, "metadata" | "projectID" | "updated"> & { readonly updated?: number }) {
    const stored: Stored = { projectID: "prj_test", updated: NOW - 60_000, metadata: {}, ...input }
    this.sessions.set(stored.id, stored)
    const at = `/api/session/${stored.id}`
    this.service.routes.set(`GET ${at}`, () => Response.json({ data: view(stored) }))
    this.service.routes.set(`PATCH ${at}`, (request) => {
      const body = Schema.decodeUnknownSync(Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) }))(
        request.body,
      )
      stored.metadata = { ...body.metadata }
      return new Response(null, { status: 204 })
    })
    this.service.routes.set(`GET ${at}/message`, () => Response.json({ data: [], cursor: {} }))
    this.service.routes.set(`GET ${at}/inbox`, () => Response.json({ data: [] }))
    this.service.routes.set(`POST ${at}/generate`, async (request) => {
      const prompt = Schema.decodeUnknownSync(Schema.Struct({ prompt: Schema.String }))(request.body).prompt
      this.prompts.push(prompt)
      const answer = await this.answer(prompt)
      return answer instanceof Response ? answer : Response.json({ data: { text: answer } })
    })
    return stored
  }
}

function view(item: Stored) {
  return {
    id: item.id,
    projectID: item.projectID,
    location: { directory: item.directory },
    time: { created: 1, updated: item.updated },
    metadata: item.metadata,
    ...(item.model === undefined ? {} : { model: item.model }),
    ...(item.parentID === undefined ? {} : { parentID: item.parentID }),
  }
}

/** A gate a fake step waits on: `reached` resolves when the step got there. */
function gate() {
  const reached = Promise.withResolvers<void>()
  const open = Promise.withResolvers<void>()
  return { reached: reached.promise, wait: () => (reached.resolve(), open.promise), open: () => open.resolve() }
}

interface Fakes {
  readonly mains: Services.MainCreate[]
  mainGate?: ReturnType<typeof gate>
  mainFails?: number
  areaGate?: ReturnType<typeof gate>
  /** The `from` of every area plan, in order. */
  froms?: Array<string | undefined>
  /** With it, a team context that records each push: the team's state and the judge calls made by then. */
  pushes?: Array<{ readonly state: OwnTeam.Team["state"] | undefined; readonly prompts: number }>
}

/** The team main of T1.14 as a fake: records the call and makes the session in the fake service. */
function mainFeature(backend: Backend, fakes: Fakes): Services.Factories["main"] {
  return () => ({
    create: async (input) => {
      fakes.mains.push(input)
      await fakes.mainGate?.wait()
      if ((fakes.mainFails ?? 0) > 0) {
        fakes.mainFails = (fakes.mainFails ?? 0) - 1
        return { ok: false, error: "internal_error", message: "팀 메인 대화를 만들지 못했어요", data: {} }
      }
      if (!backend.sessions.has(input.sessionID))
        backend.add({ id: input.sessionID, directory: input.directory, model: input.model, updated: NOW })
      return { ok: true, sessionID: input.sessionID }
    },
    model: async () => undefined,
  })
}

/** A team context that binds nothing and records each push. */
function teamContextFeature(backend: Backend, pushes: NonNullable<Fakes["pushes"]>): Services.Factories["teamContext"] {
  return (services) => ({
    get: async () => null,
    push: async (teamID) => {
      pushes.push({ state: (await services.registry.teams.get(teamID))?.state, prompts: backend.prompts.length })
    },
  })
}

const AreaArgs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  base: Schema.String,
  directory: Schema.String,
})

/** New areas of T1.14 as a fake: one step that makes a real locked worktree, an owner session and the record. */
function areasFeature(backend: Backend, fakes: Fakes): Services.Factories["areas"] {
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
        await fakes.areaGate?.wait()
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
        if (!made.ok || made.state !== "ready") return { ok: false, note: made.ok ? "confirm" : made.message }
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
        fakes.froms?.push(input.from)
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

async function setup(input: { readonly backend?: Backend; readonly fakes?: Fakes; readonly world?: World } = {}) {
  const ownHome = await tempHome()
  cleanups.push(() => ownHome[Symbol.asyncDispose]())
  const backend = input.backend ?? new Backend()
  const fakes = input.fakes ?? { mains: [] }
  const world = input.world ?? new World()
  const harness = controller(world, {
    directory: ownHome.root,
    clock: manual(NOW),
    home: ownHome.root,
    source: backend.service.source,
    features: {
      main: mainFeature(backend, fakes),
      areas: areasFeature(backend, fakes),
      ...(fakes.pushes === undefined ? {} : { teamContext: teamContextFeature(backend, fakes.pushes) }),
    },
  })
  cleanups.push(() => harness.close())
  return { ...harness, backend, fakes, world }
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

async function enable(
  h: Harness,
  input: {
    readonly directory: string
    readonly sessionID?: string
    readonly hint?: string
    readonly areaRoot?: OwnTeam.AreaRoot
  },
) {
  const answer = await rpc(h.services)("enable", input)
  const started = Schema.decodeUnknownOption(Started)(answer)
  if (started._tag === "None") throw new Error(`enable failed: ${JSON.stringify(answer)}`)
  return settle(h, started.value.opID)
}

async function settle(h: Pick<Harness, "services">, opID: string) {
  await until(async () => {
    const op = await h.services.journal.find(opID)
    return op !== undefined && op.state !== "running"
  })
  const op = await h.services.journal.find(opID)
  if (!op) throw new Error(`op ${opID} is gone`)
  return op
}

async function until(check: () => Promise<boolean>, ms = 120_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

/** F1 with `main` checked out in a linked worktree `work` (the primary is on `dev`) and a user session there. */
function linkedF1() {
  const root = temp("own-team-enable-")
  cleanups.push(() => root.dispose())
  const repo = f1(root.root)
  git(repo.home, ["checkout", "-q", "-b", "dev"])
  const work = path.join(root.root, "work")
  git(repo.home, ["worktree", "add", "-q", work, "main"])
  return { root: root.root, primary: repo.home, work, head: repo.head }
}

const TWO_AREAS = JSON.stringify({
  version: 1,
  target: "main",
  areas: [
    { slug: "inventory-ui", name: "인벤토리 화면", goal: "정렬 버그", adopt: null, create: { from: "main" } },
    { slug: "save-v3", name: "세이브 v3", adopt: null, create: { from: "main" } },
  ],
  commands: { setup: "rm -rf /", code: [] },
  notes: "두 줄기로 나눴습니다",
})

function locks(commonDir: string) {
  return TeamHome.snapshot(commonDir)
}

async function areaIDs(h: Pick<Harness, "services">, teamID: string) {
  return (await h.services.registry.areas.list(teamID)).map((area) => `${area.id}`)
}

describe("enable", () => {
  test(
    "F1, judge proposes 0 areas: main first, one judge call on it, the team on, the card's note",
    async () => {
      const root = temp("own-team-enable-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      h.backend.answer = () =>
        'Proposal:\n{ "version": 1, "areas": [], "notes": "작은 일 하나라 영역을 만들지 않았습니다" }'
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        ["enable.observe", "done"],
        ["enable.main", "done"],
        ["enable.registry", "done"],
        ["enable.judge", "done"],
        ["enable.refresh", "done"],
        ["enable.finish", "done"],
      ])
      expect(h.fakes.mains).toHaveLength(1)
      const main = h.fakes.mains[0]!
      expect(main.model).toEqual(MODEL)
      expect(Identity.same(main.directory, repo.home)).toBe(true)
      // The judge ran once on the main session, within the budget.
      expect(h.backend.prompts).toHaveLength(1)
      expect(JudgePrompt.estimate(h.backend.prompts[0]!)).toBeLessThanOrEqual(JudgePrompt.MAX_TOKENS)
      const team = await h.services.registry.teams.get(op.teamID)
      expect(team).toMatchObject({
        state: "on",
        target: "main",
        projectID: "prj_test",
        main: { sessionID: main.sessionID },
      })
      expect(team?.home).toMatchObject({ linked: false, chosenBy: "session" })
      // 4.12 (2026-10-27): new areas go inside the main folder, ignored through `info/exclude` (no file changes).
      expect(Identity.same(team?.worktreeRoot ?? "", path.join(repo.home, ".worktrees"))).toBe(true)
      expect(fs.readFileSync(path.join(repo.home, ".git", "info", "exclude"), "utf8")).toContain(
        "# own.team area folders (06 §4.12)\n/.worktrees/\n",
      )
      expect(git(repo.home, ["status", "--porcelain"])).toBe("")
      expect(op.teamID).toBe(Teams.id(path.join(repo.home, ".git")))
      expect(op.summary?.lines).toEqual([{ kind: "notes", text: "작은 일 하나라 영역을 만들지 않았습니다" }])
      expect(h.backend.refreshes).toEqual([{ projectID: "prj_test" }])
      expect(await h.services.registry.areas.list(op.teamID)).toEqual([])
      const got = await rpc(h.services)("team.get", { directory: repo.home })
      expect(got).toMatchObject({ team: { id: op.teamID }, areas: [], waiting: {}, op: null, pending: [] })
    },
    SLOW,
  )

  test(
    "F1 with a linked home, judge proposes 2 areas: home locked, areas made, V10 drops the made-up command",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      h.backend.answer = () => TWO_AREAS
      const op = await enable(h, { directory: repo.primary, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      const team = await h.services.registry.teams.get(op.teamID)
      expect(team?.home).toMatchObject({ linked: true, chosenBy: "session" })
      expect(Identity.same(team?.home.directory ?? "", repo.work)).toBe(true)
      expect(team?.commands).toEqual({ setup: null, code: [], assets: [] })
      expect(op.steps.map((step) => step.kind)).toEqual([
        "enable.observe",
        "enable.main",
        "enable.registry",
        "enable.judge",
        "team.lock",
        "test.area",
        "test.area",
        "enable.refresh",
        "enable.finish",
      ])
      expect((await areaIDs(h, op.teamID)).toSorted()).toEqual(["ar_inventory-ui", "ar_save-v3"])
      const held = await locks(team!.commonDir)
      expect(
        Object.entries(held ?? {})
          .map(([where, why]) => [path.basename(where), why])
          .toSorted(),
      ).toEqual([
        ["inventory-ui", Worktree.lockReason("ar_inventory-ui")],
        ["save-v3", Worktree.lockReason("ar_save-v3")],
        ["work", TeamHome.reason(op.teamID)],
      ])
      expect(op.summary?.lines).toEqual([
        { kind: "area", areaID: OwnTeam.AreaID.make("ar_inventory-ui"), change: "created" },
        { kind: "area", areaID: OwnTeam.AreaID.make("ar_save-v3"), change: "created" },
        { kind: "notes", text: "두 줄기로 나눴습니다" },
      ])
      // The main was made before the judge ran on it (3.4).
      expect(h.fakes.mains).toHaveLength(1)
      expect(h.backend.prompts).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "an area created from another new area of the proposal starts where that one starts (V2)",
    async () => {
      const root = temp("own-team-enable-from-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const h = await setup({ fakes: { mains: [], froms: [] } })
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      h.backend.answer = () =>
        JSON.stringify({
          version: 1,
          areas: [
            { slug: "inventory-ui", name: "인벤토리 화면", create: { from: "main" } },
            { slug: "inventory-api", name: "인벤토리 API", create: { from: "inventory-ui" } },
          ],
        })
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      expect(h.fakes.froms).toEqual(["main", "main"])
      expect((await areaIDs(h, op.teamID)).toSorted()).toEqual(["ar_inventory-api", "ar_inventory-ui"])
    },
    SLOW,
  )

  test(
    "no area limit (2026-11-14): enable makes every area the judge proposes, five here, with no plan first",
    async () => {
      const root = temp("own-team-enable-five-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      const slugs = ["map", "items", "shapes", "monsters", "boss"]
      h.backend.answer = () =>
        JSON.stringify({
          version: 1,
          areas: slugs.map((slug) => ({ slug, name: slug, adopt: null, create: { from: "main" } })),
        })
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      expect(op.steps.filter((step) => step.kind === "test.area")).toHaveLength(5)
      expect((await areaIDs(h, op.teamID)).toSorted()).toEqual(slugs.map((slug) => `ar_${slug}`).toSorted())
      expect(op.summary?.lines?.filter((line) => line.kind === "skipped")).toEqual([])
    },
    SLOW,
  )

  test(
    "프로젝트 옆 폴더 (areaRoot beside, 4.12): <home>-team as before, info/exclude untouched; 다시 켜기 keeps it",
    async () => {
      const root = temp("own-team-enable-beside-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const exclude = path.join(repo.home, ".git", "info", "exclude")
      const before = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : ""
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      h.backend.answer = () => '{ "version": 1, "areas": [] }'
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user", areaRoot: "beside" })
      expect(op.state).toBe("done")
      const team = await h.services.registry.teams.get(op.teamID)
      expect(Identity.same(team?.worktreeRoot ?? "", `${repo.home}-team`)).toBe(true)
      expect(fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "").toBe(before)
      // 3.8: off and on again (asking for the other place) keeps the place the team has.
      const off = await rpc(h.services)("disable", { teamID: op.teamID })
      const stopped = Schema.decodeUnknownOption(Started)(off)
      if (stopped._tag === "None") throw new Error(`disable failed: ${JSON.stringify(off)}`)
      expect((await settle(h, stopped.value.opID)).state).toBe("done")
      expect((await enable(h, { directory: repo.home, areaRoot: "inside" })).state).toBe("done")
      expect((await h.services.registry.teams.get(op.teamID))?.worktreeRoot).toBe(team?.worktreeRoot)
    },
    SLOW,
  )

  test(
    "프로젝트 안 next to the user's own `.worktrees/` line: no second line of own's",
    async () => {
      const root = temp("own-team-enable-inside-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const exclude = path.join(repo.home, ".git", "info", "exclude")
      fs.appendFileSync(exclude, "\n.worktrees/\n")
      const before = fs.readFileSync(exclude, "utf8")
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      h.backend.answer = () => '{ "version": 1, "areas": [] }'
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user", areaRoot: "inside" })
      expect(op.state).toBe("done")
      const team = await h.services.registry.teams.get(op.teamID)
      expect(Identity.same(team?.worktreeRoot ?? "", path.join(repo.home, ".worktrees"))).toBe(true)
      expect(fs.readFileSync(exclude, "utf8")).toBe(before)
    },
    SLOW,
  )

  test.skipIf(!lfsAvailable)(
    "F2 (LFS): heavy folders recorded with the measured commit, LFS in use, areas made",
    async () => {
      const root = temp("own-team-enable-lfs-")
      cleanups.push(() => root.dispose())
      const repo = f2(root.root)
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      h.backend.answer = () =>
        JSON.stringify({
          version: 1,
          heavy: [
            { dir: "Assets/Textures", why: "LFS 그림" },
            { dir: "Assets/Audio", why: "소리" },
            { dir: "Content", why: "데이터" },
            { dir: "Nope", why: "없음" },
          ],
          areas: [
            { slug: "inventory-ui", name: "인벤토리 화면", needs: ["Assets/Textures"], create: { from: "main" } },
            { slug: "save-v3", name: "세이브 v3", create: { from: "main" } },
          ],
        })
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      const team = await h.services.registry.teams.get(op.teamID)
      // Outer folders first (V7), in the judge's order otherwise; `Nope` is not a tree of the target.
      expect(team?.heavy.dirs).toEqual(["Content", "Assets/Textures", "Assets/Audio"])
      expect(team?.heavy.measuredAt).toBe(repo.head)
      expect(team?.env.lfs).toBe("system")
      expect(await areaIDs(h, op.teamID)).toEqual(["ar_inventory-ui", "ar_save-v3"])
    },
    SLOW,
  )

  test(
    "an answer that does not decode is asked once more with the errors, then the rule-based proposal",
    async () => {
      const root = temp("own-team-enable-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      h.backend.answer = () => "영역은 하나면 충분합니다."
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      expect(h.backend.prompts).toHaveLength(2)
      expect(h.backend.prompts[1]).toContain("앞의 답은 쓸 수 없었습니다")
      expect(h.backend.prompts[1]).toContain("답에 JSON 객체가 없습니다")
      expect(op.steps.find((step) => step.kind === "enable.judge")?.note).toBe(JudgeFallback.NOTES)
      expect(op.summary?.lines).toContainEqual({ kind: "notes", text: JudgeFallback.NOTES })

      // A judge call that fails (the provider is down) falls back the same way; the op never fails because of it.
      const again = await setup()
      const other = temp("own-team-enable-")
      cleanups.push(() => other.dispose())
      const second = f1(other.root)
      again.backend.add({ id: "ses_user", directory: second.home, model: MODEL })
      again.backend.answer = () => Response.json({ _tag: "ProviderError", message: "down" }, { status: 503 })
      const fallback = await enable(again, { directory: second.home, sessionID: "ses_user" })
      expect(fallback.state).toBe("done")
      expect(again.backend.prompts).toHaveLength(2)
    },
    SLOW,
  )

  for (const point of ["main", "judge", "area"] as const)
    test(
      `a crash during the ${point} step resumes to the same result`,
      async () => {
        const repo = linkedF1()
        const world = new World()
        const backend = new Backend()
        backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
        const stuck = gate()
        const judged = gate()
        backend.answer = async () => {
          if (point === "judge" && backend.prompts.length === 1) await judged.wait()
          return TWO_AREAS
        }
        const fakes: Fakes = {
          mains: [],
          ...(point === "main" ? { mainGate: stuck } : {}),
          ...(point === "area" ? { areaGate: stuck } : {}),
        }
        const first = await setup({ backend, fakes, world })
        const answer = await rpc(first.services)("enable", { directory: repo.work, sessionID: "ses_user" })
        const opID = Schema.decodeUnknownSync(Started)(answer).opID
        await (point === "judge" ? judged.reached : stuck.reached)
        // The process dies here: the op stays `running` in KV.
        await first.close()
        delete fakes.mainGate
        delete fakes.areaGate
        const second = await setup({ backend, fakes, world })
        const op = await settle(second, opID)
        expect(op.state).toBe("done")
        // Same ids: the main create was retried with the id chosen ahead; areas exist once.
        expect(new Set(fakes.mains.map((call) => call.sessionID)).size).toBe(1)
        const team = await second.services.registry.teams.get(op.teamID)
        expect(team?.main.sessionID).toBe(fakes.mains[0]!.sessionID)
        expect(await areaIDs(second, op.teamID)).toEqual(["ar_inventory-ui", "ar_save-v3"])
        const listed = await Worktree.list(team!.commonDir)
        const paths = listed.ok ? listed.worktrees.map((item) => path.basename(item.path)) : []
        expect(paths.filter((name) => name === "inventory-ui" || name === "save-v3").toSorted()).toEqual([
          "inventory-ui",
          "save-v3",
        ])
        expect(op.summary?.lines?.filter((line) => line.kind === "area")).toHaveLength(2)
        stuck.open()
        judged.open()
      },
      SLOW,
    )

  test(
    "a second enable is busy while the first runs, then converges on the same ids without judging again",
    async () => {
      const repo = linkedF1()
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.work, model: MODEL })
      h.backend.answer = () => TWO_AREAS
      const call = rpc(h.services)
      const first = Schema.decodeUnknownSync(Started)(
        await call("enable", { directory: repo.work, sessionID: "ses_user" }),
      )
      expect(await call("enable", { directory: repo.primary })).toMatchObject({
        type: "busy",
        data: { opID: first.opID, kind: "enable" },
      })
      const done = await settle(h, first.opID)
      expect(done.state).toBe("done")
      const before = await h.services.registry.teams.get(done.teamID)
      // A lock that went missing comes back on 다시 켜기.
      git(repo.primary, ["worktree", "unlock", path.join(before!.worktreeRoot, "save-v3")])
      const again = await enable(h, { directory: repo.primary })
      expect(again.state).toBe("done")
      expect(again.steps.map((step) => [step.kind, step.state])).toEqual([
        ["enable.observe", "done"],
        ["team.lock", "done"],
        ["team.lock", "done"],
        ["team.lock", "done"],
        ["enable.registry", "done"],
        ["enable.refresh", "done"],
        ["enable.finish", "done"],
      ])
      expect(h.fakes.mains).toHaveLength(1)
      expect(h.backend.prompts).toHaveLength(1)
      const after = await h.services.registry.teams.get(done.teamID)
      expect(after?.main.sessionID).toBe(before?.main.sessionID)
      expect(await areaIDs(h, done.teamID)).toEqual(["ar_inventory-ui", "ar_save-v3"])
      const held = await locks(after!.commonDir)
      expect(Object.values(held ?? {}).toSorted()).toEqual(
        [
          Worktree.lockReason("ar_inventory-ui"),
          Worktree.lockReason("ar_save-v3"),
          TeamHome.reason(done.teamID),
        ].toSorted(),
      )
    },
    SLOW,
  )

  test(
    "a failed enable is retried with its own steps and ids",
    async () => {
      const root = temp("own-team-enable-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const h = await setup({ fakes: { mains: [], mainFails: 1 } })
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      const failed = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(failed.state).toBe("failed")
      expect(failed.steps.find((step) => step.kind === "enable.main")?.note).toBe("팀 메인 대화를 만들지 못했어요")
      // The record written before the op stays `off` until an enable gets through.
      expect(await h.services.registry.teams.get(failed.teamID)).toMatchObject({ state: "off" })
      const retried = await enable(h, { directory: repo.home })
      expect(retried.state).toBe("done")
      expect(retried.id).not.toBe(failed.id)
      expect(h.fakes.mains.map((call) => call.sessionID)).toEqual([
        h.fakes.mains[0]!.sessionID,
        h.fakes.mains[0]!.sessionID,
      ])
      expect(Enable.context(retried).mainSessionID).toBe(Enable.context(failed).mainSessionID)

      // A failed enable can be undone although its team never went on; the next enable starts with a new main.
      const other = temp("own-team-enable-")
      cleanups.push(() => other.dispose())
      const second = f1(other.root)
      const g = await setup({ fakes: { mains: [], mainFails: 1 } })
      g.backend.add({ id: "ses_user", directory: second.home, model: MODEL })
      const broken = await enable(g, { directory: second.home, sessionID: "ses_user" })
      expect(broken.state).toBe("failed")
      const undoID = Schema.decodeUnknownSync(Started)(await rpc(g.services)("op.undo", { opID: broken.id })).opID
      await until(async () => (await g.services.journal.get(broken.teamID, undoID))?.state === "done")
      expect(await g.services.registry.teams.get(broken.teamID)).toBeUndefined()
      const fresh = await enable(g, { directory: second.home, sessionID: "ses_user" })
      expect(fresh.state).toBe("done")
      expect(Enable.context(fresh).mainSessionID).not.toBe(Enable.context(broken).mainSessionID)
    },
    SLOW,
  )

  test(
    "commits only a detached HEAD holds get a keep ref first; the active folder is on the card, outside the team",
    async () => {
      const root = temp("own-team-enable-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const spike = path.join(root.root, "spike")
      git(repo.home, ["worktree", "add", "-q", "--detach", spike, "main"])
      write(spike, { "spike.txt": "idea\n" })
      const sha = commit(spike, "spike")
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => step.kind)).toEqual([
        "enable.observe",
        "enable.main",
        "enable.registry",
        "enable.judge",
        "enable.keep",
        "enable.refresh",
        "enable.finish",
      ])
      const team = (await h.services.registry.teams.get(op.teamID))!
      expect(await Refs.read(team.commonDir, `refs/own/keep/${sha}`)).toBe(sha)
      expect(op.summary?.lines).toContainEqual({ kind: "ref", ref: `refs/own/keep/${sha}`, sha })
      const unadopted = op.summary?.lines?.find((line) => line.kind === "unadopted")
      expect(unadopted).toMatchObject({ kind: "unadopted", changes: 0, ahead: 1 })
      expect(unadopted?.kind === "unadopted" && Identity.same(unadopted.directory, spike)).toBe(true)
      expect(team.external.find((item) => Identity.same(item.directory, spike))?.why).toBe("left")
      expect(h.published.some((event) => event.name === "notice" && event.data.kind === "detached.kept")).toBe(true)
    },
    SLOW,
  )

  test(
    "without a conversation the main gets the 07 §2.2 new-session value",
    async () => {
      const root = temp("own-team-enable-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const h = await setup()
      h.world.accounts.set("accounts.list", () => ({
        revision: 1,
        accounts: [
          { id: "acc_codex01", kind: "codex", providerID: "own-codex-aaaa", status: "ready" },
          { id: "acc_codex02", kind: "codex", providerID: "own-codex-bbbb", status: "ready" },
        ],
      }))
      h.world.accounts.set("presets.list", () => ({
        groups: [{ group: "codex", defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto" } }],
      }))
      // The home's conversation has no model; the project's most recent one (in a subfolder) names the account.
      h.backend.add({ id: "ses_home", directory: repo.home, updated: NOW - 3_600_000 })
      h.backend.add({
        id: "ses_sub",
        directory: path.join(repo.home, "src"),
        model: { id: Model.ID.make("gpt-6-luna"), providerID: Model.Ref.fields.providerID.make("own-codex-bbbb") },
      })
      const op = await enable(h, { directory: repo.home })
      expect(op.state).toBe("done")
      expect(h.fakes.mains[0]?.model).toEqual({
        ...MODEL,
        providerID: Model.Ref.fields.providerID.make("own-codex-bbbb"),
      })
    },
    SLOW,
  )

  test(
    "the heavy card line carries the heavy folders and the bytes a full checkout writes there (0.4, 9.3)",
    async () => {
      const root = temp("own-team-enable-heavy-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      h.backend.answer = () => JSON.stringify({ version: 1, heavy: [{ dir: "docs", why: "문서 묶음" }] })
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      const measured = await Measure.measure(repo.home, "main")
      if (!measured.ok) throw new Error(measured.message)
      const bytes = measured.rows.find((row) => row.dir === "docs")?.bytes ?? 0
      expect(bytes).toBeGreaterThan(0)
      expect(op.summary?.lines).toContainEqual({ kind: "heavy", dirs: ["docs"], bytes })
      expect((await h.services.registry.teams.get(op.teamID))?.heavy.dirs).toEqual(["docs"])
    },
    SLOW,
  )

  test(
    "an adopt proposal is adopted (T2), no longer listed as skipped",
    async () => {
      const repo = linkedF1()
      const feature = path.join(repo.root, "feature")
      git(repo.primary, ["worktree", "add", "-q", "-b", "feature-work", feature, "main"])
      write(feature, { "src/feature.ts": "export const feature = 1\n" })
      commit(feature, "feature")
      const h = await setup()
      const models = new Map<string, Model.Ref>([["ses_feature", F4_REFS.team]])
      f4Accounts(h.world.accounts, models)
      h.backend.add({ id: "ses_user", directory: repo.work, model: F4_REFS.team })
      h.backend.add({ id: "ses_feature", directory: feature, model: F4_REFS.team })
      h.backend.service.routes.set(
        "GET /api/experimental/session/ses_feature/log",
        () => new Response(`data: ${JSON.stringify({ type: "log.synced", aggregateID: "ses_feature", seq: 3 })}\n\n`),
      )
      h.backend.answer = () =>
        JSON.stringify({
          version: 1,
          areas: [{ slug: "feature", name: "기능", adopt: { worktree: feature, owner: "ses_feature" } }],
        })
      const op = await enable(h, { directory: repo.work, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      const areaID = OwnTeam.AreaID.make("ar_feature")
      expect(op.summary?.lines).toContainEqual({ kind: "area", areaID, change: "adopted" })
      expect(op.summary?.lines?.some((line) => line.kind === "skipped")).toBe(false)
      expect(op.summary?.lines?.some((line) => line.kind === "unadopted")).toBe(false)
      expect(await h.services.registry.areas.get(op.teamID, areaID)).toMatchObject({
        name: "feature",
        subtitle: "기능",
        origin: "adopted",
        branch: "feature-work",
        owner: { sessionID: "ses_feature", attached: false },
      })
      const team = (await h.services.registry.teams.get(op.teamID))!
      expect(team.external.some((item) => Identity.same(item.directory, feature))).toBe(false)
      expect(
        Object.entries((await locks(team.commonDir)) ?? {}).find(([where]) => path.basename(where) === "feature"),
      ).toEqual([expect.any(String), Worktree.lockReason(areaID)])
    },
    SLOW,
  )

  test(
    "the team context goes to the main once the team is on: `enable.main` bound its preset while the team was off",
    async () => {
      const root = temp("own-team-enable-context-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      const h = await setup({ fakes: { mains: [], pushes: [] } })
      h.backend.add({ id: "ses_user", directory: repo.home, model: MODEL })
      h.backend.answer = () => '{ "version": 1, "areas": [] }'
      const op = await enable(h, { directory: repo.home, sessionID: "ses_user" })
      expect(op.state).toBe("done")
      // Right after `enable.registry`, before the judge: nothing else binds the main now (no area Location boots).
      expect(h.fakes.pushes?.[0]).toEqual({ state: "on", prompts: 0 })
    },
    SLOW,
  )

  test("preflight errors come back as the declared errors", async () => {
    const h = await setup()
    const call = rpc(h.services)
    const plain = temp("own-team-plain-")
    cleanups.push(() => plain.dispose())
    expect(await call("enable", { directory: plain.root })).toMatchObject({ type: "not_git" })
    // A repository without a commit (06 §3.0): own-web offers the first commit (Git 저장소로 만들기).
    git(plain.root, ["init", "-q", "-b", "main"])
    expect(await call("enable", { directory: plain.root })).toMatchObject({
      type: "not_git",
      data: { directory: plain.root, unborn: true },
    })
    expect(await call("enable", { directory: "relative/dir" })).toMatchObject({
      type: "path_forbidden",
      data: { why: "invalid" },
    })
  })
})

describe("the main's model without a conversation (07 §2.2)", () => {
  const account = (
    id: string,
    kind: Account.View["kind"],
    providerID: string,
    status: Account.View["status"] = "ready",
  ): Account.View => ({
    id: Account.ID.make(id),
    kind,
    label: id,
    shortLabel: id.slice(4, 6),
    color: "indigo",
    providerID: Model.Ref.fields.providerID.make(providerID),
    billing: "subscription",
    status,
    autoSwitch: false,
    thirdParty: false,
    readOnly: false,
    connection: { type: "oauth" },
  })
  const groups: Preset.GroupView[] = [
    {
      group: "codex",
      defaultModel: { id: Model.ID.make("gpt-6-astra"), variant: Model.VariantID.make("high"), source: "auto" },
    },
    { group: "ds", defaultModel: { id: Model.ID.make("deepseek-flash"), source: "auto" } },
  ]
  const accounts = [
    account("acc_codex01", "codex", "own-codex-aaaa", "exhausted"),
    account("acc_codex02", "codex", "own-codex-bbbb"),
    account("acc_ds", "ds", "own-ds-cccc"),
  ]

  test("the home's last model first; else the most recent account when it can serve; else the first that can", () => {
    const luna = { id: Model.ID.make("gpt-6-luna"), providerID: accounts[1]!.providerID }
    const ds = { id: Model.ID.make("deepseek-pro"), providerID: accounts[2]!.providerID }
    expect(
      Enable.initialModel({
        sessions: [
          { directory: "D:/w/home", updated: 1, model: luna },
          { directory: "D:/w/other", updated: 2, model: ds },
        ],
        home: "d:\\w\\home",
        accounts,
        groups,
      }),
    ).toEqual(luna)
    expect(
      Enable.initialModel({
        sessions: [{ directory: "D:/w/other", updated: 2, model: ds }],
        home: "D:/w/home",
        accounts,
        groups,
      }),
    ).toEqual({ providerID: accounts[2]!.providerID, id: Model.ID.make("deepseek-flash") })
    // The most recent session's account is exhausted: the first account that can serve, with its group's default.
    const exhausted = { id: Model.ID.make("gpt-6-sol"), providerID: accounts[0]!.providerID }
    expect(
      Enable.initialModel({
        sessions: [{ directory: "D:/w/x", updated: 3, model: exhausted }],
        home: "D:/w/home",
        accounts,
        groups,
      }),
    ).toEqual({
      providerID: accounts[1]!.providerID,
      id: Model.ID.make("gpt-6-astra"),
      variant: Model.VariantID.make("high"),
    })
    expect(Enable.initialModel({ sessions: [], home: "D:/w/home", accounts: [], groups })).toBeUndefined()
  })

  test("the kind's default account (policy.defaults.byKind) comes before the most recent session's account", () => {
    const sol = { id: Model.ID.make("gpt-6-sol"), providerID: accounts[1]!.providerID }
    const third = account("acc_codex03", "codex", "own-codex-dddd")
    const sessions = [{ directory: "D:/w/x", updated: 3, model: sol }]
    expect(
      Enable.initialModel({
        sessions,
        home: "D:/w/home",
        accounts: [...accounts, third],
        groups,
        byKind: { codex: third.id },
      }),
    ).toEqual({ providerID: third.providerID, id: Model.ID.make("gpt-6-astra"), variant: Model.VariantID.make("high") })
    // A default account that cannot serve now is passed over.
    expect(
      Enable.initialModel({ sessions, home: "D:/w/home", accounts, groups, byKind: { codex: accounts[0]!.id } }),
    ).toEqual({ providerID: sol.providerID, id: Model.ID.make("gpt-6-astra"), variant: Model.VariantID.make("high") })
  })
})
