// Typed `own.team` client (06 §2.7, `@own/protocol/rpc-team`). Only src/data knows the RPC id and the metadata keys
// own.team writes (03 §16.3); screens use the TeamStore (src/team/store.ts) that every ServerRuntime carries. Only the
// definition's types are imported (erased at build time), so the schema graph never reaches the bundle; the id, the
// scope table and the event list are the routing tables of `@own/protocol/rpc-team-routing` (plain data, the same ones
// the phone gateway decides with).
// Every method goes to the server's control location, so no area Location is woken (06 §2.7). The scopes are the
// own.accounts vocabulary: a gateway device never holds `local` (confirms, push, settings writes).
import { isRpcError, isRpcInternalError, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { OwnTeamRouting } from "@own/protocol/rpc-team-routing"
import { OwnRpcError, type OwnScope } from "./rpc"

type Definition = OwnTeam.Definition
export type TeamMethod = OwnTeam.MethodName
export type TeamEventName = OwnTeam.EventName
export type TeamScope = OwnTeam.Scope
export type TeamInput<M extends TeamMethod> = Rpc.Input<Definition["methods"][M]["input"]>
export type TeamOutput<M extends TeamMethod> = Rpc.Output<Definition["methods"][M]["output"]>
export type TeamEventData<E extends TeamEventName> = Rpc.EventData<Definition["events"][E]["schema"]>

/** Discriminated by `name`, so `switch (event.name)` narrows `data`. */
export type TeamEvent<E extends TeamEventName = TeamEventName> = {
  [K in E]: { readonly name: K; readonly data: TeamEventData<K>; readonly created: number }
}[E]

export const TEAM_ID = OwnTeamRouting.ID
export const TEAM_EVENT_PREFIX = `rpc.${TEAM_ID}.`

/**
 * Metadata keys own.team writes (06 §2.4 이름 규칙): on main and owner sessions (a display hint only, copied into
 * children by core), on main requests (`메인이 보냄`, envelope folded), on team updates in the main session, and on an
 * owner conversation own moved after its folder (8.8, the banner of 4.14).
 */
export const TEAM_META = {
  session: "own.team",
  dispatch: "own.dispatch",
  update: "own.team.update",
  moved: "own.team.moved",
} as const

/** The device scope each method needs (06 §2.7). */
export const TEAM_SCOPE = OwnTeamRouting.MethodScope

export interface TeamRpc {
  call<M extends TeamMethod>(
    method: M,
    input: TeamInput<M>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<TeamOutput<M>>
  /** Scope gate for buttons: a gateway device sees confirms and settings writes as view-only (06 §9.8). */
  allowed(method: TeamMethod): boolean
  scope(method: TeamMethod): TeamScope
}

export function createTeamRpc(input: {
  readonly client: () => OpenCodeClient
  /** This server's control location (02 §9.1; SSH servers: `resolve`'s `controlDir`). */
  readonly control: () => Promise<string>
  readonly scopes: () => ReadonlySet<OwnScope>
}): TeamRpc {
  const allowed = (method: TeamMethod) => input.scopes().has(TEAM_SCOPE[method])
  return {
    allowed,
    scope: (method) => TEAM_SCOPE[method],
    async call(method, payload, options) {
      if (!allowed(method)) throw new OwnRpcError("own.scope_denied", `${method} needs the ${TEAM_SCOPE[method]} scope`)
      const directory = await input.control()
      try {
        const result = await input.client().rpc.call(
          {
            rpcID: TEAM_ID,
            method,
            // SAFETY: the method's schema defines the accepted JSON input; the transport is untyped JSON.
            input: payload as never,
            location: { directory },
          },
          { signal: options?.signal },
        )
        // SAFETY: the server encodes the output with this method's schema (Rpc.PortableDefinition contract).
        return result.output as TeamOutput<typeof method>
      } catch (error) {
        if (isRpcError(error) || isRpcInternalError(error))
          throw new OwnRpcError(error.type, error.message, "data" in error ? error.data : undefined)
        throw error
      }
    },
  }
}

/**
 * Parses `rpc.own.team.<name>`; `undefined` for anything else or an unknown name. Only the leader publishes these
 * (06 §2.6), each with a ULID `eventId` that consumers de-duplicate on.
 */
export function teamEvent(event: OpenCodeEvent): TeamEvent | undefined {
  if (!event.type.startsWith(TEAM_EVENT_PREFIX)) return undefined
  const name = event.type.slice(TEAM_EVENT_PREFIX.length)
  if (
    !Object.hasOwn(OwnTeamRouting.EventOrigin, name) ||
    !("data" in event) ||
    typeof event.data !== "object" ||
    event.data === null
  )
    return undefined
  const created = "created" in event && typeof event.created === "number" ? event.created : Date.now()
  // SAFETY: `name` is a declared event of the definition and the server validated `data` with its schema.
  return { name, data: event.data, created } as TeamEvent
}
