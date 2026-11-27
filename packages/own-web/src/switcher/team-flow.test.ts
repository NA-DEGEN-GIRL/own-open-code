// T1 switcher (07 §5.3, §5.5, §7.3; 06 §9.5, §10.1): the team's R4 filter of a team session's list (the same-login
// codex/siwc sibling stays), the routes of a team session's switch (owner → `area.main{now:true}`, team main → 팀 계정
// 바꾸기, `team_switch_required` from any path → the same flow), the 팀 계정 바꾸기 lines, the child-wait choice
// (`switch.apply{children}`), the cross-group preset line and the area-mode switcher of team/intents. Every account,
// session and plan is a fixture; the runtime is a fake that records the RPC calls it gets.
import { afterEach, describe, expect, test } from "bun:test"
import type { Account, Estimate } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { OwnRpcError, type ServerRuntime } from "@/data"
import { createI18n } from "@/i18n"
import { openSwitcherForArea } from "@/team/intents"
import type { SessionPlace } from "@/team/store"
import { switcherControl } from "./control"
import type { Decision, TargetRef } from "./cost"
import { childWaitText, groupName, presetMove, presetMoveText, presetNow } from "./describe"
import { applyNow, executeStrategy, requestSwitch, withChildWait, type FlowEnv } from "./flow"
import { outsideTeam, teamAccounts } from "./picker"
import {
  applyAreaMain,
  areaOf,
  closeTeamDialog,
  openSwitcher,
  presetLineFor,
  runTeamAccount,
  switchRoute,
  teamAccountLines,
  teamDialogOf,
  teamSwitchRequired,
  textOf,
} from "./team-flow"

const ko = createI18n("ko")
const en = createI18n("en")
const TEAM = "tm_0123456789ab"

function account(
  id: string,
  kind: Account.View["kind"],
  billing: Account.View["billing"],
  extra: Partial<Account.View> = {},
): Account.View {
  // SAFETY: fixture shaped like `accounts.list` items; branded ids are plain strings at runtime.
  return {
    id,
    kind,
    label: id,
    shortLabel: id,
    color: "blue",
    providerID: `own-${kind}-${id.slice(4)}`,
    billing,
    status: "ready",
    autoSwitch: false,
    thirdParty: false,
    readOnly: false,
    connection: {},
    ...extra,
  } as unknown as Account.View
}

// ChatGPT 01 and the `siwc` account of the same login; ChatGPT 02 and a `siwc` account of an unknown login; a
// turned-off ChatGPT 03; the Claude slot; a metered OpenAI API key.
const c01 = account("acc_c01", "codex", "subscription", { label: "ChatGPT 01", identity: { login: "login-a" } })
const s01 = account("acc_s01", "siwc", "subscription", { label: "Sign in 01", identity: { login: "login-a" } })
const c02 = account("acc_c02", "codex", "subscription", { label: "ChatGPT 02", identity: { login: "login-b" } })
const s02 = account("acc_s02", "siwc", "subscription", { label: "Sign in 02", identity: {} })
const c03 = account("acc_c03", "codex", "subscription", { label: "ChatGPT 03", status: "disabled" })
const claude = account("acc_claude", "claude-sub", "subscription", { label: "Claude 구독" })
const oai = account("acc_oai", "oai", "metered", { label: "OpenAI · 개인" })
const ACCOUNTS = [c01, s01, c02, s02, c03, claude, oai]
const lookup: Preset.Lookup = (accountID) => ACCOUNTS.find((item) => item.id === accountID)

function team(role: "main" | "owner", accounts: readonly Account.View[] = [c01]): Preset.Team {
  // SAFETY: fixture; branded ids are plain strings at runtime.
  return { teamID: TEAM, role, accounts: accounts.map((item) => item.id), pinned: [] } as unknown as Preset.Team
}

const ref = (item: Account.View, id = "gpt-6-astra", variant?: string): TargetRef => ({
  providerID: item.providerID,
  id,
  variant,
})

