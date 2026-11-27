/**
 * RPC `own.import` (09 §5): finding, listing, reading and searching the conversations other tools (Codex, Claude Code)
 * left on this PC (I1, 찾기·보기), and moving one into a new own session (I2, 옮기기: `migrate.*`, `jobs.list`, the
 * `job.*` events). Exported as `@own/protocol/rpc-import`; own-import registers it (`Portable.definition`) and own-web
 * calls it. The scope and location tables are plain objects in `@own/protocol/rpc-import-routing`. A client names a
 * conversation by `SourceRef` only: no input carries a path of another tool's files (09 §2.1). The session metadata
 * own.import writes (09 §4.7) is {@link Metadata}.
 */
export * as OwnImport from "./rpc-import.js"

import { ID, META_KEY } from "./rpc-import-routing.js"
import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Rpc } from "@opencode/schema/rpc"
import { NonNegativeInt, PositiveInt, optional, statics } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { AccountID } from "./account-id.js"
import { Estimate } from "./estimate.js"
import { EpochMillis, EventID, NonNegative, Nonce, ulid } from "./id.js"

/**
 * The RPC id; own-import is its only registrant (09 §5.1). Its events come from one instance at a time: the control
 * Location's, else the oldest live one (09 §5.3); consumers de-duplicate on `eventId`.
 */
export { ID, META_KEY, marked } from "./rpc-import-routing.js"

const empty = Schema.Struct({})
const Text = Schema.NonEmptyString

// ---------------------------------------------------------------------------------------------------------------
// Sources (09 §2.1, §5.2)

/** The tools v1 reads (IM-D1). */
export const Kind = Schema.Literals(["codex", "claude-code"]).annotate({ identifier: "OwnImport.Kind" })
export type Kind = typeof Kind.Type

/** Ids are tokens without path separators, so no input can name a file of another tool. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** A root's id as `sources.list` gives it, stable while the root is configured. Never a path. */
export const RootID = Schema.String.check(Schema.isPattern(TOKEN), Schema.isMaxLength(64)).pipe(
  Schema.brand("OwnImport.RootID"),
  Schema.annotate({ identifier: "OwnImport.RootID" }),
)
export type RootID = typeof RootID.Type

/**
 * The tool's own id of a conversation: a Codex thread id or a Claude Code session id. A Claude Code sub-agent
 * conversation joins its parent's id and its agent id with `:`. Never a path.
 */
export const SourceID = Schema.String.check(Schema.isPattern(TOKEN), Schema.isMaxLength(256)).pipe(
  Schema.brand("OwnImport.SourceID"),
  Schema.annotate({ identifier: "OwnImport.SourceID" }),
)
export type SourceID = typeof SourceID.Type

/**
 * Which conversations a method reaches (09 §2.2, §5.5): `folder` (the default) those of the project of the input's
 * `directory`; `all` every conversation the index knows on this PC (the `모든 폴더` view), which only this PC's windows
 * may ask for (`OwnImportRouting.scopeOf` makes it `local`).
 */
export const Reach = Schema.Literals(["folder", "all"]).annotate({ identifier: "OwnImport.Reach" })
export type Reach = typeof Reach.Type

/** One conversation of another tool (09 §5.2): own-import resolves it to a file through its index and allowlist. */
export interface SourceRef extends Schema.Schema.Type<typeof SourceRef> {}
export const SourceRef = Schema.Struct({ kind: Kind, rootID: RootID, id: SourceID }).annotate({
  identifier: "OwnImport.SourceRef",
})

/**
 * Why a conversation cannot be read (09 §2.8, §5.4). `missing`: its file is gone (e.g. a Codex thread whose rollout
 * was deleted); `decode_failed`: not the tool's format; `too_large`: over the size limits (IG4); `path_denied`: its
 * real path leaves the root or is not on the allowlist (09 §2.1); `locked`: the file cannot be opened now.
 */
export const Unreadable = Schema.Literals(["missing", "decode_failed", "too_large", "path_denied", "locked"]).annotate({
  identifier: "OwnImport.Unreadable",
})
export type Unreadable = typeof Unreadable.Type

/**
 * Why a root is not available. `missing`: no such folder; `unreadable`: it cannot be listed; `path_denied`: not a
 * local folder, or a folder own never reads (09 §2.1).
 */
export const RootProblem = Schema.Literals(["missing", "unreadable", "path_denied"]).annotate({
  identifier: "OwnImport.RootProblem",
})
export type RootProblem = typeof RootProblem.Type

/** A root added in 설정 > 다른 도구 > `찾을 곳 더하기` (09 §2.1), e.g. an old codex-multi-provider profile home. */
export interface ExtraRoot extends Schema.Schema.Type<typeof ExtraRoot> {}
export const ExtraRoot = Schema.Struct({ kind: Kind, directory: Text }).annotate({ identifier: "OwnImport.ExtraRoot" })

/**
 * How a root came to be (SK2, 2026-10-24): `default` the folder under the user profile, `env` `$CODEX_HOME` or
 * `$CLAUDE_CONFIG_DIR`, `option` the plugin option `roots` (tests, source runs), `added` `찾을 곳 더하기`, `profile` a
 * codex-multi-provider account home found through its `state.json` (skills only, 09 §9.1).
 */
export const RootOrigin = Schema.Literals(["default", "env", "option", "added", "profile"]).annotate({
  identifier: "OwnImport.RootOrigin",
})
export type RootOrigin = typeof RootOrigin.Type

/** The codex-multi-provider account a root is the home of (`profiles\<id>\codex`), with its alias when it has one. */
export interface RootAccount extends Schema.Schema.Type<typeof RootAccount> {}
export const RootAccount = Schema.Struct({
  app: Schema.Literal("codex-multi-provider"),
  id: Schema.String,
  alias: optional(Schema.String),
}).annotate({ identifier: "OwnImport.RootAccount" })

/** Where own-import looks: the default roots (`$CODEX_HOME`, `$CLAUDE_CONFIG_DIR` or the profile folders) and added ones. */
export interface Root extends Schema.Schema.Type<typeof Root> {}
export const Root = Schema.Struct({
  rootID: RootID,
  kind: Kind,
  /** What the list and settings show for the root. */
  label: Schema.String,
  /** The root folder. */
  directory: Text,
  /** One of `extraRoots` (`sources.configure` replaces those); default roots are not. */
  added: Schema.Boolean,
  available: Schema.Boolean,
  problem: optional(RootProblem),
  /** Conversations found under the root; absent until it was scanned. */
  sessions: optional(NonNegativeInt),
  /** How the root came to be (SK2); absent from older services. */
  origin: optional(RootOrigin),
  /** A codex-multi-provider account home (found, or added by hand). */
  account: optional(RootAccount),
  /**
   * `skills.list` only: the root's `skills` folder is the same folder as this other root's (a junction or a link of
   * it, by real path), so its skills are listed once, under that root.
   */
  sharedWith: optional(RootID),
  /** `skills.list` only: the root's `skills` folder links to this folder outside any root; it is not read (shown). */
  skillsTarget: optional(Text),
}).annotate({ identifier: "OwnImport.Root" })

const Roots = Schema.Struct({ roots: Schema.Array(Root) }).annotate({ identifier: "OwnImport.Roots" })

// ---------------------------------------------------------------------------------------------------------------
// Read models (09 §2.3, §3, §5.2)

/** What this build can do. I1 offers `view` and `search`; `migrate` appears once I2 is complete, `skills` with 09 §9. */
export const Feature = Schema.Literals(["view", "search", "migrate", "skills"]).annotate({
  identifier: "OwnImport.Feature",
})
export type Feature = typeof Feature.Type

/** `health` result. It never touches the roots (release smoke calls only this method). */
export interface Health extends Schema.Schema.Type<typeof Health> {}
export const Health = Schema.Struct({
  version: Schema.String,
  features: Schema.Array(Feature),
  /** The scan Worker runs. It starts on the first `sources.list` or `sessions.list`, never at plugin load (09 §2.3). */
  workerReady: Schema.Boolean,
}).annotate({ identifier: "OwnImport.Health" })

/** How a conversation was imported (09 §4.3): moved as it was, or with its older part summarized. */
export const Mode = Schema.Literals(["full", "summary"]).annotate({ identifier: "OwnImport.Mode" })
export type Mode = typeof Mode.Type

