// Integration card and upload flow (06 §7, §9.7, §7.5), pure, in the team chunk. `integrationView` words one
// `Integration` as 9.7 does: progress `인벤토리 화면 반영하는 중 · 검사 1/2`; done `… 프로젝트 본 코드에
// 반영했습니다 [되돌리기] [원격 저장소에 올리기…]`, with `그 뒤 저장 지점 n개는 넣지 않았습니다`; waiting for
// overlapping changes `[다시 반영]` (the overlapping paths only in 자세히), for stopped work or for a folder outside
// the team; failure `[로그 보기]`; and the conflict the owner sorts out. After the target moved on (7.4) the card
// offers `메인에게 되돌리기 맡기기` instead of 되돌리기. An undo that waits outside its op (`Integration.undoing`)
// says why and offers `되돌리기 취소` (RH-42) instead. The branch tip applied without a reported candidate (7.1) lists
// the subjects of what goes in. 자세히 is 7.5's `검증한 것: 후보 a1b2c3d (…)`, the check
// results and the paths. The words never use git terms (9.1); shas, the record name and paths stay in 자세히.
// The upload (7.5) is `integration.push.plan` -> the dialog (remote; record name and commands under 자세히) ->
// `integration.push.execute{nonce}`. Nothing is sent with an expired or refused nonce: a new plan is shown instead.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { OwnRpcError } from "@/data/rpc"
import type { TeamOutput, TeamRpc } from "@/data/team-rpc"
import { viewOnlyText, type TeamText } from "./model"
import type { TeamKey } from "./strings"
import type { TeamWaitKey, TeamWaitText } from "./wait-strings"

/** What a button of the integration card does. */
export type IntegrationAction =
  /** `integration.undo` (7.4). */
  | { readonly kind: "undo" }
  /** The target moved past the candidate: the team main is asked to undo it (7.4). */
  | { readonly kind: "undo-main" }
  /** `integration.undo.cancel`: the undo that waits outside its op is dropped (7.4, RH-42). */
  | { readonly kind: "undo-cancel" }
  /** `integration.push.plan`, then the upload dialog (7.5). */
  | { readonly kind: "push"; readonly pr: boolean }
  /** `area.integrate` again (`다시 반영`, 7.2). */
  | { readonly kind: "retry" }
  /** The failed check's output. */
  | { readonly kind: "log" }
  /** The review request's page, in the browser. */
  | { readonly kind: "pr-page"; readonly url: string }

export interface IntegrationLine {
  readonly text: string
  readonly tone?: "muted" | "warn"
}

export interface IntegrationButton {
  readonly label: string
  readonly action: IntegrationAction
}

export interface IntegrationView {
  readonly headline: string
  /** `warn`: it waits for the user or the owner; `danger`: it stopped. */
  readonly tone?: "warn" | "danger"
  readonly lines: readonly IntegrationLine[]
  readonly buttons: readonly IntegrationButton[]
  /** 자세히: what was checked, the check results, the record name and the paths. */
  readonly details: readonly string[]
  /** The failed check's output (`로그 보기`). */
  readonly log?: string
}

/** Names the card shows, resolved by the caller from the stores. */
export interface IntegrationNames {
  readonly area: string
  /** A folder as 9.1 names it: the main folder `메인 폴더(<이름>)`, any other its short name. */
  readonly folder: (directory: string) => string
  /** `2분 14초`. */
  readonly duration: (ms: number) => string
}

export interface IntegrationInput {
  readonly integration: OwnTeam.Integration
  readonly names: IntegrationNames
  /** This build has the feature and this connection the scope for an action. */
  readonly can: (action: IntegrationAction["kind"]) => boolean
  /** The words of an undo that waits (RH-42): in the lazy `wait-strings.ts`, not the first chunk (PF5). */
  readonly waitText: TeamWaitText
  /** `integration.undo` answered that the target moved past the candidate (7.4). */
  readonly delegated?: boolean
  /** Uploading needs the PC (`local`): a gateway device sees where to do it instead (06 §9.8). */
  readonly viewOnly?: string
}

/** The part of the TeamStore the card asks: this build's features and this connection's scopes. */
export interface IntegrationAccess {
  has(feature: OwnTeam.Feature): boolean
  readonly rpc: Pick<TeamRpc, "allowed">
}

/**
 * Which card actions this build of own.team has (`health.features`) and this connection may use (06 §2.7): undoing
 * and applying again need `admin`, uploading `local` (a PC window). `prompt`: the connection may prompt and the team
 * main is known, for the hand-over of an undo to the main.
 */
