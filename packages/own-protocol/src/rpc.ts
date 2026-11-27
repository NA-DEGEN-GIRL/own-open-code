export * as OwnAccounts from "./rpc.js"

import { ID } from "./rpc-routing.js"
import { Effect, Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Account } from "./account.js"
import { Alert } from "./alert.js"
import { Approval } from "./approval.js"
import { Cache } from "./cache.js"
import { ClaudeAgent } from "./claude-agent.js"
import { CodexModels } from "./codex-models.js"
import { Compaction } from "./compaction.js"
import { ConversationFolder } from "./conversation-folder.js"
import { Credential } from "./credential.js"
import { OwnError } from "./error.js"
import { Side } from "./side.js"
import { Estimate } from "./estimate.js"
import { OwnGitHub } from "./github.js"
import { Ideas } from "./ideas.js"
import { OwnBrowse } from "./browse.js"
import { OwnImage } from "./image.js"
import { AttemptID, EpochMillis, EstimateID, EventID, IsoDateTime, Nonce, NonNegative } from "./id.js"
import { Kind } from "./kind.js"
import { Ledger } from "./ledger.js"
import { Limit } from "./limit.js"
import { McpHost } from "./mcp-host.js"
import { OwnMcp } from "./mcp.js"
import { Notes } from "./notes.js"
import { Plugin } from "./plugin.js"
import { Policy } from "./policy.js"
import { Preset } from "./preset.js"
import { ProjectList } from "./project-list.js"
import { ProtectedPaths } from "./protected-paths.js"
import { Ratecard } from "./ratecard.js"
import { SearchKey } from "./search-key.js"
import { OwnSkillset } from "./skillset.js"
import { Speed } from "./speed.js"
import { Switch } from "./switch.js"
import { ToolUpdates } from "./tool-updates.js"
import { Voice } from "./voice.js"

/**
 * RPC id `own.accounts`, one of the four own RPC ids (`own.accounts`, `own.remote`, `own.team`, `own.computer`,
 * FORK §1); own-accounts is its only registrant and event publisher (02 §9.1).
 */
export { ID } from "./rpc-routing.js"

const empty = Schema.Struct({})
const session = { sessionID: SessionID }
const planned = { nonce: Nonce, expiresAt: EpochMillis }
const execute = Schema.Struct({ nonce: Nonce })

/**
 * One Claude Agent account in `claudeAgent.status` (02 §8.10): its folder, whether Claude Code is logged in there (its
 * credentials file exists, never read), the masked e-mail, the plan Claude Code reported, whether new conversations
 * start on it, and what the user runs to log in there from a terminal: `commands.cmd` in 명령 프롬프트 (cmd.exe),
 * `commands.powershell` in PowerShell (`null` without Claude Code).
 */
const ClaudeAgentAccountStatus = Schema.Struct({
  accountID: Account.ID,
  folder: Schema.String,
  label: Schema.NullOr(Schema.String),
  shortLabel: Schema.String,
  loggedIn: Schema.Boolean,
  email: optional(Schema.String),
  plan: optional(Schema.NullOr(Schema.String)),
  default: Schema.Boolean,
  commands: Schema.NullOr(Schema.Struct({ cmd: Schema.String, powershell: Schema.String })),
})

/**
 * The Claude Agent route's state (02 §8.10, CAG 2026-10-31): its accounts (empty until set up, the default first), the
 * Claude Code own found on this PC (`cli`, `null`: none, own never installs it), and the login window own opened last
 * (`login`, for `loginAccount`).
 */
const ClaudeAgentStatus = Schema.Struct({
  accounts: Schema.Array(ClaudeAgentAccountStatus),
  cli: Schema.NullOr(Schema.String),
  login: Schema.Literals(["idle", "waiting", "logged_in", "failed", "timeout"]),
  loginAccount: optional(Account.ID),
  /** The live claude processes of this service and their cap (02 §8.10.12). */
  pool: optional(ClaudeAgent.Pool),
})

/**
 * A Claude login folder this PC's own knows (02 §8.10 폴더 나누기): which route it belongs to, its account, and whether
 * it can move to the other route (`movable`; `reason` when not: `claude_code` = Claude Code's own folder, `slot` =
 * claude-auth's account 1, `not_managed` = a folder own did not make, `busy` = a conversation on it is running,
 * `not_patched` = the claude-auth in this app runs one account).
 */
const ClaudeFolder = Schema.Struct({
  folder: Schema.String,
  route: Schema.Literals(["claude-auth", "claude-agent"]),
  accountID: Account.ID,
  label: Schema.String,
  email: optional(Schema.String),
  loggedIn: Schema.Boolean,
  movable: Schema.Boolean,
  reason: optional(Schema.Literals(["claude_code", "slot", "not_managed", "busy", "not_patched"])),
})

// ---------------------------------------------------------------------------------------------------------------
// Read models

export const Guard = Schema.Literals(["ok", "skew", "unmanaged"]).annotate({ identifier: "Own.Rpc.Guard" })
export type Guard = typeof Guard.Type

/**
 * `health` result (02 §9.2, 01 §14.5). The only method registered even when guard 1 fails; then only `guard`,
 * `version`, and `buildId` are reliable and the rest may be absent.
 */
export interface Health extends Schema.Schema.Type<typeof Health> {}
export const Health = Schema.Struct({
  version: Schema.String,
  buildId: Schema.String,
  guard: Guard,
  pluginVersions: optional(
    Schema.Struct({
      accounts: Schema.String,
      telemetry: optional(Schema.NullOr(Schema.String)),
      /** The loaded bundled claude-auth's version (02 §8.2); `null` while it is not loaded or not verified. */
      claudeAuth: optional(Schema.NullOr(Schema.String)),
    }),
  ),
  vaultBackend: optional(Schema.NullOr(Schema.Struct({ name: Schema.String, version: Schema.String }))),
  vault: optional(Schema.Literals(["ok", "unavailable"])),
  registryRevision: optional(Schema.NullOr(NonNegativeInt)),
  controlDir: optional(Schema.NullOr(Schema.String)),
  locations: optional(Schema.Array(Schema.Struct({ directory: Schema.String, allowlist: Plugin.TrustStatus }))),
  sizes: optional(
    Schema.Struct({
      kv: Schema.NullOr(NonNegative),
      ledger: Schema.NullOr(NonNegative),
      db: Schema.NullOr(NonNegative),
    }),
  ),
  warnings: optional(Schema.Array(Schema.String)),
  /** 04 §16.5: `remote` inside a remote service (SSH host), `local` on this PC. Absent from older builds. */
  mode: optional(Schema.Literals(["local", "remote"])),
  /** Remote mode only: the credential broker client (04 §8.3). */
  broker: optional(
    Schema.NullOr(
      Schema.Struct({
        state: Schema.Literals(["unarmed", "connecting", "connected", "drain", "skew"]),
        epoch: Schema.NullOr(NonNegativeInt),
        lastSeenAt: Schema.NullOr(EpochMillis),
      }),
    ),
  ),
  /** Remote mode only: the mirrored registry view (04 §9.2); `null` fields before the first mirror. */
  mirror: optional(
    Schema.NullOr(Schema.Struct({ revision: Schema.NullOr(NonNegativeInt), fetchedAt: Schema.NullOr(EpochMillis) })),
  ),
  /**
   * Remote mode only (04 §8.11.4.3): the PC's verdict for the Claude subscription slot on this host (`null` before a
   * view named one, or from an older PC) and whether this Location has its own Claude login or claude-auth (`conflict`).
   */
  claudeSlot: optional(Schema.Struct({ state: Schema.NullOr(Plugin.ClaudeRemoteState), conflict: Schema.Boolean })),
}).annotate({ identifier: "Own.Rpc.Health" })

/** One `session.binding` entry (02 §9.2). `accountID: null` means an unknown provider (e.g. external switch). */
export interface Binding extends Schema.Schema.Type<typeof Binding> {}
export const Binding = Schema.Struct({
  sessionID: SessionID,
  /** `null` for an unpinned session ("기본값(미고정)", 01 §8.5). */
  model: Schema.NullOr(Model.Ref),
  accountID: Schema.NullOr(Account.ID),
  /** Bound to a built-in provider that uses global credentials; the UI warns. */
  builtin: Schema.Boolean,
  thirdParty: Schema.Boolean,
  home: Schema.NullOr(Provider.ID),
  switch: Switch.State,
}).annotate({ identifier: "Own.Rpc.Binding" })

/** `diagnostics.selfTest` result (02 §4.2, §10.1). Findings name locations and patterns, never secret values. */
export interface SelfTest extends Schema.Schema.Type<typeof SelfTest> {}
export const SelfTest = Schema.Struct({
  slots: Schema.Array(
    Schema.Struct({
      providerID: Provider.ID,
      ok: Schema.Boolean,
      problems: Schema.Array(Schema.String),
      authSwap: Schema.Literals(["ok", "broken", "unknown"]),
    }),
  ),
  secretScan: Schema.Struct({ ok: Schema.Boolean, findings: Schema.Array(Schema.String) }),
  defaultModel: Schema.Struct({ ok: Schema.Boolean, warning: optional(Schema.Literal("default_model_own_slot")) }),
  surface: Schema.Struct({ ok: Schema.Boolean, changed: Schema.Array(Schema.String) }),
  /**
   * 07 §5.4: hidden agents (title, summary …) whose configured model named an own subscription slot and was removed,
   * so they run on the session's model (`internal_agent_model_removed`). Absent from builds without the check.
   */
  agentModels: optional(
    Schema.Struct({
      ok: Schema.Boolean,
      removed: Schema.Array(Schema.Struct({ agent: Schema.String, model: Model.Ref })),
    }),
  ),
}).annotate({ identifier: "Own.Rpc.SelfTest" })

/**
 * Wire evidence capture mode (P0-3a, 02 §7.8). Both record every response header name, statuses, frame and event types
 * and `kind`/`transport`; `hash` keeps only hashes of error bodies, frames and usage, `shape` also their shapes (strings
 * as lengths, numbers kept only in usage and limit objects) and the values of limit-like headers.
 */
export const CaptureMode = Schema.Literals(["hash", "shape"]).annotate({ identifier: "Own.Rpc.CaptureMode" })
export type CaptureMode = typeof CaptureMode.Type

/** How a capture window ended: `stop`, its time ran out, a new `start`, or the service stopped. */
export const CaptureEnd = Schema.Literals(["stopped", "expired", "replaced", "shutdown"]).annotate({
  identifier: "Own.Rpc.CaptureEnd",
})
export type CaptureEnd = typeof CaptureEnd.Type

/** One capture window of this process (02 §7.8). Files hold redacted shapes and hashes, never bodies or credentials. */
export interface CaptureWindow extends Schema.Schema.Type<typeof CaptureWindow> {}
export const CaptureWindow = Schema.Struct({
  /** `cap_<ULID>`; every line the window wrote carries it as `capture`. */
  id: Schema.String,
  mode: CaptureMode,
  startedAt: EpochMillis,
  until: EpochMillis,
  /** `null` while the window runs. */
  endedAt: Schema.NullOr(EpochMillis),
  end: Schema.NullOr(CaptureEnd),
  /** Only this session's requests; `null` = every session. */
  sessionID: Schema.NullOr(SessionID),
  /** Only these own slots; `null` = every own slot. */
  providerIDs: Schema.NullOr(Schema.Array(Provider.ID)),
  /** Lines written. */
  records: NonNegativeInt,
  /** Lines left out because the window reached its line cap. */
  dropped: NonNegativeInt,
  /** Own-slot usage lines (steps) written while the window ran, of its sessions and slots. */
  steps: NonNegativeInt,
  /** `<OWN_HOME>\diagnostics\captures`. */
  dir: Schema.String,
  /** Files the window wrote to, relative to `dir` (`<YYYY-MM-DD>/<sessionID>.jsonl`). */
  files: Schema.Array(Schema.String),
}).annotate({ identifier: "Own.Rpc.CaptureWindow" })

/** `diagnostics.capture.*` result: whether a window runs, and the current one, else the last one this process ran. */
export interface CaptureStatus extends Schema.Schema.Type<typeof CaptureStatus> {}
export const CaptureStatus = Schema.Struct({
  active: Schema.Boolean,
  window: Schema.NullOr(CaptureWindow),
}).annotate({ identifier: "Own.Rpc.CaptureStatus" })

/** Longest capture window: one day. The default is {@link CAPTURE_DEFAULT_MINUTES}. */
export const CAPTURE_MAX_MINUTES = 1_440
export const CAPTURE_DEFAULT_MINUTES = 30

// ---------------------------------------------------------------------------------------------------------------
// Account management

/** Per-model input for `compat` accounts (02 §3.3). Rates are USD per 1M tokens. */
export interface CompatModel extends Schema.Schema.Type<typeof CompatModel> {}
export const CompatModel = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  contextLimit: optional(PositiveInt),
  /** Output token cap the user knows (07 §6.2 #7); a server-reported value wins, else 32k shown as `모름`. */
  outputLimit: optional(PositiveInt),
  /** Image input (02 §3.3 `그림 입력`): absent = `auto`, what the server reports (unknown = text only). */
  image: optional(Account.CompatSetting),
  /** Tool calling (02 §3.3 `도구`): absent = `auto`, what the server reports (unknown = on). */
  tools: optional(Account.CompatSetting),
  /** Reasoning effort (02 §3.3a `추론 강도`): absent = `auto`, what the server reports (unknown = none). */
  reasoning: optional(Account.ReasoningSetting),
  cost: optional(
    Schema.Struct({
      input: NonNegative,
      output: NonNegative,
      cacheRead: optional(NonNegative),
      cacheWrite: optional(NonNegative),
    }),
  ),
}).annotate({ identifier: "Own.Rpc.CompatModel" })

/** `accounts.update{compatCapabilities}` item: one model's image input, tools and reasoning settings (02 §3.3). */
export interface CompatModelCapabilities extends Schema.Schema.Type<typeof CompatModelCapabilities> {}
export const CompatModelCapabilities = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  image: optional(Account.CompatSetting),
  tools: optional(Account.CompatSetting),
  /** 02 §3.3a: absent keeps the setting, `auto` follows the server again. */
  reasoning: optional(Account.ReasoningSetting),
}).annotate({ identifier: "Own.Rpc.CompatModelCapabilities" })

/** `accounts.add.key` input. One of the two methods that receive a secret (02 §9.1). */
export interface AddKeyInput extends Schema.Schema.Type<typeof AddKeyInput> {}
export const AddKeyInput = Schema.Struct({
  kind: Kind.Api,
  label: Schema.String.check(Schema.isMinLength(1)),
  /**
   * Secret. Stored only in the vault; the registry keeps `identity.keyHint`. Required but for a local model
   * (`options.local`, 02 §3.3a), whose server may take none.
   */
  key: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))),
  color: optional(Account.Color),
  /** `compat` requires `baseURL` and `models` (02 §3.3). */
  options: optional(
    Schema.Struct({
      baseURL: optional(Schema.String),
      organization: optional(Schema.String),
      project: optional(Schema.String),
      workspaceName: optional(Schema.String),
      models: optional(Schema.Array(CompatModel)),
      /** `compat` only: a local model (`로컬 모델`, 02 §3.3a) and its server's API format. */
      local: optional(Account.Local),
    }),
  ),
}).annotate({ identifier: "Own.Rpc.AddKeyInput" })

