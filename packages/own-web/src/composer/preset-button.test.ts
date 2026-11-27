// The composer's preset controls (07 §7.3, §5.1, §5.3, §2.6, §2.9, §8.1 원격; 06 §9.5, §10.1): the group of the main,
// the menu's rows (the main's group only, ★ first, `평소대로` always, 최근), the preset in effect and a new session's
// start preset, a team session's R4 dimming, the running badge, the heavy and ultra banner, when ultra asks with the
// cost dialog, the start preset bound after `session.create`, and the strings. Remote servers (T3, 07 §8.1 원격, PG2
// remote UI half): a remote session lists that server's `presets.list` (its mirror of this PC's presets) and applies
// through that server and its own.team, edits open this PC's editor, there is no repair mark, and an older server
// without the mirror lists `평소대로` only with a neutral line. Real OwnStores and RPC clients over fake transports;
// every account, login and model is fake.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account, type Estimate } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import { createTeamRpc, TEAM_ID } from "@/data/team-rpc"
import { presetPlace } from "@/presets/model"
import {
  bannerOf,
  errorKey,
  keepsEffort,
  liveCounts,
  mainGroup,
  menuRows,
  pinnedAccounts,
  presetByID,
  presetInEffect,
  presetName,
  recentRows,
  roleKey,
  runningBadge,
  startPreset,
  teamClash,
  ultraNeedsDialog,
} from "@/presets/session-view"
import { presetsText } from "@/presets/strings"
import { subagentEn, subagentKo, subagentText } from "@/subagent/strings"
import {
  applyPreset,
  applyStartPreset,
  chooseStartPreset,
  menuParts,
  PresetBanner,
  PresetButton,
  PresetMenu,
} from "./preset-button"

const tick = () => new Promise((resolve) => setTimeout(resolve, 60))
const SRC = path.join(import.meta.dir, "..")
/** Source without comments, so spec words in comments are not taken for code. */
const code = (source: string) => source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")

// ---- fixtures ----

const LOGIN_01 = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
const CHATGPT_01 = Account.ID.make("acc_chatgpt01")
const CHATGPT_03 = Account.ID.make("acc_chatgpt03")
const CLAUDE = Account.ID.claudeSlot
const DEEPSEEK = Account.ID.make("acc_deepseek")

function account(
  id: Account.ID,
  kind: Account.View["kind"],
  providerID: string,
  extra: Partial<Account.View> = {},
): Account.View {
  return {
    id,
    kind,
    label: id.slice(4),
    shortLabel: id.slice(4, 6),
    color: "indigo",
    providerID: Provider.ID.make(providerID),
    billing: kind === "ds" ? "prepaid" : "subscription",
    status: "ready",
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    connection: { type: kind === "ds" ? "key" : "oauth" },
    ...extra,
  }
}

const ACCOUNTS: ReadonlyArray<Account.View> = [
  account(CHATGPT_01, "codex", "own-codex-aaaa", { identity: { login: LOGIN_01 } }),
  account(CHATGPT_03, "codex", "own-codex-cccc", { identity: { login: "sha256:3" } }),
  account(CLAUDE, "claude-sub", "anthropic"),
  account(DEEPSEEK, "ds", "own-ds-eeee"),
]
const BY_ID = Object.fromEntries(ACCOUNTS.map((item) => [item.id, item]))
const lookup: Preset.Lookup = (id) => BY_ID[id]
const accountOf = (providerID: string) => ACCOUNTS.find((item) => item.providerID === providerID)

const pin = (account: string, model: string) => Schema.decodeUnknownSync(Preset.Target)({ pin: { account, model } })

const REVIEW = Preset.ID.make("pr_01JB0000000000000000000001")
const ACTIVE = Preset.ID.make("pr_01JB0000000000000000000002")
const PAID = Preset.ID.make("pr_01JB0000000000000000000003")
const CLAUDE_GROUP = Preset.ID.make("pr_01JB0000000000000000000004")

function preset(id: Preset.ID, name: string, extra: Partial<Preset.Info> = {}): Preset.Listed {
  return { ...Preset.builtin("codex"), id, name, revision: 1, status: "ok", ...extra }
}

