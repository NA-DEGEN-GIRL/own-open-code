// Typed `own.computer` client (01 §10.2, `@own/protocol/rpc-computer`). Only src/data knows the RPC id (03 §16.3);
// screens use the ComputerStore (src/computer). Only the definition's types are imported (erased at build time); the
// scope table is the client copy of `OwnComputer.MethodScope`, compared with the real one in src/computer tests.
// Every method is global: it is called at the local control location, and any Location's plugin instance answers for
// the one process-wide desktop.
import { isRpcError, isRpcInternalError, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnComputer } from "@own/protocol/rpc-computer"
import { OwnRpcError, type OwnScope } from "./rpc"

type Definition = OwnComputer.Definition
export type ComputerMethod = OwnComputer.MethodName
export type ComputerEventName = OwnComputer.EventName
export type ComputerScope = OwnComputer.Scope
export type ComputerInput<M extends ComputerMethod> = Rpc.Input<Definition["methods"][M]["input"]>
export type ComputerOutput<M extends ComputerMethod> = Rpc.Output<Definition["methods"][M]["output"]>
export type ComputerEventData<E extends ComputerEventName> = Rpc.EventData<Definition["events"][E]["schema"]>
export type ComputerStatus = OwnComputer.Status
export type ComputerAction = OwnComputer.Action
export type ComputerAuditEntry = OwnComputer.AuditEntry

/** Discriminated by `name`. */
export type ComputerEvent<E extends ComputerEventName = ComputerEventName> = {
  [K in E]: { readonly name: K; readonly data: ComputerEventData<K> }
}[E]

export const COMPUTER_ID = "own.computer"
export const COMPUTER_EVENT_PREFIX = `rpc.${COMPUTER_ID}.`

/** Client copy of `OwnComputer.MethodScope`. */
export const COMPUTER_SCOPE: { readonly [M in ComputerMethod]: ComputerScope } = {
  status: "read",
  "audit.list": "read",
  "killswitch.engage": "drive",
  "killswitch.reset": "local",
  "session.grants.get": "local",
  "session.grants.set": "local",
  "session.grants.revoke": "local",
  "helper.restart": "local",
}

const EVENTS: ReadonlySet<string> = new Set<ComputerEventName>(["status", "action"])

/** The own.remote vocabulary over `own.accounts` scopes: `read` ↔ read, `drive` ↔ prompt or switch, `local` ↔ local. */
export function computerAllowed(scope: ComputerScope, scopes: ReadonlySet<OwnScope>) {
  if (scope === "read") return scopes.has("read")
  if (scope === "drive") return scopes.has("prompt") || scopes.has("switch")
  return scopes.has("local")
}

export interface ComputerRpc {
  call<M extends ComputerMethod>(
    method: M,
    input: ComputerInput<M>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ComputerOutput<M>>
  allowed(method: ComputerMethod): boolean
}

export function createComputerRpc(input: {
  /** The local server's client. */
  readonly client: () => OpenCodeClient
  /** The local control location (02 §9.1). */
  readonly control: () => Promise<string>
  readonly scopes: () => ReadonlySet<OwnScope>
}): ComputerRpc {
  const allowed = (method: ComputerMethod) => computerAllowed(COMPUTER_SCOPE[method], input.scopes())
  return {
    allowed,
    async call(method, payload, options) {
      if (!allowed(method))
        throw new OwnRpcError("own.scope_denied", `${method} needs the ${COMPUTER_SCOPE[method]} scope`)
      const directory = await input.control()
      try {
        const result = await input.client().rpc.call(
          {
            rpcID: COMPUTER_ID,
            method,
            // SAFETY: the method's schema defines the accepted JSON input; the transport is untyped JSON.
            input: payload as never,
            location: { directory },
          },
          { signal: options?.signal },
        )
        // SAFETY: the server encodes the output with this method's schema (Rpc.PortableDefinition contract).
        return result.output as ComputerOutput<typeof method>
      } catch (error) {
        if (isRpcError(error) || isRpcInternalError(error))
          throw new OwnRpcError(error.type, error.message, "data" in error ? error.data : undefined)
        throw error
      }
    },
  }
}

/**
 * Parses `rpc.own.computer.<name>`; `undefined` for anything else or an unknown name. Every Location's plugin instance
 * republishes the same notice, so consumers must apply these idempotently (`status` replaces, `action` by key).
 */
export function computerEvent(event: OpenCodeEvent): ComputerEvent | undefined {
  if (!event.type.startsWith(COMPUTER_EVENT_PREFIX)) return undefined
  const name = event.type.slice(COMPUTER_EVENT_PREFIX.length)
  if (!EVENTS.has(name) || !("data" in event) || typeof event.data !== "object" || event.data === null) return undefined
  // SAFETY: `name` is a declared event of the definition and the server validated `data` with its schema.
  return { name, data: event.data } as ComputerEvent
}
