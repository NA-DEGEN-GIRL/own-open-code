// Team mode entry points and result cards (06 §9.2, §9.3, §9.7, §5.3, 07 §7.4; TG20 and TG2 UI parts) over a real
// TeamStore, the real event bus and a fake own.team client. Fixtures go through the protocol's schemas. Covered:
// `팀 모드 켜기` calls `enable{directory, sessionID}` without a dialog, shows the progress toasts in order (also for
// steps that ended before the answer), counts the planned areas and opens the team main; refusals and failed ops say
// why, and a second click does nothing while the first is on its way. Where the entry applies (Git, root conversation
// outside a team, feature and scope). 모든 영역 멈추기 / 다시 시작 choices. The result card's lines for enabling a new
// project, for adopted areas and for reused cards, with buttons only for features and scopes this connection has.
// Confirm helpers. The notification list keeps every result and tells the OS while nobody is looking. Copy: the new
// screens hold no Korean text of their own (all copy comes from team/strings.ts). T3: an SSH host answering
// `lfs_missing` gets exactly one upload of the large-file tool and one more enable, never a loop; the confirm dialog's
// unapplied count, bundled title and system-change lines; the retire signal (badge, suggestion card, `[무시]`) and a
// missing folder's `[끝내기]`; the proposal card of 팀 구성 다시 보기. 담당 대화 바꾸기: who gets `이 대화를 담당으로`,
// when it is dimmed, and the seat move from `area.seat` to the toast with the way back.
import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeEvent } from "@opencode/client"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import type { DataLayer, ServerRuntime } from "@/data"
import { createEventBus } from "@/data/events"
import { OwnRpcError } from "@/data/rpc"
import { TEAM_SCOPE, type TeamMethod, type TeamRpc } from "@/data/team-rpc"
import type { HostNotification } from "@/host/types"
import { closeTeamResult, createTeamResultNotifier, teamResults } from "@/shell/notifications"
import { pauseChoices } from "@/sidebar/project-menu"
import type { ToastInput } from "@/switcher/toast"
import { confirmBytes, confirmView, isDestructive, isFetch, isSystem, stepArgs } from "./confirm"
import {
  canEnableTeam,
  opDone,
  openPeerItem,
  peerActions,
  peerItems,
  plannedAreas,
  runEnable,
  runSeat,
  BACK_NAME,
  seatBlock,
  type EnableDeps,
  type SeatDeps,
} from "./enable"
import { teamIntents, type AreaTarget } from "./intents"
import { errorText, seatErrorText, type TeamText } from "./model"
import { areaOf, chosenProposal, proposalCard, retireSuggestions } from "./reorg"
import { createTeamStore } from "./store"
import { teamText } from "./strings"
import { integrationOfOp, joinedAreas, resultCard, type CardAction, type CardInput, type CardNames } from "./summary"
import { areaRow } from "./view-model"

const TEAM = "tm_0123456789ab"
const OP = "op_01JB0000000000000000000000"
const OP2 = "op_01JB0000000000000000000001"
const MAIN = "ses_main_now"
const OWNER = "ses_owner_now"
const HOME = "D:/own-open-code"
const INVENTORY = "ar_inventory-ui"
const SAVE = "ar_save-v3"
const REVIEW = "pr_01JB0000000000000000000000"

const decodeTeam = Schema.decodeUnknownSync(OwnTeam.Team)
const decodeArea = Schema.decodeUnknownSync(OwnTeam.AreaView)
const decodeOp = Schema.decodeUnknownSync(OwnTeam.Op)
const decodeConfirm = Schema.decodeUnknownSync(OwnTeam.Confirm)

const ko: TeamText = (key, params) => teamText.text("ko", key, params)

function team(fields: Record<string, unknown> = {}) {
  return decodeTeam({
    id: TEAM,
    projectID: "prj_own",
    commonDir: "D:/#Projects/own-open-code/.git",
    target: "main",
    state: "on",
    rev: 7,
    home: { directory: HOME, linked: true, chosenBy: "session" },
    main: { sessionID: MAIN, previous: [] },
    worktreeRoot: "D:/own-open-code-team",
    heavy: { dirs: [], measuredAt: null, forcedBytes: 0 },
    shared: [],
    commands: { setup: null, code: [], assets: [] },
    env: { symlinkFix: "none", bunCache: "same-volume", lfs: "unused" },
    external: [],
    policy: OwnTeam.POLICY,
    patterns: [],
    ...fields,
  })
}

function area(id: string, fields: Record<string, unknown> = {}) {
  const slug = id.slice(3)
  return decodeArea({
    id,
    teamID: TEAM,
    name: slug,
    goal: "",
    origin: "created",
    state: "active",
    branch: slug,
    gitDir: `D:/#Projects/own-open-code/.git/worktrees/${slug}`,
    base: { sha: "a".repeat(40), at: 1 },
    directory: `D:/own-open-code-team/${slug}`,
    shape: "code",
    cone: { extra: {}, kept: {} },
    owner: { sessionID: null, previous: [], attached: true },
    preset: "builtin:codex",
    paused: false,
    status: { kind: "idle", at: 1, text: "" },
    handoff: null,
    ...fields,
  })
}

function op(fields: Record<string, unknown> = {}) {
  return decodeOp({
    id: OP,
    teamID: TEAM,
    kind: "enable",
    by: "user",
    state: "done",
    createdAt: 1,
    steps: [],
    ...fields,
  })
}

const step = (id: string, kind: string, args: Record<string, unknown> = {}, state = "done") => ({
  id,
  kind,
  args,
  mode: "auto",
  state,
})

const health = (features: readonly string[] = ["enable", "pause"]) => ({
  version: "2.0.18-own.6",
  buildId: "b1",
  guard: "ok",
  features,
})

type Answer = (payload: unknown) => unknown

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

function harness(input: { allowed?: (method: TeamMethod) => boolean; features?: readonly string[] } = {}) {
  const bus = createEventBus()
  const calls: Array<{ method: TeamMethod; input: unknown }> = []
  const answers: Partial<Record<TeamMethod, Answer>> = {
    health: () => health(input.features),
    "team.list": () => ({ teams: [{ id: TEAM, projectID: "prj_own", home: HOME, state: "on", areas: 2 }] }),
    "team.get": () => ({
      team: team(),
      areas: [area(INVENTORY, { owner: { sessionID: OWNER, previous: [], attached: true } }), area(SAVE)],
      waiting: {},
      op: null,
      pending: [],
    }),
  }
  const rpc: TeamRpc = {
    allowed: input.allowed ?? (() => true),
    scope: (method) => TEAM_SCOPE[method],
    async call(method, payload) {
      calls.push({ method, input: payload })
      const value = await answers[method]?.(payload)
      if (value instanceof Error) throw value
      // SAFETY: every test answers a method with that method's output shape.
      return value as never
    },
  }
  const root = createRoot((dispose) => ({ dispose, store: createTeamStore({ rpc, bus, reloadMs: 1 }) }))
  cleanups.push(() => {
    root.store.dispose()
    root.dispose()
    bus.dispose()
  })
  const state = { seq: 0 }
  function emit(name: string, data: object) {
    state.seq += 1
    // SAFETY: shaped like `V2EventRpc`, the variant the server sends for plugin RPC events.
    bus.publish({
      id: `evt_${state.seq}`,
      created: 1_000 + state.seq,
      type: `rpc.own.team.${name}`,
      location: { directory: "C:/control" },
      data: { eventId: `01JC${String(state.seq).padStart(22, "0")}`, origin: "global", ...data },
    } as unknown as OpenCodeEvent)
    bus.flush()
  }
  return { store: root.store, calls, answers, emit }
}

function toasts() {
  const items = new Map<number, ToastInput>()
  const state = { seq: 0 }
  return {
    show(input: ToastInput) {
      state.seq += 1
      items.set(state.seq, input)
      return state.seq
    },
    dismiss: (id: number) => void items.delete(id),
    visible: () => [...items.values()].map((item) => item.message),
    shown: () => [...items.values()],
    tones: () => [...items.values()].map((item) => item.tone ?? "neutral"),
  }
}

function deps(store: EnableDeps["team"], opened: string[] = []) {
  const toast = toasts()
  const prefilled: Array<readonly [string, string]> = []
  const order: string[] = []
  const value: EnableDeps = {
    team: store,
    text: ko,
    describe: (error) => errorText(ko, error),
    toast,
    open: (sessionID) => {
      opened.push(sessionID)
      order.push("open")
    },
    prefill: (sessionID, text) => {
      prefilled.push([sessionID, text])
      order.push("prefill")
    },
  }
  return { value, toast, opened, prefilled, order }
}

const progress = (stepID: string, state = "done") => ({ teamID: TEAM, opID: OP, stepID, state, text: stepID })
const done = (state = "done", opID = OP) => ({ teamID: TEAM, opID, state, summary: null, undoable: true, pending: 0 })

