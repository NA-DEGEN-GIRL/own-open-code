// The team context and the team-wide R4 (06 §10.1 팀 전체 R4, 07 §5.1, §5.4, TG15/TG16 T1 items): S = the team main's
// account, the area mains' accounts and every preset's pinned targets; `session.preset.apply{team}` goes to the main
// and every owner only when their binding differs; a preset edited to break R4 is announced once (`preset.repair`) and
// left out of `pinned`; one ChatGPT login's codex and siwc accounts count once. own.accounts is a fake that judges
// `session.preset.apply` with `Preset.allowed` like the service; the own service is a fake HTTP server on 127.0.0.1.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, Preset } from "@own/protocol"
import type { Hub } from "../../src/hub.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { TeamContext } from "../../src/sessions/team-context.js"
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
const GPT_02 = ref({ id: "gpt-6-astra", providerID: "own-codex-02", variant: "high" })
const OPUS = ref({ id: "claude-opus-5", providerID: "anthropic" })

/** ChatGPT 01 and its same-login siwc sibling, ChatGPT 02 and 03 (other logins), the Claude slot, DeepSeek (metered). */
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
    id: "acc_03",
    kind: "codex",
    label: "ChatGPT 03",
    providerID: "own-codex-03",
    billing: "subscription",
    status: "ready",
    identity: viewIdentity("codex", "login-c"),
  },
  {
    id: "acc_claude_slot",
    kind: "claude-sub",
    label: "Claude",
    providerID: "anthropic",
    billing: "subscription",
    status: "ready",
  },
  { id: "acc_ds", kind: "ds", label: "DeepSeek", providerID: "own-ds-1", billing: "metered", status: "ready" },
] as const

const lookup: Preset.Lookup = (accountID) => {
  const found = ACCOUNTS.find((item) => item.id === accountID)
  return (
    found && {
      id: Account.ID.make(found.id),
      kind: found.kind,
      billing: found.billing,
      ...("identity" in found ? { identity: found.identity } : {}),
    }
  )
}

function preset(input: {
  readonly name: string
  readonly group: Preset.Group
  readonly review: string
  readonly model: string
}): Preset.Info {
  return {
    id: Preset.ID.create(),
    name: input.name,
    group: input.group,
    workers: {
      mode: "by-role",
      roles: {
        "own-review": {
          targets: [{ pin: { account: Account.ID.make(input.review), model: Model.ID.make(input.model) } }],
          effort: "inherit",
        },
      },
    },
    delegation: "model",
    caps: Preset.CAPS,
    ultraCaps: null,
    revision: 1,
  }
}

const OTHER_REVIEW = preset({
  name: "다른 회사 리뷰",
  group: "codex",
  review: "acc_claude_slot",
  model: "claude-opus-5",
})
const UI = OwnTeam.AreaID.make("ar_ui")
const PERF = OwnTeam.AreaID.make("ar_perf")
const UI_OWNER = SessionID.make("ses_owner_ui0000000000000001")
const PERF_OWNER = SessionID.make("ses_owner_perf00000000000001")

interface Bound {
  readonly presetID: Preset.ID
  readonly group: Preset.Group
  readonly team?: Preset.Team
}