/** `accounts.local.detect` input (02 §3.3a `서버에서 불러오기`): a server not added yet. `key` is a secret, never stored. */
export interface LocalDetectInput extends Schema.Schema.Type<typeof LocalDetectInput> {}
export const LocalDetectInput = Schema.Struct({
  baseURL: Schema.String.check(Schema.isMinLength(1)),
  format: Account.LocalFormat,
  key: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))),
}).annotate({ identifier: "Own.Rpc.LocalDetectInput" })

/** One model a local server lists, with what it reports (absent = not reported; `reasoning: null` = none). */
export interface LocalDetectedModel extends Schema.Schema.Type<typeof LocalDetectedModel> {}
export const LocalDetectedModel = Schema.Struct({
  id: Schema.String,
  context: optional(PositiveInt),
  output: optional(PositiveInt),
  image: optional(Schema.Boolean),
  tools: optional(Schema.Boolean),
  reasoning: optional(Schema.NullOr(Account.Reasoning)),
}).annotate({ identifier: "Own.Rpc.LocalDetectedModel" })

/**
 * `accounts.local.detect` result: `ok: false` when the server's `/models` did not answer (`status` = its HTTP status,
 * when it answered one). `family` is the server software as detected.
 */
export interface LocalDetectResult extends Schema.Schema.Type<typeof LocalDetectResult> {}
export const LocalDetectResult = Schema.Struct({
  ok: Schema.Boolean,
  status: optional(Schema.Number),
  family: optional(Account.CompatFamily),
  models: Schema.Array(LocalDetectedModel),
  latencyMs: NonNegative,
}).annotate({ identifier: "Own.Rpc.LocalDetectResult" })

/**
 * `device` and `browser` are the Codex-style ChatGPT login of a `codex` account (02 §3.2); `siwc` is Sign in with
 * ChatGPT (token sharing) of a `siwc` account (02 §3.2c), browser only.
 */
export const LoginMethod = Schema.Literals(["device", "browser", "siwc"]).annotate({
  identifier: "Own.Rpc.LoginMethod",
})
export type LoginMethod = typeof LoginMethod.Type

/** `accounts.add.chatgpt.start` input. */
export interface LoginStartInput extends Schema.Schema.Type<typeof LoginStartInput> {}
export const LoginStartInput = Schema.Struct({
  method: LoginMethod,
  /** Re-login of this account instead of adding one. */
  accountID: optional(Account.ID),
  /**
   * `siwc` only: ask ChatGPT for consent again (`prompt=consent`). Sent only on the user's explicit "retry with
   * consent" after `token_sharing_not_granted`; ordinary sign-ins never force consent.
   */
  consent: optional(Schema.Boolean),
  /**
   * `siwc` only: the finished new-account attempt this start tries again ("retry with consent", "retry"). The client
   * ChatGPT issued to it is reused, so a retry never registers another one.
   */
  retryOf: optional(AttemptID),
}).annotate({ identifier: "Own.Rpc.LoginStartInput" })

/** `accounts.add.chatgpt.start` result: device code (default), browser PKCE, or Sign in with ChatGPT (02 §3.2). */
export const LoginStart = Schema.Union([
  Schema.Struct({
    attemptID: AttemptID,
    method: Schema.Literal("device"),
    verificationURL: Schema.String,
    userCode: Schema.String,
    expiresAt: EpochMillis,
  }),
  Schema.Struct({
    attemptID: AttemptID,
    method: Schema.Literal("browser"),
    authorizeURL: Schema.String,
    expiresAt: optional(EpochMillis),
  }),
  Schema.Struct({
    attemptID: AttemptID,
    method: Schema.Literal("siwc"),
    /** Opened in the system browser; its loopback listener already runs when this is returned. */
    authorizeURL: Schema.String,
    expiresAt: optional(EpochMillis),
  }),
])
  .annotate({ identifier: "Own.Rpc.LoginStart" })
  .pipe(Schema.toTaggedUnion("method"))
export type LoginStart = typeof LoginStart.Type

export const LoginPhase = Schema.Literals(["pending", "authorized", "failed", "cancelled"]).annotate({
  identifier: "Own.Rpc.LoginPhase",
})
export type LoginPhase = typeof LoginPhase.Type

/**
 * `accounts.add.chatgpt.status` result. `error: "account_mismatch"` when a re-login is a different account (C5),
 * `authorization_denied` when the user declined in the browser. Sign in with ChatGPT adds `token_sharing_not_granted`
 * (the sharing scope was not granted: offer "retry with consent"), `client_id_missing` / `client_id_invalid` (no
 * usable issued client id), `client_mismatch` (the callback returned another client than the account's),
 * `id_token_invalid`, and `jwks_unavailable` (the ID token could not be checked right now: try again) (02 §3.2c).
 */
export interface LoginStatus extends Schema.Schema.Type<typeof LoginStatus> {}
export const LoginStatus = Schema.Struct({
  phase: LoginPhase,
  identity: optional(Schema.Struct({ emailMasked: optional(Schema.String), plan: optional(Schema.String) })),
  /** New-account flow only: an account with the same fingerprint exists; `complete` re-authenticates it. */
  duplicateOf: optional(Account.ID),
  error: optional(Schema.String),
}).annotate({ identifier: "Own.Rpc.LoginStatus" })

export interface AccountResult extends Schema.Schema.Type<typeof AccountResult> {}
export const AccountResult = Schema.Struct({ account: Account.View }).annotate({ identifier: "Own.Rpc.AccountResult" })

/**
 * `accounts.update` result. `compactionImpact` comes with every call that carries `compaction` (with or without
 * `dryRun`); a `dryRun` call stores nothing and returns the account as it is (02 §4.7.5).
 */
export interface UpdateResult extends Schema.Schema.Type<typeof UpdateResult> {}
export const UpdateResult = Schema.Struct({
  account: Account.View,
  compactionImpact: optional(Compaction.Impact),
}).annotate({ identifier: "Own.Rpc.UpdateResult" })

// ---------------------------------------------------------------------------------------------------------------
// codex-multi-provider import (extension of 02 §9.2, see Credential.LinkedCodexSource / TakeoverCodexSource)

export const CodexImportWarning = Schema.Literals([
  /** Linked: the old app must keep refreshing; if it stops, requests fail until it refreshes again. */
  "linked_depends_on_source",
  /** Takeover: our first refresh rotates the token family; the old app's profile will need to log in again. */
  "takeover_supersedes_source",
  "source_token_expired",
]).annotate({ identifier: "Own.Rpc.CodexImportWarning" })
export type CodexImportWarning = typeof CodexImportWarning.Type

/** One profile found in the old app's control center. Contains no token values. */
export interface CodexCandidate extends Schema.Schema.Type<typeof CodexCandidate> {}
export const CodexCandidate = Schema.Struct({
  profileID: Schema.String,
  alias: Schema.NullOr(Schema.String),
  importable: Schema.Boolean,
  problem: optional(OwnError.SourceProblem),
  identity: optional(Schema.Struct({ emailMasked: optional(Schema.String), plan: optional(Schema.String) })),
  /** The source's `last_refresh`. */
  lastRefresh: optional(Schema.NullOr(Schema.String)),
  importedAs: optional(Schema.NullOr(Schema.Struct({ accountID: Account.ID, mode: Credential.CodexImportMode }))),
}).annotate({ identifier: "Own.Rpc.CodexCandidate" })

export interface CodexImportPlan extends Schema.Schema.Type<typeof CodexImportPlan> {}
export const CodexImportPlan = Schema.Struct({
  ...planned,
  profileID: Schema.String,
  alias: Schema.NullOr(Schema.String),
  mode: Credential.CodexImportMode,
  identity: Schema.Struct({ emailMasked: optional(Schema.String), plan: optional(Schema.String) }),
  /** Existing account with the same fingerprint; `execute` re-links or takes it over instead of adding one. */
  duplicateOf: Schema.NullOr(Account.ID),
  warnings: Schema.Array(CodexImportWarning),
}).annotate({ identifier: "Own.Rpc.CodexImportPlan" })

// ---------------------------------------------------------------------------------------------------------------
// codex-multi-provider saved API keys, linked by reference (02 §3.2b; see Credential.LinkedLegacyKey)

export const LegacyKeyImportWarning = Schema.Literals([
  /** Always: the key stays in the old app's file; deleting or changing it there changes this account too. */
  "linked_key_depends_on_source",
  /** The old app's model is not in this kind's model template; the account gets the template's models. */
  "model_not_in_template",
]).annotate({ identifier: "Own.Rpc.LegacyKeyImportWarning" })
export type LegacyKeyImportWarning = typeof LegacyKeyImportWarning.Type

/**
 * One API-key provider saved in the old app. Contains no key and no file path; `list` never decrypts anything
 * (`keySaved` only says whether the old app's key file exists).
 */
export interface LegacyKeyCandidate extends Schema.Schema.Type<typeof LegacyKeyCandidate> {}
export const LegacyKeyCandidate = Schema.Struct({
  providerRef: Credential.LegacyProviderRef,
  /** Display name in the old app, e.g. `DeepSeek`. */
  name: Schema.NullOr(Schema.String),
  /** The own kind for the provider's API, `null` when there is none (`problem: "unsupported_provider"`). */
  kind: Schema.NullOr(Kind.Api),
  /** The old app's API URL (not secret). */
  baseURL: Schema.NullOr(Schema.String),
  /** Model ids the old app used with this provider. */
  models: Schema.Array(Schema.String),
  keySaved: Schema.Boolean,
  importable: Schema.Boolean,
  problem: optional(OwnError.LegacyKeyProblem),
  importedAs: optional(Schema.NullOr(Schema.Struct({ accountID: Account.ID }))),
}).annotate({ identifier: "Own.Rpc.LegacyKeyCandidate" })

export interface LegacyKeyImportPlan extends Schema.Schema.Type<typeof LegacyKeyImportPlan> {}
export const LegacyKeyImportPlan = Schema.Struct({
  ...planned,
  providerRef: Credential.LegacyProviderRef,
  name: Schema.NullOr(Schema.String),
  kind: Kind.Api,
  /** Suggested account name, e.g. `DeepSeek (이전 앱)`. */
  label: Schema.String,
  /** The old app's API URL; `compat` accounts use it, other kinds use their own endpoint. */
  baseURL: Schema.NullOr(Schema.String),
  /** The old app's model for this provider. */
  model: Schema.NullOr(Schema.String),
  /** Last four characters of the key the file holds now, e.g. `sk-…9fQ2`. */
  keyHint: Schema.String,
  /** A live account that already uses this key (or this file); `execute` answers `duplicate_account`. */
  duplicateOf: Schema.NullOr(Account.ID),
  warnings: Schema.Array(LegacyKeyImportWarning),
}).annotate({ identifier: "Own.Rpc.LegacyKeyImportPlan" })

// ---------------------------------------------------------------------------------------------------------------
// Worktree removal guard (06 §10.4 #5, §8.6, TG13): a read-scope extension of 02 §9.2 for the own-web cleanup dialog

/** A repository or worktree inside the inspected worktree (06 TI-3 (b)). `worktree`: one `git worktree list` names. */
export interface WorktreeNested extends Schema.Schema.Type<typeof WorktreeNested> {}
export const WorktreeNested = Schema.Struct({
  /** Absolute path on the server. */
  path: Schema.String,
  kind: Schema.Literals(["worktree", "repository"]),
}).annotate({ identifier: "Own.Rpc.WorktreeNested" })

/** `worktree.inspect` result: what `git worktree remove` would take along, and whether it may run at all. */
export interface WorktreeInspection extends Schema.Schema.Type<typeof WorktreeInspection> {}
export const WorktreeInspection = Schema.Struct({
  nested: Schema.Array(WorktreeNested),
  /** `partial`: the bounded walk stopped early, so a nested repository may be missing and `ignored.bytes` is a minimum. */
  scan: Schema.Literals(["complete", "partial"]),
  /** The `locked` line of `git worktree list`; `reason` is empty for a lock without one. */
  lock: Schema.NullOr(Schema.Struct({ reason: Schema.String })),
  /** The lock is own's (reason `own.team …` or `own: …`, 06 §3.8, TI-12): only team mode removes this folder. */
  ownLock: Schema.Boolean,
  /** Ignored files the removal deletes without asking (06 TI-2). */
  ignored: Schema.Struct({
    /** The biggest entries as `git status --ignored` names them: relative, `/`-separated, a whole folder ends in `/`. */
    entries: Schema.Array(Schema.Struct({ path: Schema.String, bytes: NonNegativeInt })),
    count: NonNegativeInt,
    bytes: NonNegativeInt,
    /** `entries` holds only the biggest of `count`. */
    truncated: Schema.Boolean,
  }),
}).annotate({ identifier: "Own.Rpc.WorktreeInspection" })

/** `worktree.inspect` errors. Only this method uses them, so they live here rather than in 02 §9.4 (`OwnError`). */
const worktreeErrors = {
  ...OwnError.pick(),
  /**
   * `root` or `directory` is not in the project's worktree table, a path names another machine (UNC), or `directory`
   * is not a linked worktree that `git worktree list` reports for `root` (the main worktree is refused).
   */
  not_found: Schema.toStandardSchemaV1(Schema.Struct({ directory: Schema.String })),
  /** Git cannot open `directory` (the root, or the worktree's own checkout) as a repository. */
  not_git: Schema.toStandardSchemaV1(Schema.Struct({ directory: Schema.String })),
}

// ---------------------------------------------------------------------------------------------------------------
// Request cost estimate for own.import (09 §5.6): a read-scope extension of 02 §9.2

/** One request to price: input tokens, output tokens and the part of the input read from the cache. */
export interface EstimateRequestItem extends Schema.Schema.Type<typeof EstimateRequestItem> {}
export const EstimateRequestItem = Schema.Struct({
  prompt: NonNegativeInt,
  output: NonNegativeInt,
  /** Leading input tokens read from the cache; absent = a cold request. */
  cachedPrefix: optional(NonNegativeInt),
}).annotate({ identifier: "Own.Rpc.EstimateRequestItem" })

/**
 * `estimate.request` result (09 §5.6): the 02 §6 estimator's price of the requests on the target slot, with the slot's
 * Z, one exchange and its window, so own.import sizes a conversation without a session of its own.
 */
export interface EstimateRequestResult extends Schema.Schema.Type<typeof EstimateRequestResult> {}
export const EstimateRequestResult = Schema.Struct({
  unit: Estimate.Unit,
  /** The requests together; `null` when a needed rate is unknown (e.g. a local model). */
  delta: Schema.NullOr(Estimate.Delta),
  quota: Schema.NullOr(Estimate.QuotaImpact),
  /** Percent left (0–100) of the account's 5-hour and weekly windows (`quota_insufficient`); `null` per unknown window. */
  remaining: Schema.NullOr(Schema.Struct({ fiveHour: Schema.NullOr(NonNegative), weekly: Schema.NullOr(NonNegative) })),
  /** The slot's system and tools: the median first-step Z of its recent sessions not imported by own.import. */
  Z: NonNegative,
  /** `measured`: from those sessions; `default`: none yet, `Tracker.DEFAULTS.Z`. */
  zSource: Schema.Literals(["measured", "default"]),
  /** One exchange: the median step growth of the same sessions, else `Tracker.DEFAULTS.delta`. */
  exchange: NonNegative,
  /** The slot template's effective `limit.input || limit.context` (01 R16) and `Compaction.ceiling` of it. */
  window: Schema.NullOr(PositiveInt),
  ceiling: Schema.NullOr(PositiveInt),
}).annotate({ identifier: "Own.Rpc.EstimateRequestResult" })

// ---------------------------------------------------------------------------------------------------------------
// Workspace notes (02 §9.2 "워크스페이스 노트", 05 §8.8): the workspace `노트` tab's notes, kept by this PC's service