/** An own session imported from the conversation (`가져옴`, 09 §4.7). */
export interface Imported extends Schema.Schema.Type<typeof Imported> {}
export const Imported = Schema.Struct({
  sessionID: SessionID,
  mode: Mode,
  importedAt: EpochMillis,
  /** Turns the source gained since, while its imported turns still hash the same (`원본에 새 턴 N개`). */
  newTurns: optional(PositiveInt),
}).annotate({ identifier: "OwnImport.Imported" })

/** A model the conversation used, as the tool recorded it. */
export interface SourceModel extends Schema.Schema.Type<typeof SourceModel> {}
export const SourceModel = Schema.Struct({ provider: optional(Schema.String), id: Text }).annotate({
  identifier: "OwnImport.SourceModel",
})

/** One list row (09 §5.2, §6). Titles and first prompts live in own-import's memory only (09 §2.3). */
export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  ref: SourceRef,
  /** By the 09 §2.3 title order, ending with the first user line. */
  title: Schema.String,
  /** The first real user request, at most 120 characters (the row's second line). */
  firstPrompt: optional(Schema.String),
  /**
   * The client that wrote it, as the tool records it (Codex `source`: `cli`, `vscode`, `exec`, …; Claude Code
   * `entrypoint`); `null` when not recorded. Codex `exec` rows are listed only with `include.exec`.
   */
  app: Schema.NullOr(Schema.String),
  /** The last working folder, as the tool wrote it. */
  cwd: Schema.String,
  /** `false`: `폴더 없음`, and the import location defaults to the project root (09 §2.2). */
  folderExists: Schema.Boolean,
  branch: optional(Schema.String),
  /** Models in order of use, the last one last (`원래: <모델>`). */
  models: Schema.Array(SourceModel),
  /** Tool versions seen (Codex `cli_version`, Claude Code `version`), for the view header and provenance (09 §2.8). */
  versions: Schema.Array(Schema.String),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  /** Compactions the tool made, as far as known (exact once the conversation was parsed in full). */
  compactions: NonNegativeInt,
  /** Sub-agent conversations folded under this one. */
  subagents: NonNegativeInt,
  /** The tool wrote it within the last 2 minutes (`진행 중일 수 있음`, 09 §2.5). */
  live: Schema.Boolean,
  imported: Schema.Array(Imported),
  /** `false`: `읽을 수 없음` with `problem`; the rest of the list is unaffected (09 §2.8). */
  readable: Schema.Boolean,
  problem: optional(Unreadable),
  /** Set on a sub-agent conversation: the conversation the list folds it under (09 §2.5, §6). */
  parent: optional(SourceRef),
  /** A Codex archived thread, listed only with `include.archived`. */
  archived: Schema.Boolean,
  /**
   * A Claude Desktop SSH session (`projects/ssh-*`): its cwd is on another computer, so it is listed in scope `all`
   * only, as `다른 컴퓨터` (09 §2.2).
   */
  otherComputer: Schema.Boolean,
}).annotate({ identifier: "OwnImport.Summary" })

/** Where the tool compacted: `foreign` keeps its summary text, `codex-remote` an encrypted one (09 §2.4). */
export const CheckpointKind = Schema.Literals(["foreign", "codex-remote"]).annotate({
  identifier: "OwnImport.CheckpointKind",
})
export type CheckpointKind = typeof CheckpointKind.Type

/** A turn of the outline: its 0-based index (the screen shows index + 1), first user line and time. */
export interface OutlineTurn extends Schema.Schema.Type<typeof OutlineTurn> {}
export const OutlineTurn = Schema.Struct({
  index: NonNegativeInt,
  firstLine: Schema.String,
  time: EpochMillis,
}).annotate({ identifier: "OwnImport.OutlineTurn" })

/** A compaction place: before step `step` of turn `turn`, mid-turn included (09 §2.4, §3 자리 표시). */
export interface OutlineCheckpoint extends Schema.Schema.Type<typeof OutlineCheckpoint> {}
export const OutlineCheckpoint = Schema.Struct({
  turn: NonNegativeInt,
  step: NonNegativeInt,
  kind: CheckpointKind,
}).annotate({ identifier: "OwnImport.OutlineCheckpoint" })

/** A sub-agent conversation, opened in the same view; `turn`: where it started, when known. */
export interface OutlineChild extends Schema.Schema.Type<typeof OutlineChild> {}
export const OutlineChild = Schema.Struct({
  ref: SourceRef,
  title: optional(Schema.String),
  turn: optional(NonNegativeInt),
}).annotate({ identifier: "OwnImport.OutlineChild" })

/** The view's turn outline (09 §3). For a `.zst` conversation it grows until `outlineComplete` (09 §2.8). */
export interface Outline extends Schema.Schema.Type<typeof Outline> {}
export const Outline = Schema.Struct({
  turns: Schema.Array(OutlineTurn),
  checkpoints: Schema.Array(OutlineCheckpoint),
  children: Schema.Array(OutlineChild),
  /** Turns the tool rolled back (`되돌린 턴 N개`, Codex `thread_rolled_back`). */
  rolledBack: NonNegativeInt,
  /** Abandoned branches of an edit or rewind (`다른 갈래 N개`, Claude Code). */
  branches: NonNegativeInt,
  /** Token estimate (`Token.estimate`) of the turns read so far: the view header's size (09 §2.3). */
  tokens: NonNegativeInt,
  /** Records of an unknown kind, skipped (`알 수 없는 형식 일부`, 09 §2.8). */
  unknownRecords: NonNegativeInt,
  /** The conversation whose beginning this one continues (Codex `history_base`, `앞부분은 <부모> 대화`, 09 §2.5). */
  base: optional(SourceRef),
}).annotate({ identifier: "OwnImport.Outline" })

/** An opaque paging cursor from the previous answer. */
export const Cursor = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)).annotate({
  identifier: "OwnImport.Cursor",
})

/** A search hit: the turn and a snippet of at most 160 characters around the match (09 §3 검색). */
export interface Hit extends Schema.Schema.Type<typeof Hit> {}
export const Hit = Schema.Struct({
  ref: SourceRef,
  turn: NonNegativeInt,
  snippet: Schema.String.check(Schema.isMaxLength(160)),
}).annotate({ identifier: "OwnImport.Hit" })

const Query = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))

// ---------------------------------------------------------------------------------------------------------------
// Migration (09 §4, §5.2): plans, jobs and what an imported session records

/** A migration job (`job_<ulid>`): one per service at a time (09 §4.8). */
export const JobID = Schema.String.check(Schema.isPattern(/^job_[0-9A-Za-z]+$/), Schema.isMaxLength(64)).pipe(
  Schema.brand("OwnImport.JobID"),
  Schema.annotate({ identifier: "OwnImport.JobID" }),
  statics((schema) => ({ create: () => schema.make("job_" + ulid()) })),
)
export type JobID = typeof JobID.Type

/** How `요약해서 이어가기` summarizes the older part: `llm` (이어 갈 모델로 요약) or `brief` (LLM 없이, 09 §4.4). */
export const SummarySource = Schema.Literals(["llm", "brief"]).annotate({ identifier: "OwnImport.SummarySource" })
export type SummarySource = typeof SummarySource.Type

/**
 * What stands right before the model-visible part of an imported session (09 §4.2, §4.4): the tool's own compaction
 * (`foreign`), the program checkpoint `briefAt(x)` past a Codex remote compaction (`codex-remote`), an LLM summary
 * (`llm`) or the LLM-free one (`brief`).
 */
export const Checkpoint = Schema.Literals(["foreign", "codex-remote", "llm", "brief"]).annotate({
  identifier: "OwnImport.Checkpoint",
})
export type Checkpoint = typeof Checkpoint.Type

/** Records left out per kind of the transcript model (09 §2.7, §2.8 `DropKind`), for display. */
export const Dropped = Schema.Record(Schema.String, NonNegativeInt).annotate({ identifier: "OwnImport.Dropped" })
export type Dropped = typeof Dropped.Type

/** `sha256` (hex) of the normalized transcript of the imported turns (09 §4.7). */
export const ContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).annotate({
  identifier: "OwnImport.ContentHash",
})