const REVIEW_PRESET = preset(REVIEW, "Claude 리뷰", {
  workers: {
    mode: "by-role",
    roles: { "own-review": { targets: [pin(CLAUDE, "claude-opus-5-5")], effort: "inherit" } },
  },
  delegation: "when-useful",
})
const ACTIVE_PRESET = preset(ACTIVE, "적극", { delegation: "active" })
const PAID_PRESET = preset(PAID, "딥시크 탐색", {
  workers: { mode: "by-role", roles: { explore: { targets: [pin(DEEPSEEK, "deepseek-flash")], effort: "inherit" } } },
  delegation: "on-request",
})
const CODEX_VIEW: Preset.GroupView = {
  group: "codex",
  defaultModel: null,
  presets: [{ ...Preset.builtin("codex"), status: "ok" }, REVIEW_PRESET, ACTIVE_PRESET, PAID_PRESET],
  star: REVIEW,
}
const CLAUDE_VIEW: Preset.GroupView = {
  group: "claude-sub",
  defaultModel: null,
  presets: [
    { ...Preset.builtin("claude-sub"), status: "ok" },
    {
      ...Preset.builtin("claude-sub"),
      id: CLAUDE_GROUP,
      name: "ChatGPT 리뷰",
      revision: 1,
      status: "ok",
      workers: {
        mode: "by-role",
        roles: { "own-review": { targets: [pin(CHATGPT_03, "gpt-6-sol")], effort: "inherit" } },
      },
    },
  ],
}

function sessionView(extra: Partial<Preset.SessionView> = {}): Preset.SessionView {
  return {
    binding: { presetID: REVIEW, group: "codex", revision: 1, appliedAt: 1, entryHash: null },
    preset: REVIEW_PRESET,
    resolution: null,
    caps: Preset.CAPS,
    counts: { running: 1, message: 2, session: 4 },
    spend: 0,
    ...extra,
  }
}

// ---- the main's group and the menu ----

describe("the main's group (07 P-D2)", () => {
  test("an own account's kind, a local provider's `local:<id>`, nothing for a built-in provider", () => {
    expect(mainGroup({ providerID: "own-codex-aaaa" }, accountOf)).toBe("codex")
    expect(mainGroup({ providerID: "anthropic" }, accountOf)).toBe("claude-sub")
    expect(mainGroup({ providerID: "ollama" }, accountOf)).toBe("local:ollama")
    expect(mainGroup({ providerID: "opencode" }, accountOf)).toBeUndefined()
    expect(mainGroup(undefined, accountOf)).toBeUndefined()
  })
})

describe("menu rows (07 §7.3)", () => {
  test("the group's presets only: ★ first, `평소대로` always", () => {
    const rows = menuRows("codex", CODEX_VIEW, false)
    expect<unknown>(rows.map((item) => item.id)).toEqual([REVIEW, "builtin:codex", ACTIVE, PAID])
    expect(rows.every((item) => item.group === "codex")).toBe(true)
    // An older service lists nothing: `평소대로` alone.
    expect<unknown>(menuRows("ds", undefined, false).map((item) => item.id)).toEqual(["builtin:ds"])
  })

  test("a remote server without this PC's presets lists `평소대로` only (07 §8.1 원격)", () => {
    expect<unknown>(menuRows("codex", CODEX_VIEW, true).map((item) => item.id)).toEqual(["builtin:codex"])
  })

  test("최근: this group's recent presets, newest first, without the one in use, at most three", () => {
    const recent = [PAID, CLAUDE_GROUP, REVIEW, PAID, Preset.builtinID("codex"), ACTIVE]
    expect<unknown>(recentRows("codex", CODEX_VIEW, recent, REVIEW).map((item) => item.id)).toEqual([
      PAID,
      "builtin:codex",
      ACTIVE,
    ])
    expect<unknown>(recentRows("codex", CODEX_VIEW, recent, REVIEW, 1).map((item) => item.id)).toEqual([PAID])
  })

  test("`평소대로` in the current language; a stored preset by its own name", () => {
    expect(presetName(Preset.builtin("codex"), presetsText("en", "own.preset.builtin"))).toBe("As usual")
    expect(presetName(REVIEW_PRESET, "평소대로")).toBe("Claude 리뷰")
  })
})

