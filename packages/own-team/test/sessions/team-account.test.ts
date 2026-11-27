// 팀 계정 바꾸기 and following the team main (06 §10.1, §6.1–6.2, 07 §5.5 팀 전체로 넓힘; TG9 and TG15 T1 items, 07 PG2 (바)
// team side): the plan (areas, the old account's work, the estimate with `teamOp`, the R4 lines), `after-idle` (warm
// handoffs on the old account while the whole team is still there, the team main moving only when no team session or
// subagent works on the old account), `stop` and an exhausted old account (program handoffs, no turn on the old
// account), one ChatGPT login's codex → siwc move (no team-wide wait, no R4 line), the TUI path (the main moved first),
// and 팀과 같게 owners following a model or effort change at their next safe point.
// own.accounts, the owner creation, the handoff documents and the safe points are fakes; the own service is a fake
// HTTP server on 127.0.0.1 that records what own.team does.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnAccounts, OwnTeam, Preset } from "@own/protocol"
import type { Hub } from "../../src/hub.js"
import { Keys } from "../../src/registry/keys.js"
import type { Services } from "../../src/services.js"
import { TeamAccount } from "../../src/sessions/team-account.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, TEAM_ID, World, area, controller, team, tempHome } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"
import { viewIdentity } from "../support/views.js"

const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
const services: FakeService[] = []
afterAll(async () => {
  for (const home of homes) await home[Symbol.asyncDispose]()
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
})

const ref = Schema.decodeUnknownSync(Model.Ref)
const GPT_01 = ref({ id: "gpt-6-astra", providerID: "own-codex-01", variant: "high" })
const GPT_01_XHIGH = ref({ id: "gpt-6-astra", providerID: "own-codex-01", variant: "xhigh" })
const GPT_02 = ref({ id: "gpt-6-astra", providerID: "own-codex-02", variant: "high" })
const SIWC_01 = ref({ id: "gpt-6-astra", providerID: "own-siwc-01", variant: "high" })
const OPUS = ref({ id: "claude-opus-5", providerID: "anthropic" })

const ACCOUNTS = [
  {
    id: "acc_01",
    kind: "codex",
    label: "ChatGPT 01",
    providerID: "own-codex-01",
    billing: "subscription",
    status: "ready",
    identity: viewIdentity("codex", "login-a"),
  },
  {
    id: "acc_s1",
    kind: "siwc",
    label: "ChatGPT 01 앱",
    providerID: "own-siwc-01",
    billing: "subscription",
    status: "ready",
    identity: viewIdentity("siwc", "login-a"),
  },
  {
    id: "acc_02",
    kind: "codex",
    label: "ChatGPT 02",
    providerID: "own-codex-02",
    billing: "subscription",
    status: "ready",
    identity: viewIdentity("codex", "login-b"),
  },
  {
    id: "acc_claude_slot",
    kind: "claude-sub",
    label: "Claude",
    providerID: "anthropic",
    billing: "subscription",
    status: "ready",
  },
] as const

/** `Claude 리뷰 01`: the Claude group's preset whose review runs on ChatGPT 01 (fine while the team is on 01). */
const CLAUDE_GPT01: Preset.Info = {
  id: Preset.ID.create(),
  name: "Claude 리뷰 01",
  group: "claude-sub",
  workers: {
    mode: "by-role",
    roles: {
      "own-review": {
        targets: [{ pin: { account: Account.ID.make("acc_01"), model: Model.ID.make("gpt-6-astra") } }],
        effort: "inherit",
      },
    },
  },
  delegation: "model",
  caps: Preset.CAPS,
  ultraCaps: null,
  revision: 1,
}

const API = OwnTeam.AreaID.make("ar_api")
const DOCS = OwnTeam.AreaID.make("ar_docs")
const PERF = OwnTeam.AreaID.make("ar_perf")
const UI = OwnTeam.AreaID.make("ar_ui")
const API_OWNER = SessionID.make("ses_owner_api000000000000001")
const UI_OWNER = SessionID.make("ses_owner_ui0000000000000001")
const PERF_OWNER = SessionID.make("ses_owner_perf00000000000001")
const API_CHILD = SessionID.make("ses_child_api000000000000001")
const PERF_CHILD = SessionID.make("ses_child_perf00000000000001")