/**
 * Why a mode row cannot be chosen (09 §4.3, §4.5, §4.6): `fits` (nothing to summarize), `does_not_fit` (too big for
 * the window as it is), `quota_insufficient` (the estimate passes what the target account has left),
 * `native_compaction` (the summarizer answers without summary text), `same_company_subscription` (R4: another
 * subscription of the target's company would summarize), `account_not_ready` (the account cannot run now).
 */
export const Reason = Schema.Literals([
  "fits",
  "does_not_fit",
  "quota_insufficient",
  "native_compaction",
  "same_company_subscription",
  "account_not_ready",
]).annotate({ identifier: "OwnImport.Reason" })
export type Reason = typeof Reason.Type

/** What the dialog warns about (09 §5.2). */
export const Warning = Schema.Literals([
  /** The tool wrote it within the last two minutes: only what is there now is imported. */
  "source_live",
  /** Its last working folder is gone; the location defaults to the project root (09 §2.2). */
  "source_folder_missing",
  /** No measured Z for the target slot yet: the default is used (09 §4.3). */
  "z_unknown",
  /** The summary input passes the summarizer's budget: core leaves out older exchanges (`size.omitted`, 09 §4.3). */
  "compaction_may_truncate",
  "images_dropped",
  /** Records of an unknown kind were skipped (09 §2.8). */
  "unknown_records",
  /** The target belongs to another company than the source tool (09 §4.5). */
  "cross_company",
  /** The Codex `history_base` prefix could not be read in full (09 §2.5). */
  "history_base_partial",
  /**
   * The chosen row's estimate passes what the target account has left of its 5-hour or weekly window (09 §4.6). Until
   * own.accounts calibrates `k_u` (02 §7.6) its percent impact is unknown (`cost.quota.state: "calibrating"`), so in
   * practice this reports a window already used up.
   */
  "quota_insufficient",
  /** `agents.compaction.model` summarizes instead of the target (09 §4.5). */
  "summarizer_overridden",
  /** The body passes its budget: the oldest turns the model does not see are not stored (09 §2.8, `store`). */
  "import_too_large",
  /** The import location is not the folder the list was opened in (09 §2.2). */
  "location_differs",
]).annotate({ identifier: "OwnImport.Warning" })
export type Warning = typeof Warning.Type

/** Where the tokens of a mode row go, shown above the button of every mode (09 §4.5 동의와 전송 안내). */
export interface Send extends Schema.Schema.Type<typeof Send> {}
export const Send = Schema.Struct({
  /** Tokens sent now, to summarize (LLM summary only; else 0). */
  now: NonNegativeInt,
  /** Tokens sent with the first message. */
  withFirst: NonNegativeInt,
  /** The account that receives them; `null` for a target that is not an own account (e.g. a local model). */
  accountID: Schema.NullOr(AccountID),
  /** That account's company (its canonical provider id, `Preset.company`); `null` for a local model. */
  company: Schema.NullOr(Schema.String),
  /** Another company than the source tool's (`다른 회사`, `cross_company`), for `now` or `withFirst`. */
  crossCompany: Schema.Boolean,
  /**
   * Where `now` goes when not to the receiver above: the summarizer `agents.compaction.model` names instead of the
   * target (`summarizer_overridden`, 09 §4.5), with its account (`null` when it is not an own account) and company
   * (`null` for a local model). Absent when the target summarizes or nothing is sent now.
   */
  nowTo: optional(Schema.Struct({ accountID: Schema.NullOr(AccountID), company: Schema.NullOr(Schema.String) })),
}).annotate({ identifier: "OwnImport.Send" })

/** A mode row's costs in account units (09 §4.6); `null` when unknown (`알 수 없음`) or not applicable. */
export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  /** The summary request (LLM summary only). */
  summary: Schema.NullOr(Estimate.Delta),
  /** The first follow-up request, cold. */
  first: Schema.NullOr(Estimate.Delta),
  /** Each later request, the same prefix read from the cache. */
  perRequest: Schema.NullOr(Estimate.Delta),
  /** `곧 자동 압축 예상`: the compaction core would run soon after (display only, never a threshold). */
  autoCompactSoon: Schema.NullOr(Estimate.Delta),
  quota: Schema.NullOr(Estimate.QuotaImpact),
}).annotate({ identifier: "OwnImport.Cost" })

/** One row of the dialog's 방식 (09 §4.3 table). */
export interface ModeOption extends Schema.Schema.Type<typeof ModeOption> {}
export const ModeOption = Schema.Struct({
  mode: Mode,
  /** `summary` rows only. */
  source: optional(SummarySource),
  available: Schema.Boolean,
  /** The row the dialog selects first (처음 값). */
  recommended: Schema.Boolean,
  /** Why the row cannot be chosen. */
  reason: optional(Reason),
  send: Send,
  cost: Cost,
}).annotate({ identifier: "OwnImport.ModeOption" })

/**
 * `migrate.plan` result (09 §5.2). Token sizes use the P-016 estimate (`Token.estimate`); the ratio to the target's
 * ceiling decides alone, with no other threshold (09 §4.3, IG9).
 */
export interface Plan extends Schema.Schema.Type<typeof Plan> {}
export const Plan = Schema.Struct({
  /** Single use, 10 minutes (09 §4.8); `migrate.execute` runs this plan's mode. */
  nonce: Nonce,
  expiresAt: EpochMillis,
  /** The new session's title. */
  title: Schema.String,
  /** Turns the import takes (up to `upToTurn`). */
  turns: NonNegativeInt,
  /** Where the session goes: by default the last working folder, else the project root (09 §2.2). */
  location: Schema.Struct({
    directory: Text,
    branch: optional(Schema.String),
    /** Not the folder the list was opened in (`location_differs`). */
    differsFromList: Schema.Boolean,
  }),
  /** Where the model-visible part starts (09 §4.1). */
  boundary: Schema.Struct({
    /** The checkpoint's place, before step `step` of turn `turn` (0-based, mid-turn too); `null`: from the start. */
    at: Schema.NullOr(Schema.Struct({ turn: NonNegativeInt, step: NonNegativeInt })),
    checkpoint: Schema.NullOr(CheckpointKind),
    /** Compactions the tool made in the imported turns. */
    sourceCompactions: NonNegativeInt,
  }),
  size: Schema.Struct({
    /** `E(V)`: the model-visible part as stored. */
    visible: NonNegativeInt,
    /** The target slot's system and tools (09 §4.3, `estimate.request`). */
    Z: NonNegative,
    zSource: Schema.Literals(["measured", "default"]),
    /** `x`: one exchange on the target slot. */
    exchange: NonNegative,
    /** The target's window and `Compaction.ceiling` of it (01 R16). */
    window: PositiveInt,
    ceiling: PositiveInt,
    /** `r = (Z + E(V) + notice) / ceiling` (`이 모델 창의 62%`). */
    ratio: NonNegative,
    /** `C = ceiling − (Z + |checkpoint| + notice + x)`; negative when even those do not fit. */
    capacity: Schema.Int,
    /** The recent turns kept as they are when the visible part is split (09 §4.3 `tail`). */
    tail: optional(Schema.Struct({ fromTurn: NonNegativeInt, tokens: NonNegativeInt })),
    /** The older part a summary covers (`old`). */
    old: optional(Schema.Struct({ turns: NonNegativeInt, tokens: NonNegativeInt })),
    /** The summary request's input, tool records cut to 1,250 characters (09 §4.4). */
    summaryInput: optional(NonNegativeInt),
    /** Pieces a summary would have needed to fit the summarizer's budget (`compaction_may_truncate`). */
    chunks: optional(PositiveInt),
    /** Older exchanges core would leave out of that summary, approximately (`compaction_may_truncate{omitted≈}`). */
    omitted: optional(NonNegativeInt),
  }),
  /** The model that would write an LLM summary; `overridden`: `agents.compaction.model`, not the target (09 §4.5). */
  summarizer: Schema.NullOr(Schema.Struct({ model: Model.Ref, overridden: Schema.Boolean })),
  modes: Schema.Array(ModeOption),
  /** `원래 대화 전체도 own에 저장` and the body budget (09 §2.8). */
  store: Schema.Struct({
    full: Schema.Boolean,
    bytes: NonNegativeInt,
    budget: PositiveInt,
    /** The oldest turns the model does not see that the budget leaves out (`앞부분 N턴은 저장하지 않음`). */
    trimmedTurns: NonNegativeInt,
  }),
  /** Values the stored text and the summary input show as `[redacted:<label>]` (`비밀 가리기(3개)`). */
  redactions: NonNegativeInt,
  dropped: Dropped,
  warnings: Schema.Array(Warning),
  /** Earlier imports of this conversation (`열기` / `새로 가져오기`, 09 §4.7). */
  existing: Schema.Array(Imported),
}).annotate({ identifier: "OwnImport.Plan" })

