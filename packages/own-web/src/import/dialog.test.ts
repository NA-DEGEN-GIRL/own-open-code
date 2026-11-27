// `이어서 하기` (I2: 09 §4.5–4.8, §6) over its pure parts and the real data layer: the default target rules (07 R4: an
// account of the source tool's company, else the folder's new-session default; own never picks by headroom), the
// `추천` alternatives on a usage shortage, the mode rows (recommended row, dimmed rows with their reason, the summary's
// two sources, the button label), the send notice of every mode (IG10), the plan input and its 300 ms debounce, the
// job's progress and its restore from `jobs.list`, the alternatives after a failed summary, the helper filter (09 §6
// 숨김: session index, flags, notifications), the first-screen line, and the scope gate that hides `이어서 하기`.
// Fixtures go through the protocol's schemas; every account, model and conversation is fake.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeClient, OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Account, Limit } from "@own/protocol"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import { OwnRpcError, type DataLayer, type ServerRuntime } from "@/data"
import { createEventBus } from "@/data/events"
import { createImportRpc, IMPORT_EVENT_PREFIX, IMPORT_META, importEvent, type ImportEvent } from "@/data/import-rpc"
import { ALL_SCOPES, type OwnScope } from "@/data/rpc"
import { createSessionIndex, isHelperSession } from "@/data/session-index"
import type { HostNotification } from "@/host/types"
import { createTurnNotifier } from "@/shell/notifications"
import { importedLine } from "@/shell/session-banners"
import { createOwnFlags } from "@/sidebar/flags"
import {
  alternatives,
  choiceOf,
  createPlanner,
  debounce,
  defaultTarget,
  errorText,
  headroomRanked,
  jobErrorKey,
  jobEvent,
  jobSteps,
  modeRows,
  PLAN_DELAY,
  planInput,
  quotaShort,
  restoreJob,
  selectedRow,
  sendNotice,
  summarizes,
  summarySource,
  summaryState,
  targetAccount,
  TOOL_COMPANY,
  type JobView,
  type Timers,
} from "./model"
import { importGates } from "./store"
import { importKo, type ImportKey } from "./strings"

const NOW = 1_800_000_000_000
const decodePlan = Schema.decodeUnknownSync(OwnImport.Plan)
const decodeJobs = Schema.decodeUnknownSync(Schema.Struct({ jobs: Schema.Array(OwnImport.Job) }))
const decodeHealth = Schema.decodeUnknownSync(OwnImport.Health)

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

function account(id: string, kind: Account.View["kind"], extra: Partial<Account.View> = {}): Account.View {
  // SAFETY: fixture shaped like `accounts.list[]`; the dialog's rules read kind, providerID, billing, status, limits.
  return {
    id,
    kind,
    label: id,
    shortLabel: id,
    color: "indigo",
    providerID: `own-${kind}-${id}`,
    billing: kind === "codex" || kind === "siwc" || kind === "claude-sub" ? "subscription" : "metered",
    status: "ready",
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    connection: { type: "key" },
    ...extra,
  } as Account.View
}

function window(
  accountID: string,
  id: string,
  usedPercent: number | undefined,
  extra: Partial<Limit.Window> = {},
): Limit.Window {
  // SAFETY: fixture shaped like `quota.snapshot` windows.
  return {
    id,
    accountID,
    providerID: "p",
    scope: "account",
    kind: "rolling_quota",
    label: id,
    usedPercent,
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: NOW,
    ...extra,
  } as Limit.Window
}

const groupModel = (item: Account.View) => ({ providerID: item.providerID, id: `${item.kind}-default` })
const FOLDER = { providerID: "own-ds-folder", id: "deepseek-fake" }

const credits = (lo: number, hi: number) => ({ lo, hi, unit: "credits" })
const free = {
  summary: null,
  first: credits(0.9, 1.1),
  perRequest: credits(0.1, 0.1),
  autoCompactSoon: null,
  quota: null,
}
const send = (now: number, withFirst: number, crossCompany = false) => ({
  now,
  withFirst,
  accountID: "acc_fake01",
  company: "openai",
  crossCompany,
})

function plan(input: { readonly modes?: readonly unknown[]; readonly [key: string]: unknown } = {}) {
  return decodePlan({
    nonce: "nonce-fixture-0000000001",
    expiresAt: NOW + 600_000,
    title: "설치기 정리",
    turns: 41,
    location: { directory: "C:\\fixture\\proj", branch: "main", differsFromList: false },
    boundary: { at: null, checkpoint: null, sourceCompactions: 0 },
    size: {
      visible: 182_000,
      Z: 12_000,
      zSource: "measured",
      exchange: 3_000,
      window: 400_000,
      ceiling: 256_000,
      ratio: 0.71,
      capacity: 60_000,
    },
    summarizer: { model: { providerID: "own-codex-a", id: "gpt-fake" }, overridden: false },
    modes: [
      { mode: "full", available: true, recommended: true, send: send(0, 182_000), cost: free },
      {
        mode: "summary",
        source: "llm",
        available: false,
        recommended: false,
        reason: "fits",
        send: send(150_000, 40_000),
        cost: { ...free, summary: credits(1.2, 1.6) },
      },
      {
        mode: "summary",
        source: "brief",
        available: false,
        recommended: false,
        reason: "fits",
        send: send(0, 60_000),
        cost: free,
      },
    ],
    store: { full: true, bytes: 1_000, budget: 33_554_432, trimmedTurns: 0 },
    redactions: 3,
    dropped: {},
    warnings: [],
    existing: [],
    ...input,
  })
}