/** A canonical workspace key (`Notes.workspaceKey`): `local:<directory>` or `ssh:<hostId>:<directory>`. */
export const NotesWorkspace = Schema.String.check(
  Schema.makeFilter((key) => Notes.isWorkspaceKey(key) || "not a canonical workspace key"),
).annotate({ identifier: "Own.Rpc.NotesWorkspace" })

export const NoteID = Schema.String.check(Schema.isPattern(Notes.ID_PATTERN)).annotate({
  identifier: "Own.Rpc.NoteID",
})

const NoteTitle = Schema.String.check(Schema.isMaxLength(Notes.TITLE_MAX))
const NoteText = Schema.String.check(Schema.isMaxLength(Notes.TEXT_MAX))

/** One `notes.list` row. `rev` grows by one with every saved change of the title or the text. */
export interface NoteMeta extends Schema.Schema.Type<typeof NoteMeta> {}
export const NoteMeta = Schema.Struct({
  id: NoteID,
  title: NoteTitle,
  rev: PositiveInt,
  updatedAt: EpochMillis,
}).annotate({ identifier: "Own.Rpc.NoteMeta" })

export interface Note extends Schema.Schema.Type<typeof Note> {}
export const Note = Schema.Struct({ ...NoteMeta.fields, text: NoteText }).annotate({ identifier: "Own.Rpc.Note" })

// ---------------------------------------------------------------------------------------------------------------
// Idea notes (02 §9.2 "아이디어 노트", 03 §4.4.1): the global sticky notes, kept by this PC's service

export const IdeaID = Schema.String.check(Schema.isPattern(Ideas.ID_PATTERN)).annotate({
  identifier: "Own.Rpc.IdeaID",
})

export const IdeaColor = Schema.Literals(Ideas.COLORS).annotate({ identifier: "Own.Rpc.IdeaColor" })
export type IdeaColor = typeof IdeaColor.Type

/** Something to read (not only spaces and line breaks), up to `Ideas.TEXT_MAX`. */
const IdeaText = Schema.String.check(
  Schema.isMaxLength(Ideas.TEXT_MAX),
  Schema.makeFilter((text) => /\S/.test(text) || "an idea needs some text"),
)

/** One idea. `rev` grows by one with every saved change; `createdAt` orders the board (newest first). */
export interface Idea extends Schema.Schema.Type<typeof Idea> {}
export const Idea = Schema.Struct({
  id: IdeaID,
  text: IdeaText,
  color: IdeaColor,
  pinned: Schema.Boolean,
  rev: PositiveInt,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
}).annotate({ identifier: "Own.Rpc.Idea" })

/**
 * `ideas.put` input. `baseRev: 0` creates the idea and needs `text`; absent fields keep the stored value (a new idea:
 * `yellow`, not pinned). `createdAt` counts only when creating (an undone removal keeps its place on the board).
 */
export const IdeaPut = Schema.Struct({
  id: IdeaID,
  text: optional(IdeaText),
  color: optional(IdeaColor),
  pinned: optional(Schema.Boolean),
  createdAt: optional(EpochMillis),
  baseRev: NonNegativeInt,
})
  .check(Schema.makeFilter((input) => input.baseRev > 0 || input.text !== undefined || "a new idea needs text"))
  .annotate({ identifier: "Own.Rpc.IdeaPut" })

// ---------------------------------------------------------------------------------------------------------------
// Side questions (곁질문, `/btw`, 02 §9.7, 03 §4.4.2): one model call on a conversation's history, kept out of it

export const SideID = Schema.String.check(Schema.isPattern(Side.ID_PATTERN)).annotate({ identifier: "Own.Rpc.SideID" })

const SideQuestion = Schema.String.check(
  Schema.isMaxLength(Side.QUESTION_MAX),
  Schema.makeFilter((text) => /\S/.test(text) || "a side question needs some text"),
)

/** One question and its answer. `running` while the answer streams; `text` then holds what arrived so far. */
export interface SideTurn extends Schema.Schema.Type<typeof SideTurn> {}
export const SideTurn = Schema.Struct({
  question: Schema.String,
  answer: Schema.String,
  status: Schema.Literals(["running", "done", "failed", "cancelled"]),
  startedAt: EpochMillis,
  endedAt: optional(EpochMillis),
  /** `tool-calls`: the model asked for a tool and the answer stops there (a side question runs none). */
  finish: optional(Schema.Literals(["stop", "length", "tool-calls", "content-filter", "error", "other"])),
  /** Korean, for the panel. */
  error: optional(Schema.String),
  model: optional(Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: optional(Schema.String) })),
  /** The answer's usage as the provider reported it; its ledger line is `kind: "side"`. */
  tokens: optional(Ledger.Tokens),
  cost: optional(Schema.NullOr(Ledger.Cost)),
}).annotate({ identifier: "Own.Rpc.SideTurn" })

/** A side thread: the first question and its follow-ups, oldest first. */
export interface SideThread extends Schema.Schema.Type<typeof SideThread> {}
export const SideThread = Schema.Struct({
  id: SideID,
  sessionID: SessionID,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  turns: Schema.Array(SideTurn),
}).annotate({ identifier: "Own.Rpc.SideThread" })

/** A list row: the first question (cut to 200 characters) and the last turn's status. */
export interface SideSummary extends Schema.Schema.Type<typeof SideSummary> {}
export const SideSummary = Schema.Struct({
  id: SideID,
  question: Schema.String,
  turns: PositiveInt,
  status: SideTurn.fields.status,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
}).annotate({ identifier: "Own.Rpc.SideSummary" })

// ---------------------------------------------------------------------------------------------------------------
// Events (02 §9.3)

/** `global` events come from the process leader, `session` events from the session's location (02 §9.1). */
export const Origin = Schema.Literals(["global", "session"]).annotate({ identifier: "Own.Rpc.Origin" })
export type Origin = typeof Origin.Type

/** Fields every `rpc.own.accounts.*` event carries (02 §9.1). */
const envelope = { eventId: EventID, origin: Origin }

function event<const S extends Schema.ConstraintDecoder<Readonly<Record<string, unknown>>>>(schema: S) {
  return { schema: Schema.toStandardSchemaV1(schema) }
}

export const Events = {
  "accounts.changed": event(
    Schema.Struct({ ...envelope, revision: NonNegativeInt }).annotate({ identifier: "Own.Event.AccountsChanged" }),
  ),
  "quota.updated": event(
    Schema.Struct({
      ...envelope,
      accountID: Account.ID,
      windows: Schema.Array(Limit.Window),
      /**
       * The account's reset credit count when one is known (02 §7.1.1); never a window. `null`: the count is unknown
       * now (a redeem whose read after it reported none), so the one shown is forgotten until the next read.
       */
      resetCredits: optional(Schema.NullOr(Limit.ResetCredits)),
    }).annotate({ identifier: "Own.Event.QuotaUpdated" }),
  ),
  /** Also carries login progress, e.g. `phase: "awaiting_user"`; `accountID` is `null` before a new login completes. */
  "account.status": event(
    Schema.Struct({
      ...envelope,
      accountID: Schema.NullOr(Account.ID),
      attemptID: optional(AttemptID),
      status: optional(Account.Status),
      reason: optional(Schema.String),
      until: optional(EpochMillis),
      phase: optional(Schema.String),
    }).annotate({ identifier: "Own.Event.AccountStatus" }),
  ),
  "cache.state": event(
    Schema.Struct({ ...envelope, ...Cache.Snapshot.fields }).annotate({ identifier: "Own.Event.CacheState" }),
  ),
  /**
   * v0.3 (02 §4.7.4): the session reached its "compact earlier" threshold. Since v2.0.24 own.accounts admits the
   * compaction itself under `inputID` (the plugin's `session.compact`, 02 §4.7.2), with no client connected. A client
   * with the `prompt` scope may still send the same id (`POST /api/session/:id/compact {id: inputID}` after checking
   * that `GET /api/session/:id` has no `revert`), as it did for an older service; the id is admitted once and a 409 is
   * ignored. Never sent while a revert is staged.
   */
  "compaction.due": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      inputID: SessionMessage.ID,
      P: NonNegative,
      triggerTokens: PositiveInt,
      epoch: NonNegativeInt,
    }).annotate({ identifier: "Own.Event.CompactionDue" }),
  ),
  /** v0.4: `session.approval.set` wrote the rules of the parent and its unfinished children. */
  "approval.changed": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      mode: Approval.SetMode,
      patched: Schema.Array(SessionID),
    }).annotate({ identifier: "Own.Event.ApprovalChanged" }),
  ),
  "binding.changed": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      model: Model.Ref,
      previous: Schema.NullOr(Model.Ref),
      accountID: Schema.NullOr(Account.ID),
      reason: Switch.BindingReason,
      external: Schema.Boolean,
    }).annotate({ identifier: "Own.Event.BindingChanged" }),
  ),
  /** Sent on switch, and once more with `actual` after the first step ends. */
  "switch.recorded": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      from: Schema.NullOr(Model.Ref),
      to: Model.Ref,
      strategy: Estimate.Strategy,
      reason: Switch.Reason,
      estimate: Schema.NullOr(Estimate.Delta),
      actual: optional(Schema.Struct({ cold: Schema.Finite, unit: Estimate.Unit })),
    }).annotate({ identifier: "Own.Event.SwitchRecorded" }),
  ),
  "switch.scheduled": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      target: Model.Ref,
      trigger: Estimate.ScheduleTrigger,
      idleMinutes: NonNegative,
      uncertain: Schema.Boolean,
      deadline: EpochMillis,
    }).annotate({ identifier: "Own.Event.SwitchScheduled" }),
  ),
  "switch.state": event(
    Schema.Struct({ ...envelope, sessionID: SessionID, state: Switch.StateName, detail: Switch.State }).annotate({
      identifier: "Own.Event.SwitchState",
    }),
  ),
  "switch.suggested": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      reason: Switch.SuggestReason,
      candidates: Schema.Array(Estimate.Candidate),
      continue: Schema.Boolean,
    }).annotate({ identifier: "Own.Event.SwitchSuggested" }),
  ),
  "ledger.step": event(
    Schema.Struct({ ...envelope, line: Ledger.Line }).annotate({ identifier: "Own.Event.LedgerStep" }),
  ),
  alert: event(
    Schema.Struct({
      ...envelope,
      code: Alert.Code,
      severity: Alert.Severity,
      sessionID: optional(SessionID),
      accountID: optional(Account.ID),
      directory: optional(Schema.String),
      message: Schema.String,
    }).annotate({ identifier: "Own.Event.Alert" }),
  ),
  "plugin.status": event(
    Schema.Struct({
      ...envelope,
      plugin: Schema.Literal("claudeAuth"),
      phase: Plugin.ClaudeAuthPhase,
      step: optional(Schema.String),
      ok: optional(Schema.Boolean),
      error: optional(Schema.String),
    }).annotate({ identifier: "Own.Event.PluginStatus" }),
  ),
  "plugin.trust.changed": event(
    Schema.Struct({
      ...envelope,
      directory: Schema.String,
      status: Plugin.TrustStatus,
      pending: NonNegativeInt,
    }).annotate({ identifier: "Own.Event.PluginTrustChanged" }),
  ),
  /**
   * 07 §8.1: `presets.json` changed (a preset, ★, pair, default model or global setting), or the standing repair
   * notices changed while `presets.json` stayed the same (07 §4.3, `presets/repair.ts`); clients read `presets.list`
   * again. `removed`: presets deleted by this change (their sessions move to the group's ★).
   */
  "presets.changed": event(
    Schema.Struct({ ...envelope, removed: optional(Schema.Array(Preset.ID)) }).annotate({
      identifier: "Own.Event.PresetsChanged",
    }),
  ),
  /** 07 §8.1: a root session's preset binding changed (`session.preset.apply`, ultra, a ★ rebind after a removal). */
  "session.preset.changed": event(
    Schema.Struct({ ...envelope, sessionID: SessionID, binding: Preset.Binding }).annotate({
      identifier: "Own.Event.SessionPresetChanged",
    }),
  ),
  /**
   * 02 §4.8: a root session's speed changed: the user's choice (`user`), a refused tier it fell back from
   * (`fallback`), Anthropic's fast rate limit (`cooldown`), the first of a run of responses served slower than sent
   * (`downgraded`), a tier the provider kept serving slower and never honored, fallen back from (`ignored`), or a
   * cooldown that ended (`recovered`). Clients read `session.speed.get` again. `cause` (`fallback` only, 2026-10-18;
   * absent from older services): the refusal's code, the one the refused offer's `reason` then names
   * (`unsupported_tier`, `subscription_sharing_unsupported_capability`, `usage_credits`, `status_<n>`, `rejected`), so
   * the toast can say why at once.
   */
  "session.speed.changed": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      choice: Speed.Choice,
      effective: Speed.Choice,
      tier: Schema.NullOr(Schema.String),
      reason: Speed.Reason,
      cause: optional(Schema.String),
    }).annotate({ identifier: "Own.Event.SessionSpeedChanged" }),
  ),
  /**
   * 02 §9.2 notes: a note of `workspace` was saved (`rev`) or removed (`rev: null`). No title or text: open clients read
   * `notes.list` / `notes.get` again when the revision is newer than theirs.
   */
  "notes.changed": event(
    Schema.Struct({
      ...envelope,
      workspace: Schema.String,
      id: NoteID,
      rev: Schema.NullOr(PositiveInt),
    }).annotate({ identifier: "Own.Event.NotesChanged" }),
  ),
  /**
   * 02 §9.7 곁질문: more text of a running side answer. `offset` is where `text` starts in the answer, so a client that
   * missed a delta (`offset` past what it has) reads the thread again with `side.get`.
   */
  "side.delta": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      threadID: SideID,
      turn: NonNegativeInt,
      offset: NonNegativeInt,
      text: Schema.String,
    }).annotate({ identifier: "Own.Event.SideDelta" }),
  ),
  /** 02 §9.7 곁질문: a side answer ended (done, failed or cancelled); `turn` is the stored turn. */
  "side.ended": event(
    Schema.Struct({
      ...envelope,
      sessionID: SessionID,
      threadID: SideID,
      index: NonNegativeInt,
      turn: SideTurn,
    }).annotate({ identifier: "Own.Event.SideEnded" }),
  ),
  /**
   * 02 §9.2 아이디어 노트: an idea was saved (`rev`) or removed (`rev: null`). No text: open boards read `ideas.list`
   * again when the revision is not theirs.
   */
  "ideas.changed": event(
    Schema.Struct({ ...envelope, id: IdeaID, rev: Schema.NullOr(PositiveInt) }).annotate({
      identifier: "Own.Event.IdeasChanged",
    }),
  ),
  /**
   * 03 §5.1 기본 대화 폴더: the service's default conversation folder changed (`conversationFolder.set`) or was created
   * (`ensure`). Open windows and devices show the new view.
   */
  "conversationFolder.changed": event(
    Schema.Struct({ ...envelope, folder: ConversationFolder.View }).annotate({
      identifier: "Own.Event.ConversationFolderChanged",
    }),
  ),
  /** 03 §18.3 폴더 열기 시작 위치: the folder picker's start changed (`folderPicker.set`). */
  "folderPicker.changed": event(
    Schema.Struct({ ...envelope, picker: ConversationFolder.PickerView }).annotate({
      identifier: "Own.Event.FolderPickerChanged",
    }),
  ),
  /** 03 §4.3 프로젝트 순서와 고정: the projects were arranged or pinned (`projectList.set`). */
  "projectList.changed": event(
    Schema.Struct({ ...envelope, list: ProjectList.View }).annotate({ identifier: "Own.Event.ProjectListChanged" }),
  ),
  /**
   * 01 §13 에이전트가 못 여는 파일·폴더 (PP): the user's list changed (`protectedPaths.add`, `protectedPaths.remove`).
   * Open settings pages show the new view.
   */
  "protectedPaths.changed": event(
    Schema.Struct({ ...envelope, paths: ProtectedPaths.View }).annotate({
      identifier: "Own.Event.ProtectedPathsChanged",
    }),
  ),
  /**
   * 07 §4.5 (CA): what `codexModels.get` answers changed: the setting, the newest Codex release read, the version the
   * lists are asked as, or the rows own left out after a fetch.
   */
  "codexModels.changed": event(
    Schema.Struct({ ...envelope, view: CodexModels.View }).annotate({ identifier: "Own.Event.CodexModelsChanged" }),
  ),
  /**
   * 03 §18.14 (SM): the servers own added or the list's kept switches changed (`mcp.save`, `mcp.remove`, `mcp.enable`,
   * `mcp.import.apply`, a test result). No values: open settings pages read `mcp.list` again.
   */
  "mcp.changed": event(Schema.Struct({ ...envelope }).annotate({ identifier: "Own.Event.McpChanged" })),
  /**
   * 03 §19.6.1 (SG): the skill switches or scopes changed (`skillset.switch`). No ids: open pages read `skillset.view`
   * again (and the projects' skill lists change through core's `skill.updated` once each Location folds again).
   */
  "skillset.changed": event(Schema.Struct({ ...envelope }).annotate({ identifier: "Own.Event.SkillsetChanged" })),
  /**
   * 02 §8.10.12: the Claude Agent process pool changed (a process started or closed, a conversation began or stopped
   * waiting for a slot, the cap changed). The accounts page shows the count; a waiting conversation shows its line.
   */
  "claudeAgent.pool": event(
    Schema.Struct({ ...envelope, pool: ClaudeAgent.Pool }).annotate({ identifier: "Own.Event.ClaudeAgentPool" }),
  ),
  /**
   * 16 (GH): the GitHub accounts, their choices, the settings or the tool list changed (every `github.*` change, a
   * device login that finished, a token GitHub refused). No values: open pages read `github.view` again.
   */
  "github.changed": event(Schema.Struct({ ...envelope }).annotate({ identifier: "Own.Event.GitHubChanged" })),
}

