// Area main and area preset (06 §10.1 영역별로 바꾸기, §6.1 영역 계정 변경, §2.7 `area.main` / `area.preset`, TG9 and TG15
// T1 items): the team's R4 refuses a second subscription of a company (`same_company_subscription`) but lets one
// ChatGPT login's siwc account in; an account change continues in a new conversation through the rotation service
// unless `now`; model or effort changes switch the owner now and never rotate; another provider group takes the
// preset of the same name, else the group's ★; `area.preset` applies at once to the owner with the team context.
// own.accounts and the rotation service are fakes; the own service is a fake HTTP server on 127.0.0.1.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, Preset } from "@own/protocol"
import { Keys } from "../../src/registry/keys.js"
import { AreaMainRpc } from "../../src/rpc/area-main.js"
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
] as const

function preset(input: {
  readonly name: string
  readonly group: Preset.Group
  readonly review?: { readonly account: string; readonly model: string }
}): Preset.Info {
  const review = input.review
  return {
    id: Preset.ID.create(),
    name: input.name,
    group: input.group,
    workers: review
      ? {
          mode: "by-role",
          roles: {
            "own-review": {
              targets: [{ pin: { account: Account.ID.make(review.account), model: Model.ID.make(review.model) } }],
              effort: "inherit",
            },
          },
        }
      : { mode: "same", roles: {} },
    delegation: "model",
    caps: Preset.CAPS,
    ultraCaps: null,
    revision: 1,
  }
}

const OTHER_REVIEW = preset({
  name: "다른 회사 리뷰",
  group: "codex",
  review: { account: "acc_claude_slot", model: "claude-opus-5" },
})
const OTHER_REVIEW_SIWC = { ...OTHER_REVIEW, id: Preset.ID.create(), group: "siwc" as const }
const CLAUDE_STAR = preset({ name: "Claude 가볍게", group: "claude-sub" })
const CLAUDE_GPT03 = preset({
  name: "Claude 리뷰",
  group: "claude-sub",
  review: { account: "acc_03", model: "gpt-6-astra" },
})
const CLAUDE_GPT01 = preset({
  name: "Claude 리뷰 01",
  group: "claude-sub",
  review: { account: "acc_01", model: "gpt-6-astra" },
})
const PRESETS = [OTHER_REVIEW, OTHER_REVIEW_SIWC, CLAUDE_STAR, CLAUDE_GPT03, CLAUDE_GPT01]
const STARS: Readonly<Record<string, Preset.ID>> = { "claude-sub": CLAUDE_STAR.id }

const UI = OwnTeam.AreaID.make("ar_ui")
const ROTATION = OwnTeam.OpID.create()
const OWNER = SessionID.make("ses_owner_ui0000000000000001")

function accounts(world: World, refs: Map<string, Model.Ref>) {
  const groupOf = (sessionID: string) =>
    ACCOUNTS.find((item) => item.providerID === refs.get(sessionID)?.providerID)?.kind
  world.accounts.set("accounts.list", () => ({ revision: 1, accounts: ACCOUNTS }))
  world.accounts.set("presets.list", () => ({
    groups: (["codex", "siwc", "claude-sub"] as const).map((group) => ({
      group,
      defaultModel: null,
      presets: [Preset.builtin(group), ...PRESETS.filter((item) => item.group === group)].map((item) => ({
        ...item,
        status: "ok",
      })),
      ...(STARS[group] ? { star: STARS[group] } : {}),
    })),
  }))
  world.accounts.set("session.preset.get", (call) => {
    const group = groupOf((call as { readonly sessionID: string }).sessionID)
    return {
      binding: null,
      preset: group ? Preset.builtin(group) : null,
      resolution: null,
      caps: Preset.CAPS,
      counts: { running: 0, message: 0, session: 0 },
      spend: 0,
    }
  })
  world.accounts.set("session.preset.apply", () => ({
    binding: {},
    resolution: null,
    entry: "unchanged",
    dryRun: false,
  }))
  world.accounts.set("switch.estimate", () => ({ estimateID: "est_test" }))
  world.accounts.set("switch.apply", () => ({ state: "STEADY" }))
}

/** A ChatGPT 01 team with one area `ar_ui` (팀과 같게 unless `main`), its owner on `owner`. */
async function setup(
  input: { readonly main?: Model.Ref; readonly owner?: Model.Ref; readonly preset?: Preset.ID } = {},
) {
  const home = await tempHome()
  homes.push(home)
  const service = start()
  services.push(service)
  const world = new World()
  const refs = new Map<string, Model.Ref>([
    [MAIN_SESSION, GPT_01],
    [OWNER, input.owner ?? input.main ?? GPT_01],
  ])
  accounts(world, refs)
  const directory = path.join(`${home.root}-team`, "ui")
  for (const [id, model] of refs)
    service.routes.set(`GET /api/session/${id}`, () =>
      Response.json({ data: session({ id, directory: id === MAIN_SESSION ? home.root : directory, model }) }),
    )
  const rotations: unknown[] = []
  const harness = controller(world, {
    directory: home.root,
    clock: manual(),
    source: service.source,
    features: {
      rotate: () => ({
        request: async (call) => {
          rotations.push(call)
          return { ok: true, opID: ROTATION }
        },
        main: async () => ({ ok: true, opID: ROTATION }),
      }),
    },
  })
  const record: OwnTeam.Area = {
    ...area({ slug: "ui", directory }),
    owner: { sessionID: OWNER, previous: [], attached: true },
    preset: input.preset ?? OTHER_REVIEW.id,
    ...(input.main === undefined ? {} : { main: { model: input.main, chosenBy: "user" as const } }),
  }
  await harness.services.write(TEAM_ID, async () => {
    await harness.services.registry.teams.put(team({ home: home.root }))
    await harness.services.registry.areas.put(record)
  })
  await harness.controller.resume()
  world.calls.length = 0
  return { ...harness, world, rotations, record }
}

