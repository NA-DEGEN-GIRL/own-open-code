// Typed `own.remote` client (04 §16). Only src/data knows the RPC id (03 §16.3); screens use RemoteStore
// (src/servers), the one adapter of this RPC like OwnStore is for `own.accounts`.
//
// The definition is `@own/protocol/rpc-remote` (04 §16.1); only its types are imported here (erased at build time), so
// nothing of it reaches the bundle. The scope table below is the client copy of `OwnRemote.MethodScope` without its
// `local` methods; src/servers/protocol.test.ts compares every method with the real table.
import { isRpcError, isRpcInternalError, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnRemote } from "@own/protocol/rpc-remote"
import { OwnRpcError, type OwnScope } from "./rpc"

type Definition = OwnRemote.Definition
export type RemoteMethod = OwnRemote.MethodName
export type RemoteEventName = OwnRemote.EventName
export type RemoteScope = OwnRemote.Scope
export type RemoteInput<M extends RemoteMethod> = Rpc.Input<Definition["methods"][M]["input"]>
export type RemoteOutput<M extends RemoteMethod> = Rpc.Output<Definition["methods"][M]["output"]>
export type RemoteEventData<E extends RemoteEventName> = Rpc.EventData<Definition["events"][E]["schema"]>
export type HostView = OwnRemote.HostView
export type HostStage = OwnRemote.Stage
export type HostError = OwnRemote.HostError
export type PromptKind = OwnRemote.PromptKind
export type RemoteCatalog = RemoteOutput<"catalog.get">
export type RemoteResolved = RemoteOutput<"resolve">
export type GatewayView = OwnRemote.GatewayView
export type DeviceView = OwnRemote.DeviceView
export type PairingView = OwnRemote.PairingView
export type DeviceScope = OwnRemote.DeviceScope
export type ServerScope = OwnRemote.ServerScope
export type FeedItem = OwnRemote.FeedItem

/** Discriminated by `name`. */
export type RemoteEvent<E extends RemoteEventName = RemoteEventName> = {
  [K in E]: { readonly name: K; readonly data: RemoteEventData<K> }
}[E]

/** Methods own-web calls on a remote server itself (04 §16.2 "원격 서버에서"). `agent.broker.arm` carries the broker
 * key and `agent.probe` runs commands: only the local own-remote calls those, so this client does not offer them. */
export type AgentMethod = "agent.realpath" | "agent.status"

export const REMOTE_ID = "own.remote"
export const REMOTE_EVENT_PREFIX = `rpc.${REMOTE_ID}.`

/**
 * Client copy of `OwnRemote.MethodScope` (04 §16.7): the methods a device may call. Every other method is `local`
 * (the PC's own windows), so the table stays short in the first chunk; src/servers/protocol.test.ts compares every
 * method with the real table.
 */
const OPEN: { readonly [M in RemoteMethod]?: RemoteScope } = {
  "hosts.list": "read",
  "catalog.get": "read",
  "portForward.list": "read",
  connect: "manage",
  disconnect: "manage",
  "drain.plan": "manage",
  "drain.execute": "manage",
  diagnostics: "manage",
  "hosts.tools.ensure": "manage",
  // Bound to the calling device (05 §13.5).
  "feed.list": "read",
  "feed.ack": "read",
  "push.register": "read",
  "push.unregister": "read",
  // 05 §8.10: whether the PC's desktop app is there to hold browser panes.
  "browser.status": "read",
  "agent.realpath": "remote",
  "agent.status": "remote",
  "agent.broker.arm": "remote",
  "agent.probe": "remote",
}

export function remoteMethodScope(method: RemoteMethod): RemoteScope {
  return OPEN[method] ?? "local"
}

const EVENTS: ReadonlySet<string> = new Set<RemoteEventName>([
  "hosts.changed",
  "host.state",
  "host.prompt",
  "host.progress",
  "catalog.changed",
  "broker.status",
  "gateway.state",
  "device.pairing.pending",
  "device.pairing.ended",
  "device.paired",
  "device.revoked",
  "feed.item",
  "browser.pane.wanted",
])

