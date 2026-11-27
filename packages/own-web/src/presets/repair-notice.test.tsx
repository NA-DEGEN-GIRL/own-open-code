// Preset repair notices (07 §4.3, §7.3, PG5 UI): one line per model event whatever the number of presets and places
// that use it, in the 07 §7.5 words; `[<후속 모델>로 고치기]` as `presets.set{repairOf}` per place (a preset's later
// write keeps its earlier fix) and `[짝 고치기]` as `presets.defaults.set{lighter}`, never a main or effort change;
// `[직접 고르기]` as the editor on that role (`focusRole`); a gone default model's line and `[바꾸기]`; the composer's
// dot; announcing each model event once; and the shell's reading of `presets.list` `repairs` (a real OwnStore over a
// fake own.accounts transport). Every account, preset and model is fake.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { Model } from "@opencode/schema/model"
import { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import type { I18nParams } from "@/i18n"
import { closePresetEditor, openPresetEditor, presetEditorRequest } from "./model"
import { applyFixes, defaultRepair, noticeLines, RepairNotices, type FixStep, type NoticeNames } from "./repair-notice"
import { marksRepair, needsRepair, presetRepairs, repairLines, unannounced, watchRepairs } from "./repairs"
import { ROLE_KEY } from "./session-view"
import { presetsText, type PresetsKey } from "./strings"

const SRC = path.join(import.meta.dir, "..")
const tick = () => new Promise((resolve) => setTimeout(resolve, 80))
/** Source without comments, so spec examples in comments are not taken for code. */
const code = (source: string) => source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")

// ---- fixtures ----

const CLAUDE = Account.ID.claudeSlot
const DEEPSEEK = Account.ID.make("acc_deepseek")
const pin = (account: string, model: string) => Schema.decodeUnknownSync(Preset.Target)({ pin: { account, model } })
const decodeRepair = Schema.decodeUnknownSync(Preset.Repair)

const REVIEW = Preset.ID.make("pr_01JB0000000000000000000001")
const BOTH = Preset.ID.make("pr_01JB0000000000000000000002")
const LIGHT = Preset.ID.make("pr_01JB0000000000000000000003")

function preset(id: Preset.ID, name: string, workers: Preset.Workers, status: Preset.Status = "ok"): Preset.Listed {
  return { ...Preset.builtin("codex"), id, name, revision: 3, status, workers, delegation: "when-useful" }
}

const GONE = "claude-opus-4-5"
const NEXT = "claude-opus-5-5"

const REVIEW_PRESET = preset(
  REVIEW,
  "다른 회사 리뷰",
  {
    mode: "by-role",
    roles: {
      "own-review": {
        targets: [pin(DEEPSEEK, "deepseek-flash"), pin(CLAUDE, GONE)],
        effort: Model.VariantID.make("high"),
      },
    },
  },
  "needs_repair",
)
const BOTH_PRESET = preset(
  BOTH,
  "둘 다 Claude",
  {
    mode: "by-role",
    roles: {
      explore: { targets: [pin(CLAUDE, GONE), pin(CLAUDE, NEXT)], effort: "inherit" },
      "own-review": { targets: [pin(CLAUDE, GONE)], effort: "inherit" },
    },
  },
  "needs_repair",
)
const LIGHT_PRESET = preset(LIGHT, "가볍게 나눠 쓰기", {
  mode: "by-role",
  roles: { explore: { targets: [{ rel: "lighter" }], effort: "inherit" } },
})

const CODEX_VIEW: Preset.GroupView = {
  group: "codex",
  defaultModel: null,
  presets: [{ ...Preset.builtin("codex"), status: "ok" }, REVIEW_PRESET, BOTH_PRESET, LIGHT_PRESET],
  lighter: {
    "gpt-6-astra": { model: Schema.decodeUnknownSync(Preset.Lighter)({ model: "gpt-6-luna" }).model, missing: true },
  },
  status: "needs_repair",
}
const CLAUDE_VIEW: Preset.GroupView = {
  group: "claude-sub",
  defaultModel: {
    ...Schema.decodeUnknownSync(Preset.DefaultModel)({ id: "claude-sonnet-4-5", source: "user" }),
    missing: true,
  },
  presets: [{ ...Preset.builtin("claude-sub"), status: "ok" }],
  status: "ok",
}
const GROUPS = { codex: CODEX_VIEW, "claude-sub": CLAUDE_VIEW }

const PIN_REPAIR = decodeRepair({
  model: GONE,
  uses: [
    { kind: "pin", group: "codex", presetID: REVIEW, place: "own-review", account: CLAUDE, suggestion: NEXT },
    { kind: "pin", group: "codex", presetID: BOTH, place: "explore", account: CLAUDE, suggestion: NEXT },
    { kind: "pin", group: "codex", presetID: BOTH, place: "own-review", account: CLAUDE, suggestion: NEXT },
  ],
})
const PAIR_REPAIR = decodeRepair({
  model: "gpt-6-luna",
  uses: [{ kind: "lighter", group: "codex", main: "gpt-6-astra", suggestion: "gpt-6-mini" }],
})
const DEFAULT_REPAIR = decodeRepair({
  model: "claude-sonnet-4-5",
  uses: [{ kind: "default", group: "claude-sub", suggestion: NEXT }],
})
const REPAIRS = [PIN_REPAIR, PAIR_REPAIR, DEFAULT_REPAIR]

const text = (key: PresetsKey, params?: I18nParams) => presetsText("ko", key, params)
const names: NoticeNames = {
  model: (id) => id.toUpperCase(),
  place: (place) => (place === "single" ? text("own.preset.place.single") : text(ROLE_KEY[place])),
  group: (group) =>
    group === "claude-sub" ? text("own.preset.groupName.claude-sub") : text("own.preset.groupName.codex"),
}
const lines = (repairs: ReadonlyArray<Preset.Repair>, group?: Preset.Group) =>
  noticeLines({ repairs, groups: GROUPS, text, names, ...(group ? { group } : {}) })

/** What a `presets.set` step stores for a role. */
function targets(step: FixStep | undefined, role: Preset.Role) {
  return step?.method === "presets.set" ? step.input.preset.workers.roles[role]?.targets : undefined
}

// ---- lines ----

describe("one line per model event (07 §4.3)", () => {
  test("a pinned model gone from two presets and three places is one line in the 07 §7.5 words", () => {
    const [line, pair, fallback] = lines(REPAIRS)
    expect(lines(REPAIRS)).toHaveLength(3)
    expect(line?.kind).toBe("pin")
    expect(line?.text).toBe("리뷰, 탐색 모델 CLAUDE-OPUS-4-5가 없어져 리뷰, 탐색을 메인 모델로 돌려요 · 프리셋 2개")
    expect(line?.fix?.label).toBe("CLAUDE-OPUS-5-5로 고치기")
    expect(pair?.text).toBe("GPT-6-LUNA가 없어져 탐색을 메인 모델로 돌려요")
    expect(pair?.fix?.label).toBe("짝 고치기")
    expect(fallback?.text).toBe(
      "Claude 구독 새 대화 기본 모델 CLAUDE-SONNET-4-5가 없어졌어요. 새 대화는 CLAUDE-OPUS-5-5로 시작해요",
    )
  })

  test("a group's view counts and fixes that group's uses only", () => {
    expect<unknown>(lines(REPAIRS, "codex").map((line) => line.model)).toEqual([GONE, "gpt-6-luna"])
    expect(lines(REPAIRS, "claude-sub").map((line) => line.kind)).toEqual(["default"])
    expect(lines(REPAIRS, "ds")).toEqual([])
    expect(lines([])).toEqual([])
  })

  test("without a suggestion there is no fix, only 직접 고르기; different successors say 고치기", () => {
    const bare = decodeRepair({
      model: GONE,
      uses: [{ kind: "pin", group: "codex", presetID: REVIEW, place: "own-review", account: CLAUDE }],
    })
    expect(lines([bare])[0]?.fix).toBeUndefined()
    expect(lines([bare])[0]?.pick).toEqual({ group: "codex", presetID: REVIEW, focusRole: "own-review" })
    const split = decodeRepair({
      model: GONE,
      uses: [
        { kind: "pin", group: "codex", presetID: REVIEW, place: "own-review", account: CLAUDE, suggestion: NEXT },
        { kind: "pin", group: "codex", presetID: BOTH, place: "explore", account: CLAUDE, suggestion: "claude-x" },
      ],
    })
    expect(lines([split])[0]?.fix?.label).toBe("고치기")
    // A lighter pair without a suggestion: the editor of the preset that runs on it, 자세히 on that role.
    const pairOnly = decodeRepair({
      model: "gpt-6-luna",
      uses: [{ kind: "lighter", group: "codex", main: "gpt-6-astra" }],
    })
    expect(lines([pairOnly])[0]?.fix).toBeUndefined()
    expect(lines([pairOnly])[0]?.pick).toEqual({ group: "codex", presetID: LIGHT, focusRole: "explore" })
  })
})

// ---- [고치기] ----

describe("[고치기] stores the suggested fix (07 §4.3, §8.1 repairOf)", () => {
  test("presets.set{repairOf} per place: the gone pin becomes the successor in its rank, nothing else changes", () => {
    const steps = lines(REPAIRS)[0]?.fix?.steps ?? []
    expect(steps.map((step) => [step.method, step.method === "presets.set" ? step.input.repairOf : undefined])).toEqual(
      [
        ["presets.set", { model: GONE, place: "own-review" }],
        ["presets.set", { model: GONE, place: "explore" }],
        ["presets.set", { model: GONE, place: "own-review" }],
      ],
    )
    expect(targets(steps[0], "own-review")).toEqual([pin(DEEPSEEK, "deepseek-flash"), pin(CLAUDE, NEXT)])
    // The second preset is written twice; the later write keeps the earlier fix, and a target listed twice stays once.
    expect(targets(steps[1], "explore")).toEqual([pin(CLAUDE, NEXT)])
    expect(targets(steps[1], "own-review")).toEqual([pin(CLAUDE, GONE)])
    expect(targets(steps[2], "explore")).toEqual([pin(CLAUDE, NEXT)])
    expect(targets(steps[2], "own-review")).toEqual([pin(CLAUDE, NEXT)])
    const first = steps[0]
    expect<unknown>(first?.method === "presets.set" && first.input.preset).toEqual({
      id: REVIEW,
      name: "다른 회사 리뷰",
      group: "codex",
      workers: { mode: "by-role", roles: { "own-review": { targets: targets(first, "own-review"), effort: "high" } } },
      delegation: "when-useful",
      caps: Preset.CAPS,
      ultraCaps: null,
    })
  })

  test("짝 고치기 is the group's lighter pair for that main model; a default is never rewritten", () => {
    expect(lines(REPAIRS)[1]?.fix?.steps).toEqual([
      {
        method: "presets.defaults.set",
        input: { group: "codex", lighter: { mainModelID: "gpt-6-astra", model: "gpt-6-mini" } },
      },
    ])
    const fallback = lines(REPAIRS)[2]
    expect(fallback?.fix).toBeUndefined()
    expect(fallback?.change).toBe("claude-sub")
  })

  test("the writes go in order, then presets.list is read again", async () => {
    const calls: string[] = []
    const own = {
      rpc: {
        call: async (method: string, input: unknown) => {
          calls.push(`${method} ${JSON.stringify((input as { repairOf?: unknown }).repairOf ?? null)}`)
          await tick()
          return {}
        },
      },
      refreshPresets: async () => void calls.push("refresh"),
    }
    // SAFETY: applyFixes only reaches `rpc.call` and `refreshPresets`.
    await applyFixes(own as never, lines(REPAIRS)[0]?.fix?.steps ?? [])
    expect(calls).toEqual([
      `presets.set ${JSON.stringify({ model: GONE, place: "own-review" })}`,
      `presets.set ${JSON.stringify({ model: GONE, place: "explore" })}`,
      `presets.set ${JSON.stringify({ model: GONE, place: "own-review" })}`,
      "refresh",
    ])
  })

  test("PG4: the repair lines write presets only, never a switch of the main's model or effort", async () => {
    const files = ["repair-notice.tsx", "repairs.ts"].map((file) => Bun.file(path.join(import.meta.dir, file)).text())
    const source = code((await Promise.all(files)).join("\n"))
    expect([...source.matchAll(/\.call\(\s*"([^"]+)"/g)].map((match) => match[1]).toSorted()).toEqual([
      "presets.defaults.set",
      "presets.list",
      "presets.set",
    ])
    expect(source).not.toMatch(/switch\.(estimate|apply|schedule)|openSwitcher/)
  })
})

// ---- a model pool's entries (07 §4.3 모델 묶음, pool design §6) ----

describe("a model pool entry's repair (07 §4.3 모델 묶음)", () => {
  const POOLED = Preset.ID.make("pr_01JB0000000000000000000004")
  const POOL_PRESET = preset(
    POOLED,
    "모델 묶음",
    Schema.decodeUnknownSync(Preset.Workers)({
      mode: "same",
      roles: {},
      pool: [
        { key: "gpt-6-luna", model: "gpt-6-luna", card: { name: "GPT-6 Luna", at: 1 } },
        {
          key: GONE,
          model: GONE,
          account: CLAUDE,
          effort: "high",
          note: "리뷰는 이것으로",
          card: { name: "Claude Opus 4.5", at: 1 },
        },
      ],
    }),
    "needs_repair",
  )
  const POOL_GROUPS = { codex: { ...CODEX_VIEW, presets: [...CODEX_VIEW.presets!, POOL_PRESET] } }
  const poolUse = { kind: "pin", group: "codex", presetID: POOLED, place: `pool:${GONE}`, account: CLAUDE }
  const lookup: Preset.Lookup = (id) =>
    id === CLAUDE
      ? { id, kind: "claude-sub", billing: "subscription" }
      : id === DEEPSEEK
        ? { id, kind: "ds", billing: "prepaid" }
        : undefined
  const poolLines = (repairs: ReadonlyArray<Preset.Repair>) =>
    noticeLines({ repairs, groups: POOL_GROUPS, text, names, lookup })
  const pool = (step: FixStep | undefined) =>
    step?.method === "presets.set" ? step.input.preset.workers.pool : undefined

  test("the line names the pool's key and says a pick runs on the default rule until it is fixed", () => {
    const [line] = poolLines([decodeRepair({ model: GONE, uses: [{ ...poolUse, suggestion: NEXT }] })])
    expect(line?.text).toBe(
      "모델 묶음의 claude-opus-4-5: CLAUDE-OPUS-4-5가 없어져 고칠 때까지 고르면 기본 규칙으로 돌아요 · 프리셋 1개",
    )
    expect(line?.fix?.label).toBe("CLAUDE-OPUS-5-5로 고치기")
    expect(line?.pick).toEqual({ group: "codex", presetID: POOLED, focusRole: `pool:${GONE}` })
    // A role and a pool entry on the same gone model: both clauses, one line.
    const both = poolLines([
      decodeRepair({
        model: GONE,
        uses: [
          { kind: "pin", group: "codex", presetID: REVIEW, place: "own-review", account: CLAUDE, suggestion: NEXT },
          { ...poolUse, suggestion: NEXT },
        ],
      }),
    ])[0]
    expect(both?.text).toBe(
      "리뷰 모델 CLAUDE-OPUS-4-5가 없어져 리뷰를 메인 모델로 돌려요 · 모델 묶음의 claude-opus-4-5: CLAUDE-OPUS-4-5가 없어져 고칠 때까지 고르면 기본 규칙으로 돌아요 · 프리셋 2개",
    )
  })

  test("[고치기]: presets.set{repairOf: pool:<key>} with the successor under a new key, no card, effort and note kept", () => {
    const steps = poolLines([decodeRepair({ model: GONE, uses: [{ ...poolUse, suggestion: NEXT }] })])[0]?.fix?.steps
    expect(steps).toHaveLength(1)
    const step = steps?.[0]
    expect(step?.method === "presets.set" && step.input.repairOf).toEqual({ model: GONE, place: `pool:${GONE}` })
    expect<unknown>(pool(step)).toEqual([
      POOL_PRESET.workers.pool![0],
      {
        key: Preset.poolKey(NEXT, ["gpt-6-luna"], "subscription"),
        model: NEXT,
        account: CLAUDE,
        effort: "high",
        note: "리뷰는 이것으로",
      },
    ])
    expect(pool(step)?.[1]?.key).toBe(NEXT)
  })

  test("a gone main-account model takes the group's successor; one already in the pool just leaves", () => {
    const main = decodeRepair({
      model: "gpt-6-luna",
      uses: [{ kind: "pin", group: "codex", presetID: POOLED, place: "pool:gpt-6-luna", suggestion: "gpt-6-sol" }],
    })
    const fixed = pool(poolLines([main])[0]?.fix?.steps[0])
    expect<unknown>(fixed?.[0]).toEqual({ key: "gpt-6-sol", model: "gpt-6-sol" })
    expect(fixed?.[1]?.key).toBe(GONE)
    // The successor is in the pool already on that account: the gone entry leaves instead of a duplicate target.
    const twice = decodeRepair({
      model: GONE,
      uses: [{ kind: "pin", group: "codex", presetID: POOLED, place: `pool:${GONE}`, suggestion: "gpt-6-luna" }],
    })
    const groups = {
      codex: {
        ...CODEX_VIEW,
        presets: [
          preset(
            POOLED,
            "모델 묶음",
            {
              ...POOL_PRESET.workers,
              pool: POOL_PRESET.workers.pool!.map((entry) => ({ ...entry, account: undefined })),
            },
            "needs_repair",
          ),
        ],
      },
    }
    const left = noticeLines({ repairs: [twice], groups, text, names, lookup })[0]?.fix?.steps[0]
    expect(pool(left)?.map((entry) => entry.key)).toEqual(["gpt-6-luna"])
  })
})

// ---- [직접 고르기], [바꾸기] ----

describe("[직접 고르기] and [바꾸기] (07 §4.3, §7.2)", () => {
  test("직접 고르기 opens the editor on the first preset that used the model, 자세히 on that role", () => {
    const pick = lines(REPAIRS)[0]?.pick
    expect(pick).toEqual({ group: "codex", presetID: REVIEW, focusRole: "own-review" })
    openPresetEditor(pick!)
    expect(presetEditorRequest()).toEqual({ group: "codex", presetID: REVIEW, focusRole: "own-review" })
    closePresetEditor()
  })

  test("the buttons call openPresetEditor with the line's request and open settings 프리셋 on a default's tab", async () => {
    const source = code(await Bun.file(path.join(import.meta.dir, "repair-notice.tsx")).text())
    expect(source).toContain("line.pick && openPresetEditor(line.pick)")
    expect(source).toContain('navigate({ name: "settings", section: "presets" })')
    const settings = code(await Bun.file(path.join(SRC, "settings", "presets.tsx")).text())
    expect(settings).toContain("takePresetTab()")
    expect(settings).toContain("<RepairNotices group={props.group} defaults={false} />")
  })

  test("a gone default: what new sessions start on, as the service says", () => {
    expect(defaultRepair(REPAIRS, "claude-sub")).toEqual({
      model: DEFAULT_REPAIR.model,
      next: DEFAULT_REPAIR.uses[0]!.suggestion,
    })
    expect(defaultRepair(REPAIRS, "codex")).toBeUndefined()
  })
})

// ---- the dot, announcing, reading ----

describe("the preset button's dot and the notifier (07 §7.3)", () => {
  test("a dot only while a preset of that group needs a repair", () => {
    expect(needsRepair(CODEX_VIEW)).toBe(true)
    // A preset that runs on a gone lighter pair needs one; a gone pair no preset runs on does not.
    expect(needsRepair({ ...CODEX_VIEW, presets: [LIGHT_PRESET] })).toBe(true)
    const unused = { ...CODEX_VIEW, presets: [{ ...Preset.builtin("codex"), status: "ok" as const }] }
    expect(needsRepair(unused)).toBe(false)
    expect(needsRepair({ ...CODEX_VIEW, presets: [LIGHT_PRESET], lighter: {} })).toBe(false)
    // A gone default model is no preset's: no dot, its line is on the settings tab.
    expect(needsRepair(CLAUDE_VIEW)).toBe(false)
    expect(needsRepair(undefined)).toBe(false)
    // What the shell reads the repairs for: any of the three.
    expect(marksRepair({ codex: unused })).toBe(true)
    expect(marksRepair({ "claude-sub": CLAUDE_VIEW })).toBe(true)
    expect(marksRepair({ codex: { ...CODEX_VIEW, presets: [LIGHT_PRESET], lighter: {} } })).toBe(false)
  })

  test("each model event is announced once; one that comes back and goes again is announced again", () => {
    expect<unknown>(unannounced(REPAIRS, []).fresh.map((repair) => repair.model)).toEqual([
      GONE,
      "gpt-6-luna",
      "claude-sonnet-4-5",
    ])
    const seen = unannounced(REPAIRS, [GONE]).seen
    expect(unannounced(REPAIRS, seen).fresh).toEqual([])
    const fixed = unannounced([PAIR_REPAIR], seen)
    expect<unknown>(fixed).toEqual({ fresh: [], seen: ["gpt-6-luna"] })
    expect(unannounced([PIN_REPAIR], fixed.seen).fresh).toEqual([PIN_REPAIR])
  })

  test("the composer and the shell mount them: the dot, the menu lines, the toast", async () => {
    const button = code(await Bun.file(path.join(SRC, "composer", "preset-button.tsx")).text())
    expect(button).toContain("needsRepair(local().presetGroups[value])")
    expect(button).toMatch(/component=\{RepairNotices\(\)\}\s*group=\{props\.group\}\s*menu\s*defaults=\{false\}/)
    const shell = code(await Bun.file(path.join(SRC, "shell", "notifications.tsx")).text())
    expect(shell).toContain("watchRepairs(data.local().own)")
    expect(shell).toContain("unannounced(list, readAnnounced())")
    // PF5: the lines and their actions are a lazy chunk; the first chunk holds only presets/repairs.ts, which loads it.
    for (const source of [button, shell]) expect(source).not.toMatch(/from "@\/presets\/repair-notice"/)
    expect(code(await Bun.file(path.join(import.meta.dir, "repairs.ts")).text())).toContain('import("./repair-notice")')
    expect(shell).toContain('import("@/presets/repair-notice")')
  })
})

// ---- reading `presets.list` `repairs` (real OwnStore) ----

function setup(answers: Record<string, unknown>) {
  const calls: string[] = []
  const client = {
    rpc: {
      call: async (input: { method: string }) => {
        calls.push(input.method)
        const entry = answers[input.method]
        return { output: (typeof entry === "function" ? entry() : entry) ?? {} }
      },
    },
  }
  return createRoot((dispose) => {
    const bus = createEventBus()
    const rpc = createOwnRpc({
      // SAFETY: the store only reaches `rpc.call` here.
      client: () => client as unknown as OpenCodeClient,
      routing: { control: async () => "D:\\ctl", sessionDirectory: () => undefined },
      scopes: () => ALL_SCOPES,
    })
    const own = createOwnStore({
      rpc,
      bus,
      client: () => client as unknown as OpenCodeClient,
      sessionDirectory: () => undefined,
    })
    watchRepairs(own)
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    bus.flush()
    const changed = () => {
      bus.publish({
        id: `evt_${Math.random()}`,
        created: Date.now(),
        type: "rpc.own.accounts.presets.changed",
        location: { directory: "D:\\ctl" },
        data: { eventId: `01JAXPRESETS${String(Math.random()).slice(2, 16).padEnd(14, "0")}`, origin: "global" },
      } as OpenCodeEvent)
      bus.flush()
    }
    return { calls, changed, dispose }
  })
}

const BASE = {
  health: { version: "local", buildId: "b", guard: "ok", controlDir: "D:\\ctl" },
  "accounts.list": { revision: 1, accounts: [] },
  "quota.snapshot": { windows: [] },
  "policy.get": { policy: { defaults: { byKind: {} } } },
}

describe("the shell reads the repairs (07 §4.3)", () => {
  test("while a group marks a repair: presets.list's repairs, and again on presets.changed", async () => {
    const run = setup({ ...BASE, "presets.list": { groups: [CODEX_VIEW, CLAUDE_VIEW], repairs: REPAIRS } })
    await tick()
    expect(presetRepairs()).toEqual(REPAIRS)
    // The lines' lazy chunk (PF5) loads with the first repairs, so a menu opened later has them at once.
    expect(repairLines()).toBe(RepairNotices)
    // OwnStore's read and this one.
    expect(run.calls.filter((method) => method === "presets.list")).toHaveLength(2)
    run.changed()
    await tick()
    expect(run.calls.filter((method) => method === "presets.list")).toHaveLength(4)
    run.dispose()
  })

  test("nothing marked: no repairs and no second read", async () => {
    const clean = { ...CODEX_VIEW, status: "ok" as const, presets: [LIGHT_PRESET], lighter: {} }
    const run = setup({ ...BASE, "presets.list": { groups: [clean] } })
    await tick()
    expect(presetRepairs()).toEqual([])
    run.changed()
    await tick()
    expect(run.calls.filter((method) => method === "presets.list")).toHaveLength(2)
    run.dispose()
  })
})
