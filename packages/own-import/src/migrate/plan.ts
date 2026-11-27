export * as Plan from "./plan.js"

import type { Model } from "@opencode/schema/model"
import type { Provider } from "@opencode/schema/provider"
import { OwnID } from "@own/protocol"
import type { Account } from "@own/protocol"
import { Compaction } from "@own/protocol/compaction"
import { Preset } from "@own/protocol/preset"
import type { OwnAccounts } from "@own/protocol/rpc"
import { OwnImport } from "@own/protocol/rpc-import"
import { Token } from "@own/protocol/token"
import { Redact } from "@own/runtime"
import type { SelfHttp } from "../http.js"
import type { Scan } from "../index/scan.js"
import { Notice } from "../render/notice.js"
import { Store } from "../render/store.js"
import { Singleton } from "../singleton.js"
import { Paths } from "../sources/paths.js"
import { Brief } from "../transcript/brief.js"
import { Transcript } from "../transcript/ir.js"
import { Fill } from "./fill.js"

/**
 * `migrate.plan` (09 §4.3–4.6, §5.2): what moving one conversation onto the target model would look like, row by row,
 * before anything runs. The plan only reads: the transcript the caller parsed, the location's catalog and hidden
 * `compaction` agent, own.accounts' `estimate.request` and `accounts.list`, the folder's branch. Its one side effect is
 * the nonce (10 minutes, single use) that `migrate.execute` redeems, kept in the build's process singleton.
 *
 * - **The target is never substituted** (IG9, 07 R4): every row continues on `request.target`. `추천` accounts are
 *   the dialog's (03 §5.1, 02 §5.10); the plan only says when the target's quota is short (`quota_insufficient`).
 * - **The window ratio decides alone** (IM-D6, 07 R8·U6): `r = (Z + E(V) + notice) / ceiling` of the target's own
 *   window, with no token constant anywhere. A summary keeps the newest turns verbatim up to the fill capacity `C`,
 *   never cut to core's `keep`.
 * - **The summarizer is core's** (`packages/core/src/session/compaction.ts` `compact`): a native session model
 *   compacts natively, without summary text (`native_compaction`); otherwise the hidden `compaction` agent's model
 *   when the location resolves it, else the target. Another subscription of the target's company may not summarize
 *   (`same_company_subscription`, R4), where one ChatGPT login's `codex` and `siwc` slots count as one.
 */

/** A plan's nonce lives this long (09 §4.8, as 02 §9 plan/execute). */
export const TTL_MS = 10 * 60_000
/** own.accounts `Tracker.DEFAULTS` (02 §6.1): the slot's Z, one exchange `x` and the summary output `S_sum`. */
export const DEFAULT_Z = 12_000
export const DEFAULT_EXCHANGE = 3_000
export const SUMMARY_TOKENS = 8_000
/** Core sizes a compaction for a model whose window is unknown as this window (`compaction.ts` `UNKNOWN_WINDOW`). */
export const UNKNOWN_WINDOW = 200_000

/** The company each source tool's conversations were written with (09 §4.5 `다른 회사`). */
export const SOURCE_COMPANY: Record<Transcript.Kind, string> = { codex: "openai", "claude-code": "anthropic" }

/** Account states that serve requests (own.accounts `planner.usability`). */
const RUNNABLE: ReadonlySet<Account.Status> = new Set(["ready", "unverified"])

/**
 * An own account that cannot run a request now (`account_not_ready`, 09 §5.4): needs a login, misconfigured, disabled,
 * retired. A used-up window (`exhausted`) is the quota's question (`quota_insufficient`, 09 §4.6); no account (a
 * local model, own.accounts not answering) is never this.
 */
export function notReady(account: Pick<Account.View, "status"> | undefined) {
  return account !== undefined && account.status !== "exhausted" && !RUNNABLE.has(account.status)
}

/** The helper session's job id while only sizing it: no job exists yet. */
const PLAN_JOB = "job_plan"

const NO_COST: OwnImport.Cost = { summary: null, first: null, perRequest: null, autoCompactSoon: null, quota: null }

// ---------------------------------------------------------------------------------------------------------------
// Inputs

/** `migrate.plan` input (09 §5.2). */
export interface Request {
  readonly ref: OwnImport.SourceRef
  /** The folder the list was opened for. */
  readonly directory: string
  /** `여기까지`: the last turn to import, 0-based. */
  readonly upToTurn?: number
  /** With `source`, the row the nonce runs; default the recommended row (an unavailable row falls back to it). */
  readonly mode?: OwnImport.Mode
  readonly source?: OwnImport.SummarySource
  readonly target: Model.Ref
  /**
   * The picked account of `target` (09 §4.5): every Claude account serves `anthropic`, so the provider alone names
   * the first one. The plan's account (its readiness, send notice and quota) and own.accounts' price are this one's
   * while it is a listed account of that provider; else the provider's first listed account, as before.
   */
  readonly accountID?: string
  /** The folder to import into; default the conversation's last working folder (09 §2.2). */
  readonly location?: string
  /** `원래 대화 전체도 own에 저장`, default true (Q3). */
  readonly storeFull?: boolean
  /** Default true. */
  readonly redact?: boolean
}

