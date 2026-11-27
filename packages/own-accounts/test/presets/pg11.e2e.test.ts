// End to end on a real upstream server: gate PG11 of 07 §8.4 (money, 07 §3.4, §5.4 step 4). A paid account (DeepSeek,
// prepaid, with a $1 monthly budget) is never suggested, never in a starter and never a fallback outside a role's own
// list; a role pinned to it runs within its budget and is declined once the budget is used up (with an alert); a role
// whose subscription target cannot run and whose next target is the paid account waits for the user's consent for
// this conversation, with no paid request before it; `session.preset.get` reports the conversation's paid amount.
//
// own-accounts loads from its package directory (`startPresetRig`) with one linked ChatGPT account (01, the main) on a
// fake Codex backend, and the DeepSeek account added through `accounts.add.key` against a fake DeepSeek chat backend.
// The scripted models read directives in the last user text; a child reply on DeepSeek can report a large usage so
// one call spends past the budget. "Claude BLOCKED": the e2e kit installs no Claude slot, so a target pinned to it
// cannot run, the same skip the gate makes for an exhausted slot (`unavailable`); such presets are written into
// `presets.json` by hand (`presets.set` refuses a target that cannot run). Every credential is fake; the servers bind
// 127.0.0.1; no real account or money is used.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Preset } from "@own/protocol"
import {
  afterToolResult,
  childOf,
  lastUserText,
  replaceFile,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  toolError,
  toolOutputs,
  toolParts,
  waitUntil,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const ONE = { accountID: "acct-pg11-01", email: "one@example.test", plan: "plus" }
const MAIN = { providerID: "own-codex-pg01", id: "gpt-6-sol", variant: "high" }
const DS_KEY = "sk-fake-pg11-deepseek-0001"
const DS_MODEL = "deepseek-flash"
const BUDGET_USD = 1
/** Output tokens a `<<big>>` child reports: 2M × $0.6/M on deepseek-flash, past the $1 budget in one call. */
const BIG_OUTPUT = 2_000_000
const CLAUDE_PIN = { pin: { account: "acc_claude_slot", model: "claude-opus-5-5" } }

const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
const AFTER_TOOL = "도구 결과를 읽었습니다."
const CHILD_DONE = "자식 작업을 마쳤습니다."
const REVIEW = { agent: "own-review", description: "리뷰", prompt: "자식 작업: 리뷰" }
const BIG_REVIEW = { agent: "own-review", description: "큰 리뷰", prompt: "자식 작업: 리뷰 <<big>>" }

const fixture: {
  codex?: FakeCodex
  chat?: FakeOpenAIChat
  rig?: PresetRig
  /** The DeepSeek account added in setup. */
  ds?: { readonly id: string; readonly providerID: string }
  presets: Map<string, string>
} = { presets: new Map() }

beforeAll(async () => {
  const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: 32 }, responder: reply })
  const chat = startFakeOpenAIChat({ responder: reply })
  Object.assign(fixture, { codex, chat })
  fixture.rig = await startPresetRig({
    name: "pg11",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login(ONE) }],
    endpoints: { deepseek: chat.baseURL },
    models: [MAIN],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop()])
}, 60_000)