function event(type: string, data: Readonly<Record<string, unknown>>): Hub.Incoming {
  // SAFETY (test): an event with the fields own.team reads (`type`, `data`).
  return { id: `evt_${type}_${Math.random()}`, created: 1, type, data } as never
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

interface FakeSession {
  readonly directory: string
  model: Model.Ref
  readonly parentID?: string
  metadata: Readonly<Record<string, unknown>>
}

/** A fake core: sessions, the active set, inboxes, synthetic messages, interrupts and metadata; `log` keeps the order. */
function fakeCore(service: FakeService) {
  const sessions = new Map<string, FakeSession>()
  const active = new Set<string>()
  const inbox = new Map<string, Array<{ readonly id: string; readonly text: string; readonly metadata?: unknown }>>()
  const log: string[] = []
  service.routes.set("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  const add = (id: string, value: FakeSession) => {
    sessions.set(id, value)
    service.routes.set(`GET /api/session/${id}`, () => {
      const current = sessions.get(id)
      if (!current) return Response.json({ _tag: "SessionNotFoundError", message: id }, { status: 404 })
      return Response.json({
        data: session({
          id,
          directory: current.directory,
          model: current.model,
          metadata: current.metadata,
          ...(current.parentID === undefined ? {} : { parentID: current.parentID }),
        }),
      })
    })
    service.routes.set(`GET /api/session/${id}/inbox`, () =>
      Response.json({
        data: (inbox.get(id) ?? []).map((item) => ({
          id: item.id,
          sessionID: id,
          type: "synthetic",
          delivery: "queue",
          payload: { text: item.text },
        })),
      }),
    )
    service.routes.set(`POST /api/session/${id}/synthetic`, (request) => {
      const body = request.body as { readonly id: string; readonly text: string; readonly metadata?: unknown }
      inbox.set(id, [...(inbox.get(id) ?? []), body])
      log.push(`synthetic ${id}`)
      return Response.json({
        data: { id: body.id, sessionID: id, type: "synthetic", delivery: "queue", payload: { text: body.text } },
      })
    })
    // Every conversation has a message, so a rotation asks for a warm handoff (`Rotation` skips empty ones).
    service.routes.set(`GET /api/session/${id}/message`, () =>
      Response.json({ data: [{ id: "msg_01", sessionID: id }], cursor: {} }),
    )
    service.routes.set(`POST /api/session/${id}/interrupt`, () => {
      log.push(`interrupt ${id}`)
      const was = active.delete(id)
      return Response.json({ interrupted: was })
    })
    service.routes.set(`PATCH /api/session/${id}`, (request) => {
      const current = sessions.get(id)
      if (current)
        current.metadata = (request.body as { readonly metadata: Readonly<Record<string, unknown>> }).metadata
      return new Response(null, { status: 204 })
    })
  }
  return { sessions, active, inbox, log, add }
}

type Core = ReturnType<typeof fakeCore>

/** own.accounts: accounts, presets, bindings, the switch (it moves the session at once) and its state. */
function fakeAccounts(world: World, core: Core, options: { readonly blocked?: boolean }) {
  const bindings = new Map<string, { readonly presetID: string; readonly team?: Preset.Team | null }>()
  /** Sessions on another subscription of the target's company that worked when the team main switched. */
  const overlaps: string[][] = []
  const accountOf = (providerID: string) => ACCOUNTS.find((item) => item.providerID === providerID)
  const groupOf = (sessionID: string) => {
    const model = core.sessions.get(sessionID)?.model
    return model && accountOf(model.providerID)?.kind
  }
  world.accounts.set("accounts.list", () => ({ revision: 1, accounts: ACCOUNTS }))
  world.accounts.set("presets.list", () => ({
    groups: (["codex", "siwc", "claude-sub"] as const).map((group) => ({
      group,
      defaultModel: null,
      presets: [Preset.builtin(group), ...(group === "claude-sub" ? [CLAUDE_GPT01] : [])].map((item) => ({
        ...item,
        status: "ok",
      })),
    })),
  }))
  world.accounts.set("session.preset.get", (call) => {
    const sessionID = (call as { readonly sessionID: string }).sessionID
    const group = groupOf(sessionID)
    const binding = bindings.get(sessionID)
    const presetID = binding?.presetID ?? (group ? Preset.builtinID(group) : undefined)
    const preset =
      presetID === CLAUDE_GPT01.id && group === "claude-sub" ? CLAUDE_GPT01 : group ? Preset.builtin(group) : null
    return {
      binding: binding ? { presetID, group, revision: 1, appliedAt: 1, entryHash: null, team: binding.team } : null,
      preset,
      resolution: group ? { main: core.sessions.get(sessionID)?.model, roles: {} } : null,
      caps: Preset.CAPS,
      counts: { running: 0, message: 0, session: 0 },
      spend: 0,
    }
  })
  world.accounts.set("session.preset.apply", (call) => {
    const input = call as { readonly sessionID: string; readonly presetID: string; readonly team?: Preset.Team | null }
    bindings.set(input.sessionID, {
      presetID: input.presetID,
      ...(input.team === undefined ? {} : { team: input.team }),
    })
    return { binding: {}, resolution: null, entry: "unchanged", dryRun: false }
  })
  world.accounts.set("session.approval.get", () => ({ mode: "full", rules: [], children: { open: 0 } }))
  world.accounts.set("switch.state", () => ({ state: options.blocked ? "BLOCKED" : "STEADY" }))
  world.accounts.set("switch.cancel", () => ({ state: "STEADY" }))
  world.accounts.set("switch.estimate", (call) => ({
    estimateID: "est_test",
    target: (call as { readonly target: unknown }).target,
    busyChildren: null,
  }))
  world.accounts.set("switch.apply", (call) => {
    const input = call as { readonly sessionID: string; readonly target: Model.Ref }
    const to = accountOf(input.target.providerID)
    // Another ChatGPT login than the target's (every ChatGPT account here has a login; Claude is another company).
    const rival = (on: (typeof ACCOUNTS)[number] | undefined) =>
      on !== undefined &&
      "identity" in on &&
      to !== undefined &&
      "identity" in to &&
      on.identity?.login !== to.identity?.login
    overlaps.push([...core.active].filter((id) => rival(accountOf(core.sessions.get(id)?.model.providerID ?? ""))))
    core.log.push(`switch ${input.sessionID}`)
    const target = core.sessions.get(input.sessionID)
    if (target) target.model = input.target
    return { state: "STEADY" }
  })
  return { bindings, overlaps }
}

/** The handoff documents (T1.24's service) and owner creation (T1.14's) as fakes that record what they were asked. */
function fakeFeatures(core: Core, home: string) {
  const texts = new Map<string, string>()
  const writes: Array<{ readonly areaID: string; readonly by: string }> = []
  const programs: string[] = []
  const owners: Array<Parameters<Services.Owner["create"]>[0] & { readonly sessionID: SessionID }> = []
  const unsafe = new Set<string>()
  const handoff = (services: Services.Context): Services.Handoff => ({
    write: async (input) => {
      await services.write(input.teamID, async () => {
        const current = await services.registry.areas.get(input.teamID, input.areaID)
        if (current)
          await services.registry.areas.put({
            ...current,
            handoff: { file: `areas/${input.areaID}/handoff.md`, hash: `h-${input.by}`, at: services.clock.now() },
          })
      })
      texts.set(input.areaID, input.text)
      writes.push({ areaID: input.areaID, by: input.by })
      return { ok: true, file: `areas/${input.areaID}/handoff.md`, hash: `h-${input.by}` }
    },
    program: async (input) => {
      programs.push(input.areaID)
      return { ok: true, text: `# 인계: ${input.areaID} (프로그램)` }
    },
    read: async (input) => texts.get(input.areaID),
  })
  /**
   * Owner creation as `sessions/owner.ts` does it for a rotation: the write-ahead id in `owner.pending`, on the area main
   * or the team main's current Ref.
   */
  const owner = (services: Services.Context): Services.Owner => ({
    create: async (input) => {
      const sessionID = SessionID.create()
      const area = await services.write(input.teamID, async () => {
        const current = await services.registry.areas.get(input.teamID, input.areaID)
        if (current) await services.registry.areas.put({ ...current, owner: { ...current.owner, pending: sessionID } })
        return current
      })
      const model = input.model ?? area?.main?.model ?? core.sessions.get(MAIN_SESSION)?.model ?? GPT_01
      core.add(sessionID, { directory: path.join(`${home}-team`, input.areaID), model, metadata: {} })
      owners.push({ ...input, model, sessionID })
      core.log.push(`owner ${input.areaID}`)
      return { ok: true, sessionID }
    },
    attach: async () => ({ ok: true }),
  })
  /** An area folder is safe when nothing in its owner's tree runs (and the test did not mark it busy). */
  const safePoint = (services: Services.Context): Services.SafePoint => ({
    check: async (input) => {
      const area =
        input.areaID === undefined ? undefined : await services.registry.areas.get(input.teamID, input.areaID)
      const rootOf = (id: string): string => {
        const parent = core.sessions.get(id)?.parentID
        return parent === undefined ? id : rootOf(parent)
      }
      const busy = [...core.active].filter((id) => area !== undefined && rootOf(id) === area.owner.sessionID)
      if ((input.areaID !== undefined && unsafe.has(input.areaID)) || busy.length > 0)
        return { ok: false, why: "session", sessionIDs: busy.map((id) => SessionID.make(id)) }
      return { ok: true }
    },
  })
  return { texts, writes, programs, owners, unsafe, handoff, owner, safePoint }
}

/**
 * A ChatGPT 01 team: `ar_api` and `ar_ui` 팀과 같게 with owners, `ar_docs` with its own main on ChatGPT 01 (effort
 * 매우 높음) and no owner, `ar_perf` on the Claude slot with `Claude 리뷰 01`. `active` sessions work now; `API_CHILD`
 * (ChatGPT 01, a subagent of the api owner) and `PERF_CHILD` (ChatGPT 01, the perf owner's review) exist.
 */
async function setup(input: { readonly active?: ReadonlyArray<string>; readonly blocked?: boolean } = {}) {
  const home = await tempHome()
  homes.push(home)
  const service = start()
  services.push(service)
  const world = new World()
  const core = fakeCore(service)
  const worktrees = `${home.root}-team`
  core.add(MAIN_SESSION, { directory: home.root, model: GPT_01, metadata: {} })
  core.add(API_OWNER, { directory: path.join(worktrees, "api"), model: GPT_01, metadata: {} })
  core.add(UI_OWNER, { directory: path.join(worktrees, "ui"), model: GPT_01, metadata: {} })
  core.add(PERF_OWNER, { directory: path.join(worktrees, "perf"), model: OPUS, metadata: {} })
  core.add(API_CHILD, { directory: path.join(worktrees, "api"), model: GPT_01, parentID: API_OWNER, metadata: {} })
  core.add(PERF_CHILD, { directory: path.join(worktrees, "perf"), model: GPT_01, parentID: PERF_OWNER, metadata: {} })
  for (const id of input.active ?? []) core.active.add(id)
  const accounts = fakeAccounts(world, core, { blocked: input.blocked === true })
  const fakes = fakeFeatures(core, home.root)
  const clock = manual()
  const harness = controller(world, {
    directory: home.root,
    clock,
    source: service.source,
    features: { handoff: fakes.handoff, owner: fakes.owner, safePoint: fakes.safePoint },
  })
  const owned = (slug: string, owner: SessionID | null) => ({
    ...area({ slug, directory: path.join(worktrees, slug) }),
    owner: { sessionID: owner, previous: [], attached: true },
  })
  await harness.services.write(TEAM_ID, async () => {
    await harness.services.registry.teams.put(team({ home: home.root }))
    await harness.services.registry.areas.put(owned("api", API_OWNER))
    await harness.services.registry.areas.put(owned("ui", UI_OWNER))
    await harness.services.registry.areas.put({
      ...owned("docs", null),
      main: { model: GPT_01_XHIGH, chosenBy: "user" },
    })
    await harness.services.registry.areas.put({
      ...owned("perf", PERF_OWNER),
      main: { model: OPUS, chosenBy: "user" },
      preset: CLAUDE_GPT01.id,
    })
  })
  await harness.controller.resume()
  world.calls.length = 0
  harness.published.length = 0
  return { ...harness, world, service, core, clock, ...accounts, ...fakes }
}

type Harness = Awaited<ReturnType<typeof setup>>

/** The session stops working: core's active set and its `execution.succeeded` event. */
function idle(h: Harness, sessionID: string) {
  h.core.active.delete(sessionID)
  h.controller.hub.receive(event("session.execution.succeeded", { sessionID }))
}

/** The team main's Ref in core (a switch made outside own.team). */
function moveMain(h: Harness, model: Model.Ref) {
  const main = h.core.sessions.get(MAIN_SESSION)
  if (main) main.model = model
}

/** The owner's warm turn ends; with `write` it called `team_handoff` first. */
async function turn(h: Harness, sessionID: string, areaID: OwnTeam.AreaID, write: boolean) {
  await eventually(() => h.core.log.includes(`synthetic ${sessionID}`))
  if (write)
    await h.services.features().handoff.write({ teamID: TEAM_ID, areaID, text: `# 인계: ${areaID}`, by: "owner" })
  h.core.inbox.delete(sessionID)
  idle(h, sessionID)
}

const calls = (h: Harness, method: string) =>
  h.world.calls.filter((call) => call.method === method).map((call) => call.input as Readonly<Record<string, unknown>>)

const notices = (h: Harness) => h.published.flatMap((item) => (item.name === "notice" ? [item.data] : []))

async function stored(h: Harness, areaID: OwnTeam.AreaID) {
  return Schema.decodeUnknownSync(OwnTeam.Area)(h.world.kv.get(Keys.area(TEAM_ID, areaID)))
}

async function done(h: Harness, opID: string) {
  await eventually(async () => (await h.services.journal.find(opID))?.state === "done")
  const op = await h.services.journal.find(opID)
  if (!op) throw new Error("op is gone")
  return op
}

/**
 * A second Claude account `accountID` the team is bound to (`plugin.claudeAuth.session.get` of any member, 07 R4); a
 * session on `anthropic` is bound to it (`session.binding`), any other one to ChatGPT 01's or 02's account.
 */
function claudeTeam(h: Harness, accountID: string, label: string) {
  h.world.accounts.set("accounts.list", () => ({
    revision: 2,
    accounts: [...ACCOUNTS, { ...ACCOUNTS[3], id: accountID, label }],
  }))
  h.world.accounts.set("plugin.claudeAuth.session.get", () => ({ accountID, bound: true }))
  h.world.accounts.set("session.binding", (call) => ({
    bindings: (call as { readonly sessionIDs: ReadonlyArray<string> }).sessionIDs.map((sessionID) => {
      const model = h.core.sessions.get(sessionID)?.model
      return {
        sessionID,
        model: model ?? null,
        accountID:
          model?.providerID === "anthropic"
            ? accountID
            : (ACCOUNTS.find((item) => item.providerID === model?.providerID)?.id ?? null),
        builtin: false,
        thirdParty: false,
        home: null,
        switch: { state: "STEADY" },
      }
    }),
  }))
}

function opOf(result: Awaited<ReturnType<Services.AreaMain["account"]>>) {
  if (!result.ok || !("opID" in result)) throw new Error(`no op: ${JSON.stringify(result)}`)
  return result.opID
}

describe("team.account plan (06 §10.1 step 1)", () => {
  test("areas, the old account's work, the estimate with teamOp, and the preset targets that break R4", async () => {
    const h = await setup({ active: [UI_OWNER, API_CHILD, PERF_CHILD, PERF_OWNER] })
    const result = await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02, dryRun: true })
    if (!result.ok || !("plan" in result)) throw new Error(`no plan: ${JSON.stringify(result)}`)
    const plan = result.plan
    expect(plan.areas.toSorted((a, b) => a.areaID.localeCompare(b.areaID))).toEqual([
      { areaID: API, rotate: true, busy: true },
      { areaID: DOCS, rotate: false, busy: false },
      { areaID: UI, rotate: true, busy: true },
    ])
    // The ui owner on ChatGPT 01, the api subagent and the perf review on ChatGPT 01; the perf owner is on Claude.
    expect(plan.busy).toEqual({ sessions: 1, children: 2 })
    expect(plan.estimate).toMatchObject({ estimateID: "est_test" })
    const [estimate] = calls(h, "switch.estimate")
    expect(estimate).toMatchObject({ sessionID: MAIN_SESSION, target: GPT_02, reason: "manual" })
    expect(String(estimate?.teamOp)).toStartWith("op_")
    expect(plan.r4).toEqual([
      { areaID: PERF, presetID: CLAUDE_GPT01.id, accountID: Account.ID.make("acc_01"), roles: ["own-review"] },
    ])
    // A plan starts nothing.
    expect(await h.services.journal.active(TEAM_ID)).toBeUndefined()
    await h.close()
  })

  test("one ChatGPT login's codex → siwc move: no team-wide wait and no R4 line", async () => {
    const h = await setup({ active: [UI_OWNER, API_CHILD] })
    const result = await h.services.features().areaMain.account({ teamID: TEAM_ID, target: SIWC_01, dryRun: true })
    if (!result.ok || !("plan" in result)) throw new Error("no plan")
    expect(result.plan.busy).toEqual({ sessions: 0, children: 0 })
    expect(result.plan.r4).toEqual([])
    await h.close()
  })

  test("busy while another op runs; team_off", async () => {
    const h = await setup()
    await h.services.journal.put({
      id: OwnTeam.OpID.create(),
      teamID: TEAM_ID,
      kind: "rotate",
      by: "user",
      state: "waiting",
      createdAt: 1,
      steps: [],
    })
    expect(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02 })).toMatchObject({
      ok: false,
      error: "busy",
    })
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.teams.get(TEAM_ID)
      if (current) await h.services.registry.teams.put({ ...current, state: "off" })
    })
    expect(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02 })).toMatchObject({
      ok: false,
      error: "team_off",
    })
    await h.close()
  })
})

