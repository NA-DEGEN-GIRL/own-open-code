// The own-web copy of the `own.team` contract against the real definition (06 §2.7, `@own/protocol/rpc-team`): id,
// scope table, metadata keys, control-location routing, error mapping, event parsing, and catalog keys for every
// literal the protocol can send (status words, notices, errors, op kinds, result-card lines, outbox reasons,
// integration states, team update groups, decision record sources). T3: the user's own reorganizations decode as
// proposals and the area menu offers each only with its feature and scope; every reorganization op has words on the
// proposal card; the own.remote errors of the large-file tool upload have words. Area peers (동료): the feature and
// limits are the protocol's, the forms send inputs the definition takes, and every refusal has its own words. 담당
// 대화 바꾸기: the features, the scope and the inputs of `area.seat` and the owner note, and every refusal's words.
import { describe, expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { OwnTeam } from "@own/protocol/rpc-team"
import { OwnTeamRouting } from "@own/protocol/rpc-team-routing"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Schema } from "effect"
import { createSignal } from "solid-js"
import { ALL_SCOPES, OwnRpcError, type OwnScope } from "@/data/rpc"
import {
  createTeamRpc,
  TEAM_EVENT_PREFIX,
  TEAM_ID,
  TEAM_META,
  TEAM_SCOPE,
  teamEvent,
  type TeamMethod,
} from "@/data/team-rpc"
import { errorText, peerErrorText, seatErrorText, type TeamText } from "./model"
import { discussDraft, proposalCard } from "./reorg"
import { teamKo, teamText } from "./strings"
import { ROLE_TEMPLATES } from "./templates"
import {
  adoptAreaProposal,
  areaActions,
  convertProposal,
  convertTarget,
  mergeProposal,
  moveCandidates,
  moveProposal,
  newAreaProposal,
  noteForm,
  OWNER_NOTE_MAX,
  PATHS_MAX,
  pathsForm,
  PEER_LABEL_MAX,
  PEER_ROLE_MAX,
  peerAddInput,
  peerEditInput,
  peerForm,
  recreateProposal,
  renameProposal,
  retireProposal,
  ROLE_MAX,
  roleLeft,
  roleMax,
  splitProposal,
} from "./view-model"

const keys = new Set(Object.keys(teamKo))
const camel = (name: string) => name.replace(/[-_.]([a-z])/g, (_, letter: string) => letter.toUpperCase())
const ko = (key: Parameters<typeof teamText.text>[1], params?: Record<string, string | number>) =>
  teamText.text("ko", key, params)