describe("PG11: money (07 §3.4, §5.4 step 4, §8.4)", () => {
  test(
    "setup: a DeepSeek API key with a $1 monthly budget",
    async () => {
      const rig = required(fixture.rig)
      const added = await rig.call("accounts.add.key", { kind: "ds", label: "DeepSeek", key: DS_KEY })
      const account = isRecord(added.account) ? added.account : {}
      const ds = { id: String(account.id), providerID: String(account.providerID) }
      fixture.ds = ds
      await rig.call("accounts.update", { accountID: ds.id, budget: { monthlyUSD: BUDGET_USD } })
      const listed = await rig.call("accounts.list", {})
      expect(
        (Array.isArray(listed.accounts) ? listed.accounts : []).find((item) => isRecord(item) && item.id === ds.id),
      ).toMatchObject({
        kind: "ds",
        billing: "prepaid",
        budget: { monthlyUSD: BUDGET_USD },
      })
      await rig.server.waitForModels([{ providerID: ds.providerID, id: DS_MODEL }])
      expect(modelRequests()).toEqual([])
    },
    TURN_TIMEOUT,
  )

  test("suggestions and starters never name the paid account", async () => {
    const rig = required(fixture.rig)
    const ds = required(fixture.ds)
    for (const group of ["codex", "ds"] as const) {
      for (const template of [undefined, ...Preset.Starter.literals]) {
        const suggestion = decodeSuggestion(
          await rig.call("presets.suggest", { group, ...(template ? { template } : {}) }),
        )
        // T4: the model pool's checklist offers the paid key in its paid section (the user checks it by hand), but
        // its `추천 묶음` never names it (PG11-P); rows, drafts and starters never do.
        const { pool, ...rest } = suggestion
        const text = JSON.stringify({ ...rest, recommended: pool?.recommended })
        expect(text).not.toContain(ds.id)
        expect(text).not.toContain(ds.providerID)
        const paid = (pool?.candidates ?? []).filter((item) => item.account === ds.id)
        expect(paid.every((item) => item.runs === "paid")).toBe(true)
        expect(pool?.recommended.some((key) => paid.some((item) => item.key === key))).toBe(false)
        if (group !== "codex") continue
        // DeepSeek is another company, but a paid one: `다른 회사 리뷰` has no subscription to fill it with.
        expect(suggestion.starters.find((item) => item.template === "cross-review")).toMatchObject({
          available: false,
          problem: "no-other-subscription",
        })
      }
    }
  })

  test(
    "a fallback never leaves the role's list: the Claude-only review runs on the main, not on DeepSeek",
    async () => {
      const rig = required(fixture.rig)
      await handWrite("Claude 리뷰만", [CLAUDE_PIN])
      const root = await bound("Claude 리뷰만")
      await turn(root, "[review] 리뷰해 줘")
      const call = required((await toolParts(rig.server, root, "subagent")).at(-1))
      expect(call.state.status).toBe("completed")
      expect((await childOf(rig.server, call)).model).toEqual(MAIN)
      expect(lastToolOutput()).toContain("Note: no target of the own-review role is available now")
      expect(modelRequests()).toEqual([])
      expect((await preset(root)).spend).toBe(0)
    },
    TURN_TIMEOUT,
  )

  test(
    "Claude blocked, DeepSeek second: declined until the user allows it here; `no` keeps it off DeepSeek",
    async () => {
      const rig = required(fixture.rig)
      const ds = required(fixture.ds)
      await handWrite("Claude 리뷰", [CLAUDE_PIN, { pin: { account: ds.id, model: DS_MODEL } }])

      const asked = await bound("Claude 리뷰")
      await turn(asked, "[review] 리뷰해 줘")
      const declined = required((await toolParts(rig.server, asked, "subagent")).at(-1))
      expect(declined.state.status).toBe("error")
      expect(toolError(declined)).toBe(
        `Unknown agent: ${Preset.rejection({ reason: "consent", roles: ["own-review"] })}`,
      )
      expect(modelRequests()).toEqual([])
      await expectRejectedAlert(asked, "consent")

      // `[아니오]`: the role goes on past DeepSeek, to the main.
      const refused = await bound("Claude 리뷰")
      expect(await rig.call("session.preset.consent", { sessionID: refused, accountID: ds.id, allow: false })).toEqual({
        accountID: ds.id,
        allow: false,
      })
      await turn(refused, "[review] 리뷰해 줘")
      const onMain = required((await toolParts(rig.server, refused, "subagent")).at(-1))
      expect((await childOf(rig.server, onMain)).model).toEqual(MAIN)
      expect(modelRequests()).toEqual([])

      // `[이 대화에서만]`: the next call runs on DeepSeek, saying so with its result.
      expect(await rig.call("session.preset.consent", { sessionID: asked, accountID: ds.id, allow: true })).toEqual({
        accountID: ds.id,
        allow: true,
      })
      await turn(asked, "[review] 다시 리뷰해 줘")
      const allowed = required((await toolParts(rig.server, asked, "subagent")).at(-1))
      expect(allowed.state.status).toBe("completed")
      expect((await childOf(rig.server, allowed)).model).toMatchObject({ providerID: ds.providerID, id: DS_MODEL })
      expect(lastToolOutput()).toContain("Note: the own-review role's first target is not available now")
      expect(modelRequests().length).toBeGreaterThan(0)
      expect(modelRequests().every((request) => request.body.includes(REVIEW.prompt))).toBe(true)
    },
    TURN_TIMEOUT,
  )

  test(
    "a role pinned to DeepSeek runs within the budget, then is declined with an alert; the amount is reported",
    async () => {
      const rig = required(fixture.rig)
      const ds = required(fixture.ds)
      const saved = await rig.call("presets.set", {
        preset: {
          name: "DeepSeek 리뷰",
          group: "codex",
          workers: {
            mode: "by-role",
            roles: { "own-review": { targets: [{ pin: { account: ds.id, model: DS_MODEL } }], effort: "inherit" } },
          },
          delegation: "on-request",
          caps: Preset.CAPS,
          ultraCaps: null,
        },
      })
      // Added by hand, so the editor warns that it costs money.
      expect(saved.warnings).toEqual([{ code: "paid", place: "own-review" }])
      fixture.presets.set("DeepSeek 리뷰", decodeInfo(saved.preset).id)
      const root = await bound("DeepSeek 리뷰")

      await turn(root, "[review-big] 크게 리뷰해 줘")
      const ran = required((await toolParts(rig.server, root, "subagent")).at(-1))
      expect(ran.state.status).toBe("completed")
      const child = await childOf(rig.server, ran)
      expect(child.model).toMatchObject({ providerID: ds.providerID, id: DS_MODEL })
      await waitUntil(async () => {
        const snapshot = await rig.call("quota.snapshot", { accountIDs: [ds.id] })
        const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
        return windows.some((window) => isRecord(window) && window.kind === "budget" && window.status === "exhausted")
      }, "the DeepSeek budget window never reported exhausted")

      const requests = modelRequests().length
      await turn(root, "[review] 한 번 더 리뷰해 줘")
      const declined = required((await toolParts(rig.server, root, "subagent")).at(-1))
      expect(declined.state.status).toBe("error")
      expect(toolError(declined)).toBe(
        `Unknown agent: ${Preset.rejection({ reason: "budget", roles: ["own-review"] })}`,
      )
      expect(modelRequests()).toHaveLength(requests)
      await expectRejectedAlert(root, "budget")
      expect(rig.server.logs()).toContain("preset_budget_exhausted")
      // Allowing a paid account whose budget is used up is refused.
      const consent = await rig.rpc("session.preset.consent", { sessionID: root, accountID: ds.id, allow: true })
      expect(consent.error).toMatchObject({ type: "preset_budget_exhausted" })

      // `session.preset.get`: this conversation's amount on paid accounts, the child's ledger lines.
      const ledger = await rig.call("ledger.session", { sessionID: child.id })
      const steps = Array.isArray(ledger.steps) ? ledger.steps.filter(isRecord) : []
      const spent = steps
        .flatMap((line) => (isRecord(line.cost) && line.cost.unit === "USD" ? [Number(line.cost.amount)] : []))
        .reduce((sum, amount) => sum + amount, 0)
      expect(spent).toBeGreaterThan(BUDGET_USD)
      const view = await preset(root)
      expect(view.spend).toBeCloseTo(spent, 6)
      expect(view.counts.session).toBe(1)
    },
    TURN_TIMEOUT,
  )

  test("no paid request beyond the two calls the user allowed; no hook failed", () => {
    const requests = modelRequests()
    expect(requests.filter((request) => request.body.includes("<<big>>"))).toHaveLength(1)
    expect(
      requests
        .filter((request) => !request.body.includes("<<big>>"))
        .every((request) => request.body.includes(REVIEW.prompt)),
    ).toBe(true)
    expect(required(fixture.rig).server.logs()).not.toMatch(/hook_failed|subagent_gate_undecided/)
  })
})