type Harness = Awaited<ReturnType<typeof setup>>

async function stored(h: Harness) {
  return Schema.decodeUnknownSync(OwnTeam.Area)(h.world.kv.get(Keys.area(TEAM_ID, UI)))
}

const calls = (h: Harness, method: string) =>
  h.world.calls.filter((call) => call.method === method).map((call) => call.input)

describe("area.main (06 §10.1)", () => {
  test("a second ChatGPT subscription is refused for the team's R4; nothing changes", async () => {
    const h = await setup()
    const result = await h.services.features().areaMain.set({ teamID: TEAM_ID, areaID: UI, model: GPT_02, by: "user" })
    expect(result).toMatchObject({ ok: false, error: "same_company_subscription", data: { accountID: "acc_02" } })
    expect((await stored(h)).main).toBeUndefined()
    expect(calls(h, "switch.apply")).toEqual([])
    expect(h.rotations).toEqual([])
    // The RPC answers the declared error.
    const handler = AreaMainRpc.handlers(h.services)["area.main"]
    const answer = await handler(
      { teamID: TEAM_ID, areaID: UI, model: GPT_02 },
      // SAFETY (test): the RPC context's error builder returns what the handler answers.
      {
        signal: new AbortController().signal,
        error: (type: string, message: string, data: unknown) => ({ type, message, data }),
      } as never,
    )
    expect(answer).toMatchObject({ type: "same_company_subscription", data: { accountID: "acc_02" } })
    await h.close()
  })

  test("the same login's siwc account is one subscription: it is saved and continues in a new conversation", async () => {
    const h = await setup()
    const result = await h.services.features().areaMain.set({ teamID: TEAM_ID, areaID: UI, model: SIWC_01, by: "user" })
    expect(result).toMatchObject({ ok: true, opID: ROTATION })
    const after = await stored(h)
    expect(after.main).toEqual({ model: SIWC_01, chosenBy: "user" })
    // Another provider group: the preset of the same name there.
    expect(after.preset).toBe(OTHER_REVIEW_SIWC.id)
    expect(h.rotations).toEqual([{ teamID: TEAM_ID, areaID: UI, reason: "account", handoff: "warm", by: "user" }])
    expect(calls(h, "switch.apply")).toEqual([])
    await h.close()
  })

  test("another company with `now`: the owner switches in this conversation; the preset becomes that group's ★", async () => {
    const h = await setup()
    const result = await h.services
      .features()
      .areaMain.set({ teamID: TEAM_ID, areaID: UI, model: OPUS, now: true, by: "user" })
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && "opID" in result ? result.opID : undefined).toBeUndefined()
    const after = await stored(h)
    expect(after.main).toEqual({ model: OPUS, chosenBy: "user" })
    expect(after.preset).toBe(CLAUDE_STAR.id)
    expect(calls(h, "switch.estimate")).toEqual([{ sessionID: OWNER, target: OPUS, reason: "manual" }])
    expect(calls(h, "switch.apply")).toEqual([
      { sessionID: OWNER, estimateID: "est_test", target: OPUS, strategy: "now", reason: "manual" },
    ])
    expect(h.rotations).toEqual([])
    // Every binding got the new team context (Claude joins the team's accounts) before the switch.
    const pushed = calls(h, "session.preset.apply") as ReadonlyArray<{ readonly team?: Preset.Team }>
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.every((call) => call.team?.accounts.includes(Account.ID.make("acc_claude_slot")))).toBe(true)
    await h.close()
  })

  test("a model or effort change switches the owner now and never rotates (6.1)", async () => {
    const h = await setup()
    const result = await h.services
      .features()
      .areaMain.set({ teamID: TEAM_ID, areaID: UI, model: GPT_01_XHIGH, by: "user" })
    expect(result).toMatchObject({ ok: true })
    expect(calls(h, "switch.apply")).toEqual([
      { sessionID: OWNER, estimateID: "est_test", target: GPT_01_XHIGH, strategy: "now", reason: "manual" },
    ])
    expect(h.rotations).toEqual([])
    expect((await stored(h)).preset).toBe(OTHER_REVIEW.id)
    await h.close()
  })

  test("null is 팀과 같게: the area main goes, and an owner on Claude continues on the team account", async () => {
    const h = await setup({ main: OPUS, preset: CLAUDE_STAR.id })
    const result = await h.services.features().areaMain.set({ teamID: TEAM_ID, areaID: UI, model: null, by: "user" })
    expect(result).toMatchObject({ ok: true, opID: ROTATION })
    const after = await stored(h)
    expect(after.main).toBeUndefined()
    // No `Claude 가볍게` in ChatGPT and no ★ there: the group's 평소대로.
    expect(after.preset).toBe(Preset.builtinID("codex"))
    expect(h.rotations).toEqual([{ teamID: TEAM_ID, areaID: UI, reason: "account", handoff: "warm", by: "user" }])
    await h.close()
  })

  test("busy while another op runs; broken, retired and unknown areas", async () => {
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
    expect(
      await h.services.features().areaMain.set({ teamID: TEAM_ID, areaID: UI, model: OPUS, by: "user" }),
    ).toMatchObject({ ok: false, error: "busy" })
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({ ...h.record, state: "broken", broken: { why: "missing", at: 1 } }),
    )
    expect(
      await h.services.features().areaMain.preset({ teamID: TEAM_ID, areaID: UI, presetID: OTHER_REVIEW.id }),
    ).toMatchObject({ ok: false, error: "broken", data: { areaID: UI, why: "missing" } })
    expect(
      await h.services
        .features()
        .areaMain.set({ teamID: TEAM_ID, areaID: OwnTeam.AreaID.make("ar_none"), model: null, by: "user" }),
    ).toMatchObject({ ok: false, error: "not_found" })
    await h.close()
  })
})

