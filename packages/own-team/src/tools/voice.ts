export * as VoicePlan from "./voice.js"

import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnID, type OwnTeam } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { OwnTeamRouting } from "@own/protocol/rpc-team-routing"
import { PromptHook } from "../hooks/prompt.js"
import { Confirm } from "../ops/confirm.js"
import type { Services } from "../services.js"
import type { MainTools } from "./main.js"

/**
 * Plans and their approval for team actions told in plain language (06 §2.9, user decision V-D1 of 2026-10-09). An
 * action that is risky, hard to undo or the user's alone first answers a plan: the text the model shows and a `token`,
 * with nothing changed. The token runs the planned action once, and only in the turn opened by the first user message
 * after the plan's turn ended: the code decides it from the session's messages, never from what a message says.
 *
 * - One live plan per session, in the controller's memory (like push plans, `integrate/push.ts`): a new plan replaces
 *   the old one, and a restart forgets them (plan again).
 * - The anchor is the session's newest message when the plan is made. Approval needs, after it, an `idle` marker (the
 *   plan's turn ended: core writes one per busy period, prompts steered in meanwhile included) and then a reply R: the
 *   first `user` message that is not a machine's (`PromptHook.machine`: a main request, `own.accounts`, `own.team`).
 *   Synthetic messages (team updates, wakes) are another type and never count. Another `idle` after R ends the
 *   approval (`plan_stale`): a later turn cannot use an earlier answer.
 * - R's device stamp (`metadata["own.device"]`, written by the gateway, 05 §13.4) must hold the scope of the button
 *   the action stands for (`OwnTeamRouting.MethodScope`); a `local` action is never approved from a device. A message
 *   without a stamp is the PC's (its own clients do not pass the gateway).
 * - The plan is removed synchronously right before it runs, so two calls in one Code Mode run execute it once. A run
 *   that fails used the token all the same.
 *
 * What the code cannot see is recorded in 06 §2.9: what R says (a "no" in R's turn still lets a token call through),
 * a reply typed before the plan was shown, a program holding the service password, and a device's slash command (no
 * metadata, so it reads as the PC's). Replies never throw and never hold an inner nonce (a step confirm's, a push's).
 */

export interface Caller {
  readonly sessionID: string
  /** The session's folder (`location[directory]` of the message reads). */
  readonly directory: string
}

export interface Issue {
  /** The team tool's name (`area`, `control`, `integrate`, `reorganize`). */
  readonly tool: string
  readonly action: string
  /** The RPC method of the same button: its device scope is the plan's. */
  readonly method: OwnTeam.MethodName
  /** What changes, what stays and how to undo it, in plain Korean. */
  readonly text: string
  /** The expiry of a nonce the plan wraps (a step confirm, a push plan): the plan ends no later. */
  readonly expiresAt?: number
  /** Runs the planned action with the targets resolved when the plan was made. */
  readonly run: () => Promise<MainTools.Reply>
}

export type Refusal = "plan_unknown" | "plan_expired" | "plan_mismatch" | "plan_stale" | "needs_user" | "needs_pc"

interface Plan {
  readonly token: string
  readonly sessionID: string
  readonly tool: string
  readonly action: string
  readonly scope: OwnTeam.Scope
  readonly anchor: string
  readonly expiresAt: number
  readonly run: () => Promise<MainTools.Reply>
}

/** Messages read for an approval: the newest of the session, as the message list pages them. */
export const WINDOW = 200

export const ASK =
  "위 내용을 사용자에게 그대로 보여 주고 할지 물으세요. 사용자가 다음 메시지로 하라고 답하면, 그 메시지에 답하는 차례에서 같은 action에 token을 붙여 다시 부르세요. 답이 오기 전이나 다른 말에 이어서는 실행되지 않습니다."
