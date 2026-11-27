// Typed `own.import` client (09 §5, `@own/protocol/rpc-import`). Only src/data knows the RPC id and the session
// metadata key own.import writes (03 §16.3); the import screens (lazy chunk src/import, 09 §6) call through the client
// every ServerRuntime carries (`runtime.imports`) and read metadata through IMPORT_META, isImportHelper and
// importOrigin. Only the definition's types are imported (erased at build time), so the schema graph never reaches the
// first chunk (03 §20.2 R5); the id, the scope table and the event list are the routing tables of
// `@own/protocol/rpc-import-routing` (plain data, the same ones the phone gateway decides with).
// Every method goes to the server's control location (09 §5.2). The scopes are the own.accounts vocabulary: a gateway
// device never holds `local`, so with the I2 scopes (09 §5.5 Q2) it views with `read` and moves with `prompt`, while
// `sources.configure` stays with this PC's windows.
import {
  isRpcError,
  isRpcInternalError,
  type JsonValue,
  type ModelRef,
  type OpenCodeClient,
  type OpenCodeEvent,
  type SessionInfo,
} from "@opencode/client"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnImport } from "@own/protocol/rpc-import"
import { OwnImportRouting } from "@own/protocol/rpc-import-routing"
import { OwnRpcError, type OwnScope } from "./rpc"

type Definition = OwnImport.Definition
export type ImportMethod = OwnImport.MethodName
export type ImportEventName = OwnImport.EventName
export type ImportScope = OwnImport.Scope
export type ImportInput<M extends ImportMethod> = Rpc.Input<Definition["methods"][M]["input"]>
export type ImportOutput<M extends ImportMethod> = Rpc.Output<Definition["methods"][M]["output"]>
export type ImportEventData<E extends ImportEventName> = Rpc.EventData<Definition["events"][E]["schema"]>
export type ImportKind = OwnImport.Kind
export type ImportSourceRef = OwnImport.SourceRef
export type ImportSummary = OwnImport.Summary

/** Discriminated by `name`, so `switch (event.name)` narrows `data`. */
export type ImportEvent<E extends ImportEventName = ImportEventName> = {
  [K in E]: { readonly name: K; readonly data: ImportEventData<K>; readonly created: number }
}[E]

export const IMPORT_ID = OwnImportRouting.ID
export const IMPORT_EVENT_PREFIX = `rpc.${IMPORT_ID}.`

/** The device scope each method needs (09 §5.5). */
export const IMPORT_SCOPE = OwnImportRouting.MethodScope

