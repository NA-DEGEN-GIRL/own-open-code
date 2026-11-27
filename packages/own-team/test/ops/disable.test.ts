// disable (06 §3.8 끄기, 그대로 두고 끄기) and 다시 켜기: waiting main requests cancelled and listed, main requests in an
// owner's queue counted, area locks released except a folder with worktrees nested inside (`own: nested worktrees
// inside`), sessions/branches/worktrees/instructions kept, team tools answering `팀 모드가 꺼져 있습니다`, team.get
// after it; enabling again converges and takes the locks again. `cleanup` (끝난 영역 정리하고 끄기, T3) with no finished
// area is the same op (the retirements are in test/plugin/t3-reorg.test.ts). Fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Identity } from "../../src/git/identity.js"
import { Refs } from "../../src/git/refs.js"
import { Worktree } from "../../src/git/worktree.js"
import { TeamHome } from "../../src/ops/home.js"
import { Areas } from "../../src/registry/area.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import type { Services } from "../../src/services.js"
import { MainTools } from "../../src/tools/main.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { f1, git, temp } from "../fixtures/repo.js"
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
  readonly directory: string
  readonly model?: Model.Ref
  inbox: unknown[]
}

class Backend {
  readonly service: FakeService = start()
  readonly sessions = new Map<string, Stored>()
  readonly prompts: string[] = []
  answer = JSON.stringify({
    version: 1,
    areas: [
      { slug: "inventory-ui", name: "인벤토리 화면", create: { from: "main" } },
      { slug: "save-v3", name: "세이브 v3", create: { from: "main" } },
    ],
  })

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
    this.service.routes.set("POST /api/worktree/refresh", () => new Response(null, { status: 204 }))
  }

  add(input: { readonly id: string; readonly directory: string; readonly model?: Model.Ref }) {
    const stored: Stored = { ...input, inbox: [] }
    this.sessions.set(stored.id, stored)
    const at = `/api/session/${stored.id}`
    this.service.routes.set(`GET ${at}`, () => Response.json({ data: view(stored) }))
    this.service.routes.set(`GET ${at}/inbox`, () => Response.json({ data: stored.inbox }))
    this.service.routes.set(`POST ${at}/generate`, (request) => {
      this.prompts.push(String(request.body))
      return Response.json({ data: { text: this.answer } })
    })
    return stored
  }
}

function view(item: Stored) {
  return {
    id: item.id,
    projectID: "prj_test",
    location: { directory: item.directory },
    time: { created: 1, updated: NOW },
    ...(item.model === undefined ? {} : { model: item.model }),
  }
}

const AreaArgs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  base: Schema.String,
  directory: Schema.String,
})

/** The team main and new areas of T1.14 as fakes; the outbox of T1.15 as a fake that cancels one area's requests. */
function features(backend: Backend, mains: Services.MainCreate[]): Partial<Services.Factories> {
  return {
    main: () => ({
      create: async (input) => {
        mains.push(input)
        if (!backend.sessions.has(input.sessionID)) backend.add({ id: input.sessionID, directory: input.directory })
        return { ok: true, sessionID: input.sessionID }
      },
      model: async () => undefined,
    }),
    areas: (services) => {
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
    },
    admit: (services) => ({
      dispatch: async () => ({ ok: false, error: "unsupported", message: "test", data: { feature: "outbox" } }),
      message: async () => ({ ok: true, guard: "limit" }),
      drain: async () => {},
      list: async () => ({ ok: true, items: [] }),
      cancel: async () => ({ ok: true }),
      // Cancels the first area's requests only; disable cancels what is left itself.
      cancelAll: async (input) => {
        const waiting = await services.registry.dispatches.waiting(input.teamID, "ar_inventory-ui")
        await services.write(input.teamID, async () => {
          for (const item of waiting) await services.registry.dispatches.put({ ...item, state: "cancelled" })
        })
        return waiting.map((item) => ({ areaID: item.areaID, dispatchID: item.id }))
      },
    }),
  }
}