/** A job's step (`원본 읽는 중` → `요약 중` → `대화 만드는 중`, 09 §6). `summarizing` comes with an LLM summary only. */
export const JobStep = Schema.Literals(["reading", "summarizing", "importing"]).annotate({
  identifier: "OwnImport.JobStep",
})
export type JobStep = typeof JobStep.Type

/** The running job, so a reopened dialog restores its progress (09 §6 진행). */
export interface Job extends Schema.Schema.Type<typeof Job> {}
export const Job = Schema.Struct({
  jobID: JobID,
  ref: SourceRef,
  step: JobStep,
  startedAt: EpochMillis,
  /** The session the job works on: the hidden helper while `summarizing`, the new session while `importing`. */
  sessionID: optional(SessionID),
}).annotate({ identifier: "OwnImport.Job" })

/** Why the summary failed (09 §4.8); nothing was imported and nothing is retried. */
export const SummaryFailure = Schema.Literals([
  "exhausted",
  "needs_reauth",
  "overflow",
  "interrupted",
  "other",
]).annotate({ identifier: "OwnImport.SummaryFailure" })
export type SummaryFailure = typeof SummaryFailure.Type

/** Why the target cannot take the conversation: not in the catalog, its account cannot run, or it calls no tools. */
export const TargetProblem = Schema.Literals(["unknown_model", "account_not_ready", "no_tools"]).annotate({
  identifier: "OwnImport.TargetProblem",
})
export type TargetProblem = typeof TargetProblem.Type

/** How a job that failed ended (`job.finished.error`): a declared error type, never conversation content. */
export interface JobError extends Schema.Schema.Type<typeof JobError> {}
export const JobError = Schema.Struct({
  type: Schema.Literals([
    "source_not_found",
    "source_unreadable",
    "source_changed",
    "target_unavailable",
    "summary_failed",
    "service_unreachable",
    "internal_error",
  ]),
  message: Schema.String,
  /** `summary_failed` only: its declared data. */
  cause: optional(SummaryFailure),
}).annotate({ identifier: "OwnImport.JobError" })

// ---------------------------------------------------------------------------------------------------------------
// Session metadata `own.import` (09 §4.7). The model never sees metadata, so its times keep the cache safe (01 R8).

/** What an imported session records of its source; `원본 보기` is `{kind, rootID: root, id: sourceID}`. */
export interface ImportMetadata extends Schema.Schema.Type<typeof ImportMetadata> {}
export const ImportMetadata = Schema.Struct({
  v: Schema.Literal(1),
  kind: Kind,
  sourceID: SourceID,
  root: RootID,
  /** The conversation file, a local path (so devices treat the metadata like a session location, 09 §5.5). */
  path: Text,
  title: Schema.String,
  /** The last working folder, as the tool wrote it. */
  cwd: Schema.String,
  models: Schema.Array(SourceModel),
  versions: Schema.Array(Schema.String),
  sourceUpdatedAt: EpochMillis,
  sourceBytes: NonNegativeInt,
  /** Turns imported. */
  turns: NonNegativeInt,
  /** Of the imported turns: `원본에 새 턴 N개` and the execute-time prefix check (09 §4.8). */
  contentHash: ContentHash,
  mode: Mode,
  /** What the stored history starts from; `null`: no boundary, the model sees every imported turn. */
  checkpoint: Schema.NullOr(Checkpoint),
  /** The model that wrote an `llm` checkpoint. */
  summarizer: optional(Model.Ref),
  /** `원래 대화 전체도 own에 저장`: the turns the model does not see are stored in the short shape (09 §4.2). */
  storedFull: Schema.Boolean,
  /** The first turn kept as it is after a summary (09 §4.3 `tail`). */
  tailFromTurn: optional(NonNegativeInt),
  /** Values replaced by `[redacted:<label>]`. */
  redactions: NonNegativeInt,
  dropped: Dropped,
  importedAt: EpochMillis,
}).annotate({ identifier: "OwnImport.ImportMetadata" })

/** A hidden helper session that summarizes for a job (09 §4.4); every own screen hides it (09 §6 숨김). */
export interface HelperMetadata extends Schema.Schema.Type<typeof HelperMetadata> {}
export const HelperMetadata = Schema.Struct({
  v: Schema.Literal(1),
  helper: Schema.Literal(true),
  jobID: JobID,
}).annotate({ identifier: "OwnImport.HelperMetadata" })

/** The value under {@link META_KEY}: a helper or an imported session (a value marked as a helper is a helper). */
export const Metadata = Schema.Union([HelperMetadata, ImportMetadata]).annotate({ identifier: "OwnImport.Metadata" })
export type Metadata = typeof Metadata.Type

const decodeMetadataOption = Schema.decodeUnknownOption(Metadata)

/**
 * A session's `own.import` value when it has one of the two shapes, else `undefined` (never throws). For server-side
 * code: own-web's header badge is first-chunk code and reads the value with its plain helpers (`importOrigin`,
 * `isImportHelper` in src/data/import-rpc.ts) so the schema graph stays out of that chunk (03 §20.2 R5); own.accounts
 * needs only {@link marked}, which counts the key whatever its shape.
 */
export function decodeMetadata(metadata: Readonly<Record<string, unknown>> | undefined) {
  return Option.getOrUndefined(decodeMetadataOption(metadata?.[META_KEY]))
}

export function isHelper(value: Metadata): value is HelperMetadata {
  return "helper" in value
}

// ---------------------------------------------------------------------------------------------------------------
// Skills (09 §9): skills Codex and Claude Code installed on this PC, and skills of a git repository, copied into own's
// global skills folder (`%OPENCODE_CONFIG_DIR%\skills\<id>`). A client names a found skill by its key, never a path.

/** Where a found skill lives: Codex `skills\`, Claude Code `skills\`, or a Claude Code plugin under `plugins\`. */
export const SkillOrigin = Schema.Literals(["codex", "claude-code", "claude-plugin"]).annotate({
  identifier: "OwnImport.SkillOrigin",
})
export type SkillOrigin = typeof SkillOrigin.Type

/** What an own copy was made from: a skill found on this PC ({@link SkillOrigin}) or a git repository. */
export const SkillImportOrigin = Schema.Literals(["codex", "claude-code", "claude-plugin", "git"]).annotate({
  identifier: "OwnImport.SkillImportOrigin",
})
export type SkillImportOrigin = typeof SkillImportOrigin.Type

/** A found skill or a previewed one: a path-free token (09 §9.2). */
export const SkillKey = Schema.String.check(Schema.isPattern(TOKEN), Schema.isMaxLength(64)).pipe(
  Schema.brand("OwnImport.SkillKey"),
  Schema.annotate({ identifier: "OwnImport.SkillKey" }),
)
export type SkillKey = typeof SkillKey.Type

/** Windows device names, which no folder may take. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i

/**
 * The id of an own skill: its folder name under own's skills folder, which core takes as the skill id. Letters,
 * digits, `.`, `_` and `-`, at most 64, not ending in `.` and not a Windows device name.
 */
export const SkillID = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/),
  Schema.makeFilter((id) => !RESERVED.test(id) || "a Windows device name"),
).pipe(Schema.brand("OwnImport.SkillID"), Schema.annotate({ identifier: "OwnImport.SkillID" }))
export type SkillID = typeof SkillID.Type