describe("team filter (06 §10.1, 07 §5.5)", () => {
  test("the same login's codex and siwc accounts are one subscription; an unknown login never is", () => {
    expect(Preset.oneSubscription(c01, s01)).toBe(true)
    expect(Preset.oneSubscription(c01, c02)).toBe(false)
    expect(Preset.oneSubscription(c01, s02)).toBe(false)
    expect(Preset.oneSubscription(s02, s02)).toBe(true)
  })

  test("other subscriptions of a team company are outside; other companies and paid keys are not", () => {
    const context = team("owner")
    expect(outsideTeam(c02, context, lookup)).toBe(true)
    expect(outsideTeam(s02, context, lookup)).toBe(true)
    expect(outsideTeam(s01, context, lookup)).toBe(false)
    expect(outsideTeam(c01, context, lookup)).toBe(false)
    expect(outsideTeam(claude, context, lookup)).toBe(false)
    expect(outsideTeam(oai, context, lookup)).toBe(false)
    // A team with the Claude slot: another company stays, its own account stays.
    expect(outsideTeam(claude, team("owner", [c01, claude]), lookup)).toBe(false)
  })

  test("the list keeps the team account and its same-login sibling and names the hidden company once", () => {
    const listed = teamAccounts(ACCOUNTS, team("owner"), lookup)
    expect<string[]>(listed.shown.map((item) => item.id)).toEqual(["acc_c01", "acc_s01", "acc_claude", "acc_oai"])
    expect(listed.hidden).toEqual(["openai"])
    // Only a turned-off account outside the team names no company.
    expect(teamAccounts([c01, c03], team("owner"), lookup).hidden).toEqual([])
  })

  test("the greyed line names the company's product", () => {
    const text = textOf(ko)
    expect(text("own.team.mainPicker.hidden", { company: "ChatGPT" })).toBe(
      "다른 ChatGPT 계정은 팀에 넣을 수 없어 목록에 없어요",
    )
  })
})

