import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { Account, type Estimate } from "@own/protocol"
import { Compaction } from "@own/protocol/compaction"
import { OwnImport } from "@own/protocol/rpc-import"
import { Token } from "@own/protocol/token"
import { Schema } from "effect"
import { Fill } from "../../src/migrate/fill.js"
import { Plan } from "../../src/migrate/plan.js"
import { Notice } from "../../src/render/notice.js"
import { Store } from "../../src/render/store.js"
import { Paths } from "../../src/sources/paths.js"
import { CodexTranscript } from "../../src/transcript/codex.js"
import type { Transcript } from "../../src/transcript/ir.js"
import { T0, compactionItem, localSummary, rollout, threadId, userItem } from "../fixtures/codex.js"
import { FAKE } from "../fixtures/make.js"

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: synthetic transcripts, a location catalog, own.accounts answers. Nothing is read from disk.

const ROOT = "C:\\work\\proj"
const SUB = "C:\\work\\proj\\sub"
const PROJECT = { id: "prj_fixture", root: ROOT, folders: [ROOT] }
const EXISTING = new Set([ROOT, SUB, "D:\\elsewhere"].map(Paths.key))
const SOURCE = Schema.decodeUnknownSync(OwnImport.SourceRef)({
  kind: "codex",
  rootID: "codex-0123456789ab",
  id: "019a0000-0000-7000-8000-000000000001",
})

const decodeModel = Schema.decodeUnknownSync(Model.Info)
const decodeRef = Schema.decodeUnknownSync(Model.Ref)
const decodeAccount = Schema.decodeUnknownSync(Account.View)
const decodePlan = Schema.decodeUnknownSync(OwnImport.Plan)
const encodePlan = Schema.encodeSync(OwnImport.Plan)

const ref = (providerID: string, id: string) => decodeRef({ providerID, id })
const TARGET = ref("own-codex-aaaa", "gpt-6")