/** `connect{hostKeyPrompt:true}` is `local` (body rule, 04 §16.7). */
export function remoteScopeOf<M extends RemoteMethod>(method: M, input: RemoteInput<M>): RemoteScope {
  if (method === "connect" && typeof input === "object" && input !== null && "hostKeyPrompt" in input)
    return input.hostKeyPrompt === true ? "local" : remoteMethodScope(method)
  return remoteMethodScope(method)
}

/**
 * Whether a connection with these `own.accounts` scopes may call a method (04 §16.7 ↔ 02 §9.1 vocabulary: `read` ↔
 * `read`, `manage` ↔ `admin`). `local` needs the PC window's `local` scope; `remote` (`agent.*`) never goes through
 * this client.
 */
export function remoteAllowed(scope: RemoteScope, scopes: ReadonlySet<OwnScope>) {
  switch (scope) {
    case "read":
      return scopes.has("read")
    case "drive":
      return scopes.has("prompt") || scopes.has("switch")
    case "manage":
      return scopes.has("admin")
    case "local":
      return scopes.has("local")
    case "remote":
      return false
  }
}

export interface RemoteRpc {
  /** A method of the local own-remote, at the local control location (04 §16.2). */
  call<M extends Exclude<RemoteMethod, `agent.${string}`>>(
    method: M,
    input: RemoteInput<M>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RemoteOutput<M>>
  allowed<M extends RemoteMethod>(method: M, input?: RemoteInput<M>): boolean
}

export function createRemoteRpc(input: {
  /** The local server's client. */
  readonly client: () => OpenCodeClient
  /** The local control location (02 §9.1). */
  readonly control: () => Promise<string>
  readonly scopes: () => ReadonlySet<OwnScope>
}): RemoteRpc {
  const allowed = <M extends RemoteMethod>(method: M, payload?: RemoteInput<M>) =>
    remoteAllowed(payload === undefined ? remoteMethodScope(method) : remoteScopeOf(method, payload), input.scopes())
  return {
    allowed,
    async call(method, payload, options) {
      if (!allowed(method, payload))
        throw new OwnRpcError("own.scope_denied", `${method} needs the ${remoteScopeOf(method, payload)} scope`)
      return invoke(input.client, await input.control(), method, payload, options?.signal)
    },
  }
}

/**
 * `agent.*` on a remote server (04 §16.2), always at its control location from `resolve` (16.6: never an arbitrary
 * location, never the `health` fallback).
 */
export function callAgent<M extends AgentMethod>(
  client: () => OpenCodeClient,
  controlDir: string,
  method: M,
  payload: RemoteInput<M>,
  signal?: AbortSignal,
): Promise<RemoteOutput<M>> {
  return invoke(client, controlDir, method, payload, signal)
}

async function invoke<M extends RemoteMethod>(
  client: () => OpenCodeClient,
  directory: string,
  method: M,
  payload: RemoteInput<M>,
  signal: AbortSignal | undefined,
): Promise<RemoteOutput<M>> {
  try {
    const result = await client().rpc.call(
      {
        rpcID: REMOTE_ID,
        method,
        // SAFETY: the method's schema defines the accepted JSON input; the transport is untyped JSON.
        input: payload as never,
        location: { directory },
      },
      { signal },
    )
    // SAFETY: the server encodes the output with this method's schema (Rpc.PortableDefinition contract).
    return result.output as RemoteOutput<M>
  } catch (error) {
    if (isRpcError(error) || isRpcInternalError(error))
      throw new OwnRpcError(error.type, error.message, "data" in error ? error.data : undefined)
    throw error
  }
}

/** Parses `rpc.own.remote.<name>`; `undefined` for anything else or an unknown name. */
export function remoteEvent(event: OpenCodeEvent): RemoteEvent | undefined {
  if (!event.type.startsWith(REMOTE_EVENT_PREFIX)) return undefined
  const name = event.type.slice(REMOTE_EVENT_PREFIX.length)
  if (!EVENTS.has(name) || !("data" in event) || typeof event.data !== "object" || event.data === null) return undefined
  // SAFETY: `name` is a declared event of the definition and the server validated `data` with its schema.
  return { name, data: event.data } as RemoteEvent
}

/** `Authorization` value for a server access token (04 §12.1: Basic, user `opencode`, token as the password). */
export function tokenHeader(token: string) {
  return `Basic ${btoa(`opencode:${token}`)}`
}
