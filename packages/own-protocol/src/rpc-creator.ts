/**
 * RPC `own.creator` (17 §8): the extensions creator mode made, as Settings > 확장 shows and changes them. own.creator
 * registers it and own-web calls it. Writes are `local`: only this PC's own clients change extensions (the phone gateway
 * refuses the whole namespace, 17 §8.2). The model never calls these; it has its own tools, which ask first.
 */
export * as OwnCreator from "./rpc-creator.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { Creator } from "./creator.js"

export const ID = "own.creator"

const empty = Schema.Struct({})

export const List = Schema.Struct({
  extensions: Schema.Array(Creator.View),
  format: Schema.String,
  /** `OWN_HOME\creator`, for the screen's "folder" line. */
  root: Schema.String,
  /** The stages this build runs: C0–C2 always; C3 only while the code plugin switch is on (off by default). */
  stages: Schema.Struct({ declarative: Schema.Boolean, mcp: Schema.Boolean, plugin: Schema.Boolean }),
  /** Store-wide switches; `plugins` is C3's (17 §12.1). */
  settings: Creator.Settings,
  /** C2 servers this service stopped (Settings' 멈추기), by extension id. */
  stopped: Schema.Array(Schema.String),
  /**
   * The SSH hosts this PC's broker serves or that reported their mirror (17 §10): whether a session is up and when the
   * host last reported. own-web adds their names from own.remote.
   */
  hosts: Schema.Array(
    Schema.Struct({ id: Schema.String, connected: Schema.Boolean, reportedAt: Schema.optionalKey(Schema.Number) }),
  ),
  buildId: Schema.String,
  version: Schema.String,
}).annotate({ identifier: "OwnCreator.List" })
export type List = typeof List.Type

export const VersionDetail = Schema.Struct({
  id: Creator.ID,
  n: Schema.Int,
  /** The version's `extension.json` as written, or undefined when it no longer reads. */
  extension: Schema.optionalKey(Schema.Unknown),
  problems: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
  effects: Schema.Array(Creator.EffectView),
}).annotate({ identifier: "OwnCreator.VersionDetail" })
export type VersionDetail = typeof VersionDetail.Type

export const Changed = Schema.Struct({
  ids: Schema.Array(Schema.String),
  at: Schema.Number,
}).annotate({ identifier: "OwnCreator.Changed" })
export type Changed = typeof Changed.Type

const ProblemList = Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String }))

/** The end of an extension's log (C2 servers, C3 crashes, staging): newest last. */
export const Log = Schema.Struct({
  id: Creator.ID,
  lines: Schema.Array(Schema.String),
}).annotate({ identifier: "OwnCreator.Log" })
export type Log = typeof Log.Type

export const errors = portable({
  not_found: Schema.Struct({ id: Schema.String }),
  version_not_found: Schema.Struct({ id: Schema.String, version: Schema.Number }),
  /** The version does not decode, its files changed, or it conflicts with another extension. */
  invalid: Schema.Struct({ problems: ProblemList }),
  /** Project folders that are not absolute, do not exist, or are a root, own's home or the config folder. */
  scope_invalid: Schema.Struct({ problems: ProblemList }),
})

function portable<const Schemas extends Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>>(schemas: Schemas) {
  // SAFETY: one converted entry per key of `schemas`, each the type toStandardSchemaV1 returns for it.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, Schema.toStandardSchemaV1(schema)]),
  ) as { readonly [K in keyof Schemas]: ReturnType<typeof Schema.toStandardSchemaV1<Schemas[K]>> }
}

function method<
  const Input extends Schema.ConstraintDecoder<unknown>,
  const Output extends Schema.ConstraintDecoder<unknown>,
  const Errors extends Rpc.ErrorMap,
>(input: Input, output: Output, errors: Errors) {
  return { input: Schema.toStandardSchemaV1(input), output: Schema.toStandardSchemaV1(output), errors }
}

function event<const S extends Schema.ConstraintDecoder<Readonly<Record<string, unknown>>>>(schema: S) {
  return { schema: Schema.toStandardSchemaV1(schema) }
}

const Target = Schema.Struct({ id: Creator.ID })