// ---------------------------------------------------------------------------------------------------------------

/**
 * The scripted models (both backends). A tool result gets a short text; a child its "done" (a `<<big>>` child reports
 * {@link BIG_OUTPUT} output tokens); the parent's directive calls the review role.
 */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(request)
  if (text.includes(SUBAGENT_PROMPT))
    return { type: "text", text: CHILD_DONE, ...(text.includes("<<big>>") ? { outputTokens: BIG_OUTPUT } : {}) }
  if (text.includes("[review-big]")) return { type: "tool-call", name: "subagent", input: BIG_REVIEW }
  if (text.includes("[review]")) return { type: "tool-call", name: "subagent", input: REVIEW }
  return { type: "text", text: "답변" }
}

/** A root on ChatGPT 01 bound to the named preset (own-web's order: create, then apply). */
async function bound(name: string) {
  const rig = required(fixture.rig)
  const session = await rig.server.createSession({ model: MAIN })
  await rig.call("session.preset.apply", { sessionID: session.id, presetID: required(fixture.presets.get(name)) })
  return session.id
}

async function turn(sessionID: string, text: string) {
  const server = required(fixture.rig).server
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
}

/** Adds a review preset to `presets.json` by hand and waits until the service loaded it. */
async function handWrite(name: string, targets: ReadonlyArray<unknown>) {
  const rig = required(fixture.rig)
  const file = path.join(rig.home, "presets.json")
  // After the leader wrote the default model of both groups, so the hand edit races no write: the DeepSeek account
  // added in setup settles its group, and the codex group's default may be written only after it (a hand edit read
  // before that write and renamed while it ran was lost: the preset never loaded).
  const current = await waitUntil(async () => {
    const json: unknown = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (!isRecord(json) || !isRecord(json.groups)) return undefined
    const groups = json.groups
    return ["codex", "ds"].every((group) => {
      const entry = groups[group]
      return isRecord(entry) && entry.defaultModel !== undefined
    })
      ? json
      : undefined
  }, "the leader never wrote the codex and ds groups' default models")
  const id = Preset.ID.create()
  const groups = isRecord(current.groups) ? current.groups : {}
  const codex = isRecord(groups.codex) ? groups.codex : {}
  const presets = Array.isArray(codex.presets) ? codex.presets : []
  const preset = {
    id,
    name,
    group: "codex",
    workers: { mode: "by-role", roles: { "own-review": { targets, effort: "inherit" } } },
    delegation: "on-request",
    caps: Preset.CAPS,
    ultraCaps: null,
    revision: 1,
  }
  await replaceFile(
    file,
    JSON.stringify({ ...current, groups: { ...groups, codex: { ...codex, presets: [...presets, preset] } } }, null, 2),
  )
  await waitUntil(async () => {
    const listed = await rig.call("presets.list", { group: "codex" })
    return JSON.stringify(listed).includes(id)
  }, `${name} was never loaded`)
  fixture.presets.set(name, id)
}

