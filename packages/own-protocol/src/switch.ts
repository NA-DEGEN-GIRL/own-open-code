export * as Switch from "./switch.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { AccountID } from "./account-id.js"
import { Estimate } from "./estimate.js"
import { EpochMillis, EstimateID, NonNegative } from "./id.js"

/** State names of the switch state machine (02 §5.4). */
export const StateName = Schema.Literals([
  "STEADY",
  "PLANNED",
  "WAIT_SAFE",
  "COMPACTING",
  "SCHEDULED",
  "SWITCHING",
  "COOLDOWN",
  "BLOCKED",
  "DELEGATED",
  "FAILED",
]).annotate({ identifier: "Own.Switch.StateName" })
export type StateName = typeof StateName.Type

/**
 * What a switch to another subscription of the same company does with the subagents still running on the old account
 * (07 §5.5, `Estimate.Result.busyChildren`): wait until they finish, or stop them first.
 */
export const Children = Schema.Literals(["after-idle", "stop"]).annotate({ identifier: "Own.Switch.Children" })
export type Children = typeof Children.Type

/**
 * The own.team operation (06 `op_<ulid>`) a team account switch runs under (07 §5.5): only own.team passes it, and a
 * team session's switch of the team's subscription account without it is `team_switch_required`.
 */
export const TeamOp = Schema.String.check(Schema.isStartingWith("op_")).annotate({ identifier: "Own.Switch.TeamOp" })
export type TeamOp = typeof TeamOp.Type

/** The three switch triggers: manual, hard exhaustion, auth failure (02 §5.2). */
export const Reason = Schema.Literals(["manual", "hard", "auth"]).annotate({ identifier: "Own.Switch.Reason" })
export type Reason = typeof Reason.Type

/** Why a session's Ref changed. `external` = another client called the model endpoint; `pin` = unpinned-session pin. */
export const BindingReason = Schema.Literals(["manual", "hard", "auth", "external", "undo", "pin"]).annotate({
  identifier: "Own.Switch.BindingReason",
})
export type BindingReason = typeof BindingReason.Type

export const SuggestReason = Schema.Literals(["hard", "auth", "home_available", "reset_passed"]).annotate({
  identifier: "Own.Switch.SuggestReason",
})
export type SuggestReason = typeof SuggestReason.Type

export interface Compact extends Schema.Schema.Type<typeof Compact> {}
export const Compact = Schema.Struct({ type: Schema.Literal("compact"), sessionID: SessionID }).annotate({
  identifier: "Own.Switch.Compact",
})

export interface Fork extends Schema.Schema.Type<typeof Fork> {}
export const Fork = Schema.Struct({ type: Schema.Literal("fork"), sessionID: SessionID, target: Model.Ref }).annotate({
  identifier: "Own.Switch.Fork",
})

export interface CreateSession extends Schema.Schema.Type<typeof CreateSession> {}
export const CreateSession = Schema.Struct({
  type: Schema.Literal("create-session"),
  sessionID: SessionID,
  target: Model.Ref,
}).annotate({ identifier: "Own.Switch.CreateSession" })

/**
 * The client restarts the service (02 §8.7). No arguments (v0.4): the new Claude account source is already in
 * `OWN_HOME\claude-auth.json`, which the launcher reads on every start.
 */
export interface RestartService extends Schema.Schema.Type<typeof RestartService> {}
export const RestartService = Schema.Struct({
  type: Schema.Literal("restart-service"),
}).annotate({ identifier: "Own.Switch.RestartService" })

/** HTTP work the plugin cannot do itself; the front end performs it (02 §5.9, §8.7). */
export const ClientAction = Schema.Union([Compact, Fork, CreateSession, RestartService])
  .annotate({ identifier: "Own.Switch.ClientAction" })
  .pipe(Schema.toTaggedUnion("type"))
export type ClientAction = typeof ClientAction.Type

/** BLOCKED sub-state "리셋까지 대기": at `resumeAt` the plugin prompts `message` (02 §5.9(i)). */
export interface WaitReset extends Schema.Schema.Type<typeof WaitReset> {}
export const WaitReset = Schema.Struct({ resumeAt: EpochMillis, message: Schema.String }).annotate({
  identifier: "Own.Switch.WaitReset",
})

/**
 * The Claude account a pending switch to `anthropic` lands on (SL-17): the account the session's tree ran on when the
 * state was entered. Several Claude accounts share `anthropic`, and the switcher moves the tree to the chosen one before
 * a switch from another company, so the session's binding names the old company's account until the switch lands.
 * Absent for every other provider (one account each) and in states written before.
 */
const pendingAccount = optional(AccountID)