describe("팀 모드 켜기 (06 §9.2)", () => {
  test("enable{directory, sessionID}, progress toasts in order, then the team main", async () => {
    const h = harness()
    h.answers.enable = () => ({ opID: OP })
    h.answers["op.get"] = () => ({
      op: op({
        state: "running",
        steps: [
          step("observe", "enable.observe"),
          step("main", "enable.main"),
          step("judge", "enable.judge"),
          step("area:1", "branch-create", { areaID: INVENTORY }, "pending"),
          step("area:2", "worktree-create", { areaID: INVENTORY }, "pending"),
          step("area:3", "branch-create", { areaID: SAVE }, "pending"),
          step("finish", "enable.finish", { created: [INVENTORY, SAVE] }, "pending"),
        ],
      }),
    })
    const run = deps(h.store)
    const result = runEnable(run.value, { serverKey: "local", directory: HOME, sessionID: "ses_viewed" })
    expect(run.toast.visible()).toEqual(["프로젝트를 살펴보는 중…"])
    await tick()
    expect(h.calls[0]).toEqual({ method: "enable", input: { directory: HOME, sessionID: "ses_viewed" } })

    h.emit("op.progress", progress("observe"))
    expect(run.toast.visible()).toEqual(["팀 메인을 만드는 중…"])
    h.emit("op.progress", progress("main"))
    expect(run.toast.visible()).toEqual(["일을 나눌 영역을 정하는 중…"])
    h.emit("op.progress", progress("judge"))
    await tick()
    expect(run.toast.visible()).toEqual(["영역 2개를 준비하는 중…"])

    h.emit("op.done", done())
    expect(await result).toBe("done")
    expect(run.toast.visible()).toEqual([])
    expect(run.opened).toEqual([MAIN])
    expect(h.calls.map((call) => call.method)).toEqual(["enable", "op.get", "team.get"])
  })

  test("a goal goes to enable as the hint and into the team main's composer after the op; nothing is sent", async () => {
    const h = harness()
    h.answers.enable = () => ({ opID: OP })
    const run = deps(h.store)
    const draft = ko("own.team.enable.draft", { goal: "로비 만들기" })
    const result = runEnable(run.value, {
      serverKey: "local",
      directory: HOME,
      sessionID: "ses_viewed",
      hint: "로비 만들기",
      draft,
    })
    await tick()
    expect(h.calls[0]).toEqual({
      method: "enable",
      input: { directory: HOME, sessionID: "ses_viewed", hint: "로비 만들기" },
    })
    expect(run.prefilled).toEqual([])
    h.emit("op.done", done())
    expect(await result).toBe("done")
    expect(draft).toBe("로비 만들기\n\n이 일을 팀에서 어떻게 나눌지 먼저 같이 정하자. 나누는 안을 보여 줘.")
    expect(run.prefilled).toEqual([[MAIN, draft]])
    // The team main opens first, so its composer holds the draft's key when the text comes (split view).
    expect(run.order).toEqual(["open", "prefill"])
    expect(run.toast.visible()).toEqual([ko("own.team.enable.doneDraft")])
    expect(h.calls.map((call) => call.method)).not.toContain("session.prompt")
  })

  test("no goal: no hint and no draft", async () => {
    const h = harness()
    h.answers.enable = () => ({ opID: OP })
    const run = deps(h.store)
    const result = runEnable(run.value, { serverKey: "local", directory: HOME, hint: "" })
    await tick()
    expect(h.calls[0]!.input).toEqual({ directory: HOME })
    h.emit("op.done", done())
    await result
    expect(run.prefilled).toEqual([])
    expect(run.opened).toEqual([MAIN])
    expect(run.toast.visible()).toEqual([])
  })

  test("영역 폴더 (06 §4.12, 2026-10-27): the dialog's choice goes to enable as areaRoot", async () => {
    for (const areaRoot of ["inside", "beside"] as const) {
      const h = harness()
      h.answers.enable = () => ({ opID: OP })
      const run = deps(h.store)
      const result = runEnable(run.value, { serverKey: "local", directory: HOME, areaRoot })
      await tick()
      expect(h.calls[0]!.input).toEqual({ directory: HOME, areaRoot })
      h.emit("op.done", done())
      await result
    }
  })

  test("steps that ended before the answer still advance the toasts; an op already done opens at once", async () => {
    const h = harness()
    h.answers.enable = () => {
      h.emit("op.progress", progress("observe"))
      return { opID: OP }
    }
    const run = deps(h.store)
    const result = runEnable(run.value, { serverKey: "local", directory: HOME })
    await tick()
    expect(h.calls[0]!.input).toEqual({ directory: HOME })
    expect(run.toast.visible()).toEqual(["팀 메인을 만드는 중…"])
    h.emit("op.done", done("waiting"))
    expect(await result).toBe("waiting")
    expect(run.opened).toEqual([MAIN])

    // 다시 켜기 (3.8): the op ended before the answer came.
    h.answers.enable = () => {
      h.emit("op.done", done("done", OP2))
      return { opID: OP2 }
    }
    const again = deps(h.store)
    expect(await runEnable(again.value, { serverKey: "local", directory: HOME })).toBe("done")
    expect(again.opened).toEqual([MAIN])
    expect(await opDone(h.store, OP2)).toMatchObject({ state: "done" })
  })

  test("refusals say why: not a Git folder, another op running; nothing opens", async () => {
    const h = harness()
    h.answers.enable = () => new OwnRpcError("not_git", "not a repository", { directory: "D:/plain" })
    const run = deps(h.store)
    expect(await runEnable(run.value, { serverKey: "local", directory: "D:/plain" })).toBeUndefined()
    expect(run.toast.visible()).toEqual(["Git 저장소가 아닌 폴더에서는 팀 모드를 켤 수 없어요"])
    expect(run.toast.tones()).toEqual(["danger"])

    h.answers.enable = () => new OwnRpcError("busy", "busy", { teamID: TEAM, opID: OP, kind: "reorg" })
    const busy = deps(h.store)
    await runEnable(busy.value, { serverKey: "local", directory: HOME })
    expect(busy.toast.visible()).toEqual([
      "팀 모드를 켜지 못했어요: 이 팀에서 다른 작업이 진행 중이에요. 끝나면 다시 하세요",
    ])
    expect(busy.opened).toEqual([])
  })

  test("a failed op names its failed step; the team main still opens when the team is there", async () => {
    const h = harness()
    h.answers.enable = () => ({ opID: OP })
    h.answers["op.get"] = () => ({
      op: op({
        state: "failed",
        steps: [
          step("observe", "enable.observe"),
          { ...step("judge", "enable.judge"), state: "failed", note: "판단 호출 실패" },
        ],
      }),
    })
    const run = deps(h.store)
    const result = runEnable(run.value, { serverKey: "local", directory: HOME })
    await tick()
    h.emit("op.done", done("failed"))
    expect(await result).toBe("failed")
    expect(run.toast.visible()).toEqual(["팀 모드를 켜지 못했어요: 판단 호출 실패"])
    expect(run.opened).toEqual([MAIN])
  })

  test("a second click while the first call is on its way does nothing", async () => {
    const h = harness()
    const gate: { release?: () => void } = {}
    h.answers.enable = () => new Promise((resolve) => (gate.release = () => resolve({ opID: OP })))
    const first = deps(h.store)
    const second = deps(h.store)
    const one = runEnable(first.value, { serverKey: "local", directory: HOME })
    expect(await runEnable(second.value, { serverKey: "local", directory: HOME })).toBeUndefined()
    await tick()
    gate.release?.()
    await tick()
    h.emit("op.done", done())
    expect(await one).toBe("done")
    expect(h.calls.filter((call) => call.method === "enable")).toHaveLength(1)
  })

  test("planned areas are the distinct area ids of the steps", () => {
    expect(
      plannedAreas(
        op({
          steps: [
            step("a", "branch-create", { areaID: INVENTORY }),
            step("b", "worktree-create", { areaID: INVENTORY }),
            step("c", "branch-create", { areaID: SAVE }),
            step("d", "enable.finish", { created: [INVENTORY, SAVE] }),
          ],
        }),
      ),
    ).toBe(2)
    expect(plannedAreas(op())).toBe(0)
  })
})

describe("where the entry applies (06 §9.2)", () => {
  function runtimeOf(
    store: ReturnType<typeof harness>["store"],
    input: { vcs?: string; sessions?: Record<string, { parentID?: string; projectID?: string }> } = {},
  ) {
    const sessions = input.sessions ?? {}
    // SAFETY: canEnableTeam reads only the team store, session data and the project list.
    return {
      team: store,
      data: {
        session: { get: (id: string) => sessions[id] },
        project: { get: () => ({ canonical: HOME, vcs: input.vcs ?? "git" }) },
      },
      sessions: { state: { sessions: {}, projects: {} } },
    } as unknown as ServerRuntime
  }

  test("a root conversation of a Git project outside any team, with the feature and the admin scope", async () => {
    const h = harness()
    await h.store.resync()
    const runtime = runtimeOf(h.store, {
      sessions: { ses_x: { projectID: "prj_own" }, ses_child: { parentID: "ses_x" } },
    })
    const place = { directory: "D:/other-clone", projectID: "prj_own" }
    expect(canEnableTeam(runtime, { ...place, sessionID: "ses_x" })).toBe(true)
    expect(canEnableTeam(runtime, place)).toBe(true)
    // A subagent, a team session, a folder of a team that is on, a project without Git, no folder.
    expect(canEnableTeam(runtime, { ...place, sessionID: "ses_child" })).toBe(false)
    expect(canEnableTeam(runtime, { ...place, sessionID: MAIN })).toBe(false)
    expect(canEnableTeam(runtime, { directory: HOME, projectID: "prj_own" })).toBe(false)
    // The checkout the team leaves outside is the same repository (one team per common folder).
    h.answers["team.get"] = () => ({
      team: team({ rev: 8, external: [{ directory: "D:/#Projects/own-open-code", why: "hash-path" }] }),
      areas: [],
      waiting: {},
      op: null,
      pending: [],
    })
    await h.store.load(HOME)
    expect(canEnableTeam(runtime, { directory: "D:\\#Projects\\own-open-code", projectID: "prj_own" })).toBe(false)
    expect(canEnableTeam(runtime, place)).toBe(true)
    expect(canEnableTeam(runtimeOf(h.store, { vcs: "none" }), place)).toBe(false)
    expect(canEnableTeam(runtime, { directory: undefined, projectID: "prj_own" })).toBe(false)
  })

  test("not without the feature, not on a device without the admin scope, not before health answered", async () => {
    const before = harness()
    expect(canEnableTeam(runtimeOf(before.store), { directory: "D:/x", projectID: "prj_own" })).toBe(false)

    const old = harness({ features: ["pause"] })
    await old.store.resync()
    expect(canEnableTeam(runtimeOf(old.store), { directory: "D:/x", projectID: "prj_own" })).toBe(false)

    const phone = harness({ allowed: (method) => TEAM_SCOPE[method] !== "admin" && TEAM_SCOPE[method] !== "local" })
    await phone.store.resync()
    expect(canEnableTeam(runtimeOf(phone.store), { directory: "D:/x", projectID: "prj_own" })).toBe(false)
  })

  test("모든 영역 멈추기 needs an area without Main 멈춤, 다시 시작 one that 모든 영역 멈추기 paused", () => {
    const entry = (paused: ReadonlyArray<OwnTeam.Paused>, retired = false) => {
      const areas = paused.map((value, index) =>
        area(`ar_a${index}`, { paused: value, ...(retired ? { state: "retired" } : {}) }),
      )
      return { areas: Object.fromEntries(areas.map((item) => [item.id, item])), order: areas.map((item) => item.id) }
    }
    expect(pauseChoices(entry([false, "user"]))).toEqual({ stop: true, resume: false })
    expect(pauseChoices(entry(["all", "user"]))).toEqual({ stop: false, resume: true })
    expect(pauseChoices(entry([false, "all"]))).toEqual({ stop: true, resume: true })
    expect(pauseChoices(entry([false], true))).toEqual({ stop: false, resume: false })
    expect(pauseChoices(entry([]))).toEqual({ stop: false, resume: false })
  })
})

