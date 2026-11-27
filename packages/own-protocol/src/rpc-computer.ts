/**
 * RPC `own.computer`: status, kill switch, per-session app grants, audit and helper control of the computer-use plugin
 * (`@own/computer-use`, 01 §10.2). Exported as `@own/protocol/rpc-computer`; own.computer-use registers it and own-web
 * calls it. Turning computer use on for a session is not here: it is a session rule written by own-accounts
 * (`session.approval.set{computerUse}`, `approval.ts`).
 */
export * as OwnComputer from "./rpc-computer.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { EpochMillis } from "./id.js"

/** The RPC id; own.computer-use is its only registrant and event publisher. */
export const ID = "own.computer"

/**
 * The answer that grants an app in `question` approval: the allow option of the plugin's question, and the only answer
 * its gate takes as a grant (an exact match). The phone gateway refuses a form reply that carries it, so app grants
 * stay on the PC (own-remote `gateway/policy.ts`, 05 §13.4).
 */
export const ALLOW_ANSWER = "이 세션 동안 허용 · Allow for this session"

const empty = Schema.Struct({})

/**
 * Why computer use is unavailable. `unmanaged`: not started by the own launcher (`OWN_OPEN_CODE`), `skew`: the bundle
 * was built for another app version, `unsupported`: not Windows, `invalid_options`: the plugin options do not decode.
 */
export const Unavailable = Schema.Literals(["unmanaged", "skew", "unsupported", "invalid_options"]).annotate({
  identifier: "OwnComputer.Unavailable",
})
export type Unavailable = typeof Unavailable.Type

export const KillSwitch = Schema.Struct({
  engaged: Schema.Boolean,
  /**
   * `user_chord`: Ctrl+Alt+Shift+Q, `rpc`: the Stop button, `helper_exit`: the desktop worker (or the helper process)
   * stopped unexpectedly.
   */
  reason: optional(Schema.Literals(["user_chord", "rpc", "helper_exit"])),
  at: optional(EpochMillis),
}).annotate({ identifier: "OwnComputer.KillSwitch" })
export type KillSwitch = typeof KillSwitch.Type

export const Helper = Schema.Struct({
  /**
   * The desktop worker thread (`driver: "windows"`) or the helper process (`driver: "helper"`) is up; it starts on the
   * first computer action, never at plugin load.
   */
  running: Schema.Boolean,
  version: optional(Schema.String),
  protocol: optional(PositiveInt),
  /**
   * The physical stop chord Ctrl+Alt+Shift+Q is registered (known once the helper runs). `false`: another program holds
   * it, so every input action is refused with `[computer.no_stop_chord]` until it is free (only the Stop button and
   * `killswitch.engage` stop computer use meanwhile).
   */
  killChord: optional(Schema.Boolean),
}).annotate({ identifier: "OwnComputer.Helper" })
export type Helper = typeof Helper.Type

/** An exe name without `.exe`, lower case (`notepad`), as the policy compares them. */
export const App = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)).annotate({
  identifier: "OwnComputer.App",
})

export const Grants = Schema.Struct({ sessionID: SessionID, apps: Schema.Array(App) }).annotate({
  identifier: "OwnComputer.Grants",
})
export type Grants = typeof Grants.Type

/**
 * The app policy of the plugin options, as the gate applies it (normalized exe names). A non-empty `allowApps` is
 * exclusive in `session` approval mode; `denyApps` adds to the built-in deny list (terminals, own apps, security UIs,
 * password managers), which no option can lift except its terminal part (`allowTerminals`).
 */
export const AppPolicy = Schema.Struct({
  allowApps: Schema.Array(Schema.String),
  denyApps: Schema.Array(Schema.String),
  allowTerminals: Schema.Boolean,
  allowSubagents: Schema.Boolean,
}).annotate({ identifier: "OwnComputer.AppPolicy" })
export type AppPolicy = typeof AppPolicy.Type

/** `status` result. When `available` is false only `reason`, `buildId` and `version` are set. */
export const Status = Schema.Struct({
  available: Schema.Boolean,
  reason: optional(Unavailable),
  buildId: Schema.String,
  version: Schema.String,
  /** `windows`: the in-process driver; `helper`: the own-cu-helper.exe fallback; `fake`: an in-memory test desktop. */
  driver: optional(Schema.Literals(["windows", "helper", "fake"])),
  approval: optional(Schema.Literals(["session", "question"])),
  policy: optional(AppPolicy),
  helper: optional(Helper),
  killSwitch: optional(KillSwitch),
  /** The session holding the desktop lease, if it acted within the idle window. */
  lease: optional(Schema.Struct({ holder: Schema.NullOr(SessionID) })),
  /** Apps approved per session in `question` mode. */
  grants: optional(Schema.Array(Grants)),
}).annotate({ identifier: "OwnComputer.Status" })
export type Status = typeof Status.Type