export const REPLACED = "앞서 낸 계획은 버렸습니다(대화마다 계획은 하나입니다)."
export const NO_ANCHOR = "대화 기록을 읽지 못해 계획을 내지 못했습니다. 잠시 뒤 다시 부르세요."
export const USED = "이 계획은 쓰였습니다. 다시 하려면 다시 계획하세요."

export const TEXT: { readonly [K in Exclude<Refusal, "needs_pc">]: string } = {
  needs_user:
    "사용자가 아직 이 계획에 답하지 않았습니다. 계획을 보여 주고 이번 차례를 마친 뒤 사용자의 다음 메시지를 기다리세요.",
  plan_unknown: "이 계획을 찾지 못했습니다(이미 쓰였거나, 새 계획으로 바뀌었거나, 프로그램이 다시 시작됨). 다시 계획하세요.",
  plan_expired: "계획을 낸 지 오래되어 끝났습니다. 다시 계획하세요.",
  plan_mismatch: "token이 이 동작의 계획이 아닙니다. 계획한 동작과 같은 action으로 부르거나 다시 계획하세요.",
  plan_stale: "사용자의 답이 연 차례가 이미 끝났습니다. 다시 계획하세요.",
}

/** `needs_pc`: the reply came from a device that cannot press the button. */
export function needsPc(scope: OwnTeam.Scope) {
  const needed = scope === "local" ? "PC에서만 할 수 있음" : `기기 범위 ${scope} 필요`
  return `이 동작은 그 기기에서 승인할 수 없습니다(${needed}). PC에서 다시 말하거나 화면 단추를 쓰세요.`
}

/** Live plans per controller (`Services.Base`), one per session. */
const plans = new WeakMap<object, Map<string, Plan>>()

function store(services: Services.Base) {
  const found = plans.get(services)
  if (found) return found
  const made = new Map<string, Plan>()
  plans.set(services, made)
  return made
}

/** Makes the session's plan (replacing an older one) and answers its text and token; changes nothing else. */
export async function issue(services: Services.Base, caller: Caller, input: Issue): Promise<MainTools.Reply> {
  const newest = await services.http.session.messages({
    sessionID: caller.sessionID,
    directory: caller.directory,
    limit: 1,
    order: "desc",
  })
  const anchor = newest.ok ? read(newest.value.data)[0]?.id : undefined
  // Without an anchor no approval could be decided: no plan (the closed side).
  if (anchor === undefined) return { ok: false, error: "plan_failed", text: NO_ANCHOR }
  const now = services.clock.now()
  const plan: Plan = {
    token: OwnID.Nonce.create(),
    sessionID: caller.sessionID,
    tool: input.tool,
    action: input.action,
    scope: OwnTeamRouting.MethodScope[input.method],
    anchor,
    expiresAt: Math.min(now + Confirm.TTL_MS, input.expiresAt ?? Number.POSITIVE_INFINITY),
    run: input.run,
  }
  const stored = store(services)
  const replaced = stored.has(caller.sessionID)
  stored.set(caller.sessionID, plan)
  return {
    ok: true,
    plan: true,
    token: plan.token,
    expiresAt: plan.expiresAt,
    text: [input.text, ASK, ...(replaced ? [REPLACED] : [])].join("\n"),
  }
}

