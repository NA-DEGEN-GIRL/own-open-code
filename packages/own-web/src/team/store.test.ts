// TeamStore (06 §9, §2.7) over the real event bus and a fake own.team client. Fixtures go through the protocol's
// schemas, so they have the shapes the service sends. Covered: nothing is asked before a screen needs it; a resync
// reads health, the team list and each team that is on; events patch status, Main 멈춤, outbox sizes, op progress,
// confirms, notices and each area's latest integration, de-duplicated by event id; a newer revision reloads the team
// and an older answer is dropped; open notices come back with team.get and leave once the service no longer holds
// them; roles come from the registry, the session metadata hint only for teams it has not answered and never for
// children. An earlier owner carries why its seat ended (담당 대화 바꾸기), the newest reason when it left twice.
import { afterEach, describe, expect, test } from "bun:test"
import type { OpenCodeEvent, SessionInfo } from "@opencode/client"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { OwnRpcError } from "@/data/rpc"
import { TEAM_META, TEAM_SCOPE, type TeamMethod, type TeamRpc } from "@/data/team-rpc"
import { createTeamStore, type TeamStore } from "./store"

const TEAM = "tm_0123456789ab"
const OFF_TEAM = "tm_ba9876543210"
const UNSEEN_TEAM = "tm_aaaaaaaaaaaa"
const INVENTORY = "ar_inventory-ui"
const SAVE = "ar_save-v3"
const MAIN = "ses_main_now"
const MAIN_OLD = "ses_main_old"
const OWNER = "ses_owner_now"
const OWNER_OLD = "ses_owner_old"
const PENDING = "ses_owner_pending"
const OP = "op_01JB0000000000000000000000"
const HOME = "D:/own-open-code"

const decodeTeam = Schema.decodeUnknownSync(OwnTeam.Team)
const decodeArea = Schema.decodeUnknownSync(OwnTeam.AreaView)
const decodeHealth = Schema.decodeUnknownSync(OwnTeam.Health)