describe("peer items of a conversation's menus (06 §9.4, §9.5, 동료)", () => {
  const PEER = "ses_reviewer"
  const INVENTORY_DIR = "D:/own-open-code-team/inventory-ui"
  const ids = { teamID: TEAM as OwnTeam.TeamID, areaID: INVENTORY as OwnTeam.AreaID }
  const peers = [
    { key: "reviewer", sessionID: PEER, label: "리뷰어", role: "", attached: false, origin: "registered", at: 1 },
  ]
  /** inventory-ui with its owner, an earlier owner and a peer; save-v3's folder is gone. */
  function withPeers(h: ReturnType<typeof harness>) {
    h.answers["team.get"] = () => ({
      team: team(),
      areas: [
        area(INVENTORY, {
          owner: {
            sessionID: OWNER,
            previous: [
              { sessionID: "ses_owner_old", endedAt: 1, why: "fresh" },
              { sessionID: "ses_seat_left", endedAt: 2, why: "seat" },
            ],
            attached: true,
          },
          peers,
        }),
        area(SAVE, { state: "broken", broken: { why: "missing", at: 1 }, status: { kind: "broken", at: 1, text: "" } }),
      ],
      waiting: {},
      op: null,
      pending: [],
    })
    return h
  }
  function runtimeOf(store: ReturnType<typeof harness>["store"], sessions: Record<string, { parentID?: string }> = {}) {
    // SAFETY: peerItems reads only the team store and the session data's parents.
    return {
      team: store,
      data: { session: { get: (id: string) => sessions[id] } },
      sessions: { state: { sessions: {} } },
    } as unknown as ServerRuntime
  }

  test("동료로 등록… in an active area's folder for a conversation without a role; a peer's own items", async () => {
    const h = withPeers(harness({ features: ["peers"] }))
    await h.store.resync()
    const runtime = runtimeOf(h.store, { ses_child: { parentID: "ses_x" } })
    const at = (sessionID: string, directory = INVENTORY_DIR) => peerItems(runtime, { sessionID, directory })
    expect(at("ses_x")).toEqual({ ...ids, sessionID: "ses_x", items: ["register"] })
    // Subfolders count; Windows paths compare without case and separators.
    expect(at("ses_x", "d:\\own-open-code-team\\INVENTORY-UI\\packages\\web")?.areaID).toBe(INVENTORY as never)
    expect(at(PEER)).toEqual({ ...ids, sessionID: PEER, key: "reviewer", items: ["edit", "remove"] })
    // Not the owner, an earlier owner, the team main or a subagent; not the main folder, a stopped area or elsewhere.
    for (const sessionID of [OWNER, "ses_owner_old", MAIN, "ses_child"])
      expect(at(sessionID), sessionID).toBeUndefined()
    expect(at("ses_x", HOME)).toBeUndefined()
    expect(at("ses_x", "D:/own-open-code-team/save-v3")).toBeUndefined()
    expect(at("ses_x", "D:/elsewhere")).toBeUndefined()
    expect(peerItems(runtime, { sessionID: "ses_x", directory: undefined })).toBeUndefined()
  })

  test("only where the build has `peers` and the connection the admin scope; each peer item with its own method", async () => {
    const old = withPeers(harness({ features: ["pause"] }))
    await old.store.resync()
    expect(peerItems(runtimeOf(old.store), { sessionID: "ses_x", directory: INVENTORY_DIR })).toBeUndefined()
    expect(peerItems(runtimeOf(old.store), { sessionID: PEER, directory: INVENTORY_DIR })).toBeUndefined()
    const device = (method: TeamMethod) => TEAM_SCOPE[method] === "read" || TEAM_SCOPE[method] === "prompt"
    const phone = withPeers(harness({ features: ["peers"], allowed: device }))
    await phone.store.resync()
    expect(peerItems(runtimeOf(phone.store), { sessionID: "ses_x", directory: INVENTORY_DIR })).toBeUndefined()
    expect(peerItems(runtimeOf(phone.store), { sessionID: PEER, directory: INVENTORY_DIR })).toBeUndefined()
    expect(peerActions({ has: () => true, allowed: (method) => method !== "area.peer.remove" })).toEqual(["edit"])
    expect(peerActions({ has: () => true, allowed: (method) => method !== "area.peer.edit" })).toEqual(["remove"])
    expect(peerActions({ has: (feature) => feature !== "peers", allowed: () => true })).toEqual([])
    for (const method of ["area.peer.add", "area.peer.edit", "area.peer.remove"] as const)
      expect(TEAM_SCOPE[method], method).toBe("admin")
  })

  test("an item opens the area menu at its panel: the conversation to register, or the peer's key", () => {
    const opened: AreaTarget[] = []
    const release = teamIntents.areaMenu.register((target) => void opened.push(target))
    // A request another test left waiting is not this test's.
    opened.splice(0)
    openPeerItem("local", { ...ids, sessionID: "ses_x", items: ["register"] }, "register")
    const peer = { ...ids, sessionID: PEER, key: "reviewer", items: ["edit", "remove"] as const }
    openPeerItem("local", peer, "edit")
    openPeerItem("local", peer, "remove")
    release()
    expect(opened).toEqual([
      { serverKey: "local", ...ids, anchor: null, panel: "registerPeer", sessionID: "ses_x" },
      { serverKey: "local", ...ids, anchor: null, panel: "editPeer", peer: "reviewer" },
      { serverKey: "local", ...ids, anchor: null, panel: "removePeer", peer: "reviewer" },
    ])
    expect(ko("own.team.peer.register")).toBe("동료로 등록…")
    expect(ko("own.team.peer.edit")).toBe("역할 바꾸기…")
    expect(ko("own.team.peer.remove")).toBe("동료에서 빼기")
  })

  test("이 대화를 담당으로: a conversation without a role, a peer and an earlier owner of the area's folder", async () => {
    const h = withPeers(harness({ features: ["peers", "seat"] }))
    await h.store.resync()
    const runtime = runtimeOf(h.store, { ses_child: { parentID: "ses_x" } })
    const at = (sessionID: string, directory = INVENTORY_DIR) => peerItems(runtime, { sessionID, directory })
    expect(at("ses_x")).toEqual({ ...ids, sessionID: "ses_x", items: ["register", "seat"] })
    expect(at(PEER)).toEqual({ ...ids, sessionID: PEER, key: "reviewer", items: ["edit", "remove", "seat"] })
    // An earlier owner may take the seat again. One that 새 대화로 이어가기 ended is never offered as a peer; one the
    // seat was moved off is (a peer made the owner and moved back may be a peer again).
    expect(at("ses_owner_old")).toEqual({ ...ids, sessionID: "ses_owner_old", items: ["seat"] })
    expect(at("ses_seat_left")).toEqual({ ...ids, sessionID: "ses_seat_left", items: ["register", "seat"] })
    expect(at("ses_seat_left", "D:/elsewhere")).toBeUndefined()
    // Not the owner, the team main or a subagent; not from the main folder, a stopped area or elsewhere.
    for (const sessionID of [OWNER, MAIN, "ses_child"]) expect(at(sessionID), sessionID).toBeUndefined()
    expect(at("ses_x", HOME)).toBeUndefined()
    expect(at("ses_x", "D:/own-open-code-team/save-v3")).toBeUndefined()
    expect(at("ses_owner_old", "D:/elsewhere")).toBeUndefined()
    // A peer whose conversation sits in another folder keeps its own items only.
    expect(at(PEER, "D:/elsewhere")?.items).toEqual(["edit", "remove"])
    expect(ko("own.team.seat.make")).toBe("이 대화를 담당으로")
  })

  test("이 대화를 담당으로 needs `seat` in the build and the admin scope, each on its own", async () => {
    const seatOnly = withPeers(harness({ features: ["seat"] }))
    await seatOnly.store.resync()
    const at = (h: ReturnType<typeof harness>, sessionID: string) =>
      peerItems(runtimeOf(h.store), { sessionID, directory: INVENTORY_DIR })?.items
    expect(at(seatOnly, "ses_x")).toEqual(["seat"])
    expect(at(seatOnly, PEER)).toEqual(["seat"])
    const device = (method: TeamMethod) => TEAM_SCOPE[method] === "read" || TEAM_SCOPE[method] === "prompt"
    const phone = withPeers(harness({ features: ["peers", "seat"], allowed: device }))
    await phone.store.resync()
    for (const sessionID of ["ses_x", PEER, "ses_owner_old"]) expect(at(phone, sessionID), sessionID).toBeUndefined()
    const noSeat = withPeers(harness({ features: ["peers", "seat"], allowed: (method) => method !== "area.seat" }))
    await noSeat.store.resync()
    expect(at(noSeat, "ses_x")).toEqual(["register"])
    expect(at(noSeat, "ses_owner_old")).toBeUndefined()
    expect(TEAM_SCOPE["area.seat"]).toBe("admin")
  })

  test("the item opens the area menu at its confirm; it is dimmed while another task of the team runs", async () => {
    const opened: AreaTarget[] = []
    const release = teamIntents.areaMenu.register((target) => void opened.push(target))
    opened.splice(0)
    openPeerItem("local", { ...ids, sessionID: "ses_x", items: ["seat"] }, "seat")
    openPeerItem("local", { ...ids, sessionID: PEER, key: "reviewer", items: ["edit", "remove", "seat"] }, "seat")
    release()
    expect(opened).toEqual([
      { serverKey: "local", ...ids, anchor: null, panel: "seat", sessionID: "ses_x" },
      { serverKey: "local", ...ids, anchor: null, panel: "seat", sessionID: PEER },
    ])
    const idle = withPeers(harness({ features: ["seat"] }))
    await idle.store.resync()
    expect(seatBlock(idle.store, ids.teamID)).toBeUndefined()
    const busy = harness({ features: ["seat"] })
    busy.answers["team.get"] = () => ({
      team: team(),
      areas: [area(INVENTORY, { owner: { sessionID: OWNER, previous: [], attached: true } })],
      waiting: {},
      op: op({ kind: "integrate", state: "running" }),
      pending: [],
    })
    await busy.store.resync()
    expect(seatBlock(busy.store, ids.teamID)).toBe("own.team.seat.busy")
    expect(ko("own.team.seat.busy")).toBe("팀의 다른 작업이 끝나면 바꿀 수 있어요")
    expect(seatBlock(busy.store, "tm_aaaaaaaaaaaa" as OwnTeam.TeamID)).toBeUndefined()
    // A task that started after the last `team.get`: its progress is enough, until it ends.
    idle.emit("op.progress", progress("seat.wait", "running"))
    expect(seatBlock(idle.store, ids.teamID)).toBe("own.team.seat.busy")
    expect(seatBlock(idle.store, "tm_aaaaaaaaaaaa" as OwnTeam.TeamID)).toBeUndefined()
    idle.emit("op.done", done())
    expect(seatBlock(idle.store, ids.teamID)).toBeUndefined()
  })
})