export interface Input {
  readonly request: Request
  /** The conversation, parsed in full. */
  readonly transcript: Transcript.Info
  /** The project of `request.directory` (`Scan.Service.project`). */
  readonly project: Scan.Project
  /** Earlier imports of this conversation (its list row's `imported`). */
  readonly existing: ReadonlyArray<OwnImport.Imported>
  /** The Codex `history_base` prefix was not read in full (09 §2.5). */
  readonly basePartial?: boolean
}

/** What the import location offers, read through the plugin API there. */
export interface Catalog {
  /** `ctx.model.list`; disabled models count as missing. */
  readonly models: ReadonlyArray<Model.Info>
  /** `ctx.provider.list`, for provider-level `settings.compaction` and `canonical`. */
  readonly providers?: ReadonlyArray<Pick<Provider.Info, "id" | "canonical" | "settings">>
  /** The hidden `compaction` agent's model (`ctx.agent.get({agentID: "compaction"})`), when it has one. */
  readonly compaction?: Model.Ref
  /** Core `keep` (default 15k): the end of the summarized part an LLM summary keeps verbatim (`recent`). */
  readonly keep?: number
}

export interface Deps {
  /** The build's plan nonces (`shared.get(NONCES)`). */
  readonly nonces: Nonces
  /** own.accounts `estimate.request` at its control Location (`SelfHttp.Client.accounts.estimate`, 09 §5.6). */
  readonly estimate: (input: SelfHttp.EstimateInput) => Promise<SelfHttp.Result<Estimated>>
  /** own.accounts `accounts.list` at its control Location; `undefined` when own.accounts did not answer. */
  readonly accounts: () => Promise<ReadonlyArray<Account.View> | undefined>
  readonly catalog: (directory: string) => Promise<Catalog>
  /** The folder's current branch (`ctx.vcs.get`); `undefined` outside a repository. */
  readonly branch: (directory: string) => Promise<string | undefined>
  /** Default `Paths.folderExists`. */
  readonly exists?: (directory: string) => Promise<boolean>
  readonly resolve?: Paths.Realpath
  readonly now?: () => number
  /** The import body budget in bytes (default `Store.BUDGET`, 32 MiB). */
  readonly budget?: number
}

// ---------------------------------------------------------------------------------------------------------------
// The nonce (09 §4.8)

/** What `migrate.execute` runs: the conversation, where it goes and the chosen row. */
export interface Planned {
  readonly nonce: OwnID.Nonce
  readonly expiresAt: number
  readonly ref: OwnImport.SourceRef
  /** The folder the list was opened for. */
  readonly directory: string
  /** The new session's folder. */
  readonly location: string
  readonly projectID: string
  /** The last planned turn: execute imports exactly the planned turns even when the source grew since. */
  readonly upToTurn?: number
  /** The planned turns and their `Transcript.contentHash`, for the execute-time prefix check (09 §4.8). */
  readonly turns: number
  readonly contentHash: string
  readonly target: Model.Ref
  /**
   * The account the plan was made for (`migrate.plan` `accountID`, when it serves the target): execute checks that one
   * can still run. Absent: the provider's first listed account, as before.
   */
  readonly accountID?: string
  /** The target takes images. */
  readonly images: boolean
  readonly storeFull: boolean
  readonly redact: boolean
  readonly run: Run
}

/**
 * The row the nonce runs. `full` and the LLM-free summary carry their boundary; an LLM summary carries where its tail
 * starts and the model core will summarize with, and its boundary (`{type: "llm", at: tail, summary}`) is built once
 * the helper session returned the summary (09 §4.4).
 */
export type Run =
  | { readonly mode: "full"; readonly boundary: Fill.Boundary }
  | { readonly mode: "summary"; readonly source: "brief"; readonly boundary: Fill.Boundary }
  | { readonly mode: "summary"; readonly source: "llm"; readonly tail: Fill.Cut; readonly summarizer: Model.Ref }

/** The valid nonces by value. */
export type Nonces = Map<string, Planned>

/** The build's nonces, shared by every Location's plugin instance. */
export const NONCES = Singleton.slot<Nonces>("plan.nonces", () => new Map())

/** The planned run of a nonce while it is valid, without using it (e.g. to answer `job_busy` first). */
export function get(nonces: Nonces, nonce: string, now = Date.now()): Planned | undefined {
  const found = nonces.get(nonce)
  if (found === undefined || found.expiresAt > now) return found
  nonces.delete(nonce)
  return undefined
}

/** Uses a nonce: its planned run while it is valid, and never again. */
export function take(nonces: Nonces, nonce: string, now = Date.now()): Planned | undefined {
  const found = get(nonces, nonce, now)
  nonces.delete(nonce)
  return found
}