function team(rev: number, fields: Record<string, unknown> = {}) {
  return decodeTeam({
    id: TEAM,
    projectID: "prj_own",
    commonDir: "D:/#Projects/own-open-code/.git",
    target: "main",
    state: "on",
    rev,
    home: { directory: HOME, linked: true, chosenBy: "session" },
    main: { sessionID: MAIN, previous: [MAIN_OLD] },
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

const inventory = (fields: Record<string, unknown> = {}) =>
  area(INVENTORY, {
    owner: { sessionID: OWNER, previous: [{ sessionID: OWNER_OLD, endedAt: 2, why: "fresh" }], attached: true },
    ...fields,
  })
const save = () => area(SAVE, { owner: { sessionID: null, pending: PENDING, previous: [], attached: false } })

function get(rev: number, fields: { team?: Record<string, unknown>; inventory?: Record<string, unknown> } = {}) {
  return {
    team: team(rev, fields.team),
    areas: [inventory(fields.inventory), save()],
    waiting: { [INVENTORY]: 1 },
    op: null,
    pending: [],
  }
}

// Fresh objects on every call, like answers off the wire: the store reconciles into what it holds.
const health = () =>
  decodeHealth({ version: "2.0.18-own.6", buildId: "b1", guard: "ok", features: ["enable", "pause"] })
const list = (state = "on") => ({
  teams: [
    { id: TEAM, projectID: "prj_own", home: HOME, state, areas: 2 },
    { id: OFF_TEAM, projectID: "prj_other", home: "D:/other", state: "off", areas: 0 },
  ],
})

type Answer = (payload: unknown) => unknown
type Hint = Pick<SessionInfo, "parentID" | "metadata">

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function harness(
  input: { sessions?: Record<string, Hint>; connected?: boolean; allowed?: (method: TeamMethod) => boolean } = {},
) {
  const bus = createEventBus()
  const calls: Array<{ method: TeamMethod; input: unknown }> = []
  const answers: Partial<Record<TeamMethod, Answer>> = {
    health,
    "team.list": () => list(),
    "team.get": () => get(7),
  }
  const rpc: TeamRpc = {
    allowed: (method) => input.allowed?.(method) ?? true,
    scope: (method) => TEAM_SCOPE[method],
    async call(method, payload) {
      calls.push({ method, input: payload })
      const value = await answers[method]?.(payload)
      if (value instanceof Error) throw value
      // SAFETY: every test answers a method with that method's output shape.
      return value as never
    },
  }
  const state = { connected: input.connected ?? true, seq: 0 }
  const root = createRoot((dispose) => ({
    dispose,
    store: createTeamStore({
      rpc,
      bus,
      session: (sessionID) => input.sessions?.[sessionID],
      connected: () => state.connected,
    }),
  }))
  cleanups.push(() => {
    root.store.dispose()
    root.dispose()
    bus.dispose()
  })
  function emit(name: string, data: object, eventId = `01JB${String(++state.seq).padStart(22, "0")}`) {
    // SAFETY: shaped like `V2EventRpc`, the variant the server sends for plugin RPC events.
    bus.publish({
      id: `evt_${state.seq}`,
      created: 1_000 + state.seq,
      type: `rpc.own.team.${name}`,
      location: { directory: "C:/control" },
      data: { eventId, origin: "global", ...data },
    } as unknown as OpenCodeEvent)
    bus.flush()
  }
  function connect() {
    state.connected = true
    // SAFETY: the stream's connect frame; only `type` is read.
    bus.publish({ type: "server.connected", data: {} } as unknown as OpenCodeEvent)
    bus.flush()
  }
  // What the store started is done: the coalesced reloads go out now (the window never runs out by itself here), and
  // the fake answers in promises only, so after one macrotask every call is answered and applied. No clock: the old
  // 10 ms sleeps waited for the OS to run the process again.
  async function settle() {
    root.store.flush()
    await new Promise((resolve) => setImmediate(resolve))
  }
  const methods = () => calls.map((call) => call.method)
  return { store: root.store, calls, methods, answers, emit, connect, settle }
}

async function ready(store: TeamStore) {
  await store.resync()
  expect(store.state.load).toBe("ready")
}

describe("영역 만들기 (06 §9.4)", () => {
  test("the whole dialog with `area-edit`; on an older own.team with `reorg.new` alone the basic one; none without", async () => {
    const offered = async (features: readonly string[], allowed?: (method: TeamMethod) => boolean) => {
      const h = harness(allowed === undefined ? {} : { allowed })
      h.answers.health = () =>
        decodeHealth({ version: "2.0.32-own.4", buildId: "b1", guard: "ok", features: [...features] })
      await ready(h.store)
      return h.store.createForm()
    }
    expect(await offered(["enable", "reorg.new", "area-edit"])).toBe("full")
    // An older own.team would take the area's own model, 에이전트 방식 and the mark and drop them without a word; it
    // still makes an area of a name, a role and a folder, as its 새 영역 did (2026-10-27).
    expect(await offered(["enable", "reorg.new"])).toBe("basic")
    expect(await offered(["enable"])).toBeUndefined()
    expect(await offered(["enable", "reorg.new", "area-edit"], (method) => method !== "reorg.apply")).toBeUndefined()
    expect(await offered(["enable", "reorg.new"], (method) => method !== "reorg.apply")).toBeUndefined()
  })
})

describe("loading", () => {
  test("nothing is asked before a screen needs it; then health, the list and every team that is on", async () => {
    const h = harness()
    h.emit("area.changed", {
      teamID: TEAM,
      areaID: INVENTORY,
      rev: 8,
      status: { kind: "busy", at: 2, text: "" },
      paused: false,
    })
    h.connect()
    await h.settle()
    expect(h.calls).toEqual([])
    expect(h.store.state.load).toBe("idle")

    h.store.ensure()
    await h.settle()
    expect(h.methods()).toEqual(["health", "team.list", "team.get"])
    expect(h.calls[2]!.input).toEqual({ directory: HOME })
    expect(h.store.state.load).toBe("ready")
    expect(Object.keys(h.store.state.teams)).toEqual([TEAM])
    expect(h.store.state.list.map((item): string => item.id)).toEqual([TEAM, OFF_TEAM])
    expect(h.store.state.teams[TEAM]!.order).toEqual([INVENTORY, SAVE])
    expect(h.store.state.teams[TEAM]!.waiting[INVENTORY]).toBe(1)
    expect(h.store.has("pause")).toBe(true)
    expect(h.store.has("integrate")).toBe(false)

    h.store.ensure()
    await h.settle()
    expect(h.calls).toHaveLength(3)
    h.connect()
    await h.settle()
    expect(h.methods().slice(3)).toEqual(["health", "team.list", "team.get"])
  })

  test("ensure waits for the stream when it is down", async () => {
    const h = harness({ connected: false })
    h.store.ensure()
    await h.settle()
    expect(h.calls).toEqual([])
    h.connect()
    await h.settle()
    expect(h.methods()).toEqual(["health", "team.list", "team.get"])
  })

  test("no plugin is missing, a failed guard unmanaged, anything else unavailable", async () => {
    const h = harness()
    h.answers.health = () => new OwnRpcError("rpc.unavailable", "no rpc")
    await h.store.resync()
    expect(h.store.state).toMatchObject({ load: "missing", reason: "rpc.unavailable" })

    h.answers.health = () => decodeHealth({ version: "2.0.18-own.5", buildId: "b0", guard: "skew", features: [] })
    await h.store.resync()
    expect(h.store.state).toMatchObject({ load: "unmanaged", reason: "skew" })

    h.answers.health = health
    h.answers["team.list"] = () => new TypeError("Failed to fetch")
    await h.store.resync()
    expect(h.store.state).toMatchObject({ load: "unavailable", reason: "TypeError" })
  })

  test("one team that fails to load does not stop the others; teams no longer on are dropped", async () => {
    const h = harness()
    await ready(h.store)
    h.answers["team.list"] = () => list("off")
    await ready(h.store)
    expect(h.store.state.teams).toEqual({})
    expect(h.store.isTeamMain(MAIN)).toBe(false)

    h.answers["team.list"] = () => list()
    h.answers["team.get"] = () => new OwnRpcError("not_git", "gone", { directory: HOME })
    await ready(h.store)
    expect(h.store.state.teams).toEqual({})
  })

  test("load(directory) answers the folder's team, or undefined when there is none", async () => {
    const h = harness()
    expect((await h.store.load("D:\\own-open-code-team\\inventory-ui"))?.team.id).toBe(TEAM as never)
    h.answers["team.get"] = () => ({ team: null, areas: [], waiting: {}, op: null, pending: [] })
    expect(await h.store.load("D:\\plain")).toBeUndefined()
  })
})

describe("roles and places", () => {
  test("from the registry: the main, owners, a pending owner and earlier conversations", async () => {
    const h = harness()
    await ready(h.store)
    expect(h.store.isTeamMain(MAIN)).toBe(true)
    expect(h.store.isTeamMain(MAIN_OLD)).toBe(false)
    expect(h.store.placeOf(MAIN_OLD)).toEqual({ teamID: TEAM as never, role: "main", previous: true, hint: false })
    expect(h.store.areaOfSession(OWNER)).toMatchObject({ areaID: INVENTORY, previous: false, hint: false })
    expect(h.store.areaOfSession(OWNER_OLD)).toMatchObject({ areaID: INVENTORY, previous: true })
    expect(h.store.areaOfSession(PENDING)).toMatchObject({ areaID: SAVE, previous: false })
    expect(h.store.areaOfSession(MAIN)).toBeUndefined()
    expect(h.store.isTeamMain(OWNER)).toBe(false)
    expect(h.store.placeOf("ses_somebody")).toBeUndefined()
  })

  test("an earlier owner says why its seat ended: the newest reason, and none once it holds the seat again", async () => {
    const h = harness()
    await ready(h.store)
    expect(h.store.placeOf(OWNER_OLD)).toEqual({
      teamID: TEAM as never,
      role: "owner",
      areaID: INVENTORY as never,
      previous: true,
      hint: false,
      why: "fresh",
    })
    const owner = (sessionID: string, previous: ReadonlyArray<readonly [string, string]>) => ({
      owner: {
        sessionID,
        previous: previous.map(([id, why], index) => ({ sessionID: id, endedAt: index + 2, why })),
        attached: true,
      },
    })
    h.answers["team.get"] = () =>
      get(8, {
        inventory: owner(OWNER, [
          [OWNER_OLD, "fresh"],
          [OWNER, "seat"],
          [OWNER_OLD, "seat"],
        ]),
      })
    await h.store.load(HOME)
    expect(h.store.placeOf(OWNER_OLD)).toMatchObject({ role: "owner", previous: true, why: "seat" })
    // The owner again after it gave the seat away: the owner, with no reason to show.
    expect(h.store.placeOf(OWNER)).toEqual({
      teamID: TEAM as never,
      role: "owner",
      areaID: INVENTORY as never,
      previous: false,
      hint: false,
    })
  })

  test("area peers (동료) from the registry's `peers` only; their metadata is no hint", async () => {
    const reviewer = {
      key: "reviewer",
      sessionID: "ses_reviewer",
      label: "리뷰어",
      role: "바뀐 코드를 읽습니다",
      attached: false,
      origin: "registered",
      at: 3,
    }
    const created = { [TEAM_META.session]: { role: "peer", teamID: UNSEEN_TEAM, areaID: "ar_x" } }
    const h = harness({ sessions: { ses_created: { metadata: created } } })
    h.answers["team.get"] = () => get(7, { inventory: { peers: [reviewer] } })
    await ready(h.store)
    expect(h.store.placeOf("ses_reviewer")).toEqual({
      teamID: TEAM as never,
      role: "peer",
      areaID: INVENTORY as never,
      key: "reviewer",
      previous: false,
      hint: false,
    })
    expect(h.store.peerOf("ses_reviewer")).toMatchObject({ area: { id: INVENTORY }, peer: { label: "리뷰어" } })
    // A peer is not the area's owner nor the team main; the owner stays the owner.
    expect(h.store.areaOfSession("ses_reviewer")).toBeUndefined()
    expect(h.store.isTeamMain("ses_reviewer")).toBe(false)
    expect(h.store.peerOf(OWNER)).toBeUndefined()
    expect(h.store.placeOf("ses_created")).toBeUndefined()
    expect(h.store.peerOf("ses_created")).toBeUndefined()
  })

  test("folders and projects; Windows paths compare without case and separators", async () => {
    const h = harness()
    await ready(h.store)
    expect(h.store.teamOfDirectory("d:\\own-open-code\\")?.team.id).toBe(TEAM as never)
    expect(h.store.teamOfDirectory("D:\\own-open-code-team\\save-v3")?.team.id).toBe(TEAM as never)
    expect(h.store.teamOfDirectory("D:\\elsewhere")).toBeUndefined()
    expect(h.store.areaOfDirectory("D:\\OWN-OPEN-CODE-TEAM\\inventory-ui")?.area.id).toBe(INVENTORY as never)
    expect(h.store.areaOfDirectory(HOME)).toBeUndefined()
    expect(h.store.teamsOfProject("prj_own").map((entry) => entry.team.id)).toEqual([TEAM as never])
    expect(h.store.area(TEAM, SAVE)?.owner.pending).toBe(PENDING as never)
  })

  test("the metadata hint only for a team the registry has not answered, never for children", async () => {
    const meta = (value: Record<string, string>) => ({ [TEAM_META.session]: value })
    const sessions: Record<string, Hint> = {
      ses_hint: { metadata: meta({ role: "owner", teamID: UNSEEN_TEAM, areaID: "ar_x" }) },
      ses_child: { parentID: "ses_hint", metadata: meta({ role: "owner", teamID: UNSEEN_TEAM, areaID: "ar_x" }) },
      ses_bad: { metadata: meta({ role: "owner", teamID: UNSEEN_TEAM }) },
      ses_off: { metadata: meta({ role: "main", teamID: OFF_TEAM }) },
      ses_fork: { metadata: meta({ role: "main", teamID: TEAM }) },
    }
    const h = harness({ sessions })
    expect(h.store.areaOfSession("ses_hint")).toEqual({
      role: "owner",
      teamID: UNSEEN_TEAM as never,
      areaID: "ar_x" as never,
      previous: false,
      hint: true,
    })
    expect(h.store.placeOf("ses_child")).toBeUndefined()
    expect(h.store.placeOf("ses_bad")).toBeUndefined()
    // Before the registry answered, a main's metadata reads as the main.
    expect(h.store.isTeamMain("ses_fork")).toBe(true)

    await ready(h.store)
    // The registry knows this team and does not list the session: a fork or a stale copy, not the main.
    expect(h.store.isTeamMain("ses_fork")).toBe(false)
    // An off team is in the list: its metadata is no longer a hint.
    expect(h.store.placeOf("ses_off")).toBeUndefined()
    expect(h.store.areaOfSession("ses_hint")?.hint).toBe(true)
  })
})

describe("events", () => {
  test("area.changed patches status and Main 멈춤 at once; a newer revision reloads the team", async () => {
    const h = harness()
    await ready(h.store)
    h.answers["team.get"] = () => get(8, { inventory: { status: { kind: "busy", at: 3, text: "" }, paused: "user" } })
    h.emit("area.changed", {
      teamID: TEAM,
      areaID: INVENTORY,
      rev: 8,
      status: { kind: "busy", at: 3, text: "" },
      paused: "user",
    })
    expect(h.store.area(TEAM, INVENTORY)).toMatchObject({ status: { kind: "busy" }, paused: "user" })
    await h.settle()
    expect(h.methods().filter((method) => method === "team.get")).toHaveLength(2)
    expect(h.store.team(TEAM)?.team.rev).toBe(8)

    // Not newer: nothing to reload.
    h.emit("team.changed", { teamID: TEAM, rev: 8 })
    await h.settle()
    expect(h.methods().filter((method) => method === "team.get")).toHaveLength(2)
    h.emit("team.changed", { teamID: TEAM, rev: 9 })
    await h.settle()
    expect(h.methods().filter((method) => method === "team.get")).toHaveLength(3)
  })

  test("a team the store does not know yet reloads everything", async () => {
    const h = harness()
    await ready(h.store)
    h.emit("team.changed", { teamID: UNSEEN_TEAM, rev: 1 })
    await h.settle()
    expect(h.methods().slice(3)).toEqual(["health", "team.list", "team.get"])
  })

  test("an answer older than what the store holds is dropped", async () => {
    const h = harness()
    h.answers["team.get"] = () => get(9)
    await ready(h.store)
    h.answers["team.get"] = () => get(8, { inventory: { status: { kind: "failed", at: 1, text: "" } } })
    await h.store.load(HOME)
    expect(h.store.team(TEAM)?.team.rev).toBe(9)
    expect(h.store.area(TEAM, INVENTORY)?.status.kind).toBe("idle")
    h.answers["team.get"] = () => get(10, { team: { state: "off" } })
    await h.store.load(HOME)
    expect(h.store.team(TEAM)).toBeUndefined()
  })

  test("outbox sizes; duplicates by event id are applied once", async () => {
    const h = harness()
    await ready(h.store)
    const seen: string[] = []
    h.store.on("outbox.changed", (event) => seen.push(`${event.data.areaID}:${event.data.waiting}`))
    h.emit("outbox.changed", { teamID: TEAM, areaID: INVENTORY, waiting: 3 }, "01JB0000000000000000000099")
    h.emit("outbox.changed", { teamID: TEAM, areaID: INVENTORY, waiting: 3 }, "01JB0000000000000000000099")
    expect(h.store.state.teams[TEAM]!.waiting[INVENTORY]).toBe(3)
    expect(seen).toEqual([`${INVENTORY}:3`])
  })

  test("op progress before the team is known, confirms replaced per step, done reloads the team", async () => {
    const h = harness()
    h.emit("op.progress", { teamID: TEAM, opID: OP, stepID: "s1", state: "done", text: "영역 2개를 준비하는 중…" })
    expect(h.store.state.ops[OP]).toEqual({
      teamID: TEAM,
      steps: { s1: { state: "done", text: "영역 2개를 준비하는 중…" } },
      last: { stepID: "s1", text: "영역 2개를 준비하는 중…" },
    })
    expect(h.calls).toEqual([])

    await ready(h.store)
    const confirm = Schema.decodeUnknownSync(OwnTeam.Confirm)({
      teamID: TEAM,
      opID: OP,
      stepID: "s2",
      kind: "cone-add",
      areaID: INVENTORY,
      nonce: "0123456789ABCDEFGHJK",
      expiresAt: 9_000,
      text: "2.1 GB",
      bytes: 2_100_000_000,
    })
    h.emit("op.confirm", confirm)
    h.emit("op.confirm", { ...confirm, text: "2.2 GB" })
    expect(h.store.state.teams[TEAM]!.pending).toEqual([{ ...confirm, text: "2.2 GB" }])

    h.emit("op.done", { teamID: TEAM, opID: OP, state: "waiting", summary: { lines: [] }, undoable: true, pending: 1 })
    expect(h.store.state.ops[OP]!.done).toEqual({
      state: "waiting",
      summary: { lines: [] },
      undoable: true,
      pending: 1,
    })
    await h.settle()
    expect(h.methods().filter((method) => method === "team.get")).toHaveLength(2)
    // The registry is the source: its answer has no pending confirm any more.
    expect(h.store.state.teams[TEAM]!.pending).toEqual([])
  })

  test("a team whose records went (the undo of the enable that made it) leaves the store when it reloads", async () => {
    const h = harness()
    await ready(h.store)
    expect(h.store.isTeamMain(MAIN)).toBe(true)
    h.answers["team.get"] = () => ({ team: null, areas: [], waiting: {}, op: null, pending: [] })
    h.emit("op.done", { teamID: TEAM, opID: OP, state: "done", summary: { lines: [] }, undoable: false, pending: 0 })
    await h.settle()
    expect(h.store.state.teams).toEqual({})
    expect(h.store.isTeamMain(MAIN)).toBe(false)
    expect(h.store.teamOfDirectory(HOME)).toBeUndefined()
  })

  test("notices: newest first, at most 50, and listeners hear them", async () => {
    const h = harness()
    const kinds: string[] = []
    h.store.on("notice", (event) => kinds.push(event.data.kind))
    for (const index of Array.from({ length: 51 }, (_, value) => value))
      h.emit("notice", { teamID: TEAM, kind: "paths.added", text: `notice ${index}`, data: { n: index } })
    h.emit("notice", { teamID: TEAM, areaID: INVENTORY, kind: "drift.repaired", text: "last" })
    expect(h.store.state.notices).toHaveLength(50)
    expect(h.store.state.notices[0]).toMatchObject({
      teamID: TEAM,
      areaID: INVENTORY,
      kind: "drift.repaired",
      text: "last",
    })
    expect(h.store.state.notices[1]).toMatchObject({ text: "notice 50", data: { n: 50 } })
    expect(kinds).toHaveLength(52)
  })

  test("notices: 닫기 removes one; a team's account move ends its account wait", () => {
    const h = harness()
    h.emit("notice", { teamID: TEAM, kind: "account.waiting", text: "wait", data: { account: "ChatGPT 01" } })
    h.emit("notice", { teamID: OFF_TEAM, kind: "account.waiting", text: "other wait" })
    h.emit("notice", { teamID: TEAM, areaID: INVENTORY, kind: "rotation.done", text: "rotated" })
    h.emit("notice", { teamID: TEAM, kind: "account.moved", text: "moved", data: { account: "ChatGPT 02", n: 1 } })
    expect(h.store.state.notices.map((item) => item.text)).toEqual(["moved", "rotated", "other wait"])
    h.store.dismiss(h.store.state.notices[1]!.id)
    expect(h.store.state.notices.map((item) => item.text)).toEqual(["moved", "other wait"])
    h.store.dismiss("unknown")
    expect(h.store.state.notices).toHaveLength(2)
  })

  test("notices the service holds open come with team.get: a window opened later shows them, once", async () => {
    const h = harness()
    const repair = {
      id: "repair:ar_inventory-ui:pr_01JB0000000000000000000001:acc_03",
      at: 500,
      areaID: INVENTORY,
      kind: "preset.repair",
      text: "'Claude 리뷰'(이)가 ChatGPT 03(을)를 써서 인벤토리 화면 리뷰(을)를 메인 모델로 돌려요",
      data: { account: "ChatGPT 03" },
    }
    h.answers["team.get"] = () => ({ ...get(7), notices: [repair] })
    await h.store.load(HOME)
    expect(h.store.state.notices).toEqual([expect.objectContaining({ ...repair, teamID: TEAM })])
    // The same repair heard as an event, and another answer: still one.
    h.emit("notice", { teamID: TEAM, areaID: INVENTORY, kind: "preset.repair", text: repair.text })
    await h.store.load(HOME)
    expect(h.store.state.notices.filter((item) => item.kind === "preset.repair")).toHaveLength(1)
    // Closed by the user: the next answer does not bring it back.
    for (const item of [...h.store.state.notices]) h.store.dismiss(item.id)
    await h.store.load(HOME)
    expect(h.store.state.notices).toEqual([])
  })

  test("integration.changed keeps the latest integration per area; an older one's change stays out", () => {
    const h = harness()
    const changed = (areaID: string, integrationID: string, state: string) =>
      h.emit("integration.changed", { teamID: TEAM, areaID, integrationID, state })
    const seen: string[] = []
    h.store.on("integration.changed", (event) => seen.push(`${event.data.integrationID}:${event.data.state}`))
    changed(INVENTORY, "ig_01JB0000000000000000000003", "conflict")
    expect(h.store.integrationOf(TEAM, INVENTORY)).toEqual({
      teamID: TEAM as never,
      areaID: INVENTORY as never,
      integrationID: "ig_01JB0000000000000000000003" as never,
      state: "conflict",
    })
    // A later integration of the area replaces it; the same one moves on.
    changed(INVENTORY, "ig_01JB0000000000000000000005", "running")
    changed(INVENTORY, "ig_01JB0000000000000000000005", "done")
    // The undo of the earlier one does not bring it back.
    changed(INVENTORY, "ig_01JB0000000000000000000003", "undone")
    expect(h.store.integrationOf(TEAM, INVENTORY)).toMatchObject({
      integrationID: "ig_01JB0000000000000000000005",
      state: "done",
    })
    // Each area (and the same area id of another team) keeps its own.
    changed(SAVE, "ig_01JB0000000000000000000001", "waiting")
    h.emit("integration.changed", {
      teamID: OFF_TEAM,
      areaID: INVENTORY,
      integrationID: "ig_01JB0000000000000000000009",
      state: "failed",
    })
    expect(h.store.integrationOf(TEAM, SAVE)?.state).toBe("waiting")
    expect(h.store.integrationOf(TEAM, INVENTORY)?.integrationID).toBe("ig_01JB0000000000000000000005" as never)
    expect(h.store.integrationOf(OFF_TEAM, INVENTORY)?.state).toBe("failed")
    expect(h.store.integrationOf(TEAM, "ar_unknown")).toBeUndefined()
    // Listeners hear every change, the older one's too.
    expect(seen).toHaveLength(6)
  })

  test("team.get notices restore open notices after a reload; one the service no longer holds leaves", async () => {
    const open = (kind: string, areaID: string, text: string, data: Record<string, string | number>) => ({
      id: `${kind}:${areaID}`,
      at: 600,
      areaID,
      kind,
      text,
      data,
    })
    const broken = open("area.broken", SAVE, "'save-v3' 폴더를 찾을 수 없어요", { why: "missing" })
    const waiting = open("integration.waiting", INVENTORY, "반영을 기다려요", { folder: HOME, why: "dirty" })
    const links = open("link.copy.dirty", INVENTORY, "링크 사본 1개", { count: 1 })
    // A window opened after the events (a reload): the open ones come with team.get.
    const h = harness()
    h.answers["team.get"] = () => ({ ...get(7), notices: [broken, waiting, links] })
    await ready(h.store)
    expect(h.store.state.notices.map((item) => item.kind).toSorted()).toEqual([
      "area.broken",
      "integration.waiting",
      "link.copy.dirty",
    ])
    expect(h.store.state.notices.find((item) => item.kind === "area.broken")).toMatchObject({
      teamID: TEAM,
      areaID: SAVE,
      data: { why: "missing" },
    })
    // A one-shot notice heard now, and the stopped area's notice heard again as an event.
    h.emit("notice", { teamID: TEAM, areaID: INVENTORY, kind: "branch.followed", text: "따라갔어요" })
    h.emit("notice", { teamID: TEAM, areaID: SAVE, kind: "area.broken", text: broken.text, data: broken.data })
    expect(h.store.state.notices.filter((item) => item.kind === "area.broken")).toHaveLength(1)
    // The folder is back and the integration went on: the service holds only the link copies open.
    h.answers["team.get"] = () => ({ ...get(8), notices: [links] })
    await h.store.load(HOME)
    expect(h.store.state.notices.map((item) => item.kind).toSorted()).toEqual(["branch.followed", "link.copy.dirty"])
    // An older service without open notices changes nothing.
    h.answers["team.get"] = () => get(9)
    await h.store.load(HOME)
    expect(h.store.state.notices).toHaveLength(2)
  })
})