describe("담당 대화 바꾸기: 바꾸기 (06 §6.8)", () => {
  const NEXT = "ses_next"
  const ids = { teamID: TEAM as OwnTeam.TeamID, areaID: INVENTORY as OwnTeam.AreaID }
  const names: Record<string, string> = { [OWNER]: "재고 화면", [NEXT]: "새 설계" }
  /** A team whose inventory-ui seat `move` hands to another conversation, as the op does before it is done. */
  function seated(
    fields: Record<string, unknown> = {},
    first: string | null = OWNER,
    allowed?: (method: TeamMethod) => boolean,
  ) {
    const h = harness({ features: ["seat"], ...(allowed ? { allowed } : {}) })
    const state = { owner: first, previous: [] as Array<Record<string, unknown>> }
    h.answers["team.get"] = () => ({
      team: team(),
      areas: [
        area(INVENTORY, { owner: { sessionID: state.owner, previous: state.previous, attached: true }, ...fields }),
        area(SAVE),
      ],
      waiting: {},
      op: null,
      pending: [],
    })
    const move = (sessionID: string) => {
      state.previous = state.owner
        ? [...state.previous, { sessionID: state.owner, endedAt: 2, why: "seat" }]
        : state.previous
      state.owner = sessionID
    }
    const toast = toasts()
    const value: SeatDeps = {
      team: h.store,
      text: ko,
      describe: (error) => seatErrorText(ko, error),
      toast,
      name: (sessionID) => names[sessionID] ?? sessionID,
    }
    return { ...h, move, toast, value }
  }

  test("area.seat, the waiting toast, then who holds the seat with the way back", async () => {
    const h = seated()
    await h.store.resync()
    h.answers["area.seat"] = () => ({ opID: OP })
    const result = runSeat(h.value, { ...ids, sessionID: NEXT })
    await tick()
    expect(h.calls.filter((call) => call.method === "area.seat")).toEqual([
      { method: "area.seat", input: { ...ids, sessionID: NEXT } },
    ])
    expect(h.toast.visible()).toEqual(["지금 일이 끝나면 바꿔요"])
    h.move(NEXT)
    h.emit("op.done", done())
    expect(await result).toBe("done")
    expect(h.toast.visible()).toEqual(["'새 설계' 대화가 이제 'inventory-ui' 담당이에요"])
    expect(h.toast.tones()).toEqual(["neutral"])
    const back = h.toast.shown()[0]!.action!
    expect(back.label).toBe("다시 재고 화면으로")

    // The way back is the same call with the conversation that held the seat.
    h.answers["area.seat"] = () => ({ opID: OP2 })
    back.run()
    await tick()
    expect(h.calls.filter((call) => call.method === "area.seat")[1]!.input).toEqual({ ...ids, sessionID: OWNER })
    h.move(OWNER)
    h.emit("op.done", done("done", OP2))
    await tick()
    expect(h.toast.visible().at(-1)).toBe("'재고 화면' 대화가 이제 'inventory-ui' 담당이에요")
    expect(h.toast.shown().at(-1)!.action!.label).toBe("다시 새 설계로")
  })

  test("a long title is cut in the way back: the button never crowds the sentence out", async () => {
    const h = seated()
    names[OWNER] = "재고 화면을 새로 큰 일 하는 대화"
    await h.store.resync()
    h.answers["area.seat"] = () => ({ opID: OP })
    const result = runSeat(h.value, { ...ids, sessionID: NEXT })
    await tick()
    h.move(NEXT)
    h.emit("op.done", done())
    await result
    names[OWNER] = "재고 화면"
    expect(BACK_NAME).toBe(12)
    // Twelve characters, the space the cut left at the end dropped, and the particle of the last kept sound.
    expect(h.toast.shown()[0]!.action!.label).toBe("다시 재고 화면을 새로 큰…으로")
    // The sentence keeps the whole title of the conversation that took the seat: it wraps.
    expect(h.toast.visible()).toEqual(["'새 설계' 대화가 이제 'inventory-ui' 담당이에요"])
  })

  test("an area under Main 멈춤: a second toast says the main's requests do not reach the new owner, and turns it off in one click", async () => {
    const h = seated({ paused: "user" })
    await h.store.resync()
    h.answers["area.seat"] = () => ({ opID: OP })
    const result = runSeat(h.value, { ...ids, sessionID: NEXT })
    await tick()
    h.move(NEXT)
    h.emit("op.done", done())
    await result
    expect(h.toast.visible()).toEqual([
      "'새 설계' 대화가 이제 'inventory-ui' 담당이에요",
      "'inventory-ui' 영역은 메인 멈춤이 켜져 있어요. 끄기 전에는 메인의 요청이 새 담당에게 가지 않아요",
    ])
    // The way back stays on the first toast; the second one's only button turns Main 멈춤 off.
    expect(h.toast.shown().map((item) => item.action?.label)).toEqual(["다시 재고 화면으로", "메인 멈춤 끄기"])
    h.answers["area.pause"] = () => ({})
    h.toast.shown()[1]!.action!.run()
    await tick()
    expect(h.calls.filter((call) => call.method === "area.pause")).toEqual([
      { method: "area.pause", input: { ...ids, on: false } },
    ])
    expect(h.toast.tones()).toEqual(["neutral", "neutral"])

    // A refused `area.pause` says why.
    h.answers["area.pause"] = () => new OwnRpcError("busy", "busy", { teamID: TEAM, opID: OP, kind: "integrate" })
    h.toast.shown()[1]!.action!.run()
    await tick()
    expect(h.toast.visible().at(-1)).toBe("이 팀에서 다른 작업이 진행 중이에요. 끝나면 다시 하세요")
    expect(h.toast.tones().at(-1)).toBe("danger")

    // A connection that may not turn Main 멈춤 off reads the same words without the button.
    const viewer = seated({ paused: "all" }, OWNER, (method) => method !== "area.pause")
    await viewer.store.resync()
    viewer.answers["area.seat"] = () => ({ opID: OP })
    const viewed = runSeat(viewer.value, { ...ids, sessionID: NEXT })
    await tick()
    viewer.move(NEXT)
    viewer.emit("op.done", done())
    await viewed
    expect(viewer.toast.visible()).toEqual([
      "'새 설계' 대화가 이제 'inventory-ui' 담당이에요",
      "'inventory-ui' 영역은 메인 멈춤이 켜져 있어요. 끄기 전에는 메인의 요청이 새 담당에게 가지 않아요",
    ])
    expect(viewer.toast.shown().map((item) => item.action?.label)).toEqual(["다시 재고 화면으로", undefined])
  })

  test("an area without an owner gets one: nothing to go back to", async () => {
    const h = seated({}, null)
    await h.store.resync()
    h.answers["area.seat"] = () => ({ opID: OP })
    const result = runSeat(h.value, { ...ids, sessionID: NEXT })
    await tick()
    h.move(NEXT)
    h.emit("op.done", done())
    await result
    expect(h.toast.visible()).toEqual(["'새 설계' 대화가 이제 'inventory-ui' 담당이에요"])
    expect(h.toast.shown()[0]!.action).toBeUndefined()
  })

  test("a refused call says why and starts nothing", async () => {
    const refusals = [
      [new OwnRpcError("seat_invalid", "no", { why: "child" }), "하위 대화는 담당이 될 수 없어요"],
      [new OwnRpcError("seat_invalid", "no", { why: "elsewhere" }), "이 영역의 폴더에 있는 대화만 담당이 될 수 있어요"],
      [
        new OwnRpcError("seat_invalid", "no", { why: "account" }),
        "이 대화의 계정을 확인할 수 없어요. 모델을 고른 뒤 다시 해 주세요",
      ],
      [
        new OwnRpcError("seat_invalid", "no", { why: "unknown" }),
        "이 대화의 계정을 지금 확인할 수 없어요. 잠시 뒤 다시 해 주세요",
      ],
      [
        new OwnRpcError("same_company_subscription", "no", {}),
        "이 대화는 팀과 같은 회사의 다른 구독 계정을 써요. 담당으로 두려면 그 대화의 계정을 바꾸세요",
      ],
      [
        new OwnRpcError("busy", "busy", { teamID: TEAM, opID: OP, kind: "integrate" }),
        "이 팀에서 다른 작업이 진행 중이에요. 끝나면 다시 하세요",
      ],
    ] as const
    for (const [error, words] of refusals) {
      const h = seated()
      await h.store.resync()
      h.answers["area.seat"] = () => error
      expect(await runSeat(h.value, { ...ids, sessionID: NEXT })).toBeUndefined()
      expect(h.toast.visible()).toEqual([words])
      expect(h.toast.tones()).toEqual(["danger"])
    }
  })

  test("a failed op names its failed step; a cancelled wait changed nothing and says nothing", async () => {
    const failed = seated()
    await failed.store.resync()
    failed.answers["area.seat"] = () => ({ opID: OP })
    failed.answers["op.get"] = () => ({
      op: op({
        kind: "seat",
        state: "failed",
        steps: [{ ...step("seat", "seat.move"), state: "failed", note: "대화를 찾지 못했어요" }],
      }),
    })
    const result = runSeat(failed.value, { ...ids, sessionID: NEXT })
    await tick()
    failed.emit("op.done", done("failed"))
    expect(await result).toBe("failed")
    expect(failed.toast.visible()).toEqual(["담당을 바꾸지 못했어요: 대화를 찾지 못했어요"])
    expect(failed.toast.tones()).toEqual(["danger"])

    const plain = seated()
    await plain.store.resync()
    plain.answers["area.seat"] = () => ({ opID: OP })
    plain.answers["op.get"] = () => new OwnRpcError("not_found", "gone", {})
    const gone = runSeat(plain.value, { ...ids, sessionID: NEXT })
    await tick()
    plain.emit("op.done", done("failed"))
    await gone
    expect(plain.toast.visible()).toEqual(["담당을 바꾸지 못했어요"])

    const cancelled = seated()
    await cancelled.store.resync()
    cancelled.answers["area.seat"] = () => ({ opID: OP })
    const waited = runSeat(cancelled.value, { ...ids, sessionID: NEXT })
    await tick()
    expect(cancelled.toast.visible()).toEqual(["지금 일이 끝나면 바꿔요"])
    cancelled.emit("op.done", done("cancelled"))
    expect(await waited).toBe("cancelled")
    expect(cancelled.toast.visible()).toEqual([])
  })
})