export const Definition = Rpc.define({
  id: ID,
  methods: {
    list: method(empty, List, {}),
    /** One version's file and what it does (version history). */
    "version.get": method(Schema.Struct({ id: Creator.ID, version: Schema.Int }), VersionDetail, {
      not_found: errors.not_found,
      version_not_found: errors.version_not_found,
    }),
    /** Turns an extension on or off; its versions and pointer stay. */
    "enabled.set": method(Schema.Struct({ id: Creator.ID, enabled: Schema.Boolean }), List, {
      not_found: errors.not_found,
      invalid: errors.invalid,
    }),
    /** Points the extension at an earlier (or later) version it already has; nothing is rewritten. */
    rollback: method(Schema.Struct({ id: Creator.ID, version: Schema.Int }), List, {
      not_found: errors.not_found,
      version_not_found: errors.version_not_found,
      invalid: errors.invalid,
    }),
    /** Removes the extension; its folder moves to `creator\trash` (the newest 20 are kept). */
    remove: method(Target, List, { not_found: errors.not_found }),
    /**
     * Limits the extension to these project folders and the folders inside them; empty means every project. Host folders
     * (17 §10) are scope entries tagged with their host; without `hostProjects` the host folders stay as they were.
     */
    "scope.set": method(
      Schema.Struct({
        id: Creator.ID,
        projects: Schema.Array(Schema.String),
        hostProjects: Schema.optionalKey(Schema.Array(Creator.HostFolder)),
      }),
      List,
      { not_found: errors.not_found, scope_invalid: errors.scope_invalid },
    ),
    /** Which SSH hosts the extension reaches: all (the default), only some, or all but some (17 §10). */
    "hosts.set": method(Schema.Struct({ id: Creator.ID, hosts: Creator.Hosts }), List, {
      not_found: errors.not_found,
    }),
    /**
     * C3 on one SSH host (17 §10): allows (or withdraws) version `version` there. Apart from `trust.set`, with the same
     * risk; the host checks the folder's hash again before its service loads it. Settings only.
     */
    "hostTrust.set": method(
      Schema.Struct({ id: Creator.ID, host: Creator.HostID, version: Schema.Int, trusted: Schema.Boolean }),
      List,
      { not_found: errors.not_found, version_not_found: errors.version_not_found, invalid: errors.invalid },
    ),
    /**
     * Approves (or withdraws) the allow rules of one version: only then do they loosen what the approval mode asks.
     * Settings only; creator mode's tools cannot approve.
     */
    "loosen.set": method(Schema.Struct({ id: Creator.ID, version: Schema.Int, approved: Schema.Boolean }), List, {
      not_found: errors.not_found,
      version_not_found: errors.version_not_found,
    }),
    /**
     * C3's switch (17 §12.1): off (the default) refuses new code plugins and unloads every one; on lets creator mode
     * stage them, and each version still waits for `trust.set`.
     */
    "plugins.set": method(Schema.Struct({ enabled: Schema.Boolean }), List, {}),
    /**
     * Approves (or withdraws) one C3 version to load in the service: the store records it and own writes the
     * version folder's hash into own-accounts' trust approvals. Settings only.
     */
    "trust.set": method(Schema.Struct({ id: Creator.ID, version: Schema.Int, trusted: Schema.Boolean }), List, {
      not_found: errors.not_found,
      version_not_found: errors.version_not_found,
      invalid: errors.invalid,
    }),
    /** Stops an extension's MCP servers in this service until `mcp.start` (or a restart of the service). */
    "mcp.stop": method(Target, List, { not_found: errors.not_found }),
    "mcp.start": method(Target, List, { not_found: errors.not_found }),
    /** The end of the extension's log: server starts and exits, its stderr, kills, staging, C3 crashes. */
    "log.get": method(Target, Log, { not_found: errors.not_found }),
    /** Lets a C3 plugin that threw run again in the Locations it stopped in. */
    "crashes.clear": method(Target, List, { not_found: errors.not_found }),
  },
  events: { changed: event(Changed) },
})
export type Definition = typeof Definition

export type MethodName = keyof Definition["methods"] & string

/** `read | local` (own.harness' vocabulary): every write is this PC's own clients' only. */
export const Scope = Schema.Literals(["read", "local"]).annotate({ identifier: "OwnCreator.Scope" })
export type Scope = typeof Scope.Type

export const MethodScope: { readonly [M in MethodName]: Scope } = {
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
