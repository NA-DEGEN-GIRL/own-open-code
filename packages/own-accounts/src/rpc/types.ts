export * as RpcTypes from "./types.js"

import type { RpcCallContext, RpcHandlers } from "@opencode/plugin/promise/rpc"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnAccounts } from "@own/protocol"

export type Definition = OwnAccounts.Definition
export type Handlers = RpcHandlers<Definition>
export type MethodName = keyof Definition["methods"] & string

/**
 * One RPC method implementation: decoded input plus `{ signal, error }`, returning the output or
 * `context.error(type, message, data)` for a type the method declares (02 §9.4). Anything thrown becomes HTTP 500
 * `rpc.internal`, so handlers return errors instead of throwing.
 */
export type Handler<N extends MethodName> = Handlers[N]
export type Context<N extends MethodName> = RpcCallContext<Definition["methods"][N]>
export type Input<N extends MethodName> = Parameters<Handler<N>>[0]
export type Output<N extends MethodName> = Rpc.HandlerOutput<Definition["methods"][N]["output"]>

/** The handlers of one method group (`src/rpc/<group>.ts`). */
export type Group<N extends MethodName> = Pick<Handlers, N>

export type EventName = keyof Definition["events"] & string
/** Event payload as given to `emit`, including the `eventId`/`origin` envelope. */
export type EventPayload<N extends EventName> = Rpc.EventInputData<Definition["events"][N]["schema"]>
/** Event payload without the envelope; {@link Emitter} adds `eventId` and `origin`. */
export type EventBody<N extends EventName> = Omit<EventPayload<N>, "eventId" | "origin">