describe("result card (06 §9.3, 07 §7.4)", () => {
  const names: CardNames = {
    main: { model: "GPT-6 Astra", effort: "high", account: "개인 Pro" },
    star: { id: "builtin:codex", name: "평소대로" },
    starOf: (ref) => (ref.providerID === "anthropic" ? "builtin:claude-sub" : "builtin:codex"),
    preset: (id) => (id === REVIEW ? "다른 회사 리뷰" : "평소대로"),
    account: (id) => (id === "acc_02" ? "ChatGPT 02" : id),
    accountOf: (ref) => (ref.providerID === "anthropic" ? "Claude 구독" : "개인 Pro"),
    bytes: (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`,
  }
  const entry = (fields: Record<string, unknown> = {}, areas = [area(INVENTORY), area(SAVE)]) => ({
    team: team(fields),
    areas: Object.fromEntries(areas.map((item) => [item.id, item])),
    order: areas.map((item) => item.id),
  })
  const every = () => true
  const card = (input: Partial<CardInput> & Pick<CardInput, "op">) =>
    resultCard(ko, { team: entry(), pending: 0, names, can: every, ...input })
  const texts = (lines: ReturnType<typeof card>["lines"]) => lines.map((line) => line.text)
  const actions = (lines: ReturnType<typeof card>["lines"]) =>
    lines.flatMap((line) => (line.action ? [line.action.run.kind] : []))

  test("a new project: areas, the main line with the group's ★, main folder, untouched folders, auto-allow", () => {
    const shown = card({
      op: op({
        summary: {
          lines: [
            { kind: "area", areaID: INVENTORY, change: "created" },
            { kind: "area", areaID: SAVE, change: "created" },
            { kind: "prepare", bytes: 2.5 * 1024 ** 3 },
          ],
        },
      }),
      team: entry({
        external: [
          { directory: "D:/#Projects/own-open-code", why: "primary" },
          { directory: "D:/x/.claude/worktrees/a", why: "other-tool" },
          { directory: "D:/x/.claude/worktrees/b", why: "other-tool" },
          { directory: "D:/own-open-code-old", why: "left" },
        ],
      }),
    })
    expect(shown.title).toBe("팀 모드를 켰어요")
    expect(shown.state).toBeUndefined()
    expect(texts(shown.lines)).toEqual([
      "영역 2개: inventory-ui · save-v3.",
      "모든 영역이 팀 메인(GPT-6 Astra · high)과 '평소대로'를 써요",
      "메인은 D:/own-open-code 폴더에서 일해요",
      "다른 도구의 작업 폴더 2개와 D:/#Projects/own-open-code 폴더는 건드리지 않았어요.",
      "담당은 검사·설치 명령을 묻지 않고 실행해요",
      "새 영역 준비에 약 2.5 GB 사용",
    ])
    // The main folder can move to a checkout without `#` (3.2); auto-allow goes to settings 팀.
    const home = shown.lines[2]!.action!.run
    expect(home).toEqual({ kind: "home", directories: ["D:/own-open-code-old"] } satisfies CardAction)
    expect(actions(shown.lines)).toEqual(["home", "settings"])
  })

  test("no areas: the card says to talk to the main; buttons need their feature and scope", () => {
    const shown = card({
      op: op({ summary: { lines: [{ kind: "notes", text: "할 일이 작으면 대화 하나로 충분해요." }] } }),
      team: entry({}, []),
      can: () => false,
    })
    expect(texts(shown.lines).slice(0, 2)).toEqual([
      "메인에게 할 일을 말하면 영역을 나눠 맡겨요.",
      "모든 영역이 팀 메인(GPT-6 Astra · high)과 '평소대로'를 써요",
    ])
    expect(shown.lines.at(-1)).toEqual({ text: "할 일이 작으면 대화 하나로 충분해요.", tone: "muted" })
    expect(actions(shown.lines)).toEqual([])
    // 다시 켜기 (3.8) makes no area: the card names the ones the team has.
    expect(texts(card({ op: op() }).lines)[0]).toBe("영역 2개: inventory-ui · save-v3.")
  })

  test("adopted areas: the main line names the account; keeps, R4 and outside folders in the 9.3 order", () => {
    const adopted = area("ar_cl-perf", {
      name: "cl-perf",
      origin: "adopted",
      preset: REVIEW,
      main: { model: { id: "claude-opus", providerID: "anthropic" }, chosenBy: "adopted" },
    })
    const shown = card({
      op: op({
        summary: {
          lines: [
            { kind: "area", areaID: "ar_cl-perf", change: "adopted" },
            { kind: "area", areaID: INVENTORY, change: "created" },
            { kind: "old-git", version: "2.40.1" },
            { kind: "r4", areaID: "ar_cl-perf", accountID: "acc_02" },
            { kind: "unadopted", directory: "D:/work/cl-x", changes: 4, ahead: 0 },
            { kind: "skipped", item: "areas/2", why: "unsupported" },
          ],
        },
      }),
      team: entry({}, [adopted, area(INVENTORY)]),
      pending: 1,
      names: { ...names, worst: "영역 2개 × (담당 1 + 하위 에이전트 동시 8) = 최대 18개 동시 실행" },
    })
    expect(texts(shown.lines)).toEqual([
      "영역 2개: cl-perf · inventory-ui. 지금 있는 작업 폴더를 그대로 써요.",
      "기존 대화는 그대로 두고, 메인이 일을 맡길 때 담당 역할을 붙여요.",
      "메인과 새 영역: GPT-6 Astra · high @ 개인 Pro, 프리셋 '평소대로'. 받아들인 영역은 각 대화 그대로",
      "메인은 D:/own-open-code 폴더에서 일해요",
      "담당은 검사·설치 명령을 묻지 않고 실행해요",
      "팀에 넣지 않은 작업 폴더: cl-x(저장 지점에 넣지 않은 변경 4개)",
      "cl-perf 대화는 ChatGPT 02를 써요. 메인이 일을 맡길 때 개인 Pro로 새 대화에서 이어 가요",
      "cl-perf: Claude 구독 그대로",
      "cl-perf: 프리셋 '다른 회사 리뷰' 그대로",
      "영역 2개 × (담당 1 + 하위 에이전트 동시 8) = 최대 18개 동시 실행",
      "Git 2.40.1은 오래되어 큰 파일까지 모두 받는 방식으로 켰어요(Git 2.42 이상이면 가벼운 폴더를 써요)",
      "확인이 필요한 것 1개",
      "이 버전에서는 아직 할 수 없는 일이라 건너뛰었어요",
    ])
    expect(actions(shown.lines)).toEqual(["settings", "adopt", "unadopt"])
    // 팀에 넣기 and 이 영역 빼기 come with adoption (T2): a build without it shows the lines only.
    const t1 = card({
      op: op({ summary: { lines: [{ kind: "unadopted", directory: "D:/w/cl-x", changes: 0, ahead: 2 }] } }),
      can: (action) => action === "settings",
    })
    expect(t1.lines.find((line) => line.text.startsWith("팀에 넣지 않은"))).toEqual({
      text: "팀에 넣지 않은 작업 폴더: cl-x(프로젝트 본 코드에 없는 저장 지점 2개)",
      tone: "warn",
      action: undefined,
    })
  })

  // SL-8: several Claude accounts share `anthropic`; the provider alone names only the first (AC-01).
  test("Claude accounts: the moved team and a kept account name the sessions' accounts, not the provider's first", () => {
    const OWNER = "ses_owner_cl02"
    const claude: CardNames = {
      ...names,
      main: { model: "Claude Opus 5.5", account: "AC-03" },
      account: (id) => ({ acc_cl2: "AC-02", acc_cl3: "AC-03" })[id] ?? id,
      // What the binding of each session names; the provider alone is the first Claude account.
      accountOf: (ref, sessionID) =>
        ref.providerID !== "anthropic" ? "개인 Pro" : sessionID === OWNER ? "AC-02" : sessionID ? "AC-03" : "AC-01",
    }
    const adopted = area("ar_cl-perf", {
      name: "cl-perf",
      origin: "adopted",
      main: { model: { id: "claude-opus", providerID: "anthropic" }, chosenBy: "adopted" },
      owner: { sessionID: OWNER, previous: [], attached: true },
      preset: "builtin:claude-sub",
    })
    // The adopted area's conversation runs on AC-02, the team main on AC-03: it keeps its own account.
    const adopt = card({
      op: op({ kind: "adopt", summary: { lines: [{ kind: "area", areaID: "ar_cl-perf", change: "adopted" }] } }),
      team: entry({}, [adopted]),
      names: claude,
    })
    expect(texts(adopt.lines)).toContain("cl-perf: AC-02 그대로")
    // On the team's account: nothing to say.
    const same = card({
      op: op({ kind: "adopt", summary: { lines: [{ kind: "area", areaID: "ar_cl-perf", change: "adopted" }] } }),
      team: entry({}, [
        area("ar_cl-perf", { ...adopted, owner: { sessionID: "ses_other", previous: [], attached: true } }),
      ]),
      names: claude,
    })
    expect(texts(same.lines).filter((line) => line.startsWith("cl-perf: CL"))).toEqual([])
    const moved = card({
      op: op({
        kind: "team-account",
        summary: {
          lines: [
            { kind: "account", model: { providerID: "anthropic", id: "claude-opus" }, areas: 1, accountID: "acc_cl3" },
          ],
        },
      }),
      names: claude,
    })
    expect(texts(moved.lines)).toContain("팀이 AC-03으로 옮겼어요 · 영역 1개 새 대화")
    // A summary written before the account id: the model's provider, as before.
    const old = card({
      op: op({
        kind: "team-account",
        summary: { lines: [{ kind: "account", model: { providerID: "anthropic", id: "claude-opus" }, areas: 0 }] },
      }),
      names: claude,
    })
    expect(texts(old.lines)).toContain("팀이 AC-01로 옮겼어요 · 영역 0개 새 대화")
  })

  test("the same card for other ops: reorganizing, fetching folders, turning off, a failed op", () => {
    const reorg = card({
      op: op({
        kind: "reorg",
        summary: {
          lines: [
            { kind: "area", areaID: SAVE, change: "renamed" },
            { kind: "skipped", item: "ops/1", areaID: INVENTORY, why: "paused" },
          ],
        },
      }),
    })
    expect(reorg.title).toBe("팀 구성을 바꿨어요")
    expect(texts(reorg.lines)).toEqual([
      "영역 이름을 'save-v3'으로 바꿨어요",
      "'inventory-ui'는 메인 멈춤이라 이번 정리에서 건너뛰었어요",
    ])

    const paths = card({
      op: op({
        kind: "paths",
        summary: {
          lines: [
            { kind: "paths", areaID: INVENTORY, change: "added", dirs: ["Assets/UI"], bytes: 1024 ** 3 },
            { kind: "paths", areaID: INVENTORY, change: "kept", dirs: ["Assets/Old"], bytes: 0 },
          ],
        },
      }),
    })
    expect(paths.title).toBe("큰 파일 폴더를 바꿨어요")
    expect(texts(paths.lines)).toEqual([
      "inventory-ui: 큰 파일 폴더 1개(1.0 GB)를 가져왔어요",
      "Assets/Old에 아직 정리되지 않은 파일이 있어 그대로 뒀어요",
    ])

    const off = card({
      op: op({
        kind: "disable",
        summary: {
          lines: [
            { kind: "cancelled", areaID: INVENTORY, dispatchID: "dp_01JB0000000000000000000000" },
            { kind: "cancelled", areaID: SAVE, dispatchID: "dp_01JB0000000000000000000001" },
            { kind: "queued", areaID: INVENTORY, sessionID: OWNER, count: 2 },
            { kind: "lock-kept", directory: HOME },
            { kind: "ref", ref: "refs/own/keep/abc", sha: "b".repeat(40) },
          ],
        },
      }),
    })
    expect(texts(off.lines)).toEqual([
      "보내지 않은 메인 요청 2개",
      "",
      "D:/own-open-code 폴더는 안에 다른 작업 폴더가 있어 잠금을 그대로 뒀어요",
    ])
    expect(off.lines[1]!.action).toEqual({
      label: "담당 대기열의 메인 요청 2개 지우기",
      run: { kind: "clear", sessionIDs: [OWNER] },
    })
    expect(off.details).toContain("작업을 지키려고 남긴 표시: refs/own/keep/abc")

    const failed = card({
      op: op({
        state: "failed",
        steps: [
          step("observe", "enable.observe"),
          { ...step("judge", "enable.judge"), state: "failed", note: "판단 실패" },
        ],
      }),
    })
    expect(failed.state).toBe("끝내지 못했어요: 판단 실패")
    expect(failed.details).toEqual(["프로젝트 살펴보기 · 끝남", "영역 제안 받기 · 실패 · 판단 실패"])
    expect(card({ op: op({ state: "waiting" }) }).state).toBe("확인을 기다려요")
  })

  test("the heavy folders areas leave out come right after the main line (0.4)", () => {
    const shown = card({
      op: op({
        summary: {
          lines: [
            { kind: "area", areaID: INVENTORY, change: "created" },
            { kind: "heavy", dirs: ["Assets/Textures", "Assets/Audio", "Models"], bytes: Math.round(14.7 * 1024 ** 3) },
          ],
        },
      }),
    })
    expect(texts(shown.lines).slice(0, 4)).toEqual([
      "영역 1개: inventory-ui.",
      "모든 영역이 팀 메인(GPT-6 Astra · high)과 '평소대로'를 써요",
      "큰 파일 폴더 3개(14.7 GB)는 영역 폴더에 받지 않아요.",
      "메인은 D:/own-open-code 폴더에서 일해요",
    ])
    // No line when the judge picked none.
    const none = card({ op: op({ summary: { lines: [{ kind: "heavy", dirs: [], bytes: 0 }] } }) })
    expect(texts(none.lines).some((line) => line.startsWith("큰 파일 폴더"))).toBe(false)
  })

  test("팀에 넣기 (8.2): the areas this op took in; a kept preset is one other than its own group's ★", () => {
    const adopted = (slug: string, fields: Record<string, unknown>) =>
      area(`ar_${slug}`, { name: slug, origin: "adopted", ...fields })
    const claude = { model: { id: "claude-opus", providerID: "anthropic" }, chosenBy: "adopted" }
    const areas = [
      // On a Claude subscription with that group's ★: only the account line.
      adopted("cl-x", { main: claude, preset: "builtin:claude-sub" }),
      // Following the team (an R4 area): its preset is measured against the team main's ★.
      adopted("cl-y", { preset: REVIEW }),
      // Taken in earlier: not this card's.
      adopted("cl-old", { main: claude, preset: REVIEW }),
    ]
    const shown = card({
      op: op({
        kind: "adopt",
        summary: {
          lines: [
            { kind: "area", areaID: "ar_cl-x", change: "adopted" },
            { kind: "area", areaID: "ar_cl-y", change: "adopted" },
          ],
        },
      }),
      team: entry({}, areas),
    })
    expect(shown.title).toBe("팀에 넣었어요")
    expect(texts(shown.lines)).toEqual([
      "'cl-x' 영역은 지금 있는 작업 폴더를 그대로 써요",
      "'cl-y' 영역은 지금 있는 작업 폴더를 그대로 써요",
      "cl-x: Claude 구독 그대로",
      "cl-y: 프리셋 '다른 회사 리뷰' 그대로",
    ])
    // The enabling card names every adopted area, the earlier one included.
    const enabled = texts(card({ op: op(), team: entry({}, areas) }).lines)
    expect(enabled).toContain("cl-old: 프리셋 '다른 회사 리뷰' 그대로")
    expect(enabled.filter((line) => line.startsWith("cl-x: "))).toEqual(["cl-x: Claude 구독 그대로"])
  })

  test("integrations and uploads on a card (7.2, 7.5): applied, later save points left out, uploaded", () => {
    const integrationID = "ig_01JB0000000000000000000000"
    const shown = card({
      op: op({
        kind: "reorg",
        summary: {
          lines: [
            { kind: "integrated", areaID: INVENTORY, integrationID, newerSkipped: 2 },
            { kind: "integrated", areaID: SAVE, integrationID, newerSkipped: 0 },
            { kind: "pushed", areaID: INVENTORY, integrationID, remote: "origin", ref: "main" },
          ],
        },
      }),
    })
    expect(texts(shown.lines)).toEqual([
      "inventory-ui 작업을 프로젝트 본 코드에 반영했어요",
      "그 뒤 저장 지점 2개는 넣지 않았어요",
      "save-v3 작업을 프로젝트 본 코드에 반영했어요",
      "inventory-ui 작업을 원격 저장소 origin에 올렸어요",
    ])
  })

  test("an integrate op shows the integration's own card: integrationOfOp finds its id", () => {
    const integrationID = OwnTeam.IntegrationID.make("ig_01JB0000000000000000000000")
    const integrate = op({
      kind: "integrate",
      steps: [step("start", "integrate-start", { integrationID, areaID: INVENTORY }), step("merge", "integrate-merge")],
    })
    expect(integrationOfOp(integrate)).toBe(integrationID)
    expect(integrationOfOp(op({ kind: "integrate", steps: [step("start", "integrate-start", { id: "x" })] }))).toBe(
      undefined,
    )
    expect(integrationOfOp(op({ kind: "undo", steps: [step("undo", "integrate-undo", { integrationID })] }))).toBe(
      undefined,
    )
    expect(integrationOfOp(undefined)).toBeUndefined()
  })

  test("'B 다시 만들기' (8.2): a join whose undo answered conflict, and an undo that left B out, offer [다시 만들기]", () => {
    const join = { into: INVENTORY, from: SAVE }
    const merged = op({
      kind: "reorg",
      steps: [step("begin", "merge-begin", join), step("into", "merge-into", join)],
      summary: { lines: [{ kind: "area", areaID: INVENTORY, change: "merged", from: SAVE }] },
    })
    const finished = [area(INVENTORY), area(SAVE, { state: "retired" })]
    // Before the undo is tried, the card is the join's only.
    expect(texts(card({ op: merged, team: entry({}, finished) }).lines)).toEqual([
      "'save-v3'을 'inventory-ui'에 묶었어요",
    ])
    const blocked = card({ op: merged, team: entry({}, finished), undoConflict: true })
    expect(blocked.lines.at(-1)).toEqual({
      text: "'inventory-ui'에 그 뒤 새 저장 지점이 생겨 묶기를 되돌릴 수 없어요. 'save-v3'은 그 기록으로 다시 만들 수 있어요",
      tone: "warn",
      action: { label: "다시 만들기", run: { kind: "recreate", areaID: OwnTeam.AreaID.make(SAVE) } },
    })
    // Without the feature or the scope the line stays and says why, without the button.
    const plain = card({
      op: merged,
      team: entry({}, finished),
      undoConflict: true,
      can: (kind) => kind !== "recreate",
    })
    expect(plain.lines.at(-1)?.action).toBeUndefined()
    // A conflict on an op without a join (a split's undo) adds nothing.
    expect(card({ op: op({ kind: "reorg" }), undoConflict: true }).lines).toEqual([])

    // The undo ran but B's folder was gone: B stays finished and can be made again; a B put back says nothing.
    const undone = op({ kind: "undo", steps: [step("area", "merge-undo-area", { ...join, origin: OP2 })] })
    expect(actions(card({ op: undone, team: entry({}, finished) }).lines)).toEqual(["recreate"])
    expect(texts(card({ op: undone, team: entry({}, finished) }).lines)).toEqual([
      "'save-v3' 폴더가 없어 팀에 다시 넣지 않았어요. 그 기록으로 다시 만들 수 있어요",
    ])
    expect(card({ op: undone, team: entry() }).lines).toEqual([])
    // A step that did not run, or carries no area ids, is no join.
    const pending = op({ kind: "undo", steps: [step("area", "merge-undo-area", join, "pending")] })
    expect(card({ op: pending, team: entry({}, finished) }).lines).toEqual([])
    expect(joinedAreas(op({ steps: [step("into", "merge-into", { into: 1, from: SAVE })] }), "merge-into")).toEqual([])
  })
})

