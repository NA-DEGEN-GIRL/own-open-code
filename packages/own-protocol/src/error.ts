export * as OwnError from "./error.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { AccountID } from "./account-id.js"
import { ConversationFolder } from "./conversation-folder.js"
import { Kind } from "./kind.js"
import { Preset } from "./preset.js"
import { ProtectedPaths } from "./protected-paths.js"
import { Voice } from "./voice.js"

/** Why a codex-multi-provider profile cannot be imported. */
export const SourceProblem = Schema.Literals([
  "unreadable",
  "parse_failed",
  "not_chatgpt",
  "missing_tokens",
  "token_expired",
  "account_mismatch",
]).annotate({ identifier: "Own.Error.SourceProblem" })
export type SourceProblem = typeof SourceProblem.Type

/** Why an API key saved by the old app cannot be linked or used (02 §3.2b). Never carries the key. */
export const LegacyKeyProblem = Schema.Literals([
  /** The key file (or its directory) does not exist: the old app has no saved key for this provider. */
  "not_found",
  /** Not a DPAPI blob of this Windows user (other user or PC, damaged file). */
  "decrypt_failed",
  /** Outside own-vault's allowlist, a reparse point, not a regular file, or too large. */
  "path_denied",
  /** Decrypts, but is not a usable key (empty, control characters, too long). */
  "invalid_key",
  "unreadable",
  /** The provider's API has no own kind (e.g. a Responses-only third-party endpoint). */
  "unsupported_provider",
  /** The installed own-vault.exe predates `linked.get` (0.1.0). */
  "helper_outdated",
]).annotate({ identifier: "Own.Error.LegacyKeyProblem" })
export type LegacyKeyProblem = typeof LegacyKeyProblem.Type

/** Why a ChatGPT login is not usable as it is for a reset credit request (02 §7.1.1 리셋권, `credential_not_ready`). */
export const CredentialCause = Schema.Literals([
  /** Its access token has 10 minutes or less left (and is never refreshed for a reset credit). */
  "expiring",
  /** The login is dead or refused (the account's `needs_reauth`, an unreadable vault item): sign in again. */
  "needs_reauth",
  /** No login is stored for the account. */
  "missing",
  /** A linked old-app login the old app has not refreshed (`codex_source_stale`). */
  "source_stale",
  /** Anything else (the vault unavailable, a linked source unreadable, a login of another kind). */
  "unusable",
]).annotate({ identifier: "Own.Error.CredentialCause" })
export type CredentialCause = typeof CredentialCause.Type

/**
 * Declared RPC error `data` schemas (02 §9.4). A handler must `return context.error(type, message, data)` for one
 * of its method's declared types; anything thrown becomes HTTP 500 `rpc.internal`.
 * `source_not_found` and `source_invalid` extend 02 §9.4 for codex-multi-provider imports, `legacy_key_not_found` and
 * `legacy_key_invalid` for its saved API keys (02 §3.2b). `remote_managed` (04 §16.5)
 * is what a remote service (`mode:"remote"`) answers to account changes: they are made on the local PC and mirrored.
 * The preset errors and `team_switch_required` come from 07 §8.1 (`same_company_subscription` has the same name and
 * meaning in 06 own.team).
 */