/** SwitchState stored in KV `sess:<sid>:switch` and returned by `switch.state` (02 §5.4 table). */
export const State = Schema.Union([
  Schema.Struct({ state: Schema.Literal("STEADY"), slot: optional(Provider.ID) }),
  Schema.Struct({
    state: Schema.Literal("PLANNED"),
    estimateID: EstimateID,
    target: Model.Ref,
    options: Schema.Array(Estimate.Option),
    reason: Reason,
    expiresAt: EpochMillis,
  }),
  Schema.Struct({
    state: Schema.Literal("WAIT_SAFE"),
    target: Model.Ref,
    strategy: Estimate.Strategy,
    reason: Reason,
    accountID: pendingAccount,
  }),
  Schema.Struct({
    state: Schema.Literal("COMPACTING"),
    target: Model.Ref,
    requestedAt: EpochMillis,
    /** Milliseconds (default 10 minutes); then back to PLANNED with an alert. */
    timeout: NonNegative,
    accountID: pendingAccount,
  }),
  Schema.Struct({
    state: Schema.Literal("SCHEDULED"),
    target: Model.Ref,
    trigger: Estimate.ScheduleTrigger,
    idleMinutes: NonNegative,
    uncertain: Schema.Boolean,
    deadline: EpochMillis,
    accountID: pendingAccount,
  }),
  Schema.Struct({
    state: Schema.Literal("SWITCHING"),
    target: Model.Ref,
    issuedAt: EpochMillis,
    accountID: pendingAccount,
  }),
  Schema.Struct({ state: Schema.Literal("COOLDOWN"), until: EpochMillis, requestsLeft: NonNegativeInt }),
  Schema.Struct({
    state: Schema.Literal("BLOCKED"),
    /** Reason code, e.g. `all_exhausted` or `auth_failed`. */
    reason: Schema.String,
    nextResetAt: Schema.NullOr(EpochMillis),
    waitReset: optional(WaitReset),
  }),
  Schema.Struct({ state: Schema.Literal("DELEGATED"), childSessionID: SessionID }),
  Schema.Struct({ state: Schema.Literal("FAILED"), error: Schema.String }),
])
  .annotate({ identifier: "Own.Switch.State" })
  .pipe(Schema.toTaggedUnion("state"))
export type State = typeof State.Type

/** `switch.apply` result (02 §9.2). `detail` carries the state fields, e.g. BLOCKED `nextResetAt`. */
export interface ApplyResult extends Schema.Schema.Type<typeof ApplyResult> {}
export const ApplyResult = Schema.Struct({
  state: StateName,
  clientAction: optional(ClientAction),
  detail: optional(State),
}).annotate({ identifier: "Own.Switch.ApplyResult" })

/** `switch.schedule` result (02 §9.2). */
export interface ScheduleResult extends Schema.Schema.Type<typeof ScheduleResult> {}
export const ScheduleResult = Schema.Struct({
  state: Schema.Literal("SCHEDULED"),
  trigger: Estimate.ScheduleTrigger,
  idleMinutes: NonNegative,
  uncertain: Schema.Boolean,
  deadline: EpochMillis,
}).annotate({ identifier: "Own.Switch.ScheduleResult" })

/** Home slot, KV `sess:<sid>:home` (02 §5.8). */
export interface Home extends Schema.Schema.Type<typeof Home> {}
export const Home = Schema.Struct({ providerID: Provider.ID, pinned: Schema.Boolean, since: EpochMillis }).annotate({
  identifier: "Own.Switch.Home",
})

export const StripKind = Schema.Literals(["reasoning.encrypted", "thinking.signature", "item.id"]).annotate({
  identifier: "Own.Switch.StripKind",
})
export type StripKind = typeof StripKind.Type

/** Safety-net strip rule, KV `sess:<sid>:strip` holds an array (02 §4.4). */
export interface StripRule extends Schema.Schema.Type<typeof StripRule> {}
export const StripRule = Schema.Struct({
  providerID: Provider.ID,
  dropBefore: Schema.String,
  kinds: Schema.Array(StripKind),
  until: Schema.Literal("next-compaction"),
}).annotate({ identifier: "Own.Switch.StripRule" })

/** KV `sess:<sid>:confirmOverride`; deleted when `switch.setConfirmOverride` receives `null` (02 §2.4.6). */
export interface ConfirmOverride extends Schema.Schema.Type<typeof ConfirmOverride> {}
export const ConfirmOverride = Schema.Struct({ silentBelowTokens: NonNegativeInt }).annotate({
  identifier: "Own.Switch.ConfirmOverride",
})

/** KV `sess:<sid>:compaction`: the session's "compact earlier" threshold (02 §2.4.6, §4.7.4). */
export interface SessionCompaction extends Schema.Schema.Type<typeof SessionCompaction> {}
export const SessionCompaction = Schema.Struct({ triggerTokens: PositiveInt, setAt: EpochMillis }).annotate({
  identifier: "Own.Switch.SessionCompaction",
})

/** KV `sess:<sid>:compactionDue`: the last `compaction.due` sent (02 §2.4.6). */
export interface CompactionDue extends Schema.Schema.Type<typeof CompactionDue> {}
export const CompactionDue = Schema.Struct({
  inputID: SessionMessage.ID,
  epoch: NonNegativeInt,
  P: NonNegative,
  triggerTokens: PositiveInt,
  at: EpochMillis,
}).annotate({ identifier: "Own.Switch.CompactionDue" })

/**
 * KV `sess:<sid>:childPolicy` (v0.4, 02 §5.11): how the parent's last switch treats its children. `providerID` is the
 * slot the parent left.
 */
export interface ChildPolicy extends Schema.Schema.Type<typeof ChildPolicy> {}
export const ChildPolicy = Schema.Struct({
  policy: Schema.Literals(["follow", "keep"]),
  providerID: Provider.ID,
  since: EpochMillis,
}).annotate({ identifier: "Own.Switch.ChildPolicy" })