describe("다시 하기 on a skipped reorganization line (06 §8.1, TC-D4, 2026-10-16)", () => {
  const names: CardNames = {
    starOf: () => undefined,
    preset: (id) => id,
    account: (id) => id,
    accountOf: () => undefined,
    bytes: (bytes) => `${bytes}`,
  }
  const split = { op: "split" as const, area: "save-v3", slug: "save-two", name: "둘" }
  const saveID = OwnTeam.AreaID.make(SAVE)
  const skippedLine = {
    kind: "skipped" as const,
    item: "ops/0",
    areaID: saveID,
    why: "busy" as const,
    op: split,
  }
  const entry = (areas = [area(INVENTORY), area(SAVE)], running: OwnTeam.Op | null = null) => ({
    team: team(),
    areas: Object.fromEntries(areas.map((item) => [item.id, item])),
    order: areas.map((item) => item.id),
    op: running,
  })
  const shown = (input: Partial<CardInput> = {}) =>
    resultCard(ko, {
      op: op({ kind: "reorg", summary: { lines: [skippedLine] } }),
      team: entry(),
      pending: 0,
      names,
      can: () => true,
      ...input,
    }).lines.find((line) => line.text.includes("건너뛰었어요"))

  test("a skipped split offers 다시 하기 as the user's own one-op proposal", () => {
    expect(shown()?.action).toEqual({
      label: "다시 하기",
      run: { kind: "redo", proposal: { version: 1, ops: [split] }, areaID: saveID, item: "ops/0" },
    })
  })

  test("nothing while a team op runs, once the split's area exists, once redone here, or without the scope", () => {
    expect(shown({ team: entry(undefined, op({ kind: "integrate" })) })?.action).toBeUndefined()
    expect(
      shown({ team: entry([area(INVENTORY), area(SAVE), area(OwnTeam.AreaID.make("ar_save-two"))]) })?.action,
    ).toBeUndefined()
    expect(shown({ redone: new Set(["ops/0"]) })?.action).toBeUndefined()
    expect(shown({ can: (kind) => kind !== "redo" })?.action).toBeUndefined()
    // Another op kind's skip, or a skip without the op (an older service), has no button.
    expect(
      resultCard(ko, {
        op: op({
          kind: "reorg",
          summary: { lines: [{ kind: "skipped", item: "ops/0", areaID: saveID, why: "busy" }] },
        }),
        team: entry(),
        pending: 0,
        names,
        can: () => true,
      }).lines.some((line) => line.action !== undefined),
    ).toBe(false)
  })

  test("a join whose source area left and a shape change already done offer nothing", () => {
    const merge = { op: "merge" as const, area: "inventory-ui", from: "save-v3" }
    const joined = resultCard(ko, {
      op: op({ kind: "reorg", summary: { lines: [{ ...skippedLine, op: merge }] } }),
      team: entry([area(INVENTORY), area(SAVE, { state: "retired" })]),
      pending: 0,
      names,
      can: () => true,
    })
    expect(joined.lines.some((line) => line.action !== undefined)).toBe(false)
    const convert = { op: "convert" as const, area: "save-v3", shape: "code" as const }
    const converted = resultCard(ko, {
      op: op({ kind: "reorg", summary: { lines: [{ ...skippedLine, op: convert }] } }),
      team: entry([area(INVENTORY), area(SAVE, { shape: "code" })]),
      pending: 0,
      names,
      can: () => true,
    })
    expect(converted.lines.some((line) => line.action !== undefined)).toBe(false)
  })
})

describe("confirms (06 §9.7)", () => {
  const confirm = (fields: Record<string, unknown>) =>
    decodeConfirm({
      teamID: TEAM,
      opID: OP,
      stepID: "s1",
      kind: "paths-add",
      nonce: "n".repeat(43),
      expiresAt: 10,
      text: "…",
      ...fields,
    })

  test("removals go through the dialog; downloads are answered in place with 받기 / 나중에", () => {
    const fetch = confirm({ bytes: 2_000 })
    const removal = confirm({
      kind: "retire-remove",
      files: [
        { path: "D:/t/a", bytes: 5 },
        { path: "D:/t/b", bytes: 7 },
      ],
    })
    const listed = confirm({ kind: "cone-set", files: [{ path: "D:/t/ignored", bytes: 1 }] })
    expect([isDestructive(fetch), isDestructive(removal), isDestructive(listed)]).toEqual([false, true, true])
    expect([isFetch(fetch), isFetch(removal)]).toEqual([true, false])
    expect([confirmBytes(fetch), confirmBytes(removal)]).toEqual([2_000, 12])
  })
})

describe("notification list (06 §9.3)", () => {
  function setup(looking: boolean) {
    const h = harness()
    h.answers["op.get"] = () => ({ op: op({ id: OP2, kind: "reorg" }) })
    const runtime = { team: h.store } as unknown as ServerRuntime
    // SAFETY: the notifier reads only the server list and each runtime's team store.
    const data = { servers: { list: () => [{ key: "local" }] }, get: () => runtime } as unknown as DataLayer
    const sent: HostNotification[] = []
    const opened: string[] = []
    const dispose = createRoot((dispose) => {
      createTeamResultNotifier({
        data,
        capability: "native",
        notify: (input) => void sent.push(input),
        hidden: () => !looking,
        focused: () => looking,
        route: () => ({ name: "home" }),
        locale: () => "ko",
        open: (serverKey, sessionID) => void opened.push(`${serverKey}/${sessionID}`),
      })
      return dispose
    })
    cleanups.push(dispose)
    return { h, sent, opened }
  }

  test("every ended op is kept, newest first; 닫기 keeps it in the list", async () => {
    const run = setup(true)
    run.h.emit("op.done", done("done", OP2))
    expect(teamResults()[0]).toMatchObject({
      serverKey: "local",
      teamID: TEAM,
      opID: OP2,
      state: "done",
      closed: false,
    })
    closeTeamResult("local", OP2)
    expect(teamResults()[0]).toMatchObject({ opID: OP2, closed: true })
    // An op that ends again (after its confirms) comes back on top, open.
    run.h.emit("op.done", done("waiting", OP2))
    expect(teamResults()[0]).toMatchObject({ opID: OP2, state: "waiting", closed: false })
    expect(teamResults().filter((item) => item.opID === OP2)).toHaveLength(1)
    await tick()
    expect(run.sent).toEqual([])
  })

  test("while nobody looks the OS hears of it with the card's title; a click opens the team main", async () => {
    const run = setup(false)
    await run.h.store.resync()
    run.h.emit("op.done", done("done", OP2))
    await tick()
    expect(run.sent).toHaveLength(1)
    expect(run.sent[0]).toMatchObject({ title: "팀 구성을 바꿨어요", tag: `own:team:local:${OP2}` })
    expect(run.sent[0]!.body).toBeUndefined()
    run.sent[0]!.onClick?.()
    expect(run.opened).toEqual([`local/${MAIN}`])
  })
})