describe("area.preset (06 §10.1 영역 프리셋)", () => {
  test("a preset of another group is preset_wrong_group", async () => {
    const h = await setup()
    expect(
      await h.services.features().areaMain.preset({ teamID: TEAM_ID, areaID: UI, presetID: CLAUDE_STAR.id }),
    ).toMatchObject({ ok: false, error: "preset_wrong_group", data: { group: "codex" } })
    await h.close()
  })

  test("a target on another ChatGPT subscription breaks the team's R4 (TG15)", async () => {
    const h = await setup({ main: OPUS, preset: CLAUDE_STAR.id })
    expect(
      await h.services.features().areaMain.preset({ teamID: TEAM_ID, areaID: UI, presetID: CLAUDE_GPT03.id }),
    ).toMatchObject({ ok: false, error: "same_company_subscription", data: { accountID: "acc_03" } })
    expect((await stored(h)).preset).toBe(CLAUDE_STAR.id)
    await h.close()
  })

  test("applied to the owner now with the team context; recorded; no switch and no new conversation", async () => {
    const h = await setup({ main: OPUS, preset: CLAUDE_STAR.id })
    const result = await h.services
      .features()
      .areaMain.preset({ teamID: TEAM_ID, areaID: UI, presetID: CLAUDE_GPT01.id })
    expect(result).toMatchObject({ ok: true, area: { id: UI, preset: CLAUDE_GPT01.id } })
    const applied = calls(h, "session.preset.apply") as ReadonlyArray<{
      readonly sessionID: string
      readonly presetID: string
      readonly team?: Preset.Team
    }>
    const first = applied[0]
    expect(first?.sessionID).toBe(OWNER)
    expect(first?.presetID).toBe(CLAUDE_GPT01.id)
    expect(first?.team?.role).toBe("owner")
    expect(first?.team?.pinned).toEqual(expect.arrayContaining([{ pin: { account: "acc_01", model: "gpt-6-astra" } }]))
    expect((await stored(h)).preset).toBe(CLAUDE_GPT01.id)
    expect(calls(h, "switch.apply")).toEqual([])
    expect(h.rotations).toEqual([])
    await h.close()
  })

  test("while the owner waits for its move to the area main's group, the preset is recorded for the new owner", async () => {
    // The area main is Claude now; the owner still runs on ChatGPT 01 until its rotation.
    const h = await setup({ main: OPUS, owner: GPT_01, preset: CLAUDE_STAR.id })
    const result = await h.services
      .features()
      .areaMain.preset({ teamID: TEAM_ID, areaID: UI, presetID: CLAUDE_GPT01.id })
    expect(result).toMatchObject({ ok: true, area: { id: UI, preset: CLAUDE_GPT01.id } })
    expect((await stored(h)).preset).toBe(CLAUDE_GPT01.id)
    const applied = calls(h, "session.preset.apply") as ReadonlyArray<{ readonly presetID: string }>
    expect(applied.some((call) => call.presetID === CLAUDE_GPT01.id)).toBe(false)
    expect(calls(h, "switch.apply")).toEqual([])
    expect(h.rotations).toEqual([])
    await h.close()
  })

  test("own.accounts' refusal is answered with the same error", async () => {
    const h = await setup()
    h.world.accounts.set("session.preset.apply", () => {
      throw { type: "preset_wrong_group", message: "preset_wrong_group", data: { group: "claude-sub" } }
    })
    expect(
      await h.services.features().areaMain.preset({ teamID: TEAM_ID, areaID: UI, presetID: Preset.builtinID("codex") }),
    ).toMatchObject({ ok: false, error: "preset_wrong_group", data: { group: "claude-sub" } })
    await h.close()
  })
})