describe("team.account op (06 §10.1 steps 2–5)", () => {
  test("after-idle: warm handoffs on the old account, the main moves only when nothing works there, then new owners", async () => {
    const h = await setup({ active: [UI_OWNER, API_CHILD, PERF_CHILD] })
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02 }))
    // New main requests wait while the op runs (5.1 "손보는 중").
    expect((await h.services.journal.active(TEAM_ID))?.kind).toBe("team-account")
    await eventually(() => notices(h).some((item) => item.kind === "account.waiting"))
    expect(notices(h).find((item) => item.kind === "account.waiting")).toMatchObject({
      text: "팀 계정 바꾸기: ChatGPT 01에서 하던 일이 끝나기를 기다려요",
      data: { account: "ChatGPT 01" },
    })
    // api: its subagent ends, then the warm turn ends without a document: the program writes it.
    expect(h.core.log).toEqual([])
    idle(h, API_CHILD)
    await turn(h, API_OWNER, API, false)
    await eventually(() => h.programs.includes(API))
    // ui: the owner ends its run, then writes the document in the warm turn.
    idle(h, UI_OWNER)
    await turn(h, UI_OWNER, UI, true)
    await eventually(() => h.writes.some((item) => item.areaID === UI && item.by === "owner"))
    // The perf review still runs on ChatGPT 01: the team main waits for it.
    await Bun.sleep(50)
    expect(calls(h, "switch.apply")).toEqual([])
    idle(h, PERF_CHILD)
    const op = await done(h, opID)

    expect(calls(h, "switch.apply")).toEqual([
      {
        sessionID: MAIN_SESSION,
        target: GPT_02,
        strategy: "now",
        reason: "manual",
        teamOp: opID,
        children: "after-idle",
      },
    ])
    // Never two ChatGPT subscriptions at once: nothing worked on 01 when the main moved, and no owner was on 02 before.
    expect(h.overlaps).toEqual([[]])
    const switched = h.core.log.indexOf(`switch ${MAIN_SESSION}`)
    expect(h.core.log.indexOf(`synthetic ${API_OWNER}`)).toBeLessThan(switched)
    expect(h.core.log.indexOf(`synthetic ${UI_OWNER}`)).toBeLessThan(switched)
    expect(h.core.log.indexOf(`owner ${API}`)).toBeGreaterThan(switched)
    expect(h.core.log.indexOf(`owner ${UI}`)).toBeGreaterThan(switched)
    // The warm request is a queued synthetic message from own.team.
    const request = h.service.requests.find((item) => item.path === `/api/session/${UI_OWNER}/synthetic`)
    expect(request?.body).toMatchObject({ delivery: "queue", metadata: { source: OwnTeam.PROMPT_SOURCE } })
    expect(String((request?.body as { readonly text: string }).text)).toContain('<team-request kind="handoff"')

    // New owners on ChatGPT 02 with the old mode and the handoff; the old ones are 지난 대화 outside the team.
    expect(h.owners.map((item) => [item.areaID, item.model, item.approval, item.handoff]).toSorted()).toEqual(
      [
        [API, GPT_02, "full", `# 인계: ${API} (프로그램)`],
        [UI, GPT_02, "full", `# 인계: ${UI}`],
      ].toSorted(),
    )
    for (const [areaID, old] of [
      [API, API_OWNER],
      [UI, UI_OWNER],
    ] as const) {
      const after = await stored(h, areaID)
      expect(after.owner.sessionID).toBe(h.owners.find((item) => item.areaID === areaID)?.sessionID ?? null)
      expect(after.owner.previous).toEqual([{ sessionID: old, endedAt: expect.any(Number), why: "team-account" }])
      expect(h.core.sessions.get(old)?.metadata).toMatchObject({ "own.archived": true })
      expect(calls(h, "session.preset.apply")).toContainEqual(expect.objectContaining({ sessionID: old, team: null }))
    }
    // The chosen area main on the old account moves with the team; its model and effort stay.
    expect((await stored(h, DOCS)).main).toEqual({
      model: ref({ ...GPT_01_XHIGH, providerID: "own-codex-02" }),
      chosenBy: "user",
    })
    expect((await stored(h, PERF)).main).toEqual({ model: OPUS, chosenBy: "user" })
    // Every binding names the team's new account.
    expect(h.bindings.get(MAIN_SESSION)?.team?.accounts).toContain(Account.ID.make("acc_02"))
    expect(h.bindings.get(MAIN_SESSION)?.team?.accounts).not.toContain(Account.ID.make("acc_01"))
    expect(notices(h).find((item) => item.kind === "account.moved")).toMatchObject({
      text: "팀이 ChatGPT 02 계정으로 옮겼어요 · 영역 2개 새 대화",
      data: { account: "ChatGPT 02", n: 2 },
    })
    expect(op.summary?.lines).toEqual(
      expect.arrayContaining([
        { kind: "area", areaID: API, change: "rotated" },
        { kind: "area", areaID: UI, change: "rotated" },
        { kind: "account", model: GPT_02, areas: 2, accountID: Account.ID.make("acc_02") },
      ]),
    )
    expect(op.undo).toEqual({ available: false })
    await h.close()
  })

  test("stop: the old account's runs are interrupted and the program writes every handoff (no turn there)", async () => {
    const h = await setup({ active: [UI_OWNER, API_CHILD, PERF_CHILD] })
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02, mode: "stop" }))
    await done(h, opID)
    expect(h.core.log.filter((line) => line.startsWith("synthetic"))).toEqual([])
    expect(h.core.log).toEqual(
      expect.arrayContaining([`interrupt ${API_CHILD}`, `interrupt ${UI_OWNER}`, `interrupt ${PERF_CHILD}`]),
    )
    expect(h.programs.toSorted()).toEqual([API, UI])
    expect(calls(h, "switch.apply")[0]).toMatchObject({ children: "stop", teamOp: opID })
    expect(h.overlaps).toEqual([[]])
    await h.close()
  })

  // SL-8: several Claude accounts share `anthropic`; the card and the notice name the account the team main runs on,
  // not the first Claude account listed.
  test("a move to Claude names the Claude account the team main runs on", async () => {
    const h = await setup()
    claudeTeam(h, "acc_cl2", "AC-02")
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: OPUS, mode: "stop" }))
    const op = await done(h, opID)
    expect(op.summary?.lines).toContainEqual({
      kind: "account",
      model: OPUS,
      areas: 2,
      accountID: Account.ID.make("acc_cl2"),
    })
    expect(notices(h).find((item) => item.kind === "account.moved")).toMatchObject({
      text: "팀이 AC-02 계정으로 옮겼어요 · 영역 2개 새 대화",
      data: { account: "AC-02", n: 2 },
    })
    await h.close()
  })

  test("an exhausted old account: program handoffs at once, no wait for a turn on it", async () => {
    const h = await setup({ blocked: true })
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02 }))
    await done(h, opID)
    expect(h.core.log.filter((line) => line.startsWith("synthetic"))).toEqual([])
    expect(h.programs.toSorted()).toEqual([API, UI])
    expect(h.owners).toHaveLength(2)
    await h.close()
  })

  test("codex → siwc of one login: the main moves first, each area hands over at its own idle point", async () => {
    const h = await setup({ active: [UI_OWNER] })
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: SIWC_01 }))
    // The ui owner still works, and the main has moved already (one subscription: no overlap to avoid).
    await eventually(() => calls(h, "switch.apply").length === 1)
    expect(h.core.active.has(UI_OWNER)).toBe(true)
    await turn(h, API_OWNER, API, true)
    idle(h, UI_OWNER)
    await turn(h, UI_OWNER, UI, true)
    await done(h, opID)
    expect(h.owners.map((item) => item.model)).toEqual([SIWC_01, SIWC_01])
    expect(h.programs).toEqual([])
    await h.close()
  })
})