// ---------------------------------------------------------------------------------------------------------------
// Definition (02 §9.2 is the only method list; `accounts.import.codex.*` and `accounts.import.keys.*` are the
// codex-multi-provider extensions, `presets.*`, `session.preset.*` and `session.ultra.set` come from 07 §8.1 and
// `worktree.inspect` from 06 §10.4 #5)

/**
 * Effect schemas plus Standard Schema `~standard`, so the definition is an `Rpc.PortableDefinition` for the promise
 * plugin and client APIs while core still decodes and encodes with the Effect schemas.
 */
function method<
  const Input extends Schema.ConstraintDecoder<unknown>,
  const Output extends Schema.ConstraintDecoder<unknown>,
  const Errors extends Rpc.ErrorMap,
>(input: Input, output: Output, errors: Errors) {
  return { input: Schema.toStandardSchemaV1(input), output: Schema.toStandardSchemaV1(output), errors }
}

export const Definition = Rpc.define({
  id: ID,
  methods: {
    // Reads
    health: method(empty, Health, OwnError.pick()),
    "accounts.list": method(
      empty,
      Schema.Struct({ revision: NonNegativeInt, accounts: Schema.Array(Account.View) }),
      OwnError.pick(),
    ),
    "quota.snapshot": method(
      Schema.Struct({ accountIDs: optional(Schema.Array(Account.ID)) }),
      Schema.Struct({
        windows: Schema.Array(Limit.Window),
        /**
         * Exhaustions in force, so a resync replaces reasons whose `account.status{ready}` it missed or that a service
         * restart forgot. Absent from services older than this field.
         */
        exhausted: optional(Schema.Array(Limit.Exhausted)),
        /** The last reset credit count of each ChatGPT account (02 §7.1.1). Absent from older services. */
        resetCredits: optional(Schema.Array(Limit.ResetCredits)),
      }),
      OwnError.pick(),
    ),
    /**
     * 02 §7.1.1 리셋권: the account's reset credits as ChatGPT lists them now (`GET <chatgpt>/wham/rate-limit-reset-credits`
     * and `wham/usage`, 10 s each), at most once per account every 2 minutes; within that the last answer comes back
     * without a request, unless a redeem was sent since (answered or not): then it reads again. The windows it read are
     * published like the poller's. Never refreshes a token.
     */
    "quota.resetCredits.list": method(
      Schema.Struct({ accountID: Account.ID }),
      Schema.Struct({ resetCredits: Limit.ResetCredits }),
      OwnError.pick(
        "account_not_found",
        "not_supported",
        "credential_not_ready",
        "limit_reset_failed",
        "remote_managed",
      ),
    ),
    "session.binding": method(
      Schema.Struct({ sessionIDs: Schema.Array(SessionID).check(Schema.isMaxLength(500)) }),
      Schema.Struct({ bindings: Schema.Array(Binding) }),
      OwnError.pick(),
    ),
    "cache.state": method(Schema.Struct(session), Cache.Snapshot, OwnError.pick()),
    "ledger.session": method(
      Schema.Struct({
        ...session,
        /** 1–1000, default 200. */
        limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))),
        cursor: optional(Schema.String),
        /** 04 §16.5: only the lines of this server (`"local"` or a `hostId`); default every server. */
        server: optional(Schema.String),
      }),
      Schema.Struct({
        steps: Schema.Array(Ledger.Line),
        totals: Schema.Struct({
          byAccount: Schema.Record(Schema.String, Ledger.Totals),
          /** 02 §9.7: the conversation's side questions alone (`kind:"side"`), already counted in `byAccount`. */
          side: optional(Ledger.Totals),
        }),
        switchCount: NonNegativeInt,
        cursor: optional(Schema.String),
      }),
      OwnError.pick(),
    ),
    "accounts.usage": method(
      Schema.Struct({
        accountID: optional(Account.ID),
        from: EpochMillis,
        to: EpochMillis,
        groupBy: Ledger.GroupBy,
      }),
      Schema.Struct({ rows: Schema.Array(Ledger.UsageRow) }),
      OwnError.pick("account_not_found"),
    ),
    "plugin.claudeAuth.status": method(empty, Plugin.ClaudeAuthStatus, OwnError.pick("remote_managed")),
    /** The Claude Agent route's state (02 §8.10). */
    "claudeAgent.status": method(empty, ClaudeAgentStatus, OwnError.pick("remote_managed")),
    /**
     * Sets a Claude Agent account up: own makes its login folder (`<OWN_HOME>\claude-agent\accounts\<id>`) with its
     * `projects` junction to the shared transcript folder, and enables upstream's `claude-agent` provider. Without `add`
     * it makes the first account only (idempotent); `add: true` adds another (phase 2). `created`: the new account.
     */
    "claudeAgent.setup": method(
      Schema.Struct({ add: optional(Schema.Boolean) }),
      Schema.Struct({ ...ClaudeAgentStatus.fields, created: optional(Account.ID) }),
      OwnError.pick("remote_managed"),
    ),
    /**
     * Opens Claude Code's own login (`claude auth login --claudeai`) in a console window on this PC with the account's
     * folder (`accountID`, else the default account's) as `CLAUDE_CONFIG_DIR`; the user signs in in the browser it
     * opens. own never sees a password or a token. `claude_account_unavailable{cli_missing}` without Claude Code,
     * `{busy}` while a window is open.
     */
    "claudeAgent.login": method(
      Schema.Struct({ accountID: optional(Account.ID) }),
      ClaudeAgentStatus,
      OwnError.pick("account_not_found", "claude_account_unavailable", "remote_managed"),
    ),
    /**
     * Removes a Claude Agent account (`accountID`, else the default one); the conversations bound to it move to the
     * default account (with none left the provider turns off). `deleteFolder` also deletes the login folder own made
     * (Claude Code's login there is gone then; the shared transcripts stay).
     */
    "claudeAgent.remove": method(
      Schema.Struct({ accountID: optional(Account.ID), deleteFolder: Schema.Boolean }),
      Schema.Struct({ folderDeleted: Schema.Boolean, movedSessions: Schema.Array(SessionID) }),
      OwnError.pick("account_not_found", "remote_managed"),
    ),
    /**
     * Asks Claude Code for an account's plan windows (5 hours, weekly, per model, extra usage; P-039): a running claude
     * of the account answers, else a short one that sends no prompt, so an idle account's are read too. `accountID`,
     * else the default account. The windows also arrive as `quota.updated`.
     */
    "claudeAgent.limits.refresh": method(
      Schema.Struct({ accountID: optional(Account.ID) }),
      Schema.Struct({ windows: Schema.Array(Limit.Window), plan: Schema.NullOr(Schema.String) }),
      OwnError.pick("account_not_found", "claude_account_unavailable", "remote_managed"),
    ),
    /** The Claude Agent account a conversation's tree runs on (its root's or team's binding, else the default). */
    "claudeAgent.session.get": method(
      Schema.Struct(session),
      Schema.Struct({ accountID: Schema.NullOr(Account.ID), bound: Schema.Boolean }),
      OwnError.pick(),
    ),
    /**
     * Moves a conversation's whole tree (its subagents, and its team when it has one) to another Claude Agent account by
     * hand (CAG-D3: never on its own); each session changes at its next turn, and the same Claude conversation goes on
     * in the shared transcript folder. New conversations start on the account chosen last.
     */
    "claudeAgent.session.set": method(
      Schema.Struct({ ...session, accountID: Account.ID }),
      Schema.Struct({ accountID: Account.ID, sessions: Schema.Array(SessionID) }),
      OwnError.pick("account_not_found", "remote_managed"),
    ),
    /**
     * The cap on live claude processes of this service (`processes`, 1–64, default 8) and the spare processes kept per
     * account for new conversations (`spares`, 0–2, default 0) (02 §8.10.12). Answers the pool with the new cap.
     */
    "claudeAgent.pool.set": method(
      Schema.Struct({ processes: optional(ClaudeAgent.Processes), spares: optional(ClaudeAgent.Spares) }),
      ClaudeAgent.Pool,
      OwnError.pick("remote_managed"),
    ),
    /** The Claude Agent account new conversations start on. */
    "claudeAgent.default.set": method(
      Schema.Struct({ accountID: Account.ID }),
      Schema.Struct({ accountID: Account.ID }),
      OwnError.pick("account_not_found", "remote_managed"),
    ),
    /** Every Claude login folder of this PC with the route it belongs to (02 §8.10 폴더 나누기). */
    "claudeAgent.folders.list": method(
      empty,
      Schema.Struct({ folders: Schema.Array(ClaudeFolder) }),
      OwnError.pick("remote_managed"),
    ),
    /**
     * Gives an account's folder to the other route (one route per folder): claude-auth's own-made folder becomes a
     * Claude Agent account, or a Claude Agent folder a claude-auth account. The folder moves under the route's own
     * root, its conversations move to the route's default account, and the login inside stays.
     */
    "claudeAgent.folders.assign": method(
      Schema.Struct({ accountID: Account.ID, route: Schema.Literals(["claude-auth", "claude-agent"]) }),
      Schema.Struct({
        accountID: Account.ID,
        route: Schema.Literals(["claude-auth", "claude-agent"]),
        folder: Schema.String,
      }),
      OwnError.pick("account_not_found", "claude_account_unavailable", "session_busy", "remote_managed"),
    ),
    "cache.setTtlMode": method(
      Schema.Struct({ ...session, providerID: Provider.ID, mode: Cache.TtlMode }),
      Schema.Struct({ mode: Cache.TtlMode }),
      OwnError.pick("unsupported_strategy"),
    ),

    // Estimate and switch
    /**
     * 09 §5.6: the cost of requests on a slot that no session runs on yet (own.import's `migrate.plan`, over loopback).
     * Reads only: no PLANNED state, no secret prefetch.
     */
    "estimate.request": method(
      Schema.Struct({
        target: Model.Ref,
        requests: Schema.Array(EstimateRequestItem).check(Schema.isMaxLength(64)),
        /**
         * The account of `target` to price on (own.import's picked account, 09 §4.5): one of the Claude accounts for
         * `anthropic`, which they all serve. Absent, or not an account of that provider: the provider's own account.
         */
        accountID: optional(Account.ID),
      }),
      EstimateRequestResult,
      OwnError.pick("account_not_found", "slot_misconfigured"),
    ),
    "switch.estimate": method(
      Schema.Struct({
        ...session,
        target: Model.Ref,
        /**
         * SL-8: the Claude account the target would run on (several share `anthropic`, each with its own cache); omitted
         * = the account the session's tree runs on. Ignored for every other provider (one account each).
         */
        accountID: optional(Account.ID),
        reason: optional(Switch.Reason),
        /** 07 §5.5: own.team's team account operation; only it may move a team's subscription account. */
        teamOp: optional(Switch.TeamOp),
        /** 07 §5.5: what to do with subagents running on the old subscription (`busyChildren`). */
        children: optional(Switch.Children),
      }),
      Estimate.Result,
      OwnError.pick(
        "account_not_found",
        "slot_misconfigured",
        "no_eligible_target",
        "vault_unavailable",
        "team_switch_required",
      ),
    ),
    "switch.apply": method(
      Schema.Struct({
        ...session,
        estimateID: optional(EstimateID),
        target: Model.Ref,
        strategy: Estimate.Strategy,
        reason: Switch.Reason,
        /** `new-session`: the session created by the front end (DELEGATED). */
        childSessionID: optional(SessionID),
        /** 07 §5.5: own.team's team account operation; only it may move a team's subscription account. */
        teamOp: optional(Switch.TeamOp),
        /**
         * 07 §5.5: subagents running on the old subscription: `after-idle` (default) waits in WAIT_SAFE until they
         * finish, `stop` interrupts them first.
         */
        children: optional(Switch.Children),
      }),
      Switch.ApplyResult,
      OwnError.pick(
        "account_not_found",
        "slot_misconfigured",
        "session_busy",
        "estimate_expired",
        "needs_reauth",
        "unsupported_strategy",
        "vault_unavailable",
        // v0.4: `compact-then-switch`/`switch-then-compact` while a revert is staged (02 §4.7.4).
        "revert_staged",
        "team_switch_required",
      ),
    ),
    "switch.schedule": method(
      Schema.Struct({
        ...session,
        target: Model.Ref,
        trigger: Estimate.ScheduleTrigger,
        /** Default: source TTL_hi, else `unknownTtlIdleMinutes` with `uncertain: true`. */
        idleMinutes: optional(NonNegative),
        /** Default `max(30, 2 × idleMinutes)`; shorter than `idleMinutes` is `invalid_schedule`. */
        deadlineMinutes: optional(NonNegative),
      }),
      Switch.ScheduleResult,
      // 07 §5.5: a team's subscription account moves only through own.team's team account operation, never by
      // a scheduled switch.
      OwnError.pick("account_not_found", "slot_misconfigured", "invalid_schedule", "team_switch_required"),
    ),
    "switch.cancel": method(
      Schema.Struct(session),
      Schema.Struct({ state: Schema.Literal("STEADY") }),
      OwnError.pick(),
    ),
    "switch.undo": method(
      Schema.Struct(session),
      Schema.Struct({ state: Schema.Literal("STEADY") }),
      OwnError.pick("undo_window_closed"),
    ),
    "switch.state": method(Schema.Struct(session), Switch.State, OwnError.pick()),
    "switch.waitReset": method(
      Schema.Struct({ ...session, message: optional(Schema.String) }),
      Schema.Struct({ state: Schema.Literal("BLOCKED"), resumeAt: EpochMillis }),
      OwnError.pick(),
    ),
    "switch.setConfirmOverride": method(
      Schema.Struct({ ...session, silentBelowTokens: Schema.NullOr(NonNegativeInt) }),
      Schema.Struct({ silentBelowTokens: Schema.NullOr(NonNegativeInt) }),
      OwnError.pick(),
    ),
    /**
     * v0.3 (02 §4.7.4): the session's "compact earlier" threshold, `null` = follow the account/model. Accepted range
     * `[floorTokens, slotTriggerTokens)` of `cache.state.compaction`. `compaction` is `null` for an unpinned session.
     */
    "compaction.setSession": method(
      Schema.Struct({ ...session, triggerTokens: Schema.NullOr(Schema.Int) }),
      Schema.Struct({ compaction: Schema.NullOr(Compaction.View) }),
      OwnError.pick("setting_out_of_range"),
    ),
    /**
     * CC-14 (02 §4.7.7): a client shows the session on a visible screen the user touched within the last minute; sent
     * once a minute while that lasts (CC-16: no client window of its own). With `policy.awayDetect` on, idle compaction
     * waits until no client has said so for `hiddenMinutes`, and drops an admitted one that delivers after a report. A
     * read: it changes nothing but that wait.
     */
    "session.presence": method(Schema.Struct(session), empty, OwnError.pick()),

    // Approval mode (v0.4, 03 §18.8)
    "session.approval.get": method(Schema.Struct(session), Approval.State, OwnError.pick()),
    "session.approval.set": method(
      // v0.5 `browserTool` (03 §18.15 rule 3) and `computerUse` (01 §10.2): the same read-merge-write, for the session
      // and its unfinished children.
      Schema.Struct({
        ...session,
        mode: Approval.SetMode,
        browserTool: optional(Approval.BrowserTool),
        computerUse: optional(Approval.ComputerUse),
        // 내 브라우저 사용 (BRW): the session rule `{browse_*, *, allow}`, for the session and its unfinished children.
        browse: optional(Approval.Browse),
      }),
      Approval.SetResult,
      OwnError.pick(),
    ),

    // Web search service (03 §18.2): the server-wide choice in own's global config, not a session rule.
    "websearch.get": method(empty, Approval.WebSearchState, OwnError.pick("websearch_unavailable")),
    /**
     * Writes core's `websearch` key, or removes it for `default`; core's config watcher applies it to every session
     * (the KV answer is overridden).
     */
    "websearch.set": method(
      Approval.WebSearchSetInput,
      Approval.WebSearchState,
      OwnError.pick("websearch_unavailable"),
    ),

    // Account management
    "accounts.add.key": method(
      AddKeyInput,
      Schema.Struct({
        account: Account.Brief,
        test: Schema.Struct({ ok: Schema.Boolean, detected: optional(Account.Detected) }),
        sameDomainCandidates: Schema.Array(Account.ID),
      }),
      OwnError.pick("probe_failed", "duplicate_account", "template_unavailable", "vault_unavailable", "remote_managed"),
    ),
    /**
     * 02 §3.3a: reads a local model server before it is added (`서버에서 불러오기`): its models with their windows, output
     * caps, image input, tools and reasoning as the server reports them. Sends `key` only to `baseURL`, stores nothing.
     */
    "accounts.local.detect": method(LocalDetectInput, LocalDetectResult, OwnError.pick("remote_managed")),
    "accounts.add.chatgpt.start": method(
      LoginStartInput,
      LoginStart,
      OwnError.pick("account_not_found", "remote_managed"),
    ),
    "accounts.add.chatgpt.status": method(
      Schema.Struct({ attemptID: AttemptID }),
      LoginStatus,
      OwnError.pick("remote_managed"),
    ),
    "accounts.add.chatgpt.complete": method(
      Schema.Struct({ attemptID: AttemptID, label: optional(Schema.String), color: optional(Account.Color) }),
      Schema.Struct({ account: Account.View, reauthenticated: Schema.Boolean }),
      OwnError.pick("account_not_found", "template_unavailable", "vault_unavailable", "remote_managed"),
    ),
    "accounts.add.chatgpt.cancel": method(
      Schema.Struct({ attemptID: AttemptID }),
      empty,
      OwnError.pick("remote_managed"),
    ),
    "accounts.import.codex.list": method(
      empty,
      Schema.Struct({ available: Schema.Boolean, sources: Schema.Array(CodexCandidate) }),
      OwnError.pick("remote_managed"),
    ),
    "accounts.import.codex.plan": method(
      Schema.Struct({
        /** A plain profile directory name; the server builds the `auth.json` path from it, so no separators. */
        profileID: Credential.CodexSource.fields.profileID,
        /** Default `linked`. */
        mode: Credential.CodexImportMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("linked" as const))),
        /** Re-link or take over this existing account instead of detecting it by fingerprint. */
        accountID: optional(Account.ID),
      }),
      CodexImportPlan,
      OwnError.pick("source_not_found", "source_invalid", "account_not_found", "remote_managed"),
    ),
    "accounts.import.codex.execute": method(
      Schema.Struct({ nonce: Nonce, label: optional(Schema.String), color: optional(Account.Color) }),
      Schema.Struct({
        account: Account.View,
        mode: Credential.CodexImportMode,
        reauthenticated: Schema.Boolean,
      }),
      // `account_not_found`: the planned re-link/takeover target was removed before execute.
      OwnError.pick(
        "nonce_invalid",
        "account_not_found",
        "source_not_found",
        "source_invalid",
        "template_unavailable",
        "vault_unavailable",
        "remote_managed",
      ),
    ),
    "accounts.import.keys.list": method(
      empty,
      Schema.Struct({ available: Schema.Boolean, keys: Schema.Array(LegacyKeyCandidate) }),
      OwnError.pick("remote_managed"),
    ),
    "accounts.import.keys.plan": method(
      Schema.Struct({
        /** The old app's credential ref; the server builds the key file path from it. */
        providerRef: Credential.LegacyProviderRef,
      }),
      LegacyKeyImportPlan,
      OwnError.pick("legacy_key_not_found", "legacy_key_invalid", "vault_unavailable", "remote_managed"),
    ),
    "accounts.import.keys.execute": method(
      Schema.Struct({
        nonce: Nonce,
        label: optional(Schema.String),
        color: optional(Account.Color),
        /**
         * Re-read and decrypt the key and check duplicates, but send no probe and create nothing; the nonce stays
         * valid for the real call.
         */
        dryRun: optional(Schema.Boolean),
      }),
      Schema.Struct({
        /** `null` for a `dryRun`. */
        account: Schema.NullOr(Account.View),
        dryRun: Schema.Boolean,
        keyHint: Schema.String,
        /** The kind's connection test (02 §3.3); `skipped` for a `dryRun`. */
        test: Schema.Struct({ ok: Schema.Boolean, skipped: Schema.Boolean, detected: optional(Account.Detected) }),
      }),
      OwnError.pick(
        "nonce_invalid",
        "legacy_key_not_found",
        "legacy_key_invalid",
        "probe_failed",
        "duplicate_account",
        "template_unavailable",
        "vault_unavailable",
        "remote_managed",
      ),
    ),
    "accounts.test": method(
      Schema.Struct({ accountID: Account.ID }),
      Schema.Struct({
        ok: Schema.Boolean,
        status: optional(Account.Status),
        detected: optional(Account.Detected),
        latencyMs: NonNegative,
      }),
      OwnError.pick("account_not_found", "needs_reauth", "probe_failed", "vault_unavailable", "remote_managed"),
    ),
    "accounts.update": method(
      Schema.Struct({
        accountID: Account.ID,
        label: optional(Schema.String),
        shortLabel: optional(Schema.String),
        color: optional(Account.Color),
        autoSwitch: optional(Schema.Boolean),
        budget: optional(Schema.NullOr(Account.Budget)),
        /** Secret. API key accounts only. */
        replaceKey: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))),
        /** Re-captures the kind's template for every slot of the kind (02 §2.4.2). */
        refreshCatalog: optional(Schema.Boolean),
        enabled: optional(Schema.Boolean),
        /** `ds`, `or`, `xai` only; other kinds get `policy_denied{field:"pollBalance"}`. */
        pollBalance: optional(Schema.Boolean),
        /** v0.3: account auto-compaction setting; `null` = back to the kind default (02 §4.7.3). */
        compaction: optional(Schema.NullOr(Compaction.SettingInput)),
        /** With `compaction` only: return `compactionImpact` and store nothing (02 §4.7.5). */
        dryRun: optional(Schema.Boolean),
        /** 04 §8.9: lease this account's credential to SSH hosts (`allow`, the default) or not (`deny`). */
        remote: optional(Account.RemoteAccess),
        /**
         * `compat` only (02 §3.3): image input and tools per model id; an absent field keeps its setting, `auto` follows
         * the server again. Other kinds, and a model id the account does not have, get `policy_denied`.
         */
        compatCapabilities: optional(Schema.Array(CompatModelCapabilities)),
        /**
         * `compat` only (02 §3.3a): make the account a local model with this API format (`로컬 모델로 바꾸기`) or change
         * its format; `null` makes it `기타 OpenAI 호환` again. The key, models and settings stay.
         */
        local: optional(Schema.NullOr(Account.Local)),
      }),
      UpdateResult,
      // `probe_failed`: the `replaceKey` connection test rejected the new key (02 §3.3).
      OwnError.pick(
        "account_not_found",
        "policy_denied",
        "probe_failed",
        "template_unavailable",
        "vault_unavailable",
        "setting_out_of_range",
        "remote_managed",
      ),
    ),
    "accounts.remove.plan": method(
      Schema.Struct({ accountID: Account.ID, mode: Schema.Literals(["disable", "delete"]) }),
      Schema.Struct({
        ...planned,
        affectedSessions: Schema.Array(SessionID),
        /** Always `false` for a linked codex source: the source file is never touched. */
        willShredVault: Schema.Boolean,
      }),
      OwnError.pick("account_not_found", "policy_denied", "remote_managed"),
    ),
    /**
     * 02 §7.1.1 리셋권, step 1 of 2 (01 §13): what the confirmation names (the account, the credit, the windows now) and
     * a single-use nonce (10 min). The plan fixes the `redeem_request_id` every execute of this nonce sends. Sends no
     * request. Called only after the user asked for it in the UI; nothing in own redeems by itself.
     */
    "quota.resetCredits.redeem.plan": method(
      Schema.Struct({
        accountID: Account.ID,
        /** A credit of the list; absent: ChatGPT picks one. */
        creditID: optional(Schema.String.check(Schema.isMinLength(1))),
      }),
      Schema.Struct({
        ...planned,
        account: Schema.Struct({ id: Account.ID, label: Schema.String }),
        /** What the list said of the picked credit; absent without `creditID` or when the list did not name it. */
        credit: optional(
          Schema.Struct({ id: Schema.String, title: optional(Schema.String), expiresAt: optional(EpochMillis) }),
        ),
        windows: Schema.Array(Limit.Window),
      }),
      OwnError.pick("account_not_found", "not_supported", "credential_not_ready", "remote_managed"),
    ),
    /**
     * 02 §7.1.1, step 2: `POST <chatgpt>/wham/rate-limit-reset-credits/consume` with the plan's `redeem_request_id`. Any
     * of the four answers uses the nonce up; no answer (`limit_reset_failed`) keeps it, and a retry sends the same id
     * (ChatGPT redeems one id once). After `reset` or `already_redeemed` the windows and the count are read again and
     * the account's exhaustion ends; a read that fails or names no count leaves the count unknown (as Codex).
     */
    "quota.resetCredits.redeem.execute": method(
      execute,
      Schema.Struct({
        outcome: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
        windowsReset: optional(NonNegativeInt),
        /** The count the read after a `reset` or `already_redeemed` saw; absent there, the count is unknown now. */
        resetCredits: optional(Limit.ResetCredits),
        windows: optional(Schema.Array(Limit.Window)),
      }),
      OwnError.pick(
        "nonce_invalid",
        "account_not_found",
        "not_supported",
        "credential_not_ready",
        "limit_reset_failed",
        "remote_managed",
      ),
    ),
    // `account_not_found`: the account was removed by another client between plan and execute.
    "accounts.remove.execute": method(
      execute,
      AccountResult,
      OwnError.pick("nonce_invalid", "account_not_found", "vault_unavailable", "remote_managed"),
    ),

    // Policy and rate cards
    "policy.get": method(
      empty,
      Schema.Struct({
        policy: Policy.File,
        /** The code constants of 02 §4.7.3 (output only), for "reset to the kind default" and source labels. */
        compactionDefaults: Schema.Record(Schema.String, Compaction.Setting),
      }),
      OwnError.pick(),
    ),
    "policy.set": method(
      Schema.Struct({
        patch: Policy.Patch,
        /** With `patch.compaction.byKind` only: return `compactionImpact` and store nothing (02 §4.7.5). */
        dryRun: optional(Schema.Boolean),
      }),
      Schema.Struct({ policy: Policy.File, compactionImpact: optional(Compaction.Impact) }),
      OwnError.pick("policy_denied", "setting_out_of_range", "remote_managed"),
    ),
    "ratecards.get": method(empty, Ratecard.File, OwnError.pick()),

    // Presets (07 §8.1): stored per provider group (U4), global methods at the control location.
    "presets.list": method(
      Schema.Struct({ group: optional(Preset.Group) }),
      /**
       * Groups with a live account and groups `presets.json` names. An `auto` default not written yet is computed for
       * the answer; only the service writes it (07 §2.2), so this `read` method never changes the file. The global
       * settings come with T1 (absent from older services: `star`, no recent presets, `recommended`). `repairs` (T2,
       * 07 §4.3): one notice per gone model across every group, with its uses and suggestions; absent = none.
       */
      Schema.Struct({
        groups: Schema.Array(Preset.GroupView),
        newSession: optional(Preset.NewSession),
        recent: optional(Schema.Array(Preset.ID)),
        ultraCaps: optional(Preset.UltraCaps),
        repairs: optional(Schema.Array(Preset.Repair)),
      }),
      OwnError.pick(),
    ),
    /** 07 §3.4: a draft with suggestions from the live catalog (never a paid target) and the starters' state. */
    "presets.suggest": method(
      Schema.Struct({ group: Preset.Group, template: optional(Preset.Starter) }),
      Preset.Suggestion,
      OwnError.pick("remote_managed"),
    ),
    /**
     * 07 §8.1: store a preset (new without `id`; `revision` + 1). R4 is judged without a team (`main: null`); a breach
     * stores nothing. `dryRun` returns the resolution and the warnings only. `repairOf` (T2, 07 §4.3 `[고치기]`): the
     * save fixes a gone model, and the group's repair history records it.
     */
    "presets.set": method(
      Schema.Struct({
        preset: Preset.Save,
        dryRun: optional(Schema.Boolean),
        repairOf: optional(Preset.RepairOf),
        /** T4: freeze every model pool card again from the catalog now (`카드 새로 고치기`, 07 §7.2). */
        refreshCards: optional(Schema.Boolean),
      }),
      Schema.Struct({
        preset: Preset.Info,
        /** For the group's new-session default model on its first live account; `null` without one. */
        resolution: Schema.NullOr(Preset.Resolution),
        warnings: Schema.Array(Preset.Warning),
        dryRun: Schema.Boolean,
      }),
      OwnError.pick(
        "same_company_subscription",
        "preset_not_found",
        "preset_wrong_group",
        "preset_target_unavailable",
        "preset_builtin_locked",
        "remote_managed",
      ),
    ),
    /** 07 §5.3: sessions on the removed preset move to the group's ★ (a removed ★ falls back to `평소대로`). */
    "presets.remove": method(
      Schema.Struct({ presetID: Preset.ID }),
      Schema.Struct({ presetID: Preset.ID, group: Preset.Group, star: Preset.ID }),
      OwnError.pick("preset_not_found", "preset_builtin_locked", "remote_managed"),
    ),
    "presets.defaults.set": method(
      Schema.Struct({
        group: Preset.Group,
        /** A model becomes the group's `user` default; `null` returns the group to `auto`, decided again now. */
        defaultModel: optional(Schema.NullOr(Preset.Choice)),
        /** The group's ★; its `평소대로` id clears it. */
        star: optional(Preset.ID),
        /** The user's lighter pair for one main model (`source: "user"`, 07 §4.2). */
        lighter: optional(Schema.Struct({ mainModelID: Model.ID, model: Model.ID })),
        /** Global: the preset a new session starts with (07 §5.1). */
        newSession: optional(Preset.NewSession),
        /** Global: the ultra level, or the user's own three numbers (07 §2.6). */
        ultraCaps: optional(Preset.UltraCaps),
      }),
      Preset.GroupView,
      OwnError.pick("remote_managed"),
    ),

    // Session presets (07 §5.1–§5.4, §2.9): methods of a root session, at the session's location.
    /** T2 (07 §4.3): `main` says the session's main model or effort level is gone, with the switch to offer. */
    "session.preset.get": method(Schema.Struct(session), Preset.SessionView, OwnError.pick()),
    /**
     * 07 §5.3: bind the root to a preset of its main's group, on the session's serial runner, returning after the
     * `own.preset` entry is written. `team` (own.team only): omitted keeps the stored team, `null` clears it. Never
     * changes the main, so there is no estimate. `dryRun`: the resolution and what the entry would do.
     */
    "session.preset.apply": method(
      Schema.Struct({
        ...session,
        presetID: Preset.ID,
        team: optional(Schema.NullOr(Preset.Team)),
        dryRun: optional(Schema.Boolean),
      }),
      Schema.Struct({
        binding: Preset.Binding,
        resolution: Schema.NullOr(Preset.Resolution),
        /** What happened (with `dryRun`, would happen) to the `own.preset` instruction entry (07 §3.3). */
        entry: Schema.Literals(["unchanged", "written", "removed"]),
        dryRun: Schema.Boolean,
      }),
      OwnError.pick("preset_not_found", "preset_wrong_group", "same_company_subscription", "preset_target_unavailable"),
    ),
    /**
     * 07 §2.9: turn ultra on or off for this session. When the main's effort changes it is a 02 variant switch:
     * `estimate` is its cost (with `dryRun` nothing changes), and without `dryRun` the switch is applied (`switch`).
     */
    "session.ultra.set": method(
      Schema.Struct({
        ...session,
        on: Schema.Boolean,
        /** Claude only: also raise the effort to `xhigh` (07 §2.9). */
        raiseClaude: optional(Schema.Boolean),
        dryRun: optional(Schema.Boolean),
      }),
      Schema.Struct({
        on: Schema.Boolean,
        /** The main's variant before and after; equal when ultra leaves the effort as it is. */
        variant: Schema.Struct({ from: Schema.NullOr(Model.VariantID), to: Schema.NullOr(Model.VariantID) }),
        estimate: Schema.NullOr(Estimate.Result),
        switch: optional(Switch.ApplyResult),
        dryRun: Schema.Boolean,
      }),
      OwnError.pick(
        "account_not_found",
        "slot_misconfigured",
        "no_eligible_target",
        "session_busy",
        "needs_reauth",
        "vault_unavailable",
      ),
    ),
    /**
     * 07 §2.6: raise the per-message cap for the current user message only (the chip's `이번 메시지만 늘리기`);
     * without `perMessage`, to what the message asked for. `effort` (07 §2.3, the effort chip's `이번 메시지만 허용`):
     * instead lift the per-call effort ceiling of free targets to `max` for the current user message (a paid target is
     * never raised); the per-message cap is left as it is and answered (`effort: true`).
     */
    "session.preset.raiseOnce": method(
      Schema.Struct({ ...session, perMessage: optional(PositiveInt), effort: optional(Schema.Boolean) }),
      Schema.Struct({ perMessage: PositiveInt, effort: optional(Schema.Boolean) }),
      OwnError.pick(),
    ),
    /**
     * 07 §5.4 step 4 (spec addition): the user's answer, for this conversation, to a role moving onto a paid account
     * (`[이 대화에서만] [아니오]`). Allowing an account whose budget is used up is `preset_budget_exhausted`.
     */
    "session.preset.consent": method(
      Schema.Struct({ ...session, accountID: Account.ID, allow: Schema.Boolean }),
      Schema.Struct({ accountID: Account.ID, allow: Schema.Boolean }),
      OwnError.pick("account_not_found", "preset_budget_exhausted"),
    ),

    // Session speed (02 §4.8): a root session's `속도`, never stored in a preset and Standard in a new conversation.
    /** The session's speed as its next request would send it; a child shows what it inherits from its root. */
    "session.speed.get": method(Schema.Struct(session), Speed.View, OwnError.pick()),
    /**
     * What a main offers before any session runs on it (2026-10-10): the new-conversation composer and the switcher's
     * speed row read it for the target on screen, again on every account or model change.
     */
    "speed.offers": method(
      Schema.Struct({ providerID: Provider.ID, modelID: Model.ID }),
      Speed.Targeted,
      OwnError.pick(),
    ),
    /**
     * Sets the root's speed (a child's call sets its root's). `dryRun`: the view after the change and its cost
     * (`change`, a speed-only estimate: same prompt bytes, the cache and the price change), nothing stored.
     * `consent`: the user accepted that Fast on the Claude subscription slot bills usage credits (stored once).
     */
    "session.speed.set": method(
      Schema.Struct({
        ...session,
        speed: Speed.Choice,
        dryRun: optional(Schema.Boolean),
        consent: optional(Schema.Boolean),
      }),
      Schema.Struct({ view: Speed.View, change: Schema.NullOr(Speed.Change), dryRun: Schema.Boolean }),
      OwnError.pick("speed_unavailable", "speed_consent_required"),
    ),
    "ratecards.set": method(
      Schema.Struct({ cards: Schema.Array(Ratecard.Card) }),
      Ratecard.File,
      OwnError.pick("remote_managed"),
    ),

    // Claude subscription slot. The plugin ships with the app and is always on (02 §8.2, 2026-10-18): `ack` answers
    // and stores nothing (there is no consent), and install, uninstall and patch remain for older clients only and
    // refuse with `internal_error` "built_in".
    "plugin.claudeAuth.ack": method(
      /** Fields of the former consent; ignored. */
      Schema.Struct({
        version: Schema.String,
        integrity: Schema.String,
        noticeHash: Schema.String,
        patchSha256: optional(Schema.String),
      }),
      Schema.Struct({ acknowledgedAt: IsoDateTime }),
      OwnError.pick("ack_required", "remote_managed"),
    ),
    "plugin.claudeAuth.install.plan": method(
      empty,
      Schema.Struct({
        ...planned,
        version: Schema.String,
        target: Schema.String,
        configDiff: Schema.String,
        integrity: Schema.String,
      }),
      OwnError.pick("ack_required", "remote_managed"),
    ),
    "plugin.claudeAuth.install.execute": method(
      execute,
      Plugin.JobResult,
      OwnError.pick("nonce_invalid", "ack_required", "remote_managed"),
    ),
    "plugin.claudeAuth.uninstall.plan": method(
      empty,
      Schema.Struct({
        ...planned,
        affectedSessions: Schema.Array(SessionID),
        credential: Schema.Struct({ exists: Schema.Boolean, label: optional(Schema.String) }),
        configDiff: Schema.String,
      }),
      OwnError.pick("plugin_not_installed", "remote_managed"),
    ),
    "plugin.claudeAuth.uninstall.execute": method(
      Schema.Struct({
        nonce: Nonce,
        /** Default `true`: delete the `anthropic` OAuth credential. */
        deleteCredential: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
      }),
      Plugin.JobResult,
      OwnError.pick("nonce_invalid", "plugin_not_installed", "remote_managed"),
    ),
    /**
     * While account 1 is on an own login folder (`claudeSlot.configDir`, 02 §8.7 CS) plan and execute refuse with
     * `claude_account_unavailable{own_login}`; `leaveOwnLogin: true` says to leave it for this source (read only).
     */
    "plugin.claudeAuth.changeSource.plan": method(
      /**
       * `null` = back to the default `%USERPROFILE%\.claude`; a relative path, or one of own's login folders
       * (`<OWN_HOME>\claude-accounts\…`, by path or realpath: a source is Claude Code's and turns read only), is
       * `setting_out_of_range` (v0.4, CS), with or without `leaveOwnLogin`.
       */
      Schema.Struct({
        configDir: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
        leaveOwnLogin: optional(Schema.Boolean),
      }),
      Schema.Struct({
        ...planned,
        runningSessions: Schema.Array(SessionID),
        credentialsFound: Schema.Boolean,
        restartRequired: Schema.Literal(true),
      }),
      OwnError.pick("plugin_not_installed", "setting_out_of_range", "claude_account_unavailable", "remote_managed"),
    ),
    "plugin.claudeAuth.changeSource.execute": method(
      execute,
      Schema.Struct({ clientAction: Switch.RestartService }),
      OwnError.pick(
        "nonce_invalid",
        "session_busy",
        "plugin_not_installed",
        "claude_account_unavailable",
        "remote_managed",
      ),
    ),
    "plugin.claudeAuth.importSubscription": method(
      empty,
      Schema.Struct({ ok: Schema.Boolean, connection: Schema.NullOr(Account.Connection) }),
      OwnError.pick("ack_required", "plugin_not_installed", "remote_managed"),
    ),
    /**
     * 04 §8.11.12: the consent to use the slot from SSH remote hosts (KV `ack:claudeRemote`), naming the bundled pin
     * (`status.bundle`) and the remote notice's hash (`status.remote.noticeHash`); another pin or hash is
     * `ack_required{stale}`.
     */
    "plugin.claudeAuth.remote.ack": method(
      Schema.Struct({ version: Schema.String, integrity: Schema.String, noticeHash: Schema.String }),
      Schema.Struct({ acknowledgedAt: IsoDateTime }),
      OwnError.pick("ack_required", "remote_managed"),
    ),
    /**
     * 04 §8.11.12: switches one SSH host on or off (`accounts.json` `claudeSlot.remoteHosts`). Switching on needs a valid
     * remote consent (`ack_required{remote}`); switching off always works and stops the host's relayed requests.
     */
    "plugin.claudeAuth.remote.set": method(
      Schema.Struct({ hostId: Schema.String.check(Schema.isPattern(/^h-[a-z0-9]{6,8}$/)), enabled: Schema.Boolean }),
      Plugin.ClaudeRemoteHost,
      OwnError.pick("ack_required", "plugin_not_installed", "remote_managed"),
    ),
    /**
     * 04 §8.11.9: records on this PC that Fast on the Claude subscription slot bills usage credits (KV `ack:claudeFast`),
     * for a remote session whose `session.speed.set` answered `speed_consent_required{recordOn:"local"}`.
     */
    "plugin.claudeAuth.fastAck": method(empty, Speed.Consent, OwnError.pick("remote_managed")),
    /**
     * Applied the local patch to an in-app install before the bundled plugin (2026-10-18). The bundle is patched at
     * build time; the methods remain for older clients and refuse with `internal_error` "built_in".
     */
    "plugin.claudeAuth.patch.plan": method(
      empty,
      Schema.Struct({
        ...planned,
        sha256: Schema.String,
        runningSessions: Schema.Array(SessionID),
        restartRequired: Schema.Literal(true),
      }),
      OwnError.pick("ack_required", "plugin_not_installed", "remote_managed"),
    ),
    "plugin.claudeAuth.patch.execute": method(
      execute,
      Schema.Struct({ clientAction: Switch.RestartService }),
      OwnError.pick("nonce_invalid", "session_busy", "ack_required", "plugin_not_installed", "remote_managed"),
    ),
    /**
     * 02 §8.7 (2026-10-10) `Claude 계정 추가`: Claude Code's own login (`claude auth login --claudeai`) in a window on
     * this PC with a new login folder (`<OWN_HOME>\claude-accounts\<id>`). `cli`: the Claude Code found; `null` =
     * `claude_account_unavailable{cli_missing}` on execute. own never sees a password or a token. With `accountID`
     * (`다시 로그인`, 2026-10-18): the same login into that account's own folder, for an expired or revoked login; the
     * folder is never deleted then (`account_not_found` for an unknown account). An account on a login Claude Code itself
     * uses (`Account.View` `claude.shared`: `%USERPROFILE%\.claude`, the account source's folder, or a folder or
     * credentials file that is one of those by realpath or file id) is never logged into there (CS, 2026-10-22):
     * `move: true`, the login goes into a new own folder and the account moves to it (`own 전용 로그인으로 바꾸기`; its
     * id, label, color and bindings stay). Plan and execute read the folders' realpaths again; a `다시 로그인` plan whose
     * folder turned into Claude Code's since is `nonce_invalid` on execute (plan again: it moves).
     */
    "plugin.claudeAuth.accounts.add.plan": method(
      Schema.Struct({ accountID: optional(Account.ID) }),
      Schema.Struct({
        ...planned,
        cli: Schema.NullOr(Schema.String),
        folder: Schema.String,
        move: optional(Schema.Boolean),
      }),
      OwnError.pick(
        "ack_required",
        "plugin_not_installed",
        "claude_account_unavailable",
        "account_not_found",
        "remote_managed",
      ),
    ),
    "plugin.claudeAuth.accounts.add.execute": method(
      execute,
      Schema.Struct({ attemptID: Schema.String }),
      OwnError.pick("nonce_invalid", "claude_account_unavailable", "remote_managed"),
    ),
    /**
     * The login window's progress: `waiting` (until the window closes or 10 minutes pass), `added` with the new
     * account, `duplicate` (that login is already an account: `accountID`), `mismatch` (a `move` whose login is another
     * Claude account than the shared one: nothing changed, CS), `failed` (closed without a login), `timeout`.
     */
    "plugin.claudeAuth.accounts.add.status": method(
      Schema.Struct({ attemptID: Schema.String }),
      Schema.Struct({
        state: Schema.Literals(["waiting", "added", "duplicate", "mismatch", "failed", "timeout"]),
        accountID: optional(Account.ID),
        label: optional(Schema.String),
      }),
      OwnError.pick("nonce_invalid", "remote_managed"),
    ),
    /**
     * `이 PC의 기존 Claude Code 로그인 가져오기`: the login folder the slot reads (`claude-auth.json`, else
     * `%USERPROFILE%\.claude`) and its masked e-mail when Claude Code is signed in there; `imported` = the slot's
     * connection exists already. Reads only `oauthAccount.emailAddress` of `.claude.json` and whether a login exists.
     */
    "plugin.claudeAuth.accounts.detect": method(
      empty,
      Schema.Struct({
        found: Schema.NullOr(Schema.Struct({ folder: Schema.String, email: Schema.NullOr(Schema.String) })),
        imported: Schema.Boolean,
      }),
      OwnError.pick("remote_managed"),
    ),
    /** `계정 빼기…`: the conversations bound to the account (they move to the default account) and the folder choice. */
    "plugin.claudeAuth.accounts.remove.plan": method(
      Schema.Struct({ accountID: Account.ID }),
      Schema.Struct({
        ...planned,
        boundSessions: Schema.Array(SessionID),
        /**
         * Offered (and on by default) only for a folder own created; never for a login Claude Code uses (`claude.shared`,
         * read again at plan and execute).
         */
        deleteFolder: Schema.Struct({ offered: Schema.Boolean, default: Schema.Boolean }),
      }),
      OwnError.pick("account_not_found", "remote_managed"),
    ),
    "plugin.claudeAuth.accounts.remove.execute": method(
      Schema.Struct({ nonce: Nonce, deleteFolder: Schema.Boolean }),
      Schema.Struct({ movedSessions: Schema.Array(SessionID), folderDeleted: Schema.Boolean }),
      OwnError.pick("nonce_invalid", "account_not_found", "remote_managed"),
    ),
    /** The Claude account a conversation uses (its tree's binding, else the default) (02 §8.7, 07 R4). */
    "plugin.claudeAuth.session.get": method(
      Schema.Struct(session),
      Schema.Struct({ accountID: Account.ID, bound: Schema.Boolean }),
      OwnError.pick(),
    ),
    /**
     * The switcher's `Claude · {label}`: binds the conversation's whole tree (subagents, and the team when it has one)
     * to one Claude account (R4), cold for the cache; new conversations start on the account chosen last.
     */
    "plugin.claudeAuth.session.set": method(
      Schema.Struct({ ...session, accountID: Account.ID }),
      Schema.Struct({ accountID: Account.ID, sessions: Schema.Array(SessionID) }),
      OwnError.pick("account_not_found", "claude_account_unavailable"),
    ),
    /** The Claude account new conversations start on (the switcher's choice for a new conversation, 02 §8.7). */
    "plugin.claudeAuth.default.set": method(
      Schema.Struct({ accountID: Account.ID }),
      Schema.Struct({ accountID: Account.ID }),
      OwnError.pick("account_not_found", "claude_account_unavailable", "remote_managed"),
    ),

    // Project plugin trust
    "plugin.trust.list": method(
      empty,
      Schema.Struct({ locations: Schema.Array(Plugin.TrustLocation) }),
      OwnError.pick(),
    ),
    "plugin.trust.approve.plan": method(
      Schema.Struct({
        directory: Schema.String,
        sources: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
      }),
      Schema.Struct({
        ...planned,
        directory: Schema.String,
        plugins: Schema.Array(Plugin.TrustPlugin),
        warning: Schema.String,
      }),
      OwnError.pick(),
    ),
    "plugin.trust.approve.execute": method(
      execute,
      Schema.Struct({ directory: Schema.String, status: Plugin.TrustStatus }),
      OwnError.pick("nonce_invalid", "trust_hash_mismatch"),
    ),
    "plugin.trust.revoke": method(
      Schema.Struct({ directory: Schema.String, source: Schema.String }),
      Schema.Struct({ directory: Schema.String, status: Plugin.TrustStatus }),
      OwnError.pick(),
    ),

    // Diagnostics
    "diagnostics.selfTest": method(empty, SelfTest, OwnError.pick()),
    /**
     * P0-3a (02 §7.8): starts an opt-in window of own-slot wire evidence under `<OWN_HOME>\diagnostics\captures`, kept
     * 7 days. A running window ends first (`replaced`). Local only: the files name local paths and the census.
     */
    "diagnostics.capture.start": method(
      Schema.Struct({
        mode: CaptureMode,
        /** Default {@link CAPTURE_DEFAULT_MINUTES}. */
        minutes: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CAPTURE_MAX_MINUTES }))),
        sessionID: optional(SessionID),
        providerIDs: optional(Schema.Array(Provider.ID).check(Schema.isMinLength(1))),
      }),
      CaptureStatus,
      OwnError.pick(),
    ),
    /** Ends the running window (`capture_empty` when it recorded nothing); without one, the status as it is. */
    "diagnostics.capture.stop": method(empty, CaptureStatus, OwnError.pick()),
    "diagnostics.capture.status": method(empty, CaptureStatus, OwnError.pick()),

    // Image tool (02 §9.6): the key chain and the subscription accounts as the tool would try them now (no key), and
    // clearing a key's used-up mark after the user topped it up. The setting itself is `policy.set{image}`.
    "image.get": method(empty, OwnImage.View, OwnError.pick()),
    "image.clear": method(OwnImage.ClearInput, OwnImage.View, OwnError.pick()),

    // 내 브라우저 사용 (BRW): the setting and the `browse` program this PC's service would run (never runs it), and
    // the setting's write. `browse.set` is `local`: the program it names runs on this PC as an MCP server.
    "browse.status": method(empty, OwnBrowse.Status, OwnError.pick()),
    "browse.set": method(OwnBrowse.Setting, OwnBrowse.Status, OwnError.pick()),

    // Voice input (02 §3.9, 03 §5.7.4). Voice-only keys in the vault (`voice-<provider>`), never an account's key; the
    // audio and the text are not stored, logged or put into a session. Methods of this PC: a remote service answers
    // `remote_managed`, and the gateway sends none of them to a host.
    /** Settings, which services have a key (never the key), the selected model, usage minutes and the limits. */
    "voice.get": method(empty, Voice.View, OwnError.pick("remote_managed")),
    "voice.set": method(Voice.SetInput, Voice.View, OwnError.pick("remote_managed")),
    /** Stores (or with `key: null` removes) a service's voice key in the vault. Local only: a device never sends one. */
    "voice.key.set": method(
      Voice.KeyInput,
      Voice.View,
      OwnError.pick("voice_key_invalid", "vault_unavailable", "remote_managed"),
    ),
    /**
     * One recording → text with the selected service and its voice key. `prompt`: it spends the user's paid minutes.
     * Nothing is sent when voice input is off or the key is missing.
     */
    "voice.transcribe": method(
      Voice.TranscribeInput,
      Voice.TranscribeResult,
      OwnError.pick("voice_unavailable", "voice_audio_invalid", "voice_failed", "vault_unavailable", "remote_managed"),
    ),

    // Web search services' own keys (02 §9.2, SP 2026-10-19): Brave's key in own's vault (`websearch-brave`), never an
    // account's key nor core's credential table. Methods of this PC like the voice keys: a remote service answers
    // `remote_managed`.
    /** Which services have their key (never the key, only its last four characters). */
    "websearch.key.get": method(empty, SearchKey.View, OwnError.pick("remote_managed")),
    /**
     * Stores (or with `key: null` removes) a service's key in the vault; every Location folds the web search services
     * again, so Brave is listed once its key is there. Local only: a device never sends one.
     */
    "websearch.key.set": method(
      SearchKey.SetInput,
      SearchKey.View,
      OwnError.pick("websearch_key_invalid", "vault_unavailable", "remote_managed"),
    ),

    // Worktree removal guard (06 §10.4 #5). Reads only folders the server has as the project's worktrees (its
    // worktree table) and that `git worktree list` reports for `root`.
    "worktree.inspect": method(
      Schema.Struct({
        /** The project whose worktree table must list both `root` and `directory`. */
        projectID: Schema.String.check(Schema.isMinLength(1)),
        /** The project's main worktree. */
        root: Schema.String.check(Schema.isMinLength(1)),
        /** A linked worktree of `root`, absolute. */
        directory: Schema.String.check(Schema.isMinLength(1)),
      }),
      WorktreeInspection,
      worktreeErrors,
    ),

    // Workspace notes (02 §9.2 "워크스페이스 노트", 05 §8.8). Global methods at the control location; a remote service
    // answers `remote_managed` (the notes of SSH projects live on this PC too).
    /** The workspace's notes in creation order, without their text. */
    "notes.list": method(
      Schema.Struct({ workspace: NotesWorkspace }),
      Schema.Struct({ notes: Schema.Array(NoteMeta) }),
      OwnError.pick("remote_managed"),
    ),
    "notes.get": method(
      Schema.Struct({ workspace: NotesWorkspace, id: NoteID }),
      Note,
      OwnError.pick("note_not_found", "remote_managed"),
    ),
    /**
     * Saves a note when `baseRev` is the stored revision (0: the note does not exist yet, which creates it). Absent
     * `title` or `text` keep the stored value (empty for a new note). Anything else is `note_conflict` with the stored
     * note, never a silent overwrite.
     */
    "notes.put": method(
      Schema.Struct({
        workspace: NotesWorkspace,
        id: NoteID,
        title: optional(NoteTitle),
        text: optional(NoteText),
        baseRev: NonNegativeInt,
      }),
      Schema.Struct({ rev: PositiveInt, updatedAt: EpochMillis }),
      OwnError.pick("note_conflict", "notes_limit", "remote_managed"),
    ),
    /** Removes a note; with `baseRev`, only that revision (else `note_conflict`). `removed: false` when it was gone. */
    "notes.remove": method(
      Schema.Struct({ workspace: NotesWorkspace, id: NoteID, baseRev: optional(PositiveInt) }),
      Schema.Struct({ removed: Schema.Boolean }),
      OwnError.pick("note_conflict", "remote_managed"),
    ),

    // 곁질문 (02 §9.7, 03 §4.4.2): side questions about a conversation, answered by the service that runs it (an SSH
    // host's for a host conversation) from its history without tools, and kept out of it (own-accounts KV).
    /**
     * Asks a side question: a new thread, or a follow-up in `threadID`. Answers the thread with the new turn
     * `running`; the text comes as `side.delta` events and the end as `side.ended`.
     */
    "side.ask": method(
      Schema.Struct({ ...session, threadID: optional(SideID), question: SideQuestion }),
      Schema.Struct({ thread: SideThread }),
      OwnError.pick("side_unavailable", "side_not_found", "side_busy"),
    ),
    /** One thread, with the running turn's text so far. */
    "side.get": method(
      Schema.Struct({ ...session, threadID: SideID }),
      Schema.Struct({ thread: SideThread }),
      OwnError.pick("side_not_found"),
    ),
    /** The conversation's side threads, newest first. */
    "side.list": method(Schema.Struct({ ...session }), Schema.Struct({ threads: Schema.Array(SideSummary) }), OwnError.pick()),
    /** Ends the thread's running answer; `cancelled: false` when nothing ran. */
    "side.cancel": method(
      Schema.Struct({ ...session, threadID: SideID }),
      Schema.Struct({ cancelled: Schema.Boolean }),
      OwnError.pick(),
    ),
    /** Forgets a thread (its running answer is cancelled first). */
    "side.remove": method(
      Schema.Struct({ ...session, threadID: SideID }),
      Schema.Struct({ removed: Schema.Boolean }),
      OwnError.pick(),
    ),

    // Idea notes (02 §9.2 "아이디어 노트", 03 §4.4.1): global sticky notes tied to no project or conversation. Global
    // methods at the control location, like the workspace notes; a remote service answers `remote_managed`.
    /** Every idea, in no particular order (the board sorts: pinned first, then newest). */
    "ideas.list": method(empty, Schema.Struct({ ideas: Schema.Array(Idea) }), OwnError.pick("remote_managed")),
    /**
     * Saves an idea when `baseRev` is the stored revision (0: it does not exist yet, which creates it). Anything else
     * is `idea_conflict` with the stored idea, never a silent overwrite. Answers the saved idea.
     */
    "ideas.put": method(IdeaPut, Idea, OwnError.pick("idea_conflict", "ideas_limit", "remote_managed")),
    /** Removes an idea; with `baseRev`, only that revision (else `idea_conflict`). `removed: false` when it was gone. */
    "ideas.remove": method(
      Schema.Struct({ id: IdeaID, baseRev: optional(PositiveInt) }),
      Schema.Struct({ removed: Schema.Boolean }),
      OwnError.pick("idea_conflict", "remote_managed"),
    ),

    // 기본 대화 폴더 (03 §5.1): where a conversation started without choosing a project works. Global methods at the
    // control location, answered by every service itself (an SSH host decides its own folder); never remote-managed.
    /** The folder new folderless conversations start in, the built-in default and whether it exists yet. */
    "conversationFolder.get": method(empty, ConversationFolder.View, OwnError.pick()),
    /**
     * The user's choice (`path`, created now with a write check) or back to the built-in default (`null`). A refused
     * folder stores nothing (`conversation_folder_unavailable`).
     */
    "conversationFolder.set": method(
      ConversationFolder.SetInput,
      ConversationFolder.View,
      OwnError.pick("conversation_folder_unavailable"),
    ),
    /** Creates the folder when it is missing (first use) and answers the view; a new folderless conversation calls it. */
    "conversationFolder.ensure": method(
      empty,
      ConversationFolder.View,
      OwnError.pick("conversation_folder_unavailable"),
    ),
    // 폴더 열기 시작 위치 (03 §18.3): where the folder picker starts on this service, beside the folder above.
    /** The user's start folder (or `null`: the last opened folder's parent) and the home folder. */
    "folderPicker.get": method(empty, ConversationFolder.PickerView, OwnError.pick()),
    /** An existing absolute folder, or `null` back to the last opened folder's parent. */
    "folderPicker.set": method(
      ConversationFolder.PickerSetInput,
      ConversationFolder.PickerView,
      OwnError.pick("folder_picker_unavailable"),
    ),
    /**
     * 폴더 열기 (03 §18.3, 04 §17.4): the folders inside an absolute folder of this service's machine, each marked when
     * the service user may not open it, without the folders that are never a project (`lost+found` at a mount point,
     * Windows' system folders at a drive root). A picker of an older service lists with core's `fs.list` instead.
     */
    "folderPicker.list": method(
      ConversationFolder.ListInput,
      ConversationFolder.ListView,
      OwnError.pick("folder_list_unavailable"),
    ),
    /** `새 폴더` in the picker: one new folder named `name` inside `parent`; never an existing one. */
    "folderPicker.create": method(
      ConversationFolder.CreateInput,
      ConversationFolder.CreateView,
      OwnError.pick("folder_create_unavailable"),
    ),

    // 프로젝트 순서와 고정 (03 §4.3): how the sidebar lists this service's projects. Every service answers for itself
    // (an SSH host keeps its own); never remote-managed. An older service has neither method: own-web keeps the list
    // in the browser there.
    /** The pinned projects and the user's order, as saved. */
    "projectList.get": method(empty, ProjectList.View, OwnError.pick()),
    /** Replaces the pinned projects, the order, or both; `order: null` goes back to the default order. */
    "projectList.set": method(ProjectList.SetInput, ProjectList.View, OwnError.pick()),

    // 에이전트가 못 여는 파일·폴더 (01 §13, 03 §18.8, PP): what an agent's file tools never open on this service, and
    // what a shell command asks first for when it names it. Every service answers for itself (an SSH host keeps its
    // own list, placed in its own home folder); never remote-managed.
    /** The built-in entries with their reasons and the user's list. */
    "protectedPaths.get": method(empty, ProtectedPaths.View, OwnError.pick()),
    /**
     * Adds a path (absolute, or starting with `~`) to the user's list; every session follows from its next tool call.
     * A path already listed answers the view unchanged.
     */
    "protectedPaths.add": method(
      ProtectedPaths.PathInput,
      ProtectedPaths.View,
      OwnError.pick("protected_path_invalid"),
    ),
    /** Removes a path of the user's list (as added, or its absolute form); an unknown one answers the view unchanged. */
    "protectedPaths.remove": method(ProtectedPaths.PathInput, ProtectedPaths.View, OwnError.pick()),
    /**
     * Names in the home folder that look sensitive (wallet, backup, seed, keys, password, `.kdbx` …) and nothing
     * covers yet: offered with `추가`, never added by themselves.
     */
    "protectedPaths.suggest": method(empty, ProtectedPaths.Suggestions, OwnError.pick()),
    /** Every pattern the hook denies `read` and `edit` for, for searches that filter their results themselves (dsh). */
    "protectedPaths.patterns": method(empty, ProtectedPaths.Patterns, OwnError.pick()),

    // Codex 모델 목록 (07 §4.5, CA 2026-10-19): which Codex version the ChatGPT accounts' model lists are asked as, and
    // the rows own left out. This PC's: a remote service fetches no list and answers `remote_managed`.
    /** The setting `Codex 최신 모델 자동 확인`, the version asked now, the registry's newest release, left-out rows. */
    "codexModels.get": method(empty, CodexModels.View, OwnError.pick("remote_managed")),
    /** Turns `Codex 최신 모델 자동 확인` on or off; a changed version asks every list again. */
    "codexModels.set": method(CodexModels.SetInput, CodexModels.View, OwnError.pick("remote_managed")),
    /**
     * In-process (own.harness, 10 §6.14): the served rows the `codex` harness takes at runtime and their revision;
     * none on a remote service, which fetches no list.
     */
    "codexModels.rows": method(CodexModels.RowsInput, CodexModels.Rows, OwnError.pick()),

    // MCP servers own adds (03 §18.14, SM 2026-10-24): kept in `OWN_HOME\mcp.json` with their values in the vault and
    // handed to core by the `mcp.transform` of every Location, never written into a config file. This PC's: a remote
    // service answers `remote_managed` (an SSH host's servers are its own config's).
    /**
     * The servers own added, the list's kept switches and whether the vault answers; with a project folder also core's
     * error text of own's failed servers there, stored values cut out. Never a stored value.
     */
    "mcp.list": method(OwnMcp.ListInput, OwnMcp.View, OwnError.pick("remote_managed")),
    /** What any window may know of own's servers (names, scopes, where they came from): the list's source line. */
    "mcp.summary": method(empty, OwnMcp.Summary, OwnError.pick("remote_managed")),
    /** Adds or changes a server; every Location folds its servers again. */
    "mcp.save": method(
      OwnMcp.SaveInput,
      OwnMcp.View,
      OwnError.pick(
        "mcp_name_taken",
        "mcp_not_found",
        "mcp_secret_missing",
        "mcp_invalid",
        "vault_unavailable",
        "remote_managed",
      ),
    ),
    /** Removes a server own added and its vault item. */
    "mcp.remove": method(
      Schema.Struct({ id: OwnMcp.ID }),
      OwnMcp.View,
      OwnError.pick("mcp_not_found", "vault_unavailable", "remote_managed"),
    ),
    /**
     * The list's switch in every project (no `directory`) or in one project, kept across restarts: own's servers and a
     * config file's alike (core applies it as the server's `disabled`). The global switch applies first, then the
     * project switches from the shallowest folder to the deepest (SG). For own's servers a value equal to what the
     * folder inherits deletes the switch instead of storing it.
     */
    "mcp.enable": method(
      Schema.Struct({
        /** Left out: every project (the global switch, SG). */
        directory: optional(Schema.String.check(Schema.isMinLength(1))),
        name: Schema.String.check(Schema.isMinLength(1)),
        /** `null` deletes the switch at exactly this folder (or the global one): the value it inherits applies again. */
        enabled: Schema.NullOr(Schema.Boolean),
      }),
      OwnMcp.View,
      OwnError.pick("mcp_invalid", "remote_managed"),
    ),
    /** Starts the server for a moment (or calls its URL), lists its tools and stops it; a saved one keeps the result. */
    "mcp.test": method(
      OwnMcp.TestInput,
      OwnMcp.Check,
      OwnError.pick("mcp_not_found", "mcp_secret_missing", "mcp_invalid", "vault_unavailable", "remote_managed"),
    ),
    /** Reads the other tools' MCP settings (Codex, Claude Code, the project's `.mcp.json`); values by name only. */
    "mcp.import.scan": method(
      Schema.Struct({ directory: optional(Schema.String.check(Schema.isMinLength(1))) }),
      OwnMcp.Scan,
      OwnError.pick("remote_managed"),
    ),
    /** Adds the picked candidates of a scan (its nonce, once), values into the vault. */
    "mcp.import.apply": method(
      Schema.Struct({
        nonce: Nonce,
        picks: Schema.Array(OwnMcp.Pick).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      }),
      OwnMcp.Applied,
      OwnError.pick("nonce_invalid", "mcp_name_taken", "mcp_invalid", "vault_unavailable", "remote_managed"),
    ),
    /** 찾아서 설치: one page of the MCP Registry's servers (latest versions) as the add form takes them. Saves nothing. */
    "mcp.registry.search": method(
      OwnMcp.RegistrySearch,
      OwnMcp.RegistryPage,
      OwnError.pick("mcp_registry_unavailable", "remote_managed"),
    ),

    // MCP servers of this PC on an SSH host (04 §13 "MCP", 03 §18.14, MH 2026-11-26). `mcp.host.*` are the host's own:
    // its installed servers (its `mcp.json`, no values), the probe of its runtimes, the connection test and a
    // pre-fetch, all in the host service's environment; this PC's service answers `mcp_host_only`. `mcp.hosts.*` are
    // this PC's records of values the user sent to a host (`이 키를 <host>에 보내기`); a host answers `remote_managed`.
    /** The host's installed servers (names of values only, whether the host holds them now) and its home folder. */
    "mcp.host.view": method(empty, McpHost.View, OwnError.pick("mcp_host_only")),
    /** What the host has: OS, architecture, runtimes on the service's PATH, docker access, named programs. Read only. */
    "mcp.host.probe": method(McpHost.ProbeInput, McpHost.Probe, OwnError.pick("mcp_host_only")),
    /** Installs or updates one server on the host (no values); every Location of the host folds again. */
    "mcp.host.save": method(
      McpHost.SaveInput,
      McpHost.View,
      OwnError.pick("mcp_name_taken", "mcp_not_found", "mcp_invalid", "mcp_host_only"),
    ),
    /** Removes a server from the host; the PC's record of values sent to it stays until `mcp.hosts.unsend`. */
    "mcp.host.remove": method(McpHost.IdInput, McpHost.View, OwnError.pick("mcp_not_found", "mcp_host_only")),
    /** The connection test on the host, with the values the PC sent; the result is kept with the server. */
    "mcp.host.test": method(McpHost.IdInput, OwnMcp.Check, OwnError.pick("mcp_not_found", "mcp_host_only")),
    /** Fetches the server's package into the host user's caches (npm, uv), up to `PREFETCH_TIMEOUT_MS`. */
    "mcp.host.prefetch": method(McpHost.IdInput, McpHost.Prefetch, OwnError.pick("mcp_not_found", "mcp_host_only")),
    /** Sends these values of a server to a host's server (a copy in this PC's vault the broker hands to that host). */
    "mcp.hosts.send": method(
      McpHost.SendInput,
      McpHost.Sends,
      OwnError.pick("mcp_not_found", "mcp_secret_missing", "mcp_invalid", "vault_unavailable", "remote_managed"),
    ),
    /** Withdraws what was sent to a host's server: the copy goes and the host drops the values. */
    "mcp.hosts.unsend": method(
      McpHost.UnsendInput,
      McpHost.Sends,
      OwnError.pick("vault_unavailable", "remote_managed"),
    ),
    /** The records of values sent to hosts (names only; `differs` when own's server holds other values now). */
    "mcp.hosts.view": method(McpHost.SendsInput, McpHost.Sends, OwnError.pick("remote_managed")),

    // Skill switches and scopes (03 §19.6.1, SG 2026-10-26): every skill is used in every project first; own.accounts
    // keeps what is off where (`OWN_HOME\skill-switches.json`) and folds it into each project's skills. This PC's: a
    // remote service answers `remote_managed` (an SSH host's skills are that host's own folders).
    /** The catalog, every switch and scope, and with a project folder what is off there. Never a skill's content. */
    "skillset.view": method(OwnSkillset.ViewInput, OwnSkillset.View, OwnError.pick("remote_managed")),
    /** Sets or deletes switches and scopes in one write; every project's Location folds its skills again. */
    "skillset.switch": method(
      OwnSkillset.SwitchInput,
      OwnSkillset.View,
      OwnError.pick("skillset_invalid", "remote_managed"),
    ),

    // GitHub connection (16, GH 2026-10-31): accounts in `OWN_HOME\github.json`, their tokens in the vault, and which
    // one a project, a team area's folder or a conversation uses. This PC's: a remote service answers `remote_managed`.
    /** Accounts, choices, settings and the tool list; with a folder or a conversation also the account in use there. */
    "github.view": method(OwnGitHub.ViewInput, OwnGitHub.View, OwnError.pick("remote_managed")),
    /** Connects an account by a token the user made: GitHub is asked whose token it is before anything is stored. */
    "github.add.token": method(
      OwnGitHub.AddTokenInput,
      OwnGitHub.View,
      OwnError.pick(
        "github_token_invalid",
        "github_unavailable",
        "github_invalid",
        "vault_unavailable",
        "remote_managed",
      ),
    ),
    /** Starts a browser login with the user's own app (`settings.clientID`): the code to type on GitHub's page. */
    "github.device.start": method(
      OwnGitHub.DeviceStartInput,
      OwnGitHub.DeviceStart,
      OwnError.pick("github_invalid", "github_unavailable", "remote_managed"),
    ),
    /** Where a browser login stands; `done` stores the account (once). */
    "github.device.status": method(
      Schema.Struct({ nonce: Nonce }),
      OwnGitHub.DeviceStatus,
      OwnError.pick("nonce_invalid", "vault_unavailable", "remote_managed"),
    ),
    /** Stops waiting for a browser login. */
    "github.device.cancel": method(
      Schema.Struct({ nonce: Nonce }),
      OwnGitHub.DeviceStatus,
      OwnError.pick("nonce_invalid", "remote_managed"),
    ),
    /** Renames an account, allows or stops its write tools, or replaces its token with one of the same user's. */
    "github.update": method(
      OwnGitHub.UpdateInput,
      OwnGitHub.View,
      OwnError.pick(
        "github_not_found",
        "github_token_invalid",
        "github_unavailable",
        "github_invalid",
        "vault_unavailable",
        "remote_managed",
      ),
    ),
    /** Removes an account, its token and the choices that name it. */
    "github.remove": method(
      Schema.Struct({ id: OwnGitHub.ID }),
      OwnGitHub.View,
      OwnError.pick("github_not_found", "vault_unavailable", "remote_managed"),
    ),
    /** Sets or deletes the default's, a project folder's or a conversation's choice. */
    "github.bind": method(OwnGitHub.BindInput, OwnGitHub.View, OwnError.pick("github_invalid", "remote_managed")),
    /** The MCP server own asks, its toolsets, git's logins through own and the browser login's client ID. */
    "github.settings.set": method(
      OwnGitHub.SettingsInput,
      OwnGitHub.View,
      OwnError.pick("github_invalid", "remote_managed"),
    ),
    /** Asks GitHub who the account's token is and reads GitHub's MCP server's tools with it. */
    "github.test": method(
      Schema.Struct({ id: OwnGitHub.ID }),
      OwnGitHub.Check,
      OwnError.pick("github_not_found", "vault_unavailable", "remote_managed"),
    ),

    // 설정 > 업데이트 (05 §20, UPD): the programs own runs on this PC that the user installs (Claude Code, Git, git-lfs,
    // gh, ripgrep, a local github-mcp-server), their versions, the newest releases (npm's registry and GitHub's
    // releases API, no credentials, daily, off by switch) and an official update command run only after the user's
    // click. Methods of this PC: a remote service answers `remote_managed`; an SSH host's parts update through
    // own.remote's `update.*`.
    /** Versions, statuses and how each updates; reads the newest releases when due. */
    "tools.view": method(ToolUpdates.ViewInput, ToolUpdates.View, OwnError.pick("remote_managed")),
    /** `새 버전 확인` on or off. */
    "tools.settings.set": method(ToolUpdates.SettingsInput, ToolUpdates.View, OwnError.pick("remote_managed")),
    /** The confirm card of one component's update: the exact command and its official source. Runs nothing. */
    "tools.update.plan": method(
      ToolUpdates.PlanInput,
      Schema.Struct({ ...planned, ...ToolUpdates.Plan.fields }),
      OwnError.pick("tool_not_updatable", "tool_busy", "remote_managed"),
    ),
    /** Starts the planned command (one at a time) and answers its job; the output comes with `tools.update.status`. */
    "tools.update.execute": method(execute, ToolUpdates.Job, OwnError.pick("nonce_invalid", "tool_busy", "remote_managed")),
    /** The job's state and its output from `from`; after the end, the version read again (`after`). */
    "tools.update.status": method(
      ToolUpdates.StatusInput,
      ToolUpdates.Job,
      OwnError.pick("tool_job_not_found", "remote_managed"),
    ),
  },
  events: Events,
})
export type Definition = typeof Definition

