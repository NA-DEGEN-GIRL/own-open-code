export * as AccountsRpc from "./accounts-rpc.js"

import type { Plugin } from "@opencode/plugin"
import type { Rpc } from "@opencode/schema/rpc"
import { OwnAccounts, Portable } from "@own/protocol"

/**
 * own.accounts through `ctx.rpc` (06 §2.5 "승인 모드, 영역 프리셋", §2.6): never over HTTP, never a second copy of its
 * logic. A plugin's RPC call is answered in the calling instance's Location, so each call uses the instance at the
 * session's folder when it is alive, else the control location's (`Services.Base.instance`). Calls never throw: an
 * own.accounts error comes back as `{ok: false, type, message, data}` (`unavailable` when no instance is alive).
 *
 * own.team never sets or forwards computer use: `approvalSet` callers pass no `computerUse` (it is the user's per-session
 * switch, and own-accounts' read-merge-write keeps an existing computer allow).
 *
 * RH-20: every call answers within {@link TIMEOUT_MS} (`switch.apply` within {@link APPLY_TIMEOUT_MS}) with
 * `{ok: false, type: "timeout"}` otherwise: callers run inside an area's admission lock or an op step and already
 * fail closed, so a handler that never answers no longer holds them.
 */

/** How long an own.accounts call may take before it answers `timeout` (RH-20). */
export const TIMEOUT_MS = 30_000
/** `switch.apply` may wait for a compaction or a model call before it answers. */
export const APPLY_TIMEOUT_MS = 120_000

type Definition = OwnAccounts.Definition
type Method = keyof Definition["methods"] & string
export type Input<N extends Method> = Rpc.Input<Definition["methods"][N]["input"]>
export type Output<N extends Method> = Rpc.Output<Definition["methods"][N]["output"]>

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly type: string; readonly message: string; readonly data?: unknown }

/** Where to call from: the folder of the session the call is about (its Location instance answers). */
export interface Where {
  readonly directory?: string
}

export interface Client {
  approvalGet(input: Input<"session.approval.get">, where?: Where): Promise<Result<Output<"session.approval.get">>>
  /** Read-merge-write of the own bundle; own.team never passes `computerUse`. */
  approvalSet(input: Input<"session.approval.set">, where?: Where): Promise<Result<Output<"session.approval.set">>>
  presetGet(input: Input<"session.preset.get">, where?: Where): Promise<Result<Output<"session.preset.get">>>
  presetApply(input: Input<"session.preset.apply">, where?: Where): Promise<Result<Output<"session.preset.apply">>>
  switchEstimate(input: Input<"switch.estimate">, where?: Where): Promise<Result<Output<"switch.estimate">>>
  switchApply(input: Input<"switch.apply">, where?: Where): Promise<Result<Output<"switch.apply">>>
  switchState(input: Input<"switch.state">, where?: Where): Promise<Result<Output<"switch.state">>>
  /** Drops the session's pending switch; one already `SWITCHING` lands anyway (own-accounts `switching.ts`). */
  switchCancel(input: Input<"switch.cancel">, where?: Where): Promise<Result<Output<"switch.cancel">>>
  quotaSnapshot(input: Input<"quota.snapshot">, where?: Where): Promise<Result<Output<"quota.snapshot">>>
  accountsList(where?: Where): Promise<Result<Output<"accounts.list">>>
  /** The sessions' bindings: their model and the account they run on (one of the Claude accounts on `anthropic`). */
  sessionBinding(input: Input<"session.binding">, where?: Where): Promise<Result<Output<"session.binding">>>
  /** The Claude account a session's tree runs on (its team's in a team, 07 R4), whatever model it runs now. */
  claudeSession(
    input: Input<"plugin.claudeAuth.session.get">,
    where?: Where,
  ): Promise<Result<Output<"plugin.claudeAuth.session.get">>>
  /** The Claude Agent account a session's tree runs on (its team's in a team, 02 §8.10, 07 R4). */
  claudeAgentSession(
    input: Input<"claudeAgent.session.get">,
    where?: Where,
  ): Promise<Result<Output<"claudeAgent.session.get">>>
  presetsList(input: Input<"presets.list">, where?: Where): Promise<Result<Output<"presets.list">>>
  /** A worktree conversation keeps the Claude account of the conversation that started it (06 §13). */
  claudeSessionSet(
    input: Input<"plugin.claudeAuth.session.set">,
    where?: Where,
  ): Promise<Result<Output<"plugin.claudeAuth.session.set">>>
  claudeAgentSessionSet(
    input: Input<"claudeAgent.session.set">,
    where?: Where,
  ): Promise<Result<Output<"claudeAgent.session.set">>>
  policyGet(where?: Where): Promise<Result<Output<"policy.get">>>
}