export const data = portable({
  account_not_found: Schema.Struct({ accountID: Schema.String }),
  slot_misconfigured: Schema.Struct({ providerID: Schema.String, problems: Schema.Array(Schema.String) }),
  session_busy: Schema.Struct({ sessionIDs: Schema.Array(SessionID) }),
  estimate_expired: Schema.Struct({ estimateID: Schema.String }),
  no_eligible_target: Schema.Struct({ reasons: Schema.Array(Schema.String) }),
  needs_reauth: Schema.Struct({ accountID: AccountID }),
  probe_failed: Schema.Struct({ status: optional(Schema.Int), message: Schema.String }),
  duplicate_account: Schema.Struct({ accountID: AccountID }),
  /** `remote` (04 §8.11.12): `plugin.claudeAuth.remote.set` needs the remote consent first. */
  ack_required: Schema.Struct({ reason: Schema.Literals(["missing", "stale", "remote"]) }),
  policy_denied: Schema.Struct({ field: Schema.String }),
  trust_hash_mismatch: Schema.Struct({ source: Schema.String, expected: Schema.String, actual: Schema.String }),
  undo_window_closed: Schema.Struct({}),
  unsupported_strategy: Schema.Struct({ strategy: Schema.String }),
  invalid_schedule: Schema.Struct({
    idleMinutes: Schema.NullOr(Schema.Finite),
    deadlineMinutes: Schema.NullOr(Schema.Finite),
  }),
  nonce_invalid: Schema.Struct({}),
  plugin_not_installed: Schema.Struct({}),
  template_unavailable: Schema.Struct({ kind: Kind.Own, reason: Schema.String }),
  vault_unavailable: Schema.Struct({}),
  internal_error: Schema.Struct({}),
  source_not_found: Schema.Struct({ profileID: Schema.String }),
  source_invalid: Schema.Struct({ profileID: Schema.String, reason: SourceProblem }),
  /** `accounts.import.keys.*`: the old app has no such provider (or no saved key file for it). */
  legacy_key_not_found: Schema.Struct({ providerRef: Schema.String }),
  /** `accounts.import.keys.*`: the old app's key file exists but cannot back an account. */
  legacy_key_invalid: Schema.Struct({ providerRef: Schema.String, reason: LegacyKeyProblem }),
  /** v0.3/v0.4: a compaction setting, `keepTokens` or `configDir` outside its range; `null` bound = open. */
  setting_out_of_range: Schema.Struct({
    field: Schema.String,
    min: Schema.NullOr(Schema.Finite),
    max: Schema.NullOr(Schema.Finite),
  }),
  /** v0.4: the strategy would send `POST /compact`, which commits the session's staged revert (02 §4.7.4). */
  revert_staged: Schema.Struct({ sessionID: SessionID }),
  /** 04 §16.5: this is a remote service; accounts, policy, rate cards and the Claude slot are managed locally. */
  remote_managed: Schema.Struct({ method: Schema.String }),
  /** 07 §5.4 R4: the account would be a second subscription of one company (another login of the main's company). */
  same_company_subscription: Schema.Struct({ accountID: AccountID }),
  /** 07 §8.1: no such preset (a remote service has only each group's `평소대로` before T3). */
  preset_not_found: Schema.Struct({ presetID: Schema.String }),
  /** 07 §5.3: the preset belongs to another group than the session's main account (`group` = the main's). */
  preset_wrong_group: Schema.Struct({ group: Preset.Group }),
  /** 07 §3.4: a target of this role (or `single`, or the model pool entry `pool:<key>`) is unknown or cannot call tools. */
  preset_target_unavailable: Schema.Struct({ role: Preset.Spot }),
  /** 07 §2.7: a group's `평소대로` cannot be changed or removed. */
  preset_builtin_locked: Schema.Struct({ presetID: Schema.String }),
  /** 07 §5.4 step 4: the paid account's monthly budget is used up. */
  preset_budget_exhausted: Schema.Struct({ accountID: AccountID }),
  /**
   * 07 §5.5, 06 §10.1: this switch changes a team's subscription account of that company; only own.team's
   * `team.account` operation may (`teamOp`).
   */
  team_switch_required: Schema.Struct({ teamID: Schema.String }),
  /**
   * 02 §4.8: the session's main does not offer this speed now (`reason`: `not_offered`, `unavailable`, `cooldown`,
   * `fixed_model` for a `-fast` model entry, `no_model`).
   */
  speed_unavailable: Schema.Struct({ speed: Schema.String, reason: Schema.String }),
  /**
   * 02 §4.8: Fast on the Claude subscription slot needs the one-time usage-credit consent first. `recordOn: "local"`
   * (04 §8.11.9): on a remote service the consent is recorded on the PC (`plugin.claudeAuth.fastAck`), never here.
   */
  speed_consent_required: Schema.Struct({ recordOn: optional(Schema.Literal("local")) }),
  /**
   * 02 §8.7 (2026-10-10): another Claude account cannot be added or used now. `cli_missing`: no Claude Code on this
   * PC (own never installs it); `not_patched`: the installed claude-auth runs one account only (patch it first, or the
   * service has not restarted since); `busy`: a login is already waiting in a window on this PC; `own_login` (CS,
   * 2026-10-22): `changeSource` while account 1 is on an own login folder, without `leaveOwnLogin`. 02 §8.10 폴더 나누기:
   * a folder that cannot move to another route: `claude_code` (Claude Code's own folder), `slot` (claude-auth's
   * account 1), `not_managed` (a folder own did not make); `transcripts`: a Claude Agent folder's transcript link is
   * broken and own could not repair it.
   */
  claude_account_unavailable: Schema.Struct({
    reason: Schema.Literals([
      "cli_missing",
      "not_patched",
      "busy",
      "own_login",
      "claude_code",
      "slot",
      "not_managed",
      "transcripts",
    ]),
  }),
  /** 02 §9.2 notes: the workspace has no note with this id (never saved, or removed). */
  note_not_found: Schema.Struct({ id: Schema.String }),
  /**
   * 02 §9.2 notes: `baseRev` is not the stored revision. `current` is the stored note (`null`: removed), so the client
   * shows another device's newer text instead of overwriting it.
   */
  note_conflict: Schema.Struct({
    current: Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        text: Schema.String,
        rev: Schema.Int,
        updatedAt: Schema.Finite,
      }),
    ),
  }),
  /** 02 §9.2 notes: the workspace already holds `max` notes. */
  notes_limit: Schema.Struct({ max: Schema.Int }),
  /**
   * 02 §9.2 아이디어 노트: `baseRev` is not the stored revision. `current` is the stored idea (`null`: removed), so
   * the board shows another device's change instead of overwriting it.
   */
  idea_conflict: Schema.Struct({
    current: Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        text: Schema.String,
        color: Schema.String,
        pinned: Schema.Boolean,
        rev: Schema.Int,
        createdAt: Schema.Finite,
        updatedAt: Schema.Finite,
      }),
    ),
  }),
  /** 02 §9.2 아이디어 노트: this PC already keeps `max` ideas. */
  ideas_limit: Schema.Struct({ max: Schema.Int }),
  /**
   * 03 §18.2 `websearch.*`: `unknown_service` = the server lists no search service with this `id`; `config_unavailable`
   * = own's global config file is not there to write (`OPENCODE_CONFIG_DIR` unset) or is not valid JSONC.
   */
  websearch_unavailable: Schema.Struct({
    reason: Schema.Literals(["unknown_service", "config_unavailable"]),
    id: optional(Schema.String),
  }),
  /** 02 §3.9: voice input is off, or the selected service has no voice key in the vault. */
  voice_unavailable: Schema.Struct({ reason: Schema.Literals(["disabled", "key_missing"]), provider: Voice.Provider }),
  /** 02 §3.9: the key is empty after trimming or holds whitespace or control characters. */
  voice_key_invalid: Schema.Struct({}),
  /** 02 §9.2 (SP): a web search service's key is empty after trimming or holds whitespace or control characters. */
  websearch_key_invalid: Schema.Struct({}),
  /** 02 §3.9: the recording is empty, not base64, larger than `Voice.MAX_AUDIO_BYTES` or longer than `MAX_SECONDS`. */
  voice_audio_invalid: Schema.Struct({
    reason: Schema.Literals(["empty", "encoding", "too_large", "too_long"]),
    max: optional(Schema.Finite),
  }),
  /** 02 §3.9: the service refused or failed. Never carries the audio, the text or the service's body. */
  voice_failed: Schema.Struct({
    provider: Voice.Provider,
    reason: Voice.Failure,
    status: optional(Schema.Int),
    retryable: Schema.Boolean,
  }),
  /**
   * 03 §5.1 기본 대화 폴더: `path` cannot be the default conversation folder or could not be created or written
   * (`ConversationFolder.Problem`). `conversationFolder.set` stores nothing then; `ensure` creates no session folder.
   */
  conversation_folder_unavailable: Schema.Struct({ reason: ConversationFolder.Problem, path: Schema.String }),
  /** 03 §18.3 폴더 열기 시작 위치: `path` cannot be where the folder picker starts; nothing is stored. */
  folder_picker_unavailable: Schema.Struct({ reason: ConversationFolder.PickerProblem, path: Schema.String }),
  /**
   * 03 §18.3 폴더 열기: `path` cannot be listed (`ConversationFolder.ListProblem`); `owner` names a `denied` folder's
   * owner where the system says it.
   */
  folder_list_unavailable: Schema.Struct({
    reason: ConversationFolder.ListProblem,
    path: Schema.String,
    owner: optional(Schema.String),
  }),
  /** 03 §18.3 `새 폴더`: nothing was made (`ConversationFolder.CreateProblem`); `path` is the folder it would have been. */
  folder_create_unavailable: Schema.Struct({ reason: ConversationFolder.CreateProblem, path: Schema.String }),
  /** 01 §13 에이전트가 못 여는 파일·폴더 (PP): `path` cannot join the user's list; nothing is stored. */
  protected_path_invalid: Schema.Struct({ reason: ProtectedPaths.Problem, path: Schema.String }),
  /**
   * 03 §18.14 (SM): another server own added already has this name where this one would run (both everywhere, or
   * one everywhere and one in a project, or both in folders inside each other). Core would keep only one of them.
   */
  mcp_name_taken: Schema.Struct({ name: Schema.String }),
  /** 03 §18.14 (SM): own added no server with this id (removed meanwhile). */
  mcp_not_found: Schema.Struct({ id: Schema.String }),
  /** 03 §18.14 (SM): a value left out to keep the stored one names a variable or header nothing is stored for. */
  mcp_secret_missing: Schema.Struct({ name: Schema.String }),
  /**
   * 03 §18.14 (SM): `url` (not an http or https address, or a new server without one), `directory` (a project folder
   * that is not absolute), `test` (neither a saved server nor a form to test), `pick` (a key the scan did not give),
   * `args` (the command or an argument names a `${NAME}` the server stores no environment value for).
   */
  mcp_invalid: Schema.Struct({ field: Schema.Literals(["url", "directory", "test", "pick", "args"]) }),
  /**
   * 03 §18.14 (SM 찾아서 설치): the MCP Registry did not answer (`offline`: no connection or no answer in time),
   * answered an error (`status`), answered something that is not a server list (`invalid`), or is not asked from this
   * service (`disabled`: a test service given other endpoints but no registry of its own).
   */
  mcp_registry_unavailable: Schema.Struct({
    reason: Schema.Literals(["offline", "status", "invalid", "disabled"]),
    status: optional(Schema.Int),
  }),
  /**
   * 04 §13 (MH): a `mcp.host.*` method asked of this PC's own service: those are an SSH host's (its own installed
   * servers); this PC's are `mcp.*`.
   */
  mcp_host_only: Schema.Struct({ method: Schema.String }),
  /**
   * 02 §7.1.1 리셋권: only ChatGPT subscription (`codex`) accounts have reset credits; Sign in with ChatGPT, Claude
   * and API key accounts answer this without any upstream request.
   */
  not_supported: Schema.Struct({ kind: Schema.String }),
  /**
   * 02 §7.1.1: the account's login is not usable as it is, and `cause` says why (the screen names it). Reset credits
   * never refresh a token; a conversation on the account or `다시 로그인` does.
   */
  credential_not_ready: Schema.Struct({ accountID: AccountID, cause: CredentialCause }),
  /**
   * 02 §7.1.1: ChatGPT did not answer (`timeout`, `network`), answered an error (`status`) or something else
   * (`invalid`). `retryable`: the same plan's nonce still works, and a retry sends the same `redeem_request_id`.
   */
  limit_reset_failed: Schema.Struct({
    reason: Schema.Literals(["timeout", "network", "status", "invalid"]),
    status: optional(Schema.Int),
    retryable: Schema.Boolean,
  }),
  /**
   * 03 §19.6.1 (SG): `skillset.switch` refused, nothing stored: a project folder (`directory`) or a skill folder
   * (`folder`) that is not absolute, no change and no scope (`changes`), or more switches or scopes than are kept
   * (`changes`, `scopes`: `OwnSkillset.MAX_SWITCHES`, `MAX_SCOPES`).
   */
  skillset_invalid: Schema.Struct({ field: Schema.Literals(["directory", "folder", "changes", "scopes"]) }),
  /** 16 (GH): own connected no GitHub account with this id (removed meanwhile). */
  github_not_found: Schema.Struct({ id: Schema.String }),
  /**
   * 16 §4 (GH): GitHub refused the token (`status` 401 or 403) or named another user than the account's (`mismatch`,
   * `github.update{token}` only). Nothing is stored.
   */
  github_token_invalid: Schema.Struct({ status: optional(Schema.Int), mismatch: optional(Schema.Boolean) }),
  /** 16 (GH): GitHub did not answer (`offline`), answered an error (`status`) or something else (`invalid`). */
  github_unavailable: Schema.Struct({
    reason: Schema.Literals(["offline", "status", "invalid"]),
    status: optional(Schema.Int),
  }),
  /**
   * 16 (GH): `label` (taken by another account), `directory` (not an absolute folder), `session` (no such
   * conversation), `account` (a choice names no account), `client_id` (a browser login needs the user's own app's
   * client ID first), `server` (a local server without a command, or the hosted server for a GitHub Enterprise site).
   */
  github_invalid: Schema.Struct({
    field: Schema.Literals(["label", "directory", "session", "account", "client_id", "server"]),
  }),
  /**
   * 05 §20 (UPD): own runs no update for this component now: `manual` (its steps are on the page: administrator
   * rights, bundled, no updater …) or `missing` (not installed; own never installs it).
   */
  tool_not_updatable: Schema.Struct({
    component: Schema.String,
    reason: Schema.Literals(["manual", "missing"]),
  }),
  /** 05 §20 (UPD): another update is still running (`id`); one runs at a time. */
  tool_busy: Schema.Struct({ id: Schema.String }),
  /** 05 §20 (UPD): no update with this id in this service run (a restarted service forgets them). */
  tool_job_not_found: Schema.Struct({ id: Schema.String }),
  /**
   * 02 §9.7 곁질문: no side question here. `session`: the conversation is gone; `route`: its model's route cannot answer
   * one without disturbing the conversation (the message names it, in Korean).
   */
  side_unavailable: Schema.Struct({ reason: Schema.Literals(["session", "route"]), detail: optional(Schema.String) }),
  /** 02 §9.7: no side thread with this id in the conversation (removed, or its list dropped the oldest). */
  side_not_found: Schema.Struct({ threadID: Schema.String }),
  /** 02 §9.7: the conversation already waits for `Side.RUNNING_MAX` answers, or this thread's answer still runs. */
  side_busy: Schema.Struct({ max: Schema.Number }),
})

export type Name = keyof typeof data

/** Adds Standard Schema `~standard` so the map is usable in an `Rpc.PortableDefinition`; values stay Effect schemas. */
function portable<const Schemas extends Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>>(schemas: Schemas) {
  // Since effect 4.0.6 toStandardSchemaV1 returns a copy with `~standard` instead of changing the schema in place.
  // SAFETY: one converted entry per key of `schemas`, each the type toStandardSchemaV1 returns for it.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, Schema.toStandardSchemaV1(schema)]),
  ) as { readonly [K in keyof Schemas]: ReturnType<typeof Schema.toStandardSchemaV1<Schemas[K]>> }
}

/** The error map of one method: the listed types plus `internal_error`, which every handler may return. */
export function pick<const Names extends ReadonlyArray<Name>>(...names: Names) {
  // SAFETY: The entries are exactly the requested names plus internal_error, taken from `data`.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    [...names, "internal_error" as const].map((name): [Name, Schema.Top] => [name, data[name]]),
  ) as {
    readonly [K in Names[number] | "internal_error"]: (typeof data)[K]
  }
}