async function preset(sessionID: string) {
  return decodeView(await required(fixture.rig).call("session.preset.get", { sessionID }))
}

/** The `subagent_rejected` alert of this root for `reason` (named in its message), naming the DeepSeek account. */
async function expectRejectedAlert(sessionID: string, reason: "consent" | "budget") {
  const alert = await required(fixture.rig).events.waitFor(
    (event) =>
      event.type === "rpc.own.accounts.alert" &&
      event.data.code === "subagent_rejected" &&
      event.data.sessionID === sessionID &&
      String(event.data.message).includes(`(${reason})`),
  )
  expect(alert.data).toMatchObject({ severity: "info", accountID: required(fixture.ds).id })
}

/** Model requests DeepSeek received (the account probe excluded). */
function modelRequests() {
  return required(fixture.chat).requests.filter((request) => request.model !== undefined)
}

/** The tool results the last Codex request carried. */
function lastToolOutput() {
  const last = required(fixture.codex)
    .requests.filter((request) => request.model !== undefined && toolOutputs(request).length > 0)
    .at(-1)
  return toolOutputs(required(last)).join("\n")
}

const decodeInfo = Schema.decodeUnknownSync(Preset.Info)
const decodeView = Schema.decodeUnknownSync(Preset.SessionView)
const decodeSuggestion = Schema.decodeUnknownSync(Preset.Suggestion)

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
