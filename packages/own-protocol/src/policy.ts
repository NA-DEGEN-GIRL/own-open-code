export * as Policy from "./policy.js"

import { Schema } from "effect"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { Account } from "./account.js"
import { Compaction } from "./compaction.js"
import { OwnImage } from "./image.js"
import { NonNegative } from "./id.js"
import { OutputLimit } from "./output-limit.js"

export const SwitchMode = Schema.Literals(["auto", "ask", "off"]).annotate({ identifier: "Own.Policy.SwitchMode" })
export type SwitchMode = typeof SwitchMode.Type

/**
 * Leaving a subscription is never automatic (02 §5.10). The stored policy only admits `ask | off` there and a fixed
 * `toClaudeSlot: "off"`; `policy.set` accepts any {@link SwitchMode} and answers `policy_denied` instead.
 */
export const SubscriptionMode = Schema.Literals(["ask", "off"]).annotate({ identifier: "Own.Policy.SubscriptionMode" })
export type SubscriptionMode = typeof SubscriptionMode.Type

/**
 * Between this PC's Claude subscription accounts (02 §8.8): `auto` moves the tree at once, `off` never does. There is
 * no `ask`: the switch has to happen before any output, so nothing waits for a click.
 */
export const ClaudeMode = Schema.Literals(["auto", "off"]).annotate({ identifier: "Own.Policy.ClaudeMode" })
export type ClaudeMode = typeof ClaudeMode.Type

export interface AutoSwitch extends Schema.Schema.Type<typeof AutoSwitch> {}
export const AutoSwitch = Schema.Struct({
  /** Same-kind API keys, only for accounts with `autoSwitch: true`. */
  apiToApi: SwitchMode,
  subscriptionToApi: SubscriptionMode,
  subscriptionToSubscription: SubscriptionMode,
  toClaudeSlot: Schema.Literal("off"),
  /**
   * 02 §8.8 (user decision C-D3 2026-10-10): from one Claude subscription account of this PC to another when it runs
   * out, the conversation's whole tree at once. Absent = `off`, and new installs write `off` (CAG-5 2026-10-31); an
   * existing `auto` is kept. Never to or from another company.
   */
  claudeToClaude: optional(ClaudeMode),
  /** Phase 3; `false` until AC-P17b passes. */
  inTurnFailover: Schema.Boolean,
}).annotate({ identifier: "Own.Policy.AutoSwitch" })

export interface Hysteresis extends Schema.Schema.Type<typeof Hysteresis> {}
export const Hysteresis = Schema.Struct({
  cooldownMinutes: NonNegative,
  cooldownRequests: NonNegativeInt,
  breakerAutoPerHour: NonNegativeInt,
  breakerFlapMinutes: NonNegative,
  breakerOpenMinutes: NonNegative,
  coldSumFactor: NonNegative,
}).annotate({ identifier: "Own.Policy.Hysteresis" })

export interface Confirm extends Schema.Schema.Type<typeof Confirm> {}
export const Confirm = Schema.Struct({
  silentBelowTokens: NonNegativeInt,
  dialogAtTokens: NonNegativeInt,
  dialogAtQuotaPercent: NonNegative,
  dialogAtUSD: NonNegative,
}).annotate({ identifier: "Own.Policy.Confirm" })

/**
 * There are no token-size advice thresholds (07 §6.1 U6, §6.2 #9–#11): switch advice compares against the target's
 * window and trigger only, and nothing advises compacting to save quota.
 */
export interface Thresholds extends Schema.Schema.Type<typeof Thresholds> {}
export const Thresholds = Schema.Struct({
  anthropicWatermarkBlocks: NonNegativeInt,
  unknownTtlIdleMinutes: NonNegative,
  scheduleDeadlineMinMinutes: NonNegative,
  confirm: Confirm,
}).annotate({ identifier: "Own.Policy.Thresholds" })

/** `false` shows every built-in provider; `"auto"` hides the built-ins of kinds that have own accounts. */
export const HideBuiltinProviders = Schema.Union([
  Schema.Literal("auto"),
  Schema.Literal(false),
  Schema.Array(Provider.ID),
]).annotate({ identifier: "Own.Policy.HideBuiltinProviders" })
export type HideBuiltinProviders = typeof HideBuiltinProviders.Type

/** Default account per kind (03 §5.4). */
export interface ByKind extends Schema.Schema.Type<typeof ByKind> {}
export const ByKind = Schema.Struct({
  codex: optional(Account.ID),
  siwc: optional(Account.ID),
  oai: optional(Account.ID),
  anth: optional(Account.ID),
  ds: optional(Account.ID),
  xai: optional(Account.ID),
  or: optional(Account.ID),
  compat: optional(Account.ID),
}).annotate({ identifier: "Own.Policy.ByKind" })

