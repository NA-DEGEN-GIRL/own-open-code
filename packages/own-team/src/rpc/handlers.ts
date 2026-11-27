export * as TeamRpc from "./handlers.js"

import type { RpcCallContext, RpcHandlers } from "@opencode/plugin/promise/rpc"
import type { Rpc } from "@opencode/schema/rpc"
import { OwnTeam, Portable } from "@own/protocol"
import { OwnTeamRouting } from "@own/protocol/rpc-team-routing"
import type { Log } from "../log.js"
import type { Services } from "../services.js"
import { AdoptRpc } from "./adopt.js"
import { AreaEditRpc } from "./area-edit.js"
import { AreaMainRpc } from "./area-main.js"
import { DecisionsRpc } from "./decisions.js"
import { HealthRpc } from "./health.js"
import { IntegrateRpc } from "./integrate.js"
import { OpRpc } from "./op.js"
import { OutboxRpc } from "./outbox.js"
import { PathsRpc } from "./paths.js"
import { PauseRpc } from "./pause.js"
import { PeerRpc } from "./peer.js"
import { ProjectRpc } from "./project.js"
import { ReorgRpc } from "./reorg.js"
import { RotateRpc } from "./rotate.js"
import { SeatRpc } from "./seat.js"
import { SettingsRpc } from "./settings.js"
import { TeamGroupRpc } from "./team.js"
import { WorktreeChatRpc } from "./worktree-chat.js"

/**
 * RPC `own.team` (06 §2.7), assembled from the group files. The return type makes a missing method a compile error;
 * a method belongs to exactly one group. Each group also lists the `features` it implements (spec addition: `health`
 * reports them so clients hide what this build lacks). Handlers never throw: declared errors are returned, and
 * anything thrown becomes `internal_error`. Since T2 every method has its group; since T3 every group answers in
 * full (`reorg.propose`, the reorg actions, `disable{cleanup}`), and `health.features` adds `reorg.split`,
 * `reorg.merge`, `reorg.retire`, `reorg.convert`, `reorg.move`, `cleanup`, `assets` and `shared`; `area.edit` and its
 * `area-edit` came with 사용자가 정하는 영역 (2026-10-26).
 */

export type Definition = OwnTeam.Definition
export type Handlers = RpcHandlers<Definition>
export type MethodName = OwnTeam.MethodName
export type Context<N extends MethodName> = RpcCallContext<Definition["methods"][N]>
export type HandlerError<N extends MethodName> = Rpc.HandlerError<Definition["methods"][N]>

/** The handlers of one method group (`src/rpc/<group>.ts`). */
export type Group<N extends MethodName> = Pick<Handlers, N>

export interface Deps {
  readonly services: Services.Context
  /** Whether the instance answering leads (only the leader emits events). */
  readonly leader: () => boolean
  readonly log: Log.Logger
}

/** What this build implements: the union of the groups' features. */
export const FEATURES: ReadonlyArray<OwnTeam.Feature> = [
  ...new Set([
    ...TeamGroupRpc.FEATURES,
    ...PauseRpc.FEATURES,
    ...OutboxRpc.FEATURES,
    ...RotateRpc.FEATURES,
    ...AreaMainRpc.FEATURES,
    ...PathsRpc.FEATURES,
    ...ReorgRpc.FEATURES,
    ...SettingsRpc.FEATURES,
    ...HealthRpc.FEATURES,
    ...AdoptRpc.FEATURES,
    ...IntegrateRpc.FEATURES,
    ...DecisionsRpc.FEATURES,
    ...PeerRpc.FEATURES,
    ...ProjectRpc.FEATURES,
    ...AreaEditRpc.FEATURES,
    ...SeatRpc.FEATURES,
    ...WorktreeChatRpc.FEATURES,
  ]),
]

export function create(deps: Deps): Handlers {
  return safe(
    {
      ...HealthRpc.handlers({ services: deps.services, leader: deps.leader, features: FEATURES }),
      ...TeamGroupRpc.handlers(deps.services),
      ...PauseRpc.handlers(deps.services),
      ...OutboxRpc.handlers(deps.services),
      ...OpRpc.handlers(deps.services),
      ...RotateRpc.handlers(deps.services),
      ...AreaMainRpc.handlers(deps.services),
      ...PathsRpc.handlers(deps.services),
      ...ReorgRpc.handlers(deps.services),
      ...SettingsRpc.handlers(deps.services),
      ...AdoptRpc.handlers(deps.services),
      ...IntegrateRpc.handlers(deps.services),
      ...DecisionsRpc.handlers(deps.services),
      ...PeerRpc.handlers(deps.services),
      ...ProjectRpc.handlers(deps.services),
      ...AreaEditRpc.handlers(deps.services),
      ...SeatRpc.handlers(deps.services),
      ...WorktreeChatRpc.handlers(deps.services),
    },
    deps.log,
    deps.services,
  )
}

/**
 * RH-20: how long a method that writes waits for the controller lock before it answers `unavailable` (another live
 * process of this OWN_HOME holds it), instead of hanging.
 */
export const WRITE_WAIT_MS = 10_000

/** The device scope of a method by its name (`OwnTeamRouting.MethodScope`); an unknown name counts as writing. */
function scopeOf(name: string) {
  const scopes: Readonly<Record<string, OwnTeam.Scope | undefined>> = OwnTeamRouting.MethodScope
  return scopes[name] ?? "admin"
}

let portable: Definition | undefined
/** The definition as Standard Schema: a release bundle's `effect` cannot run in the host (own-protocol portable.ts). */
export function definition() {
  return (portable ??= Portable.definition(OwnTeam.Definition))
}

type Loose = (
  input: unknown,
  context: { readonly error: (type: string, message: string, data: unknown) => unknown },
) => Promise<unknown>

/**
 * Every handler with anything thrown turned into the declared `internal_error` (06 §2.6 "핸들러는 throw하지 않는다"), and
 * every method that is not `read` refused with `unavailable` while this controller cannot write (RH-20).
 */
function safe(handlers: Handlers, log: Log.Logger, services: Services.Context): Handlers {
  // SAFETY: each handler takes its method's input and call context; erased here only to add one catch per method.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const loose = handlers as unknown as Readonly<Record<string, Loose>>
  const wrapped = Object.fromEntries(
    Object.entries(loose).map(([name, handler]): [string, Loose] => [
      name,
      (input, context) =>
        Promise.resolve()
          .then(async () => {
            if (scopeOf(name) === "read" || (await services.ready(WRITE_WAIT_MS))) return handler(input, context)
            const controller = services.status.controller()
            log.warn("rpc_unavailable", { method: name, pid: controller.holder?.pid })
            return context.error(
              "unavailable",
              "다른 프로세스가 팀 서비스를 잡고 있어 지금은 기록할 수 없어요",
              controller.holder ? { why: "controller_lock", pid: controller.holder.pid } : { why: "controller_lock" },
            )
          })
          .catch((error: unknown) => {
            log.error("rpc_handler_failed", { method: name, error })
            return context.error("internal_error", "the own.team request failed", {})
          }),
    ]),
  )
  // SAFETY: the same keys and signatures; every method declares `internal_error` with empty data.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return wrapped as unknown as Handlers
}