/**
 * Why own cannot use a skill as it is (09 §9.3), so it is not imported. `no_skill_md`: the folder has no `SKILL.md`;
 * `frontmatter`: its frontmatter is not YAML or `name`/`description` are not text; `frontmatter_language`: the opening
 * `---` names another language (`---js`, `---coffee`, `---json`, 09 §9.12), which gray-matter would run or read as
 * something else, so the file is not read at all; `hooks`, `context_fork`: Claude Code
 * runs hooks or a forked sub-agent for it; `dynamic_context`: its body runs commands (`` !`…` ``) before the model
 * reads it; `skill_variables`: it uses `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}`;
 * `arguments`: it expects `$ARGUMENTS`; `links`: a link inside the folder (or the folder itself) whose target cannot be
 * used: missing, a loop, a device, a network place or a place own never reads (SK2: a link own can copy is not a
 * problem, {@link SkillLink}); `secret_file`: a file named like a login or a key; `too_large`: over 500 files or
 * 20 MiB; `unreadable`: a file could not be read.
 */
export const SkillProblem = Schema.Literals([
  "no_skill_md",
  "frontmatter",
  "frontmatter_language",
  "hooks",
  "context_fork",
  "dynamic_context",
  "skill_variables",
  "arguments",
  "links",
  "secret_file",
  "too_large",
  "unreadable",
]).annotate({ identifier: "OwnImport.SkillProblem" })
export type SkillProblem = typeof SkillProblem.Type

/**
 * What own leaves out of a usable skill (09 §9.3); none of it is part of the instructions the model reads.
 * `allowed_tools`: own asks for permissions as usual instead of pre-approving; `user_invocable`: own lists the skill
 * anyway; `argument_hint`, `codex_interface`: display hints; `model`: the session's model runs it; `when_to_use`: not
 * part of the description own shows the model; `codex_dependencies`: the MCP servers Codex would set up are not;
 * `unknown_fields`: other frontmatter keys (in `ignored`). SK2 (2026-10-24): `left_out_folders`: `node_modules`,
 * `.venv`, `__pycache__` or `.git` inside are neither counted nor copied; `links_copied`: links inside are copied as
 * the files they point to; `claude_only`: a Codex skill uses Claude Code's syntax (`` !`…` ``, `$ARGUMENTS`,
 * `${CLAUDE_…}`, hooks), which Codex leaves as text too, so own reads it as Codex does.
 */
export const SkillNote = Schema.Literals([
  "allowed_tools",
  "user_invocable",
  "argument_hint",
  "model",
  "when_to_use",
  "codex_interface",
  "codex_dependencies",
  "unknown_fields",
  "left_out_folders",
  "links_copied",
  "claude_only",
]).annotate({ identifier: "OwnImport.SkillNote" })
export type SkillNote = typeof SkillNote.Type

/**
 * How the skill's format fits own (09 §9.3). `ok`: copied as it is; `converted`: a Codex skill whose
 * `agents/openai.yaml` turns implicit use off, and own's copy says so with `disable-model-invocation: true` (nothing
 * else changes); `incompatible`: not imported, `problems` says why.
 */
export interface SkillFormat extends Schema.Schema.Type<typeof SkillFormat> {}
export const SkillFormat = Schema.Struct({
  status: Schema.Literals(["ok", "converted", "incompatible"]),
  problems: Schema.Array(SkillProblem),
  notes: Schema.Array(SkillNote),
  /** Frontmatter keys own does not read (`unknown_fields`), at most 20. */
  ignored: Schema.Array(Schema.String),
  /**
   * `too_large` (SK2, 2026-10-25): which limit it passed. `skillMd`: the `SKILL.md`'s size, over 1 MiB (it is not read);
   * `files`: the files counted, over 500 (a local walk stops at 501, so it is a lower bound there); `bytes`: the files'
   * total size, over 20 MiB; `deep`: folders nested deeper than 8.
   */
  large: optional(
    Schema.Struct({
      skillMd: optional(NonNegativeInt),
      files: optional(NonNegativeInt),
      bytes: optional(NonNegativeInt),
      deep: optional(Schema.Boolean),
    }),
  ),
}).annotate({ identifier: "OwnImport.SkillFormat" })

/** A link the user approved copying (SK2): a path-free token of the root, the skill, the link and its target. */
export const LinkKey = Schema.String.check(Schema.isPattern(/^lk-[0-9a-f]{20}$/)).pipe(
  Schema.brand("OwnImport.LinkKey"),
  Schema.annotate({ identifier: "OwnImport.LinkKey" }),
)
export type LinkKey = typeof LinkKey.Type

const ApprovedLinks = Schema.Array(LinkKey).check(Schema.isMaxLength(200))

/**
 * A link (symbolic link or junction) in a found skill, or the skill folder itself as a link (`relative` empty), SK2
 * 2026-10-24. own copies what a link points to, never the link. `scope`: `inside` its root's skill area (or another
 * root's), `known` a folder own already loads skills from (`~/.agents/skills`, `~/.claude/skills`, own's skills folder),
 * `outside` anywhere else on a local drive. `state`: `copy` (copied with the skill, no question), `approve` (an
 * `outside` target, read only after the user approves its `linkKey`: `skills.list`/`skills.import` `approvedLinks`) or
 * `refused` (`reason`: `broken` no target, `cycle` a loop, `special` a device or another kind of file, `network` a share,
 * `denied` a place own never reads: another root's non-skill files, OWN_HOME, `.ssh` and the like, the Windows folder).
 */
export interface SkillLink extends Schema.Schema.Type<typeof SkillLink> {}
export const SkillLink = Schema.Struct({
  /** The link below the skill folder (`/`-separated); empty for the skill folder itself. */
  relative: Schema.String,
  /** Where it points (shown only; never an input). */
  target: Schema.String,
  kind: Schema.Literals(["folder", "file", "other"]),
  scope: optional(Schema.Literals(["inside", "known", "outside"])),
  state: Schema.Literals(["copy", "approve", "refused"]),
  reason: optional(Schema.Literals(["broken", "cycle", "special", "network", "denied"])),
  /** An `outside` link: the token that approves it; approved, the list shows `state: "copy"` and the files. */
  linkKey: optional(LinkKey),
  /** An `outside` link the input approved. */
  approved: optional(Schema.Boolean),
}).annotate({ identifier: "OwnImport.SkillLink" })

/** A skill another tool installed on this PC (`skills.list`, 09 §9.2). */
export interface SkillFound extends Schema.Schema.Type<typeof SkillFound> {}
export const SkillFound = Schema.Struct({
  key: SkillKey,
  origin: SkillOrigin,
  rootID: RootID,
  /** The frontmatter `name`, else the folder name. */
  name: Schema.String,
  description: optional(Schema.String),
  /** The id own's copy gets unless the user renames it: the folder name, cleaned when it is not a valid id. */
  id: SkillID,
  /** The skill's folder (shown, and compared with the loaded skills for `이미 쓰는 중`). */
  directory: Text,
  /** The Claude Code plugin it comes with; `installed` when Claude Code installed that plugin (`plugins\cache`). */
  plugin: optional(
    Schema.Struct({ name: Schema.String, marketplace: optional(Schema.String), installed: Schema.Boolean }),
  ),
  /** One of Codex's bundled skills (`skills\.system`). */
  system: Schema.Boolean,
  files: NonNegativeInt,
  bytes: NonNegativeInt,
  /** Files that look executable (scripts, programs), relative to the folder, at most 50. */
  scripts: Schema.Array(Schema.String),
  format: SkillFormat,
  /** own's copy of this skill; `changed` once the source no longer hashes as it did when copied. */
  imported: optional(Schema.Struct({ id: SkillID, changed: Schema.Boolean })),
  /** SK2 (2026-10-24): the folder below its root (`/`-separated), shown instead of the whole path. */
  relative: optional(Schema.String),
  /** The skill folder's real path (links and junctions resolved): one folder reached twice is one place. */
  real: optional(Text),
  /** The newest modification time of its files (epoch ms). */
  modifiedAt: optional(EpochMillis),
  /** Frontmatter `version` (or `metadata.version`). */
  version: optional(Schema.String),
  /**
   * The content hash (09 §9.4: sorted paths, sizes and bytes) when another found skill has the same id, the skill has
   * an own-import copy, or the list asked for all; links count as the files they point to. Absent for one that cannot
   * be read whole (a problem, an unapproved link).
   */
  hash: optional(Schema.String),
  /** The links in it ({@link SkillLink}), at most 50. */
  links: optional(Schema.Array(SkillLink)),
  /**
   * A Claude Code skill the Claude app synced into `skills\synced\<org>_<account>\` (09 §9.1): the two parts of that
   * folder's name, so a client can name the account.
   */
  synced: optional(Schema.Struct({ folder: Schema.String, org: Schema.String, account: Schema.String })),
}).annotate({ identifier: "OwnImport.SkillFound" })

