// TG15 메인·프리셋·R4 (T1 items) and 07 PG2 (바) on a real server (06 §11.3, §10.1; 07 §5.1, §5.4, §5.5, §8.4):
// ChatGPT 01, 02 and 03 (one fake Codex backend), the Claude subscription slot (fake claude-auth shim) and a metered
// DeepSeek key, a team of three areas on F1 enabled from a ChatGPT 01 conversation that has its own preset and ultra.
//
// - The team main takes the enabling conversation's model, the group's ★ and no ultra; new areas follow the main
//   (팀과 같게) with the ★.
// - Team R4: an area main or area preset that adds another subscription of the team's company is refused
//   (`same_company_subscription`); another company's subscription is fine; a preset of another group is
//   `preset_wrong_group`. A preset edited later to break R4 is saved, the gate turns the target back to the main, and
//   own.team posts a repair notice.
// - PG2 (바): an owner's switch to another ChatGPT account is `team_switch_required`, and its exhaustion suggestions
//   leave the other ChatGPT accounts out.
// - The team main's effort change is followed by the 팀과 같게 owners in their conversations (no rotation).
// - 팀 계정 바꾸기: 01 → 02 `끝나면 바꾸기` while two owners and a subagent work (the old account's work ends before
//   anything runs on the new one; warm handoffs on 01; the subagent stays on 01), 02 → 03 `멈추고 바꾸기` and 03 → 01
//   with 03 exhausted (no handoff turn, nothing more on the old account).
// - The worst case of concurrent runs reads from every owner's live caps (`session.preset.get`), ultra included.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Preset, OwnTeam } from "@own/protocol"
import { childOf, toolParts } from "../../../own-accounts/test/e2e-kit"
import {
  ACCOUNT,
  BOOT_TIMEOUT,
  CHATGPT,
  CLAUDE,
  MODEL,
  SLOT,
  active,
  codexIdentity,
  enableTeam,
  messages,
  opEnd,
  ops,
  pin,
  presetOf,
  savePreset,
  sessionRows,
  startTeamFakes,
  startTeamServer,
  until,
  type ChatGPT,
  type TeamFakes,
  type TeamServer,
} from "./harness.js"
import { inbox, ofSession } from "./inspect.js"

const STEP_TIMEOUT = 300_000
/** An op that waits for the old account's work: shorter than a test, so a stuck op names its steps. */
const OP_TIMEOUT = 200_000
const AREA = {
  1: OwnTeam.AreaID.make("ar_area-1"),
  2: OwnTeam.AreaID.make("ar_area-2"),
  3: OwnTeam.AreaID.make("ar_area-3"),
}

interface Team {
  readonly server: TeamServer
  readonly fakes: TeamFakes
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly viewed: string
  /** The enabling conversation's own preset. */
  readonly own: string
}