describe("copy (06 §9.1)", () => {
  test("the new screens hold no Korean text of their own: all copy comes from team/strings.ts", async () => {
    const files = [
      "team/enable.ts",
      "team/summary.tsx",
      "team/confirm.tsx",
      "sidebar/project-menu.tsx",
      // T3
      "team/reorg.tsx",
      "team/area-menu.tsx",
      "team/view-model.ts",
      "team/store.ts",
      "sidebar/rows.tsx",
      "worktree/remove.tsx",
    ]
    for (const file of files) {
      const source = await Bun.file(path.join(import.meta.dir, "..", file)).text()
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code.match(/[\uAC00-\uD7A3]+/g) ?? [], file).toEqual([])
    }
  })
})

const en: TeamText = (key, params) => teamText.text("en", key, params)

describe("a remote host without the large-file tool (06 §4.13, TG17 UI half)", () => {
  function remote(input: { readonly ensure?: () => Promise<unknown>; readonly enable: Answer[] }) {
    const h = harness()
    const answers = [...input.enable]
    h.answers.enable = (payload) => answers.shift()?.(payload)
    const run = deps(h.store)
    const uploads: number[] = []
    const value: EnableDeps = {
      ...run.value,
      ...(input.ensure
        ? {
            ensureLfs: () => {
              uploads.push(uploads.length + 1)
              return input.ensure!()
            },
          }
        : {}),
    }
    return { h, run, value, uploads }
  }
  const missing = () => new OwnRpcError("lfs_missing", "no git-lfs", { tool: "git-lfs", version: null })
  const enables = (h: ReturnType<typeof harness>) => h.calls.filter((call) => call.method === "enable")

  test("lfs_missing: exactly one upload through this PC, then enable once more and on as usual", async () => {
    const gate: { release?: () => void } = {}
    const r = remote({
      ensure: () => new Promise((resolve) => (gate.release = () => resolve({ state: "uploaded", version: "3.8.0" }))),
      enable: [missing, () => ({ opID: OP })],
    })
    const result = runEnable(r.value, { serverKey: "h-abc123", directory: "/home/me/own-open-code" })
    await tick()
    expect(r.uploads).toEqual([1])
    expect(r.run.toast.visible()).toEqual(["원격 호스트에 큰 파일 도구를 준비하는 중…"])
    gate.release?.()
    await tick()
    expect(r.run.toast.visible()).toEqual(["프로젝트를 살펴보는 중…"])
    expect(enables(r.h)).toHaveLength(2)
    r.h.emit("op.done", done())
    expect(await result).toBe("done")
    expect(r.run.opened).toEqual([MAIN])
    expect(r.uploads).toEqual([1])
  })

  test("a failed upload is the answer: an error with its reason, no second enable", async () => {
    const r = remote({
      ensure: async () => {
        throw new OwnRpcError("tool_hash_mismatch", "bad", { tool: "git-lfs", expected: "a", actual: "b" })
      },
      enable: [missing],
    })
    expect(await runEnable(r.value, { serverKey: "h-abc123", directory: "/srv/repo" })).toBeUndefined()
    expect(r.uploads).toEqual([1])
    expect(enables(r.h)).toHaveLength(1)
    expect(r.run.toast.visible()).toEqual([
      "원격 호스트에 큰 파일 도구를 준비하지 못했어요: 준비한 도구 파일이 기록과 달라 올리지 않았어요",
    ])
    expect(r.run.toast.tones()).toEqual(["danger"])
    expect(r.run.opened).toEqual([])
  })

  test("a second lfs_missing after the upload is the answer too: no loop", async () => {
    const r = remote({ ensure: async () => ({ state: "present", version: "3.8.0" }), enable: [missing, missing] })
    expect(await runEnable(r.value, { serverKey: "h-abc123", directory: "/srv/repo" })).toBeUndefined()
    expect(r.uploads).toEqual([1])
    expect(enables(r.h)).toHaveLength(2)
    expect(r.run.toast.visible()).toEqual(["팀 모드를 켜지 못했어요: 이 저장소에 필요한 큰 파일 도구가 없어요"])
  })

  test("this PC's own service (no host to upload to) says the tool is missing; other refusals never upload", async () => {
    const local = remote({ enable: [missing] })
    expect(await runEnable(local.value, { serverKey: "local", directory: HOME })).toBeUndefined()
    expect(enables(local.h)).toHaveLength(1)
    expect(local.run.toast.visible()).toEqual(["팀 모드를 켜지 못했어요: 이 저장소에 필요한 큰 파일 도구가 없어요"])
    const busy = remote({
      ensure: async () => ({ state: "uploaded", version: "3.8.0" }),
      enable: [() => new OwnRpcError("busy", "busy", { teamID: TEAM, opID: OP, kind: "enable" })],
    })
    await runEnable(busy.value, { serverKey: "h-abc123", directory: "/srv/repo" })
    expect(busy.uploads).toEqual([])
    expect(enables(busy.h)).toHaveLength(1)
  })
})

describe("the T3 confirm dialog (06 §9.7, §8.2, §8.6, §4.10, §4.11)", () => {
  const bytes = (value: number) => `${(value / 1e9).toFixed(1)} GB`
  const time = (at: number) => `${at}`
  const confirm = (fields: Record<string, unknown>) =>
    decodeConfirm({
      teamID: TEAM,
      opID: OP,
      stepID: "s1",
      kind: "retire-remove",
      nonce: "n".repeat(43),
      expiresAt: 10,
      text: "…",
      ...fields,
    })
  const removal = (stepID: string, size: number) =>
    confirm({ stepID, files: [{ path: `D:/own-open-code-team/${stepID}/node_modules`, bytes: size }] })

  test("an unapplied area keeps its save points: the count its step carries, under 남는 것", () => {
    const op = decodeOp({
      id: OP,
      teamID: TEAM,
      kind: "retire",
      by: "user",
      state: "waiting",
      createdAt: 1,
      steps: [
        { ...step("retire:a:check", "retire.check"), note: "…" },
        {
          ...step("s1", "retire-remove", { areaID: INVENTORY, unapplied: 3 }),
          mode: "confirm",
          state: "needs_confirm",
        },
      ],
    })
    const shown = removal("s1", 2_500_000_000)
    expect(stepArgs(op, shown)).toEqual({ areaID: INVENTORY, unapplied: 3 })
    // Another op's confirm finds nothing in this one.
    expect(stepArgs(op, confirm({ opID: OP2 }))).toBeUndefined()
    const view = confirmView(ko, [shown], { local: true, now: 1, bytes, time, args: (item) => stepArgs(op, item) })
    expect(view.stays).toBe(true)
    expect(view.unapplied).toBe("반영하지 않은 저장 지점 3개는 기록에 남아요")
    // All applied (0), or a step that does not say: no line.
    const applied = decodeOp({ ...op, steps: [{ ...op.steps[1]!, args: { areaID: INVENTORY, unapplied: 0 } }] })
    expect(
      confirmView(ko, [shown], { local: true, now: 1, bytes, time, args: (item) => stepArgs(applied, item) }).unapplied,
    ).toBeUndefined()
    expect(confirmView(ko, [shown], { local: true, now: 1, bytes, time }).unapplied).toBeUndefined()
  })

  test("finished areas go together with the removals' total; their unapplied save points add up", () => {
    const three = [removal("a", 4_000_000_000), removal("b", 2_500_000_000), removal("c", 1_000_000_000)]
    const unapplied: Record<string, number> = { a: 2, b: 0, c: 1 }
    const view = confirmView(ko, three, {
      local: true,
      now: 1,
      bytes,
      time,
      args: (item) => ({ unapplied: unapplied[item.stepID] }),
    })
    expect(view.title).toBe("끝난 영역 3개 정리(7.5 GB)")
    expect(view.files.map((file) => file.size)).toEqual(["4.0 GB", "2.5 GB", "1.0 GB"])
    expect(view.unapplied).toBe("반영하지 않은 저장 지점 3개는 기록에 남아요")
    expect(view.buttons[0]).toEqual({ choice: "skip", label: "두기" })
  })

  test("a shared folder made read-only says what changes and how to undo it; the command only under 자세히", () => {
    const shared = confirm({ kind: "protect-shared", text: "'weights' 폴더를 모든 영역에 연결할까요?" })
    expect([isSystem(shared), isDestructive(shared)]).toEqual([true, false])
    const args = () => ({ name: "weights" })
    const windows = confirmView(ko, [shared], { local: true, now: 1, bytes, time, args, protect: "acl", home: HOME })
    expect(windows.danger).toBe(false)
    expect(windows.title).toBe("확인이 필요해요")
    expect(windows.buttons).toEqual([
      { choice: "skip", label: "두기" },
      { choice: "do", label: "하기", tone: "primary" },
    ])
    expect(windows.system).toEqual([
      {
        line: "바뀌는 설정: 'weights' 폴더를 읽기 전용으로 바꿈(쓰기와 지우기를 막고 읽기는 그대로). 되돌리는 법: 그 폴더의 속성 > 보안 > 고급에서 이 사용자의 거부 항목을 지워요",
        command: 'icacls "D:/own-open-code\\weights" /remove:d "%USERNAME%"',
      },
    ])
    const linux = confirmView(ko, [shared], {
      local: true,
      now: 1,
      bytes,
      time,
      args: () => ({ name: "data/weights" }),
      protect: "chmod",
      home: "/home/me/repo",
    })
    expect(linux.system[0]?.line).toContain("되돌리는 법: 그 폴더와 안의 파일에 쓰기 권한을 다시 줘요")
    expect(linux.system[0]?.command).toBe("chmod -R u+w '/home/me/repo/data/weights'")
    for (const item of [...windows.system, ...linux.system]) expect(item.line).not.toMatch(/icacls|chmod|\{\w+\}/)
  })

  test("the first .assets folder says the disk it takes and how to undo it", () => {
    const assets = confirm({ kind: "integrate-assets", bytes: 12_000_000_000 })
    expect(isSystem(assets)).toBe(true)
    expect(confirmView(ko, [assets], { local: true, now: 1, bytes, time }).system).toEqual([
      {
        line: "바뀌는 설정: 큰 파일 검사용 폴더 .assets를 만듦(디스크 12.0 GB). 되돌리는 법: 팀 모드를 끄면 그 폴더의 잠금이 풀리고, 작업 폴더 목록에서 그 폴더를 지워요. 그 폴더에는 사용자 작업이 없어요",
      },
    ])
    // Other confirms change nothing of the system.
    expect(confirmView(ko, [removal("a", 1)], { local: true, now: 1, bytes, time }).system).toEqual([])
    expect(isSystem(confirm({ kind: "paths-add" }))).toBe(false)
  })
})