export interface ImportRpc {
  call<M extends ImportMethod>(
    method: M,
    input: ImportInput<M>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ImportOutput<M>>
  /**
   * Scope gate for entries and buttons: a gateway device without the scope does not see them (09 §5.5). With `input`,
   * the scope that call needs (`OwnImportRouting.scopeOf`): `scope: "all"` and `redact: false` are this PC's only.
   */
  allowed(method: ImportMethod, input?: unknown): boolean
  scope(method: ImportMethod): ImportScope
}

export function createImportRpc(input: {
  readonly client: () => OpenCodeClient
  /** This server's control location (02 §9.1; SSH servers: `resolve`'s `controlDir`). */
  readonly control: () => Promise<string>
  readonly scopes: () => ReadonlySet<OwnScope>
}): ImportRpc {
  const allowed = (method: ImportMethod, payload?: unknown) =>
    input.scopes().has(OwnImportRouting.scopeOf(method, payload))
  return {
    allowed,
    scope: (method) => IMPORT_SCOPE[method],
    async call(method, payload, options) {
      if (!allowed(method, payload))
        throw new OwnRpcError(
          "own.scope_denied",
          `${method} needs the ${OwnImportRouting.scopeOf(method, payload)} scope for this input`,
        )
      const directory = await input.control()
      try {
        const result = await input.client().rpc.call(
          {
            rpcID: IMPORT_ID,
            method,
            // SAFETY: the method's schema defines the accepted JSON input; the transport is untyped JSON.
            input: payload as never,
            location: { directory },
          },
          { signal: options?.signal },
        )
        // SAFETY: the server encodes the output with this method's schema (Rpc.PortableDefinition contract).
        return result.output as ImportOutput<typeof method>
      } catch (error) {
        if (isRpcError(error) || isRpcInternalError(error))
          throw new OwnRpcError(error.type, error.message, "data" in error ? error.data : undefined)
        throw error
      }
    },
  }
}

/**
 * Parses `rpc.own.import.<name>`; `undefined` for anything else or an unknown name. One instance publishes these: the
 * control Location's, else the oldest live one (09 §5.3), each with a ULID `eventId` that consumers de-duplicate on.
 */
export function importEvent(event: OpenCodeEvent): ImportEvent | undefined {
  if (!event.type.startsWith(IMPORT_EVENT_PREFIX)) return undefined
  const name = event.type.slice(IMPORT_EVENT_PREFIX.length)
  if (
    !Object.hasOwn(OwnImportRouting.EventOrigin, name) ||
    !("data" in event) ||
    typeof event.data !== "object" ||
    event.data === null
  )
    return undefined
  const created = "created" in event && typeof event.created === "number" ? event.created : Date.now()
  // SAFETY: `name` is a declared event of the definition and the server validated `data` with its schema.
  return { name, data: event.data, created } as ImportEvent
}

// ---------------------------------------------------------------------------------------------------------------
// Session metadata (09 §4.7, §6 숨김)

/** The one key own.import writes, on imported conversations and on its hidden summary helpers alike (09 §4.7). */
export const IMPORT_META = { session: OwnImportRouting.META_KEY } as const

type Metadata = SessionInfo["metadata"]

/** An imported conversation's origin: its header badge, the badge's details and the first-screen line (09 §4.7). */
export interface ImportOrigin {
  readonly kind: ImportKind
  /** The source conversation for `원본 보기`; absent when the recorded ids are not the tokens `sources.list` gives. */
  readonly ref: ImportSourceRef | undefined
  readonly title: string
  /** Turns imported. */
  readonly turns: number
  readonly mode: OwnImport.Mode
  /** What the imported history starts from: a source compaction, an `llm` summary or a `brief`; `null`: no boundary. */
  readonly checkpoint: Checkpoint | null
  /** The model that wrote an `llm` summary. */
  readonly summarizer: Pick<ModelRef, "providerID" | "id"> | undefined
  /** Values replaced by `[redacted:<label>]` (09 §4.2). */
  readonly redactions: number
  readonly importedAt: number
}

type Checkpoint = OwnImport.CheckpointKind | "llm" | "brief"

// Mapped over the protocol's literals, so a new kind, mode or checkpoint does not typecheck until it is listed here.
const KINDS: { readonly [K in ImportKind]: true } = { codex: true, "claude-code": true }
const MODES: { readonly [M in OwnImport.Mode]: true } = { full: true, summary: true }
const CHECKPOINTS: { readonly [C in Checkpoint]: true } = {
  foreign: true,
  "codex-remote": true,
  llm: true,
  brief: true,
}
/** `SourceRef` ids are path-free tokens (09 §5.2). */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** A hidden summary helper session (`{v: 1, helper: true, jobID}`, 09 §4.4): no own screen lists it (09 §6 숨김). */
export function isImportHelper(metadata: Metadata) {
  return record(metadata?.[IMPORT_META.session])?.helper === true
}

/** The origin of a conversation own.import imported; `undefined` for any other session, a helper included. */
export function importOrigin(metadata: Metadata): ImportOrigin | undefined {
  const value = record(metadata?.[IMPORT_META.session])
  if (!value || value.v !== 1 || value.helper === true) return undefined
  if (!member(KINDS, value.kind) || !member(MODES, value.mode)) return undefined
  if (!(value.checkpoint === null || member(CHECKPOINTS, value.checkpoint))) return undefined
  if (typeof value.title !== "string" || typeof value.turns !== "number") return undefined
  if (typeof value.redactions !== "number" || typeof value.importedAt !== "number") return undefined
  const summarizer = record(value.summarizer)
  return {
    kind: value.kind,
    ref: sourceRef(value.kind, value.root, value.sourceID),
    title: value.title,
    turns: value.turns,
    mode: value.mode,
    checkpoint: value.checkpoint,
    summarizer:
      typeof summarizer?.providerID === "string" && typeof summarizer.id === "string"
        ? { providerID: summarizer.providerID, id: summarizer.id }
        : undefined,
    redactions: value.redactions,
    importedAt: value.importedAt,
  }
}

function member<T extends string>(table: { readonly [K in T]: true }, value: JsonValue | undefined): value is T {
  return typeof value === "string" && Object.hasOwn(table, value)
}

function sourceRef(kind: ImportKind, root: JsonValue | undefined, id: JsonValue | undefined) {
  if (typeof root !== "string" || typeof id !== "string" || !TOKEN.test(root) || !TOKEN.test(id)) return undefined
  // SAFETY: both are path-free tokens; own.import decodes the ref again with the branded schema when it is used.
  return { kind, rootID: root, id } as ImportSourceRef
}

function record(value: JsonValue | undefined) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined
}