describe("RH-20: the switch of the team main ends, and a follow that met another op is kept", () => {
  /** The first value `read` gives within `ms`. */
  async function reach<T>(read: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const value = await read()
      if (value !== undefined) return value
      if (Date.now() > end) throw new Error("condition not reached")
      await Bun.sleep(5)
    }
  }

  /** own.accounts accepts the switch but never lands it; `state` is what `switch.state` answers meanwhile. */
  function pendingSwitch(h: Harness, state: () => unknown) {
    h.world.accounts.set("switch.apply", () => ({ state: "SWITCHING" }))
    h.world.accounts.set("switch.state", state)
  }

  test("a switch own.accounts reports failed ends the move: no owner moved", async () => {
    const h = await setup()
    pendingSwitch(h, () => ({ state: "FAILED", error: "upstream" }))
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02, mode: "stop" }))
    const op = await reach(async () => {
      const current = await h.services.journal.find(opID)
      return current?.state === "failed" ? current : undefined
    }, 30_000)
    expect(op.steps.find((step) => step.kind === "account-switch")).toMatchObject({
      state: "failed",
      note: "팀 메인을 새 계정으로 옮기지 못했어요: 계정 전환이 실패했어요",
    })
    expect(h.owners).toEqual([])
    await h.close()
  })

  test("a switch that never lands gives up after 15 minutes; one that settled on another model ends at once", async () => {
    const h = await setup()
    pendingSwitch(h, () => ({ state: "SWITCHING", target: GPT_02, issuedAt: 1 }))
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02, mode: "stop" }))
    await reach(async () => {
      const step = (await h.services.journal.find(opID))?.steps.find((item) => item.kind === "account-switch")
      return step?.wait?.why === "account-switch" && step.wait.detail === "SWITCHING" ? true : undefined
    }, 30_000)
    h.clock.advance(TeamAccount.SWITCH_MS)
    const op = await reach(async () => {
      const current = await h.services.journal.find(opID)
      return current?.state === "failed" ? current : undefined
    }, 30_000)
    expect(op.steps.find((step) => step.kind === "account-switch")?.note).toBe(
      "팀 메인을 새 계정으로 옮기지 못했어요: 전환이 끝나지 않았어요",
    )
    // RH-33: the switch the move gave up on is dropped in own.accounts too.
    expect(calls(h, "switch.cancel")).toEqual([{ sessionID: MAIN_SESSION }])
    await h.close()

    const settled = await setup()
    pendingSwitch(settled, () => ({ state: "STEADY" }))
    const other = opOf(
      await settled.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02, mode: "stop" }),
    )
    const ended = await reach(async () => {
      const current = await settled.services.journal.find(other)
      return current?.state === "failed" ? current : undefined
    }, 30_000)
    expect(ended.steps.find((step) => step.kind === "account-switch")?.note).toBe(
      "팀 메인을 새 계정으로 옮기지 못했어요: 전환이 다른 모델로 끝났거나 취소됐어요",
    )
    await settled.close()
  })

  test("an account change of the main while another op runs is kept, told after 5 minutes, and started when it ends", async () => {
    const h = await setup()
    const release = Promise.withResolvers<void>()
    h.services.steps.register({
      kind: "test.hold",
      observe: async () => ({ state: "pending" }),
      act: async () => {
        await release.promise
        return { ok: true }
      },
      verify: async () => ({ ok: true }),
    })
    const blocking = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "reorg",
      by: "user",
      steps: [{ kind: "test.hold" }],
    })
    if (!blocking.ok) throw new Error("busy")
    moveMain(h, GPT_02)
    h.controller.hub.receive(
      event("session.model.selected", { sessionID: MAIN_SESSION, model: GPT_02, previous: GPT_01 }),
    )
    await Bun.sleep(50)
    expect((await h.services.journal.active(TEAM_ID))?.id).toBe(blocking.op.id)
    h.clock.advance(TeamAccount.FOLLOW_TOLD_MS)
    await reach(() =>
      notices(h).some((item) => item.kind === "account.waiting" && item.data?.follow === true) ? true : undefined,
    )
    release.resolve()
    await reach(
      async () => ((await h.services.journal.active(TEAM_ID))?.kind === "team-account" ? true : undefined),
      30_000,
    )
    await h.close()
  })

  /** The op's `account-switch` step once it waits for the main's switch with `detail`. */
  async function switching(h: Harness, opID: string, detail: string) {
    return reach(async () => {
      const step = (await h.services.journal.find(opID))?.steps.find((item) => item.kind === "account-switch")
      return step?.wait?.why === "account-switch" && step.wait.detail === detail ? step : undefined
    })
  }

  test("RH-33: a switch that lands while a look reads the main is the move done, not a failed one", async () => {
    const h = await setup()
    const state: { value: unknown } = { value: { state: "SWITCHING", target: GPT_02, issuedAt: 1 } }
    pendingSwitch(h, () => state.value)
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02, mode: "stop" }))
    await switching(h, opID, "SWITCHING")
    // own.accounts moves the main's model first and settles after core's `session.model.selected`: here both land
    // right after the next read of the main's model, so a look that read the model before the state saw the old model
    // and then a settled switch.
    const main = h.core.sessions.get(MAIN_SESSION)!
    const route = `GET /api/session/${MAIN_SESSION}`
    const read = h.service.routes.get(route)!
    h.service.routes.set(route, (request) => {
      const answer = read(request)
      main.model = GPT_02
      state.value = { state: "STEADY" }
      h.service.routes.set(route, read)
      return answer
    })
    h.controller.hub.receive(
      event(`rpc.${OwnAccounts.ID}.switch.state`, { sessionID: MAIN_SESSION, state: "SWITCHING" }),
    )
    await reach(() => (h.service.routes.get(route) === read ? true : undefined))
    h.controller.hub.receive(
      event("session.model.selected", { sessionID: MAIN_SESSION, model: GPT_02, previous: GPT_01 }),
    )
    const op = await reach(async () => {
      const current = await h.services.journal.find(opID)
      return current?.state === "running" ? undefined : current
    })
    expect(op.state).toBe("done")
    expect(op.steps.find((step) => step.kind === "account-switch")?.state).toBe("done")
    expect(h.owners.map((item) => item.model)).toEqual([GPT_02, GPT_02])
    await h.close()
  })

  test("RH-33: 취소 drops the main's switch; one that landed anyway is followed when the op ends", async () => {
    const h = await setup()
    pendingSwitch(h, () => ({ state: "SWITCHING", target: GPT_02, issuedAt: 1 }))
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02, mode: "stop" }))
    await switching(h, opID, "SWITCHING")
    // own.accounts was already switching: core announces the main's new model while the op still waits (its look has
    // not read the model yet), and `switch.cancel` cannot stop it.
    h.controller.hub.receive(
      event("session.model.selected", { sessionID: MAIN_SESSION, model: GPT_02, previous: GPT_01 }),
    )
    await Bun.sleep(200)
    moveMain(h, GPT_02)
    expect(await h.services.runner.cancel(opID)).toMatchObject({ ok: true, op: { state: "cancelled" } })
    expect(calls(h, "switch.cancel")).toEqual([{ sessionID: MAIN_SESSION }])
    expect(h.owners).toEqual([])
    // The cancelled op moved no owner, so the change is followed: a new op with the main already moved.
    const follow = await reach(async () => {
      const active = await h.services.journal.active(TEAM_ID)
      return active?.kind === "team-account" && active.id !== opID ? active : undefined
    })
    await reach(async () => ((await h.services.journal.find(follow.id))?.state === "done" ? true : undefined))
    expect(calls(h, "switch.apply")).toHaveLength(1)
    expect(h.owners.map((item) => item.model)).toEqual([GPT_02, GPT_02])
    await h.close()
  })

  test("RH-44: an op that ends between the change's look at the active op and its note is followed too", async () => {
    const h = await setup()
    pendingSwitch(h, () => ({ state: "SWITCHING", target: GPT_02, issuedAt: 1 }))
    const opID = opOf(await h.services.features().areaMain.account({ teamID: TEAM_ID, target: GPT_02, mode: "stop" }))
    await switching(h, opID, "SWITCHING")
    moveMain(h, GPT_02)
    // The change's look sees the op still running; the op is cancelled (`op.done`) before that look returns.
    const journal = h.services.journal
    const active = journal.active
    const looked = Promise.withResolvers<void>()
    journal.active = async (teamID) => {
      const found = await active(teamID)
      journal.active = active
      expect(await h.services.runner.cancel(opID)).toMatchObject({ ok: true, op: { state: "cancelled" } })
      looked.resolve()
      return found
    }
    h.controller.hub.receive(
      event("session.model.selected", { sessionID: MAIN_SESSION, model: GPT_02, previous: GPT_01 }),
    )
    await looked.promise
    const follow = await reach(async () => {
      const current = await h.services.journal.active(TEAM_ID)
      return current?.kind === "team-account" && current.id !== opID ? current : undefined
    })
    await reach(async () => ((await h.services.journal.find(follow.id))?.state === "done" ? true : undefined))
    expect(h.owners.map((item) => item.model)).toEqual([GPT_02, GPT_02])
    await h.close()
  })
})