function issue(nonces: Nonces, planned: Omit<Planned, "nonce" | "expiresAt">, now: number): Planned {
  // Expired nonces go when the next one is issued, so the map holds only what the last 10 minutes planned.
  const expired = [...nonces.values()].filter((item) => item.expiresAt <= now)
  expired.forEach((item) => nonces.delete(item.nonce))
  const entry: Planned = { ...planned, nonce: OwnID.Nonce.create(), expiresAt: now + TTL_MS }
  nonces.set(entry.nonce, entry)
  return entry
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

export type Result =
  | { readonly ok: true; readonly plan: OwnImport.Plan; readonly planned: Planned }
  | {
      readonly ok: false
      readonly error: "target_unavailable"
      readonly data: { readonly model: Model.Ref; readonly reason: OwnImport.TargetProblem }
    }
  | { readonly ok: false; readonly error: "directory_unknown"; readonly data: { readonly directory: string } }

/**
 * `migrate.plan` (09 §5.2). A source or target problem is an answer; a dependency that rejects (the catalog, the
 * branch) rejects the plan. own.accounts missing or failing leaves the costs `null` and sizes with the catalog window.
 */
export async function create(input: Input, deps: Deps): Promise<Result> {
  const request = input.request
  const now = (deps.now ?? Date.now)()
  const resolve = deps.resolve ?? Paths.realpath
  const place = await locate(input, deps.exists ?? Paths.folderExists, resolve)
  if (!place.ok) return place
  const catalog = await deps.catalog(place.directory)
  const facts = factsOf(catalog, request.target)
  if (facts === undefined) return unavailable(request.target, "unknown_model")
  if (!facts.tools) return unavailable(request.target, "no_tools")
  const agent = summarizerOf(catalog, request.target, facts)
  // The picked account (09 §4.5): every Claude account serves `anthropic`, so the provider alone names the first one.
  // own.accounts prices and reads the quota on it (it ignores one that does not serve the target, as the plan does).
  const [listed, measured, side, branch] = await Promise.all([
    deps.accounts(),
    deps.estimate({
      target: request.target,
      requests: [],
      ...(request.accountID === undefined ? {} : { accountID: request.accountID }),
    }),
    agent?.overridden ? deps.estimate({ target: agent.ref, requests: [] }) : undefined,
    deps.branch(place.directory),
  ])
  const picked = listed?.find((item) => item.id === request.accountID && item.providerID === request.target.providerID)
  const target = party(request.target, facts, listed, measured, picked)
  // The import pins the session to the target's account: one that cannot run now is no target (09 §5.4).
  if (notReady(target.account)) return unavailable(request.target, "account_not_ready")
  const summarizer: Summarizer | undefined =
    agent === undefined
      ? undefined
      : { ...(agent.overridden ? party(agent.ref, agent.facts, listed, side) : target), overridden: agent.overridden }
  const sizing = size({
    input,
    target,
    summarizer,
    keep: catalog.keep ?? Compaction.KEEP_TOKENS,
    location: place.directory,
    now,
    bytes: deps.budget ?? Store.BUDGET,
  })
  const rows = await modes({ input, sizing, target, summarizer, price: pricer(deps.estimate) })
  const chosen = choose(rows, request)
  const planned = issue(deps.nonces, plannedOf(input, place.directory, target, sizing, chosen), now)
  const plan = planOf({ input, place, branch, sizing, target, summarizer, rows, chosen, planned })
  return { ok: true, plan, planned }
}

// ---------------------------------------------------------------------------------------------------------------
// Location (09 §2.2)

interface Place {
  readonly ok: true
  readonly directory: string
  /** The conversation's last working folder is gone: the location defaults to the project root. */
  readonly missing: boolean
  /** Not the folder the list was opened in. */
  readonly differs: boolean
}

/**
 * The import location: the asked folder, else the conversation's last working folder when it exists, else the project
 * root. An asked folder must exist and be the default or a working folder of the project (`directory_unknown`).
 */
async function locate(
  input: Input,
  exists: (directory: string) => Promise<boolean>,
  resolve: Paths.Realpath,
): Promise<Place | Extract<Result, { readonly error: "directory_unknown" }>> {
  const cwd = input.transcript.source.cwds.at(-1) ?? ""
  const found = cwd !== "" && (await exists(cwd))
  // Recorded cwds may be verbatim paths (`\\?\C:\…`, 09 §2.2); the session gets the plain form.
  const fallback = found ? Paths.native(cwd) : input.project.root
  const asked = input.request.location
  if (asked !== undefined && !(await allowed(asked, fallback, input.project, exists, resolve)))
    return { ok: false, error: "directory_unknown", data: { directory: asked } }
  const directory = asked === undefined ? fallback : Paths.native(asked)
  return { ok: true, directory, missing: !found, differs: !Paths.same(directory, input.request.directory, resolve) }
}

async function allowed(
  asked: string,
  fallback: string,
  project: Scan.Project,
  exists: (directory: string) => Promise<boolean>,
  resolve: Paths.Realpath,
) {
  if (!(await exists(asked))) return false
  return Paths.same(asked, fallback, resolve) || project.folders.some((folder) => Paths.inside(asked, folder, resolve))
}

// ---------------------------------------------------------------------------------------------------------------
// Target and summarizer (09 §4.5)

/** What the plan reads of a catalog model. */
interface Facts {
  /** `limit.input || limit.context` (01 R16); 0 when unknown. */
  readonly window: number
  readonly tools: boolean
  readonly images: boolean
  /** Its `compaction.type` (variant, model, then provider settings) is `native`. */
  readonly native: boolean
  readonly canonical?: string
}

/** A model the plan sends to, with its account, company and own.accounts' measurements of its slot. */
interface Party {
  readonly ref: Model.Ref
  readonly facts: Facts
  readonly account?: Account.View
  /** Its account came from the pick (`migrate.plan` `accountID`): own.accounts prices on that account too. */
  readonly picked: boolean
  /** The account's company (`Preset.company`), else the model's canonical provider; `null` for a local model. */
  readonly company: string | null
  /** own.accounts' answer for the slot with no requests; `undefined` when own.accounts did not answer. */
  readonly measured?: Estimated
  readonly window: number
  readonly ceiling: number
  readonly Z: number
  readonly exchange: number
}

interface Summarizer extends Party {
  /** `agents.compaction.model` summarizes instead of the target (`summarizer_overridden`). */
  readonly overridden: boolean
}

type Estimated = OwnAccounts.EstimateRequestResult

function factsOf(catalog: Catalog, ref: Model.Ref): Facts | undefined {
  const info = catalog.models.find(
    (model) => model.enabled && model.providerID === ref.providerID && model.id === ref.id,
  )
  if (info === undefined) return undefined
  const provider = catalog.providers?.find((item) => item.id === ref.providerID)
  const variant = ref.variant === undefined ? undefined : info.variants.find((item) => item.id === ref.variant)
  const compaction = variant?.settings?.compaction ?? info.settings?.compaction ?? provider?.settings?.compaction
  const canonical = info.canonical ?? provider?.canonical
  return {
    window: Compaction.windowOf(info.limit),
    tools: info.capabilities.tools,
    images: info.capabilities.input.includes("image"),
    native: compaction?.type === "native",
    ...(canonical === undefined ? {} : { canonical }),
  }
}

/**
 * Core's precedence (`compaction.ts` `compact`): a native session model compacts natively and leaves no summary text,
 * so there is no LLM summarizer; else the `compaction` agent's model when the location resolves it, else the target.
 */
function summarizerOf(catalog: Catalog, target: Model.Ref, facts: Facts) {
  if (facts.native) return undefined
  const agent = catalog.compaction
  const resolved = agent === undefined ? undefined : factsOf(catalog, agent)
  if (agent === undefined || resolved === undefined) return { ref: target, facts, overridden: false }
  return { ref: agent, facts: resolved, overridden: !sameRef(agent, target) }
}

function party(
  ref: Model.Ref,
  facts: Facts,
  accounts: ReadonlyArray<Account.View> | undefined,
  answer: SelfHttp.Result<Estimated> | undefined,
  picked?: Account.View,
): Party {
  const account = picked ?? accounts?.find((item) => item.providerID === ref.providerID)
  const measured = answer?.ok ? answer.value : undefined
  const window = measured?.window ?? (facts.window > 0 ? facts.window : UNKNOWN_WINDOW)
  const local = Preset.LOCAL_PROVIDERS.some((id) => id === ref.providerID)
  return {
    ref,
    facts,
    ...(account === undefined ? {} : { account }),
    picked: picked !== undefined,
    company: account !== undefined ? Preset.company(account) : local ? null : (facts.canonical ?? ref.providerID),
    ...(measured === undefined ? {} : { measured }),
    window,
    ceiling: measured?.ceiling ?? Compaction.ceiling(window),
    Z: measured?.Z ?? DEFAULT_Z,
    exchange: measured?.exchange ?? DEFAULT_EXCHANGE,
  }
}

/**
 * R4 (09 §4.5, 07 §5.4): a subscription of the target's company summarizes only when it is the target's own
 * subscription (the same account, or one ChatGPT login's `codex` and `siwc` slots, `Preset.oneSubscription`). Other
 * companies, metered keys and local models may summarize, with the send notice.
 */
function clash(summarizer: Summarizer, target: Party) {
  const account = summarizer.account
  if (!summarizer.overridden || account === undefined || account.billing !== "subscription") return false
  if (Preset.company(account) !== target.company) return false
  return target.account === undefined || !Preset.oneSubscription(account, target.account)
}

function sameRef(a: Model.Ref, b: Model.Ref) {
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? "") === (b.variant ?? "")
}