/** Runs the session's plan once when `token` names it and the user approved it (see the module comment). */
export async function redeem(
  services: Services.Base,
  caller: Caller,
  input: { readonly tool: string; readonly action: string; readonly token: string },
): Promise<MainTools.Reply> {
  const stored = store(services)
  const plan = stored.get(caller.sessionID)
  if (!plan || plan.token !== input.token) return refuse("plan_unknown")
  const forget = () => {
    if (stored.get(caller.sessionID) === plan) stored.delete(caller.sessionID)
  }
  if (services.clock.now() >= plan.expiresAt) {
    forget()
    return refuse("plan_expired")
  }
  if (plan.tool !== input.tool || plan.action !== input.action) return refuse("plan_mismatch")
  const listed = await services.http.session.messages({
    sessionID: caller.sessionID,
    directory: caller.directory,
    limit: WINDOW,
    order: "desc",
  })
  // Unreadable: no approval now, the plan stays (the closed side).
  if (!listed.ok) return refuse("needs_user")
  const messages = read(listed.value.data).toReversed()
  const at = messages.findIndex((message) => message.id === plan.anchor)
  // Reverted away, or older than the window: the plan cannot be approved any more.
  if (at < 0) {
    forget()
    return refuse("plan_unknown")
  }
  const after = messages.slice(at + 1)
  const idle = after.findIndex(isIdle)
  if (idle < 0) return refuse("needs_user")
  const later = after.slice(idle + 1)
  const reply = later.findIndex((message) => message.type === "user" && !PromptHook.machine(message.metadata))
  if (reply < 0) return refuse("needs_user")
  if (later.slice(reply + 1).some(isIdle)) {
    forget()
    return refuse("plan_stale")
  }
  if (!allowed(plan.scope, later[reply]?.metadata)) {
    forget()
    return { ok: false, error: "needs_pc", text: needsPc(plan.scope) }
  }
  // Another call of this run took it, or a new plan replaced it, while the messages were read.
  if (stored.get(caller.sessionID) !== plan) return refuse("plan_unknown")
  stored.delete(caller.sessionID)
  const done = await plan.run()
  return done.ok ? done : { ...done, text: `${done.text} ${USED}` }
}

/**
 * Whether the user wrote into the caller's current run (2026-11-14): `ok` when, after the session's last `idle`
 * marker, the first `user` message that is not a machine's (`PromptHook.machine`) came from a device that may press
 * a button of `scope` ({@link allowed}); `scope` when a device without that scope wrote it; `none` when the user did
 * not write in this run (only a main request, an area message or a team update) or the messages cannot be read (the
 * closed side). It says that the user spoke in this run, never what the user asked.
 */
export async function backed(
  services: Services.Base,
  caller: Caller,
  scope: OwnTeam.Scope,
): Promise<"ok" | "none" | "scope"> {
  const listed = await services.http.session.messages({
    sessionID: caller.sessionID,
    directory: caller.directory,
    limit: WINDOW,
    order: "desc",
  })
  if (!listed.ok) return "none"
  const messages = read(listed.value.data).toReversed()
  const run = messages.slice(messages.findLastIndex(isIdle) + 1)
  const user = run.find((message) => message.type === "user" && !PromptHook.machine(message.metadata))
  if (user === undefined) return "none"
  return allowed(scope, user.metadata) ? "ok" : "scope"
}

/** Whether a reply with `metadata` approves an action of `scope` (the button rule, 06 §2.7, §12.2). */
export function allowed(scope: OwnTeam.Scope, metadata: Readonly<Record<string, unknown>> | undefined) {
  const stamp = metadata?.[OwnRemote.DEVICE_META]
  // The PC's own clients never pass the gateway: no stamp.
  if (stamp === undefined) return true
  if (scope === "local") return false
  // A stamp that does not decode is a device without scopes.
  const scopes = Option.getOrUndefined(decodeStamp(stamp))?.scopes ?? []
  return scopes.some((item) => item === scope)
}

const decodeStamp = Schema.decodeUnknownOption(OwnRemote.DeviceStamp)

function refuse(error: Exclude<Refusal, "needs_pc">): MainTools.Reply {
  return { ok: false, error, text: TEXT[error] }
}

/** What an approval reads of a message: its id, type and metadata. */
const Message = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeMessage = Schema.decodeUnknownOption(Message)

/** The messages of a page as {@link Message}s, in the page's order. */
function read(page: ReadonlyArray<unknown>) {
  return page.flatMap((item) => Option.toArray(decodeMessage(item)))
}

function isIdle(message: typeof Message.Type) {
  return message.type === "idle"
}