export function integrationCan(team: IntegrationAccess, prompt: boolean) {
  return (kind: IntegrationAction["kind"]) => {
    if (kind === "undo") return team.has("integrate") && team.rpc.allowed("integration.undo")
    if (kind === "undo-cancel") return team.has("undo-cancel") && team.rpc.allowed("integration.undo.cancel")
    if (kind === "retry") return team.has("integrate") && team.rpc.allowed("area.integrate")
    if (kind === "push") return team.has("push") && team.rpc.allowed("integration.push.plan")
    if (kind === "undo-main") return prompt
    return true
  }
}

/** A build that can upload on a connection that may not (a gateway device): where to do it instead (06 §9.8). */
export function uploadElsewhere(text: TeamText, team: IntegrationAccess, pc?: string) {
  return team.has("push") && !team.rpc.allowed("integration.push.plan") ? viewOnlyText(text, "confirm", pc) : undefined
}

const WAITING: Readonly<Record<NonNullable<OwnTeam.Integration["waiting"]>["why"], TeamKey>> = {
  dirty: "own.team.integrate.waiting.dirty",
  "in-use": "own.team.integrate.waiting.inUse",
  "in-progress": "own.team.integrate.waiting.inProgress",
  outside: "own.team.integrate.waiting.outside",
}

const UNDO_WAITING: Readonly<Record<NonNullable<OwnTeam.Integration["undoing"]>["why"], TeamWaitKey>> = {
  dirty: "own.team.wait.undo.dirty",
  "in-use": "own.team.wait.undo.inUse",
  "in-progress": "own.team.wait.undo.inProgress",
  outside: "own.team.wait.undo.outside",
}

const FAILED: Readonly<Record<OwnTeam.IntegrationFailure, TeamKey>> = {
  verify: "own.team.integrate.failed.verify",
  assets: "own.team.integrate.failed.assets",
  cone: "own.team.integrate.failed.cone",
  conflict: "own.team.integrate.failed.conflict",
  moved: "own.team.integrate.failed.moved",
  rewritten: "own.team.integrate.failed.rewritten",
  heavy: "own.team.integrate.failed.heavy",
  broken: "own.team.integrate.failed.broken",
  error: "own.team.integrate.failed.error",
}

/**
 * Why a failed integration stopped. `assets` without an asset check result is the user's 두기 on making `.assets` the
 * first time (4.10, 0.3): no check ran, so the card must not say one failed.
 */
function failedKey(integration: Pick<OwnTeam.Integration, "failure" | "verify">): TeamKey {
  if (integration.failure === "assets" && integration.verify.assets === undefined)
    return "own.team.integrate.failed.assetsDeclined"
  return FAILED[integration.failure ?? "error"]
}

/** The card of an integration (06 §9.7). Pure. */
export function integrationView(text: TeamText, input: IntegrationInput): IntegrationView {
  const integration = input.integration
  const area = input.names.area
  const failedLog = [integration.verify.code, integration.verify.assets].find(
    (result): result is OwnTeam.VerifyResult => typeof result === "object" && !result.ok,
  )?.log
  const base = { lines: [], buttons: [], details: details(text, input) }
  const going = subjectsLine(text, integration)
  switch (integration.state) {
    case "running":
      return { ...base, headline: running(text, integration, area), lines: going }
    case "waiting":
      return {
        ...base,
        headline: running(text, integration, area),
        tone: "warn",
        lines: [
          ...(integration.waiting
            ? [{ text: waitingText(text, integration.waiting, input.names), tone: "warn" as const }]
            : []),
          ...going,
        ],
        buttons: retry(text, input),
      }
    case "conflict":
      return {
        ...base,
        headline: text("own.team.integrate.conflict"),
        tone: "warn",
        lines: integration.conflicts?.length
          ? [{ text: text("own.team.integrate.conflictFiles", { n: integration.conflicts.length }) }]
          : [],
      }
    case "failed":
      return {
        ...base,
        headline: text(failedKey(integration)),
        tone: "danger",
        buttons: [
          ...(failedLog ? [{ label: text("own.team.action.log"), action: { kind: "log" as const } }] : []),
          ...(integration.failure === "moved" ? retry(text, input) : []),
        ],
        ...(failedLog ? { log: failedLog } : {}),
      }
    case "undone":
      return { ...base, headline: text("own.team.integrate.undone", { area }) }
    case "done":
      // 7.2 step 2 ends before a candidate is made: the work was in the target already.
      if (!integration.advanced && integration.candidate === undefined)
        return { ...base, headline: text("own.team.integrate.already", { area }) }
      return { ...base, ...applied(text, input, going), ...(integration.undoing ? { tone: "warn" as const } : {}) }
  }
}