function fakeTimers() {
  const pending = new Map<number, { readonly run: () => void; readonly at: number }>()
  const clock = { now: 0, seq: 0 }
  const timers: Timers = {
    set: (run, ms) => {
      const id = ++clock.seq
      pending.set(id, { run, at: clock.now + ms })
      // SAFETY: an opaque handle for `clear`; the fake never hands it to the real timer functions.
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clear: (timer) => {
      // SAFETY: handles come from `set` above.
      pending.delete(timer as unknown as number)
    },
  }
  const advance = (ms: number) => {
    clock.now += ms
    for (const [id, item] of [...pending].toSorted((a, b) => a[1].at - b[1].at)) {
      if (item.at > clock.now) continue
      pending.delete(id)
      item.run()
    }
  }
  return { timers, advance, pending: () => pending.size }
}

// ---------------------------------------------------------------------------------------------------------------

describe("default target (09 §4.5, 07 R4, U1)", () => {
  test("a subscription slot of the source tool comes first, tagged 원래와 같은 회사", () => {
    const accounts = [account("ant", "anth"), account("cx", "codex"), account("cl", "claude-sub")]
    const codex = defaultTarget({ kind: "codex", accounts, recent: [], modelOf: groupModel, folder: FOLDER })
    expect(codex).toEqual({
      target: { providerID: "own-codex-cx", id: "codex-default" },
      sameCompany: true,
      account: accounts[1],
    })
    const claude = defaultTarget({ kind: "claude-code", accounts, recent: [], modelOf: groupModel, folder: FOLDER })
    // The subscription, not the API key of the same company.
    expect(claude).toEqual({
      target: { providerID: "own-claude-sub-cl", id: "claude-sub-default" },
      sameCompany: true,
      account: accounts[2],
    })
    expect(TOOL_COMPANY).toEqual({ codex: "openai", "claude-code": "anthropic" })
    // A Sign in with ChatGPT slot is a ChatGPT subscription too.
    const signIn = account("sw", "siwc")
    const siwc = defaultTarget({ kind: "codex", accounts: [signIn], recent: [], modelOf: groupModel, folder: FOLDER })
    expect(siwc).toEqual({
      target: { providerID: "own-siwc-sw", id: "siwc-default" },
      sameCompany: true,
      account: signIn,
    })
  })

  test("a metered key of the same company is never the start, even when the folder used it last", () => {
    const accounts = [account("api", "oai"), account("cx", "codex"), account("ant", "anth")]
    const pick = (kind: "codex" | "claude-code", recent: readonly string[]) =>
      defaultTarget({ kind, accounts, recent, modelOf: groupModel, folder: FOLDER })
    expect(pick("codex", ["own-oai-api"])).toEqual({
      target: { providerID: "own-codex-cx", id: "codex-default" },
      sameCompany: true,
      account: accounts[1],
    })
    // No Claude subscription: the folder's new-session default, not the Anthropic key.
    expect(pick("claude-code", ["own-anth-ant"])).toEqual({ target: FOLDER, sameCompany: false })
  })

  test("several: the one this folder used last, else the first in account order that can serve", () => {
    const accounts = [
      account("api", "oai"),
      account("first", "codex", { status: "needs_reauth" }),
      account("second", "codex"),
      account("third", "codex"),
    ]
    const pick = (recent: readonly string[]) =>
      defaultTarget({ kind: "codex", accounts, recent, modelOf: groupModel, folder: FOLDER }).target?.providerID
    expect(pick([])).toBe("own-codex-second")
    expect(pick(["own-ds-x", "own-codex-third", "own-codex-second"])).toBe("own-codex-third")
    // The last used one is the start even when it cannot serve now: the user sees why and picks.
    expect(pick(["own-codex-first"])).toBe("own-codex-first")
    // Nothing of the company can serve: still its first account, never another company.
    const blocked = [account("a", "codex", { status: "exhausted" }), account("b", "anth")]
    expect(
      defaultTarget({ kind: "codex", accounts: blocked, recent: [], modelOf: groupModel, folder: FOLDER }),
    ).toEqual({
      target: { providerID: "own-codex-a", id: "codex-default" },
      sameCompany: true,
      account: blocked[0],
    })
  })

  test("no account of that company: the folder's new-session default, without the tag", () => {
    const accounts = [account("ds", "ds"), account("cl", "claude-sub")]
    expect(defaultTarget({ kind: "codex", accounts, recent: [], modelOf: groupModel, folder: FOLDER })).toEqual({
      target: FOLDER,
      sameCompany: false,
    })
    expect(defaultTarget({ kind: "codex", accounts: [], recent: [], modelOf: groupModel, folder: undefined })).toEqual({
      target: undefined,
      sameCompany: false,
    })
    // The model is not known yet (catalog loading): no target until it is.
    const waiting = defaultTarget({
      kind: "codex",
      accounts: [account("cx", "codex")],
      recent: [],
      modelOf: () => undefined,
      folder: FOLDER,
    })
    expect(waiting).toMatchObject({ target: undefined, sameCompany: true, account: { id: "cx" } })
  })

  test("추천 alternatives on a usage shortage: the same kind, ready, by headroom; nothing switches", () => {
    const current = account("now", "codex")
    const quota = {
      now: [window("now", "codex.primary", 97)],
      busy: [window("busy", "codex.primary", 80)],
      calm: [window("calm", "codex.primary", 10)],
      off: [window("off", "codex.primary", 0)],
      other: [window("other", "codex.primary", 0)],
    }
    const accounts = [
      current,
      account("busy", "codex"),
      account("calm", "codex"),
      account("unknown", "codex"),
      account("off", "codex", { status: "needs_reauth" }),
      account("other", "oai"),
    ]
    const ids = (items: ReturnType<typeof headroomRanked>) => items.map((item): string => item.account.id)
    expect(ids(headroomRanked(accounts, current, quota, NOW, () => "gpt-5.5"))).toEqual(["calm", "busy", "unknown"])
    expect(headroomRanked(accounts, undefined, quota, NOW, () => undefined)).toEqual([])
    const shortPlan = plan({ warnings: ["quota_insufficient"] })
    expect(quotaShort(shortPlan, selectedRow(shortPlan, undefined))).toBe(true)
    expect(quotaShort(plan(), selectedRow(plan(), undefined))).toBe(false)
  })

  test("the headroom alternatives rank with the model each would run; a used-up lead for it is none (LV)", () => {
    // Claude 2 is barely used but its Opus week is used up, known only by its state; Claude 3 is fuller everywhere.
    const current = account("one", "claude-sub")
    const quota = {
      one: [window("one", "claude.5h", 99)],
      two: [
        window("two", "claude.5h", 5),
        window("two", "claude.7d", 10),
        window("two", "claude.7d_opus", undefined, { status: "exhausted", resetAt: NOW + 5 * 86_400_000 }),
      ],
      three: [window("three", "claude.5h", 60), window("three", "claude.7d", 70)],
      four: [window("four", "claude.5h", 100, { status: "exhausted", resetAt: NOW + 3_600_000 })],
    }
    const accounts = [
      current,
      account("two", "claude-sub"),
      account("three", "claude-sub"),
      account("four", "claude-sub"),
    ]
    const pick = (model: string) =>
      headroomRanked(accounts, current, quota, NOW, () => model).map((item): [string, number | undefined] => [
        item.account.id,
        item.used,
      ])
    expect(pick("claude-opus-5-5")).toEqual([["three", 70]])
    expect(pick("claude-sonnet-4-5")).toEqual([
      ["two", 10],
      ["three", 70],
    ])
  })

  test("a picked Claude account stays picked: Claude 2 does not snap back to the provider's first account (LV)", () => {
    // Both Claude accounts serve `anthropic`; own's `accountFor` names the first one listed.
    const one = account("one", "claude-sub", { providerID: "anthropic" as Account.View["providerID"] })
    const two = account("two", "claude-sub", { providerID: "anthropic" as Account.View["providerID"] })
    const codex = account("cx", "codex")
    const byProvider = (providerID: string) => [one, codex].find((item) => item.providerID === providerID)
    const opus = { providerID: "anthropic", id: "claude-opus-5-5" }
    expect(targetAccount(two, opus, byProvider)).toBe(two)
    expect(targetAccount(undefined, opus, byProvider)).toBe(one)
    // A pick of another provider's account does not name this target's account.
    expect(targetAccount(two, { providerID: codex.providerID, id: "gpt-5.5" }, byProvider)).toBe(codex)
    expect(targetAccount(two, undefined, byProvider)).toBeUndefined()
    // The start names its account too: Claude 1 cannot serve, so the dialog starts on Claude 2 (and shows it).
    const start = defaultTarget({
      kind: "claude-code",
      accounts: [{ ...one, status: "needs_reauth" }, two],
      recent: [],
      modelOf: (item) => ({ providerID: item.providerID, id: "claude-opus-5-5" }),
      folder: FOLDER,
    })
    expect(start.account).toBe(two)
    expect(targetAccount(start.account, start.target, byProvider)).toBe(two)
  })

  test("the dialog keeps the picked account and model: picking an account maps the picked model, never replaces it", async () => {
    const source = (await Bun.file(path.join(import.meta.dir, "dialog.tsx")).text()).replaceAll(/^\s*\/\/.*$/gm, "")
    const body = (name: string) => source.slice(source.indexOf(`function ${name}(`)).split("\n  }\n")[0]!
    expect(source).toContain('targetAccount(own.state.accounts[picking() ?? ""], target(), own.accountFor)')
    expect(source).not.toContain("own.accountFor(current.providerID)")
    expect(source).toContain("rowModel(picked(), models(item.providerID), own.state.groupDefaults[item.kind])")
    expect(body("selectAccount")).toContain("modelForAccount(picked(), models(next.providerID)")
    expect(body("selectAccount")).toContain("setPicking(next.id)")
    expect(body("selectAccount")).not.toContain("setPicked(")
    for (const name of ["selectModel", "selectVariant"]) expect(body(name)).toContain("setPicked(")
    // The import starts on the picked Claude account (the one chosen last, 02 §8.7) before it runs.
    expect(body("execute")).toContain('own.rpc.call("plugin.claudeAuth.default.set", { accountID: claude.id })')
    expect(body("execute").indexOf("plugin.claudeAuth.default.set")).toBeLessThan(
      body("execute").indexOf("migrate.execute"),
    )
  })

  test("a Claude refusal is its own error with the account's fixes, never a plan error (LV)", async () => {
    // The fifth limits review: it read `계획을 만들지 못했어요: …` with `다시 시도`, though the plan stood and planning
    // again changes nothing.
    const source = (await Bun.file(path.join(import.meta.dir, "dialog.tsx")).text()).replaceAll(/^\s*\/\/.*$/gm, "")
    const body = (name: string) => source.slice(source.indexOf(`function ${name}(`)).split("\n  }\n")[0]!
    expect(body("execute")).toContain("if (!chosen) return setState({ executing: false, refused: true })")
    expect(source).not.toMatch(/error: text\("own\.otherTools\.migrate\.claudeRefused"\)/)
    const notice = source.slice(source.indexOf("<Show when={state.refused}>")).split("</Show>")[0]!
    expect(notice).toContain('testid="import-migrate-claude-refused"')
    expect(notice).toContain('text("own.otherTools.migrate.claudeRefused")')
    expect(notice).toContain("onClick={openAccounts}")
    expect(notice).toContain('onClick={() => pickAlternative("target")}')
    expect(notice).not.toMatch(/planFailed|replan|migrate\.retry/)
    expect(body("openAccounts")).toContain('router.navigate({ name: "accounts" })')
    // Another pick, or a run, clears it.
    for (const name of ["selectAccount", "pickAlternative", "execute"]) expect(body(name)).toContain("refused: false")
    expect(importKo["own.otherTools.migrate.claudeRefused"]).toBe("이 Claude 계정으로 정하지 못해서 가져오지 않았어요")
    expect(importKo["own.otherTools.migrate.openAccounts"]).toBe("계정 화면 열기")
    expect(importKo["own.otherTools.migrate.altTarget"]).toBe("다른 계정 고르기")
  })
})

describe("mode rows (09 §4.3, §6)", () => {
  test("the recommended row is chosen; a summary that is not needed is dimmed with its reason", () => {
    const fits = plan()
    const rows = modeRows(fits)
    expect(selectedRow(fits, undefined)?.mode).toBe("full")
    expect(summaryState(rows)).toEqual({ available: false, reason: "fits" })
    expect(summarizes(selectedRow(fits, undefined))).toBe(false)
  })

  test("too big for the window: 요약해서 이어가기 is recommended; LLM 없이 stays a choice; the button follows the row", () => {
    const big = plan({
      modes: [
        {
          mode: "full",
          available: false,
          recommended: false,
          reason: "does_not_fit",
          send: send(0, 900_000),
          cost: free,
        },
        {
          mode: "summary",
          source: "llm",
          available: true,
          recommended: true,
          send: send(400_000, 200_000, true),
          cost: { ...free, summary: credits(1.2, 1.6) },
        },
        {
          mode: "summary",
          source: "brief",
          available: true,
          recommended: false,
          send: send(0, 210_000, true),
          cost: free,
        },
      ],
    })
    const rows = modeRows(big)
    expect(selectedRow(big, undefined)?.source).toBe("llm")
    expect(summaryState(rows)).toEqual({ available: true, reason: undefined })
    expect(summarySource(rows)).toBe("llm")
    expect(summarizes(selectedRow(big, undefined))).toBe(true)
    const brief = selectedRow(big, { mode: "summary", source: "brief" })
    expect(brief?.source).toBe("brief")
    expect(summarizes(brief)).toBe(false)
    expect(selectedRow(big, { mode: "full" })).toMatchObject({ available: false, reason: "does_not_fit" })
    expect(choiceOf(rows.llm!)).toEqual({ mode: "summary", source: "llm" })
    expect(choiceOf(rows.full!)).toEqual({ mode: "full" })
  })

  test("an LLM summary that cannot run leaves LLM 없이 as the summary's source", () => {
    const blocked = plan({
      modes: [
        {
          mode: "full",
          available: false,
          recommended: false,
          reason: "does_not_fit",
          send: send(0, 900_000),
          cost: free,
        },
        {
          mode: "summary",
          source: "llm",
          available: false,
          recommended: false,
          reason: "same_company_subscription",
          send: send(400_000, 200_000),
          cost: free,
        },
        { mode: "summary", source: "brief", available: true, recommended: true, send: send(0, 210_000), cost: free },
      ],
    })
    const rows = modeRows(blocked)
    expect(summarySource(rows)).toBe("brief")
    expect(summaryState(rows).available).toBe(true)
    expect(rows.llm?.reason).toBe("same_company_subscription")
  })

  test("the send notice is there for every mode, with 다른 회사 when it goes elsewhere (IG10)", () => {
    const rows = plan({
      modes: [
        { mode: "full", available: true, recommended: true, send: send(0, 182_000, true), cost: free },
        {
          mode: "summary",
          source: "llm",
          available: true,
          recommended: false,
          send: send(150_000, 40_000, true),
          cost: free,
        },
        {
          mode: "summary",
          source: "brief",
          available: true,
          recommended: false,
          send: send(0, 60_000, true),
          cost: free,
        },
      ],
    }).modes
    const notices = rows.map(sendNotice)
    expect(notices.map((notice) => notice.key)).toEqual(["first", "now", "first"])
    expect(notices.every((notice) => notice.crossCompany && notice.accountID === "acc_fake01")).toBe(true)
    expect(notices[1]).toMatchObject({ now: 150_000, withFirst: 40_000, company: "openai" })
    // Every key the notice and the rows use is worded.
    const keys: ImportKey[] = [
      "own.otherTools.migrate.sendFirst",
      "own.otherTools.migrate.sendNow",
      "own.otherTools.migrate.crossCompany",
      ...OwnImport.Reason.literals.map((reason): ImportKey => `own.otherTools.migrate.reason.${reason}`),
    ]
    for (const key of keys) expect(importKo[key].length).toBeGreaterThan(0)
  })

  test("after a failed summary: LLM 없이, 그대로 when it fits, another target", () => {
    expect(alternatives(modeRows(plan()))).toEqual(["full", "target"])
    const both = plan({
      modes: [
        { mode: "full", available: true, recommended: true, send: send(0, 1), cost: free },
        { mode: "summary", source: "brief", available: true, recommended: false, send: send(0, 1), cost: free },
      ],
    })
    expect(alternatives(modeRows(both))).toEqual(["brief", "full", "target"])
    expect(alternatives(undefined)).toEqual(["target"])
  })
})

describe("planning", () => {
  test("the plan input carries the controls; storeFull and redact are sent as they are (Q3: on by default)", () => {
    const ref = { kind: "codex" as const, rootID: "codex-default", id: "thread-1" }
    const base = { ref, directory: "C:\\fixture\\proj", target: { providerID: "own-codex-a", id: "gpt-fake" } }
    expect(planInput({ ...base, storeFull: true, redact: true })).toEqual({
      ref,
      directory: "C:\\fixture\\proj",
      target: { providerID: "own-codex-a", id: "gpt-fake" },
      storeFull: true,
      redact: true,
    })
    expect(
      planInput({
        ...base,
        target: { ...base.target, variant: "high" },
        choice: { mode: "summary", source: "brief" },
        upToTurn: 0,
        location: "C:\\fixture\\proj",
        storeFull: false,
        redact: false,
      }),
    ).toEqual({
      ref,
      directory: "C:\\fixture\\proj",
      target: { providerID: "own-codex-a", id: "gpt-fake", variant: "high" },
      mode: "summary",
      source: "brief",
      upToTurn: 0,
      location: "C:\\fixture\\proj",
      storeFull: false,
      redact: false,
    })
  })

  test("the picked account plans too: Claude 2's costs, quota and send notice, and a re-plan when only it changes (LV)", async () => {
    // The fifth limits review: the plan took a Model.Ref only, so with Claude 2 picked it priced Claude 1.
    const ref = { kind: "claude-code" as const, rootID: "claude-default", id: "thread-1" }
    const base = { ref, directory: "C:\\fixture\\proj", target: { providerID: "anthropic", id: "claude-opus-5-5" } }
    const two = account("acc_claude_two", "claude-sub", { providerID: "anthropic" as Account.View["providerID"] })
    const decodeInput = Schema.decodeUnknownSync(OwnImport.Definition.methods["migrate.plan"].input)
    const sent = planInput({ ...base, accountID: two.id, storeFull: true, redact: true })
    expect(sent).toMatchObject({ target: base.target, accountID: "acc_claude_two" })
    expect(decodeInput(sent)).toMatchObject({ accountID: "acc_claude_two" })
    expect(planInput({ ...base, storeFull: true, redact: true })).not.toHaveProperty("accountID")
    // The dialog names the picked account in its inputs, so Claude 1 → Claude 2 (the same target) plans again.
    const source = (await Bun.file(path.join(import.meta.dir, "dialog.tsx")).text()).replaceAll(/^\s*\/\/.*$/gm, "")
    const inputs = source.slice(source.indexOf("const inputs = createMemo<MigrateInputs")).split("\n  )\n")[0]!
    expect(inputs).toContain("const picked = account()")
    expect(inputs).toContain("...(picked ? { accountID: picked.id } : {})")
  })

  test("every change re-plans once, 300 ms after the last one; the first plan goes at once", () => {
    const fake = fakeTimers()
    const runs: number[] = []
    const planner = debounce((value: number) => runs.push(value), 300, fake.timers)
    planner.now(1)
    expect(runs).toEqual([1])
    planner.push(2)
    fake.advance(200)
    planner.push(3)
    fake.advance(200)
    planner.push(4)
    expect(planner.pending()).toBe(true)
    fake.advance(299)
    expect(runs).toEqual([1])
    fake.advance(1)
    expect(runs).toEqual([1, 4])
    expect(planner.pending()).toBe(false)
    // `now` replaces a pending push; `cancel` drops it.
    planner.push(5)
    planner.now(6)
    fake.advance(1_000)
    planner.push(7)
    planner.cancel()
    fake.advance(1_000)
    expect(runs).toEqual([1, 4, 6])
    expect(fake.pending()).toBe(0)
  })

  test("a plan that answers after the user changed the target is shown but never current (IG9)", async () => {
    const fake = fakeTimers()
    const asked: Array<{ readonly value: string; readonly resolve: (plan: string) => void }> = []
    const answers: Array<{ readonly value: string; readonly plan?: string; readonly current: boolean }> = []
    const inputs = { now: "deepseek" }
    const planner = createPlanner({
      ask: (value: string) => new Promise<string>((resolve) => asked.push({ value, resolve })),
      inputs: () => inputs.now,
      started: () => undefined,
      answered: (answer) =>
        answers.push({
          value: answer.value,
          ...(answer.result.ok ? { plan: answer.result.plan } : {}),
          current: answer.current,
        }),
      timers: fake.timers,
    })
    const settle = () => Bun.sleep(0)
    planner.changed("deepseek", true)
    // The user picks ChatGPT while the DeepSeek plan runs; its answer lands before the re-plan's debounce fires.
    inputs.now = "chatgpt"
    planner.changed("chatgpt", false)
    asked[0]?.resolve("plan-deepseek")
    await settle()
    expect(answers).toEqual([{ value: "deepseek", plan: "plan-deepseek", current: false }])
    fake.advance(PLAN_DELAY)
    expect(asked.map((item) => item.value)).toEqual(["deepseek", "chatgpt"])
    asked[1]?.resolve("plan-chatgpt")
    await settle()
    expect(answers.at(-1)).toEqual({ value: "chatgpt", plan: "plan-chatgpt", current: true })
    // Without a debounce in between, an answer for older inputs is not current either (a mode changed meanwhile).
    planner.again("chatgpt")
    inputs.now = "chatgpt summary"
    asked[2]?.resolve("plan-chatgpt-again")
    await settle()
    expect(answers.at(-1)).toEqual({ value: "chatgpt", plan: "plan-chatgpt-again", current: false })
    // An answer overtaken by a newer request is dropped; after cancel nothing lands.
    planner.again("chatgpt summary")
    planner.again("chatgpt summary")
    asked[3]?.resolve("overtaken")
    await settle()
    expect(answers.map((item) => item.plan)).not.toContain("overtaken")
    planner.cancel()
    asked[4]?.resolve("late")
    await settle()
    expect(answers).toHaveLength(3)
  })
})

describe("the job (09 §4.8, §5.3, §6 진행)", () => {
  const event = (name: "job.progress" | "job.finished", data: Record<string, unknown>) =>
    importEvent({
      type: `${IMPORT_EVENT_PREFIX}${name}`,
      id: "evt",
      created: NOW,
      // SAFETY: the data layer reads `type`, `data` and `created` of rpc events.
      data: { eventId: "01J0000000000000000000000A", origin: "global", ...data },
    } as unknown as OpenCodeEvent) as ImportEvent

  test("a reload restores the running job from jobs.list; progress and the end follow its events", () => {
    const listed = decodeJobs({
      jobs: [
        {
          jobID: "job_01J0000000000000000000000A",
          ref: { kind: "claude-code", rootID: "claude-default", id: "sess-1" },
          step: "reading",
          startedAt: NOW - 5_000,
        },
      ],
    })
    expect(restoreJob(decodeJobs({ jobs: [] }).jobs)).toBeUndefined()
    const restored = restoreJob(listed.jobs)
    expect(restored).toEqual({
      jobID: "job_01J0000000000000000000000A",
      ref: { kind: "claude-code", rootID: "claude-default", id: "sess-1" },
      step: "reading",
      startedAt: NOW - 5_000,
    })
    // A restored job does not know whether it summarizes: the bar shows `요약 중` until it is known.
    expect(jobSteps(restored!)).toEqual(["reading", "summarizing", "importing"])
    const summarizing = jobEvent(
      restored,
      event("job.progress", { jobID: "job_01J0000000000000000000000A", step: "summarizing", helperSessionID: "ses_h" }),
    )
    expect(summarizing).toMatchObject({ step: "summarizing", summarizes: true })
    // Another job's events change nothing.
    expect(jobEvent(summarizing, event("job.progress", { jobID: "job_other", step: "importing" }))).toBe(summarizing)
    const finished = jobEvent(
      summarizing,
      event("job.finished", { jobID: "job_01J0000000000000000000000A", outcome: "succeeded", sessionID: "ses_new" }),
    )
    expect(finished).toMatchObject({ outcome: "succeeded", sessionID: "ses_new" })
    // Nothing after the end.
    expect(
      jobEvent(finished, event("job.progress", { jobID: "job_01J0000000000000000000000A", step: "reading" })),
    ).toBe(finished)
  })

  test("a job without an LLM summary has two steps; a failed summary says its cause", () => {
    const job: JobView = {
      jobID: "job_1",
      ref: { kind: "codex", rootID: "codex-default", id: "t" },
      step: "reading",
      startedAt: NOW,
      summarizes: false,
    }
    expect(jobSteps(job)).toEqual(["reading", "importing"])
    const failed = jobEvent(
      { ...job, summarizes: true },
      event("job.finished", {
        jobID: "job_1",
        outcome: "failed",
        error: { type: "summary_failed", message: "x", cause: "exhausted" },
      }),
    )
    expect(failed?.outcome).toBe("failed")
    expect(jobErrorKey(failed?.error)).toBe("own.otherTools.error.summary.exhausted")
    expect(jobErrorKey({ type: "source_changed", message: "x" })).toBe("own.otherTools.error.source_changed")
    expect(jobErrorKey(undefined)).toBe("own.otherTools.error.other")
    const text = (key: ImportKey) => key
    expect(errorText(text, new OwnRpcError("nonce_invalid", "x"))).toBe("own.otherTools.error.nonce_invalid")
    expect(errorText(text, new OwnRpcError("job_busy", "x"))).toBe("own.otherTools.error.job_busy")
    // A server's own words never reach the screen (they may hold a path).
    expect(errorText(text, new Error("C:\\Users\\fake\\.codex\\x"))).toBe("own.otherTools.error.other")
  })
})

describe("helper sessions never appear (09 §6 숨김, IG8)", () => {
  const helperMeta = { [IMPORT_META.session]: { v: 1, helper: true, jobID: "job_01J0000000000000000000000A" } }

  function info(id: string, metadata: Record<string, unknown> = {}): SessionInfo {
    // SAFETY: the fields the session index reads; a helper is listed unarchived here to prove the metadata decides.
    return {
      id,
      title: id,
      projectID: "prj_fake",
      location: { directory: "C:\\fixture\\proj" },
      time: { created: 1, updated: id === "ses_helper" ? 300 : 100 },
      metadata,
    } as unknown as SessionInfo
  }

  test("the session index, the sidebar flags and turn notifications leave them out", async () => {
    const serverKey = "srv-helper-test"
    const fetched: string[] = []
    // SAFETY: the index only calls `session.list`, `session.get` and `project.list`.
    const client = {
      project: { list: async () => [] },
      session: {
        list: async () => ({ data: [info("ses_helper", helperMeta), info("ses_user")], cursor: {} }),
        get: async ({ sessionID }: { sessionID: string }) => {
          fetched.push(sessionID)
          return info(sessionID)
        },
        update: async () => ({}),
      },
    } as unknown as OpenCodeClient
    const bus = createEventBus()
    const { index, flags, dispose } = createRoot((dispose) => ({
      index: createSessionIndex({
        serverKey,
        client: () => client,
        bus,
        cache: { read: async () => undefined, write: async () => {} },
      }),
      flags: createOwnFlags({ serverKey, bus, client: () => client }),
      dispose,
    }))
    await index.ready
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    bus.flush()
    await index.fresh
    expect(index.state.order).toEqual(["ses_user"])
    expect(index.state.sessions.ses_helper).toBeUndefined()
    expect(isHelperSession(serverKey, "ses_helper")).toBe(true)
    expect(isHelperSession(serverKey, "ses_user")).toBe(false)

    // A new helper is never fetched as a row; a reload during a job learns its helper from the progress event.
    // SAFETY: the index reads only `type` and `data` of these events.
    bus.publish({
      type: "session.created",
      id: "e1",
      data: { sessionID: "ses_helper2", projectID: "prj_fake", metadata: { ...helperMeta, "own.pinned": 5 } },
    } as unknown as OpenCodeEvent)
    bus.publish({
      type: `${IMPORT_EVENT_PREFIX}job.progress`,
      id: "e2",
      data: {
        eventId: "01J0000000000000000000000B",
        origin: "global",
        jobID: "job_01J0000000000000000000000A",
        step: "summarizing",
        helperSessionID: "ses_helper3",
      },
    } as unknown as OpenCodeEvent)
    bus.flush()
    await Promise.resolve()
    expect(fetched).toEqual([])
    expect(isHelperSession(serverKey, "ses_helper2")).toBe(true)
    expect(isHelperSession(serverKey, "ses_helper3")).toBe(true)
    expect(index.state.sessions.ses_helper2).toBeUndefined()

    // Flags: a helper's (copied) pin is never taken.
    expect(flags.pinned("ses_helper2")).toBe(false)
    flags.ingestInfos([info("ses_helper", { ...helperMeta, "own.pinned": 7 }), info("ses_user", { "own.pinned": 9 })])
    expect(flags.pinned("ses_helper")).toBe(false)
    expect(flags.pinned("ses_user")).toBe(true)

    // Turn ends: a helper's never notifies, a user session's does.
    const handlers = new Map<string, (event: { data: { sessionID: string } }) => void>()
    const runtime = {
      bus: {
        on(type: string, handler: (event: { data: { sessionID: string } }) => void) {
          handlers.set(type, handler)
          return () => handlers.delete(type)
        },
      },
      sessions: index,
      data: {
        session: {
          get: (id: string) => (id === "ses_helper4" ? { id, metadata: helperMeta } : undefined),
        },
      },
      team: { placeOf: () => undefined },
    } as unknown as ServerRuntime
    const data = {
      servers: { list: () => [{ key: serverKey }] },
      get: (key: string) => (key === serverKey ? runtime : undefined),
    } as unknown as DataLayer
    const sent: HostNotification[] = []
    const stop = createRoot((dispose) => {
      createTurnNotifier({
        data,
        capability: "native",
        notify: (input) => sent.push(input),
        hidden: () => true,
        focused: () => false,
        route: () => ({ name: "home" }),
        locale: () => "ko",
        open: () => {},
      })
      return dispose
    })
    const end = handlers.get("session.execution.succeeded")
    for (const sessionID of ["ses_helper", "ses_helper2", "ses_helper3", "ses_helper4", "ses_user"])
      end?.({ data: { sessionID } })
    expect(sent.map((item) => item.tag)).toEqual([`own:turn:${serverKey}:ses_user`])
    stop()

    // The index lets go of its helpers with itself.
    flags.dispose()
    index.dispose()
    dispose()
    expect(isHelperSession(serverKey, "ses_helper")).toBe(false)
  })

  test("the first-screen line shows until the conversation has a turn of its own", () => {
    const user = (created: number): SessionMessageInfo => ({
      id: `m${created}`,
      type: "user",
      text: "x",
      time: { created },
    })
    expect(importedLine({ importedAt: NOW }, [user(NOW - 50_000), user(NOW - 10_000)])).toBe(true)
    expect(importedLine({ importedAt: NOW }, [user(NOW - 50_000), user(NOW + 1)])).toBe(false)
    // Not before its messages are there (no flash on a conversation that already went on), never for other sessions.
    expect(importedLine({ importedAt: NOW }, [])).toBe(false)
    expect(importedLine(undefined, [user(NOW - 50_000)])).toBe(false)
  })
})

describe("scope gate (09 §5.5): a connection that may not plan never sees 이어서 하기", () => {
  const rpc = (scopes: ReadonlySet<OwnScope>) =>
    createImportRpc({
      // SAFETY: only `allowed` is used here; no call goes out.
      client: () => ({}) as unknown as OpenCodeClient,
      control: async () => "C:\\ctl",
      scopes: () => scopes,
    })
  const health = (features: readonly string[]) => decodeHealth({ version: "0.0.0", features, workerReady: false })

  test("migrate needs the build's feature and the method's scope", () => {
    expect(importGates(health(["view", "search", "migrate"]), rpc(ALL_SCOPES).allowed).migrate).toBe(true)
    expect(importGates(health(["view", "search"]), rpc(ALL_SCOPES).allowed).migrate).toBe(false)
    const readOnly = new Set<OwnScope>(["read"])
    expect(importGates(health(["view", "search", "migrate"]), rpc(readOnly).allowed).migrate).toBe(false)
    expect(importGates(undefined, rpc(ALL_SCOPES).allowed).migrate).toBe(false)
  })
})