/** One own skill that own-import copied (`OWN_HOME/state/skill-imports.json`, 09 §9.4). */
export interface SkillImport extends Schema.Schema.Type<typeof SkillImport> {}
export const SkillImport = Schema.Struct({
  id: SkillID,
  origin: SkillImportOrigin,
  name: Schema.String,
  importedAt: EpochMillis,
  /** sha256 over the source's files as copied (sorted relative paths and bytes), before any conversion. */
  hash: Schema.String,
  files: NonNegativeInt,
  /** A local source: its root, its folder below the root (`/`-separated), and the folder (shown). */
  rootID: optional(RootID),
  relative: optional(Schema.String),
  source: optional(Schema.String),
  /** `git`: the repository, the ref asked for (absent: its default branch), the pinned commit, the folder in it. */
  url: optional(Schema.String),
  ref: optional(Schema.String),
  commit: optional(Schema.String),
  folder: optional(Schema.String),
  /**
   * SK2 (2026-10-24): the links outside the root the user approved, each copied as what it pointed to (`target` its
   * real path then); `skills.updates` reads them again only while they still point there.
   */
  links: optional(
    Schema.Array(Schema.Struct({ relative: Schema.String, target: Schema.String, linkKey: optional(LinkKey) })),
  ),
}).annotate({ identifier: "OwnImport.SkillImport" })

/**
 * `상세 보기` of a skill (`skills.detail`, SK2 2026-10-24), read only: its `SKILL.md` frontmatter (every key, values as
 * text) and body, its files with sizes, the content hash and, for own-import's copy, its record and whether the
 * source changed. Nothing is run or rendered here; a client renders the body as untrusted markdown.
 */
export interface SkillDetail extends Schema.Schema.Type<typeof SkillDetail> {}
export const SkillDetail = Schema.Struct({
  name: Schema.String,
  description: optional(Schema.String),
  /** The folder the detail was read from (shown). */
  directory: Text,
  /**
   * Every frontmatter key in file order with its value as YAML-ish text, at most 50 keys of 2,000 characters (a longer
   * value ends in `…`). `omitted` (SK2, 2026-10-25): the value is not shown, `aliases` because its YAML aliases (`*x`)
   * expand past 10,000 values or into a loop, `budget` because the detail's time or size budget ran out before it.
   */
  frontmatter: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      value: Schema.String,
      omitted: optional(Schema.Literals(["aliases", "budget"])),
    }),
  ),
  /** `SKILL.md` after its frontmatter, at most 256 KiB (`truncated`). Absent when it cannot be read. */
  body: optional(Schema.String),
  /**
   * Why `SKILL.md` was not read (SK2, 2026-10-25), absent when it was: `missing`, `too_large` (over 1 MiB, `size` its
   * size) or `unreadable`.
   */
  skillMd: optional(
    Schema.Struct({
      state: Schema.Literals(["missing", "too_large", "unreadable"]),
      size: optional(NonNegativeInt),
    }),
  ),
  truncated: Schema.Boolean,
  /** Its files (`/`-separated) with sizes, at most 500. */
  files: Schema.Array(Schema.Struct({ relative: Schema.String, size: NonNegativeInt })),
  fileCount: NonNegativeInt,
  bytes: NonNegativeInt,
  /** The content hash; absent when the skill cannot be read whole. */
  hash: optional(Schema.String),
  format: optional(SkillFormat),
  links: optional(Schema.Array(SkillLink)),
  /** own-import's copy: its record, and the source now (`same`, `changed`, `source_missing`, `unknown`). */
  imported: optional(
    Schema.Struct({
      record: SkillImport,
      source: Schema.Literals(["same", "changed", "source_missing", "unknown"]),
    }),
  ),
}).annotate({ identifier: "OwnImport.SkillDetail" })

/**
 * A git repository to install from (`URL로 설치`, 09 §9.5): an `https:` URL (`http:` only for a loopback host), no
 * user name or password in it. A GitHub `…/tree/<ref>/<folder>` link gives `ref` and `folder` itself.
 */
export interface SkillRepo extends Schema.Schema.Type<typeof SkillRepo> {}
export const SkillRepo = Schema.Struct({
  url: Text.check(Schema.isMaxLength(2048)),
  ref: optional(Text.check(Schema.isMaxLength(256))),
  /** A folder of the repository (`/`-separated) to look in; default the whole repository. */
  folder: optional(Text.check(Schema.isMaxLength(1024))),
}).annotate({ identifier: "OwnImport.SkillRepo" })

/** A skill of a previewed repository (09 §9.5): its manifest only, the files' names but not their content. */
export interface SkillCandidate extends Schema.Schema.Type<typeof SkillCandidate> {}
export const SkillCandidate = Schema.Struct({
  key: SkillKey,
  name: Schema.String,
  description: optional(Schema.String),
  id: SkillID,
  /** The skill's folder in the repository (`/`-separated). */
  folder: Schema.String,
  /** The marketplace or repository plugin it belongs to. */
  plugin: optional(Schema.String),
  /** Its files (`/`-separated, relative to the folder), at most 200 shown. */
  files: Schema.Array(Schema.String),
  fileCount: NonNegativeInt,
  scripts: Schema.Array(Schema.String),
  format: SkillFormat,
  /** own already has a skill folder with this id; `replaceable` when it is own-import's copy (an update). */
  conflict: optional(Schema.Struct({ replaceable: Schema.Boolean })),
}).annotate({ identifier: "OwnImport.SkillCandidate" })

/** What `URL로 설치` would install (09 §9.5); `skills.install` redeems the nonce at the same pinned commit. */
export interface SkillPreview extends Schema.Schema.Type<typeof SkillPreview> {}
export const SkillPreview = Schema.Struct({
  nonce: Nonce,
  expiresAt: EpochMillis,
  url: Text,
  ref: optional(Schema.String),
  folder: optional(Schema.String),
  /** The commit everything is read from and installed at. */
  commit: Schema.String,
  /** `marketplace`: `.claude-plugin/marketplace.json`; `plugin`: `.claude-plugin/plugin.json`; else `repository`. */
  layout: Schema.Literals(["marketplace", "plugin", "repository"]),
  items: Schema.Array(SkillCandidate),
  /** Marketplace plugins kept in another repository: previewed on their own when the user asks. */
  external: Schema.Array(Schema.Struct({ plugin: Schema.String, repo: optional(SkillRepo) })),
}).annotate({ identifier: "OwnImport.SkillPreview" })

/**
 * Why a repository could not be read (09 §9.5). `git_missing`: no `git` on this PC; `not_found`: no such repository or
 * ref; `no_partial_clone`: the server would send every file before the preview, so own stops; `too_large`: the tree or
 * a skill is over the limits.
 */
export const FetchProblem = Schema.Literals([
  "git_missing",
  "unreachable",
  "not_found",
  "no_partial_clone",
  "timeout",
  "too_large",
  "other",
]).annotate({ identifier: "OwnImport.FetchProblem" })
export type FetchProblem = typeof FetchProblem.Type

/** `업데이트 확인` (09 §9.4): one own copy against its source now. */
export interface SkillUpdate extends Schema.Schema.Type<typeof SkillUpdate> {}
export const SkillUpdate = Schema.Struct({
  id: SkillID,
  state: Schema.Literals(["same", "changed", "source_missing", "unknown"]),
  /** A local source: the key `skills.import` copies it again with. */
  key: optional(SkillKey),
  /** `git`: the commit the ref points at now. */
  commit: optional(Schema.String),
}).annotate({ identifier: "OwnImport.SkillUpdate" })

// ---------------------------------------------------------------------------------------------------------------
// Errors (09 §5.4, 02 §9.4): declared types become HTTP 400; a handler never throws.