async function setup() {
  const ownHome = await tempHome()
  cleanups.push(() => ownHome[Symbol.asyncDispose]())
  const backend = new Backend()
  const mains: Services.MainCreate[] = []
  const harness = controller(new World(), {
    directory: ownHome.root,
    clock: manual(NOW),
    home: ownHome.root,
    source: backend.service.source,
    features: features(backend, mains),
  })
  cleanups.push(() => harness.close())
  return { ...harness, backend, mains }
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

async function run(h: Harness, method: string, input: unknown) {
  const answer = await rpc(h.services)(method, input)
  const found = Schema.decodeUnknownOption(Started)(answer)
  if (found._tag === "None") throw new Error(`${method} failed: ${JSON.stringify(answer)}`)
  const deadline = Date.now() + 120_000
  const read = () => h.services.journal.find(found.value.opID)
  while ((await read())?.state === "running") {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
  const op = await read()
  if (!op) throw new Error("op is gone")
  return op
}

async function lockOf(commonDir: string, name: string) {
  const held = (await TeamHome.snapshot(commonDir)) ?? {}
  return Object.entries(held).find(([where]) => path.basename(where) === name)?.[1] ?? null
}

function dispatch(teamID: OwnTeam.TeamID, areaID: string, seq: number): OwnTeam.Dispatch {
  return {
    id: OwnTeam.DispatchID.create(),
    teamID,
    areaID: OwnTeam.AreaID.make(areaID),
    seq,
    from: "main",
    kind: "task",
    text: `요청 ${seq}`,
    state: "waiting",
    createdAt: NOW,
  }
}

describe("disable", () => {
  test(
    "cancels and lists waiting requests, counts queued ones, releases locks but keeps the nested home's, keeps the rest",
    async () => {
      const root = temp("own-team-disable-")
      cleanups.push(() => root.dispose())
      const repo = f1(root.root)
      git(repo.home, ["checkout", "-q", "-b", "dev"])
      const work = path.join(root.root, "work")
      git(repo.home, ["worktree", "add", "-q", work, "main"])
      // A worktree nested inside the home (like this user's .worktrees): the home keeps a lock when the team goes off.
      git(repo.home, ["worktree", "add", "-q", "-b", "nested", path.join(work, ".worktrees", "nested"), "main"])
      const h = await setup()
      h.backend.add({ id: "ses_user", directory: work, model: MODEL })
      const enabled = await run(h, "enable", { directory: work, sessionID: "ses_user" })
      expect(enabled.state).toBe("done")
      const teamID = enabled.teamID
      const team = (await h.services.registry.teams.get(teamID))!
      const areas = await h.services.registry.areas.list(teamID)
      const inventory = areas.find((area) => area.id === "ar_inventory-ui")!
      const waiting = [
        dispatch(teamID, "ar_inventory-ui", 0),
        dispatch(teamID, "ar_inventory-ui", 1),
        dispatch(teamID, "ar_save-v3", 0),
      ]
      await h.services.write(teamID, async () => {
        for (const item of waiting) await h.services.registry.dispatches.put(item)
      })
      h.backend.sessions.get(inventory.owner.sessionID!)!.inbox = [
        {
          id: "msg_queued",
          sessionID: inventory.owner.sessionID,
          type: "user",
          delivery: "queue",
          payload: { text: "<dispatch>", metadata: { [OwnTeam.DISPATCH_META]: { id: waiting[0]!.id } } },
        },
        {
          id: "msg_user",
          sessionID: inventory.owner.sessionID,
          type: "user",
          delivery: "queue",
          payload: { text: "hi" },
        },
      ]
      // No area has commits of its own: 끝난 영역 정리 retires nothing and turns the team off at once.
      const off = await run(h, "disable", { teamID, cleanup: true })
      expect(off.steps.some((step) => step.kind === "disable.cleanup")).toBe(false)
      expect(off.state).toBe("done")
      expect(off.undo).toEqual({ available: false })
      expect(off.summary?.lines).toEqual([
        { kind: "cancelled", areaID: OwnTeam.AreaID.make("ar_inventory-ui"), dispatchID: waiting[0]!.id },
        { kind: "cancelled", areaID: OwnTeam.AreaID.make("ar_inventory-ui"), dispatchID: waiting[1]!.id },
        { kind: "cancelled", areaID: OwnTeam.AreaID.make("ar_save-v3"), dispatchID: waiting[2]!.id },
        { kind: "queued", areaID: inventory.id, sessionID: inventory.owner.sessionID!, count: 1 },
        { kind: "lock-kept", directory: team.home.directory },
      ])
      const after = (await h.services.registry.teams.get(teamID))!
      expect(after.state).toBe("off")
      expect(await h.services.registry.dispatches.waiting(teamID)).toEqual([])
      expect(await lockOf(team.commonDir, "work")).toBe(TeamHome.NESTED)
      expect(await lockOf(team.commonDir, "inventory-ui")).toBeNull()
      expect(await lockOf(team.commonDir, "save-v3")).toBeNull()
      // Sessions, branches, worktrees and records stay.
      expect((await h.services.registry.areas.list(teamID)).map((area) => `${area.id}`)).toEqual([
        "ar_inventory-ui",
        "ar_save-v3",
      ])
      expect(fs.existsSync(inventory.directory)).toBe(true)
      expect(await Refs.read(team.commonDir, "refs/heads/inventory-ui")).toBe(inventory.base.sha)
      expect(h.backend.sessions.has(team.main.sessionID)).toBe(true)
      // Team tools answer that team mode is off; permissions were not rewritten.
      expect(await MainTools.check(h.services, team.main.sessionID)).toEqual({ ok: false, text: MainTools.TEAM_OFF })
      expect(await OwnerTools.check(h.services, inventory.owner.sessionID!)).toEqual({
        ok: false,
        text: MainTools.TEAM_OFF,
      })
      expect(await rpc(h.services)("team.get", { directory: work })).toMatchObject({
        team: { id: teamID, state: "off" },
        areas: [{ id: "ar_inventory-ui" }, { id: "ar_save-v3" }],
        waiting: {},
        op: null,
        pending: [],
      })
      expect(await rpc(h.services)("disable", { teamID })).toMatchObject({ type: "team_off" })

      // 다시 켜기: the same ids, the locks again, no judge, no new main.
      const again = await run(h, "enable", { directory: work })
      expect(again.state).toBe("done")
      expect((await h.services.registry.teams.get(teamID))?.state).toBe("on")
      expect(await lockOf(team.commonDir, "work")).toBe(TeamHome.reason(teamID))
      expect(await lockOf(team.commonDir, "inventory-ui")).toBe(Worktree.lockReason("ar_inventory-ui"))
      expect(h.mains).toHaveLength(1)
      expect(h.backend.prompts).toHaveLength(1)
      // The requests cancelled by 끄기 do not come back.
      expect(await h.services.registry.dispatches.waiting(teamID)).toEqual([])

      // Undoing that 다시 켜기 puts the team and its locks back as they were.
      const undo = await run(h, "op.undo", { opID: again.id })
      expect(undo.state).toBe("done")
      expect((await h.services.registry.teams.get(teamID))?.state).toBe("off")
      expect(await lockOf(team.commonDir, "work")).toBe(TeamHome.NESTED)
      expect(await lockOf(team.commonDir, "inventory-ui")).toBeNull()
    },
    SLOW,
  )
})