let portable: Definition | undefined
/** The definition as Standard Schema: the host cannot run this bundle's `effect` schemas (own-protocol portable.ts). */
function definition() {
  return (portable ??= Portable.definition(OwnAccounts.Definition))
}

function client(ctx: Pick<Plugin.Context, "rpc">) {
  return ctx.rpc(definition())
}

export function create(
  pick: (directory?: string) => Pick<Plugin.Context, "rpc"> | undefined,
  limits: { readonly timeoutMs?: number; readonly applyTimeoutMs?: number } = {},
): Client {
  const run = async <T>(
    where: Where | undefined,
    call: (rpc: ReturnType<typeof client>) => Promise<T>,
    ms = limits.timeoutMs ?? TIMEOUT_MS,
  ): Promise<Result<T>> => {
    const ctx = pick(where?.directory)
    if (!ctx) return unavailable<T>()
    const timer = Promise.withResolvers<Result<T>>()
    const cancel = setTimeout(
      () => timer.resolve({ ok: false, type: "timeout", message: "계정 서비스가 제때 답하지 않았어요" }),
      ms,
    )
    cancel.unref?.()
    const answered = call(client(ctx)).then(
      (value): Result<T> => ({ ok: true, value }),
      (error: unknown): Result<T> => failed(error),
    )
    return Promise.race([answered, timer.promise]).finally(() => clearTimeout(cancel))
  }
  return {
    approvalGet: (input, where) => run(where, (rpc) => rpc["session.approval.get"](input)),
    approvalSet: (input, where) => run(where, (rpc) => rpc["session.approval.set"](input)),
    presetGet: (input, where) => run(where, (rpc) => rpc["session.preset.get"](input)),
    presetApply: (input, where) => run(where, (rpc) => rpc["session.preset.apply"](input)),
    switchEstimate: (input, where) => run(where, (rpc) => rpc["switch.estimate"](input)),
    switchApply: (input, where) =>
      run(where, (rpc) => rpc["switch.apply"](input), limits.applyTimeoutMs ?? APPLY_TIMEOUT_MS),
    switchState: (input, where) => run(where, (rpc) => rpc["switch.state"](input)),
    switchCancel: (input, where) => run(where, (rpc) => rpc["switch.cancel"](input)),
    quotaSnapshot: (input, where) => run(where, (rpc) => rpc["quota.snapshot"](input)),
    accountsList: (where) => run(where, (rpc) => rpc["accounts.list"]({})),
    sessionBinding: (input, where) => run(where, (rpc) => rpc["session.binding"](input)),
    claudeSession: (input, where) => run(where, (rpc) => rpc["plugin.claudeAuth.session.get"](input)),
    claudeAgentSession: (input, where) => run(where, (rpc) => rpc["claudeAgent.session.get"](input)),
    presetsList: (input, where) => run(where, (rpc) => rpc["presets.list"](input)),
    claudeSessionSet: (input, where) => run(where, (rpc) => rpc["plugin.claudeAuth.session.set"](input)),
    claudeAgentSessionSet: (input, where) => run(where, (rpc) => rpc["claudeAgent.session.set"](input)),
    policyGet: (where) => run(where, (rpc) => rpc["policy.get"]({})),
  }
}

function unavailable<T>(): Result<T> {
  return { ok: false, type: "unavailable", message: "계정 서비스에 닿을 팀 서비스가 아직 준비되지 않았어요" }
}

/** An RPC client rejects with `{type, message, data?}`; anything else is an internal failure. */
function failed<T>(error: unknown): Result<T> {
  if (typeof error === "object" && error !== null) {
    const record: Readonly<Record<string, unknown>> = { ...error }
    if (typeof record.type === "string")
      return {
        ok: false,
        type: record.type,
        message: typeof record.message === "string" ? record.message : record.type,
        ...(record.data === undefined ? {} : { data: record.data }),
      }
  }
  return { ok: false, type: "internal", message: error instanceof Error ? error.message : String(error) }
}