/** own.accounts: accounts, presets (editable), bindings, and `session.preset.apply` judged like the service (07 §5.3). */
function accounts(world: World, refs: Map<string, Model.Ref>, presets: Map<string, Preset.Info>) {
  const bindings = new Map<string, Bound>()
  const memberOf = (sessionID: string) => {
    const main = refs.get(sessionID)
    return main && ACCOUNTS.find((item) => item.providerID === main.providerID)
  }
  const presetOf = (presetID: string) =>
    presets.get(presetID) ??
    (Preset.isBuiltin(presetID) ? Preset.builtin(Schema.decodeUnknownSync(Preset.Group)(presetID.slice(8))) : undefined)
  world.accounts.set("accounts.list", () => ({ revision: 1, accounts: ACCOUNTS }))
  world.accounts.set("presets.list", () => ({
    groups: (["codex", "claude-sub"] as const).map((group) => ({
      group,
      defaultModel: null,
      presets: [Preset.builtin(group), ...[...presets.values()].filter((item) => item.group === group)].map((item) => ({
        ...item,
        status: "ok",
      })),
    })),
  }))
  world.accounts.set("session.preset.get", (call) => {
    const sessionID = (call as { readonly sessionID: string }).sessionID
    const group = memberOf(sessionID)?.kind
    if (!group)
      return {
        binding: null,
        preset: null,
        resolution: null,
        caps: Preset.CAPS,
        counts: { running: 0, message: 0, session: 0 },
        spend: 0,
      }
    const binding = bindings.get(sessionID)
    const presetID = binding?.group === group ? binding.presetID : Preset.builtinID(group)
    return {
      binding: binding ? { ...binding, revision: 1, appliedAt: 1, entryHash: null } : null,
      preset: presetOf(presetID),
      resolution: { main: refs.get(sessionID), roles: {} },
      caps: Preset.CAPS,
      counts: { running: 0, message: 0, session: 0 },
      spend: 0,
    }
  })
  world.accounts.set("session.preset.apply", (call) => {
    const input = call as { readonly sessionID: string; readonly presetID: string; readonly team?: Preset.Team | null }
    const chosen = presetOf(input.presetID)
    if (!chosen) throw { type: "preset_not_found", message: "preset_not_found", data: { presetID: input.presetID } }
    const member = memberOf(input.sessionID)
    if (chosen.group !== member?.kind)
      throw { type: "preset_wrong_group", message: "preset_wrong_group", data: { group: member?.kind } }
    const previous = bindings.get(input.sessionID)
    const teamOf = input.team === undefined ? previous?.team : (input.team ?? undefined)
    const verdict = Preset.allowed(chosen, Account.ID.make(member.id), lookup, teamOf)
    if (!verdict.ok)
      throw {
        type: "same_company_subscription",
        message: "same_company_subscription",
        data: { accountID: verdict.accountID },
      }
    bindings.set(input.sessionID, { presetID: chosen.id, group: chosen.group, ...(teamOf ? { team: teamOf } : {}) })
    return { binding: {}, resolution: null, entry: "unchanged", dryRun: false }
  })
  return { bindings }
}