/**
 * The new-session default model is not a policy value: each provider group has one in `presets.json` (07 §2.2), so
 * `byKind` only picks the account a new session starts on.
 */
export interface Defaults extends Schema.Schema.Type<typeof Defaults> {}
export const Defaults = Schema.Struct({ byKind: ByKind }).annotate({ identifier: "Own.Policy.Defaults" })

export interface AwayDetect extends Schema.Schema.Type<typeof AwayDetect> {}
export const AwayDetect = Schema.Struct({ enabled: Schema.Boolean, hiddenMinutes: NonNegative }).annotate({
  identifier: "Own.Policy.AwayDetect",
})

export const CredentialBackend = Schema.Literals(["vault", "opencode-credential"]).annotate({
  identifier: "Own.Policy.CredentialBackend",
})
export type CredentialBackend = typeof CredentialBackend.Type

/**
 * `policy.compaction` (02 §2.4.3, §4.7.3). `byKind` holds only the user's changes; missing kinds and fields use
 * `Compaction.defaults`. `keepTokens` is never stored in `policy.json`: `policy.get` reports the core
 * `compaction.keep.tokens` of the own global config file, the only source (4.7.6 (가)).
 */
/** `policy.compaction.idle` (02 §2.4.3, §4.7.7): idle compaction, an opt-in; absent or `enabled: false` = never. */
export interface PolicyCompactionIdle extends Schema.Schema.Type<typeof PolicyCompactionIdle> {}
export const PolicyCompactionIdle = Schema.Struct({
  enabled: Schema.Boolean,
  /** Default `CompactionCache.IDLE.minTokens`. */
  minTokens: optional(PositiveInt),
  /** Default `CompactionCache.IDLE.minIdleMinutes`. */
  minIdleMinutes: optional(PositiveInt),
}).annotate({ identifier: "Own.Policy.CompactionIdle" })

export interface PolicyCompaction extends Schema.Schema.Type<typeof PolicyCompaction> {}
export const PolicyCompaction = Schema.Struct({
  byKind: Compaction.ByKind,
  keepTokens: optional(PositiveInt),
  /** Idle compaction before the cache expires (02 §4.7.7, CC 2026-10-24): an opt-in, absent = off. */
  idle: optional(PolicyCompactionIdle),
}).annotate({ identifier: "Own.Policy.Compaction" })

/**
 * One model the user hid from the lists (PF 2026-11-03, 07 §7.1 숨긴 모델): a provider group (an account kind such as
 * `codex` or `claude-sub`, or `local:<providerID>`) and a model id. Plain strings, read leniently.
 */
export interface HiddenModel extends Schema.Schema.Type<typeof HiddenModel> {}
export const HiddenModel = Schema.Struct({ group: Schema.String, model: Schema.String }).annotate({
  identifier: "Own.Policy.HiddenModel",
})

/**
 * Whether the user hid `model` of `group` (07 §7.1 숨긴 모델). Hiding only takes a model out of the pickers, the
 * recommended pool and automatic choices; a preset or a conversation that uses it keeps working.
 */
export function hidden(policy: Pick<File, "hiddenModels"> | undefined, group: string | undefined, model: string) {
  return (
    group !== undefined && (policy?.hiddenModels ?? []).some((item) => item.group === group && item.model === model)
  )
}

/**
 * One-time changes own made to a stored policy (02 §2.4.3), each made once and never again, so a later choice of the
 * user stands. `claudeToClaudeOff` (CAG-5, 2026-10-31): the first start of a build with it turned a stored
 * `autoSwitch.claudeToClaude: "auto"` (every `policy.set` from 2026-10-11 on wrote one) into `off` (`changed: true`,
 * `at`); a `policy.set` that names `claudeToClaude` first records the user's own choice (`changed: false`), which no
 * start changes. `noticed`: the app told the user (`policy.set{noticed}`).
 */
export interface Migrated extends Schema.Schema.Type<typeof Migrated> {}
export const Migrated = Schema.Struct({
  claudeToClaudeOff: optional(
    Schema.Struct({ changed: Schema.Boolean, at: optional(NonNegativeInt), noticed: optional(Schema.Boolean) }),
  ),
}).annotate({ identifier: "Own.Policy.Migrated" })

/** The one-time notices the app acknowledges with `policy.set{noticed}`. */
export const Notice = Schema.Literals(["claudeToClaudeOff"]).annotate({ identifier: "Own.Policy.Notice" })
export type Notice = typeof Notice.Type