describe("the retire signal and missing folders (06 §8.1, §8.8, §9.4, §9.7)", () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = 100 * DAY
  const quiet = area(INVENTORY, { retirable: { since: NOW - 9 * DAY } })
  const entry = (areas: OwnTeam.AreaView[]) => ({
    areas: Object.fromEntries(areas.map((item) => [item.id, item])),
    order: areas.map((item) => item.id),
  })

  test("a retirable area becomes a suggestion card; [무시] hides it until another quiet period", async () => {
    const h = harness()
    const areas = { list: [quiet, area(SAVE), area("ar_docs", { state: "retired", retirable: { since: 1 } })] }
    h.answers["team.get"] = () => ({ team: team(), areas: areas.list, waiting: {}, op: null, pending: [] })
    await h.store.resync()
    const shown = () => retireSuggestions(ko, h.store.retireCandidates(TEAM), NOW)
    // Only the active area the service marks: not the plain one, not the finished one.
    expect(shown()).toEqual([
      {
        areaID: OwnTeam.AreaID.make(INVENTORY),
        since: NOW - 9 * DAY,
        text: "제안: 'inventory-ui' 영역을 끝낼 수 있어요(모두 반영됨, 9일 동안 변경 없음)",
      },
    ])
    h.store.ignoreRetire(TEAM, INVENTORY, NOW - 9 * DAY)
    expect(shown()).toEqual([])
    expect(h.store.retireCandidates("tm_ffffffffffff")).toEqual([])
    // Changed and quiet again: a new `since` suggests it again.
    areas.list = [area(INVENTORY, { retirable: { since: NOW - 8 * DAY } })]
    await h.store.resync()
    expect(shown()).toHaveLength(1)
    expect(retireSuggestions(en, h.store.retireCandidates(TEAM), NOW)[0]?.text).toBe(
      "Suggestion: the area 'inventory-ui' can be finished (all applied, no change for 8 days)",
    )
  })

  test("the area row: `끝낼 수 있음` beside the status; a missing folder's `[다시 만들기] [끝내기]` where allowed", () => {
    const row = (value: OwnTeam.AreaView, retire = true, recreate = true) =>
      areaRow(ko, value, { home: HOME, waiting: 0, preset: { name: "평소대로", builtin: true }, retire, recreate })
    expect(row(quiet)).toMatchObject({ retirable: "끝낼 수 있음", status: { word: "쉬는 중" } })
    expect(row(quiet).finish).toBeUndefined()
    expect(row(quiet).recreate).toBeUndefined()
    expect(row(area(SAVE)).retirable).toBeUndefined()
    const broken = (why: OwnTeam.BrokenReason) =>
      area(SAVE, { state: "broken", broken: { why, at: 2 }, status: { kind: "broken", at: 2, text: "" } })
    // 8.8 `찾을 수 없음 [다시 만들기] [끝내기]`: each where this build has it and this connection may.
    expect(row(broken("missing"))).toMatchObject({
      status: { word: "찾을 수 없음" },
      recreate: "다시 만들기",
      finish: "끝내기",
    })
    expect(row(broken("missing"), false)).toMatchObject({ recreate: "다시 만들기" })
    expect(row(broken("missing"), false).finish).toBeUndefined()
    expect(row(broken("missing"), true, false)).toMatchObject({ finish: "끝내기" })
    expect(row(broken("missing"), true, false).recreate).toBeUndefined()
    expect(row(broken("identity")).finish).toBeUndefined()
    expect(row(broken("identity")).recreate).toBeUndefined()
    expect(
      areaRow(en, broken("missing"), { home: HOME, waiting: 0, preset: { name: "x", builtin: true }, recreate: true })
        .recreate,
    ).toBe("Create again")
  })

  test("areas as suggestions and proposals name them: id, slug or name", () => {
    const team = entry([quiet, area(SAVE, { name: "저장 형식" })])
    expect(areaOf(team, INVENTORY)?.name).toBe("inventory-ui")
    expect(areaOf(team, "save-v3")?.name).toBe("저장 형식")
    expect(areaOf(team, "저장 형식")?.directory).toBe("D:/own-open-code-team/save-v3")
    expect(areaOf(team, "gone")).toBeUndefined()
    expect(areaOf(undefined, INVENTORY)).toBeUndefined()
  })
})

describe("팀 구성 다시 보기 (06 §8.1, §9.7)", () => {
  test("the card: confirms said, rejections with why, a retire suggestion with its area, the main's notes", () => {
    const card = proposalCard(ko, {
      proposal: {
        version: 1,
        ops: [
          { op: "split", area: INVENTORY, slug: "inventory-server", name: "인벤토리 서버" },
          { op: "retire", area: "gone" },
          { op: "merge", area: INVENTORY, from: "save-v3" },
        ],
        suggest: [{ kind: "retire", area: "save-v3", why: "모두 반영됨" }],
        notes: "결제를 둘로 나눴어요.",
      },
      plan: {
        steps: [
          { item: "ops/0", kind: "split-begin", mode: "auto" },
          { item: "ops/2", kind: "merge-into", mode: "auto" },
          { item: "ops/2", kind: "retire-remove", mode: "confirm" },
        ],
        rejected: [
          { item: "ops/1", why: "'gone' 영역이 없어요" },
          { item: "commands/code/0", why: "목록에 없는 명령이에요" },
        ],
      },
      name: (value) => (value === INVENTORY ? "인벤토리 화면" : value),
    })
    expect(card.runs).toBe(true)
    expect(card.lines).toEqual([
      { text: "'인벤토리 화면'에서 '인벤토리 서버' 영역을 나눠요", item: "ops/0", checked: true },
      { text: "'gone' 영역을 끝내요 · 하지 않음: 'gone' 영역이 없어요", tone: "muted" },
      { text: "'save-v3'을 '인벤토리 화면'에 묶어요 · 확인한 뒤 해요", tone: "warn", item: "ops/2", checked: true },
      { text: "하지 않음: 목록에 없는 명령이에요", tone: "muted" },
      { text: "제안: 'save-v3' 영역을 끝낼 수 있어요(모두 반영됨)", tone: "muted", retire: "save-v3" },
      { text: "결제를 둘로 나눴어요.", tone: "muted" },
    ])
  })

  test("choices (2026-10-16): 끝내기 unchecked and never undone, a busy or paused skip choosable but unchecked, refusals and the judge's moves not choosable", () => {
    const card = proposalCard(ko, {
      proposal: {
        version: 1,
        ops: [
          { op: "rename", area: INVENTORY, name: "인벤토리" },
          { op: "retire", area: "save-v3" },
          { op: "split", area: "docs", slug: "docs-two", name: "둘" },
          { op: "convert", area: "gone", shape: "code" },
          { op: "merge", area: INVENTORY, from: "save-v3" },
        ],
        areas: [{ slug: "feat", name: "기능", adopt: { worktree: "D:/w/feat" } }],
        suggest: [{ kind: "move", area: INVENTORY, why: "그 폴더의 대화" }],
      },
      plan: {
        steps: [
          { item: "ops/0", kind: "area-rename", mode: "auto" },
          { item: "ops/1", kind: "retire.begin", mode: "auto" },
          { item: "areas/0", kind: "adopt.register", mode: "auto" },
        ],
        rejected: [
          { item: "ops/3", why: "영역이 없어요" },
          // Older clients read the skips here too; this one reads them from `skipped`.
          { item: "ops/2", why: "'docs' 영역에서 일하는 중이라 이번 정리에서 건너뛰었어요" },
          { item: "ops/4", why: "'save-v3'(은)는 메인 멈춤이라 이번 정리에서 건너뛰었어요" },
        ],
        skipped: [
          { item: "ops/2", areaID: OwnTeam.AreaID.make("ar_docs"), why: "busy" },
          { item: "ops/4", areaID: OwnTeam.AreaID.make(SAVE), why: "paused" },
        ],
      },
      name: (value) => (value === INVENTORY ? "인벤토리 화면" : value.replace(/^ar_/, "")),
    })
    expect(card.runs).toBe(true)
    expect(card.lines).toEqual([
      { text: "feat 폴더를 팀에 넣어요", item: "areas/0", checked: true },
      { text: "'인벤토리 화면' 영역 이름을 '인벤토리'로 바꿔요", item: "ops/0", checked: true },
      { text: "'save-v3' 영역을 끝내요 · 되돌릴 수 없어요", tone: "warn", item: "ops/1", checked: false },
      {
        text: "'docs'에서 '둘' 영역을 나눠요 · 'docs'에서 일하는 중이에요. 고르면 그 일이 끝난 뒤에 하고, 그동안 팀의 다른 일(메인 요청, 반영)도 기다려요",
        tone: "warn",
        item: "ops/2",
        checked: false,
      },
      { text: "'gone'를 가벼운 폴더로 바꿔요 · 하지 않음: 영역이 없어요", tone: "muted" },
      {
        text: "'save-v3'을 '인벤토리 화면'에 묶어요 · 'save-v3'은 메인 멈춤 중이에요. 고르면 그 대화가 쉴 때 하고, 그 대화에 인계나 정리 요청이 갈 수 있어요",
        tone: "warn",
        item: "ops/4",
        checked: false,
      },
      { text: "제안: 대화를 '인벤토리 화면' 영역으로 옮길 수 있어요(그 폴더의 대화)", tone: "muted" },
    ])
  })

  test("chosenProposal keeps only the chosen ops and areas, version 1, no notes or suggestions", () => {
    const proposal: OwnTeam.Proposal = {
      version: 1,
      ops: [
        { op: "rename", area: "a", name: "가" },
        { op: "retire", area: "b" },
        { op: "split", area: "c", slug: "c-two", name: "둘" },
      ],
      areas: [{ slug: "feat", name: "기능", adopt: { worktree: "D:/w/feat" } }],
      suggest: [{ kind: "retire", area: "b", why: "끝남" }],
      notes: "메모",
    }
    expect(chosenProposal(proposal, new Set(["ops/0", "ops/2"]))).toEqual({
      version: 1,
      ops: [
        { op: "rename", area: "a", name: "가" },
        { op: "split", area: "c", slug: "c-two", name: "둘" },
      ],
    })
    expect(chosenProposal(proposal, new Set(["areas/0"]))).toEqual({ version: 1, areas: proposal.areas })
    expect(chosenProposal(proposal, new Set())).toEqual({ version: 1 })
  })

  test("chosenProposal leaves out what only the user sets, whatever the judge wrote (2026-10-27)", () => {
    // The judge's answer as `reorg.propose` returns it.
    const judged = Schema.decodeUnknownSync(OwnTeam.Proposal)({
      version: 1,
      ops: [
        {
          op: "new",
          slug: "bosses",
          name: "보스",
          goal: "보스 그림",
          from: "main",
          main: { providerID: "anthropic", id: "claude" },
          harness: { id: "codex", prompt: "own" },
          userMade: true,
        },
      ],
      areas: [
        { slug: "feat", name: "기능", adopt: { worktree: "D:/w/feat" }, userMade: true },
        { slug: "old", name: "옛 영역", create: { from: "old" }, userMade: true },
      ],
    })
    expect(chosenProposal(judged, new Set(["ops/0", "areas/0", "areas/1"]))).toEqual({
      version: 1,
      ops: [{ op: "new", slug: "bosses", name: "보스", goal: "보스 그림", from: "main" }],
      areas: [
        { slug: "feat", name: "기능", adopt: { worktree: "D:/w/feat" } },
        { slug: "old", name: "옛 영역", create: { from: "old" } },
      ],
    })
  })

  test("nothing to run: the card still says what the main thought", () => {
    const card = proposalCard(ko, {
      proposal: { version: 1, suggest: [{ kind: "convert", worktree: "D:/w/cl-x", why: "큰 파일을 쓰지 않음" }] },
      plan: { steps: [], rejected: [] },
      name: (value) => value,
    })
    expect(card.runs).toBe(false)
    expect(card.lines).toEqual([
      { text: "제안: cl-x 폴더를 가벼운 폴더로 바꿀 수 있어요(큰 파일을 쓰지 않음)", tone: "muted" },
    ])
  })
})