function event(type: string, data: Readonly<Record<string, unknown>>): Hub.Incoming {
  // SAFETY (test): an event with the fields own.team reads (`type`, `data`).
  return { id: `evt_${type}_${Math.random()}`, created: 1, type, data } as never
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

/**
 * A ChatGPT 01 team: the main on `평소대로`, `ar_ui` 팀과 같게 with `다른 회사 리뷰` (review on Claude), `ar_perf` on the
 * Claude slot with `Claude 리뷰` (review on `perfReview`, ChatGPT 01 by default).
 */
async function setup(
  input: {
    readonly perfReview?: string
    readonly mainRef?: Model.Ref
    readonly uiRef?: Model.Ref
    /** `ar_ui`'s owner was adopted and has had no main request yet (3.7). */
    readonly uiAdopted?: boolean
    /** An op recorded before the controller resumes. */
    readonly op?: OwnTeam.Op
  } = {},
) {
  const home = await tempHome()
  homes.push(home)
  const service = start()
  services.push(service)
  const world = new World()
  const claudeReview = preset({
    name: "Claude 리뷰",
    group: "claude-sub",
    review: input.perfReview ?? "acc_01",
    model: "gpt-6-astra",
  })
  const presets = new Map<string, Preset.Info>([
    [OTHER_REVIEW.id, OTHER_REVIEW],
    [claudeReview.id, claudeReview],
  ])
  const refs = new Map<string, Model.Ref>([
    [MAIN_SESSION, input.mainRef ?? GPT_01],
    [UI_OWNER, input.uiRef ?? GPT_01],
    [PERF_OWNER, OPUS],
  ])
  const fake = accounts(world, refs, presets)
  const worktrees = `${home.root}-team`
  for (const [id, model] of refs)
    service.routes.set(`GET /api/session/${id}`, () =>
      Response.json({
        data: session({ id, directory: id === MAIN_SESSION ? home.root : path.join(worktrees, id), model }),
      }),
    )
  const harness = controller(world, { directory: home.root, clock: manual(), source: service.source })
  await harness.services.write(TEAM_ID, async () => {
    await harness.services.registry.teams.put(team({ home: home.root }))
    await harness.services.registry.areas.put({
      ...area({ slug: "ui", directory: path.join(worktrees, "ui") }),
      owner: { sessionID: UI_OWNER, previous: [], attached: input.uiAdopted !== true },
      preset: OTHER_REVIEW.id,
    })
    await harness.services.registry.areas.put({
      ...area({ slug: "perf", directory: path.join(worktrees, "perf") }),
      owner: { sessionID: PERF_OWNER, previous: [], attached: true },
      main: { model: OPUS, chosenBy: "user" },
      preset: claudeReview.id,
    })
  })
  if (input.op) await harness.services.journal.put(input.op)
  await harness.controller.resume()
  world.calls.length = 0
  harness.published.length = 0
  return { ...harness, home: home.root, world, service, presets, refs, claudeReview, bindings: fake.bindings }
}

const applies = (world: World) =>
  world.calls
    .filter((call) => call.method === "session.preset.apply")
    .map((call) => call.input as { readonly sessionID: string; readonly presetID: string; readonly team?: Preset.Team })

const sorted = (team: Preset.Team | null | undefined) =>
  team && {
    teamID: String(team.teamID),
    role: team.role,
    accounts: team.accounts.map(String).toSorted(),
    pinned: team.pinned.map((target) => String("pin" in target ? target.pin.account : target.rel)).toSorted(),
  }

describe("team context (06 §10.1)", () => {
  test("S: the team main's account, the area mains' and every preset's pinned targets", async () => {
    const h = await setup()
    const owner = await h.services.features().teamContext.get({ teamID: TEAM_ID, role: "owner" })
    expect(sorted(owner)).toEqual({
      teamID: TEAM_ID,
      role: "owner",
      accounts: ["acc_01", "acc_claude_slot"],
      pinned: ["acc_01", "acc_claude_slot"],
    })
    expect((await h.services.features().teamContext.get({ teamID: TEAM_ID, role: "main" }))?.role).toBe("main")
    await h.close()
  })

  test("resume binds the main (its preset in force) and every owner (its area preset); an equal binding is skipped", async () => {
    const h = await setup()
    expect(h.bindings.get(MAIN_SESSION)).toMatchObject({ presetID: Preset.builtinID("codex"), team: { role: "main" } })
    expect(h.bindings.get(UI_OWNER)).toMatchObject({ presetID: OTHER_REVIEW.id, team: { role: "owner" } })
    expect(h.bindings.get(PERF_OWNER)).toMatchObject({ presetID: h.claudeReview.id, team: { role: "owner" } })
    // Nothing changed: no second write (and own.accounts never rewrites the instruction entry for a team-only change).
    await h.services.features().teamContext.push(TEAM_ID)
    expect(applies(h.world)).toEqual([])
    // Another area main account: every binding gets the new context, each with the preset it already has.
    h.bindings.set(UI_OWNER, { presetID: OTHER_REVIEW.id, group: "codex" })
    await h.services.features().teamContext.push(TEAM_ID)
    expect(applies(h.world).map((call) => [call.sessionID, call.presetID])).toEqual([[UI_OWNER, OTHER_REVIEW.id]])
    await h.close()
  })

  test("an adopted owner gets no team context before its first main request (06 §3.7, TG16)", async () => {
    const h = await setup({ uiAdopted: true })
    expect(h.bindings.get(UI_OWNER)).toBeUndefined()
    expect(h.bindings.get(PERF_OWNER)).toMatchObject({ presetID: h.claudeReview.id, team: { role: "owner" } })
    h.bindings.delete(PERF_OWNER)
    await h.services.features().teamContext.push(TEAM_ID)
    expect(applies(h.world).map((call) => call.sessionID)).toEqual([PERF_OWNER])
    await h.close()
  })

  test("a preset edited to break R4 is announced once, left out of pinned, and its owner keeps the team on 평소대로", async () => {
    const h = await setup()
    await h.services.features().teamContext.push(TEAM_ID)
    h.world.calls.length = 0
    // `Claude 리뷰` now runs review on ChatGPT 03: a second OpenAI subscription in a ChatGPT 01 team (TG15).
    h.presets.set(h.claudeReview.id, {
      ...h.claudeReview,
      ...preset({ name: "Claude 리뷰", group: "claude-sub", review: "acc_03", model: "gpt-6-astra" }),
      id: h.claudeReview.id,
    })
    h.controller.hub.receive(event("rpc.own.accounts.presets.changed", {}))
    await eventually(() => h.published.some((item) => item.name === "notice" && item.data.kind === "preset.repair"))
    await eventually(() => applies(h.world).some((call) => call.sessionID === PERF_OWNER))
    const notices = h.published.flatMap((item) => (item.name === "notice" ? [item.data] : []))
    expect(notices).toEqual([
      expect.objectContaining({
        teamID: TEAM_ID,
        areaID: PERF,
        kind: "preset.repair",
        text: "'Claude 리뷰' 프리셋이 ChatGPT 03 계정을 써서 perf 리뷰 역할을 perf 모델로 돌려요",
        data: {
          presetID: h.claudeReview.id,
          preset: "Claude 리뷰",
          accountID: "acc_03",
          account: "ChatGPT 03",
          roles: "리뷰",
        },
      }),
    ])
    // own.accounts refuses the area preset with this team, so the owner is held on 평소대로 with the new context.
    await eventually(() => h.bindings.get(PERF_OWNER)?.presetID === Preset.builtinID("claude-sub"))
    expect(sorted(h.bindings.get(PERF_OWNER)?.team)?.pinned).toEqual(["acc_claude_slot"])
    expect(sorted(h.bindings.get(MAIN_SESSION)?.team)?.pinned).toEqual(["acc_claude_slot"])
    // A second change event announces nothing new.
    h.published.length = 0
    h.controller.hub.receive(event("rpc.own.accounts.presets.changed", {}))
    await Bun.sleep(50)
    expect(h.published.filter((item) => item.name === "notice")).toEqual([])
    // Open until fixed, for a window opened later (`team.get` `notices`), and told again after a restart.
    const open = await h.services.notices.open(TEAM_ID)
    expect(open).toEqual([expect.objectContaining({ kind: "preset.repair", areaID: PERF, data: notices[0]?.data })])
    const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: h.services.log })
    const viewed = await handlers["team.get"](
      { directory: h.home },
      {
        signal: new AbortController().signal,
        // SAFETY (test): `team.get` declares no error this team answers with.
        error: (() => {
          throw new Error("team.get failed")
        }) as never,
      },
    )
    expect(viewed).toMatchObject({ notices: open })
    const restarted = TeamContext.create(h.services)
    await restarted.resume?.()
    expect(h.published.filter((item) => item.name === "notice" && item.data.kind === "preset.repair")).toHaveLength(1)
    await restarted.close?.()
    // Fixed again: the area preset comes back and the notice closes.
    h.presets.set(h.claudeReview.id, h.claudeReview)
    h.controller.hub.receive(event("rpc.own.accounts.presets.changed", {}))
    await eventually(() => h.bindings.get(PERF_OWNER)?.presetID === h.claudeReview.id)
    await eventually(async () => (await h.services.notices.open(TEAM_ID)).length === 0)
    await h.close()
  })

  test("a model pool pinning another ChatGPT login: the pool repair with its names and no role list (07 T4)", async () => {
    const h = await setup()
    await h.services.features().teamContext.push(TEAM_ID)
    h.world.calls.length = 0
    // `Claude 리뷰` now pools gpt-6-sol on ChatGPT 03: a second OpenAI subscription in a ChatGPT 01 team.
    const pooled: Preset.Info = {
      ...h.claudeReview,
      workers: {
        mode: "same",
        roles: {},
        pool: [
          { key: "gpt-6-sol", model: Model.ID.make("gpt-6-sol"), account: Account.ID.make("acc_03") },
          { key: "claude-opus-5", model: Model.ID.make("claude-opus-5") },
        ],
      },
    }
    h.presets.set(h.claudeReview.id, pooled)
    h.controller.hub.receive(event("rpc.own.accounts.presets.changed", {}))
    await eventually(() => h.published.some((item) => item.name === "notice" && item.data.kind === "preset.repair"))
    const notices = h.published.flatMap((item) => (item.name === "notice" ? [item.data] : []))
    expect(notices).toEqual([
      expect.objectContaining({
        teamID: TEAM_ID,
        areaID: PERF,
        kind: "preset.repair",
        text: "'Claude 리뷰' 프리셋이 ChatGPT 03 계정을 써서 perf 모델 묶음의 gpt-6-sol 항목을 기본 규칙으로 돌려요",
        data: {
          presetID: h.claudeReview.id,
          preset: "Claude 리뷰",
          accountID: "acc_03",
          account: "ChatGPT 03",
          roles: "",
          pool: "gpt-6-sol",
        },
      }),
    ])
    const state = (await TeamContext.load(h.services, TEAM_ID))?.state
    if (!state) throw new Error("no snapshot")
    expect(TeamContext.repairsOf(state, [Account.ID.make("acc_03")])).toEqual([
      {
        areaID: PERF,
        presetID: h.claudeReview.id,
        accountID: Account.ID.make("acc_03"),
        roles: [],
        pool: ["gpt-6-sol"],
      },
    ])
    await h.close()
  })

  test("a model pool pin on the main's same-login siwc account passes as before (07 T4)", async () => {
    const h = await setup()
    const pooled: Preset.Info = {
      ...h.claudeReview,
      workers: {
        mode: "same",
        roles: {},
        pool: [{ key: "gpt-6-sol", model: Model.ID.make("gpt-6-sol"), account: Account.ID.make("acc_s1") }],
      },
    }
    h.presets.set(h.claudeReview.id, pooled)
    const state = (await TeamContext.load(h.services, TEAM_ID))?.state
    if (!state) throw new Error("no snapshot")
    expect(TeamContext.offenders(state)).toEqual([])
    expect(TeamContext.pins(pooled).map((pin) => String(pin.pin.account))).toEqual(["acc_s1"])
    await h.services.features().teamContext.push(TEAM_ID)
    expect(h.bindings.get(PERF_OWNER)?.presetID).toBe(h.claudeReview.id)
    expect(h.published.filter((item) => item.name === "notice")).toEqual([])
    await h.close()
  })

  test("one ChatGPT login: a siwc pin of the main's login is no repair, and only the main's company leaves it out", async () => {
    const h = await setup({ perfReview: "acc_s1" })
    const state = (await TeamContext.load(h.services, TEAM_ID))?.state
    if (!state) throw new Error("no snapshot")
    expect(TeamContext.offenders(state)).toEqual([])
    // The main's subagents never run on its sibling slot, so the pin is not listed for the team; the Claude owner's
    // own preset keeps it (one subscription with the team's ChatGPT 01).
    const pinned = TeamContext.context(state, []).pinned.map((target) =>
      String("pin" in target ? target.pin.account : ""),
    )
    expect(pinned).toEqual(["acc_claude_slot"])
    await h.services.features().teamContext.push(TEAM_ID)
    expect(h.bindings.get(PERF_OWNER)?.presetID).toBe(h.claudeReview.id)
    expect(h.published.filter((item) => item.name === "notice")).toEqual([])
    await h.close()
  })

  test("a team main preset change re-pushes the team context", async () => {
    const h = await setup()
    await h.services.features().teamContext.push(TEAM_ID)
    const deep = preset({ name: "깊게", group: "codex", review: "acc_ds", model: "deepseek-v4" })
    h.presets.set(deep.id, deep)
    h.bindings.set(MAIN_SESSION, { presetID: deep.id, group: "codex", team: h.bindings.get(MAIN_SESSION)?.team })
    h.world.calls.length = 0
    h.controller.hub.receive(event("rpc.own.accounts.session.preset.changed", { sessionID: MAIN_SESSION, binding: {} }))
    await eventually(() => applies(h.world).some((call) => call.sessionID === UI_OWNER))
    expect(sorted(h.bindings.get(UI_OWNER)?.team)?.pinned).toEqual(["acc_01", "acc_claude_slot", "acc_ds"])
    // The main keeps its own preset; only its team context changed.
    expect(h.bindings.get(MAIN_SESSION)?.presetID).toBe(deep.id)
    await h.close()
  })

  test("while the team account moves, each session keeps its own account for its company (06 §10.1 경로)", async () => {
    // The TUI path: the main is on ChatGPT 02 already, the 팀과 같게 owner still on ChatGPT 01.
    // The op waits (a confirm-free `waiting` op is enough here): the team account is moving.
    const h = await setup({
      mainRef: GPT_02,
      perfReview: "acc_claude_slot",
      op: {
        id: OwnTeam.OpID.create(),
        teamID: TEAM_ID,
        kind: "team-account",
        by: "user",
        state: "waiting",
        createdAt: 1,
        steps: [],
      },
    })
    await h.services.features().teamContext.push(TEAM_ID)
    expect(sorted(h.bindings.get(MAIN_SESSION)?.team)?.accounts).toEqual(["acc_02", "acc_claude_slot"])
    expect(sorted(h.bindings.get(UI_OWNER)?.team)?.accounts).toEqual(["acc_01", "acc_claude_slot"])
    expect(sorted(h.bindings.get(PERF_OWNER)?.team)?.accounts).toEqual(["acc_02", "acc_claude_slot"])
    await h.close()
  })

  test("R4 helpers: a rival is another subscription of the company; one login is one subscription", () => {
    const member = (id: string) => {
      const found = lookup(Account.ID.make(id))
      if (!found) throw new Error(`no account ${id}`)
      return found
    }
    expect(TeamContext.rival(member("acc_01"), member("acc_02"))).toBe(true)
    expect(TeamContext.rival(member("acc_01"), member("acc_s1"))).toBe(false)
    expect(TeamContext.rival(member("acc_01"), member("acc_claude_slot"))).toBe(false)
    expect(TeamContext.rival(member("acc_01"), member("acc_ds"))).toBe(false)
    expect(TeamContext.sameSubscription(member("acc_01"), member("acc_s1"))).toBe(true)
    expect(TeamContext.sameSubscription(member("acc_02"), member("acc_s1"))).toBe(false)
  })

  test("R4 helpers: the Claude Agent account is Anthropic's, another subscription than the Claude slot (CAG)", () => {
    const slot = lookup(Account.ID.make("acc_claude_slot"))!
    const agent: Preset.Member = { id: Account.ID.make("acc_agent"), kind: "claude-agent", billing: "subscription" }
    const codex = lookup(Account.ID.make("acc_01"))!
    expect(Preset.company(agent)).toBe("anthropic")
    expect(TeamContext.rival(agent, slot)).toBe(true)
    expect(TeamContext.rival(slot, agent)).toBe(true)
    expect(TeamContext.rival(agent, codex)).toBe(false)
    expect(TeamContext.sameSubscription(agent, agent)).toBe(true)
  })
})