describe("own.team client contract", () => {
  test("TEAM_SCOPE equals OwnTeam.MethodScope; the id and the method list match the definition", () => {
    expect(TEAM_ID).toBe(OwnTeam.ID)
    expect(TEAM_ID).toBe(OwnTeamRouting.ID)
    expect(TEAM_SCOPE).toEqual(OwnTeam.MethodScope)
    expect(Object.keys(TEAM_SCOPE).sort()).toEqual(Object.keys(OwnTeam.Definition.methods).sort())
  })

  test("metadata keys are the ones own.team writes", () => {
    expect(TEAM_META).toEqual({
      session: OwnTeam.SESSION_META,
      dispatch: OwnTeam.DISPATCH_META,
      update: OwnTeam.UPDATE_META,
      moved: OwnTeam.MOVED_META,
    })
  })

  test("every method goes to the control location under own.team; RPC errors become OwnRpcError", async () => {
    const sent: Array<{ rpcID: string; method: string; location: { directory: string } }> = []
    let fail: unknown
    const client = {
      rpc: {
        call: async (request: { rpcID: string; method: string; location: { directory: string } }) => {
          sent.push(request)
          if (fail) throw fail
          return { output: { teams: [] } }
        },
      },
    } as unknown as OpenCodeClient
    const rpc = createTeamRpc({ client: () => client, control: async () => "C:/control", scopes: () => ALL_SCOPES })
    const methods = Object.keys(TEAM_SCOPE) as TeamMethod[]
    expect(methods.every((method) => OwnTeamRouting.MethodLocation[method] === "control")).toBe(true)
    // SAFETY: the fake transport ignores the input; only routing is checked here.
    for (const method of methods) await rpc.call(method, {} as never)
    expect(sent.map((request) => request.method)).toEqual(methods)
    expect(sent.every((request) => request.rpcID === "own.team" && request.location.directory === "C:/control")).toBe(
      true,
    )

    fail = { _tag: "RpcError", type: "busy", message: "busy", data: { teamID: "tm_0123456789ab", kind: "enable" } }
    const error = await rpc.call("team.list", {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OwnRpcError)
    expect(error).toMatchObject({ type: "busy", data: { kind: "enable" } })
    fail = { _tag: "RpcInternalError", type: "rpc.invalid_output", message: "bad" }
    expect(await rpc.call("team.list", {}).catch((caught: unknown) => caught)).toMatchObject({
      type: "rpc.invalid_output",
    })
    fail = new TypeError("Failed to fetch")
    expect(await rpc.call("team.list", {}).catch((caught: unknown) => caught)).toBeInstanceOf(TypeError)
  })

  test("a gateway device without local sees confirms, push and settings writes as view-only", async () => {
    const calls: unknown[] = []
    const client = {
      rpc: {
        call: async (request: unknown) => {
          calls.push(request)
          return { output: {} }
        },
      },
    }
    const [scopes, setScopes] = createSignal<ReadonlySet<OwnScope>>(new Set(["read", "prompt", "switch"]))
    const rpc = createTeamRpc({
      client: () => client as unknown as OpenCodeClient,
      control: async () => "C:/control",
      scopes,
    })
    expect(rpc.allowed("area.pause")).toBe(true)
    expect(rpc.allowed("area.main")).toBe(true)
    expect(rpc.allowed("enable")).toBe(false)
    for (const method of ["op.confirm", "integration.push.plan", "integration.push.execute", "settings.set"] as const) {
      expect(rpc.scope(method)).toBe("local")
      expect(rpc.allowed(method)).toBe(false)
    }
    await expect(rpc.call("settings.set", {} as never)).rejects.toMatchObject({ type: "own.scope_denied" })
    expect(calls).toHaveLength(0)
    setScopes(ALL_SCOPES)
    expect(rpc.allowed("op.confirm")).toBe(true)
  })

  test("events: every declared name parses; other names and ids are ignored", () => {
    for (const name of Object.keys(OwnTeam.Events)) {
      const event = teamEvent({
        type: `${TEAM_EVENT_PREFIX}${name}`,
        created: 7,
        location: { directory: "C:/control" },
        data: { eventId: "01J0000000000000000000000A" },
      } as unknown as OpenCodeEvent)
      expect(event?.name).toBe(name as never)
      expect(event?.created).toBe(7)
    }
    expect(teamEvent({ type: "rpc.own.team.unknown", data: {} } as unknown as OpenCodeEvent)).toBeUndefined()
    expect(teamEvent({ type: "rpc.own.accounts.notice", data: {} } as unknown as OpenCodeEvent)).toBeUndefined()
    expect(teamEvent({ type: "rpc.own.team.notice" } as unknown as OpenCodeEvent)).toBeUndefined()
  })
})

describe("the strings cover every literal the protocol sends", () => {
  test("status words, broken reasons and Main 멈춤", () => {
    for (const kind of OwnTeam.StatusKind.literals.filter((kind) => kind !== "broken"))
      expect(keys.has(`own.team.status.${camel(kind)}`), kind).toBe(true)
    for (const why of OwnTeam.BrokenReason.literals)
      expect(keys.has(`own.team.status.broken.${camel(why)}`), why).toBe(true)
  })

  test("notices (area.broken also by reason)", () => {
    for (const kind of OwnTeam.NoticeKind.literals) expect(keys.has(`own.team.notice.${camel(kind)}`), kind).toBe(true)
    for (const why of OwnTeam.BrokenReason.literals)
      expect(keys.has(`own.team.notice.broken.${camel(why)}`), why).toBe(true)
  })

  test("result cards: op titles, area changes, skip reasons, suggestions, step states", () => {
    for (const kind of OwnTeam.OpKind.literals) expect(keys.has(`own.team.card.title.${camel(kind)}`), kind).toBe(true)
    for (const change of OwnTeam.AreaChange.literals)
      expect(keys.has(`own.team.card.area.${camel(change)}`), change).toBe(true)
    for (const why of OwnTeam.SkipReason.literals) expect(keys.has(`own.team.card.skipped.${why}`), why).toBe(true)
    for (const kind of OwnTeam.Suggestion.fields.kind.literals)
      expect(keys.has(`own.team.card.suggest.${kind}`), kind).toBe(true)
    for (const state of OwnTeam.StepState.literals)
      expect(keys.has(`own.team.step.state.${camel(state)}`), state).toBe(true)
  })

  test("outbox reasons, request sources and kinds", () => {
    for (const why of OwnTeam.WaitReason.literals) expect(keys.has(`own.team.outbox.why.${why}`), why).toBe(true)
    for (const from of OwnTeam.Dispatch.fields.from.literals)
      expect(keys.has(`own.team.outbox.from.${from}`), from).toBe(true)
    for (const kind of OwnTeam.Dispatch.fields.kind.literals)
      expect(keys.has(`own.team.outbox.kind.${kind}`), kind).toBe(true)
  })

  test("result card lines: every SummaryLine kind has its words, T2's heavy and pushed lines included", () => {
    const lines: { readonly [K in OwnTeam.SummaryLine["kind"]]: ReadonlyArray<string> } = {
      area: OwnTeam.AreaChange.literals.map((change) => `own.team.card.area.${camel(change)}`),
      unadopted: ["own.team.card.unadopted", "own.team.action.adopt"],
      r4: ["own.team.card.r4", "own.team.action.removeArea"],
      suggest: OwnTeam.Suggestion.fields.kind.literals.map((kind) => `own.team.card.suggest.${kind}`),
      // The judge's own sentences.
      notes: [],
      prepare: ["own.team.card.prepare"],
      "home-changes": ["own.team.card.homeChanges"],
      "old-git": ["own.team.card.oldGit"],
      skipped: OwnTeam.SkipReason.literals.map((why) => `own.team.card.skipped.${why}`),
      cancelled: ["own.team.card.cancelled"],
      queued: ["own.team.card.clearQueued"],
      "lock-kept": ["own.team.card.lockKept"],
      ref: ["own.team.card.kept"],
      paths: ["own.team.card.paths.added", "own.team.card.paths.released", "own.team.card.paths.kept"],
      account: ["own.team.card.account"],
      integrated: ["own.team.card.integrated", "own.team.card.newerSkipped"],
      heavy: ["own.team.card.heavy"],
      pushed: ["own.team.card.pushed", "own.team.card.openPr"],
    }
    expect(Object.keys(lines).sort()).toEqual(
      OwnTeam.SummaryLine.members.map((member) => member.fields.kind.literal).sort(),
    )
    for (const [kind, list] of Object.entries(lines))
      for (const key of list) expect(keys.has(key), `${kind}: ${key}`).toBe(true)
  })

  test("integration cards: every state, waiting reason and failure (06 §7, §9.7)", () => {
    const waiting: { readonly [K in NonNullable<OwnTeam.Integration["waiting"]>["why"]]: true } = {
      dirty: true,
      "in-use": true,
      "in-progress": true,
      outside: true,
    }
    const states: { readonly [K in OwnTeam.IntegrationState]: ReadonlyArray<string> } = {
      running: ["own.team.integrate.running", "own.team.integrate.checks"],
      waiting: [
        ...Object.keys(waiting).map((why) => `own.team.integrate.waiting.${camel(why)}`),
        "own.team.action.retryIntegrate",
      ],
      conflict: ["own.team.integrate.conflict", "own.team.integrate.conflictFiles"],
      failed: [
        ...OwnTeam.IntegrationFailure.literals.map((why) => `own.team.integrate.failed.${why}`),
        "own.team.action.log",
      ],
      done: [
        "own.team.card.integrated",
        "own.team.integrate.already",
        "own.team.integrate.undoMain",
        "own.team.push.action",
        "own.team.push.prAction",
      ],
      undone: ["own.team.integrate.undone"],
    }
    expect(Object.keys(states).sort()).toEqual([...OwnTeam.IntegrationState.literals].sort())
    for (const [state, list] of Object.entries(states))
      for (const key of list) expect(keys.has(key), `${state}: ${key}`).toBe(true)
  })

  test("team update summaries: every group own.team's lines count in, the T2 event groups included", () => {
    for (const kind of [...OwnTeamText.COUNTS, ...OwnTeamText.EVENT_COUNTS])
      expect(keys.has(`own.team.update.count.${kind}`), kind).toBe(true)
    for (const state of OwnTeam.IntegrationState.literals) {
      const kind = OwnTeamText.countOf(OwnTeamText.integrationLine({ area: "a", state }))
      expect(kind !== undefined && keys.has(`own.team.update.count.${kind}`), state).toBe(true)
    }
  })

  test("decision records: who wrote them", () => {
    for (const source of OwnTeam.DecisionRecord.fields.source.literals)
      expect(keys.has(`own.team.decide.source.${source}`), source).toBe(true)
  })

  test("every declared error type has its own words", () => {
    const generic = ko("own.team.error.internalError")
    for (const type of Object.keys(OwnTeam.errors).filter((type) => type !== "internal_error")) {
      expect(keys.has(`own.team.error.${camel(type)}`), type).toBe(true)
      expect(errorText(ko, new OwnRpcError(type, "m", {})), type).not.toBe(generic)
    }
  })
})

describe("T3 reorganizations (06 §2.7, §8.2, §9.4)", () => {
  const decodeProposal = Schema.decodeUnknownSync(OwnTeam.Proposal)
  const decodeArea = Schema.decodeUnknownSync(OwnTeam.AreaView)
  const AREA = "ar_inventory-ui"
  const SAVE = "ar_save-v3"
  const area = (fields: Record<string, unknown> = {}) =>
    decodeArea({
      id: AREA,
      teamID: "tm_0123456789ab",
      name: "inventory-ui",
      goal: "",
      origin: "created",
      state: "active",
      branch: "inventory-ui",
      gitDir: "D:/#Projects/own-open-code/.git/worktrees/inventory-ui",
      base: { sha: "a".repeat(40), at: 1 },
      directory: "D:/own-open-code-team/inventory-ui",
      shape: "code",
      cone: { extra: {}, kept: {} },
      owner: { sessionID: "ses_owner", previous: [], attached: true },
      preset: "builtin:codex",
      paused: false,
      status: { kind: "idle", at: 1, text: "" },
      handoff: null,
      ...fields,
    })
  const every = (method: OwnTeam.MethodName) => OwnTeam.MethodScope[method] !== undefined
  const device = (method: OwnTeam.MethodName) =>
    OwnTeam.MethodScope[method] === "read" || OwnTeam.MethodScope[method] === "prompt"
  const ITEMS = {
    split: "reorg.split",
    merge: "reorg.merge",
    retire: "reorg.retire",
    convert: "reorg.convert",
    move: "reorg.move",
  } as const

  test("the T3 reorganization features are the protocol's", () => {
    for (const feature of [...Object.values(ITEMS), "cleanup"] as const)
      expect(OwnTeam.Feature.literals).toContain(feature)
  })

  test("the user's own reorganizations decode as proposals of one op each", () => {
    const proposals = {
      rename: renameProposal(AREA, " 화면 ", ""),
      new: newAreaProposal("Inventory UI", "", ["inventory-ui"]),
      split: splitProposal(AREA, "  Save v3 ", " 저장 형식 ", ["inventory-ui", "save-v3"]),
      merge: mergeProposal(AREA, SAVE),
      retire: retireProposal(AREA),
      convert: convertProposal(AREA, "full"),
      move: moveProposal("ses_user", AREA),
    }
    expect(Object.keys(proposals).sort()).toEqual(
      OwnTeam.ReorgOp.members.map((member) => member.fields.op.literal).sort(),
    )
    for (const [op, proposal] of Object.entries(proposals)) {
      expect(decodeProposal(proposal), op).toEqual(proposal)
      expect(
        proposal.ops?.map((item): string => item.op),
        op,
      ).toEqual([op])
    }
    expect(proposals.split.ops).toEqual([
      { op: "split", area: AREA, slug: "save-v3-2", name: "Save v3", goal: "저장 형식" },
    ])
    expect(splitProposal(AREA, "결제 서버", "", []).ops).toEqual([
      { op: "split", area: AREA, slug: "area", name: "결제 서버" },
    ])
    expect(proposals.merge.ops).toEqual([{ op: "merge", area: AREA, from: SAVE }])
    expect(proposals.move.ops).toEqual([{ op: "move", sessionID: "ses_user", area: AREA }])
    // A suggestion names an area by its slug; the service takes ids, slugs and names alike.
    expect(retireProposal("inventory-ui").ops).toEqual([{ op: "retire", area: "inventory-ui" }])
  })

  test("each T3 item of the area menu needs its own feature and the admin scope of reorg.apply", () => {
    for (const item of Object.keys(ITEMS) as Array<keyof typeof ITEMS>) {
      const feature = ITEMS[item]
      const only = areaActions({ area: area(), has: (value) => value === feature, allowed: every })
      expect(only, item).toContain(item)
      // No other T3 item rides along.
      expect(
        only.filter((value) => value in ITEMS && value !== item),
        item,
      ).toEqual([])
      expect(areaActions({ area: area(), has: (value) => value !== feature, allowed: every }), item).not.toContain(item)
      // A gateway device has no admin scope: reorg.apply is not offered there.
      expect(areaActions({ area: area(), has: () => true, allowed: device }), item).not.toContain(item)
    }
    expect(OwnTeam.MethodScope["reorg.apply"]).toBe("admin")
  })

  test("menu order: 반영하기, 이름 바꾸기, 나누기, 영역 묶기, 파일 모양 바꾸기, 대화 옮기기, 영역 끝내기, 팀에서 빼기, 자세히", () => {
    expect(areaActions({ area: area({ origin: "adopted" }), has: () => true, allowed: every }).slice(-9)).toEqual([
      "integrate",
      "rename",
      "split",
      "merge",
      "convert",
      "move",
      "retire",
      "unadopt",
      "details",
    ])
  })

  test("영역 묶기 needs another area; 파일 모양 바꾸기 large-file folders; a stopped area keeps only 끝내기", () => {
    const all = () => true
    expect(areaActions({ area: area(), has: all, allowed: every, peers: 0 })).not.toContain("merge")
    expect(areaActions({ area: area(), has: all, allowed: every, peers: 2 })).toContain("merge")
    expect(areaActions({ area: area({ shape: "plain" }), has: all, allowed: every })).not.toContain("convert")
    expect([convertTarget("code"), convertTarget("full"), convertTarget("plain")]).toEqual(["full", "code", undefined])
    const missing = area({
      state: "broken",
      broken: { why: "missing", at: 2 },
      status: { kind: "broken", at: 2, text: "" },
    })
    const menu = areaActions({ area: missing, has: all, allowed: every })
    expect(menu).toContain("retire")
    for (const item of ["split", "merge", "convert", "move"] as const) expect(menu).not.toContain(item)
    expect(areaActions({ area: area({ state: "retired" }), has: all, allowed: every })).toContain("retire")
  })

  test("다시 만들기 (8.8): only a missing folder's menu, right before 영역 끝내기, with reorg.new and reorg.apply", () => {
    const all = () => true
    const broken = (why: OwnTeam.BrokenReason) =>
      area({ state: "broken", broken: { why, at: 2 }, status: { kind: "broken", at: 2, text: "" } })
    const menu = areaActions({ area: broken("missing"), has: all, allowed: every })
    expect(menu.slice(menu.indexOf("recreate"), menu.indexOf("recreate") + 2)).toEqual(["recreate", "retire"])
    for (const why of ["identity", "branch-gone", "shared-branch"] as const)
      expect(areaActions({ area: broken(why), has: all, allowed: every }), why).not.toContain("recreate")
    expect(areaActions({ area: area(), has: all, allowed: every })).not.toContain("recreate")
    expect(areaActions({ area: area({ state: "retired" }), has: all, allowed: every })).not.toContain("recreate")
    // The feature of a new area, and the admin scope a gateway device does not have.
    const without = areaActions({ area: broken("missing"), has: (value) => value !== "reorg.new", allowed: every })
    expect(without).not.toContain("recreate")
    expect(areaActions({ area: broken("missing"), has: all, allowed: device })).not.toContain("recreate")
  })

  test("다시 만들기 is a new area from the area's record, with its name and purpose (8.2, 8.8)", () => {
    const made = recreateProposal({ id: OwnTeam.AreaID.make(SAVE), name: "저장 형식", goal: " 새 저장 형식 " })
    expect(decodeProposal(made)).toEqual(made)
    expect(made.ops).toEqual([{ op: "new", slug: "save-v3", name: "저장 형식", goal: "새 저장 형식", from: "save-v3" }])
    expect(recreateProposal({ id: OwnTeam.AreaID.make(SAVE), name: "cl-x", goal: "" }).ops).toEqual([
      { op: "new", slug: "save-v3", name: "cl-x", from: "save-v3" },
    ])
  })

  test("대화 옮기기 offers root conversations of the project outside the area, never the team's own", () => {
    const row = (id: string, fields: Record<string, unknown> = {}) => ({
      id,
      title: id,
      projectID: "prj_own",
      directory: "D:/own-open-code",
      updated: 1,
      ...fields,
    })
    const places: Record<string, { previous: boolean }> = {
      ses_main: { previous: false },
      ses_owner_b: { previous: false },
      ses_old_owner: { previous: true },
    }
    const offered = moveCandidates({
      area: area(),
      projectID: "prj_own",
      sessions: [
        row("ses_user", { updated: 5 }),
        row("ses_inside", { directory: "d:\\own-open-code-team\\INVENTORY-UI\\src" }),
        row("ses_child", { parentID: "ses_user" }),
        row("ses_archived", { archived: 3 }),
        row("ses_other", { projectID: "prj_other" }),
        row("ses_main"),
        row("ses_owner_b"),
        row("ses_old_owner", { updated: 9, title: undefined }),
      ],
      place: (sessionID) => places[sessionID],
    })
    expect(offered).toEqual([
      { sessionID: "ses_old_owner", directory: "D:/own-open-code" },
      { sessionID: "ses_user", directory: "D:/own-open-code", title: "ses_user" },
    ])
  })

  test("every reorganization op and every adopted or created area has words on the proposal card", () => {
    const words: TeamText = (key, params) => teamText.text("ko", key, params)
    const proposal: OwnTeam.Proposal = {
      version: 1,
      areas: [
        { slug: "cl-x", name: "cl-x", adopt: { worktree: "D:/own-open-code/.worktrees/cl-x" } },
        { slug: "docs", name: "문서", create: { from: "main" } },
      ],
      ops: [
        ...(newAreaProposal("결제", "", []).ops ?? []),
        ...(renameProposal(AREA, "인벤토리", "").ops ?? []),
        ...(splitProposal(AREA, "결제 서버", "", []).ops ?? []),
        ...(mergeProposal(AREA, SAVE).ops ?? []),
        ...(retireProposal(SAVE).ops ?? []),
        ...(convertProposal(AREA, "code").ops ?? []),
        ...(moveProposal("ses_user", AREA).ops ?? []),
      ],
    }
    const card = proposalCard(words, {
      proposal,
      plan: { steps: [], rejected: [] },
      name: (value) => (value === AREA ? "인벤토리 화면" : value === SAVE ? "저장" : value),
    })
    const lines = card.lines.map((line) => line.text)
    expect(lines).toEqual([
      "cl-x 폴더를 팀에 넣어요",
      "새 영역 '문서'를 만들어요",
      "새 영역 '결제'를 만들어요",
      "'인벤토리 화면' 영역 이름을 '인벤토리'로 바꿔요",
      "'인벤토리 화면'에서 '결제 서버' 영역을 나눠요",
      "'저장'을 '인벤토리 화면'에 묶어요",
      "'저장' 영역을 끝내요 · 되돌릴 수 없어요",
      "'인벤토리 화면'을 가벼운 폴더로 바꿔요",
      "대화를 '인벤토리 화면' 영역으로 옮겨요",
    ])
    for (const line of lines) expect(line, line).not.toMatch(/\{\w+\}/)
    expect(card.runs).toBe(false)
  })

  test("팀 메인과 상의하기 drafts the hint and the lines still shown; a suggestion closed with 무시 stays out", () => {
    const words: TeamText = (key, params) => teamText.text("ko", key, params)
    const card = proposalCard(words, {
      proposal: {
        version: 1,
        ops: renameProposal(AREA, "인벤토리", "").ops,
        suggest: [{ kind: "retire", area: SAVE, why: "반영 끝남" }],
      },
      plan: { steps: [], rejected: [] },
      name: (value) => (value === AREA ? "인벤토리 화면" : value === SAVE ? "저장" : value),
    })
    const suggestion = card.lines.findIndex((line) => line.retire !== undefined)
    expect(card.lines[suggestion]?.text).toBe("제안: '저장' 영역을 끝낼 수 있어요(반영 끝남)")
    expect(discussDraft(words, { lines: card.lines, ignored: [suggestion], hint: "  묶어 줘 " })).toBe(
      "내가 바란 것: 묶어 줘\n팀 구성 다시 보기에서 이런 제안을 받았어:\n- '인벤토리 화면' 영역 이름을 '인벤토리'로 바꿔요\n이대로 할지, 어떻게 바꿀지 같이 정하자.",
    )
    expect(discussDraft(words, { lines: card.lines, ignored: [], hint: "" })).toContain(
      "- 제안: '저장' 영역을 끝낼 수 있어요(반영 끝남)",
    )
  })

  test("the own.remote errors of the large-file tool upload have words (06 §4.13)", () => {
    const generic = ko("own.team.error.internalError")
    const errors = Object.keys(OwnRemote.Definition.methods["hosts.tools.ensure"].errors).filter(
      (type) => type !== "internal_error",
    )
    expect(errors.length).toBeGreaterThan(0)
    for (const type of errors) {
      expect(keys.has(`own.team.error.${camel(type)}`), type).toBe(true)
      expect(errorText(ko, new OwnRpcError(type, "m", {})), type).not.toBe(generic)
    }
  })
})

describe("사용자가 정하는 영역 (06 §2.7, §9.4, 2026-10-26)", () => {
  const ids = { teamID: "tm_0123456789ab", areaID: "ar_inventory-ui" }
  const valid = async (method: OwnTeam.MethodName, input: unknown) =>
    (await OwnTeam.Definition.methods[method].input["~standard"].validate(input)).issues === undefined

  test("area.edit is the protocol's admin method with its feature; the role and the mark are what it takes", async () => {
    expect(TEAM_SCOPE["area.edit"]).toBe("admin")
    expect(OwnTeamRouting.MethodScope["area.edit"]).toBe("admin")
    expect(OwnTeam.Feature.literals).toContain("area-edit")
    expect(await valid("area.edit", { ...ids, goal: "몬스터 그림" })).toBe(true)
    expect(await valid("area.edit", { ...ids, userMade: false })).toBe(true)
  })

  test("영역 만들기's 만들 곳 asks area.create.check (2026-10-27): admin like the dialog, a V6 name in", async () => {
    expect(TEAM_SCOPE["area.create.check"]).toBe("admin")
    expect(await valid("area.create.check", { teamID: ids.teamID, slug: "monster-assets" })).toBe(true)
    expect(await valid("area.create.check", { teamID: ids.teamID, slug: "Monster Assets" })).toBe(false)
  })

  test("영역 만들기 sends a proposal reorg.apply takes, a new folder or an existing one", async () => {
    const made = newAreaProposal("몬스터 에셋", "몬스터 그림", [], {
      slug: "monster-assets",
      main: { providerID: "own-claude-1", id: "claude-opus-4-8" },
      harness: { id: "pi", prompt: "reference" },
      userMade: true,
    })
    expect(await valid("reorg.apply", { teamID: ids.teamID, proposal: made })).toBe(true)
    const joined = adoptAreaProposal("시뮬레이션", "", "D:/own-open-code/.worktrees/sim", [])
    expect(await valid("reorg.apply", { teamID: ids.teamID, proposal: joined })).toBe(true)
  })

  test("the role templates fit an area's role (V12: `ROLE_MAX`, 1,000 characters) in both languages", () => {
    expect(ROLE_MAX).toBe(1_000)
    for (const [label, role] of ROLE_TEMPLATES)
      for (const locale of ["ko", "en"] as const) {
        expect(teamText.text(locale, label).length, label).toBeGreaterThan(0)
        expect(teamText.text(locale, role).length, role).toBeLessThanOrEqual(ROLE_MAX)
      }
  })

  test("a role counts characters as the protocol does (`String.length` of the trimmed text) and is never cut (2026-11-14)", async () => {
    expect(roleLeft("  몬스터 그림  ")).toBe(ROLE_MAX - 6)
    // 1,000 Hangul fit and save; one more is 1 over, which the protocol refuses too.
    const full = "가".repeat(ROLE_MAX)
    expect(roleLeft(full)).toBe(0)
    expect(roleLeft(`${full}가`)).toBe(-1)
    expect(await valid("area.edit", { ...ids, goal: full })).toBe(true)
    expect(await valid("area.edit", { ...ids, goal: `${full}가` })).toBe(false)
    // An emoji is two UTF-16 units, as `Schema.isMaxLength` counts it.
    expect(roleLeft("🙂")).toBe(ROLE_MAX - 2)
    // An own.team without `direct` cut a role to 200 without a word: the fields say 200 there.
    expect(roleMax((feature) => feature === "direct")).toBe(ROLE_MAX)
    expect(roleMax(() => false)).toBe(200)
    expect(roleMax(undefined)).toBe(ROLE_MAX)
    expect(roleLeft("가".repeat(201), roleMax(() => false))).toBe(-1)
    expect(ko("own.team.createArea.roleOver", { n: 1 })).toBe("1자 넘었어요")
    expect(ko("own.team.createArea.roleLeft", { n: 1 })).toBe("1자 남음")
    // The role fields have no native limit, so a pasted role is not cut where nobody sees it.
    for (const file of ["area-menu.tsx", "create-area.tsx", "reorg.tsx"]) {
      const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text()
      expect(source, file).not.toMatch(/maxLength=\{(ROLE_MAX|1_000)\}/)
    }
    // The split form's new role had the old 200 (큰 파일 폴더's reason field keeps the protocol's 200).
    expect(await Bun.file(new URL("./reorg.tsx", import.meta.url)).text()).not.toContain("maxLength={200}")
  })
})

describe("큰 파일 폴더 가져오기 (06 §4.6, 2026-11-14: 64 folders)", () => {
  const ids = { teamID: "tm_0123456789ab", areaID: "ar_inventory-ui" }
  const valid = async (input: unknown) =>
    (await OwnTeam.Definition.methods["area.paths"].input["~standard"].validate(input)).issues === undefined

  test("one folder per line, trimmed, blank lines and repeats left out; up to the protocol's 64, never cut", async () => {
    expect(PATHS_MAX).toBe(OwnTeam.PATHS_MAX)
    expect(pathsForm(" Assets/Art \r\n\nAssets/Art\nAssets/Audio  \n")).toEqual({
      dirs: ["Assets/Art", "Assets/Audio"],
      ok: true,
    })
    expect(pathsForm(" \n ").ok).toBe(false)
    const lines = (n: number) => Array.from({ length: n }, (_, index) => `Assets/${index}`).join("\n")
    const most = pathsForm(lines(PATHS_MAX))
    expect(most).toMatchObject({ ok: true })
    expect(most.dirs).toHaveLength(PATHS_MAX)
    expect(await valid({ ...ids, add: most.dirs })).toBe(true)
    // 65 lines: all kept, so the form says how many and does not send.
    const over = pathsForm(lines(PATHS_MAX + 1))
    expect(over.dirs).toHaveLength(PATHS_MAX + 1)
    expect(over.ok).toBe(false)
    expect(await valid({ ...ids, add: over.dirs })).toBe(false)
    expect(ko("own.team.paths.over", { max: PATHS_MAX, n: 65 })).toBe("한 번에 64개까지예요(지금 65개)")
  })
})

describe("담당 대화 바꾸기 (06 §6.8, 2026-11-12)", () => {
  const ids = { teamID: "tm_0123456789ab", areaID: "ar_inventory-ui" }
  const takes = async (method: "area.seat" | "area.edit", input: unknown) =>
    (await OwnTeam.Definition.methods[method].input["~standard"].validate(input)).issues === undefined

  test("the features and the admin scope are the protocol's; a seat move is its own op with its own card", () => {
    for (const feature of ["seat", "owner-note"] as const) expect(OwnTeam.Feature.literals).toContain(feature)
    expect(OwnTeam.MethodScope["area.seat"]).toBe("admin")
    expect(TEAM_SCOPE["area.seat"]).toBe("admin")
    expect(OwnTeam.OpKind.literals).toContain("seat")
    expect(OwnTeam.OwnerEnded.literals).toContain("seat")
    expect(ko("own.team.card.title.seat")).toBe("담당 대화를 바꿨어요")
    expect(ko("own.team.card.area.seated", { area: "inventory-ui" })).toBe(
      "'inventory-ui' 담당이 다른 대화로 바뀌었어요",
    )
  })

  test("바꾸기 sends the area and the conversation; the owner note goes through `area.edit`", async () => {
    expect(await takes("area.seat", { ...ids, sessionID: "ses_next" })).toBe(true)
    expect(await takes("area.seat", ids)).toBe(false)
    // Nine Hangul syllables and two spaces: 11 of the 1,024 characters.
    const form = noteForm("  설계와 구현을 맡아요 ")
    expect(form).toEqual({ note: "설계와 구현을 맡아요", left: 1_013, ok: true })
    expect(await takes("area.edit", { ...ids, note: form.note })).toBe(true)
    // An empty note removes it; one over 1,024 characters cannot be saved (characters, not bytes: 2026-11-14).
    expect(noteForm("  ")).toEqual({ note: "", left: OwnTeam.OWNER_NOTE_MAX, ok: true })
    expect(await takes("area.edit", { ...ids, note: "" })).toBe(true)
    expect(noteForm("가".repeat(1_024))).toMatchObject({ left: 0, ok: true })
    expect(noteForm("가".repeat(1_026))).toMatchObject({ left: -2, ok: false })
    expect(OWNER_NOTE_MAX).toBe(OwnTeam.OWNER_NOTE_MAX)
  })

  test("the confirm is one sentence that names the conversation and what it runs on", () => {
    expect(ko("own.team.seat.confirm", { area: "inventory-ui", name: "새 설계", model: "GPT-6 Astra · high" })).toBe(
      "'inventory-ui' 영역의 담당을 '새 설계' 대화(GPT-6 Astra · high)로 바꿀까요?",
    )
    expect(ko("own.team.seat.confirmPlain", { area: "inventory-ui", name: "새 설계" })).toBe(
      "'inventory-ui' 영역의 담당을 '새 설계' 대화로 바꿀까요?",
    )
    expect(ko("own.team.action.cancel")).toBe("취소")
    expect(ko("own.team.action.change")).toBe("바꾸기")
    // The way back names the conversation that held the seat, with the particle its last sound takes.
    expect(ko("own.team.seat.back", { name: "재고 화면" })).toBe("다시 재고 화면으로")
    expect(ko("own.team.seat.back", { name: "새 설계" })).toBe("다시 새 설계로")
    expect(ko("own.team.seat.back", { name: "오늘 할 일" })).toBe("다시 오늘 할 일로")
    // A title cut short keeps the particle of its last kept sound.
    expect(ko("own.team.seat.back", { name: "재고 화면을 다시 그리는…" })).toBe("다시 재고 화면을 다시 그리는…으로")
    expect(ko("own.team.seat.back", { name: "새 설계를 다시 그려 보기…" })).toBe("다시 새 설계를 다시 그려 보기…로")
    // A peer is told what the move costs it: the way back does not make it a peer again (second pass, 2026-11-13).
    expect(ko("own.team.seat.peerLeaves")).toBe(
      "이 대화는 동료에서 빠지고 동료 역할 글도 지워져요. 담당을 다시 바꿔도 동료로 돌아오지 않으니, 그때는 동료로 다시 등록하세요",
    )
    // Main 멈춤 after a move: what it does, not a claim that a request waits now.
    expect(ko("own.team.seat.paused", { area: "inventory-ui" })).toBe(
      "'inventory-ui' 영역은 메인 멈춤이 켜져 있어요. 끄기 전에는 메인의 요청이 새 담당에게 가지 않아요",
    )
    expect(ko("own.team.talkers.title")).toBe("팀과 이야기하는 대화")
    expect(ko("own.team.talkers.owner")).toBe("담당")
    expect(ko("own.team.peer.word")).toBe("동료")
    expect(ko("own.team.seat.noteEdit")).toBe("메모 바꾸기…")
    expect(ko("own.team.seat.note")).toBe("담당 메모")
    // The note is the seat's, not the conversation's: a move keeps it, and the form says so.
    expect(ko("own.team.seat.notePlaceholder")).toBe("이 영역의 담당이 팀에서 맡은 일을 적어요")
    expect(ko("own.team.seat.noteHint")).toBe("담당 대화를 바꿔도 메모는 남아요. 동료가 있을 때만 팀의 대화들에 보여요")
  })

  test("every reason a conversation cannot take the seat has its words; the team company's other plan says what to do", () => {
    type Why = (typeof OwnTeam.errors)["seat_invalid"]["Type"]["why"]
    const words: Readonly<Record<Why, string>> = {
      child: "하위 대화는 담당이 될 수 없어요",
      main: "팀 메인은 영역 담당이 될 수 없어요",
      owner: "이미 이 영역의 담당이에요",
      elsewhere: "이 영역의 폴더에 있는 대화만 담당이 될 수 있어요",
      account: "이 대화의 계정을 확인할 수 없어요. 모델을 고른 뒤 다시 해 주세요",
      unknown: "이 대화의 계정을 지금 확인할 수 없어요. 잠시 뒤 다시 해 주세요",
      note: "담당 메모는 1,024자 이하로 적어요",
    }
    for (const [why, text] of Object.entries(words))
      expect(seatErrorText(ko, new OwnRpcError("seat_invalid", "m", { why })), why).toBe(text)
    // A reason a newer service adds still reads as a refusal of the seat.
    expect(seatErrorText(ko, new OwnRpcError("seat_invalid", "m", { why: "later" }))).toBe(
      "이 대화는 담당이 될 수 없어요",
    )
    expect(seatErrorText(ko, new OwnRpcError("same_company_subscription", "m", { accountID: "acc_02" }))).toBe(
      "이 대화는 팀과 같은 회사의 다른 구독 계정을 써요. 담당으로 두려면 그 대화의 계정을 바꾸세요",
    )
    expect(seatErrorText(ko, new OwnRpcError("team_off", "m", {}))).toBe(ko("own.team.error.teamOff"))
    expect(seatErrorText(ko, new OwnRpcError("broken", "m", {}))).toBe(ko("own.team.error.broken"))
  })
})

describe("area peers (동료, 06 §2.7, §9.4, 2026-10-09)", () => {
  const ids = { teamID: "tm_0123456789ab", areaID: "ar_inventory-ui" }
  const takes = async (method: "area.peer.add" | "area.peer.edit", input: unknown) =>
    (await OwnTeam.Definition.methods[method].input["~standard"].validate(input)).issues === undefined

  test("the feature, the admin scope and the limits are the protocol's", () => {
    expect(OwnTeam.Feature.literals).toContain("peers")
    for (const method of ["area.peer.add", "area.peer.edit", "area.peer.remove"] as const)
      expect(OwnTeam.MethodScope[method], method).toBe("admin")
    expect(PEER_LABEL_MAX).toBe(OwnTeam.PEER_LABEL_MAX)
    expect(PEER_ROLE_MAX).toBe(OwnTeam.PEER_ROLE_MAX)
    expect(ko("own.team.error.peerInvalid.limit")).toContain(String(OwnTeam.PEER_MAX))
  })

  test("동료 추가… creates and 동료로 등록… registers, both as `area.peer.add` inputs the definition takes", async () => {
    const created = peerAddInput(ids, peerForm(" 리뷰어 ", " 바뀐 코드를 읽습니다 "))
    expect(created).toEqual({ ...ids, create: { label: "리뷰어", role: "바뀐 코드를 읽습니다" } })
    const registered = peerAddInput(ids, peerForm("리뷰어", ""), "ses_user")
    expect(registered).toEqual({ ...ids, sessionID: "ses_user", label: "리뷰어", role: "" })
    expect(await takes("area.peer.add", created)).toBe(true)
    expect(await takes("area.peer.add", registered)).toBe(true)
  })

  test("역할 바꾸기… sends only what changed, and nothing when nothing did", async () => {
    const peer = { key: "reviewer", label: "리뷰어", role: "읽기" }
    expect(peerEditInput(ids, peer, { label: "리뷰어", role: "읽기" })).toBeUndefined()
    const role = peerEditInput(ids, peer, { label: "리뷰어", role: "읽고 고치기" })
    expect(role).toEqual({ ...ids, key: "reviewer", role: "읽고 고치기" })
    expect(peerEditInput(ids, peer, { label: "검토", role: "읽기" })).toEqual({
      ...ids,
      key: "reviewer",
      label: "검토",
    })
    expect(await takes("area.peer.edit", role)).toBe(true)
  })

  test("the form: a name of 1 to 40 characters, a role of at most 1,024 characters with the characters left or over", () => {
    expect(peerForm("  리뷰   담당 ", " 역할 ")).toEqual({ label: "리뷰 담당", role: "역할", left: 1_022, ok: true })
    expect(peerForm(" ", "").ok).toBe(false)
    expect(peerForm("a".repeat(41), "").ok).toBe(false)
    expect(peerForm("a".repeat(40), "").ok).toBe(true)
    // Characters, as the protocol counts them (2026-11-14; UTF-8 bytes before): 1,024 Hangul fit.
    expect(peerForm("리뷰어", "가".repeat(1_023))).toMatchObject({ left: 1, ok: true })
    expect(peerForm("리뷰어", "가".repeat(1_026))).toMatchObject({ left: -2, ok: false })
    expect(ko("own.team.peer.roleLeft", { n: 1 })).toBe("1자 남음")
    expect(ko("own.team.peer.roleOver", { n: 2 })).toBe("1,024자를 2자 넘었어요")
  })

  test("every reason a conversation cannot be a peer has its words; the team company's other plan says what to do", () => {
    type Why = (typeof OwnTeam.errors)["peer_invalid"]["Type"]["why"]
    const words: Readonly<Record<Why, string>> = {
      child: "하위 대화는 동료로 등록하지 않아요",
      main: "팀 메인은 동료가 될 수 없어요",
      owner: "영역 담당 대화는 동료가 될 수 없어요",
      previous: "전에 담당이던 대화는 동료가 될 수 없어요",
      peer: "이미 동료로 등록된 대화예요",
      elsewhere: "이 영역의 폴더에 있는 대화만 동료로 등록할 수 있어요",
      label: "이름이 비었거나 이 영역의 다른 동료와 같아요",
      role: "역할은 1,024자 이하로 적으세요",
      limit: "한 영역의 동료는 4개까지예요",
    }
    for (const [why, text] of Object.entries(words))
      expect(errorText(ko, new OwnRpcError("peer_invalid", "m", { why })), why).toBe(text)
    // A reason a newer service adds still reads as a refusal of the peer.
    expect(errorText(ko, new OwnRpcError("peer_invalid", "m", { why: "later" }))).toBe("동료로 둘 수 없는 대화예요")
    expect(peerErrorText(ko, new OwnRpcError("same_company_subscription", "m", { accountID: "acc_02" }))).toBe(
      "이 대화는 팀 메인과 같은 회사의 다른 구독 계정을 써요. 동료로 쓰려면 그 대화의 계정을 바꾸세요",
    )
    // Elsewhere the team's words stand; other peer failures read as every team failure does.
    expect(errorText(ko, new OwnRpcError("same_company_subscription", "m", {}))).toBe(
      ko("own.team.error.sameCompanySubscription"),
    )
    expect(peerErrorText(ko, new OwnRpcError("team_off", "m", {}))).toBe(ko("own.team.error.teamOff"))
  })

  test("a main request to a peer names it in the outbox", () => {
    expect(OwnTeam.Dispatch.fields.to).toBeDefined()
    expect(ko("own.team.outbox.to", { label: "리뷰어" })).toBe("→ 동료 리뷰어")
    expect(teamText.text("en", "own.team.outbox.to", { label: "Reviewer" })).toBe("→ Peer Reviewer")
  })
})