function unavailable(model: Model.Ref, reason: OwnImport.TargetProblem): Result {
  return { ok: false, error: "target_unavailable", data: { model, reason } }
}

// ---------------------------------------------------------------------------------------------------------------
// Sizing (09 §4.1, §4.3): pure

/** One row's stored session, as `render/store.ts` builds it. */
interface Shape {
  readonly boundary: Fill.Boundary
  readonly built: Store.Built
  /** Tokens the model reads after the import: `E + notice`, an LLM summary's `S` and `R` estimated in. */
  readonly visible: number
  /** The fill that placed the boundary (Codex remote, and both summary rows). */
  readonly fitted?: Fill.Fitted
}

interface Sizing {
  readonly zones: Fill.Zones
  readonly measure: Fill.Measure
  readonly budget: Fill.Budget
  /** `r = (Z + E(V) + notice) / ceiling` of `그대로`. */
  readonly ratio: number
  /**
   * `fits`: `그대로` keeps what the original model saw (or the Codex fill took every turn). `remote`: `그대로` fills
   * across a Codex remote compaction behind `briefAt(x)`. `over`: `그대로` does not fit.
   */
  readonly state: "fits" | "remote" | "over"
  readonly full: Shape
  /** `요약해서 이어가기` with an LLM summary: sized unless everything fits or the target compacts natively. */
  readonly llm?: Shape & { readonly fitted: Fill.Fitted; readonly helper: Store.Helper }
  /** `요약해서 이어가기` without an LLM: sized when `그대로` does not fit. */
  readonly brief?: Shape & { readonly fitted: Fill.Fitted }
}