/**
 * 7.1: an integration of the branch tip without a reported candidate shows the subjects of what goes in (the first
 * three here, all of them in 자세히).
 */
function subjectsLine(text: TeamText, integration: OwnTeam.Integration): IntegrationLine[] {
  const subjects = integration.subjects ?? []
  if (subjects.length === 0) return []
  const more = subjects.length > 3 ? " …" : ""
  return [
    {
      text: text("own.team.integrate.subjects", {
        n: subjects.length,
        list: `${subjects.slice(0, 3).join(" · ")}${more}`,
      }),
      tone: "muted",
    },
  ]
}

/** `인벤토리 화면 반영하는 중 · 검사 1/2`. */
function running(text: TeamText, integration: OwnTeam.Integration, area: string) {
  const head = text("own.team.integrate.running", { area })
  const checks = integration.checks
  return checks ? `${head} · ${text("own.team.integrate.checks", { n: checks.current, total: checks.total })}` : head
}

/** 7.2: why it waits, with the folder in plain words; the overlapping paths are listed in 자세히. */
function waitingText(text: TeamText, waiting: NonNullable<OwnTeam.Integration["waiting"]>, names: IntegrationNames) {
  return text(WAITING[waiting.why], { folder: names.folder(waiting.directory), n: waiting.paths?.length ?? 0 })
}

function retry(text: TeamText, input: IntegrationInput): IntegrationButton[] {
  return input.can("retry") ? [{ label: text("own.team.action.retryIntegrate"), action: { kind: "retry" } }] : []
}

/** Done (9.7 끝): the result line, left-out save points, the upload and the undo or its hand-over to the main. */
function applied(
  text: TeamText,
  input: IntegrationInput,
  going: readonly IntegrationLine[],
): Pick<IntegrationView, "headline" | "lines" | "buttons"> {
  const integration = input.integration
  const area = input.names.area
  const pushed = integration.pushed
  const skipped = integration.newerSkipped ?? 0
  const upload = input.can("push")
  const undoing = integration.undoing
  const undo = undoing
    ? input.can("undo-cancel")
      ? [{ label: input.waitText("own.team.wait.undoCancel"), action: { kind: "undo-cancel" as const } }]
      : []
    : input.delegated
      ? input.can("undo-main")
        ? [{ label: text("own.team.integrate.undoMain"), action: { kind: "undo-main" as const } }]
        : []
      : input.can("undo")
        ? [{ label: text("own.team.action.undo"), action: { kind: "undo" as const } }]
        : []
  return {
    headline: text("own.team.card.integrated", { area }),
    lines: [
      // RH-42: the undo waits for the folder that has the target checked out (7.4).
      ...(undoing
        ? [
            {
              text: input.waitText(UNDO_WAITING[undoing.why], {
                folder: input.names.folder(undoing.directory),
                n: undoing.paths?.length ?? 0,
              }),
              tone: "warn" as const,
            },
          ]
        : []),
      ...(skipped > 0 ? [{ text: text("own.team.card.newerSkipped", { n: skipped }) }] : []),
      ...(pushed ? [{ text: text("own.team.card.pushed", { area, remote: pushed.remote }) }] : []),
      ...(input.delegated ? [{ text: text("own.team.integrate.undoMainHint"), tone: "muted" as const }] : []),
      ...(!upload && input.viewOnly && !pushed?.pr ? [{ text: input.viewOnly, tone: "muted" as const }] : []),
      ...going,
    ],
    buttons: [
      ...undo,
      ...(upload && !pushed
        ? [{ label: text("own.team.push.action"), action: { kind: "push" as const, pr: false } }]
        : []),
      ...(upload && !pushed?.pr
        ? [{ label: text("own.team.push.prAction"), action: { kind: "push" as const, pr: true } }]
        : []),
      ...(pushed?.pr
        ? [{ label: text("own.team.card.openPr"), action: { kind: "pr-page" as const, url: pushed.pr } }]
        : []),
    ],
  }
}