describe("routes of a team session (06 §9.5, §10.1)", () => {
  const owner: SessionPlace = {
    teamID: TEAM as OwnTeam.TeamID,
    role: "owner",
    areaID: "ar_web" as OwnTeam.AreaID,
    previous: false,
    hint: false,
  }
  const main: SessionPlace = { teamID: TEAM as OwnTeam.TeamID, role: "main", previous: false, hint: false }

  test("an owner conversation goes through its area main, whatever the target", () => {
    for (const target of [c01, claude, oai])
      expect(switchRoute({ place: owner, team: team("owner"), target, lookup })).toEqual({
        kind: "owner",
        teamID: TEAM,
        areaID: "ar_web",
      })
  })

  test("the team main: another subscription of a team company is 팀 계정 바꾸기; the same login is not", () => {
    expect(switchRoute({ place: main, team: team("main"), target: c02, lookup })).toEqual({
      kind: "team-account",
      teamID: TEAM,
    })
    expect(switchRoute({ place: main, team: team("main"), target: s01, lookup })).toEqual({ kind: "plain" })
    expect(switchRoute({ place: main, team: team("main"), target: claude, lookup })).toEqual({ kind: "plain" })
    // Binding not loaded yet: plain, and the service's `team_switch_required` takes over.
    expect(switchRoute({ place: main, team: undefined, target: c02, lookup })).toEqual({ kind: "plain" })
  })

  test("a replaced conversation and a session outside any team switch plainly", () => {
    expect(switchRoute({ place: { ...owner, previous: true }, team: team("owner"), target: c01, lookup })).toEqual({
      kind: "plain",
    })
    expect(switchRoute({ place: undefined, team: undefined, target: c02, lookup })).toEqual({ kind: "plain" })
  })

  test("team_switch_required carries the team", () => {
    expect(teamSwitchRequired(new OwnRpcError("team_switch_required", "x", { teamID: TEAM }))).toBe(TEAM)
    expect(teamSwitchRequired(new OwnRpcError("session_busy", "x", { teamID: TEAM }))).toBeUndefined()
    expect(teamSwitchRequired(new OwnRpcError("team_switch_required", "x"))).toBeUndefined()
    expect(teamSwitchRequired(new Error("team_switch_required"))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------------------------

type Option = Partial<Estimate.Option>

function estimate(input: { readonly P?: number; readonly busy?: number; readonly options?: Option[] } = {}) {
  // SAFETY: fixture shaped like `switch.estimate`; branded ids are plain strings at runtime.
  return {
    estimateID: "est_1",
    expiresAt: Date.now() + 300_000,
    context: { P: input.P ?? 5_000, Z: 1_000, units: { source: "credits", target: "credits" } },
    target: { providerID: c02.providerID, id: "gpt-6-astra", fits: true },
    options: (input.options ?? [{}]).map((option) => ({
      strategy: "now",
      available: true,
      display: "primary",
      delta: { lo: 0.1, hi: 0.1, unit: "credits" },
      ...option,
    })),
    variantOnly: null,
    busyChildren: input.busy ? { count: input.busy, accountID: c01.id } : null,
    confidence: { steps: 4, recentError: 0.1 },
    inputs: { W_lo: 0, W_hi: 0, rates: {}, ttl: { lo: null, hi: null } },
  } as unknown as Estimate.Result
}

const PLAN = {
  areas: [
    { areaID: "ar_web", rotate: true, busy: true },
    { areaID: "ar_api", rotate: false, busy: false },
    { areaID: "ar_docs", rotate: true, busy: false },
  ],
  busy: { sessions: 2, children: 1 },
  estimate: null,
  r4: [{ areaID: "ar_web", presetID: "pr_01J0000000000000000000000A", accountID: "acc_c03", roles: ["own-review"] }],
} as unknown as OwnTeam.AccountPlan

interface Call {
  readonly to: "own" | "team"
  readonly method: string
  readonly input: Record<string, unknown>
}

/** A runtime with the store fields the flow reads; RPC answers come from `answer`, every call is recorded. */
function fake(input: {
  readonly places?: Record<string, SessionPlace>
  readonly bindings?: Record<string, Preset.Team>
  readonly current?: Record<string, TargetRef>
  readonly answer?: (to: "own" | "team", method: string, payload: Record<string, unknown>) => unknown
}) {
  const calls: Call[] = []
  const call = (to: "own" | "team") => async (method: string, payload: Record<string, unknown>) => {
    calls.push({ to, method, input: payload })
    if (method === "policy.get") return { policy: undefined }
    return input.answer?.(to, method, payload) ?? (to === "own" ? { state: "STEADY" } : {})
  }
  const runtime = {
    key: "srv-test",
    kind: "local",
    own: {
      state: {
        accounts: Object.fromEntries(ACCOUNTS.map((item) => [item.id, item])),
        accountOrder: ACCOUNTS.map((item) => item.id),
        binding: Object.fromEntries(Object.entries(input.current ?? {}).map(([id, model]) => [id, { model }])),
        cache: {},
        // No pending switch record names an account (SL-17).
        switchState: {},
        sessionPreset: Object.fromEntries(
          Object.entries(input.bindings ?? {}).map(([id, context]) => [id, { binding: { team: context } }]),
        ),
      },
      accountFor: (providerID: string) => ACCOUNTS.find((item) => item.providerID === providerID),
      // No binding names an account here: a session's account is its provider's.
      accountOfSession: (_sessionID: string, providerID: string) =>
        ACCOUNTS.find((item) => item.providerID === providerID),
      on: () => () => {},
    },
    rpc: { allowed: () => true, call: call("own") },
    team: {
      placeOf: (sessionID: string) => input.places?.[sessionID],
      team: () => undefined,
      area: () => undefined,
      rpc: { allowed: () => true, call: call("team") },
    },
    bus: { on: () => () => {} },
    data: { session: { get: () => undefined, status: () => "idle", family: () => [] } },
  } as unknown as ServerRuntime
  const env: FlowEnv = { runtime, serverKey: "local", i18n: ko, navigate: () => {} }
  return { env, calls }
}

const methods = (calls: readonly Call[]) =>
  calls.filter((item) => item.method !== "policy.get").map((item) => `${item.to}:${item.method}`)

afterEach(() => {
  switcherControl.closeDialog()
  switcherControl.close()
  closeTeamDialog("ses_main")
  closeTeamDialog("ses_plain")
})

describe("switch flow in team sessions (06 §9.5, §10.1; 07 §5.5)", () => {
  const ownerPlace: SessionPlace = {
    teamID: TEAM as OwnTeam.TeamID,
    role: "owner",
    areaID: "ar_web" as OwnTeam.AreaID,
    previous: false,
    hint: false,
  }
  const mainPlace: SessionPlace = { teamID: TEAM as OwnTeam.TeamID, role: "main", previous: false, hint: false }

  test("an owner conversation's change goes to area.main{model, now:true}, never to switch.apply", async () => {
    const { env, calls } = fake({ places: { ses_owner: ownerPlace }, current: { ses_owner: ref(c01, "gpt-6-astra") } })
    const target = ref(c01, "gpt-6-luna", "high")
    const outcome = await requestSwitch(env, { sessionID: "ses_owner", target, estimate: estimate() })
    expect(outcome).toBe("applied")
    expect(methods(calls)).toEqual(["team:area.main"])
    expect(calls.at(-1)?.input).toEqual({ teamID: TEAM, areaID: "ar_web", model: target, now: true })
  })

  test("the team main choosing another ChatGPT subscription plans 팀 계정 바꾸기 and opens it as the cost dialog", async () => {
    const { env, calls } = fake({
      places: { ses_main: mainPlace },
      bindings: { ses_main: team("main") },
      current: { ses_main: ref(c01) },
      answer: (to, method) => (to === "team" && method === "team.account" ? { plan: PLAN } : undefined),
    })
    const target = ref(c02)
    expect(await requestSwitch(env, { sessionID: "ses_main", target })).toBe("dialog")
    // No estimate: own.accounts would refuse it without the team's op.
    expect(methods(calls)).toEqual(["team:team.account"])
    expect(calls[0]?.input).toEqual({ teamID: TEAM, target, dryRun: true })
    expect(switcherControl.state.dialog?.sessionID).toBe("ses_main")
    expect(teamDialogOf("ses_main", target)?.plan).toEqual(PLAN)
    expect(teamDialogOf("ses_main", ref(c01))).toBeUndefined()
  })

  test("the same login's siwc account is a plain switch on the team main", async () => {
    const { env, calls } = fake({
      places: { ses_main: mainPlace },
      bindings: { ses_main: team("main") },
      current: { ses_main: ref(c01) },
    })
    expect(await requestSwitch(env, { sessionID: "ses_main", target: ref(s01), estimate: estimate() })).toBe("applied")
    expect(methods(calls)).toEqual(["own:switch.apply"])
  })

  test("team_switch_required from the estimate opens the same 팀 계정 바꾸기 flow", async () => {
    const { env, calls } = fake({
      current: { ses_plain: ref(c01) },
      answer: (to, method) => {
        if (to === "own" && method === "switch.estimate")
          throw new OwnRpcError("team_switch_required", "team", { teamID: TEAM })
        if (to === "team" && method === "team.account") return { plan: PLAN }
        return undefined
      },
    })
    expect(await requestSwitch(env, { sessionID: "ses_plain", target: ref(c02) })).toBe("dialog")
    expect(methods(calls)).toEqual(["own:switch.estimate", "team:team.account"])
    expect(teamDialogOf("ses_plain", ref(c02))?.teamID).toBe(TEAM)
  })

  test("team_switch_required from switch.apply opens it too", async () => {
    const { env, calls } = fake({
      current: { ses_plain: ref(c01) },
      answer: (to, method) => {
        if (to === "own" && method === "switch.apply")
          throw new OwnRpcError("team_switch_required", "team", { teamID: TEAM })
        if (to === "team" && method === "team.account") return { plan: PLAN }
        return undefined
      },
    })
    expect(await applyNow(env, { sessionID: "ses_plain", target: ref(c02) })).toBe(false)
    expect(methods(calls)).toEqual(["own:switch.apply", "team:team.account"])
    expect(switcherControl.state.dialog?.sessionID).toBe("ses_plain")
  })

  test("[끝나면 바꾸기] / [멈추고 바꾸기] run team.account{mode} without dryRun", async () => {
    const { env, calls } = fake({})
    expect(await runTeamAccount(env, { teamID: TEAM, target: ref(c02), mode: "stop" })).toBe(true)
    expect(calls).toEqual([
      { to: "team", method: "team.account", input: { teamID: TEAM, target: ref(c02), mode: "stop" } },
    ])
  })

  test("팀과 같게 is area.main{model: null}", async () => {
    const { env, calls } = fake({})
    expect(await applyAreaMain(env, { teamID: TEAM, areaID: "ar_web", model: null })).toBe(true)
    expect(calls[0]).toEqual({
      to: "team",
      method: "area.main",
      input: { teamID: TEAM, areaID: "ar_web", model: null, now: undefined },
    })
  })
})

describe("child wait (07 §5.5)", () => {
  const decision: Decision = { level: "immediate", tokens: { lo: 0, hi: 5_000 } }

  test("subagents on the old subscription always ask", () => {
    expect(withChildWait(decision, { busyChildren: { count: 2, accountID: c01.id } }).level).toBe("dialog")
    expect(withChildWait(decision, { busyChildren: null }).level).toBe("immediate")
    expect(withChildWait({ ...decision, level: "same" }, { busyChildren: { count: 1, accountID: c01.id } }).level).toBe(
      "same",
    )
  })

  test("a small switch with busy children opens the dialog instead of applying", async () => {
    const { env, calls } = fake({ current: { ses_plain: ref(c01) } })
    const outcome = await requestSwitch(env, {
      sessionID: "ses_plain",
      target: ref(c02),
      estimate: estimate({ busy: 2 }),
    })
    expect(outcome).toBe("dialog")
    expect(methods(calls)).toEqual([])
    expect(switcherControl.state.dialog?.sessionID).toBe("ses_plain")
  })

  test("the dialog's choice reaches switch.apply{children}", async () => {
    const { env, calls } = fake({ current: { ses_plain: ref(c01) } })
    const result = estimate({ busy: 2 })
    const ok = await executeStrategy(env, {
      sessionID: "ses_plain",
      target: ref(c02),
      estimate: result,
      option: result.options[0]!,
      children: "stop",
    })
    expect(ok).toBe(true)
    expect(calls.find((item) => item.method === "switch.apply")?.input).toMatchObject({
      strategy: "now",
      children: "stop",
    })
  })

  test("the line names the old account", () => {
    expect(childWaitText(ko, "ChatGPT 01", 2)).toBe("ChatGPT 01에서 하위 에이전트 2개가 실행 중이에요")
    expect(childWaitText(en, "ChatGPT 01", 2)).toBe("2 subagents are running on ChatGPT 01")
  })
})

describe("compacting strategies: the service compacts (02 §5.9(b)(c), 03 §6.5)", () => {
  async function run(state: string, strategy: "compact-then-switch" | "switch-then-compact") {
    const { env, calls } = fake({
      current: { ses_plain: ref(c01) },
      answer: (_to, method) => (method === "switch.apply" ? { state } : undefined),
    })
    const result = estimate({ options: [{ strategy } as Option] })
    const ok = await executeStrategy(env, {
      sessionID: "ses_plain",
      target: ref(c02),
      estimate: result,
      option: result.options[0]!,
    })
    return { ok, methods: methods(calls) }
  }

  test("COMPACTING and SWITCHING succeed without any client compaction", async () => {
    expect(await run("COMPACTING", "compact-then-switch")).toEqual({ ok: true, methods: ["own:switch.apply"] })
    expect(await run("SWITCHING", "switch-then-compact")).toEqual({ ok: true, methods: ["own:switch.apply"] })
  })

  test("PLANNED: the service could not admit the compaction, so nothing switched", async () => {
    expect(await run("PLANNED", "compact-then-switch")).toEqual({ ok: false, methods: ["own:switch.apply"] })
  })
})

describe("팀 계정 바꾸기 lines (06 §10.1)", () => {
  const names = {
    to: "ChatGPT 02",
    from: "ChatGPT 01",
    area: (areaID: string) => (areaID === "ar_web" ? "cl-perf" : areaID),
    preset: () => "다른 회사 리뷰",
    account: (accountID: string) => (accountID === "acc_c03" ? "ChatGPT 03" : accountID),
    role: () => "리뷰",
  }

  test("the team-wide line, the areas in new conversations and the R4 repairs", () => {
    const lines = teamAccountLines(textOf(ko), PLAN, names)
    expect(lines.move).toBe(
      "팀 전체(메인과 영역 3개)를 ChatGPT 02로 · ChatGPT 01에서 대화 2개와 하위 에이전트 1개가 일하는 중이에요",
    )
    expect(lines.rotate).toBe("영역 2개는 새 대화로 이어 가요")
    expect(lines.repairs).toEqual(["'다른 회사 리뷰'가 ChatGPT 03을 써서 cl-perf 리뷰를 cl-perf 모델로 돌려요"])
    expect(lines.waits).toBe(true)
  })

  test("nothing working: the idle line, no rotation line", () => {
    const idle = { ...PLAN, areas: [], busy: { sessions: 0, children: 0 }, r4: [] } as OwnTeam.AccountPlan
    const lines = teamAccountLines(textOf(ko), idle, names)
    expect(lines.move).toBe("팀 전체(메인과 영역 0개)를 ChatGPT 02로 · ChatGPT 01에서 일하는 대화가 없어요")
    expect(lines.rotate).toBeUndefined()
    expect(lines.waits).toBe(false)
  })
})

describe("cross-group preset line (07 §5.3)", () => {
  function preset(id: string, name: string, group: Preset.Group, pins: readonly Account.View[] = []): Preset.Listed {
    // SAFETY: fixture shaped like `presets.list` rows; branded ids are plain strings at runtime.
    return {
      id,
      name,
      group,
      workers: {
        mode: pins.length ? "by-role" : "same",
        roles: pins.length
          ? {
              "own-review": {
                targets: pins.map((item) => ({ pin: { account: item.id, model: "m" } })),
                effort: "inherit",
              },
            }
          : {},
      },
      delegation: "model",
      caps: { concurrent: 3, perMessage: 6, perSession: null },
      ultraCaps: null,
      revision: 1,
      status: "ok",
    } as unknown as Preset.Listed
  }
  const review = preset("pr_01J0000000000000000000000B", "Claude 리뷰", "codex", [claude])
  const claudeReview = preset("pr_01J0000000000000000000000C", "Claude 리뷰", "claude-sub")
  const claudeStar = preset("pr_01J0000000000000000000000D", "가볍게", "claude-sub")
  const pinsC02 = preset("pr_01J0000000000000000000000E", "ChatGPT 02 리뷰", "claude-sub", [c02])
  const view = (presets: Preset.Listed[], star?: string) =>
    ({ group: "claude-sub", defaultModel: null, presets, star }) as unknown as Preset.GroupView
  const move = (current: Preset.Listed, target: Preset.GroupView | undefined, context?: Preset.Team) =>
    presetMove({ from: "codex", to: "claude-sub", current, view: target, main: claude.id, lookup, team: context })

  test("the group's preset of the same name first, else its ★, else 평소대로", () => {
    expect(move(review, view([claudeReview, claudeStar], claudeStar.id))?.to.id).toBe(claudeReview.id)
    const other = preset("pr_01J0000000000000000000000F", "다른 이름", "codex")
    expect(move(other, view([claudeReview, claudeStar], claudeStar.id))?.to.id).toBe(claudeStar.id)
    expect<string | undefined>(move(other, view([claudeReview]))?.to.id).toBe("builtin:claude-sub")
    // A remote server lists no presets: 평소대로.
    expect<string | undefined>(move(review, undefined)?.to.id).toBe("builtin:claude-sub")
  })

  test("a preset that breaks R4 with the team is skipped", () => {
    expect<string | undefined>(move(pinsC02, view([pinsC02], pinsC02.id), team("main"))?.to.id).toBe(
      "builtin:claude-sub",
    )
  })

  test("same group: no line; the line in words", () => {
    expect(
      presetMove({ from: "codex", to: "codex", current: review, view: undefined, main: c01.id, lookup }),
    ).toBeUndefined()
    const line = move(review, view([claudeStar], claudeStar.id))!
    expect(presetMoveText(ko, line)).toBe("프리셋: Claude 리뷰 → 가볍게(Claude 구독)")
    expect(presetMoveText(ko, move(review, undefined)!)).toBe("프리셋: Claude 리뷰 → 평소대로(Claude 구독)")
    expect(presetMoveText(en, move(review, undefined)!)).toBe("Preset: Claude 리뷰 → As usual (Claude subscription)")
  })

  test("a remote session reads its server's mirror of this PC's presets; one without it keeps 평소대로 (07 §8.1 원격)", () => {
    const here = {
      codex: { group: "codex", defaultModel: null, presets: [review] } as unknown as Preset.GroupView,
      "claude-sub": view([claudeReview, claudeStar], claudeStar.id),
    }
    const session = { binding: null, preset: review } as unknown as Preset.SessionView
    const remote = (presetGroups: Readonly<Record<string, Preset.GroupView>>) =>
      // SAFETY: the parts of a remote server's runtime `presetLineFor` reads.
      ({
        kind: "ssh",
        own: {
          accountFor: (providerID: string) => ACCOUNTS.find((item) => item.providerID === providerID),
          state: {
            presetGroups,
            sessionPreset: { ses_remote: session },
            accounts: Object.fromEntries(ACCOUNTS.map((item) => [item.id, item])),
          },
        },
      }) as unknown as ServerRuntime
    const line = (runtime: ServerRuntime) =>
      presetLineFor({
        i18n: ko,
        runtime,
        groups: here,
        base: ref(c01),
        target: ref(claude, "claude-opus"),
        sessionID: "ses_remote",
      })
    expect(line(remote(here))).toBe("프리셋: Claude 리뷰 → Claude 리뷰(Claude 구독)")
    const older = {
      codex: { group: "codex", defaultModel: null, presets: [] } as unknown as Preset.GroupView,
      "claude-sub": view([]),
    }
    expect(line(remote(older))).toBe("프리셋: 평소대로 → 평소대로(Claude 구독)")
  })

  test("the preset in use: the session's while in the group, else the group's ★", () => {
    const session = { binding: null, preset: review } as unknown as Preset.SessionView
    expect(presetNow("codex", session, undefined).id).toBe(review.id)
    expect(presetNow("claude-sub", session, view([claudeStar], claudeStar.id)).id).toBe(claudeStar.id)
    expect<string>(presetNow("claude-sub", undefined, undefined).id).toBe("builtin:claude-sub")
    expect(groupName(ko, "local:ollama")).toBe("Ollama")
    expect(groupName(ko, "siwc")).toBe("Sign in with ChatGPT")
  })
})

describe("area switcher (06 §10.1 `모델 바꾸기…`)", () => {
  test("team/intents opens the switcher on the area's server with no session of the route", () => {
    switcherControl.setRoute("local", "ses_on_screen")
    openSwitcherForArea({ serverKey: "srv-ssh", teamID: TEAM as OwnTeam.TeamID, areaID: "ar_web" as OwnTeam.AreaID })
    const open = switcherControl.state.open
    expect(open?.serverKey).toBe("srv-ssh")
    expect(open?.sessionID).toBeUndefined()
    expect(areaOf(open!.seq)).toMatchObject({ teamID: TEAM, areaID: "ar_web" })
  })

  test("a plain open afterwards is not an area's", () => {
    openSwitcher({
      serverKey: "local",
      teamID: TEAM as OwnTeam.TeamID,
      areaID: "ar_web" as OwnTeam.AreaID,
      mode: "area",
    })
    openSwitcher({})
    expect(areaOf(switcherControl.state.open!.seq)).toBeUndefined()
  })
})