function size(context: {
  readonly input: Input
  readonly target: Party
  readonly summarizer?: Summarizer
  readonly keep: number
  readonly location: string
  readonly now: number
  readonly bytes: number
}): Sizing {
  const transcript = context.input.transcript
  const request = context.input.request
  const redact = request.redact ?? true
  const kind = transcript.source.kind
  const zones = Fill.zones(transcript, { upToTurn: request.upToTurn })
  const measure = Store.measure(kind, { images: context.target.facts.images, redact })
  const brief = Store.briefSize(zones, { redact })
  // The notice names the tools of the model-visible part; the tools of V bound those of any tail.
  const tools = Fill.pieces(zones.turns, zones.visible).flatMap((piece) =>
    piece.turn.steps.slice(piece.from, piece.to).flatMap((step) => (step.type === "tool" ? [step.name] : [])),
  )
  const budget: Fill.Budget = {
    ceiling: context.target.ceiling,
    Z: context.target.Z,
    notice: Token.estimate(Notice.text(kind, tools)),
    exchange: context.target.exchange,
  }
  const location = { directory: context.location }
  const shape = (boundary: Fill.Boundary, fitted?: Fill.Fitted, extra = 0): Shape => {
    const built = Store.build({
      transcript,
      upToTurn: request.upToTurn,
      boundary,
      target: context.target.ref,
      images: context.target.facts.images,
      full: request.storeFull ?? true,
      redact,
      projectID: context.input.project.id,
      location,
      importedAt: context.now,
      budget: context.bytes,
    })
    return { boundary, built, visible: built.visible + extra, ...(fitted === undefined ? {} : { fitted }) }
  }
  const whole = Fill.full({ zones, budget, measure, brief })
  const full = shape(whole.boundary, whole.fitted)
  const ratio = (budget.Z + full.visible) / budget.ceiling
  const state = zones.remote ? (whole.fitted?.whole ? "fits" : "remote") : ratio <= 1 ? "fits" : "over"
  const clean = (text: string) => (redact ? Redact.named(text).text : text)
  const summarizer = context.summarizer
  const llm =
    state === "fits" || summarizer === undefined
      ? undefined
      : (() => {
          // |checkpoint| of an LLM summary: the summary cap and core's `keep` (09 §4.3), plus the brief the store
          // appends to the summary (09 §4.4 S + brief), which grows with the cut.
          const fixed = SUMMARY_TOKENS + context.keep
          const checkpoint = (cut: Fill.Cut) =>
            fixed +
            Token.estimate(
              Store.checkpointText(clean(`\n\n${Brief.brief(Fill.pieces(zones.turns, Fill.START, cut))}`), ""),
            )
          const fitted = Fill.fit({ turns: zones.turns, from: zones.visible, budget, checkpoint, measure })
          const summary = { text: "", recent: "", model: summarizer.ref }
          const helper = Store.helper({
            transcript,
            upToTurn: request.upToTurn,
            tail: fitted.cut,
            model: summarizer.ref,
            jobID: PLAN_JOB,
            projectID: context.input.project.id,
            location,
            archivedAt: context.now,
            redact,
          })
          return { ...shape({ type: "llm", at: fitted.cut, summary }, fitted, fixed), fitted, helper }
        })()
  const briefed =
    state !== "over"
      ? undefined
      : (() => {
          const fitted = Fill.fit({ turns: zones.turns, from: zones.visible, budget, checkpoint: brief, measure })
          return { ...shape({ type: "brief", at: fitted.cut }, fitted), fitted }
        })()
  return {
    zones,
    measure,
    budget,
    ratio,
    state,
    full,
    ...(llm === undefined ? {} : { llm }),
    ...(briefed === undefined ? {} : { brief: briefed }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rows (09 §4.3 table, §4.5, §4.6)

interface Row {
  readonly option: OwnImport.ModeOption
  /** Set on every row that can be chosen. */
  readonly run?: Run
  readonly shape?: Shape
  /** own.accounts' answer for the first request after the import. */
  readonly first?: Estimated
}

interface Rows {
  readonly full: Row
  readonly llm: Row
  readonly brief: Row
}

/** `estimate.request` of requests on `ref`, on `accountID` when the plan was made for a picked account. */
type Price = (
  ref: Model.Ref,
  requests: ReadonlyArray<OwnAccounts.EstimateRequestItem>,
  accountID?: string,
) => Promise<SelfHttp.Result<Estimated>>

async function modes(context: {
  readonly input: Input
  readonly sizing: Sizing
  readonly target: Party
  readonly summarizer?: Summarizer
  readonly price: Price
}): Promise<Rows> {
  const sizing = context.sizing
  const target = context.target
  const summarizer = context.summarizer
  const llm = sizing.llm
  const cost = costing(context.price, target)
  const summary =
    llm === undefined || summarizer?.measured === undefined
      ? undefined
      : { ref: summarizer.ref, prompt: Math.ceil(summarizer.Z + llm.helper.tokens), accountID: pricedOn(summarizer) }
  const [full, summarized, briefed] = await Promise.all([
    sizing.state === "over" ? undefined : cost(sizing.full.visible),
    llm === undefined ? undefined : cost(llm.visible, summary),
    sizing.brief === undefined ? undefined : cost(sizing.brief.visible),
  ])
  const llmReason = ((): OwnImport.Reason | undefined => {
    if (sizing.state === "fits") return "fits"
    if (summarizer === undefined) return "native_compaction"
    if (clash(summarizer, target)) return "same_company_subscription"
    if (summarizer.account?.status === "exhausted" || insufficient(summarized?.summary)) return "quota_insufficient"
    if (notReady(summarizer.account)) return "account_not_ready"
    if (llm?.fitted.whole) return "fits"
    return undefined
  })()
  const source = SOURCE_COMPANY[context.input.transcript.source.kind]
  const cross = (company: string | null) => company !== null && company !== source
  const send = (now: number, withFirst: number, crossCompany: boolean): OwnImport.Send => ({
    now: Math.round(now),
    withFirst: Math.round(withFirst),
    accountID: target.account?.id ?? null,
    company: target.company,
    crossCompany,
  })
  // `agents.compaction.model` sends the summary input to its own account and company (09 §4.5).
  const nowTo =
    summarizer?.overridden && llm !== undefined && llm.helper.tokens > 0
      ? { accountID: summarizer.account?.id ?? null, company: summarizer.company }
      : undefined
  const option = (
    fields: Pick<OwnImport.ModeOption, "mode" | "source" | "recommended" | "send" | "cost">,
    reason: OwnImport.Reason | undefined,
  ): OwnImport.ModeOption => ({
    ...fields,
    available: reason === undefined,
    recommended: reason === undefined && fields.recommended,
    ...(reason === undefined ? {} : { reason }),
  })
  return {
    full: {
      option: option(
        {
          mode: "full",
          recommended: sizing.state !== "over",
          send: send(0, sizing.full.visible, cross(target.company)),
          cost: full?.cost ?? NO_COST,
        },
        sizing.state === "over" ? "does_not_fit" : undefined,
      ),
      run: { mode: "full", boundary: sizing.full.boundary },
      shape: sizing.full,
      ...(full?.first === undefined ? {} : { first: full.first }),
    },
    llm: {
      option: option(
        {
          mode: "summary",
          source: "llm",
          // In a Codex remote conversation an LLM summary is `전체 기록 요약`, only when the user picks it.
          recommended: sizing.state === "over",
          send: {
            ...send(
              llm?.helper.tokens ?? 0,
              llm?.visible ?? 0,
              cross(target.company) || (summarizer !== undefined && cross(summarizer.company)),
            ),
            ...(nowTo === undefined ? {} : { nowTo }),
          },
          cost: summarized?.cost ?? NO_COST,
        },
        llmReason,
      ),
      ...(llm === undefined || summarizer === undefined
        ? {}
        : {
            run: { mode: "summary", source: "llm", tail: llm.fitted.cut, summarizer: summarizer.ref },
            shape: llm,
          }),
      ...(summarized?.first === undefined ? {} : { first: summarized.first }),
    },
    brief: {
      option: option(
        {
          mode: "summary",
          source: "brief",
          recommended: llmReason !== undefined,
          send: send(0, sizing.brief?.visible ?? 0, cross(target.company)),
          cost: briefed?.cost ?? NO_COST,
        },
        // Past a Codex remote compaction `그대로` already is the LLM-free summary.
        sizing.brief === undefined ? "fits" : undefined,
      ),
      ...(sizing.brief === undefined
        ? {}
        : { run: { mode: "summary", source: "brief", boundary: sizing.brief.boundary }, shape: sizing.brief }),
      ...(briefed?.first === undefined ? {} : { first: briefed.first }),
    },
  }
}

/** The requested row when it can run, else the recommended one; the plan never changes the target. */
function choose(rows: Rows, request: Request): Row {
  const summary = rows.llm.option.available ? rows.llm : rows.brief
  const wanted =
    request.mode === "full"
      ? rows.full
      : request.source === "brief"
        ? rows.brief
        : request.source === "llm"
          ? rows.llm
          : request.mode === "summary"
            ? summary
            : undefined
  if (wanted?.option.available) return wanted
  return [rows.full, rows.llm, rows.brief].find((row) => row.option.recommended) ?? rows.full
}

/**
 * A row's costs (09 §4.6): the summary request (input `Z + summary input`, output the summary cap), the first request
 * (`Z + visible`, cold: caches are per provider and account), each later request (the same prefix from the cache plus
 * one exchange) and, when `Z + visible + x` passes the ceiling, the compaction core would run soon. One
 * `estimate.request` per cell, since it sums the requests it gets; all `null` without own.accounts.
 */
function costing(price: Price, target: Party) {
  const on = pricedOn(target)
  return async (
    visible: number,
    summary?: { readonly ref: Model.Ref; readonly prompt: number; readonly accountID: string | undefined },
  ) => {
    if (target.measured === undefined) return { cost: NO_COST }
    const prompt = Math.ceil(target.Z + visible)
    const next = prompt + Math.ceil(target.exchange)
    const [first, later, soon, summarized] = await Promise.all([
      price(target.ref, [{ prompt, output: 0 }], on),
      price(target.ref, [{ prompt: next, output: 0, cachedPrefix: prompt }], on),
      next > target.ceiling
        ? price(target.ref, [{ prompt: next, output: SUMMARY_TOKENS, cachedPrefix: prompt }], on)
        : undefined,
      summary === undefined
        ? undefined
        : price(summary.ref, [{ prompt: summary.prompt, output: SUMMARY_TOKENS }], summary.accountID),
    ])
    const spent = summarized ?? first
    const cost: OwnImport.Cost = {
      summary: summarized === undefined ? null : deltaOf(summarized),
      first: deltaOf(first),
      perRequest: deltaOf(later),
      autoCompactSoon: soon === undefined ? null : deltaOf(soon),
      quota: spent.ok ? spent.value.quota : null,
    }
    return {
      cost,
      ...(first.ok ? { first: first.value } : {}),
      ...(summarized?.ok ? { summary: summarized.value } : {}),
    }
  }
}

/** `estimate.request` with each distinct question asked once per plan. */
function pricer(estimate: Deps["estimate"]): Price {
  const asked = new Map<string, Promise<SelfHttp.Result<Estimated>>>()
  return (ref, requests, accountID) => {
    const key = JSON.stringify([ref.providerID, ref.id, ref.variant ?? null, accountID ?? null, requests])
    const known = asked.get(key)
    if (known !== undefined) return known
    const answer = estimate({ target: ref, requests, ...(accountID === undefined ? {} : { accountID }) })
    asked.set(key, answer)
    return answer
  }
}

/** The account own.accounts prices a party on: the picked one, else none named (own.accounts' own choice, as before). */
function pricedOn(party: Party) {
  return party.picked ? party.account?.id : undefined
}

function deltaOf(answer: SelfHttp.Result<Estimated>) {
  return answer.ok ? answer.value.delta : null
}

/**
 * The estimate passes what the account has left of its 5-hour and weekly windows (09 §4.6): a percent need (the
 * quota impact, or a delta in percent) above the tightest window, or any need of a window used up.
 */
function insufficient(estimated: Estimated | undefined) {
  const remaining = estimated?.remaining
  if (estimated === undefined || remaining === undefined || remaining === null) return false
  const left = [remaining.fiveHour, remaining.weekly].filter((value): value is number => value !== null)
  if (left.length === 0) return false
  const room = Math.min(...left)
  const need = estimated.quota?.percent?.hi ?? (estimated.delta?.unit === "percent" ? estimated.delta.hi : undefined)
  return need === undefined ? room <= 0 : need > room
}

// ---------------------------------------------------------------------------------------------------------------
// The answer

function plannedOf(
  input: Input,
  location: string,
  target: Party,
  sizing: Sizing,
  chosen: Row,
): Omit<Planned, "nonce" | "expiresAt"> {
  const turns = sizing.zones.turns.length
  return {
    ref: input.request.ref,
    directory: input.request.directory,
    location,
    projectID: input.project.id,
    ...(turns === 0 ? {} : { upToTurn: turns - 1 }),
    turns,
    contentHash: Transcript.contentHash(sizing.zones.turns),
    target: input.request.target,
    ...(target.picked && target.account !== undefined ? { accountID: target.account.id } : {}),
    images: target.facts.images,
    storeFull: input.request.storeFull ?? true,
    redact: input.request.redact ?? true,
    // A chosen row is always available, and every available row has its run.
    run: chosen.run ?? { mode: "full", boundary: sizing.full.boundary },
  }
}

function planOf(context: {
  readonly input: Input
  readonly place: Place
  readonly branch: string | undefined
  readonly sizing: Sizing
  readonly target: Party
  readonly summarizer?: Summarizer
  readonly rows: Rows
  readonly chosen: Row
  readonly planned: Planned
}): OwnImport.Plan {
  const input = context.input
  const sizing = context.sizing
  const rows = context.rows
  const shape = context.chosen.shape ?? sizing.full
  const built = shape.built
  const split = shape.fitted === undefined || shape.fitted.whole ? undefined : shape.fitted
  const llm = sizing.llm
  const truncation =
    llm === undefined || context.summarizer === undefined || !rows.llm.option.available
      ? undefined
      : truncates(llm.helper, context.summarizer)
  const summarizing = context.chosen === rows.llm && llm !== undefined
  const flags: Record<OwnImport.Warning, boolean> = {
    source_live: input.transcript.source.live,
    source_folder_missing: context.place.missing,
    z_unknown: context.target.measured?.zSource !== "measured",
    compaction_may_truncate: truncation !== undefined,
    images_dropped: dropsImages(sizing.zones, shape),
    unknown_records: (input.transcript.dropped.unknownRecord ?? 0) > 0,
    // The chosen row's receivers: the target, and an LLM summary's summarizer when settings name another (09 §4.5).
    cross_company: context.chosen.option.send.crossCompany,
    history_base_partial: input.basePartial === true,
    quota_insufficient:
      rows.llm.option.reason === "quota_insufficient" ||
      context.target.account?.status === "exhausted" ||
      insufficient(context.chosen.first),
    summarizer_overridden: context.summarizer?.overridden === true,
    import_too_large: built.trimmedTurns > 0,
    location_differs: context.place.differs,
  }
  return {
    nonce: context.planned.nonce,
    expiresAt: context.planned.expiresAt,
    title: built.data.info.title ?? "",
    turns: sizing.zones.turns.length,
    location: {
      directory: context.place.directory,
      ...(context.branch === undefined || context.branch === "" ? {} : { branch: context.branch }),
      differsFromList: context.place.differs,
    },
    boundary: {
      at: placeOf(sizing.full.boundary),
      checkpoint: checkpointOf(sizing.full.boundary),
      sourceCompactions: sizing.zones.checkpoints.length,
    },
    size: {
      visible: Math.max(0, sizing.full.visible - sizing.full.built.notice),
      Z: context.target.Z,
      zSource: context.target.measured?.zSource ?? "default",
      exchange: context.target.exchange,
      window: context.target.window,
      ceiling: context.target.ceiling,
      ratio: sizing.ratio,
      capacity: Math.floor(shape.fitted?.capacity ?? Fill.capacity(sizing.budget, 0)),
      ...(split === undefined
        ? {}
        : {
            tail: { fromTurn: split.cut.turn, tokens: split.tokens },
            old: {
              turns: new Set(
                Fill.pieces(sizing.zones.turns, sizing.zones.visible, split.cut).map((piece) => piece.index),
              ).size,
              tokens: Fill.tokens(sizing.zones.turns, sizing.measure, sizing.zones.visible, split.cut),
            },
          }),
      ...(llm === undefined ? {} : { summaryInput: llm.helper.tokens }),
      ...(truncation === undefined ? {} : truncation),
    },
    summarizer:
      context.summarizer === undefined
        ? null
        : { model: context.summarizer.ref, overridden: context.summarizer.overridden },
    modes: [rows.full.option, rows.llm.option, rows.brief.option],
    store: {
      full: input.request.storeFull ?? true,
      bytes: built.bytes,
      budget: built.budget,
      trimmedTurns: built.trimmedTurns,
    },
    // An LLM summary also sends the summary input, whose tool output the stored short shape leaves out.
    redactions: built.redactions.count + (summarizing ? llm.helper.redactions.count : 0),
    dropped: Object.fromEntries(
      Object.entries(input.transcript.dropped).flatMap((entry) => (entry[1] === undefined ? [] : [entry])),
    ),
    warnings: OwnImport.Warning.literals.filter((warning) => flags[warning]),
    existing: [...input.existing],
  }
}

/** Where V starts as the plan shows it: `{turn, step}`, a cut before a turn as its step 0. */
function placeOf(boundary: Fill.Boundary) {
  if (boundary.type === "none") return null
  const cut = Fill.start(boundary)
  return { turn: cut.turn, step: cut.step ?? 0 }
}

function checkpointOf(boundary: Fill.Boundary): OwnImport.CheckpointKind | null {
  if (boundary.type === "source") return "foreign"
  if (boundary.type === "remote") return "codex-remote"
  return null
}

/** A user image of the model-visible part became a placeholder: the target takes none, or core's bounds. */
function dropsImages(zones: Fill.Zones, shape: Shape) {
  const shown = Fill.pieces(zones.turns, Fill.start(shape.boundary)).reduce(
    (total, piece) => total + (piece.user ? piece.turn.user.images.length : 0),
    0,
  )
  const inline = shape.built.data.messages.reduce(
    (total, message) => total + (message.type === "user" ? (message.files?.length ?? 0) : 0),
    0,
  )
  return inline < shown
}

/**
 * The summary input passes the summarizer's compaction budget (its ceiling, less its system and tools), so core
 * leaves out the oldest exchanges (`[N older exchanges omitted]`, 09 §4.3): the pieces a summary would have needed
 * and about how many exchanges (a user message and what follows it) go.
 */
function truncates(helper: Store.Helper, summarizer: Summarizer) {
  const room = Math.max(1, summarizer.ceiling - summarizer.Z)
  if (helper.tokens <= room) return undefined
  const exchanges = helper.data.messages.reduce<number[]>((sizes, message) => {
    const at = message.type === "user" || sizes.length === 0 ? sizes.length : sizes.length - 1
    sizes[at] = (sizes[at] ?? 0) + Store.estimate(message)
    return sizes
  }, [])
  const kept = exchanges.reduceRight(
    (state, tokens) =>
      state.full || state.tokens + tokens > room
        ? { ...state, full: true }
        : { tokens: state.tokens + tokens, count: state.count + 1, full: false },
    { tokens: 0, count: 0, full: false },
  )
  return {
    chunks: Math.max(2, Math.ceil(helper.tokens / room)),
    omitted: Math.max(1, exchanges.length - kept.count),
  }
}