describe("the preset in effect and a new session's start preset (07 §5.1, §5.3)", () => {
  test("the service's view while it is of the main's group; else the binding, the group's ★ or `평소대로`", () => {
    expect(presetInEffect("codex", sessionView(), CODEX_VIEW).id).toBe(REVIEW)
    const bound = sessionView({ preset: null, binding: { ...sessionView().binding!, presetID: PAID } })
    expect(presetInEffect("codex", bound, CODEX_VIEW).id).toBe(PAID)
    // The main moved to the Claude group: that group's ★, here none, so its `평소대로`.
    expect<string>(presetInEffect("claude-sub", sessionView(), CLAUDE_VIEW).id).toBe("builtin:claude-sub")
    expect(presetInEffect("codex", undefined, CODEX_VIEW).id).toBe(REVIEW)
    expect<string>(presetInEffect("ds", undefined, undefined).id).toBe("builtin:ds")
  })

  test("★ by default; `마지막에 쓴 것` continues the group's newest recent preset only while it is light", () => {
    expect(startPreset("codex", { newSession: "star", recent: [PAID] }, CODEX_VIEW, lookup)).toBe(REVIEW)
    // The newest recent of this group is `평소대로` (light): it continues.
    const builtin = Preset.builtinID("codex")
    expect(
      startPreset("codex", { newSession: "last-light", recent: [CLAUDE_GROUP, builtin] }, CODEX_VIEW, lookup),
    ).toBe(builtin)
    // `적극적으로` and a paid target are heavy: the group's ★ instead.
    expect(startPreset("codex", { newSession: "last-light", recent: [ACTIVE] }, CODEX_VIEW, lookup)).toBe(REVIEW)
    expect(startPreset("codex", { newSession: "last-light", recent: [PAID] }, CODEX_VIEW, lookup)).toBe(REVIEW)
    expect<string>(startPreset("ds", { newSession: "last-light", recent: [] }, undefined, lookup)).toBe("builtin:ds")
  })
})

describe("a team session's R4 (07 §5.1, §5.3 step 2; 06 §9.5)", () => {
  const team: Preset.Team = { teamID: "tm_0123456789ab", role: "owner", accounts: [CHATGPT_01], pinned: [] }

  test("a preset pinning another ChatGPT subscription is dimmed with that account; none without a team", () => {
    const claudePreset = CLAUDE_VIEW.presets![1]!
    expect(teamClash(claudePreset, CLAUDE, lookup, team)).toBe(CHATGPT_03)
    expect(teamClash(claudePreset, CLAUDE, lookup, undefined)).toBeUndefined()
    expect(teamClash(REVIEW_PRESET, CHATGPT_01, lookup, team)).toBeUndefined()
  })

  test("the worst case finds every area's preset across groups, `평소대로` by its id", () => {
    const groups = { codex: CODEX_VIEW, "claude-sub": CLAUDE_VIEW }
    expect(presetByID(groups, ACTIVE)?.delegation).toBe("active")
    expect(presetByID(groups, CLAUDE_GROUP)?.group).toBe("claude-sub")
    expect<unknown>(presetByID({}, "builtin:local:ollama")).toEqual(Preset.builtin("local:ollama"))
    expect(presetByID(groups, "builtin:nope")).toBeUndefined()
    expect(presetByID(groups, "pr_01JB0000000000000000000009")).toBeUndefined()
  })
})

// ---- badge, banner, ultra ----

describe("`하위 에이전트 2/3 실행 중 · 이 메시지 5개` (07 §7.3)", () => {
  test("only while the preset delegates actively or ultra is on; the cap in force from the service", () => {
    expect(runningBadge(sessionView(), undefined)).toBeUndefined()
    expect(runningBadge(undefined, { running: 1 })).toBeUndefined()
    expect(runningBadge(sessionView({ preset: ACTIVE_PRESET }), undefined)).toEqual({ running: 1, max: 3, message: 2 })
    const ultra = sessionView({
      binding: { ...sessionView().binding!, ultra: { before: null } },
      caps: Preset.caps(REVIEW_PRESET, true),
    })
    expect(runningBadge(ultra, { running: 4, message: 7 })).toEqual({ running: 4, max: 8, message: 7 })
    // Without the root's messages the read count stands.
    expect(runningBadge(ultra, { running: 4 })).toEqual({ running: 4, max: 8, message: 2 })
  })

  test("live counts: running children, and children started since the root's last user message", () => {
    const children = [
      { created: 100, running: false },
      { created: 200, running: true },
      { created: 300, running: true },
    ]
    expect(liveCounts(children, 150)).toEqual({ running: 2, message: 2 })
    expect(liveCounts(children, undefined)).toEqual({ running: 2, message: undefined })
    expect(liveCounts([], 1)).toEqual({ running: 0, message: 0 })
  })
})