export type MethodName = keyof Definition["methods"] & string
export type EventName = keyof Definition["events"] & string

// ---------------------------------------------------------------------------------------------------------------
// Routing: device scopes and locations (02 §9.1)

/**
 * Device scope a method needs (02 §9.1, names of 05 §13.5). The gateway enforces it on `/api/rpc/own.accounts/<m>`
 * and own-web hides what the device may not call. `local` never works from a remote device (secrets, local paths,
 * code installs, registry writes). `prompt` guards upstream HTTP work (a client's `compaction.due` run, `clientAction`)
 * and the one own method that lets the current message start more work, `session.preset.raiseOnce` (07 §8.1). The
 * compactions own.accounts admits itself follow the method that caused them (`switch.apply`, `compaction.setSession`:
 * `switch`, 05 §13.5). Every event is `read`.
 */
export const Scope = Schema.Literals(["read", "prompt", "switch", "admin", "local"]).annotate({
  identifier: "Own.Rpc.Scope",
})
export type Scope = typeof Scope.Type

/** Typed so that a new method cannot be added without a scope. */
export { MethodScope, scopeOf } from "./rpc-routing.js"

/**
 * Where a call goes (02 §9.1 "location 규칙"):
 * - `control`: global methods, sent with `location[directory]` = the control directory (`health.controlDir`, or what
 *   the host gives: launcher fragment `#control=…`, `OwnHost.controlDir`, gateway status). Never an arbitrary directory.
 * - `session`: session methods, sent with the session's own directory (after `session.moved`, the new one): the
 *   session's hooks, timers and events live in that Location's instance. `session.binding` takes sessions of one
 *   directory per call.
 */
export const Location = Schema.Literals(["control", "session"]).annotate({ identifier: "Own.Rpc.Location" })
export type Location = typeof Location.Type

/** Typed so that a new method cannot be added without a location. */
export { MethodLocation } from "./rpc-routing.js"

/**
 * Which instance publishes an event (02 §9.1): `global` events only the process leader (the control Location's
 * instance when it exists); `session` events the instance of the session's Location. `alert` is either, and carries
 * `origin`. Every event has `eventId` for de-duplication.
 */
export { EventOrigin } from "./rpc-routing.js"
