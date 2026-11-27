// Typed `own.harness` client (10 §3.8, `@own/protocol/rpc-harness`). Only src/data knows the RPC id (03 §16.3);
// screens use src/harness. Only the definition's types are imported (erased at build time); the scope table is the
// client copy of `OwnHarness.MethodScope`, compared with the real one in src/harness tests. Every server runtime carries
// one (`runtime.harness`): this PC and remote installs run the plugin (10 §6.1), and calls go to that server's control
// location. `drive` (a switch) needs `switch`, as the phone gateway decides it: the scope of a model switch.
import { isRpcError, isRpcInternalError, type OpenCodeClient } from "@opencode/client"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnRpcError, type OwnScope } from "./rpc"

type Definition = OwnHarness.Definition
export type HarnessMethod = OwnHarness.MethodName
export type HarnessInput<M extends HarnessMethod> = Rpc.Input<Definition["methods"][M]["input"]>
export type HarnessOutput<M extends HarnessMethod> = Rpc.Output<Definition["methods"][M]["output"]>

export const HARNESS_ID = "own.harness"

/** Client copy of `OwnHarness.MethodScope`. */
export const HARNESS_SCOPE: { readonly [M in HarnessMethod]: OwnHarness.Scope } = {
  list: "read",
  "session.get": "read",
  "session.set": "drive",
  "defaults.set": "local",
  "compaction.get": "read",
  "compaction.set": "local",
  "prompt.preview": "read",
  "prompt.subagent": "read",
  "prompt.custom.set": "local",
}

export interface HarnessRpc {
  call<M extends HarnessMethod>(method: M, input: HarnessInput<M>): Promise<HarnessOutput<M>>
  allowed(method: HarnessMethod): boolean
}

export function createHarnessRpc(input: {
  readonly client: () => OpenCodeClient
  readonly control: () => Promise<string>
  readonly scopes: () => ReadonlySet<OwnScope>
}): HarnessRpc {
  const allowed = (method: HarnessMethod) => {
    const scope = HARNESS_SCOPE[method]
    const scopes = input.scopes()
    if (scope === "read") return scopes.has("read")
    if (scope === "drive") return scopes.has("switch")
    return scopes.has("local")
  }
  return {
    allowed,
    async call(method, payload) {
      if (!allowed(method)) throw new OwnRpcError("own.scope_denied", `${method} needs the ${HARNESS_SCOPE[method]} scope`)
      const directory = await input.control()
      try {
        const result = await input.client().rpc.call({
          rpcID: HARNESS_ID,
          method,
          // SAFETY: the method's schema defines the accepted JSON input; the transport is untyped JSON.
          input: payload as never,
          location: { directory },
        })
        // SAFETY: the server encodes the output with this method's schema (Rpc.PortableDefinition contract).
        return result.output as HarnessOutput<typeof method>
      } catch (error) {
        if (isRpcError(error) || isRpcInternalError(error))
          throw new OwnRpcError(error.type, error.message, "data" in error ? error.data : undefined)
        throw error
      }
    },
  }
}