describe("the heavy and ultra banner (07 §5.1, §2.9)", () => {
  test("ultra: the main account, then every subscription a target runs on; paid when a target costs money", () => {
    const ultra = sessionView({ binding: { ...sessionView().binding!, ultra: { before: null } } })
    expect(bannerOf(ultra, REVIEW_PRESET, CHATGPT_01, lookup)).toEqual({
      kind: "ultra",
      accounts: [CHATGPT_01, CLAUDE],
      paid: false,
    })
    expect(bannerOf(ultra, PAID_PRESET, CHATGPT_01, lookup)).toEqual({
      kind: "ultra",
      accounts: [CHATGPT_01],
      paid: true,
    })
  })

  test("a heavy preset (`적극적으로`, a paid target) shows the line; a light one shows none", () => {
    expect(bannerOf(sessionView(), ACTIVE_PRESET, CHATGPT_01, lookup)).toEqual({
      kind: "heavy",
      active: true,
      paid: false,
    })
    expect(bannerOf(sessionView(), PAID_PRESET, CHATGPT_01, lookup)).toEqual({
      kind: "heavy",
      active: false,
      paid: true,
    })
    expect(bannerOf(sessionView(), REVIEW_PRESET, CHATGPT_01, lookup)).toBeUndefined()
    expect(bannerOf(undefined, Preset.builtin("codex"), CHATGPT_01, lookup)).toBeUndefined()
  })

  test("pinned accounts follow the worker mode and leave out the main and local targets", () => {
    expect(pinnedAccounts(REVIEW_PRESET)).toEqual([CLAUDE])
    expect(pinnedAccounts({ workers: { ...REVIEW_PRESET.workers, mode: "same" } })).toEqual([])
    expect(pinnedAccounts({ workers: { mode: "single", single: pin("local:ollama", "qwen3"), roles: {} } })).toEqual([])
    expect(pinnedAccounts(REVIEW_PRESET, CLAUDE)).toEqual([])
  })
})

describe("ultra (07 §2.9)", () => {
  const estimate = (variantOnly: Estimate.Result["variantOnly"]) => ({ variantOnly }) as unknown as Estimate.Result

  test("the cost dialog only when the effort changes off the effort-update path", () => {
    expect(ultraNeedsDialog({ estimate: null })).toBe(false)
    expect(ultraNeedsDialog({ estimate: estimate({ preservesCache: true, reason: "message_effort_update" }) })).toBe(
      false,
    )
    expect(ultraNeedsDialog({ estimate: estimate({ preservesCache: false, reason: "route_unsupported" }) })).toBe(true)
    expect(ultraNeedsDialog({ estimate: estimate(null) })).toBe(true)
  })

  test("Claude keeps its effort (and offers `xhigh로 올리기`); every other group follows its rule", () => {
    expect(keepsEffort("claude-sub")).toBe(true)
    expect(keepsEffort("anth")).toBe(true)
    expect(keepsEffort("codex")).toBe(false)
    expect(keepsEffort("local:ollama")).toBe(false)
    expect(keepsEffort(undefined)).toBe(false)
  })
})

describe("roles and errors", () => {
  test("preset roles by their names; other agents have none", () => {
    expect(roleKey("own-review")).toBe("own.preset.role.review")
    expect(roleKey("explore")).toBe("own.preset.role.explore")
    expect(roleKey("build")).toBeUndefined()
    expect(roleKey(undefined)).toBeUndefined()
  })

  test("apply errors in the editor's words", () => {
    expect(errorKey("same_company_subscription")).toBe("own.preset.err.sameCompany")
    expect(errorKey("preset_wrong_group")).toBe("own.preset.err.wrongGroup")
    expect(errorKey("own.scope_denied")).toBe("own.preset.page.readOnly")
    expect(errorKey("internal_error")).toBeUndefined()
    expect(errorKey(undefined)).toBeUndefined()
  })
})

// ---- the start preset after session.create, and remote servers (real OwnStores) ----

interface Call {
  readonly rpcID: string
  readonly method: string
  readonly input: unknown
  readonly directory?: string
}

function transport(answers: Record<string, unknown>) {
  const calls: Call[] = []
  const client = {
    rpc: {
      call: async (input: { rpcID: string; method: string; input?: unknown; location?: { directory: string } }) => {
        calls.push({
          rpcID: input.rpcID,
          method: input.method,
          input: input.input,
          directory: input.location?.directory,
        })
        const entry = answers[input.method]
        const answer = typeof entry === "function" ? await entry(input.input) : entry
        if (answer instanceof Error) throw answer
        return { output: answer ?? {} }
      },
    },
  }
  // SAFETY: the stores, the RPC clients and `applyStartPreset` only reach `rpc.call` here.
  return { calls, client: client as unknown as OpenCodeClient }
}

const applied = (input: { presetID: string }) => ({
  binding: { presetID: input.presetID, group: "codex", revision: 1, appliedAt: 1, entryHash: null },
  resolution: null,
  entry: "unchanged",
  dryRun: false,
})