export const errors = portable({
  internal_error: Schema.Struct({}),
  /** The input folder is not a working folder of a project core knows. */
  directory_unknown: Schema.Struct({ directory: Schema.String }),
  source_not_found: Schema.Struct({ ref: SourceRef }),
  source_unreadable: Schema.Struct({ ref: SourceRef, reason: Unreadable }),
  /** The planned turns no longer hash the same: the source was rewritten, not only appended to (09 §4.8). */
  source_changed: Schema.Struct({ ref: SourceRef }),
  target_unavailable: Schema.Struct({ model: Model.Ref, reason: TargetProblem }),
  /** Unknown, used or older than 10 minutes. */
  nonce_invalid: Schema.Struct({}),
  /** Another job runs (one per service); `jobID` is that job. */
  job_busy: Schema.Struct({ jobID: JobID }),
  job_not_found: Schema.Struct({ jobID: JobID }),
  /** Ends a job (`job.finished.error`); no method answers it. */
  summary_failed: Schema.Struct({ cause: SummaryFailure }),
  /** own's own service (loopback import, session log) did not answer. */
  service_unreachable: Schema.Struct({}),
  /** own's skills folder is unknown: the service runs without `OPENCODE_CONFIG_DIR` (09 §9.4). */
  skills_unconfigured: Schema.Struct({}),
  /** No found or previewed skill has this key (any more). */
  skill_not_found: Schema.Struct({ key: Schema.String }),
  skill_incompatible: Schema.Struct({ key: Schema.String, problems: Schema.Array(SkillProblem) }),
  /** own has a skill folder `id`; `replaceable` when it is own-import's copy, which `replace: true` overwrites. */
  skill_conflict: Schema.Struct({ id: Schema.String, replaceable: Schema.Boolean }),
  /** No copy own-import made has this id (`skills.remove`, 09 §9.9): a folder own did not make is never removed. */
  skill_not_imported: Schema.Struct({ id: Schema.String }),
  /**
   * SK2: the skill has a link outside its root that the input did not approve (`unapproved`), or an approved link
   * points elsewhere now (`changed`: list again and approve the new target). `linkKeys`: those links.
   */
  skill_links: Schema.Struct({
    key: Schema.String,
    linkKeys: Schema.Array(Schema.String),
    reason: Schema.Literals(["unapproved", "changed"]),
  }),
  /** Not an `https:` git URL (09 §9.5). */
  url_invalid: Schema.Struct({}),
  fetch_failed: Schema.Struct({ reason: FetchProblem }),
})

export type ErrorName = keyof typeof errors

/** Adds Standard Schema `~standard` so the map is usable in an `Rpc.PortableDefinition`; values stay Effect schemas. */
function portable<const Schemas extends Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>>(schemas: Schemas) {
  // Since effect 4.0.6 toStandardSchemaV1 returns a copy with `~standard` instead of changing the schema in place.
  // SAFETY: one converted entry per key of `schemas`, each the type toStandardSchemaV1 returns for it.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, Schema.toStandardSchemaV1(schema)]),
  ) as { readonly [K in keyof Schemas]: ReturnType<typeof Schema.toStandardSchemaV1<Schemas[K]>> }
}

/** The error map of one method: the listed types plus `internal_error`, which every method has. */
function pick<const Names extends ReadonlyArray<ErrorName>>(...names: Names) {
  // SAFETY: the entries are exactly the requested names plus internal_error, taken from `errors`.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    [...names, "internal_error" as const].map((name): [ErrorName, Schema.Top] => [name, errors[name]]),
  ) as { readonly [K in Names[number] | "internal_error"]: (typeof errors)[K] }
}

// ---------------------------------------------------------------------------------------------------------------
// Events (09 §5.3). No event carries conversation content.

export const Origin = Schema.Literals(["global"]).annotate({ identifier: "OwnImport.Origin" })
export type Origin = typeof Origin.Type

const envelope = { eventId: EventID, origin: Origin }

function event<const S extends Schema.ConstraintDecoder<Readonly<Record<string, unknown>>>>(schema: S) {
  return { schema: Schema.toStandardSchemaV1(schema) }
}

export const Events = {
  /**
   * A scan ended, new conversations were found or a provisional folder membership changed (09 §2.3, §2.8).
   * `directories`: the project folders whose lists changed; absent when any may have.
   */
  "index.changed": event(
    Schema.Struct({ ...envelope, directories: optional(Schema.Array(Text)) }).annotate({
      identifier: "OwnImport.Event.IndexChanged",
    }),
  ),
  /** The running job reached a step; `helperSessionID` while `summarizing` (09 §4.4). */
  "job.progress": event(
    Schema.Struct({ ...envelope, jobID: JobID, step: JobStep, helperSessionID: optional(SessionID) }).annotate({
      identifier: "OwnImport.Event.JobProgress",
    }),
  ),
  /** The job ended: `sessionID` is the imported session when it succeeded; `error` when it failed (09 §4.8). */
  "job.finished": event(
    Schema.Struct({
      ...envelope,
      jobID: JobID,
      outcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
      sessionID: optional(SessionID),
      error: optional(JobError),
    }).annotate({ identifier: "OwnImport.Event.JobFinished" }),
  ),
}

