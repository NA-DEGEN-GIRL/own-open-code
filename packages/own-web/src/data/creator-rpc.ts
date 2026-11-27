// Typed `own.creator` client (17 §8, `@own/protocol/rpc-creator`). Only src/data knows the RPC id (03 §16.3); the
// settings page (src/creator, a lazy chunk) makes one from its server runtime, so neither the client nor its strings
// reach the first chunk (PF5). Only the definition's types are imported; the scope table is the client copy of
// `OwnCreator.MethodScope`, compared with the real one in src/creator tests. Writes are `local`: this PC's windows only.
import { isRpcError, isRpcInternalError, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnCreator } from "@own/protocol/rpc-creator"
import { ALL_SCOPES, OwnRpcError, type OwnScope } from "./rpc"
import type { ServerEntry } from "./servers"

type Definition = OwnCreator.Definition
export type CreatorMethod = OwnCreator.MethodName
export type CreatorInput<M extends CreatorMethod> = Rpc.Input<Definition["methods"][M]["input"]>
export type CreatorOutput<M extends CreatorMethod> = Rpc.Output<Definition["methods"][M]["output"]>

export const CREATOR_ID = "own.creator"

/** Client copy of `OwnCreator.MethodScope`. */
export const CREATOR_SCOPE: { readonly [M in CreatorMethod]: OwnCreator.Scope } = {
  list: "read",
  "version.get": "read",
  "enabled.set": "local",
  rollback: "local",
  remove: "local",
  "scope.set": "local",
  "hosts.set": "local",
  "hostTrust.set": "local",
  "loosen.set": "local",
  "plugins.set": "local",
  "trust.set": "local",
  "mcp.stop": "local",
  "mcp.start": "local",
  "log.get": "read",
  "crashes.clear": "local",
}

export interface CreatorRpc {
  call<M extends CreatorMethod>(method: M, input: CreatorInput<M>): Promise<CreatorOutput<M>>
  allowed(method: CreatorMethod): boolean
}

export function createCreatorRpc(input: {
  readonly client: () => OpenCodeClient
  readonly control: () => Promise<string>
  readonly scopes: () => ReadonlySet<OwnScope>
}): CreatorRpc {
  const allowed = (method: CreatorMethod) => input.scopes().has(CREATOR_SCOPE[method])
  return {
    allowed,
    async call(method, payload) {
      if (!allowed(method))
        throw new OwnRpcError("own.scope_denied", `${method} needs the ${CREATOR_SCOPE[method]} scope`)
      const directory = await input.control()
      try {
        const result = await input.client().rpc.call({
          rpcID: CREATOR_ID,
          method,
          // SAFETY: the method's schema defines the accepted JSON input; the transport is untyped JSON.
          input: payload as never,
          location: { directory },
        })
        // SAFETY: the server encodes the output with this method's schema (Rpc.PortableDefinition contract).
        return result.output as CreatorOutput<typeof method>
      } catch (error) {
        if (isRpcError(error) || isRpcInternalError(error))
          throw new OwnRpcError(error.type, error.message, "data" in error ? error.data : undefined)
        throw error
      }
    },
  }
}

/** The client of one server runtime: every scope on this PC's windows, never `local` on a paired device. */
export function creatorRpcOf(runtime: {
  readonly client: () => OpenCodeClient
  readonly control: () => Promise<string>
  readonly entry: () => ServerEntry | undefined
}) {
  return createCreatorRpc({
    client: runtime.client,
    control: runtime.control,
    scopes: () => {
      const entry = runtime.entry()
      if (!entry || entry.auth !== "device") return ALL_SCOPES
      return new Set((entry.scopes ?? ["read"]).filter((scope) => scope !== "local"))
    },
  })
}

/** `rpc.own.creator.changed`: an extension changed somewhere in this service (another window, creator mode). */
export function creatorChanged(event: OpenCodeEvent) {
  return event.type === `rpc.${CREATOR_ID}.changed`
}