function setup(
  settings: { newSession: Preset.NewSession; recent: Preset.ID[] },
  answers: Record<string, unknown> = {},
) {
  const { calls, client } = transport({
    health: { version: "local", buildId: "b", guard: "ok", controlDir: "D:\\ctl" },
    "accounts.list": { revision: 1, accounts: ACCOUNTS },
    "quota.snapshot": { windows: [] },
    "policy.get": { policy: { defaults: { byKind: {} } } },
    "presets.list": { groups: [CODEX_VIEW, CLAUDE_VIEW], ...settings, ultraCaps: "recommended" },
    "session.preset.apply": applied,
    ...answers,
  })
  return createRoot((dispose) => {
    const bus = createEventBus()
    const rpc = createOwnRpc({
      client: () => client,
      routing: { control: async () => "D:\\ctl", sessionDirectory: () => undefined },
      scopes: () => ALL_SCOPES,
    })
    const own = createOwnStore({ rpc, bus, client: () => client, sessionDirectory: () => undefined })
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    bus.flush()
    return { runtime: { kind: "local" as const, rpc, own }, calls, dispose }
  })
}

/**
 * An SSH host (04 §12.6): accounts from this PC's store (`registry`), its own `presets.list` (07 §8.1 원격), its own
 * own.accounts session methods and its own own.team.
 */
function host(local: ReturnType<typeof setup>, presets: unknown) {
  const { calls, client } = transport({
    health: { version: "remote", buildId: "b", guard: "ok", controlDir: "/home/u/ctl", mode: "remote" },
    "session.binding": { bindings: [] },
    "presets.list": presets,
    "session.preset.apply": applied,
    "area.preset": (input: { areaID: string; presetID: string }) => ({
      areaID: input.areaID,
      presetID: input.presetID,
    }),
  })
  return createRoot((dispose) => {
    const bus = createEventBus()
    const rpc = createOwnRpc({
      client: () => client,
      routing: { control: async () => "/home/u/ctl", sessionDirectory: () => "/home/u/p" },
      scopes: () => ALL_SCOPES,
    })
    const own = createOwnStore({
      rpc,
      bus,
      client: () => client,
      sessionDirectory: () => "/home/u/p",
      registry: () => local.runtime.own,
    })
    const team = {
      rpc: createTeamRpc({ client: () => client, control: async () => "/home/u/ctl", scopes: () => ALL_SCOPES }),
    }
    bus.publish({ type: "server.connected", id: "h", data: {} } as OpenCodeEvent)
    bus.flush()
    return { runtime: { kind: "ssh" as const, rpc, own, team }, calls, dispose }
  })
}

const methods = (calls: ReadonlyArray<Call>) => calls.map((call) => call.method)
/** Writes of presets (`presets.set`, `presets.remove`, `presets.defaults.set`, `presets.suggest`): never from here. */
const presetWrites = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => call.method.startsWith("presets.") && call.method !== "presets.list")
const applies = (calls: ReadonlyArray<Call>) => calls.filter((call) => call.method === "session.preset.apply")
const TARGET = { providerID: "own-codex-aaaa", id: Model.ID.make("gpt-6-astra") }

/** The host's mirror of this PC's `presets.json`, one save behind: no `딥시크 탐색` yet, and ★ `적극`. */
const MIRROR = {
  groups: [
    { ...CODEX_VIEW, presets: CODEX_VIEW.presets!.filter((item) => item.id !== PAID), star: ACTIVE },
    CLAUDE_VIEW,
  ],
  newSession: "star",
  recent: [REVIEW],
  ultraCaps: "recommended",
}
/** An older host (before T3): every group has `평소대로` only. */
const OLDER = {
  groups: [
    { group: "codex", defaultModel: null, presets: [{ ...Preset.builtin("codex"), status: "ok" }] },
    { group: "claude-sub", defaultModel: null, presets: [{ ...Preset.builtin("claude-sub"), status: "ok" }] },
  ],
  newSession: "star",
  recent: [],
  ultraCaps: "recommended",
}