/** 7.5 자세히: `검증한 것: 후보 a1b2c3d (…)`, the check results, the record name and the paths. */
function details(text: TeamText, input: IntegrationInput) {
  const integration = input.integration
  const names = input.names
  const code = integration.verify.code
  const assets = integration.verify.assets
  const cone = integration.verify.cone
  return [
    ...(integration.candidate && integration.base
      ? [
          text("own.team.integrate.details.verified", {
            candidate: short(integration.candidate),
            base: short(integration.base),
            area: names.area,
            source: short(integration.source),
          }),
        ]
      : []),
    ...(code
      ? [
          code.ok
            ? text("own.team.integrate.details.codePassed", { time: names.duration(code.ms) })
            : text("own.team.integrate.details.codeFailed", { command: code.failed ?? "" }),
        ]
      : []),
    ...(assets === "skipped" ? [text("own.team.integrate.details.assetsSkipped")] : []),
    ...(typeof assets === "object" && assets.ok
      ? [text("own.team.integrate.details.assetsPassed", { time: names.duration(assets.ms) })]
      : []),
    ...(typeof assets === "object" && !assets.ok && assets.failed ? [assets.failed] : []),
    ...(cone && !cone.ok && cone.missing.length > 0
      ? [text("own.team.integrate.details.missing", { dirs: cone.missing.join(", ") })]
      : []),
    text("own.team.push.record", { name: integration.target }),
    ...(integration.subjects ?? []),
    ...(integration.waiting ? [integration.waiting.directory, ...(integration.waiting.paths ?? [])] : []),
    ...(integration.undoing ? [integration.undoing.directory, ...(integration.undoing.paths ?? [])] : []),
    ...(integration.state === "conflict" ? (integration.conflicts ?? []) : []),
  ]
}

function short(sha: string) {
  return sha.slice(0, 7)
}

// ---------------------------------------------------------------------------------------------------------------
// Uploading and review requests (7.5)

/** A plan the upload dialog shows: remote, record name and commands, bound to a 10-minute nonce. */
export interface PushPlan extends TeamOutput<"integration.push.plan"> {
  readonly integrationID: OwnTeam.IntegrationID
  /** 검토 요청 올리기. */
  readonly pr: boolean
}

export type PushStart =
  | { readonly kind: "started"; readonly opID: OwnTeam.OpID }
  /** The nonce had expired or was refused: nothing ran, and this plan is to be confirmed again. */
  | { readonly kind: "renewed"; readonly plan: PushPlan }

/** `integration.push.plan`: what would run, before anything does (7.5). */
export async function planPush(
  rpc: Pick<TeamRpc, "call">,
  integrationID: OwnTeam.IntegrationID,
  pr: boolean,
): Promise<PushPlan> {
  const plan = await rpc.call("integration.push.plan", { integrationID, ...(pr ? { pr } : {}) })
  return { ...plan, integrationID, pr }
}

/**
 * `integration.push.execute{nonce}` with the nonce the dialog showed. An expired nonce is not sent, and a refused one
 * (`nonce_invalid`) runs nothing: either way a new plan comes back to be confirmed again. Other refusals go to the caller.
 */
export async function executePush(rpc: Pick<TeamRpc, "call">, plan: PushPlan, now = Date.now()): Promise<PushStart> {
  if (now >= plan.expiresAt) return { kind: "renewed", plan: await planPush(rpc, plan.integrationID, plan.pr) }
  const opID = await rpc.call("integration.push.execute", { nonce: plan.nonce }).then(
    (output) => output.opID,
    (error: unknown) => {
      if (error instanceof OwnRpcError && error.type === "nonce_invalid") return undefined
      throw error
    },
  )
  if (opID === undefined) return { kind: "renewed", plan: await planPush(rpc, plan.integrationID, plan.pr) }
  return { kind: "started", opID }
}

/**
 * Git's own words when a remote wants a sign-in it could not ask for (`GIT_TERMINAL_PROMPT=0`, 7.5). The same rule as
 * own.team's push step, which puts the sign-in hint in front of git's message.
 */
const SIGN_IN =
  /terminal prompts disabled|could not read (?:username|password)|authentication failed|invalid username or password|permission denied \(publickey|\b40[13]\b/i

/** What the toast says when the upload op ended (7.5): uploaded, the large files failed first, a sign-in, or why. */
export function pushOutcome(
  text: TeamText,
  plan: Pick<PushPlan, "pr" | "remote">,
  op: Pick<OwnTeam.Op, "state" | "steps"> | undefined,
): { readonly message: string; readonly tone?: "danger" } {
  if (op?.state === "done")
    return { message: plan.pr ? text("own.team.push.prDone") : text("own.team.push.done", { remote: plan.remote }) }
  const failed = op?.steps.find((step) => step.state === "failed")
  if (failed?.kind === "push-lfs") return { tone: "danger", message: text("own.team.push.largeFailed") }
  if (failed?.note && SIGN_IN.test(failed.note)) return { tone: "danger", message: text("own.team.push.login") }
  return {
    tone: "danger",
    message: text("own.team.push.failed", { reason: failed?.note ?? text("own.team.error.internalError") }),
  }
}