describe("following the team main (06 §10.1)", () => {
  // SL-17: on the TUI path the main already runs on the new company's account, so its binding no longer names the
  // team's Claude account; the waiting notice names the Claude account the team is bound to, not the first one listed.
  test("a TUI switch from Claude names the team's Claude account in the waiting notice", async () => {
    const h = await setup({ active: [UI_OWNER] })
    claudeTeam(h, "acc_cl3", "AC-03")
    // docs follows the team here, so the move to ChatGPT 02 shares no company with an area main.
    await h.services.write(TEAM_ID, async () => {
      const docs = await h.services.registry.areas.get(TEAM_ID, DOCS)
      if (docs) await h.services.registry.areas.put({ ...docs, main: undefined })
    })
    moveMain(h, GPT_02)
    h.controller.hub.receive(
      event("session.model.selected", { sessionID: MAIN_SESSION, model: GPT_02, previous: OPUS }),
    )
    await eventually(() => notices(h).some((item) => item.kind === "account.waiting"))
    expect(notices(h).find((item) => item.kind === "account.waiting")).toMatchObject({
      text: "팀 계정 바꾸기: AC-03에서 하던 일이 끝나기를 기다려요",
      data: { account: "AC-03" },
    })
    idle(h, UI_OWNER)
    await h.close()
  })

  test("a TUI switchModel to another subscription starts the op; the old account runs no new turn", async () => {
    const h = await setup()
    // The TUI switched the main session itself: core already has it on ChatGPT 02.
    moveMain(h, GPT_02)
    h.controller.hub.receive(
      event("session.model.selected", { sessionID: MAIN_SESSION, model: GPT_02, previous: GPT_01 }),
    )
    await eventually(async () => (await h.services.journal.active(TEAM_ID))?.kind === "team-account")
    const active = await h.services.journal.active(TEAM_ID)
    if (!active) throw new Error("no op")
    expect(active.by).toBe("user")
    await done(h, active.id)
    // The main was on the new account already: no switch, program handoffs, new owners on 02.
    expect(calls(h, "switch.apply")).toEqual([])
    expect(h.core.log.filter((line) => line.startsWith("synthetic"))).toEqual([])
    expect(h.programs.toSorted()).toEqual([API, UI])
    expect(h.owners.map((item) => item.model)).toEqual([GPT_02, GPT_02])
    await h.close()
  })

  test("a model or effort change: 팀과 같게 owners switch now at their next safe point, never rotate", async () => {
    const h = await setup()
    h.unsafe.add(UI)
    moveMain(h, GPT_01_XHIGH)
    h.controller.hub.receive(
      event("session.model.selected", { sessionID: MAIN_SESSION, model: GPT_01_XHIGH, previous: GPT_01 }),
    )
    await eventually(() => calls(h, "switch.apply").length === 1)
    expect(calls(h, "switch.apply")).toEqual([
      { sessionID: API_OWNER, estimateID: "est_test", target: GPT_01_XHIGH, strategy: "now", reason: "manual" },
    ])
    // The ui folder is busy: it follows after its run ends.
    h.unsafe.delete(UI)
    idle(h, UI_OWNER)
    await eventually(() => calls(h, "switch.apply").length === 2)
    expect(calls(h, "switch.apply")[1]).toMatchObject({ sessionID: UI_OWNER, target: GPT_01_XHIGH })
    // The chosen area mains stay; nothing rotated.
    expect(h.owners).toEqual([])
    expect(await h.services.journal.active(TEAM_ID)).toBeUndefined()
    // 02 §4.8: speed is each conversation's own; 팀과 같게 follows the model and effort, never the main's speed.
    expect(calls(h, "session.speed.set")).toEqual([])
    await h.close()
  })
})