describe("a new session starts on its start preset (07 §5.1 새 세션)", () => {
  test("after session.create: `session.preset.apply` with the group's ★, at the session's folder", async () => {
    const { runtime, calls, dispose } = setup({ newSession: "star", recent: [] })
    await tick()
    await applyStartPreset({
      runtime,
      local: runtime,
      serverKey: "local",
      sessionID: "ses_new1",
      target: TARGET,
      directory: "D:\\proj",
    })
    expect(applies(calls)).toEqual([
      {
        rpcID: "own.accounts",
        method: "session.preset.apply",
        input: { sessionID: "ses_new1", presetID: REVIEW },
        directory: "D:\\proj",
      },
    ])
    dispose()
  })

  test("the new-session screen's pick wins once; the next session starts on the start preset again", async () => {
    const { runtime, calls, dispose } = setup({ newSession: "last-light", recent: [Preset.builtinID("codex")] })
    await tick()
    chooseStartPreset("local", "codex", ACTIVE)
    const input = { runtime, local: runtime, serverKey: "local", target: TARGET, directory: "D:\\proj" }
    await applyStartPreset({ ...input, sessionID: "ses_new2" })
    await applyStartPreset({ ...input, sessionID: "ses_new3" })
    expect(applies(calls).map((call) => call.input)).toEqual([
      { sessionID: "ses_new2", presetID: ACTIVE },
      { sessionID: "ses_new3", presetID: "builtin:codex" },
    ])
    dispose()
  })

  test("a failing service never holds the first prompt back", async () => {
    const failing = setup({ newSession: "star", recent: [] }, { "session.preset.apply": new Error("not_implemented") })
    await tick()
    await expect(
      applyStartPreset({
        runtime: failing.runtime,
        local: failing.runtime,
        serverKey: "local",
        sessionID: "ses_new4",
        target: TARGET,
        directory: "D:\\proj",
      }),
    ).resolves.toBeUndefined()
    expect(applies(failing.calls)).toHaveLength(1)
    failing.dispose()
  })
})

describe("where a session reads presets (07 §8.1 원격, T3)", () => {
  const LOCAL = { codex: CODEX_VIEW, "claude-sub": CLAUDE_VIEW }
  const older = Object.fromEntries(OLDER.groups.map((view) => [view.group, view])) as Record<string, Preset.GroupView>

  test("this PC's list for a local session; a remote server's own list while it mirrors this PC's presets", () => {
    expect(presetPlace(undefined, LOCAL)).toBe("local")
    expect(presetPlace({ codex: { ...CODEX_VIEW, presets: [REVIEW_PRESET] } }, LOCAL)).toBe("mirror")
    // With no stored preset on either side there is nothing to tell apart, and nothing missing.
    expect(presetPlace(older, { codex: { group: "codex", defaultModel: null } })).toBe("mirror")
  })

  test("a remote server listing none of this PC's presets (an older build, or no mirror yet) has `평소대로` only", () => {
    expect(presetPlace(older, LOCAL)).toBe("builtin")
    expect(presetPlace({}, LOCAL)).toBe("builtin")
  })

  test("the menu: repairs only from this PC's list; an older remote has `평소대로`, no editing and the neutral line", () => {
    expect(menuParts("local", false)).toEqual({
      builtinOnly: false,
      repairs: true,
      editing: true,
      note: ["own.subagent.preset.free"],
    })
    expect(menuParts("local", true).note).toEqual(["own.subagent.preset.free", "own.subagent.preset.area"])
    // A remote list has no repairs (07 §7.3: no dot on a remote server's session); editing is this PC's editor.
    expect(menuParts("mirror", true)).toEqual({
      builtinOnly: false,
      repairs: false,
      editing: true,
      note: ["own.subagent.preset.free", "own.subagent.preset.area"],
    })
    expect(menuParts("builtin", false)).toEqual({
      builtinOnly: true,
      repairs: false,
      editing: false,
      note: ["own.subagent.preset.remoteBuiltin"],
    })
  })
})