/**
 * One audit line (`<OWN_HOME>\audit\computer-YYYY-MM.jsonl`). Never images, typed text or window titles: `type` text
 * becomes `{length}` only, the target title only `titleHash`.
 */
export const AuditEntry = Schema.Struct({
  ts: NonNegativeInt,
  sessionID: Schema.String,
  callID: Schema.String,
  tool: Schema.String,
  target: optional(Schema.Struct({ app: Schema.String, titleHash: Schema.String })),
  args: Schema.Record(Schema.String, Schema.Unknown),
  outcome: Schema.Literals(["ok", "denied", "error"]),
  /** `[computer.<code>]` code of a denied or failed action. */
  code: optional(Schema.String),
  ms: NonNegativeInt,
}).annotate({ identifier: "OwnComputer.AuditEntry" })
export type AuditEntry = typeof AuditEntry.Type

/** `action` event: one computer action finished (no arguments; see `audit.list` for those). */
export const Action = Schema.Struct({
  sessionID: Schema.String,
  tool: Schema.String,
  app: optional(Schema.String),
  outcome: AuditEntry.fields.outcome,
  code: optional(Schema.String),
  at: EpochMillis,
}).annotate({ identifier: "OwnComputer.Action" })
export type Action = typeof Action.Type

function method<
  const Input extends Schema.ConstraintDecoder<unknown>,
  const Output extends Schema.ConstraintDecoder<unknown>,
>(input: Input, output: Output) {
  return { input: Schema.toStandardSchemaV1(input), output: Schema.toStandardSchemaV1(output), errors: {} }
}

function event<const S extends Schema.ConstraintDecoder<Readonly<Record<string, unknown>>>>(schema: S) {
  return { schema: Schema.toStandardSchemaV1(schema) }
}

export const Events = {
  status: event(Status),
  action: event(Action),
}

export const Definition = Rpc.define({
  id: ID,
  methods: {
    status: method(empty, Status),
    /** The Stop button: every action fails with `[computer.stopped]` and held input is released. */
    "killswitch.engage": method(empty, KillSwitch),
    /** Only an explicit reset clears the kill switch (never a tool, a timer or a helper restart). */
    "killswitch.reset": method(empty, KillSwitch),
    "session.grants.get": method(Schema.Struct({ sessionID: SessionID }), Grants),
    /** Replaces the session's approved apps. */
    "session.grants.set": method(
      Schema.Struct({ sessionID: SessionID, apps: Schema.Array(App).check(Schema.isMaxLength(64)) }),
      Grants,
    ),
    /** Removes `apps` (default: all) from the session's approved apps. */
    "session.grants.revoke": method(
      Schema.Struct({ sessionID: SessionID, apps: optional(Schema.Array(App).check(Schema.isMaxLength(64))) }),
      Grants,
    ),
    /** Newest first. */
    "audit.list": method(
      Schema.Struct({
        sessionID: optional(SessionID),
        limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
        before: optional(EpochMillis),
      }),
      Schema.Struct({ entries: Schema.Array(AuditEntry) }),
    ),
    /** Stops the helper; the next action starts a new one. The kill switch is left as it is. */
    "helper.restart": method(empty, Helper),
  },
  events: Events,
})
export type Definition = typeof Definition

export type MethodName = keyof Definition["methods"] & string
export type EventName = keyof Definition["events"] & string

/**
 * `read | drive | local` (the own.remote vocabulary). The phone gateway passes only `status` and
 * `killswitch.engage`, to a device that can prompt or switch (own-remote `gateway/policy.ts` `COMPUTER_METHODS`,
 * 05 §13.4).
 */
export const Scope = Schema.Literals(["read", "drive", "local"]).annotate({ identifier: "OwnComputer.Scope" })
export type Scope = typeof Scope.Type

/** Typed so that a new method cannot be added without a scope. */
export const MethodScope: { readonly [M in MethodName]: Scope } = {
  status: "read",
  "audit.list": "read",
  "killswitch.engage": "drive",
  "killswitch.reset": "local",
  "session.grants.get": "local",
  "session.grants.set": "local",
  "session.grants.revoke": "local",
  "helper.restart": "local",
}