// ---------------------------------------------------------------------------------------------------------------
// Definition (09 §5.2 is the only method list)

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
    health: method(empty, Health, pick()),
    "sources.list": method(empty, Roots, pick()),
    /** Replaces the added roots (stored in `OWN_HOME/state/import-sources.json`, 09 §2.1). */
    "sources.configure": method(
      Schema.Struct({ extraRoots: Schema.Array(ExtraRoot).check(Schema.isMaxLength(32)) }),
      Roots,
      pick(),
    ),
    /** Newest first, 50 per page. The first call builds the index and answers within 2 s (09 §2.3, §2.8). */
    "sessions.list": method(
      Schema.Struct({
        /** A working folder of the project; the list is that project's conversations (IM-D3). */
        directory: Text,
        /** `folder` (default): the project's folders; `all`: every conversation, grouped by cwd (09 §2.2). */
        scope: optional(Reach),
        /** Rows hidden by default: sub-agent conversations, Codex `exec` runs and archived threads. */
        include: optional(Schema.Struct({ subagents: Schema.Boolean, exec: Schema.Boolean, archived: Schema.Boolean })),
        /** Title search, in memory; content search is `sessions.search`. */
        query: optional(Query),
        cursor: optional(Cursor),
        /** Default 50; 0 answers only the counts (the sidebar's `새 N개`, 09 §6). */
        limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
      }),
      Schema.Struct({
        items: Schema.Array(Summary),
        /** Rows matching the input on all pages. */
        total: NonNegativeInt,
        /** Top-level, readable conversations of the folder not imported yet (`새 N개`). */
        fresh: NonNegativeInt,
        /** The next page; `null` on the last. */
        cursor: Schema.NullOr(Cursor),
        /** The index is still being built: the items are partial and `index.changed` follows. */
        scanning: Schema.Boolean,
      }),
      pick("directory_unknown"),
    ),
    /** A page of turns as view messages; no server session is created and no LLM is called (09 §3). */
    "sessions.read": method(
      Schema.Struct({
        ref: SourceRef,
        /** A working folder of the project the list was opened for; `ref` must be one of its conversations. */
        directory: Text,
        /** `all`: `ref` may be any conversation the index knows (the `모든 폴더` view, this PC's windows only). */
        scope: optional(Reach),
        /** The first turn of the page (default 0). */
        from: optional(NonNegativeInt),
        /** Turns per page (default 20). */
        count: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
      }),
      Schema.Struct({
        summary: Summary,
        outline: Outline,
        /** `false` while a `.zst` outline still streams (`읽는 중`, 09 §2.8). */
        outlineComplete: Schema.Boolean,
        /** Tool calls as tool parts (v2 renderer names when the input shape matches), checkpoints as compactions. */
        messages: Schema.Array(SessionMessage.Info),
        /** `from` of the next page; absent on the last. */
        next: optional(NonNegativeInt),
      }),
      pick("directory_unknown", "source_not_found", "source_unreadable"),
    ),
    /**
     * Without `ref`, the conversations of `directory`'s project (user and model text only, at most 100 hits in a 5 s
     * budget); with `ref`, that one conversation of the project (tool output included; `scope: "all"` as in
     * `sessions.read`). `complete: false` with `cursor` resumes (`일부만 찾음 · 계속 찾기`, 09 §3).
     */
    "sessions.search": method(
      Schema.Struct({
        directory: Text,
        ref: optional(SourceRef),
        scope: optional(Reach),
        query: Query,
        cursor: optional(Cursor),
        limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
      }),
      Schema.Struct({ hits: Schema.Array(Hit), complete: Schema.Boolean, cursor: optional(Cursor) }),
      pick("directory_unknown", "source_not_found", "source_unreadable"),
    ),
    /**
     * Sizes, modes and costs of moving the conversation onto `target`, which the plan never substitutes (09 §4.3–4.6).
     * No side effect besides the nonce. `mode` and `source` pick the row the nonce runs (default: the recommended
     * one); `storeFull` and `redact` default to `true`.
     */
    "migrate.plan": method(
      Schema.Struct({
        ref: SourceRef,
        /** A working folder of the project the list was opened for; `ref` must be one of its conversations. */
        directory: Text,
        /** `all`: `ref` may be any conversation the index knows (`이 폴더로 가져오기`, this PC's windows only). */
        scope: optional(Reach),
        /** The last turn to import, 0-based (`여기까지`). */
        upToTurn: optional(NonNegativeInt),
        mode: optional(Mode),
        source: optional(SummarySource),
        target: Model.Ref,
        /**
         * The account the user picked for `target` (09 §4.5): several accounts may serve one provider (every Claude
         * account serves `anthropic`), and the plan's account, costs, quota check and send notice are that account's.
         * Absent, or naming no listed account of `target`'s provider: the provider's first listed account.
         */
        accountID: optional(AccountID),
        /** The folder to import into; default the last working folder (09 §2.2). */
        location: optional(Text),
        storeFull: optional(Schema.Boolean),
        /** `false` keeps secrets in the import (IG10): this PC's windows only (`OwnImportRouting.scopeOf`). */
        redact: optional(Schema.Boolean),
      }),
      Plan,
      pick("directory_unknown", "source_not_found", "source_unreadable", "target_unavailable", "service_unreachable"),
    ),
    /** Starts the planned job; progress and the end come as `job.*` events. Only this method calls an LLM. */
    "migrate.execute": method(
      Schema.Struct({ nonce: Nonce }),
      Schema.Struct({ jobID: JobID }),
      pick(
        "source_not_found",
        "source_unreadable",
        "source_changed",
        "target_unavailable",
        "nonce_invalid",
        "job_busy",
        "service_unreachable",
      ),
    ),
    /** Before the final import the helper is stopped and removed; after it `cancelled` is `false` (09 §4.8). */
    "migrate.cancel": method(
      Schema.Struct({ jobID: JobID }),
      Schema.Struct({ cancelled: Schema.Boolean }),
      pick("job_not_found", "service_unreachable"),
    ),
    /** The running job (at most one), so the dialog restores it after a reload (09 §6). */
    "jobs.list": method(empty, Schema.Struct({ jobs: Schema.Array(Job) }), pick()),
    /**
     * Skills Codex and Claude Code installed on this PC, read only, and own-import's copies (09 §9.2). `directory` is
     * own's skills folder; `null` when the service does not know it (no `OPENCODE_CONFIG_DIR`).
     */
    "skills.list": method(
      Schema.Struct({
        /** SK2: links outside the roots the user approved; their skills are read through them (files, format, hash). */
        approvedLinks: optional(ApprovedLinks),
        /** SK2: the content hash of every readable skill, not only of ids found twice (설정 > 스킬's matching). */
        hashes: optional(Schema.Boolean),
        /**
         * SK2 (2026-10-25): the project folder whose loaded skills (core's `GET /api/skill`) are compared by content:
         * `loaded` answers their hashes, and a found skill with the same files is hashed too.
         */
        directory: optional(Text),
      }),
      Schema.Struct({
        directory: Schema.NullOr(Text),
        roots: Schema.Array(Root),
        items: Schema.Array(SkillFound),
        imports: Schema.Array(SkillImport),
        /**
         * With `directory` (SK2, 2026-10-25): the skills core loads there that have the same files (names and sizes)
         * as a found skill, with their content hash (09 §9.4), so a copy of the same content under any id or folder
         * (own's skills folder, `~/.agents/skills`, the project) is `이미 쓰는 중`. Built-in skills have no folder.
         */
        loaded: optional(Schema.Array(Schema.Struct({ id: Schema.String, path: Text, hash: Schema.String }))),
      }),
      pick(),
    ),
    /** Copies a found skill into own's skills folder as `id` (default the found one); `replace` overwrites own's copy. */
    "skills.import": method(
      Schema.Struct({
        key: SkillKey,
        id: optional(SkillID),
        replace: optional(Schema.Boolean),
        /** SK2: the approved links of this skill outside its root ({@link SkillLink}). */
        approvedLinks: optional(ApprovedLinks),
      }),
      Schema.Struct({ id: SkillID, directory: Text }),
      pick("skills_unconfigured", "skill_not_found", "skill_incompatible", "skill_conflict", "skill_links"),
    ),
    /**
     * `상세 보기` (SK2, 2026-10-24), read only: a found skill by `key` (its approved links followed), own-import's copy by
     * `copy`, or a skill core loads in the project of `directory` by its id (`loaded`; the folder is the one core
     * reports, read with the same rules as another tool's skill: no link followed, no login or key file opened).
     */
    "skills.detail": method(
      Schema.Union([
        Schema.Struct({ key: SkillKey, approvedLinks: optional(ApprovedLinks) }),
        Schema.Struct({ copy: SkillID }),
        Schema.Struct({ directory: Text, loaded: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)) }),
      ]),
      SkillDetail,
      pick("skill_not_found", "skills_unconfigured"),
    ),
    /**
     * Reads a git repository's tree and manifests (`marketplace.json`, `plugin.json`, each `SKILL.md`) at one commit,
     * never the other files, and answers what `skills.install` would copy (09 §9.5). Only on the user's request.
     */
    "skills.preview": method(SkillRepo, SkillPreview, pick("skills_unconfigured", "url_invalid", "fetch_failed")),
    /** Downloads and copies the chosen skills of a preview at its commit (`renames`: other ids). */
    "skills.install": method(
      Schema.Struct({
        nonce: Nonce,
        keys: Schema.Array(SkillKey).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        renames: optional(Schema.Array(Schema.Struct({ key: SkillKey, id: SkillID })).check(Schema.isMaxLength(200))),
        replace: optional(Schema.Boolean),
      }),
      Schema.Struct({ installed: Schema.Array(Schema.Struct({ id: SkillID, directory: Text })) }),
      pick(
        "skills_unconfigured",
        "nonce_invalid",
        "skill_not_found",
        "skill_incompatible",
        "skill_conflict",
        "fetch_failed",
      ),
    ),
    /** `업데이트 확인`: each copy against its source; a git source is asked for its ref's commit (network). */
    "skills.updates": method(empty, Schema.Struct({ items: Schema.Array(SkillUpdate) }), pick()),
    /**
     * Removes a copy own-import made (one of `skills.list` `imports`) from own's skills folder, with its record (설정 >
     * 스킬 `지우기`, SM 2026-10-24). Never another folder: the original skill and other tools' folders stay.
     */
    "skills.remove": method(
      Schema.Struct({ id: SkillID }),
      Schema.Struct({ id: SkillID }),
      pick("skills_unconfigured", "skill_not_imported"),
    ),
  },
  events: Events,
})
export type Definition = typeof Definition

export type MethodName = keyof Definition["methods"] & string
export type EventName = keyof Definition["events"] & string

// ---------------------------------------------------------------------------------------------------------------
// Routing (09 §5.5): the tables live in `rpc-import-routing.ts`

/** own.accounts' words (02 §9.1); `local` is never given to a remote device (05 §13.5). */
export const Scope = Schema.Literals(["read", "prompt", "local"]).annotate({ identifier: "OwnImport.Scope" })
export type Scope = typeof Scope.Type

/** Every own.import method goes to the control location (09 §5.2). */
export const Location = Schema.Literals(["control"]).annotate({ identifier: "OwnImport.Location" })
export type Location = typeof Location.Type

/** Typed so that a new method or event cannot be added without a scope, a location or an origin. */
export { MethodScope, MethodLocation, EventScope, EventOrigin } from "./rpc-import-routing.js"