function model(
  providerID: string,
  id: string,
  more: {
    readonly context?: number
    readonly input?: number
    readonly tools?: boolean
    readonly images?: boolean
    readonly native?: boolean
    readonly canonical?: string
  } = {},
) {
  return decodeModel({
    id,
    modelID: id,
    providerID,
    name: id,
    ...(more.canonical === undefined ? {} : { canonical: more.canonical }),
    capabilities: {
      tools: more.tools ?? true,
      input: more.images === false ? ["text"] : ["text", "image"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context: more.context ?? 1_000_000,
      ...(more.input === undefined ? {} : { input: more.input }),
      output: 32_000,
    },
    ...(more.native ? { settings: { compaction: { type: "native" } } } : {}),
  })
}

function account(
  id: string,
  kind: string,
  providerID: string,
  more: { readonly billing?: string; readonly status?: string; readonly login?: string } = {},
) {
  return decodeAccount({
    id,
    kind,
    label: id,
    shortLabel: id.slice(4, 6),
    color: "teal",
    providerID,
    billing: more.billing ?? "subscription",
    status: more.status ?? "ready",
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    ...(more.login === undefined ? {} : { identity: { login: more.login } }),
    connection: { type: "oauth" },
  })
}

const ACCOUNTS = {
  codex: account("acc_codex_a", "codex", "own-codex-aaaa", { login: "login-1" }),
  otherLogin: account("acc_codex_b", "codex", "own-codex-bbbb", { login: "login-2" }),
  sameLogin: account("acc_siwc_c", "siwc", "own-siwc-cccc", { login: "login-1" }),
  key: account("acc_oai_key", "oai", "own-oai-dddd", { billing: "metered" }),
  claude: account("acc_claude_slot", "claude-sub", "anthropic"),
}

/** own.accounts' slot answers: a fixed price per token so every cost cell is easy to tell apart. */
interface Slot {
  readonly window: number
  readonly ceiling?: number
  readonly Z?: number
  readonly exchange?: number
  readonly zSource?: "measured" | "default"
  readonly unit?: Estimate.Unit
  readonly remaining?: { readonly fiveHour: number | null; readonly weekly: number | null } | null
}

interface Call {
  readonly target: Model.Ref
  readonly requests: ReadonlyArray<{ readonly prompt: number; readonly output: number; readonly cachedPrefix?: number }>
}

function setup(
  input: {
    readonly slots?: Readonly<Record<string, Slot>>
    readonly models?: ReadonlyArray<Model.Info>
    readonly compaction?: Model.Ref
    readonly accounts?: ReadonlyArray<Account.View> | null
    readonly branch?: string
    readonly budget?: number
    readonly now?: number
  } = {},
) {
  const calls: Call[] = []
  const nonces: Plan.Nonces = new Map()
  const slots = input.slots ?? { "own-codex-aaaa": { window: 1_000_000 } }
  const deps: Plan.Deps = {
    nonces,
    estimate: async (asked) => {
      calls.push({ target: asked.target, requests: asked.requests })
      const slot = slots[asked.target.providerID]
      if (slot === undefined) return { ok: false, status: 400, type: "account_not_found", message: "no such account" }
      const unit = slot.unit ?? "credits"
      const price = asked.requests.reduce(
        (sum, item) =>
          sum + (item.prompt - (item.cachedPrefix ?? 0)) + (item.cachedPrefix ?? 0) * 0.1 + item.output * 4,
        0,
      )
      return {
        ok: true,
        value: {
          unit,
          delta: { lo: price / 1_000_000, hi: (price * 1.25) / 1_000_000, unit },
          quota: null,
          remaining: slot.remaining ?? null,
          Z: slot.Z ?? 10_000,
          zSource: slot.zSource ?? "measured",
          exchange: slot.exchange ?? 2_000,
          window: slot.window,
          ceiling: slot.ceiling ?? Compaction.ceiling(slot.window),
        },
      }
    },
    accounts: async () => (input.accounts === null ? undefined : (input.accounts ?? Object.values(ACCOUNTS))),
    catalog: async () => ({
      models: input.models ?? [model("own-codex-aaaa", "gpt-6", { canonical: "openai" })],
      ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
    }),
    branch: async (directory) => (Paths.same(directory, SUB, () => undefined) ? (input.branch ?? "feature") : "main"),
    exists: async (directory) => EXISTING.has(Paths.key(directory)),
    resolve: () => undefined,
    now: () => input.now ?? T0 + 86_400_000,
    ...(input.budget === undefined ? {} : { budget: input.budget }),
  }
  return { deps, calls, nonces }
}

/** About `tokens` tokens of ASCII text (`Token.estimate`: 4 characters a token). */
const filler = (tokens: number) => "lorem ".repeat(Math.max(0, Math.round((tokens * 4) / 6)))

function turn(index: number, tokens = 200, user: Partial<Transcript.User> = {}): Transcript.Turn {
  const at = T0 + index * 1000
  return {
    index,
    time: at,
    user: { text: `request ${index}`, images: [], ...user },
    steps: [
      {
        type: "tool",
        name: "exec_command",
        input: { cmd: "bun test" },
        output: { text: `3 pass ${filler(40)}`, error: false },
        exit: 0,
        time: at + 1,
      },
      { type: "text", text: `answer ${index} ${filler(tokens)}`, time: at + 2, model: "gpt-5.5" },
    ],
    end: "completed",
  }
}

function conversation(turns: number, tokens = 200) {
  return Array.from({ length: turns }, (_, index) => turn(index, tokens))
}

function transcript(
  turns: ReadonlyArray<Transcript.Turn>,
  more: {
    readonly kind?: Transcript.Kind
    readonly checkpoints?: ReadonlyArray<Transcript.Checkpoint>
    readonly cwds?: ReadonlyArray<string>
    readonly live?: boolean
    readonly dropped?: Transcript.Dropped
  } = {},
): Transcript.Info {
  const kind = more.kind ?? "codex"
  return {
    source: {
      kind,
      id: SOURCE.id,
      rootID: SOURCE.rootID,
      path: "C:\\fixture\\codex\\sessions\\2026\\10\\08\\rollout-x.jsonl",
      versions: ["0.153.0"],
      cwds: [...(more.cwds ?? ["\\\\?\\C:\\work\\proj", "\\\\?\\C:\\work\\proj\\sub"])],
      title: "설치기 정리",
      models: [{ provider: "openai", id: "gpt-5.5" }],
      createdAt: T0,
      updatedAt: T0 + 99_000,
      bytes: 4096,
      subagent: false,
      live: more.live ?? false,
    },
    turns: [...turns],
    checkpoints: [...(more.checkpoints ?? [])],
    children: [],
    dropped: more.dropped ?? { thinking: 2 },
  }
}

function foreign(turnIndex: number, step: number): Transcript.Checkpoint {
  return {
    at: { turn: turnIndex, step, source: { uuid: `uuid-${turnIndex}-${step}` } },
    kind: "foreign",
    summary: `The tool's summary up to ${turnIndex}.${step}.`,
    recent: [{ role: "user", text: "keep going" }],
  }
}

function input(info: Transcript.Info, request: Partial<Plan.Request> = {}): Plan.Input {
  return {
    request: { ref: SOURCE, directory: SUB, target: TARGET, ...request },
    transcript: info,
    project: PROJECT,
    existing: [],
  }
}

async function plan(info: Transcript.Info, request: Partial<Plan.Request> = {}, deps = setup().deps) {
  const result = await Plan.create(input(info, request), deps)
  if (!result.ok) throw new Error(`plan failed: ${result.error}`)
  // Every plan is a valid `migrate.plan` answer.
  expect(decodePlan(encodePlan(result.plan))).toEqual(result.plan)
  return result
}

const row = (value: OwnImport.Plan, mode: OwnImport.Mode, source?: OwnImport.SummarySource) => {
  const found = value.modes.find((item) => item.mode === mode && item.source === source)
  if (found === undefined) throw new Error(`no ${mode}/${source} row`)
  return found
}
const recommended = (value: OwnImport.Plan) =>
  value.modes.filter((item) => item.recommended).map((item) => [item.mode, item.source ?? null])

/** The model-visible tokens of `그대로` with the notice (its `send.withFirst`). */
const whole = (value: OwnImport.Plan) => row(value, "full").send.withFirst

// ---------------------------------------------------------------------------------------------------------------

describe("sizing and the mode table (09 §4.3, IM-D6)", () => {
  test("a conversation that fits continues as it is; the summary rows are not needed", async () => {
    const info = transcript(conversation(3))
    const result = await plan(info)
    const value = result.plan
    expect(recommended(value)).toEqual([["full", null]])
    expect(row(value, "full")).toMatchObject({ available: true, recommended: true })
    expect(row(value, "full").reason).toBeUndefined()
    expect(row(value, "summary", "llm")).toMatchObject({ available: false, reason: "fits" })
    expect(row(value, "summary", "brief")).toMatchObject({ available: false, reason: "fits" })
    const notice = Token.estimate(Notice.text("codex", ["exec_command"]))
    expect(value.size).toMatchObject({ Z: 10_000, zSource: "measured", exchange: 2_000, window: 1_000_000 })
    expect(value.size.ceiling).toBe(Compaction.ceiling(1_000_000))
    expect(value.size.visible).toBe(whole(value) - notice)
    expect(value.size.ratio).toBe((10_000 + whole(value)) / value.size.ceiling)
    expect(value.size.capacity).toBe(value.size.ceiling - (10_000 + notice + 2_000))
    expect(value.size.tail).toBeUndefined()
    expect(value.size.summaryInput).toBeUndefined()
    expect(value.boundary).toEqual({ at: null, checkpoint: null, sourceCompactions: 0 })
    expect(value.summarizer).toEqual({ model: TARGET, overridden: false })
    expect(value.title).toBe("설치기 정리")
    expect(value.turns).toBe(3)
    expect(value.store).toEqual({ full: true, bytes: value.store.bytes, budget: 32 * 1024 * 1024, trimmedTurns: 0 })
    expect(value.store.bytes).toBeGreaterThan(0)
    expect(value.dropped).toEqual({ thinking: 2 })
    expect(value.warnings).toEqual([])
    expect(result.planned.run).toEqual({ mode: "full", boundary: { type: "none" } })
  })

  test("the window ratio alone decides, with the same flip point for every window size (IG9, U6)", async () => {
    for (const window of [32_000, 200_000, 1_000_000]) {
      // A conversation of about 80% of the window: 25k tokens for a 32k model, 800k for a 1M model.
      const info = transcript(conversation(20, Math.round((window * 0.8) / 20)))
      const slot = { window, Z: Math.round(window * 0.05), exchange: Math.round(window * 0.01) }
      const probe = await plan(info, {}, setup({ slots: { "own-codex-aaaa": { ...slot, ceiling: 10 * window } } }).deps)
      const needed = slot.Z + whole(probe.plan)

      const fits = await plan(info, {}, setup({ slots: { "own-codex-aaaa": { ...slot, ceiling: needed } } }).deps)
      expect([window, fits.plan.size.ratio, recommended(fits.plan)]).toEqual([window, 1, [["full", null]]])
      expect(fits.plan.size.window).toBe(window)

      const over = await plan(info, {}, setup({ slots: { "own-codex-aaaa": { ...slot, ceiling: needed - 1 } } }).deps)
      expect(over.plan.size.ratio).toBeGreaterThan(1)
      expect([window, recommended(over.plan)]).toEqual([window, [["summary", "llm"]]])
      expect(row(over.plan, "full")).toMatchObject({ available: false, reason: "does_not_fit" })
      expect(row(over.plan, "summary", "brief")).toMatchObject({ available: true, recommended: false })
    }
  })

  test("a summary keeps the newest turns verbatim up to the fill capacity C, not core's keep (07 R8)", async () => {
    const info = transcript(conversation(30, 40_000))
    const deps = setup().deps
    const value = (await plan(info, {}, deps)).plan
    expect(recommended(value)).toEqual([["summary", "llm"]])
    const tail = value.size.tail
    const old = value.size.old
    if (tail === undefined || old === undefined) throw new Error("no split")
    // C = ceiling − (Z + |checkpoint| + notice + x), |checkpoint| ≥ the summary cap + keep.
    expect(value.size.capacity).toBeLessThanOrEqual(
      value.size.ceiling - (10_000 + Plan.SUMMARY_TOKENS + Compaction.KEEP_TOKENS + 2_000),
    )
    expect(tail.tokens).toBeLessThanOrEqual(value.size.capacity)
    const measure = Store.measure("codex", { images: true })
    const before = Fill.tokens(info.turns, measure, { turn: tail.fromTurn - 1 }, { turn: tail.fromTurn })
    expect(tail.tokens + before).toBeGreaterThan(value.size.capacity)
    expect(tail.tokens).toBeGreaterThan(10 * Compaction.KEEP_TOKENS)
    expect(old.turns).toBe(tail.fromTurn)
    // The summary input cuts tool output to 1,250 characters, and goes now to the summarizer.
    const llm = row(value, "summary", "llm")
    expect(value.size.summaryInput).toBeGreaterThan(0)
    expect(llm.send.now).toBe(value.size.summaryInput ?? -1)
    expect(llm.send.withFirst).toBeGreaterThan(tail.tokens + Plan.SUMMARY_TOKENS + Compaction.KEEP_TOKENS)
    expect(row(value, "summary", "brief").send.now).toBe(0)
  })

  test("a request picks the row the nonce runs; an unavailable row falls back to the recommended one", async () => {
    // Turns smaller than the LLM summary's cap and keep, so the room the brief leaves always holds one more of them
    // (40k turns kept the same count once core's 15% reserve moved the window, upstream v2.1).
    const info = transcript(conversation(120, 10_000))
    const llm = await plan(info)
    expect(llm.planned.run).toMatchObject({ mode: "summary", source: "llm", summarizer: TARGET })
    const tail = llm.plan.size.tail
    if (tail === undefined || llm.planned.run.mode !== "summary" || llm.planned.run.source !== "llm")
      throw new Error("no llm tail")
    expect(llm.planned.run.tail.turn).toBe(tail.fromTurn)

    const brief = await plan(info, { mode: "summary", source: "brief" })
    expect(brief.planned.run).toMatchObject({ mode: "summary", source: "brief", boundary: { type: "brief" } })
    // The program checkpoint is smaller than an LLM summary's cap and keep: the brief tail keeps more turns.
    expect(brief.plan.size.tail?.tokens ?? 0).toBeGreaterThan(tail.tokens)

    const full = await plan(info, { mode: "full" })
    expect(full.planned.run).toMatchObject({ mode: "summary", source: "llm" })
    expect(full.plan.modes).toEqual(llm.plan.modes)
  })

  test("costs come from estimate.request per cell: the summary, a cold first request, cached later ones (09 §4.6)", async () => {
    const info = transcript(conversation(30, 40_000))
    const { deps, calls } = setup()
    const value = (await plan(info, {}, deps)).plan
    const llm = row(value, "summary", "llm")
    const brief = row(value, "summary", "brief")
    const prompt = Math.ceil(10_000 + llm.send.withFirst)
    const priced = (requests: Call["requests"]) =>
      calls.some((call) => JSON.stringify(call.requests) === JSON.stringify(requests))
    expect(priced([{ prompt: Math.ceil(10_000 + (value.size.summaryInput ?? 0)), output: Plan.SUMMARY_TOKENS }])).toBe(
      true,
    )
    expect(priced([{ prompt, output: 0 }])).toBe(true)
    expect(priced([{ prompt: prompt + 2_000, output: 0, cachedPrefix: prompt }])).toBe(true)
    expect(llm.cost.summary?.lo).toBeCloseTo(
      (10_000 + (value.size.summaryInput ?? 0) + Plan.SUMMARY_TOKENS * 4) / 1e6,
      6,
    )
    expect(llm.cost.first?.lo).toBeCloseTo(prompt / 1e6, 6)
    expect(llm.cost.perRequest?.lo).toBeCloseTo((2_000 + prompt * 0.1) / 1e6, 6)
    expect(brief.cost.summary).toBeNull()
    expect(brief.cost.first).not.toBeNull()
    // Every cell is asked once, and only for the target (at own.accounts' control Location, `rpc.ts`).
    expect(new Set(calls.map((call) => JSON.stringify([call.target, call.requests]))).size).toBe(calls.length)
    expect(new Set(calls.map((call): string => call.target.providerID))).toEqual(new Set(["own-codex-aaaa"]))
    // `곧 자동 압축 예상` only when the first exchange passes the ceiling.
    expect(llm.cost.autoCompactSoon).toBeNull()
    const tight = transcript(conversation(3, 300))
    const near = await plan(tight, {}, setup().deps)
    const needed = 10_000 + whole(near.plan)
    const soon = await plan(
      tight,
      {},
      setup({ slots: { "own-codex-aaaa": { window: 50_000, ceiling: needed + 10 } } }).deps,
    )
    expect(recommended(soon.plan)).toEqual([["full", null]])
    expect(row(soon.plan, "full").cost.autoCompactSoon).not.toBeNull()
  })

  test("without own.accounts the costs are unknown and the catalog window sizes the plan", async () => {
    const info = transcript(conversation(3))
    const { deps, calls } = setup({
      slots: {},
      accounts: null,
      models: [model("own-codex-aaaa", "gpt-6", { context: 400_000, input: 272_000, canonical: "openai" })],
    })
    const value = (await plan(info, {}, deps)).plan
    expect(value.size).toMatchObject({
      Z: Plan.DEFAULT_Z,
      zSource: "default",
      exchange: Plan.DEFAULT_EXCHANGE,
      window: 272_000,
      ceiling: Compaction.ceiling(272_000),
    })
    expect(value.modes.map((item) => item.cost)).toEqual(
      value.modes.map(() => ({ summary: null, first: null, perRequest: null, autoCompactSoon: null, quota: null })),
    )
    expect(row(value, "full").send).toMatchObject({ accountID: null, company: "openai", crossCompany: false })
    expect(value.warnings).toContain("z_unknown")
    expect(calls.length).toBe(1)
  })
})

describe("Codex remote compaction (09 §4.1, §4.3)", () => {
  const PREFIX = CodexTranscript.SUMMARY_PREFIX
  const start = {
    rootID: SOURCE.rootID,
    path: "C:\\fixture\\rollout.jsonl",
    bytes: 1,
    mtimeMs: T0,
    now: T0 + 3_600_000,
  }

  /** A local summary after turn 1, then two remote compactions, the second in the middle of turn 4. */
  function remote() {
    const builder = rollout()
      .meta({ id: threadId(7) })
      .user("turn zero")
      .assistant("zero done")
      .user("turn one")
      .assistant("one done")
      .compacted(localSummary("Local summary of turns zero and one.", PREFIX), [
        userItem("turn zero"),
        userItem("turn one"),
      ])
      .user(`turn two ${filler(60)}`)
      .call("exec_command", { cmd: "bun test" }, "call_2")
      .output("call_2", "2 pass")
      .assistant(`two done ${filler(60)}`)
      .user(`turn three ${filler(60)}`)
      .assistant(`three done ${filler(60)}`)
      .compacted("", [userItem("turn two"), userItem("turn three"), compactionItem()])
      .user(`turn four ${filler(60)}`)
      .call("exec_command", { cmd: "bun run build" }, "call_4")
      .compacted("", [userItem("turn two"), userItem("turn three"), userItem("turn four"), compactionItem()])
      .output("call_4", "built")
      .assistant(`four done ${filler(60)}`)
    return CodexTranscript.parse(builder.lines(), start)
  }

  test("그대로 fills across the remote boundaries behind briefAt(x) and needs no LLM call", async () => {
    const info = remote()
    const slot = (ceiling: number) => ({ "own-codex-aaaa": { window: 1_000_000, ceiling, Z: 0, exchange: 0 } })
    const roomy = await plan(info, {}, setup({ slots: slot(1_000_000) }).deps)
    // Everything after the local summary fits: the local summary itself is the boundary.
    expect(roomy.plan.boundary).toEqual({ at: { turn: 1, step: 1 }, checkpoint: "foreign", sourceCompactions: 3 })
    expect(recommended(roomy.plan)).toEqual([["full", null]])
    expect(row(roomy.plan, "summary", "llm").reason).toBe("fits")

    const ceilings = Array.from({ length: 80 }, (_, index) => 100 + index * 10)
    const plans = await Promise.all(ceilings.map((ceiling) => plan(info, {}, setup({ slots: slot(ceiling) }).deps)))
    const crossing = plans.filter((item) => item.plan.boundary.checkpoint === "codex-remote")
    expect(crossing.length).toBeGreaterThan(0)
    for (const item of crossing) {
      expect(recommended(item.plan)).toEqual([["full", null]])
      expect(row(item.plan, "full").send.now).toBe(0)
      // `전체 기록 요약` stays a choice; the LLM-free summary is what 그대로 already does.
      expect(row(item.plan, "summary", "llm")).toMatchObject({ recommended: false })
      expect(row(item.plan, "summary", "brief")).toMatchObject({ available: false, reason: "fits" })
      expect(item.planned.run).toMatchObject({ mode: "full", boundary: { type: "remote" } })
      const tail = item.plan.size.tail
      if (tail === undefined || item.planned.run.mode !== "full" || item.planned.run.boundary.type !== "remote")
        throw new Error("no remote fill")
      expect(tail.fromTurn).toBe(item.planned.run.boundary.at.turn)
      expect(item.plan.boundary.at?.turn).toBe(tail.fromTurn)
    }
    // Where the window holds the program checkpoint at all, the tail fills up to C and the whole fits the window.
    const filled = crossing.filter((item) => item.plan.size.capacity >= 0)
    expect(filled.some((item) => (item.plan.size.tail?.tokens ?? 0) > 0)).toBe(true)
    for (const item of filled) {
      expect(item.plan.size.tail?.tokens ?? 0).toBeLessThanOrEqual(item.plan.size.capacity)
      expect(item.plan.size.ratio).toBeLessThanOrEqual(1)
    }
  })
})

describe("the summarizer (09 §4.5, IG8)", () => {
  const big = transcript(conversation(30, 8_000))
  const slots = {
    "own-codex-aaaa": { window: 200_000 },
    "own-codex-bbbb": { window: 200_000 },
    "own-siwc-cccc": { window: 200_000 },
    "own-oai-dddd": { window: 200_000 },
    anthropic: { window: 200_000 },
  }
  const catalog = [
    model("own-codex-aaaa", "gpt-6", { canonical: "openai" }),
    model("own-codex-bbbb", "gpt-6", { canonical: "openai" }),
    model("own-siwc-cccc", "gpt-6", { canonical: "openai" }),
    model("own-oai-dddd", "gpt-6-mini", { canonical: "openai" }),
    model("anthropic", "claude-sonnet", { canonical: "anthropic" }),
  ]
  const summarized = (compaction?: Model.Ref, more: Parameters<typeof setup>[0] = {}) =>
    plan(big, {}, setup({ slots, models: catalog, ...(compaction === undefined ? {} : { compaction }), ...more }).deps)

  test("without an agents.compaction.model the target summarizes", async () => {
    const value = (await summarized()).plan
    expect(value.summarizer).toEqual({ model: TARGET, overridden: false })
    expect(recommended(value)).toEqual([["summary", "llm"]])
    expect(value.warnings).not.toContain("summarizer_overridden")
  })

  test("a compaction agent model the location resolves summarizes instead, priced on that model", async () => {
    const key = ref("own-oai-dddd", "gpt-6-mini")
    const { deps, calls } = setup({ slots, models: catalog, compaction: key })
    const result = await plan(big, {}, deps)
    expect(result.plan.summarizer).toEqual({ model: key, overridden: true })
    expect(result.plan.warnings).toContain("summarizer_overridden")
    // A metered key of the same company may summarize (R4 is about subscriptions).
    expect(recommended(result.plan)).toEqual([["summary", "llm"]])
    expect(result.planned.run).toMatchObject({ source: "llm", summarizer: key })
    const summary = calls.filter((call) => call.requests.some((item) => item.output === Plan.SUMMARY_TOKENS))
    expect(summary.map((call): string => call.target.providerID)).toContain("own-oai-dddd")
    expect(row(result.plan, "summary", "llm").cost.summary).not.toBeNull()
  })

  test("an agent model the location does not offer leaves the target (core falls back the same way)", async () => {
    const value = (await summarized(ref("own-oai-dddd", "not-in-catalog"))).plan
    expect(value.summarizer).toEqual({ model: TARGET, overridden: false })
  })

  test("R4: another subscription of the target's company may not summarize; one ChatGPT login counts once", async () => {
    const other = (await summarized(ref("own-codex-bbbb", "gpt-6"))).plan
    expect(row(other, "summary", "llm")).toMatchObject({ available: false, reason: "same_company_subscription" })
    expect(recommended(other)).toEqual([["summary", "brief"]])

    const sibling = (await summarized(ref("own-siwc-cccc", "gpt-6"))).plan
    expect(row(sibling, "summary", "llm")).toMatchObject({ available: true, recommended: true })

    // Another company's subscription may summarize; the row says the content goes to another company, names where
    // the summary input goes (`nowTo`), and the plan warns while that row is the chosen one.
    const anthropic = ref("anthropic", "claude-sonnet")
    const claude = (await summarized(anthropic)).plan
    expect(row(claude, "summary", "llm")).toMatchObject({ available: true, recommended: true })
    expect(row(claude, "summary", "llm").send).toMatchObject({
      accountID: ACCOUNTS.codex.id,
      company: "openai",
      crossCompany: true,
      nowTo: { accountID: ACCOUNTS.claude.id, company: "anthropic" },
    })
    expect(row(claude, "summary", "brief").send.crossCompany).toBe(false)
    expect(row(claude, "summary", "brief").send.nowTo).toBeUndefined()
    expect(claude.warnings).toContain("cross_company")
    const brief = await plan(big, { source: "brief" }, setup({ slots, models: catalog, compaction: anthropic }).deps)
    expect(brief.planned.run).toMatchObject({ mode: "summary", source: "brief" })
    expect(brief.plan.warnings).not.toContain("cross_company")
    // The target summarizing names no other receiver.
    expect(row((await summarized()).plan, "summary", "llm").send.nowTo).toBeUndefined()
  })

  test("a native target compacts without summary text: no LLM summary, the LLM-free one instead", async () => {
    const result = await plan(
      big,
      {},
      setup({ slots, models: [model("own-codex-aaaa", "gpt-6", { canonical: "openai", native: true })] }).deps,
    )
    expect(result.plan.summarizer).toBeNull()
    expect(row(result.plan, "summary", "llm")).toMatchObject({ available: false, reason: "native_compaction" })
    expect(recommended(result.plan)).toEqual([["summary", "brief"]])
    expect(result.planned.run).toMatchObject({ mode: "summary", source: "brief" })
  })

  test("a summary input past the summarizer's budget warns that core will leave out older exchanges", async () => {
    const key = ref("own-oai-dddd", "gpt-6-mini")
    const value = (await summarized(key, { slots: { ...slots, "own-oai-dddd": { window: 40_000, Z: 4_000 } } })).plan
    expect(value.warnings).toContain("compaction_may_truncate")
    const room = Compaction.ceiling(40_000) - 4_000
    expect(value.size.chunks).toBe(Math.ceil((value.size.summaryInput ?? 0) / room))
    expect(value.size.omitted).toBeGreaterThan(0)
    expect(row(value, "summary", "llm").available).toBe(true)
  })
})

describe("accounts and quota (09 §4.5, §4.6, 07 R4)", () => {
  const big = transcript(conversation(30, 8_000))
  const slots = { "own-codex-aaaa": { window: 200_000 } }

  test("a target account that cannot run is no target (09 §5.4); a summarizer's blocks the LLM summary only", async () => {
    for (const status of ["needs_reauth", "misconfigured", "auth_failed", "disabled"] as const) {
      const accounts = [account("acc_codex_a", "codex", "own-codex-aaaa", { status, login: "login-1" })]
      expect({ status, result: await Plan.create(input(big), setup({ slots, accounts }).deps) }).toEqual({
        status,
        result: { ok: false, error: "target_unavailable", data: { model: TARGET, reason: "account_not_ready" } },
      })
    }
    expect(Plan.notReady({ status: "exhausted" })).toBe(false)
    expect(Plan.notReady({ status: "unverified" })).toBe(false)
    expect(Plan.notReady(undefined)).toBe(false)

    const key = ref("own-oai-dddd", "gpt-6-mini")
    const result = await plan(
      big,
      {},
      setup({
        slots: { ...slots, "own-oai-dddd": { window: 200_000 } },
        models: [model("own-codex-aaaa", "gpt-6", { canonical: "openai" }), model("own-oai-dddd", "gpt-6-mini")],
        compaction: key,
        accounts: [ACCOUNTS.codex, { ...ACCOUNTS.key, status: "misconfigured" }],
      }).deps,
    )
    expect(row(result.plan, "summary", "llm")).toMatchObject({ available: false, reason: "account_not_ready" })
    expect(recommended(result.plan)).toEqual([["summary", "brief"]])
    expect(result.planned.target).toEqual(TARGET)
  })

  test("an exhausted account or a summary past what remains is quota_insufficient, shown, never rerouted", async () => {
    const exhausted = [account("acc_codex_a", "codex", "own-codex-aaaa", { status: "exhausted", login: "login-1" })]
    const spent = (await plan(big, {}, setup({ slots, accounts: exhausted }).deps)).plan
    expect(row(spent, "summary", "llm")).toMatchObject({ available: false, reason: "quota_insufficient" })
    expect(spent.warnings).toContain("quota_insufficient")

    // The fake prices a million tokens at 1%: a summary of about 110k tokens needs more than the 0.1% left.
    const short = {
      "own-codex-aaaa": { window: 200_000, unit: "percent" as const, remaining: { fiveHour: 0.1, weekly: 40 } },
    }
    const result = await plan(big, {}, setup({ slots: short }).deps)
    expect(row(result.plan, "summary", "llm")).toMatchObject({ available: false, reason: "quota_insufficient" })
    expect(result.plan.warnings).toContain("quota_insufficient")
    expect(recommended(result.plan)).toEqual([["summary", "brief"]])
    expect(result.planned.target).toEqual(TARGET)
    expect(result.plan.modes.every((item) => item.send.accountID === "acc_codex_a")).toBe(true)

    const roomy = { "own-codex-aaaa": { ...short["own-codex-aaaa"], remaining: { fiveHour: 1e9, weekly: null } } }
    expect(row((await plan(big, {}, setup({ slots: roomy }).deps)).plan, "summary", "llm").available).toBe(true)
  })

  test("the picked account of a provider several serve: its readiness, quota, price and send notice (09 §4.5)", async () => {
    // The fifth limits review: every Claude account serves `anthropic`, and the plan took the first one listed, so with
    // Claude 2 picked the send notice, the costs and the quota check were Claude 1's.
    const opus = ref("anthropic", "claude-opus-5-5")
    const two = account("acc_claude_two", "claude-sub", "anthropic")
    const models = [model("anthropic", "claude-opus-5-5", { canonical: "anthropic", context: 200_000 })]
    // Claude 1 has room; Claude 2 has 0.1 % of its 5 hours left, which a summary of the big conversation passes.
    const left = { [ACCOUNTS.claude.id]: { fiveHour: 80, weekly: 70 }, [two.id]: { fiveHour: 0.1, weekly: 40 } }
    const world = (accounts: ReadonlyArray<Account.View>) => {
      const made = setup({ slots: { anthropic: { window: 200_000, unit: "percent" } }, models, accounts })
      const estimate = made.deps.estimate
      const asked: Array<string | undefined> = []
      const deps: Plan.Deps = {
        ...made.deps,
        estimate: async (input) => {
          asked.push(input.accountID)
          const answer = await estimate(input)
          if (!answer.ok) return answer
          return { ...answer, value: { ...answer.value, remaining: left[input.accountID ?? ACCOUNTS.claude.id]! } }
        },
      }
      return { deps, asked }
    }
    const both = [ACCOUNTS.codex, ACCOUNTS.claude, two]

    const picked = world(both)
    const result = await plan(big, { target: opus, accountID: two.id }, picked.deps)
    expect(result.plan.modes.every((item) => item.send.accountID === two.id)).toBe(true)
    expect(row(result.plan, "summary", "llm")).toMatchObject({ available: false, reason: "quota_insufficient" })
    expect(result.plan.warnings).toContain("quota_insufficient")
    // Every price is asked on Claude 2, and execute checks Claude 2 again.
    expect(picked.asked.length).toBeGreaterThan(1)
    expect(picked.asked.every((accountID) => accountID === two.id)).toBe(true)
    expect(result.planned.accountID).toBe(two.id)
    expect(result.planned.target).toEqual(opus)

    // Absent, the provider's first listed account, as before: Claude 1, with room, and no account named to own.accounts.
    const before = world(both)
    const first = await plan(big, { target: opus }, before.deps)
    expect(first.plan.modes.every((item) => item.send.accountID === ACCOUNTS.claude.id)).toBe(true)
    expect(row(first.plan, "summary", "llm").available).toBe(true)
    expect(before.asked.every((accountID) => accountID === undefined)).toBe(true)
    expect(first.planned.accountID).toBeUndefined()
    // A picked account of another provider names nothing here.
    const other = await plan(big, { target: opus, accountID: ACCOUNTS.codex.id }, world(both).deps)
    expect(other.plan.modes.every((item) => item.send.accountID === ACCOUNTS.claude.id)).toBe(true)
    expect(other.planned.accountID).toBeUndefined()

    // A picked account that cannot run is no target, though Claude 1 could.
    const stale = [ACCOUNTS.claude, { ...two, status: "needs_reauth" as const }]
    expect(await Plan.create(input(big, { target: opus, accountID: two.id }), world(stale).deps)).toEqual({
      ok: false,
      error: "target_unavailable",
      data: { model: opus, reason: "account_not_ready" },
    })
  })

  test("the send notice names the target's account and company on every row (09 §4.5, IG10)", async () => {
    const value = (await plan(transcript(conversation(3)))).plan
    const send = { accountID: ACCOUNTS.codex.id, company: "openai", crossCompany: false }
    expect(value.modes.map((item) => item.send)).toEqual([
      { now: 0, withFirst: whole(value), ...send },
      { now: 0, withFirst: 0, ...send },
      { now: 0, withFirst: 0, ...send },
    ])
    // A Claude Code conversation moved to a ChatGPT account goes to another company.
    const claude = (await plan(transcript(conversation(3), { kind: "claude-code" }))).plan
    expect(claude.warnings).toContain("cross_company")
    expect(claude.modes.every((item) => item.send.crossCompany)).toBe(true)
  })
})

describe("location, store and warnings (09 §2.2, §2.8, §5.2)", () => {
  test("the location is the last working folder with its branch, and says when it is not the list's folder", async () => {
    const value = (await plan(transcript(conversation(2)), { directory: ROOT })).plan
    expect(value.location).toEqual({ directory: SUB, branch: "feature", differsFromList: true })
    expect(value.warnings).toEqual(["location_differs"])
    const same = (await plan(transcript(conversation(2)), { directory: SUB })).plan
    expect(same.location.differsFromList).toBe(false)
    expect(same.warnings).toEqual([])
  })

  test("a missing last folder imports into the project root", async () => {
    const result = await plan(transcript(conversation(2), { cwds: [ROOT, "C:\\work\\gone"] }), { directory: ROOT })
    expect(result.plan.location).toEqual({ directory: ROOT, branch: "main", differsFromList: false })
    expect(result.plan.warnings).toEqual(["source_folder_missing"])
    expect(result.planned.location).toBe(ROOT)
  })

  test("an asked location must be the default or a folder of the project", async () => {
    const here = await plan(transcript(conversation(2)), { location: ROOT, directory: ROOT })
    expect(here.plan.location.directory).toBe(ROOT)
    expect(here.planned.location).toBe(ROOT)
    const away = await Plan.create(input(transcript(conversation(2)), { location: "D:\\elsewhere" }), setup().deps)
    expect(away).toEqual({ ok: false, error: "directory_unknown", data: { directory: "D:\\elsewhere" } })
    const gone = await Plan.create(
      input(transcript(conversation(2)), { location: "C:\\work\\proj\\gone" }),
      setup().deps,
    )
    expect(gone.ok).toBe(false)
  })

  test("store: everything is stored by default (Q3); the body budget leaves out the oldest unseen turns", async () => {
    const info = transcript(conversation(6), { checkpoints: [foreign(3, 1)] })
    const full = (await plan(info)).plan
    expect(full.store.full).toBe(true)
    expect(full.boundary).toEqual({ at: { turn: 3, step: 1 }, checkpoint: "foreign", sourceCompactions: 1 })
    const lean = (await plan(info, { storeFull: false })).plan
    expect(lean.store.full).toBe(false)
    expect(lean.store.bytes).toBeLessThan(full.store.bytes)
    const tight = (await plan(info, {}, setup({ budget: full.store.bytes - 1 }).deps)).plan
    expect(tight.store.trimmedTurns).toBeGreaterThan(0)
    expect(tight.store.budget).toBe(full.store.bytes - 1)
    expect(tight.warnings).toContain("import_too_large")
  })

  test("warnings for a live source, unknown records, a partial history base and dropped images", async () => {
    const image = { mime: "image/png", bytes: 70, data: "iVBORw0KGgo=" }
    const info = transcript([turn(0), turn(1, 200, { images: [image] })], {
      live: true,
      dropped: { unknownRecord: 2 },
    })
    const result = await Plan.create(
      { ...input(info), basePartial: true },
      setup({ models: [model("own-codex-aaaa", "gpt-6", { canonical: "openai", images: false })] }).deps,
    )
    if (!result.ok) throw new Error("plan failed")
    expect(result.plan.warnings).toEqual(["source_live", "images_dropped", "unknown_records", "history_base_partial"])
    expect(result.plan.dropped).toEqual({ unknownRecord: 2 })
    expect(result.planned.images).toBe(false)
    // A target that takes images keeps the image inline.
    const shown = await plan(info)
    expect(shown.plan.warnings).toEqual(["source_live", "unknown_records"])
  })

  test("redactions count the secrets the stored text hides; off, nothing is hidden", async () => {
    const info = transcript([turn(0), turn(1, 200, { text: `my key is ${FAKE.apiKey} and ${FAKE.github}` })])
    expect((await plan(info)).plan.redactions).toBe(2)
    expect((await plan(info, { redact: false })).plan.redactions).toBe(0)
  })

  test("an LLM summary also counts the secrets of the summary input it sends", async () => {
    const leaky: Transcript.Turn = {
      ...turn(0, 8_000),
      steps: [
        {
          type: "tool",
          name: "exec_command",
          input: { cmd: "env" },
          output: { text: FAKE.aws, error: false },
          time: T0,
        },
        { type: "text", text: `answer 0 ${filler(8_000)}`, time: T0 + 1 },
      ],
    }
    const info = transcript([leaky, ...conversation(30, 8_000).slice(1)])
    const deps = () => setup({ slots: { "own-codex-aaaa": { window: 200_000 } } }).deps
    const llm = (await plan(info, {}, deps())).plan
    const brief = (await plan(info, { source: "brief" }, deps())).plan
    expect(recommended(llm)).toEqual([["summary", "llm"]])
    // The old turn's tool output is one line in the stored short shape, but part of the summary input.
    expect(brief.redactions).toBe(0)
    expect(llm.redactions).toBe(1)
  })

  test("earlier imports of the source are listed", async () => {
    const earlier = Schema.decodeUnknownSync(OwnImport.Imported)({
      sessionID: "ses_fixture0000000000000001",
      mode: "full",
      importedAt: T0,
    })
    const result = await Plan.create({ ...input(transcript(conversation(2))), existing: [earlier] }, setup().deps)
    if (!result.ok) throw new Error("plan failed")
    expect(result.plan.existing).toEqual([earlier])
  })

  test("a target the location does not offer, or one without tools, cannot take the conversation", async () => {
    const info = transcript(conversation(2))
    const missing = await Plan.create(input(info, { target: ref("own-codex-zzzz", "gpt-6") }), setup().deps)
    expect(missing).toEqual({
      ok: false,
      error: "target_unavailable",
      data: { model: ref("own-codex-zzzz", "gpt-6"), reason: "unknown_model" },
    })
    const toolless = await Plan.create(
      input(info),
      setup({ models: [model("own-codex-aaaa", "gpt-6", { tools: false })] }).deps,
    )
    expect(toolless).toMatchObject({ ok: false, data: { reason: "no_tools" } })
  })
})

describe("the nonce (09 §4.8)", () => {
  test("is valid for 10 minutes and single use; the plan changes nothing else", async () => {
    const now = T0 + 86_400_000
    const { deps, nonces, calls } = setup({ now })
    const result = await plan(transcript(conversation(3)), { upToTurn: 1 }, deps)
    expect(result.plan.nonce).toBe(result.planned.nonce)
    expect(result.plan.expiresAt).toBe(now + Plan.TTL_MS)
    expect([...nonces.keys()]).toEqual([result.plan.nonce])
    expect(result.planned).toMatchObject({
      ref: SOURCE,
      directory: SUB,
      location: SUB,
      projectID: PROJECT.id,
      upToTurn: 1,
      turns: 2,
      target: TARGET,
      images: true,
      storeFull: true,
      redact: true,
    })
    expect(result.plan.turns).toBe(2)
    // Only reads: estimate requests carry no session, and nothing but the nonce was kept.
    expect(calls.length).toBeGreaterThan(0)

    expect(Plan.get(nonces, result.plan.nonce, now + Plan.TTL_MS - 1)).toBe(result.planned)
    expect(Plan.take(nonces, result.plan.nonce, now + 1)).toBe(result.planned)
    expect(Plan.take(nonces, result.plan.nonce, now + 2)).toBeUndefined()
    expect(nonces.size).toBe(0)

    const again = await plan(transcript(conversation(3)), {}, deps)
    expect(Plan.get(nonces, again.plan.nonce, now + Plan.TTL_MS)).toBeUndefined()
    expect(Plan.take(nonces, again.plan.nonce, now + Plan.TTL_MS)).toBeUndefined()
    expect(Plan.take(nonces, "not-a-nonce-at-all-0000", now)).toBeUndefined()
  })

  test("expired nonces go when the next one is issued", async () => {
    const clock = { now: T0 }
    const { deps, nonces } = setup()
    const timed = { ...deps, now: () => clock.now }
    const info = transcript([turn(0, 10)])
    const first = await plan(info, {}, timed)
    const second = await plan(info, {}, timed)
    expect(nonces.size).toBe(2)
    clock.now += Plan.TTL_MS
    const third = await plan(info, {}, timed)
    expect([...nonces.keys()]).toEqual([third.plan.nonce])
    expect([first, second].some((item) => nonces.has(item.plan.nonce))).toBe(false)
  })
})
