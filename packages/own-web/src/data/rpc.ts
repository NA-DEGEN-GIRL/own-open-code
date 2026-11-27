// Typed `own.accounts` client (02 §9). The definition, scopes and locations all come from @own/protocol, so a new
// method is routed and gated without touching this file. Only src/data may call it (03 §16.3: RPC ids are known by
// the stores alone); screens use OwnStore.
import { isRpcError, isRpcInternalError, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnAccounts } from "@own/protocol/rpc"
import { OwnRouting } from "@own/protocol/rpc-routing"

type Definition = OwnAccounts.Definition
export type OwnMethod = OwnAccounts.MethodName
export type OwnEventName = OwnAccounts.EventName
export type OwnScope = OwnAccounts.Scope
export type OwnInput<M extends OwnMethod> = Rpc.Input<Definition["methods"][M]["input"]>
export type OwnOutput<M extends OwnMethod> = Rpc.Output<Definition["methods"][M]["output"]>
export type OwnEventData<E extends OwnEventName> = Rpc.EventData<Definition["events"][E]["schema"]>

/** Discriminated by `name`, so `switch (event.name)` narrows `data`. */
export type OwnEvent<E extends OwnEventName = OwnEventName> = {
  [K in E]: {
    readonly name: K
    readonly data: OwnEventData<K>
    /** The Location whose own.accounts instance published it. */
    readonly directory: string
    readonly created: number
  }
}[E]

export const EVENT_PREFIX = `rpc.${OwnRouting.ID}.`
export const ALL_SCOPES: ReadonlySet<OwnScope> = new Set(["read", "prompt", "switch", "admin", "local"])

/** Errors thrown by `call`: server-declared (`type` from 02 §9.4), `rpc.*` system errors, or client-side `own.*`. */
export class OwnRpcError extends Error {
  override readonly name = "OwnRpcError"
  constructor(
    readonly type: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export interface OwnRpcRouting {
  /** Control location for global methods; rejects when none can be found (02 §9.1). */
  control(): Promise<string>
  /** The session's current directory (after `session.moved`, the new one). */
  sessionDirectory(sessionID: string): string | undefined
}

export interface OwnCallOptions {
  /** Overrides routing, e.g. `session.binding` for sessions of one directory, or the control fallback. */
  readonly directory?: string
  readonly signal?: AbortSignal
}

export interface OwnRpc {
  call<M extends OwnMethod>(method: M, input: OwnInput<M>, options?: OwnCallOptions): Promise<OwnOutput<M>>
  /**
   * Scope gate for buttons (02 §9.1 "원격 기기의 메서드 범위"): hide what this connection may not call. With the call's
   * input, what that one call needs (`OwnRouting.scopeOf`: a strict approval mode needs only `prompt`, MUX).
   */
  allowed(method: OwnMethod, payload?: unknown): boolean
  scope(method: OwnMethod): OwnScope
  /** Whether this connection holds a scope, also for non-RPC work such as `prompt` (compaction.due, clientAction). */
  can(scope: OwnScope): boolean
}

export function createOwnRpc(input: {
  readonly client: () => OpenCodeClient
  readonly routing: OwnRpcRouting
  readonly scopes: () => ReadonlySet<OwnScope>
  /** Tests shorten how long a session Location's `rpc.unavailable` is asked again (`BOOTING_MS`). */
  readonly bootingMs?: number
}): OwnRpc {
  const allowed = (method: OwnMethod, payload?: unknown) =>
    input.scopes().has(payload === undefined ? OwnRouting.MethodScope[method] : OwnRouting.scopeOf(method, payload))
  return {
    allowed,
    scope: (method) => OwnRouting.MethodScope[method],
    can: (scope) => input.scopes().has(scope),
    async call(method, payload, options) {
      if (!allowed(method, payload))
        throw new OwnRpcError("own.scope_denied", `${method} needs the ${OwnRouting.scopeOf(method, payload)} scope`)
      const directory = options?.directory ?? (await locate(method, payload, input.routing))
      // Plugins load in the background since upstream v2.4.0 (#63814), in every Location: a session's Location that just
      // booted (a new conversation's folder) answers `rpc.unavailable` until own.accounts registered there. Such a
      // call is asked again for up to BOOTING_MS, or a new conversation would keep no approval mode (`사용자 지정`). The
      // control Location's "still starting" is the store's (own-store.ts), so a global method is never retried here.
      const session = OwnRouting.MethodLocation[method] !== "control"
      const since = Date.now()
      const attempt = async (step: number): Promise<OwnOutput<typeof method>> =>
        once().catch(async (error: unknown) => {
          const booting =
            session &&
            error instanceof OwnRpcError &&
            error.type === "rpc.unavailable" &&
            Date.now() - since < (input.bootingMs ?? BOOTING_MS) &&
            options?.signal?.aborted !== true
          if (!booting) throw error
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(BOOTING_STEP_MS * 2 ** step, BOOTING_MAX_STEP_MS)),
          )
          return attempt(step + 1)
        })
      const once = async () => {
        try {
          const result = await input.client().rpc.call(
            {
              rpcID: OwnRouting.ID,
              method,
              // SAFETY: the method's schema defines the accepted JSON input; the transport is untyped JSON.
              input: payload as never,
              location: { directory },
            },
            { signal: options?.signal },
          )
          // SAFETY: the server encodes the output with this method's schema (Rpc.PortableDefinition contract).
          return result.output as OwnOutput<typeof method>
        } catch (error) {
          if (isRpcError(error) || isRpcInternalError(error))
            throw new OwnRpcError(error.type, error.message, "data" in error ? error.data : undefined)
          throw error
        }
      }
      return attempt(0)
    },
  }
}

/** How long a session Location's `rpc.unavailable` counts as that Location still loading own.accounts. */
const BOOTING_MS = 30_000
const BOOTING_STEP_MS = 200
const BOOTING_MAX_STEP_MS = 2_000

async function locate(method: OwnMethod, payload: unknown, routing: OwnRpcRouting) {
  if (OwnRouting.MethodLocation[method] === "control") return routing.control()
  const sessionID = sessionOf(payload)
  const directory = sessionID ? routing.sessionDirectory(sessionID) : undefined
  if (!directory)
    throw new OwnRpcError(
      "own.location_unknown",
      `${method}: pass options.directory or call it for a session whose directory is known`,
    )
  return directory
}

function sessionOf(payload: unknown) {
  if (typeof payload !== "object" || payload === null || !("sessionID" in payload)) return undefined
  return typeof payload.sessionID === "string" ? payload.sessionID : undefined
}

/** Parses `rpc.own.accounts.<name>` from the event stream; `undefined` for anything else or an unknown name. */
export function ownEvent(event: OpenCodeEvent): OwnEvent | undefined {
  if (!event.type.startsWith(EVENT_PREFIX) || !("location" in event) || !event.location) return undefined
  const name = event.type.slice(EVENT_PREFIX.length)
  if (!Object.hasOwn(OwnRouting.EventOrigin, name)) return undefined
  const created = "created" in event && typeof event.created === "number" ? event.created : Date.now()
  // SAFETY: `name` is a declared event of the definition and the server validated `data` with its schema.
  return { name, data: event.data, directory: event.location.directory, created } as OwnEvent
}