describe("a remote server's session (07 §8.1 원격, §7.4; 06 §10.1; PG2 remote UI)", () => {
  test("the host's own `presets.list` loads once asked, then on every resync; this PC's stay this PC's", async () => {
    const local = setup({ newSession: "star", recent: [] })
    await tick()
    const remote = host(local, MIRROR)
    await tick()
    // Until a screen asks, the host is asked for health only (accounts and limits come from this PC, 04 §12.6).
    expect(methods(remote.calls)).toEqual(["health"])
    await remote.runtime.own.refreshPresets()
    expect(methods(remote.calls)).toEqual(["health", "presets.list"])
    const groups = remote.runtime.own.state.presetGroups
    expect(presetPlace(groups, local.runtime.own.state.presetGroups)).toBe("mirror")
    // The host's rows: its ★ first, without the preset its mirror does not have yet.
    expect<unknown>(menuRows("codex", groups.codex, false).map((item) => item.id)).toEqual([
      ACTIVE,
      "builtin:codex",
      REVIEW,
    ])
    expect<unknown>(remote.runtime.own.state.presetSettings.recent).toEqual([REVIEW])
    // This PC's store is untouched; a resync of the host reads its list again.
    expect(local.runtime.own.state.presetGroups.codex?.star).toBe(REVIEW)
    await remote.runtime.own.resync()
    expect(methods(remote.calls).filter((method) => method === "presets.list")).toHaveLength(2)
    expect([...presetWrites(remote.calls), ...presetWrites(local.calls)]).toEqual([])
    remote.dispose()
    local.dispose()
  })

  test("a pick applies through that server: its `session.preset.apply`, its own.team `area.preset` for an owner", async () => {
    const local = setup({ newSession: "star", recent: [] })
    await tick()
    const remote = host(local, MIRROR)
    await tick()
    const before = local.calls.length
    await applyPreset(remote.runtime, { sessionID: "ses_remote", presetID: ACTIVE, area: undefined })
    await applyPreset(remote.runtime, {
      sessionID: "ses_owner",
      presetID: REVIEW,
      area: { teamID: "tm_0123456789ab", areaID: "ar_0123456789ab" },
    })
    expect(remote.calls.slice(1)).toEqual([
      {
        rpcID: "own.accounts",
        method: "session.preset.apply",
        input: { sessionID: "ses_remote", presetID: ACTIVE },
        directory: "/home/u/p",
      },
      {
        rpcID: TEAM_ID,
        method: "area.preset",
        input: { teamID: "tm_0123456789ab", areaID: "ar_0123456789ab", presetID: REVIEW },
        directory: "/home/u/ctl",
      },
    ])
    // Nothing reaches this PC's service, and no preset is written anywhere.
    expect(local.calls.length).toBe(before)
    expect(presetWrites(remote.calls)).toEqual([])
    remote.dispose()
    local.dispose()
  })

  test("a new session on a mirroring host starts on the host's start preset, bound there", async () => {
    const local = setup({ newSession: "star", recent: [] })
    await tick()
    const remote = host(local, MIRROR)
    await tick()
    await remote.runtime.own.refreshPresets()
    await applyStartPreset({
      runtime: remote.runtime,
      local: local.runtime,
      serverKey: "srv",
      sessionID: "ses_remote1",
      target: TARGET,
      directory: "/home/u/p",
    })
    expect(applies(remote.calls)).toEqual([
      {
        rpcID: "own.accounts",
        method: "session.preset.apply",
        input: { sessionID: "ses_remote1", presetID: ACTIVE },
        directory: "/home/u/p",
      },
    ])
    expect(applies(local.calls)).toEqual([])
    remote.dispose()
    local.dispose()
  })

  test("an older host without the mirror: `평소대로` only, nothing bound, the neutral line", async () => {
    const local = setup({ newSession: "star", recent: [] })
    await tick()
    const remote = host(local, OLDER)
    await tick()
    await remote.runtime.own.refreshPresets()
    const groups = remote.runtime.own.state.presetGroups
    const place = presetPlace(groups, local.runtime.own.state.presetGroups)
    expect(place).toBe("builtin")
    const parts = menuParts(place, false)
    expect<unknown>(menuRows("codex", groups.codex, parts.builtinOnly).map((item) => item.id)).toEqual([
      "builtin:codex",
    ])
    expect(parts.note.map((key) => subagentText.text("ko", key))).toEqual([
      "이 원격 서버에는 아직 프리셋이 없어 평소대로만 써요",
    ])
    // Even the new-session screen's pick is not sent: the host would answer `preset_not_found`.
    chooseStartPreset("srv", "codex", REVIEW)
    await applyStartPreset({
      runtime: remote.runtime,
      local: local.runtime,
      serverKey: "srv",
      sessionID: "ses_remote2",
      target: TARGET,
      directory: "/home/u/p",
    })
    expect(applies(remote.calls)).toEqual([])
    remote.dispose()
    local.dispose()
  })
})

// ---- the module's contract ----

