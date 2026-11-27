// The `Git 저장소로 만들기` dialog's rules (03 §4.3.1, 06 §3.0), apart from its UI so they are tested as written:
// the defaults (first commit on, the proposed .gitignore on where the folder has none, large and binary files out),
// what the first commit takes with the user's choices, the request, and a failure in plain words.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { OwnRpcError } from "@/data/rpc"
import type { TeamInput } from "@/data/team-rpc"
import type { GitInitKey } from "./git-init-strings"

type Plan = OwnTeam.GitInitPlan
type Listed = Extract<Plan["files"], { kind: "listed" }>
type Say = (key: GitInitKey, params?: Record<string, string | number>) => string

export interface Choices {
  /** `첫 저장 지점(커밋) 만들기`. */
  readonly commit: boolean
  /** The proposed .gitignore (only where the folder has none). */
  readonly gitignore: boolean
  /** Flagged files the user picked to commit anyway. */
  readonly include: ReadonlySet<string>
}

export interface Identity {
  readonly name: string
  readonly email: string
}

export function listed(plan: Plan): Listed | undefined {
  return plan.files.kind === "listed" ? plan.files : undefined
}

/** First commit on unless there are too many files; the proposal on; no flagged file picked. */
export function defaults(plan: Plan): Choices {
  return { commit: listed(plan) !== undefined, gitignore: !plan.gitignore.exists, include: new Set() }
}

/** The proposal applies: the folder has no .gitignore, and it is chosen or there would be too many files without it. */
export function proposalOn(plan: Plan, choices: Choices) {
  if (plan.gitignore.exists) return false
  return choices.gitignore || listed(plan)?.proposalRequired === true
}

/** The flagged files with these choices (the proposal hides the ones it leaves out anyway). */
export function visibleFlagged(plan: Plan, choices: Choices) {
  const on = proposalOn(plan, choices)
  return (listed(plan)?.flagged ?? []).filter((item) => !on || !item.ignored)
}

/** The biggest files the first commit would take with these choices. */
export function visibleLargest(plan: Plan, choices: Choices, limit = 5) {
  const on = proposalOn(plan, choices)
  return (listed(plan)?.largest ?? []).filter((item) => !on || !item.ignored).slice(0, limit)
}

/**
 * What the first commit takes: the plan's count with or without the proposal, less the flagged files not picked (and
 * those beyond the listed ones, by count). `undefined` when there are too many files to commit here.
 */
export function summary(plan: Plan, choices: Choices) {
  const files = listed(plan)
  if (!files) return undefined
  const on = proposalOn(plan, choices)
  const base = on
    ? files.total
    : { count: files.total.count + files.proposal.count, bytes: files.total.bytes + files.proposal.bytes }
  const left = visibleFlagged(plan, choices).filter((item) => !choices.include.has(item.path))
  return {
    count: Math.max(0, base.count - left.length - files.flaggedMore),
    bytes: Math.max(0, base.bytes - left.reduce((sum, item) => sum + item.bytes, 0)),
  }
}

/** git has no `user.name` or `user.email` here: the dialog asks (a first commit never makes one up). */
export function needsIdentity(plan: Plan) {
  return plan.identity.name === null || plan.identity.email === null
}

/** One line each, not blank; the email has an `@`. */
export function identityValid(identity: Identity) {
  const line = (value: string) => value.trim() !== "" && !/[\r\n\0]/.test(value) && value.length <= 256
  return line(identity.name) && line(identity.email) && identity.email.includes("@")
}

/** The `project.gitInit` input for these choices (the identity only where git has none). */
export function request(plan: Plan, choices: Choices, identity?: Identity): TeamInput<"project.gitInit"> {
  if (!choices.commit || !listed(plan)) return { directory: plan.directory }
  const flagged = new Set(visibleFlagged(plan, choices).map((item) => item.path))
  return {
    directory: plan.directory,
    firstCommit: {
      gitignore: proposalOn(plan, choices),
      include: [...choices.include].filter((path) => flagged.has(path)),
      ...(needsIdentity(plan) && identity
        ? { identity: { name: identity.name.trim(), email: identity.email.trim() } }
        : {}),
    },
  }
}

/** The confirm button: what it will do. */
export function confirmKey(plan: Plan, choices: Choices): GitInitKey {
  if (plan.state === "unborn") return "own.gitInit.confirmFirst"
  return choices.commit && listed(plan) ? "own.gitInit.confirmCommit" : "own.gitInit.confirm"
}

/** The confirm button can run: a first commit needs an identity (typed where git has none). */
export function canRun(plan: Plan, choices: Choices, identity: Identity) {
  if (plan.state === "unborn" && !(choices.commit && listed(plan))) return false
  if (!choices.commit || !listed(plan)) return true
  return !needsIdentity(plan) || identityValid(identity)
}

/** The repository an `inside` refusal names (offered as the project to open instead). */
export function insideParent(error: unknown) {
  if (!(error instanceof OwnRpcError) || error.type !== "git_init_refused") return undefined
  const data = error.data
  if (typeof data !== "object" || data === null || !("why" in data) || data.why !== "inside") return undefined
  return "parent" in data && typeof data.parent === "string" ? data.parent : undefined
}

/** A failure of either call in plain words. */
export function failureText(say: Say, error: unknown): string {
  if (!(error instanceof OwnRpcError)) return say("own.gitInit.failed", { reason: String(error) })
  const data: Record<string, unknown> = typeof error.data === "object" && error.data !== null ? { ...error.data } : {}
  const text = (value: unknown) => (typeof value === "string" ? value : "")
  if (error.type === "git_init_refused") {
    if (data.why === "inside") return say("own.gitInit.refused.inside", { parent: text(data.parent) })
    if (data.why === "exists") return say("own.gitInit.refused.exists")
    if (data.why === "system") return say("own.gitInit.refused.system")
    if (data.why === "busy") return say("own.gitInit.refused.busy")
    return say("own.gitInit.refused.tooMany")
  }
  if (error.type === "identity_missing") return say("own.gitInit.identityMissing")
  if (error.type === "git_too_old")
    return text(data.version)
      ? say("own.gitInit.gitTooOld", { version: text(data.version), minimum: text(data.minimum) })
      : say("own.gitInit.gitMissing")
  if (error.type === "git_failed") return say("own.gitInit.gitFailed", { message: text(data.message) })
  if (error.type === "not_found") return say("own.gitInit.notFound")
  return say("own.gitInit.failed", { reason: error.message })
}