describe("TG15 team main, area main and preset, R4 and the team account (T1)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const fakes = startTeamFakes()
    const server = await startTeamServer({ name: "account", fakes, claude: true })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    // The enabling conversation has a preset of its own and ultra on: the team main inherits neither (07 §5.1).
    const own = await savePreset(server, "켠 대화의 프리셋", "codex", { "own-review": [{ rel: "main" }] })
    await server.accounts("session.preset.apply", { sessionID: viewed, presetID: own }, server.project)
    await server.accounts("session.ultra.set", { sessionID: viewed, on: true }, server.project)
    const enabled = await enableTeam(server, { hint: "[propose-areas 3]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.team = { server, fakes, teamID: team.id, main: team.main.sessionID, viewed, own }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
    await state.team?.fakes.stop()
  }, 120_000)

  test(
    "the main and the new areas: the conversation's account and model, the group's ★, no preset or ultra inherited",
    async () => {
      const team = required(state.team)
      const project = required(team.server.project)
      const viewed = rowOf(team, team.viewed)
      const main = rowOf(team, team.main)
      // The enabling conversation keeps its own preset with ultra on.
      const before = await presetOf(team.server, team.viewed, project)
      expect<unknown>(before.binding?.presetID).toBe(team.own)
      expect(before.binding?.ultra).toBeDefined()
      expect(main.model).toMatchObject({ providerID: SLOT["01"], id: required(viewed.model ?? undefined).id })
      const mainPreset = await presetOf(team.server, team.main, project)
      expect(mainPreset.binding).toMatchObject({ presetID: Preset.builtinID("codex"), team: { role: "main" } })
      expect(mainPreset.binding?.ultra).toBeUndefined()
      const view = await team.server.team("team.get", { directory: project })
      expect(view.areas).toHaveLength(3)
      for (const area of view.areas) {
        expect(area.main).toBeUndefined()
        expect(area.preset).toBe(Preset.builtinID("codex"))
        const owner = required(area.owner.sessionID ?? undefined)
        expect(rowOf(team, owner).model).toMatchObject({
          providerID: SLOT["01"],
          id: required(main.model ?? undefined).id,
        })
        const bound = await presetOf(team.server, owner, area.directory)
        expect(bound.binding).toMatchObject({
          presetID: Preset.builtinID("codex"),
          team: { teamID: team.teamID, role: "owner", accounts: [ACCOUNT["01"]] },
        })
        expect(bound.binding?.ultra).toBeUndefined()
      }
    },
    STEP_TIMEOUT,
  )

  test(
    "R4: another ChatGPT account as an area main is refused; the Claude subscription is fine; its preset is checked",
    async () => {
      const team = required(state.team)
      for (const id of ["02", "03"] as const) {
        const refused = await team.server.rpc(OwnTeam.ID, "area.main", {
          teamID: team.teamID,
          areaID: AREA[1],
          model: MODEL[id],
        })
        expect(refused).toMatchObject({
          status: 400,
          type: "same_company_subscription",
          data: { accountID: ACCOUNT[id] },
        })
      }
      const moved = await team.server.team("area.main", { teamID: team.teamID, areaID: AREA[1], model: CLAUDE.model })
      expect((await opEnd(team.server, required(moved.opID))).state).toBe("done")
      const area = await areaOf(team, AREA[1])
      expect(area.main).toMatchObject({ model: CLAUDE.model, chosenBy: "user" })
      expect(area.preset).toBe(Preset.builtinID("claude-sub"))
      expect(rowOf(team, required(area.owner.sessionID ?? undefined)).model).toMatchObject(CLAUDE.model)

      // A Claude-group preset reviewing on ChatGPT 03: fine on its own (07 §5.4), two OpenAI subscriptions in the team.
      const reviewOn03 = await savePreset(team.server, "다른 회사 리뷰(03)", "claude-sub", {
        "own-review": [pin(ACCOUNT["03"])],
      })
      expect(
        await team.server.rpc(OwnTeam.ID, "area.preset", {
          teamID: team.teamID,
          areaID: AREA[1],
          presetID: reviewOn03,
        }),
      ).toMatchObject({ status: 400, type: "same_company_subscription", data: { accountID: ACCOUNT["03"] } })
      expect(
        await team.server.rpc(OwnTeam.ID, "area.preset", {
          teamID: team.teamID,
          areaID: AREA[1],
          presetID: Preset.builtinID("codex"),
        }),
      ).toMatchObject({ status: 400, type: "preset_wrong_group", data: { group: "claude-sub" } })
      expect((await areaOf(team, AREA[1])).preset).toBe(Preset.builtinID("claude-sub"))
      expect(requestsOf(team, "02")).toEqual([])
      expect(requestsOf(team, "03")).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "a preset edited later to break R4 is saved; the gate runs its review on the main and own.team posts a repair",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, AREA[1])
      const owner = required(area.owner.sessionID ?? undefined)
      const review = await savePreset(team.server, "Claude 리뷰", "claude-sub", { "own-review": [{ rel: "main" }] })
      await team.server.team("area.preset", { teamID: team.teamID, areaID: AREA[1], presetID: review })
      const edited = await team.server.accounts("presets.set", {
        preset: {
          id: review,
          name: "Claude 리뷰",
          group: "claude-sub",
          workers: { mode: "by-role", roles: { "own-review": { targets: [pin(ACCOUNT["03"])], effort: "inherit" } } },
          delegation: "when-useful",
          caps: Preset.CAPS,
          ultraCaps: null,
        },
      })
      expect(edited.dryRun).toBe(false)
      await team.server.events.waitFor(
        (event) =>
          event.type === "rpc.own.team.notice" && event.data.kind === "preset.repair" && event.data.areaID === AREA[1],
        60_000,
      )
      // The owner's review runs, on the main (Claude), never on ChatGPT 03.
      await team.server.turn(owner, "[subagent own-review 검토해 주세요]")
      const call = required((await toolParts(team.server.server, owner, "subagent")).at(-1))
      const child = await childOf(team.server.server, call)
      expect(child.model).toMatchObject({ providerID: CLAUDE.model.providerID })
      expect(requestsOf(team, "03")).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "PG2 (바): an owner cannot switch to another ChatGPT account (`team_switch_required`)",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, AREA[2])
      const owner = required(area.owner.sessionID ?? undefined)
      for (const id of ["02", "03"] as const) {
        const applied = await team.server.rpc(
          "own.accounts",
          "switch.apply",
          { sessionID: owner, target: MODEL[id], strategy: "now", reason: "manual" },
          area.directory,
        )
        expect(applied).toMatchObject({ status: 400, type: "team_switch_required", data: { teamID: team.teamID } })
        const estimated = await team.server.rpc(
          "own.accounts",
          "switch.estimate",
          { sessionID: owner, target: MODEL[id] },
          area.directory,
        )
        expect(estimated).toMatchObject({ status: 400, type: "team_switch_required" })
      }
      expect(rowOf(team, owner).model).toMatchObject({ providerID: SLOT["01"] })
    },
    STEP_TIMEOUT,
  )

  test(
    "the team main's effort change: 팀과 같게 owners follow in their conversations, no rotation",
    async () => {
      const team = required(state.team)
      const project = required(team.server.project)
      const rotations = ops(db(team), team.teamID).filter((op) => op.kind === "rotate").length
      const high = { ...MODEL["01"], variant: "high" }
      await team.server.accounts(
        "switch.apply",
        { sessionID: team.main, target: high, strategy: "now", reason: "manual" },
        project,
      )
      for (const areaID of [AREA[2], AREA[3]]) {
        const owner = required((await areaOf(team, areaID)).owner.sessionID ?? undefined)
        await until(
          async () => rowOf(team, owner).model?.variant === "high",
          `the owner of ${areaID} did not follow the main's effort`,
          120_000,
        )
      }
      expect(ops(db(team), team.teamID).filter((op) => op.kind === "rotate")).toHaveLength(rotations)
    },
    STEP_TIMEOUT,
  )

  test(
    "the worst case reads every owner's live caps; ultra in one owner counts with the ultra caps",
    async () => {
      const team = required(state.team)
      const worst = async () => {
        const view = await team.server.team("team.get", { directory: required(team.server.project) })
        const caps = await Promise.all(
          view.areas.map(async (area) => {
            const bound = await presetOf(team.server, required(area.owner.sessionID ?? undefined), area.directory)
            return bound.caps.concurrent
          }),
        )
        return { areas: view.areas.length, total: view.areas.length + caps.reduce((sum, item) => sum + item, 0) }
      }
      expect(await worst()).toEqual({ areas: 3, total: 3 * (1 + Preset.CAPS.concurrent) })
      const area = await areaOf(team, AREA[3])
      const owner = required(area.owner.sessionID ?? undefined)
      await team.server.accounts("session.ultra.set", { sessionID: owner, on: true }, area.directory)
      const ultra = (await presetOf(team.server, owner, area.directory)).caps.concurrent
      expect(ultra).toBeGreaterThan(Preset.CAPS.concurrent)
      expect(await worst()).toEqual({ areas: 3, total: 3 + 2 * Preset.CAPS.concurrent + ultra })
      await team.server.accounts("session.ultra.set", { sessionID: owner, on: false }, area.directory)
      // The team view's usage per account: the team account's limit windows from its own responses.
      const quota = await team.server.accounts("quota.snapshot", { accountIDs: [ACCOUNT["01"]] })
      const windows = Array.isArray(quota.windows) ? quota.windows : []
      expect(windows.length).toBeGreaterThan(0)
      expect(JSON.stringify(windows)).toContain(ACCOUNT["01"])
    },
    STEP_TIMEOUT,
  )

  test(
    "team account 01 → 02 after idle while two owners and a subagent work: 01 and 02 never overlap",
    async () => {
      const team = required(state.team)
      const project = required(team.server.project)
      const busy = await areaOf(team, AREA[2])
      const parent = await areaOf(team, AREA[3])
      const owner2 = required(busy.owner.sessionID ?? undefined)
      const owner3 = required(parent.owner.sessionID ?? undefined)
      await team.server.server.prompt(owner2, "[slow 8000] [report progress 일하는 중]")
      await team.server.server.prompt(owner3, "[subagent general [slow 8000] 하위 작업]")
      await until(async () => {
        const running = await active(team.server)
        const children = sessionRows(db(team)).filter((row) => row.parentID === owner3 && running.has(row.id))
        return running.has(owner2) && running.has(owner3) && children.length > 0
      }, "the owners and the subagent never started")

      const planned = await team.server.team("team.account", {
        teamID: team.teamID,
        target: MODEL["02"],
        dryRun: true,
      })
      const plan = "plan" in planned ? planned.plan : undefined
      expect(plan?.areas.map((item) => [item.areaID, item.rotate]).toSorted()).toEqual([
        [AREA[2], true],
        [AREA[3], true],
      ])
      expect(plan?.busy.sessions).toBeGreaterThanOrEqual(2)
      expect(plan?.busy.children).toBeGreaterThanOrEqual(1)

      const start = Date.now()
      const started = await team.server.team("team.account", {
        teamID: team.teamID,
        target: MODEL["02"],
        mode: "after-idle",
      })
      const opID = opIDOf(started)
      await team.server.events.waitFor(
        (event) => event.type === "rpc.own.team.notice" && event.data.kind === "account.waiting",
        60_000,
      )
      const op = await opEnd(team.server, opID, { timeoutMs: OP_TIMEOUT })
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      // The account the team main runs on now, from its binding (SL-8).
      expect<unknown>(op.summary?.lines).toContainEqual({
        kind: "account",
        model: MODEL["02"],
        areas: 2,
        accountID: ACCOUNT["02"],
      })

      // The team main moved only after the old account's last request in the team (the owners' work, the subagent and
      // the handoff turns), and nothing ran on 02 before that; then the team works on 02.
      const switched = (await messages(team.server, team.main)).findLast((message) => message.type === "model-switched")
      const time = switched?.time
      const movedAt = typeof time === "object" && time !== null && "created" in time ? Number(time.created) : 0
      const on01 = requestsOf(team, "01").filter((request) => request.at >= start)
      expect(on01.length).toBeGreaterThan(0)
      expect(Math.max(...on01.map((request) => request.at))).toBeLessThan(movedAt)
      expect(requestsOf(team, "02").filter((request) => request.at < movedAt)).toEqual([])
      await team.server.turn(team.main, "새 계정에서 확인합니다")
      expect(requestsOf(team, "02").length).toBeGreaterThan(0)
      // Warm handoffs on 01: each moving owner got the handoff request and wrote the document.
      for (const old of [owner2, owner3]) {
        const synthetic = (await messages(team.server, old)).filter((message) => message.type === "synthetic")
        expect(synthetic.some((message) => String(message.text).startsWith('<team-request kind="handoff"'))).toBe(true)
      }
      // The subagent stayed on 01.
      const call = required((await toolParts(team.server.server, owner3, "subagent")).at(-1))
      const child = await childOf(team.server.server, call)
      expect(ofSession(team.fakes.codex.requests, child.id).map((request) => request.identity)).not.toContain(
        codexIdentity("02"),
      )

      // The team moved: the main on 02, the 팀과 같게 areas in new conversations on 02, the Claude area unchanged.
      expect(rowOf(team, team.main).model).toMatchObject({ providerID: SLOT["02"] })
      // The team's subscriptions: ChatGPT 02 now, and the Claude slot of area 1.
      const accounts = ((await presetOf(team.server, team.main, project)).binding?.team?.accounts ?? []).map(String)
      expect(accounts.toSorted()).toEqual([ACCOUNT.claude, ACCOUNT["02"]].toSorted())
      for (const [areaID, old] of [
        [AREA[2], owner2],
        [AREA[3], owner3],
      ] as const) {
        const area = await areaOf(team, areaID)
        expect(area.owner.previous.at(-1)).toMatchObject({ sessionID: old, why: "team-account" })
        expect(rowOf(team, required(area.owner.sessionID ?? undefined)).model).toMatchObject({
          providerID: SLOT["02"],
        })
      }
      const claude = await areaOf(team, AREA[1])
      const claudeOwner = required(claude.owner.sessionID ?? undefined)
      expect(rowOf(team, claudeOwner).model).toMatchObject(CLAUDE.model)
      // Its preset (whose review pin on ChatGPT 03 the team's R4 holds back) stays bound with the new team context
      // (06 §10.1 "같게 처리한다"): the gate keeps running that role like the main; no rebinding to `평소대로`.
      const bound = await presetOf(team.server, claudeOwner, claude.directory)
      expect(bound.binding?.presetID).toBe(claude.preset)
      expect((bound.binding?.team?.accounts ?? []).map(String)).toContain(ACCOUNT["02"])
      await team.server.events.waitFor(
        (event) => event.type === "rpc.own.team.notice" && event.data.kind === "account.moved",
        60_000,
      )
    },
    STEP_TIMEOUT,
  )

  test(
    "멈추고 바꾸기 02 → 03: the owners stop, no handoff turn, nothing more on 02",
    async () => {
      const team = required(state.team)
      const busy = await areaOf(team, AREA[2])
      const owner = required(busy.owner.sessionID ?? undefined)
      await team.server.server.prompt(owner, "[slow 15000] [report progress 오래 걸리는 일]")
      await until(async () => (await active(team.server)).has(owner), "the owner never started")
      // The run is active before its first request reaches ChatGPT 02 (a loaded PC takes seconds in between): that
      // request belongs to the run the move stops, so the move starts only once it is there.
      await until(
        async () => requestsOf(team, "02").some((request) => request.body.includes("[slow 15000] [report progress")),
        "the owner's request never reached ChatGPT 02",
      )
      // The user also queued a prompt for after the run: it stays parked in the stopped conversation.
      const parked = "대기열에 둔 사용자 입력"
      await team.server.server.prompt(owner, parked, { delivery: "queue" })
      const start = Date.now()
      const started = await team.server.team("team.account", { teamID: team.teamID, target: MODEL["03"], mode: "stop" })
      const op = await opEnd(team.server, opIDOf(started), {
        timeoutMs: OP_TIMEOUT,
      })
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(inbox(db(team), owner).map((row) => JSON.stringify(row.payload))).toEqual([
        expect.stringContaining(parked),
      ])
      expect(op.steps.filter((step) => step.kind === "rotate.handoff").map((step) => step.note)).toEqual([
        "이 앱이 인계 메모를 썼어요",
        "이 앱이 인계 메모를 썼어요",
      ])
      expect(requestsOf(team, "02").filter((request) => request.at >= start)).toEqual([])
      expect(rowOf(team, team.main).model).toMatchObject({ providerID: SLOT["03"] })
    },
    STEP_TIMEOUT,
  )

  test(
    "03 exhausted: owners wait for the limit, suggestions leave the other ChatGPT accounts out, the move needs no turn on 03",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, AREA[2])
      const owner = required(area.owner.sessionID ?? undefined)
      team.fakes.codex.setUsage(CHATGPT["03"].accountID, { primary: 100 })
      await team.server.server.prompt(owner, "한도에 걸리는 질문")
      const suggested = await team.server.events.waitFor(
        (event) => event.type === "rpc.own.accounts.switch.suggested" && event.data.sessionID === owner,
        120_000,
      )
      const candidates = (Array.isArray(suggested.data.candidates) ? suggested.data.candidates : []).map((item) =>
        typeof item === "object" && item !== null && "accountID" in item ? String(item.accountID) : "",
      )
      expect(candidates).not.toContain(ACCOUNT["01"])
      expect(candidates).not.toContain(ACCOUNT["02"])
      // The user waits for the reset (02 §5.9): BLOCKED, and the area shows 한도 대기.
      await team.server.accounts("switch.waitReset", { sessionID: owner }, area.directory)
      await until(
        async () => (await areaOf(team, AREA[2])).status.kind === "waiting-quota",
        "the area does not show 한도 대기",
      )
      // Nothing moves by itself: the owner stays on 03.
      expect(rowOf(team, owner).model).toMatchObject({ providerID: SLOT["03"] })

      const start = Date.now()
      const started = await team.server.team("team.account", {
        teamID: team.teamID,
        target: MODEL["01"],
        mode: "after-idle",
      })
      const op = await opEnd(team.server, opIDOf(started), {
        timeoutMs: OP_TIMEOUT,
      })
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(op.steps.find((step) => step.kind === "rotate.handoff" && step.args.areaID === AREA[2])?.note).toBe(
        "이 앱이 인계 메모를 썼어요",
      )
      expect(requestsOf(team, "03").filter((request) => request.at >= start)).toEqual([])
      expect(rowOf(team, team.main).model).toMatchObject({ providerID: SLOT["01"] })
      team.fakes.codex.setUsage(CHATGPT["03"].accountID, { primary: 0 })
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

function db(team: Team) {
  return team.server.server.paths.database
}

function rowOf(team: Team, sessionID: string) {
  return required(sessionRows(db(team)).find((row) => row.id === sessionID))
}

async function areaOf(team: Team, areaID: OwnTeam.AreaID) {
  const view = await team.server.team("team.get", { directory: required(team.server.project) })
  return required(view.areas.find((area) => area.id === areaID))
}

/** Model requests of one ChatGPT account (the fake attributes them by `chatgpt-account-id`). */
function requestsOf(team: Team, id: ChatGPT) {
  return team.fakes.codex.requests.filter(
    (request) => request.model !== undefined && request.identity === codexIdentity(id),
  )
}

/** The op a `team.account` without `dryRun` started. */
function opIDOf(result: { readonly opID: string } | { readonly plan: unknown }) {
  if (!("opID" in result)) throw new Error("team.account answered a plan")
  return result.opID
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