describe("module contract (07 §7.3, PF5)", () => {
  test("PresetMenu, the button and the banner are exported for the composer and the team's area menu", () => {
    expect(typeof PresetMenu).toBe("function")
    expect(typeof PresetButton).toBe("function")
    expect(typeof PresetBanner).toBe("function")
  })

  test("a preset never changes the main: the preset controls make no switch and open no 02 cost dialog", async () => {
    const source = await Bun.file(path.join(SRC, "composer", "preset-button.tsx")).text()
    expect(source).not.toMatch(/switch\.(estimate|apply|schedule)|requestSwitch|openDialog/)
    expect(source).toContain('"session.preset.apply"')
    // An owner conversation's choice is the area's preset (06 §9.5).
    expect(source).toContain('"area.preset"')
  })

  test("no write of presets targets a remote server: every `presets.*` write is this PC's (07 §8.1 원격)", async () => {
    for (const file of [
      "presets/editor.tsx",
      "presets/details.tsx",
      "presets/repair-notice.tsx",
      "settings/presets.tsx",
    ]) {
      const source = code(await Bun.file(path.join(SRC, file)).text())
      expect(source, file).toMatch(/call\(\s*"presets\.(set|remove|defaults\.set)"/)
      expect(source, file).toContain("data.local()")
      expect(source, file).not.toMatch(/data\.get\(|useServer\(/)
    }
    // The composer's controls read presets and open this PC's editor; they never write one, wherever the session is.
    const button = code(await Bun.file(path.join(SRC, "composer", "preset-button.tsx")).text())
    expect(button).not.toMatch(/call\(\s*"presets\./)
    expect(button).toContain("openPresetEditor({")
  })

  test("the button's repair dot and the menu's repair lines come from this PC's list only (07 §7.3, T2.18)", async () => {
    const button = code(await Bun.file(path.join(SRC, "composer", "preset-button.tsx")).text())
    expect(button).toContain('presets().place === "local" && needsRepair(local().presetGroups[value])')
    expect(button).toContain("<Show when={parts().repairs && repairLines()}>")
  })

  test("the start preset is bound after the create and before the first prompt; the editor stays lazy", async () => {
    const source = await Bun.file(path.join(SRC, "composer", "index.tsx")).text()
    const create = source.slice(source.indexOf("async function create("))
    const created = create.indexOf("await created.request")
    const bound = create.indexOf("await applyStartPreset(")
    const prompted = create.indexOf("await suggest.send(")
    expect(created).toBeGreaterThan(0)
    expect(bound).toBeGreaterThan(created)
    expect(prompted).toBeGreaterThan(bound)
    expect(source).toContain('lazy(() => import("@/presets/editor"))')
    // team/model.ts (and its strings) load only for an owner conversation's worst case; type imports are erased.
    const button = await Bun.file(path.join(SRC, "composer", "preset-button.tsx")).text()
    const team = button.split("\n").filter((line) => /from "@\/team\/(model|strings)"/.test(line))
    expect(team.every((line) => line.startsWith("import type "))).toBe(true)
    expect(button).toContain('await import("@/team/model")')
  })
})

// ---- strings ----

describe("strings (07 §7.3, §7.5)", () => {
  test("every composer and chip key has its English line", () => {
    const missing = Object.keys(subagentKo).filter((key) => !(key in subagentEn))
    expect(missing).toEqual([])
  })

  test("the button, the menu note, the older remote's note and the badge", () => {
    expect(subagentText.text("ko", "own.subagent.preset.button", { name: "평소대로" })).toBe("프리셋: 평소대로")
    expect(subagentText.text("ko", "own.subagent.preset.free")).toBe("비용 없음 · 바로 적용")
    expect(subagentText.text("ko", "own.subagent.preset.remoteBuiltin")).toBe(
      "이 원격 서버에는 아직 프리셋이 없어 평소대로만 써요",
    )
    expect(subagentText.text("en", "own.subagent.preset.remoteBuiltin")).toBe(
      "This remote server has no presets yet, so it uses 'As usual' only",
    )
    expect(subagentText.text("ko", "own.subagent.badge.running", { running: 2, max: 3, message: 5 })).toBe(
      "하위 에이전트 2/3 실행 중 · 이 메시지 5개",
    )
    expect(subagentText.text("ko", "own.subagent.preset.teamClash", { account: "ChatGPT 03" })).toBe(
      "ChatGPT 03을 써서 이 팀에서 쓸 수 없어요",
    )
    expect(subagentText.text("en", "own.subagent.preset.button", { name: "As usual" })).toBe("Preset: As usual")
    expect(presetsText("ko", "own.preset.ultra.raiseClaude")).toBe("켤 때 강도도 xhigh로")
  })

  test("T3 (07 §8.1 원격): the T1 remote line is gone; the older remote's line names no mechanism", () => {
    expect(Object.keys(subagentKo)).not.toContain("own.subagent.preset.remote")
    expect(Object.keys(subagentEn)).not.toContain("own.subagent.preset.remote")
    const lines = (["ko", "en"] as const).map((locale) =>
      subagentText.text(locale, "own.subagent.preset.remoteBuiltin"),
    )
    for (const line of lines)
      expect(line).not.toMatch(
        /mirror|미러|presets\.json|json|SSH|RPC|own\.|registry|레지스트리|sync|동기화|version|버전|this PC|이 PC|T3/i,
      )
  })
})