/** `OWN_HOME\policy.json` (02 §2.4.3). */
export interface File extends Schema.Schema.Type<typeof File> {}
export const File = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  autoSwitch: AutoSwitch,
  hysteresis: Hysteresis,
  thresholds: Thresholds,
  horizonRequests: PositiveInt,
  /** Chains that contain a `billing: "subscription"` slot are used only for "recommended" ordering (02 §2.4.3). */
  fallbackChains: Schema.Record(Schema.String, Schema.Array(Provider.ID)),
  hideBuiltinProviders: HideBuiltinProviders,
  defaults: Defaults,
  awayDetect: AwayDetect,
  /** Decrypted secret cache TTL; `0` disables the cache (01 §8.3). */
  secretCacheSeconds: NonNegativeInt,
  credentialBackend: CredentialBackend,
  /** Auto-compaction kind defaults changed by the user (02 §2.4.3, §4.7.3). */
  compaction: optional(PolicyCompaction),
  /**
   * Tool names the repeated identical tool-call reminder ignores (external-repos P1-1, decision D4), `*` matching any
   * run of characters. Absent: the list in code (`Repeat.EXCLUDE`, own-accounts). Set by editing the file;
   * `policy.set` keeps it.
   */
  repeatReminderExclude: optional(Schema.Array(Schema.String)),
  /** The main reply's output limit (02 §4.9, OL 2026-10-19). Absent: `OutputLimit.DEFAULT` (core's own default). */
  outputLimit: optional(OutputLimit.Setting),
  /**
   * Core's `experimental_image_generate` tool (upstream v2.2.2 offers it whenever a connected provider has an image
   * model; decisions US5): own lists it only when this is `true`. Absent or `false`: off, so the tool list and the
   * prompt cache stay as they were and no image request costs anything unasked. See {@link imageGenerate}.
   */
  imageGenerate: optional(Schema.Boolean),
  /** Models the user hid from the lists (PF 2026-11-03, {@link HiddenModel}); absent = none. */
  hiddenModels: optional(Schema.Array(HiddenModel)),
  /** own's image tool (02 §9.6): models, quality and size, the key chain and the Codex fallback. */
  image: optional(OwnImage.Setting),
  /** One-time changes own made (see {@link Migrated}). */
  migrated: optional(Migrated),
}).annotate({ identifier: "Own.Policy.File" })

/** Built-in defaults written on first run (02 §2.4.3). */
export const defaults = {
  schemaVersion: 1,
  autoSwitch: {
    apiToApi: "auto",
    subscriptionToApi: "ask",
    subscriptionToSubscription: "ask",
    toClaudeSlot: "off",
    claudeToClaude: "off",
    inTurnFailover: false,
  },
  hysteresis: {
    cooldownMinutes: 30,
    cooldownRequests: 20,
    breakerAutoPerHour: 2,
    breakerFlapMinutes: 10,
    breakerOpenMinutes: 30,
    coldSumFactor: 3,
  },
  thresholds: {
    anthropicWatermarkBlocks: 15,
    unknownTtlIdleMinutes: 60,
    scheduleDeadlineMinMinutes: 30,
    confirm: { silentBelowTokens: 20_000, dialogAtTokens: 100_000, dialogAtQuotaPercent: 5, dialogAtUSD: 0.5 },
  },
  horizonRequests: 20,
  fallbackChains: { default: [] },
  hideBuiltinProviders: "auto",
  defaults: { byKind: {} },
  awayDetect: { enabled: true, hiddenMinutes: 10 },
  secretCacheSeconds: 600,
  credentialBackend: "vault",
} as const satisfies File

/**
 * `policy.set` patch. Sections merge one level deep; arrays and records replace. The auto-switch modes accept every
 * {@link SwitchMode} so a forbidden value reaches the handler and is answered with `policy_denied` (02 §9.2).
 */
export interface Patch extends Schema.Schema.Type<typeof Patch> {}
export const Patch = Schema.Struct({
  autoSwitch: optional(
    Schema.Struct({
      apiToApi: optional(SwitchMode),
      subscriptionToApi: optional(SwitchMode),
      subscriptionToSubscription: optional(SwitchMode),
      toClaudeSlot: optional(SwitchMode),
      claudeToClaude: optional(SwitchMode),
      inTurnFailover: optional(Schema.Boolean),
    }),
  ),
  hysteresis: optional(
    Schema.Struct({
      cooldownMinutes: optional(NonNegative),
      cooldownRequests: optional(NonNegativeInt),
      breakerAutoPerHour: optional(NonNegativeInt),
      breakerFlapMinutes: optional(NonNegative),
      breakerOpenMinutes: optional(NonNegative),
      coldSumFactor: optional(NonNegative),
    }),
  ),
  thresholds: optional(
    Schema.Struct({
      anthropicWatermarkBlocks: optional(NonNegativeInt),
      unknownTtlIdleMinutes: optional(NonNegative),
      scheduleDeadlineMinMinutes: optional(NonNegative),
      confirm: optional(
        Schema.Struct({
          silentBelowTokens: optional(NonNegativeInt),
          dialogAtTokens: optional(NonNegativeInt),
          dialogAtQuotaPercent: optional(NonNegative),
          dialogAtUSD: optional(NonNegative),
        }),
      ),
    }),
  ),
  horizonRequests: optional(PositiveInt),
  fallbackChains: optional(Schema.Record(Schema.String, Schema.Array(Provider.ID))),
  hideBuiltinProviders: optional(HideBuiltinProviders),
  defaults: optional(Schema.Struct({ byKind: optional(ByKind) })),
  awayDetect: optional(
    Schema.Struct({
      enabled: optional(Schema.Boolean),
      hiddenMinutes: optional(NonNegative),
    }),
  ),
  secretCacheSeconds: optional(NonNegativeInt),
  credentialBackend: optional(CredentialBackend),
  /**
   * Kind defaults (`null` clears a kind back to the code constant) and the global `keep` (written to the own global
   * config file, not to `policy.json`). Ranges are checked by the handler (`setting_out_of_range`), and `claude-sub`
   * is accepted here only to be answered with `policy_denied{field:"compaction.byKind.claude-sub"}` (02 §9.2).
   */
  compaction: optional(
    Schema.Struct({
      byKind: optional(
        Schema.Struct({
          codex: optional(Schema.NullOr(Compaction.SettingInput)),
          siwc: optional(Schema.NullOr(Compaction.SettingInput)),
          oai: optional(Schema.NullOr(Compaction.SettingInput)),
          anth: optional(Schema.NullOr(Compaction.SettingInput)),
          ds: optional(Schema.NullOr(Compaction.SettingInput)),
          xai: optional(Schema.NullOr(Compaction.SettingInput)),
          or: optional(Schema.NullOr(Compaction.SettingInput)),
          compat: optional(Schema.NullOr(Compaction.SettingInput)),
          "claude-agent": optional(Schema.NullOr(Compaction.SettingInput)),
          "claude-sub": optional(Schema.NullOr(Compaction.SettingInput)),
        }),
      ),
      keepTokens: optional(Schema.Int),
      /** Idle compaction (02 §4.7.7): the given fields replace the stored ones. */
      idle: optional(
        Schema.Struct({
          enabled: optional(Schema.Boolean),
          minTokens: optional(PositiveInt),
          minIdleMinutes: optional(PositiveInt),
        }),
      ),
    }),
  ),
  /** Replaces the output limit (02 §4.9); `null` goes back to the default. Range checked by the handler. */
  outputLimit: optional(Schema.NullOr(OutputLimit.SettingInput)),
  /** Lists core's image tool (`true`) or not (`false`, the default). */
  imageGenerate: optional(Schema.Boolean),
  /** Replaces the hidden models (07 §7.1 숨긴 모델); `[]` shows every model again. */
  hiddenModels: optional(Schema.Array(HiddenModel)),
  /** The given image tool fields replace the stored ones (`OwnImage.apply`). */
  image: optional(OwnImage.Setting),
  /** The app showed this one-time notice ({@link Migrated}); it is not shown again. */
  noticed: optional(Notice),
}).annotate({ identifier: "Own.Policy.Patch" })

/**
 * Core's image tool id (`packages/core/src/tool/plugin/image-generate.ts`, surface `image-generate-tool`;
 * `experimental_image_generate` before v2.4.0, #65682).
 */
export const IMAGE_GENERATE_TOOL = "generate_image"

/**
 * Core's video tool id (`packages/core/src/tool/plugin/video-generate.ts`, v2.4.0 #63666): listed by core while a
 * connected provider has a video model. own never lists it: one call is a paid video, run in the background.
 */
export const VIDEO_GENERATE_TOOL = "generate_video"

/**
 * Core's automation tools (`packages/core/src/tool/plugin/automation.ts`, namespace `automation`, on by default since
 * v2.4.0 #65296, surface `automation-tools`). own never lists them: an automation runs prompts, Code Mode scripts or
 * shell commands later on a timer, a cron or an MCP event, and own-web has no view to list, pause or delete them, so the
 * user would not see what a conversation scheduled (decisions MR18).
 */
export const AUTOMATION_TOOLS = [
  "automation_create",
  "automation_list",
  "automation_pause",
  "automation_resume",
  "automation_delete",
] as const

/** Whether own lists core's image tool: only when the user turned it on. */
export function imageGenerate(policy: File | undefined) {
  return policy?.imageGenerate === true
}
