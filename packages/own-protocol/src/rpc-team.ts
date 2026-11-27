/**
 * RPC `own.team` (06 §2.7): the team mode's methods, events and errors, the registry schemas of 06 §2.4 and the
 * proposal of §3.4. Exported as `@own/protocol/rpc-team`; own-team registers it (`Portable.definition`) and own-web
 * calls it. The scope and location tables are plain objects in `@own/protocol/rpc-team-routing`. own.team never sets
 * or forwards computer use: no input or output here has a computer-use field.
 */
export * as OwnTeam from "./rpc-team.js"

import { ID } from "./rpc-team-routing.js"
import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { Model } from "@opencode/schema/model"
import { NonNegativeInt, PositiveInt, optional, statics } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { AccountID } from "./account-id.js"
import { Estimate } from "./estimate.js"
import { EpochMillis, EventID, Nonce, ULID_PATTERN, ulid } from "./id.js"
import { Preset } from "./preset.js"
import { OwnHarnessRouting } from "./rpc-harness-routing.js"
import { keyedRecord } from "./util.js"

/** The RPC id; own-team is its only registrant and its leader the only event publisher (06 §2.6). */
export { ID } from "./rpc-team-routing.js"

/**
 * `metadata.source` of every prompt and synthetic message own.team sends (main requests, team updates, handoff
 * requests). own.computer-use refuses computer actions in turns started by such a message.
 */
export const PROMPT_SOURCE = "own.team"

const empty = Schema.Struct({})
const Text = Schema.NonEmptyString
/** A repository-relative folder, `/`-separated (`Assets/Textures`). own-team refuses `..`, a leading `/` or `-`. */
const Dir = Schema.NonEmptyString

// ---------------------------------------------------------------------------------------------------------------
// Ids

/** `tm_` + the first 12 hex digits of a hash of the realpath of the git common dir: one team per common dir. */
export const TeamID = Schema.String.check(Schema.isPattern(/^tm_[0-9a-f]{12}$/)).pipe(
  Schema.brand("OwnTeam.TeamID"),
  Schema.annotate({ identifier: "OwnTeam.TeamID" }),
)
export type TeamID = typeof TeamID.Type

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/

/** An area slug (V6): ASCII lower case, digits and hyphens, at most 32; also the area's branch and folder name. */
export const Slug = Schema.String.check(Schema.isPattern(SLUG)).annotate({ identifier: "OwnTeam.Slug" })

/**
 * `ar_<slug>`. Unique within a team only (KV `area:<teamID>:<areaID>`), so every area method also takes `teamID`.
 * Renaming an area changes its name, never its id.
 */
export const AreaID = Schema.String.check(Schema.isPattern(new RegExp(`^ar_${SLUG.source.slice(1)}`))).pipe(
  Schema.brand("OwnTeam.AreaID"),
  Schema.annotate({ identifier: "OwnTeam.AreaID" }),
)
export type AreaID = typeof AreaID.Type

function ulidID<const Brand extends string>(prefix: string, brand: Brand) {
  return Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}${ULID_PATTERN.source.slice(1)}`))).pipe(
    // A generic brand cannot prove it is one literal, which `Schema.brand` checks; every caller passes one.
    Schema.brand<Brand>(brand as Parameters<typeof Schema.brand<Brand>>[0]),
    Schema.annotate({ identifier: brand }),
    statics((schema) => ({ create: () => schema.make(prefix + ulid()) })),
  )
}

/** A main request or an area message (`dp_<ulid>`). */
export const DispatchID = ulidID("dp_", "OwnTeam.DispatchID")
export type DispatchID = typeof DispatchID.Type

export const OpID = ulidID("op_", "OwnTeam.OpID")
export type OpID = typeof OpID.Type

export const IntegrationID = ulidID("ig_", "OwnTeam.IntegrationID")
export type IntegrationID = typeof IntegrationID.Type

/** A stored reorganization proposal (KV `proposal:<teamID>:<id>`, kept 7 days). */
export const ProposalID = ulidID("rp_", "OwnTeam.ProposalID")
export type ProposalID = typeof ProposalID.Type

/** An area note (쪽지, 06 §5.8): `an_<ulid>`; distinct from `Own.Rpc`'s NoteID (project notes). */
export const AreaNoteID = ulidID("an_", "OwnTeam.AreaNoteID")
export type AreaNoteID = typeof AreaNoteID.Type

/** A git object id (SHA-1 or SHA-256), lower-case hex; checked before it reaches `update-ref` (06 §4.3). */
export const Sha = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)).annotate({
  identifier: "OwnTeam.Sha",
})

// ---------------------------------------------------------------------------------------------------------------
// Team (06 §2.4). The registry stores bindings and intent only; git and core facts are read, never stored.

/** A team command (V10): a package script as argv without a shell, or a shell string run like core runs it (4.3). */
export const Command = Schema.Union([
  Schema.Struct({ argv: Schema.Array(Text).check(Schema.isMinLength(1)) }),
  Schema.Struct({ shell: Text }),
]).annotate({ identifier: "OwnTeam.Command" })
export type Command = typeof Command.Type

export interface Commands extends Schema.Schema.Type<typeof Commands> {}
export const Commands = Schema.Struct({
  setup: Schema.NullOr(Command),
  code: Schema.Array(Command),
  assets: Schema.Array(Command),
}).annotate({ identifier: "OwnTeam.Commands" })

/**
 * Team settings (설정 `팀`, 06 §9.8). There are no window, compaction, token or rotation values: owners and the main
 * use core's automatic compaction only (U6, 07 P-D8). `autoAllow`: the evaluate hook allows the team's commands and
 * read-only git without asking, for the registered main and owner sessions only (10.1).
 */
export interface Policy extends Schema.Schema.Type<typeof Policy> {}
export const Policy = Schema.Struct({
  /**
   * Not read since 2026-11-14 (no area limit, AL-1). Kept required and written as 4 so an older build still reads the
   * record (AL-2).
   */
  maxAreas: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
  /** Missing large-file bytes from which a fetch waits for a confirm (4.6). */
  askDownloadBytes: NonNegativeInt,
  /** Folder bytes from which a fetch waits for a confirm (4.6). */
  askDiskBytes: NonNegativeInt,
  /** `auto`: a verified candidate is integrated into the local target without asking, with undo (12.2). */
  mergeLocal: Schema.Literals(["auto", "ask"]),
  /** Commit a copy of each decision record in the main folder (12.2). */
  commitDecisions: Schema.Boolean,
  autoAllow: Schema.Boolean,
  /**
   * 영역과 직접 일할 때 (2026-11-14): a user message in an area's owner conversation starts direct work
   * (`Area.directWork`), so the main's new requests wait until the user hands the area back. Absent = `true`.
   */
  directHold: optional(Schema.Boolean),
  /**
   * Whether owners and peers tell the main about work the user asked them for directly: `none`, `judge` (when it
   * affects the main or other areas) or `always`. An open string, so a later value never makes a stored team
   * undecodable: anything but `none` and `always` reads as `judge` (own.team `Direct.tell`). Absent = `judge`.
   */
  directTell: optional(Schema.String),
}).annotate({ identifier: "OwnTeam.Policy" })

/** The values of `Policy.directTell` a client may write (`settings.set`). */
export const DirectTell = Schema.Literals(["none", "judge", "always"]).annotate({ identifier: "OwnTeam.DirectTell" })
export type DirectTell = typeof DirectTell.Type

const MiB = 1024 ** 2
const GiB = 1024 ** 3

/**
 * Defaults of a new team (06 §2.4, §12.2). `directHold` and `directTell` are not written: absent reads as `true`
 * and `judge`.
 */
export const POLICY: Policy = {
  maxAreas: 4,
  askDownloadBytes: 500 * MiB,
  askDiskBytes: 2 * GiB,
  mergeLocal: "auto",
  commitDecisions: false,
  autoAllow: true,
}

/** A path pattern that marks another tool's worktrees (3.2, added in 설정 `팀` to the built-in ones). */
export const Pattern = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
  identifier: "OwnTeam.Pattern",
})

/** Where the main works (3.2): not `project.canonical`. */
export interface Home extends Schema.Schema.Type<typeof Home> {}
export const Home = Schema.Struct({
  directory: Text,
  /** A linked worktree (locked by own while the team is on). */
  linked: Schema.Boolean,
  chosenBy: Schema.Literals(["session", "target-checkout", "recent", "canonical", "user"]),
}).annotate({ identifier: "OwnTeam.Home" })

/**
 * Where a new team keeps its area folders (06 §4.12, 2026-10-27; `enable{areaRoot}`): `inside` = 프로젝트 안,
 * `<main folder>/.worktrees` (ignored through the repository's `info/exclude`), `beside` = 프로젝트 옆 폴더,
 * `<main folder's parent>/<name>-team`. A main folder with a `#` takes `<drive>:/own-team/<repository>` either way.
 */
export const AreaRoot = Schema.Literals(["inside", "beside"]).annotate({ identifier: "OwnTeam.AreaRoot" })
export type AreaRoot = typeof AreaRoot.Type

/** A checkout outside the team that own only reads (3.2, TI-6); `left` = an area candidate the judge left out. */
export interface External extends Schema.Schema.Type<typeof External> {}
export const External = Schema.Struct({
  directory: Text,
  why: Schema.Literals(["primary", "other-tool", "hash-path", "prunable", "left"]),
}).annotate({ identifier: "OwnTeam.External" })

/** An ignored read-only folder of the main folder linked into every area (4.11). */
export interface Shared extends Schema.Schema.Type<typeof Shared> {}
export const Shared = Schema.Struct({
  name: Text,
  target: Text,
  protect: Schema.Literals(["acl", "chmod", "none"]),
}).annotate({ identifier: "OwnTeam.Shared" })

export interface Team extends Schema.Schema.Type<typeof Team> {}
export const Team = Schema.Struct({
  id: TeamID,
  projectID: Text,
  commonDir: Text,
  /** The target branch areas integrate into (usually `main`). */
  target: Text,
  state: Schema.Literals(["on", "off"]),
  /** Grows by one on every registry write of this team (areas included). */
  rev: NonNegativeInt,
  home: Home,
  main: Schema.Struct({ sessionID: SessionID, previous: Schema.Array(SessionID) }),
  /**
   * Parent of new areas, `.verify` and `.assets` (4.12): `<home>/.worktrees` for a team turned on since 2026-10-27
   * (`enable{areaRoot}` `inside`, the default), else `<home's parent>/<home name>-team` (`beside`, and every team
   * before); a team keeps the one it got.
   */
  worktreeRoot: Text,
  heavy: Schema.Struct({
    dirs: Schema.Array(Dir),
    /**
     * The commit measured; `null` before the first measurement. The list grows when a later commit of the target (or
     * an area's HEAD) has new heavy folders (06 §4.4, `assets/heavy.ts`); it is the commit that growth measured.
     */
    measuredAt: Schema.NullOr(Sha),
    /** Bytes the cone cannot leave out (root files, files directly under a heavy folder's parents). */
    forcedBytes: NonNegativeInt,
    /** Folders an undone growth took out again: a later measurement does not add them back (06 §4.4). */
    light: optional(Schema.Array(Dir)),
    /**
     * The commit whose measurement last grew the list (06 §4.4); absent while it never grew. Areas left behind by a
     * growth (Main 멈춤, at work) follow the list later, also after a restart, only in a team that has it.
     */
    grownAt: optional(Sha),
  }),
  shared: Schema.Array(Shared),
  commands: Commands,
  env: Schema.Struct({
    symlinkFix: Schema.Literals(["none", "skip-worktree", "assume-unchanged", "symlinks"]),
    bunCache: Schema.Literals(["same-volume", "other-volume", "unused"]),
    lfs: Schema.Literals(["unused", "system", "own", "missing"]),
  }),
  external: Schema.Array(External),
  policy: Policy,
  patterns: Schema.Array(Pattern),
}).annotate({ identifier: "OwnTeam.Team" })

// ---------------------------------------------------------------------------------------------------------------
// Area (06 §2.4)

/** The status words of 06 §9.4. A recomputable cache, never a source of truth. */
export const StatusKind = Schema.Literals([
  "idle",
  "preparing",
  "busy",
  "asking",
  "blocked",
  "waiting-quota",
  "ready",
  "failed",
  "broken",
  "retired",
]).annotate({ identifier: "OwnTeam.StatusKind" })
export type StatusKind = typeof StatusKind.Type

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  kind: StatusKind,
  at: EpochMillis,
  text: Schema.String,
  /** `waiting-quota`: when the limit resets; `preparing`: when setup is expected to end. */
  until: optional(EpochMillis),
}).annotate({ identifier: "OwnTeam.Status" })

/** Why an area stopped (8.8): its folder failed the identity check, is gone, lost its branch, or shares one. */
export const BrokenReason = Schema.Literals(["identity", "missing", "branch-gone", "shared-branch"]).annotate({
  identifier: "OwnTeam.BrokenReason",
})
export type BrokenReason = typeof BrokenReason.Type

/** Main 멈춤 (5.3): `user` = the user's switch or the stop button, `all` = 모두 멈추기. */
export const Paused = Schema.Literals([false, "user", "all"]).annotate({ identifier: "OwnTeam.Paused" })
export type Paused = typeof Paused.Type

/** Why an owner conversation was replaced (6.1): only semantic boundaries, never its size. */
export const RotationReason = Schema.Literals(["fresh", "user", "account", "team-account", "r4", "worktree"]).annotate({
  identifier: "OwnTeam.RotationReason",
})
export type RotationReason = typeof RotationReason.Type

/**
 * Why a conversation stopped being an area's owner: a rotation replaced it ({@link RotationReason}), or the user moved
 * the seat onto another conversation of the folder (`seat`, 담당 대화 바꾸기). A rotation never has the reason `seat`.
 */
export const OwnerEnded = Schema.Literals([...RotationReason.literals, "seat"]).annotate({
  identifier: "OwnTeam.OwnerEnded",
})
export type OwnerEnded = typeof OwnerEnded.Type

export interface Owner extends Schema.Schema.Type<typeof Owner> {}
export const Owner = Schema.Struct({
  /** `null`: an adopted folder without a conversation; the first main request creates one. */
  sessionID: Schema.NullOr(SessionID),
  /** Write-ahead id of the owner being created (6.2 step 3). */
  pending: optional(SessionID),
  previous: Schema.Array(Schema.Struct({ sessionID: SessionID, endedAt: EpochMillis, why: OwnerEnded })),
  /** The team role, tools and preset are attached (an adopted owner gets them with the first main request, 3.7). */
  attached: Schema.Boolean,
  /**
   * Conversations that may still hold the owner's team allows, role entries or team context without being the owner
   * (담당 대화 바꾸기): the conversation a seat move is about to seat, and the one it replaced. own.team strips each and
   * takes it off the list; one whose instance could not be reached stays listed until a later sweep.
   */
  release: optional(Schema.Array(SessionID)),
  /**
   * The user's note about what the owner conversation does in the team (담당 메모; at most {@link OWNER_NOTE_MAX}
   * characters, checked by `area.edit`). It stays with the seat, whichever conversation holds it.
   */
  note: optional(Schema.String),
}).annotate({ identifier: "OwnTeam.Owner" })

/** Longest peer label (화면 이름, `리뷰어`). */
export const PEER_LABEL_MAX = 40
/**
 * Longest peer role text in characters, as `Schema.isMaxLength` counts them (UTF-16 code units; 06 §2.4, so the
 * role entry stays small). Before 2026-11-14 own.team counted UTF-8 bytes (`PEER_ROLE_BYTES`).
 */
export const PEER_ROLE_MAX = 1_024
/** Longest owner note (담당 메모, `Owner.note`) in characters, counted like {@link PEER_ROLE_MAX}. */
export const OWNER_NOTE_MAX = 1_024
/** Large-file folders one `area.paths` call (and `team_need_paths`) may add or release. */
export const PATHS_MAX = 64
/** Peers one area may have; each one's inbox is read before every main request goes (5.1). */
export const PEER_MAX = 4

/**
 * An area peer (동료, 06 §1.2, §2.4, approved 2026-10-09): a root conversation the user registered in the area's folder
 * (or one own.team created for it) that the main may send requests to besides the owner. The registry decides the
 * role by session id only. A peer gets the owner's team allows (same catalog), and own.team narrows what it may do:
 * `team_report` progress/done/blocked and `team_need_paths`; `ready`, `team_integrate` and `team_handoff` stay the
 * owner's. One request at a time per folder still holds (5.1).
 */
export interface Peer extends Schema.Schema.Type<typeof Peer> {}
export const Peer = Schema.Struct({
  /** Unique within the area; what `team_dispatch{member}` and the envelope's `to` name. */
  key: Slug,
  sessionID: SessionID,
  /** The screen name (`리뷰어`). */
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(PEER_LABEL_MAX)),
  /** What the peer does (its role entry `own.team.peer.role` quotes it; at most {@link PEER_ROLE_MAX} characters). */
  role: Schema.String.check(Schema.isMaxLength(PEER_ROLE_MAX)),
  /** The team allows and the peer role entry are on the conversation (a registered one gets them lazily, 5.1). */
  attached: Schema.Boolean,
  /** `registered`: the user's conversation (its model and preset stay); `created`: own.team made it for the area. */
  origin: Schema.Literals(["registered", "created"]),
  at: EpochMillis,
  /** The user's last direct input in the peer conversation (5.4): recorded for the peer, never as the owner's. */
  direct: optional(Schema.Struct({ at: EpochMillis })),
}).annotate({ identifier: "OwnTeam.Peer" })

const areaFields = {
  id: AreaID,
  teamID: TeamID,
  /** Adopted areas are named after their folder; the judge's name becomes `subtitle` (3.7). */
  name: Text,
  subtitle: optional(Schema.String),
  goal: Schema.String,
  origin: Schema.Literals(["created", "adopted"]),
  state: Schema.Literals(["active", "broken", "retiring", "retired"]),
  broken: optional(Schema.Struct({ why: BrokenReason, at: EpochMillis })),
  branch: Text,
  /**
   * An adopted area whose detached HEAD was to be named `branch` while a git operation was stopped there (3.7): the
   * name is given by the area reconcile once the operation ended (8.8), and the mark goes. Absent otherwise.
   */
  deferredName: optional(Schema.Literal(true)),
  /** `<common dir>/worktrees/<name>`: the worktree's identity (4.3). */
  gitDir: Text,
  base: Schema.Struct({ sha: Sha, at: EpochMillis }),
  directory: Text,
  /** `plain`: no heavy folders, so no sparse checkout. */
  shape: Schema.Literals(["plain", "code", "full"]),
  cone: Schema.Struct({
    /** Folders fetched by `need_paths` or added automatically (`reason: "auto"`). */
    extra: Schema.Record(
      Schema.String,
      Schema.Struct({ reason: Schema.String, at: EpochMillis, bytes: NonNegativeInt }),
    ),
    /** Folders that could not be released, with the reason. */
    kept: Schema.Record(Schema.String, Schema.String),
  }),
  owner: Owner,
  /** The area main (10.1); absent = `팀과 같게` (the team main session's current Ref). */
  main: optional(Schema.Struct({ model: Model.Ref, chosenBy: Schema.Literals(["user", "adopted"]) })),
  /** The area preset (07 §8.2 `Preset.ID`); a new area starts with its group's ★. */
  preset: Preset.ID,
  paused: Paused,
  /** The last direct user input (5.4); information only, it blocks nothing. */
  direct: optional(Schema.Struct({ at: EpochMillis, sessionID: SessionID })),
  /**
   * 직접 작업 (2026-11-14): the user works with the area's owner directly. `since`: the user's first message of this
   * stretch in the owner conversation (`Policy.directHold` on, the owner not serving a main request); `at`: the
   * user's last one. While it is set and Main 멈춤 is off the main's new requests wait and the owner's reports do not
   * wake the main. No clock ends it, only a hand-back (메인에게 넘기기, `team_area resume`, Main 멈춤 off, the hold
   * switched off) or the area's end. Absent = not held.
   */
  directWork: optional(Schema.Struct({ since: EpochMillis, at: EpochMillis })),
  status: Status,
  /**
   * The commit the owner reported `ready` (7.1). `assets`: the owner reported that it needs an engine run, so the
   * integration runs the `.assets` check even when no heavy folder changed (4.10).
   */
  candidate: optional(
    Schema.Struct({ sha: Sha, at: EpochMillis, text: Schema.String, assets: optional(Schema.Boolean) }),
  ),
  /** `areas/<slug>/handoff.md` in the team records folder (6.4). */
  handoff: Schema.NullOr(Schema.Struct({ file: Text, hash: Text, at: EpochMillis })),
  /** Blob hashes of link copies own wrote (4.12), by repository path. */
  linkCopies: optional(Schema.Record(Schema.String, Sha)),
  /** Area peers (동료, 2026-10-09); absent = none. Optional, so older records read as they are. */
  peers: optional(Schema.Array(Peer)),
  /**
   * 내가 정한 영역 (06 §2.4, 2026-10-26): the user set this area up (영역 만들기, or marked it so later), so the team
   * main's structural changes to it (rename, split, merge, convert, retire, a peer it would create) wait for the user's
   * yes (06 §2.9 V-b (5)); the work inside the area stays the main's to give. Absent = an area the team made or took in.
   */
  userMade: optional(Schema.Struct({ at: EpochMillis })),
}

/** The registry record (KV `area:<teamID>:<areaID>`). */
export interface Area extends Schema.Schema.Type<typeof Area> {}
export const Area = Schema.Struct(areaFields).annotate({ identifier: "OwnTeam.Area" })

/** An area as methods return it: the record plus derived values, never stored. */
export interface AreaView extends Schema.Schema.Type<typeof AreaView> {}
export const AreaView = Schema.Struct({
  ...areaFields,
  /**
   * `끝낼 수 있음` (8.1): the area's branch had commits of its own, all of them are in the target, the folder is clean
   * and nothing changed for 7 days. `since`: the area's last change. A signal only; own never retires by itself.
   */
  retirable: optional(Schema.Struct({ since: EpochMillis })),
}).annotate({ identifier: "OwnTeam.AreaView" })

// ---------------------------------------------------------------------------------------------------------------
// Main requests (06 §5.1)

/**
 * Why a main request or an area message waits in the outbox (5.1, 5.8): Main 멈춤, the owner or another conversation of
 * the folder works, a request is still undelivered in the owner's or a peer's queue, own maintains the area, or the
 * area is broken.
 */
export const WaitReason = Schema.Literals(["paused", "busy", "queued", "maintaining", "broken"]).annotate({
  identifier: "OwnTeam.WaitReason",
})
export type WaitReason = typeof WaitReason.Type

/**
 * Who sent an area message (06 §5.8): its area, and the peer when a peer sent it, with the names the envelope and the
 * screen showed when it was sent (`인벤토리 화면`, `인벤토리 화면 동료 리뷰어`).
 */
export interface Sender extends Schema.Schema.Type<typeof Sender> {}
export const Sender = Schema.Struct({
  areaID: AreaID,
  /** The area's display name. */
  area: Schema.String,
  /** The sending peer; absent = the area's owner. */
  peer: optional(Schema.Struct({ key: Slug, label: Schema.String })),
}).annotate({ identifier: "OwnTeam.Sender" })

/**
 * KV `dispatch:<teamID>:<areaID>:<seq>`. `waiting` ones are the outbox; sent and cancelled ones go after 7 days. Main
 * requests (`main`), program requests and notices (`team`) and area messages (`area`, 5.8) share the path and its rules.
 */
export interface Dispatch extends Schema.Schema.Type<typeof Dispatch> {}
export const Dispatch = Schema.Struct({
  id: DispatchID,
  teamID: TeamID,
  areaID: AreaID,
  seq: NonNegativeInt,
  /**
   * `team`: a program request (integration conflict, target sync) or a program notice (`kind: "notice"`, 5.8), same
   * path and Main 멈춤 rule. `area`: another area's ask or reply (5.8).
   */
  from: Schema.Literals(["main", "team", "area"]),
  kind: Schema.Literals(["task", "conflict", "sync", "ask", "reply", "notice"]),
  task: optional(Schema.String),
  text: Schema.String,
  /** Unrelated new work: the owner conversation is replaced first (6.1). */
  fresh: optional(Schema.Boolean),
  /** The area peer it goes to (`Peer.key`); absent = the owner. Never with `fresh`. */
  to: optional(Slug),
  /** `from="area"`: who sent it (5.8). */
  sender: optional(Sender),
  /** `kind="reply"`: the ask it answers. */
  replyTo: optional(DispatchID),
  /**
   * The notes (쪽지) chosen to go after its envelope, written before it is sent: a resend carries the same ones, and
   * they leave own.team's store once it went in (5.8).
   */
  notes: optional(Schema.Array(AreaNoteID)),
  state: Schema.Literals(["waiting", "sent", "cancelled"]),
  sentTo: optional(Schema.Struct({ sessionID: SessionID, msgID: SessionMessage.ID, at: EpochMillis })),
  movedFrom: optional(AreaID),
  createdAt: EpochMillis,
  /**
   * `from="team"`: when the integration or the op that asked for it started (2026-11-15). An area held by direct work
   * lets a program request in only when its origin is inside the stretch; absent = `createdAt`.
   */
  origin: optional(EpochMillis),
}).annotate({ identifier: "OwnTeam.Dispatch" })

/**
 * An area's FYI note (쪽지, 06 §5.8), held by own.team (KV `talk:<teamID>`) until the receiving conversation's next
 * request goes; never an inbox item.
 */
export interface AreaNote extends Schema.Schema.Type<typeof AreaNote> {}
export const AreaNote = Schema.Struct({
  id: AreaNoteID,
  /** The receiving area. */
  areaID: AreaID,
  /** The receiving peer (`Peer.key`); absent = the owner. */
  to: optional(Slug),
  /**
   * The receiving area itself for a team note (`from: "team"`): own.team has no area of its own, and readers show `팀`
   * as the sender instead of this name.
   */
  sender: Sender,
  /** `team`: own.team wrote it (담당 대화 바꾸기 tells the new owner conversation); absent = an area's note. */
  from: optional(Schema.Literal("team")),
  text: Schema.String,
  at: EpochMillis,
}).annotate({ identifier: "OwnTeam.AreaNote" })

// ---------------------------------------------------------------------------------------------------------------
// Message metadata own.team writes and reads (5.1, 5.6, 6.2)

/**
 * Key of a main request's metadata; own-web shows `메인이 보냄` (or `팀이 보냄`, or who sent an area message) and strips
 * the envelope.
 */
export const DISPATCH_META = "own.dispatch"
export interface DispatchMeta extends Schema.Schema.Type<typeof DispatchMeta> {}
export const DispatchMeta = Schema.Struct({
  id: DispatchID,
  from: Dispatch.fields.from,
  teamID: TeamID,
  areaID: AreaID,
  task: optional(Schema.String),
  /** The area peer it went to (`Peer.key`); absent = the owner. */
  to: optional(Slug),
  /** Written only for area messages and program notices (5.8); main and program requests carry what they did before. */
  kind: optional(Dispatch.fields.kind),
  sender: optional(Sender),
  replyTo: optional(DispatchID),
}).annotate({ identifier: "OwnTeam.DispatchMeta" })

/** Key of a handoff request's metadata (beside `source: "own.team"`, 6.2): `{kind: "handoff", opID}`. */
export const REQUEST_META = "own.team.request"

/** Key of a team update's metadata (a synthetic message in the main session). */
export const UPDATE_META = "own.team.update"
export interface UpdateMeta extends Schema.Schema.Type<typeof UpdateMeta> {}
export const UpdateMeta = Schema.Struct({ seq: NonNegativeInt, reasons: Schema.Array(Schema.String) }).annotate({
  identifier: "OwnTeam.UpdateMeta",
})

/**
 * Key of a team session's metadata. A display hint only: roles are read from the registry, and children (which copy
 * their parent's metadata) are never team sessions.
 */
export const SESSION_META = "own.team"
export interface SessionMeta extends Schema.Schema.Type<typeof SessionMeta> {}
export const SessionMeta = Schema.Struct({
  /** `peer`: a conversation own.team created as an area peer (a registered peer keeps its own metadata). */
  role: Schema.Literals(["main", "owner", "peer"]),
  teamID: TeamID,
  areaID: optional(AreaID),
}).annotate({ identifier: "OwnTeam.SessionMeta" })

// ---------------------------------------------------------------------------------------------------------------
// Worktree conversations (06 §13, 2026-11-24): a conversation starts other conversations, each in a new worktree of
// the project on a branch of its own, follows their state and integrates their branches; no team needed.

/**
 * Key of a worktree conversation's metadata: `{role: "child", parentID, name, branch}` on the started conversation,
 * `{role: "parent"}` on the conversation that started some. A display hint (own-web shows the dock from it); the KV
 * record is the source. Subagents copy their parent's metadata, so only a root session counts.
 */
export const WORKTREE_CHAT_META = "own.worktreeChat"
export type WorktreeChatMeta = typeof WorktreeChatMeta.Type
export const WorktreeChatMeta = Schema.Union([
  Schema.Struct({ role: Schema.Literal("parent") }),
  Schema.Struct({ role: Schema.Literal("child"), parentID: Text, name: Text, branch: Text }),
]).annotate({ identifier: "OwnTeam.WorktreeChatMeta" })

/**
 * `working`: it runs or has input waiting; `needs_user`: a permission or question waits for the user there; `done`:
 * its last turn ended; `blocked`: its last answer starts with `BLOCKED` / `막힘`, or the turn failed; `integrated`: its
 * branch went into the base branch; `removed`: its worktree is gone (the conversation stays).
 */
export const WorktreeChatState = Schema.Literals([
  "working",
  "needs_user",
  "done",
  "blocked",
  "integrated",
  "removed",
]).annotate({ identifier: "OwnTeam.WorktreeChatState" })
export type WorktreeChatState = typeof WorktreeChatState.Type

export interface WorktreeChat extends Schema.Schema.Type<typeof WorktreeChat> {}
export const WorktreeChat = Schema.Struct({
  sessionID: Text,
  parentID: Text,
  name: Text,
  title: Text,
  directory: Text,
  branch: Text,
  /** The branch the work integrates into (absent when the parent's folder was on a detached HEAD) and its commit. */
  base: Schema.Struct({ branch: optional(Text), commit: Text }),
  state: WorktreeChatState,
  /** The start of its last answer (at most 600 characters). */
  summary: optional(Schema.String),
  created: EpochMillis,
  updated: EpochMillis,
  integrated: optional(
    Schema.Struct({ before: Text, after: Text, at: EpochMillis, how: Schema.Literals(["ff", "merge"]) }),
  ),
}).annotate({ identifier: "OwnTeam.WorktreeChat" })

/**
 * Key of the metadata of an owner conversation that own moved after its folder (06 §8.8). own-web shows that it cannot
 * go back to a point before the move (4.14).
 */
export const MOVED_META = "own.team.moved"
export interface MovedMeta extends Schema.Schema.Type<typeof MovedMeta> {}
export const MovedMeta = Schema.Struct({
  at: EpochMillis,
  from: Text,
  to: Text,
}).annotate({ identifier: "OwnTeam.MovedMeta" })

// ---------------------------------------------------------------------------------------------------------------
// Proposal (06 §3.4) and reorganization plans (8.1–8.2)

/**
 * Proposals come from the judge (LLM) or are built by own-web for user actions, so fields are lenient: the V-rules
 * (3.5) drop, fix or truncate items instead of failing the decode.
 */
export interface ProposalArea extends Schema.Schema.Type<typeof ProposalArea> {}
export const ProposalArea = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  goal: optional(Schema.String),
  /** `code` (default) or `full` (V9: adopted full folders only). Without heavy folders own makes it `plain`. */
  shape: optional(Schema.Literals(["code", "full"])),
  /** Heavy folders the area needs from the start. */
  needs: optional(Schema.Array(Schema.String)),
  /** Exactly one of `adopt` and `create`. */
  adopt: optional(
    Schema.NullOr(
      Schema.Struct({
        worktree: Schema.String,
        branch: optional(Schema.NullOr(Schema.String)),
        owner: optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  /** `from`: `main` (the target) or another area's slug. */
  create: optional(Schema.NullOr(Schema.Struct({ from: Schema.String }))),
  /**
   * The area is user-made: the user's `adopt` row (영역 만들기 · 있는 작업 폴더, 2026-10-26) or new area, or the main's new
   * area for a standing role the user asked to keep (2026-11-14); never the judge's.
   */
  userMade: optional(Schema.Literal(true)),
}).annotate({ identifier: "OwnTeam.ProposalArea" })

/** Shown on the card as 제안, never run (V11). `area` is an area slug, `worktree` a folder of the inventory. */
export interface Suggestion extends Schema.Schema.Type<typeof Suggestion> {}
export const Suggestion = Schema.Struct({
  kind: Schema.Literals(["convert", "retire", "move", "split", "merge"]),
  worktree: optional(Schema.String),
  area: optional(Schema.String),
  why: Schema.String,
}).annotate({ identifier: "OwnTeam.Suggestion" })

const why = { why: optional(Schema.String) }

/**
 * An 에이전트 방식 and its prompt variant (own.harness, 10 §3.2, §3.9) a new team conversation starts on: written as its
 * metadata `own.harness` (`OwnHarnessRouting.value`) when own.team creates it (2026-10-26).
 */
export interface Harness extends Schema.Schema.Type<typeof Harness> {}
export const Harness = Schema.Struct({
  id: Schema.Literals(OwnHarnessRouting.IDS),
  prompt: Schema.Literals(OwnHarnessRouting.PROMPTS),
}).annotate({ identifier: "OwnTeam.Harness" })

/**
 * A structural action (8.2). Areas are named by slug. own-web builds these for the area menu (by `user`); the judge
 * proposes them through `reorg.propose` and `team_reorganize` (by `auto` / `main`), where `move` is suggest-only.
 */
export const ReorgOp = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("new"),
    slug: Schema.String,
    name: Schema.String,
    goal: optional(Schema.String),
    needs: optional(Schema.Array(Schema.String)),
    /**
     * `main` (default) or the slug of the area whose branch tip the new branch starts at. A stopped or finished area
     * keeps its branch, so it may be named too: 다시 만들기 of a missing folder (06 §8.8) or of B after a merge whose
     * undo is no longer possible (8.2).
     */
    from: optional(Schema.String),
    /**
     * 영역 만들기 (2026-10-26, the user's only): the area's own model (`area.main`, chosen by the user); absent = 팀과
     * 같게. Team R4 is checked when the action is planned.
     */
    main: optional(Model.Ref),
    /**
     * 영역 만들기 (the user's only): the 에이전트 방식 of the area's first owner conversation (metadata `own.harness`);
     * absent = the service's default for a new conversation. Later owner conversations keep the one before.
     */
    harness: optional(Harness),
    /**
     * The new area is user-made (`Area.userMade`): the user's (영역 만들기), or the main's for a standing role the
     * user asked for (2026-11-14). own.team drops it from the judge's proposals.
     */
    userMade: optional(Schema.Literal(true)),
    ...why,
  }),
  Schema.Struct({
    op: Schema.Literal("rename"),
    area: Schema.String,
    name: Schema.String,
    subtitle: optional(Schema.NullOr(Schema.String)),
    /**
     * The area's whole new role (`Area.goal`) when the rename takes it to another purpose (2026-11-17, L12); absent =
     * unchanged. The user's and the main's only: own.team drops it from the judge's proposals.
     */
    goal: optional(Schema.String),
    /**
     * The renamed area becomes user-made (`Area.userMade`): the main's for a standing role the user asked to keep, as
     * on `new` (2026-11-17, L12). own.team drops it from the judge's proposals.
     */
    userMade: optional(Schema.Literal(true)),
    ...why,
  }),
  Schema.Struct({ op: Schema.Literal("retire"), area: Schema.String, ...why }),
  /** A → A, A2: the new area starts at A's tip with A's handoff, area main and preset. */
  Schema.Struct({
    op: Schema.Literal("split"),
    area: Schema.String,
    slug: Schema.String,
    name: Schema.String,
    goal: optional(Schema.String),
    ...why,
  }),
  /** `from` + `area` → `area`. */
  Schema.Struct({ op: Schema.Literal("merge"), area: Schema.String, from: Schema.String, ...why }),
  Schema.Struct({
    op: Schema.Literal("convert"),
    area: Schema.String,
    shape: Schema.Literals(["code", "full"]),
    ...why,
  }),
  /** Moves a conversation into the area's folder (`session.move`, user action only). */
  Schema.Struct({ op: Schema.Literal("move"), sessionID: Schema.String, area: Schema.String, ...why }),
]).annotate({ identifier: "OwnTeam.ReorgOp" })
export type ReorgOp = typeof ReorgOp.Type

const reason = Schema.Struct({ dir: Schema.String, why: Schema.String })

export interface Proposal extends Schema.Schema.Type<typeof Proposal> {}
export const Proposal = Schema.Struct({
  version: Schema.Literal(1),
  target: optional(Schema.String),
  heavy: optional(Schema.Array(reason)),
  shared: optional(Schema.Array(reason)),
  areas: optional(Schema.Array(ProposalArea)),
  leave: optional(Schema.Array(Schema.Struct({ worktree: Schema.String, why: Schema.String }))),
  suggest: optional(Schema.Array(Suggestion)),
  /** Reorganization actions (8.2); enabling uses `areas`. */
  ops: optional(Schema.Array(ReorgOp)),
  /** Names from the program's candidate list only (V10). */
  commands: optional(
    Schema.Struct({
      setup: optional(Schema.NullOr(Schema.String)),
      code: optional(Schema.Array(Schema.String)),
      assets: optional(Schema.Array(Schema.String)),
    }),
  ),
  /** One or two sentences for the user (V12: at most 400 characters). */
  notes: optional(Schema.String),
}).annotate({ identifier: "OwnTeam.Proposal" })

/** A proposal item, as a pointer into the proposal (`areas/1`, `ops/0`). */
const Item = Schema.String

/** An action of a proposal the user chose (`reorg.apply{proposalID, items}`, 2026-10-27): `ops/N` or `areas/N`. */
const ChosenItem = Schema.String.check(Schema.isPattern(/^(?:ops|areas)\/(?:0|[1-9][0-9]{0,3})$/))

/** An item the V-rules rejected (or a T1 build does not support yet), with the reason. */
export interface Rejected extends Schema.Schema.Type<typeof Rejected> {}
export const Rejected = Schema.Struct({ item: Item, why: Schema.String }).annotate({ identifier: "OwnTeam.Rejected" })

export const StepMode = Schema.Literals(["auto", "confirm"]).annotate({ identifier: "OwnTeam.StepMode" })
export type StepMode = typeof StepMode.Type

/** Step kinds are open: feature modules register them (the 3.6 names, `retire-remove`, `setup-run`, …). */
const StepKind = Schema.NonEmptyString

/** Why an item was not run: 메인 멈춤 (TI-13), not at a safe point (TI-9), broken, not in this build, or a V-rule. */
export const SkipReason = Schema.Literals(["paused", "busy", "broken", "unsupported", "invalid"]).annotate({
  identifier: "OwnTeam.SkipReason",
})
export type SkipReason = typeof SkipReason.Type

/**
 * What applying a proposal would do (`reorg.propose`): the steps with auto/confirm, and what was rejected. `skipped`
 * (2026-10-16, 06 §8.1): the actions this run would skip now because their area is under Main 멈춤 or still working
 * (TI-13, TI-9). They are also in `rejected` with their text, so a client built before reads them as today; a newer
 * one reads `skipped` first and offers them as the user's own action, which waits for the area's safe point.
 */
export interface Plan extends Schema.Schema.Type<typeof Plan> {}
export const Plan = Schema.Struct({
  steps: Schema.Array(Schema.Struct({ item: Item, kind: StepKind, mode: StepMode, areaID: optional(AreaID) })),
  rejected: Schema.Array(Rejected),
  skipped: optional(
    Schema.Array(Schema.Struct({ item: Item, areaID: AreaID, why: Schema.Literals(["paused", "busy"]) })),
  ),
}).annotate({ identifier: "OwnTeam.Plan" })

// ---------------------------------------------------------------------------------------------------------------
// Ops (06 §2.4, §8.5): ordered steps and user confirms only, never an event log

export const OpKind = Schema.Literals([
  "enable",
  "reorg",
  "integrate",
  "rotate",
  "paths",
  "retire",
  "disable",
  "undo",
  "home",
  "adopt",
  "unadopt",
  "team-account",
  /** The heavy-folder list grew with the project (06 §4.4): the list and the areas that follow it. */
  "heavy",
  /** 담당 대화 바꾸기: the area's owner seat moves onto another conversation of its folder (`area.seat`). */
  "seat",
]).annotate({ identifier: "OwnTeam.OpKind" })
export type OpKind = typeof OpKind.Type

/**
 * What holds an outbox (RH-20): the op that maintains the area (`opID`, `kind`), or the last failure that holds it
 * (`failure`, at `at`) and when the outbox looks again (`retryAt`).
 */
export interface WaitCause extends Schema.Schema.Type<typeof WaitCause> {}
export const WaitCause = Schema.Struct({
  opID: optional(OpID),
  kind: optional(OpKind),
  failure: optional(Schema.String),
  at: optional(EpochMillis),
  retryAt: optional(EpochMillis),
  /**
   * The outbox waits because the user works with the area directly (`Area.directWork`, 2026-11-14); stored with
   * `why: "paused"`. Absent = Main 멈춤 (or another cause above).
   */
  direct: optional(Schema.Boolean),
}).annotate({ identifier: "OwnTeam.WaitCause" })

export const OpState = Schema.Literals(["running", "waiting", "done", "failed", "cancelled"]).annotate({
  identifier: "OwnTeam.OpState",
})
export type OpState = typeof OpState.Type

export const StepState = Schema.Literals(["pending", "done", "skipped", "needs_confirm", "failed"]).annotate({
  identifier: "OwnTeam.StepState",
})
export type StepState = typeof StepState.Type

/** A confirm a step waits for (10 minutes; a removal's nonce is bound to `manifest`, 8.6). */
export interface StepConfirm extends Schema.Schema.Type<typeof StepConfirm> {}
export const StepConfirm = Schema.Struct({
  nonce: Nonce,
  expiresAt: EpochMillis,
  text: Schema.String,
  /** Bytes downloaded, used or removed. */
  bytes: optional(NonNegativeInt),
  /**
   * What a removal deletes; `irreplaceable`: an ignored file or folder that cannot be made again (not a tool cache,
   * dependency or build output) and is too large to keep in the team records (8.6 step 2).
   */
  files: optional(
    Schema.Array(Schema.Struct({ path: Text, bytes: NonNegativeInt, irreplaceable: optional(Schema.Boolean) })),
  ),
  /** Hash of the list shown (paths, sizes, mtimes). */
  manifest: optional(Schema.String),
}).annotate({ identifier: "OwnTeam.StepConfirm" })

/**
 * What the user can do about a step that waits (RH-20, 06 §8.5): `cancel` (`op.cancel`), `force` (`op.force`: the
 * wait's fallback now: the program's handoff, the request without a new conversation, or going on past a command
 * that runs in the background) and `stop-shell` (`op.force{action: "stop-shell"}`: the commands that hold the folder
 * are stopped, then the step goes on).
 */
export const WaitAction = Schema.Literals(["cancel", "force", "stop-shell"]).annotate({
  identifier: "OwnTeam.WaitAction",
})
export type WaitAction = typeof WaitAction.Type

/**
 * Why a running step waits (RH-20): written only when the reason changes. `why` names the wait (`safe-point`,
 * `handoff`, `main-idle`, `account`, `undo`, `turn`), `detail` the check that holds it (`session`, `inbox`, `shell`, …),
 * `text` says it for the card and `team_status`, `since` is when this wait began (a restart keeps it). `shells` are the
 * commands that hold the folder, with the conversation that started each.
 */
export interface StepWait extends Schema.Schema.Type<typeof StepWait> {}
export const StepWait = Schema.Struct({
  why: Text,
  detail: optional(Schema.String),
  text: Schema.String,
  since: EpochMillis,
  sessionIDs: optional(Schema.Array(SessionID)),
  shells: optional(
    Schema.Array(
      Schema.Struct({
        id: Text,
        command: Schema.String,
        sessionID: optional(SessionID),
        kind: Schema.Literals(["shell", "pty"]),
        /** The folder whose Location runs it. */
        directory: optional(Schema.String),
      }),
    ),
  ),
  actions: optional(Schema.Array(WaitAction)),
}).annotate({ identifier: "OwnTeam.StepWait" })

export interface Step extends Schema.Schema.Type<typeof Step> {}
export const Step = Schema.Struct({
  id: Text,
  kind: StepKind,
  args: Schema.Record(Schema.String, Schema.Unknown),
  mode: StepMode,
  state: StepState,
  note: optional(Schema.String),
  confirm: optional(StepConfirm),
  /** When the runner began the step (RH-20); the current step only. */
  startedAt: optional(EpochMillis),
  /** Why the current step waits (RH-20). */
  wait: optional(StepWait),
  /**
   * An answer to the step's confirm given while the op was busy with another step (RH-20): applied after that step,
   * also after a restart. `at`: when the user answered (the nonce's lifetime counts to then).
   */
  answer: optional(Schema.Struct({ choice: Schema.Literals(["do", "skip"]), at: EpochMillis })),
}).annotate({ identifier: "OwnTeam.Step" })

/** A pending confirm as `team.get` lists it and `op.confirm` announces it (answered with `op.confirm`). */
export interface Confirm extends Schema.Schema.Type<typeof Confirm> {}
export const Confirm = Schema.Struct({
  teamID: TeamID,
  opID: OpID,
  stepID: Text,
  kind: StepKind,
  areaID: optional(AreaID),
  ...StepConfirm.fields,
}).annotate({ identifier: "OwnTeam.Confirm" })

/**
 * What an area line of a result card reports. `touched`: undo kept a folder someone worked in. `seated`: the owner
 * seat moved onto another conversation of the folder.
 */
export const AreaChange = Schema.Literals([
  "created",
  "adopted",
  "renamed",
  "rotated",
  "split",
  "merged",
  "retired",
  "converted",
  "unadopted",
  "touched",
  "seated",
]).annotate({ identifier: "OwnTeam.AreaChange" })
export type AreaChange = typeof AreaChange.Type

/**
 * One fact of an op's result card (06 §9.3, §3.8, §8.1, §9.7, §10.1). own-web words it; what the team record already
 * holds (home, outside folders, auto-allow, the main's model and preset) comes from `team.get`, not from here.
 */
export const SummaryLine = Schema.Union([
  /** `from`: the source area of a split, or the area merged into `areaID`. */
  Schema.Struct({ kind: Schema.Literal("area"), areaID: AreaID, change: AreaChange, from: optional(AreaID) }),
  /** V13: an active folder left outside the team (`[팀에 넣기]`). */
  Schema.Struct({
    kind: Schema.Literal("unadopted"),
    directory: Text,
    /** Uncommitted changes. */
    changes: NonNegativeInt,
    /** Commits not in the target. */
    ahead: NonNegativeInt,
  }),
  /** 3.7, 10.1: an adopted conversation on another subscription of the team main's company. */
  Schema.Struct({ kind: Schema.Literal("r4"), areaID: AreaID, accountID: AccountID }),
  Schema.Struct({ kind: Schema.Literal("suggest"), suggestion: Suggestion }),
  /** The judge's `notes`. */
  Schema.Struct({ kind: Schema.Literal("notes"), text: Schema.String }),
  /** Disk the new areas' preparation uses. */
  Schema.Struct({ kind: Schema.Literal("prepare"), bytes: NonNegativeInt }),
  /** Uncommitted changes of the main folder that new areas do not get. */
  Schema.Struct({ kind: Schema.Literal("home-changes"), count: PositiveInt }),
  /** 4.2: Git older than 2.42, so areas are full folders. */
  Schema.Struct({ kind: Schema.Literal("old-git"), version: Text }),
  Schema.Struct({
    kind: Schema.Literal("skipped"),
    item: Item,
    areaID: optional(AreaID),
    why: SkipReason,
    /**
     * 2026-10-16 (06 §8.1): the action as proposed, for a Main 멈춤 or busy skip of an `ops/N` item, so the card can
     * offer it again as the user's own action (`[다시 하기]`).
     */
    op: optional(ReorgOp),
  }),
  /** A waiting main request the op cancelled (disable, retire, unadopt). */
  Schema.Struct({ kind: Schema.Literal("cancelled"), areaID: AreaID, dispatchID: DispatchID }),
  /** Main requests still in an owner's queue (`[담당 대기열의 메인 요청 n개 지우기]`, 3.8). */
  Schema.Struct({ kind: Schema.Literal("queued"), areaID: AreaID, sessionID: SessionID, count: PositiveInt }),
  /** A lock left in place because the folder holds nested worktrees (3.8). */
  Schema.Struct({ kind: Schema.Literal("lock-kept"), directory: Text }),
  /** An own ref that protects work (`refs/own/keep/*`, `refs/own/hold/*`, 2.4, 8.7). */
  Schema.Struct({ kind: Schema.Literal("ref"), ref: Text, sha: Sha, bytes: optional(NonNegativeInt) }),
  /** Large-file folders fetched, released or kept (4.6, 4.7). */
  Schema.Struct({
    kind: Schema.Literal("paths"),
    areaID: AreaID,
    change: Schema.Literals(["added", "released", "kept"]),
    dirs: Schema.Array(Dir),
    bytes: NonNegativeInt,
  }),
  /**
   * The team moved to another account (`team.account`, 10.1); `areas` continued in new conversations. `accountID`: the
   * account the team main runs on now (SL-8: the Claude accounts share `anthropic`, so the model names only the first);
   * absent on summaries written before it.
   */
  Schema.Struct({
    kind: Schema.Literal("account"),
    model: Model.Ref,
    areas: NonNegativeInt,
    accountID: optional(AccountID),
  }),
  /** 7.2: `newerSkipped` = commits after the candidate that were left out. */
  Schema.Struct({
    kind: Schema.Literal("integrated"),
    areaID: AreaID,
    integrationID: IntegrationID,
    newerSkipped: NonNegativeInt,
  }),
  /** 0.4, 9.3: the heavy folders areas leave out (`큰 파일 폴더 3개(14.7 GB)는 영역 폴더에 받지 않아요.`). */
  Schema.Struct({ kind: Schema.Literal("heavy"), dirs: Schema.Array(Dir), bytes: NonNegativeInt }),
  /** 7.5: the target went up to `remote`; `pr` = the review request's page (GitHub's compare page without `gh`). */
  Schema.Struct({
    kind: Schema.Literal("pushed"),
    areaID: AreaID,
    integrationID: IntegrationID,
    remote: Text,
    ref: Text,
    pr: optional(Schema.String),
  }),
]).annotate({ identifier: "OwnTeam.SummaryLine" })
export type SummaryLine = typeof SummaryLine.Type

export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({ lines: Schema.Array(SummaryLine) }).annotate({ identifier: "OwnTeam.Summary" })

/** KV `op:<teamID>:<opID>`. One running op per team (`busy`). */
export interface Op extends Schema.Schema.Type<typeof Op> {}
export const Op = Schema.Struct({
  id: OpID,
  teamID: TeamID,
  kind: OpKind,
  /** `user`: a user action; `main`: the main's tool call; `auto`: a judge proposal or an own duty (TI-13). */
  by: Schema.Literals(["user", "main", "auto"]),
  state: OpState,
  /** The area an area op works on. */
  areaID: optional(AreaID),
  /** Also the author and commit date of hold refs (8.7). */
  createdAt: EpochMillis,
  summary: optional(Summary),
  /** `available`: `op.undo` can still reverse it; `by`: the undo op that did; `of`: for an `undo` op, its target. */
  undo: optional(Schema.Struct({ available: Schema.Boolean, by: optional(OpID), of: optional(OpID) })),
  steps: Schema.Array(Step),
}).annotate({ identifier: "OwnTeam.Op" })

// ---------------------------------------------------------------------------------------------------------------
// Integration (06 §2.4, §7)

export const IntegrationState = Schema.Literals([
  "running",
  "waiting",
  "conflict",
  "failed",
  "done",
  "undone",
]).annotate({ identifier: "OwnTeam.IntegrationState" })
export type IntegrationState = typeof IntegrationState.Type

/** A verification run: the failed command, if any, and its log (last 64 KB) in the team records folder. */
export interface VerifyResult extends Schema.Schema.Type<typeof VerifyResult> {}
export const VerifyResult = Schema.Struct({
  ok: Schema.Boolean,
  ms: NonNegativeInt,
  failed: optional(Schema.String),
  log: optional(Schema.String),
}).annotate({ identifier: "OwnTeam.VerifyResult" })

/**
 * The `.assets` check (4.10): a verification run plus what it did to the `.assets` folder. `sha`: the K it reset to;
 * `heldRef`: the hold ref of changes left there (`refs/own/hold/assets/<opID>`, 8.7); `keptRefs`: the keep refs of
 * commits made there since the last check (`refs/own/keep/<sha>`, TI-8). T2 records carry none of them.
 */
export interface AssetsResult extends Schema.Schema.Type<typeof AssetsResult> {}
export const AssetsResult = Schema.Struct({
  ...VerifyResult.fields,
  sha: optional(Sha),
  heldRef: optional(Text),
  keptRefs: optional(Schema.Array(Text)),
}).annotate({ identifier: "OwnTeam.AssetsResult" })

/**
 * Why a `failed` integration stopped (7.1–7.3, 4.10). `verify`, `assets` and `cone` name the failed check of `verify`;
 * `conflict` is the second conflict (the first one is the `conflict` state: the owner sorts it out); `moved`: the
 * target moved on every try (7.2 step 8); `rewritten`: the candidate is no longer on the area's branch and the owner
 * was asked to report `ready` again (7.1); `heavy`: the candidate deletes files in heavy folders (4.10); `broken`: a
 * folder failed the identity check (4.3); `error`: anything else (`diagnostics` `lastErrors`).
 */
export const IntegrationFailure = Schema.Literals([
  "verify",
  "assets",
  "cone",
  "conflict",
  "moved",
  "rewritten",
  "heavy",
  "broken",
  "error",
]).annotate({ identifier: "OwnTeam.IntegrationFailure" })
export type IntegrationFailure = typeof IntegrationFailure.Type

/** KV `ig:<teamID>:<igID>`. `base`, `candidate` and `how` are set once step 1–4 of 7.2 ran. */
export interface Integration extends Schema.Schema.Type<typeof Integration> {}
export const Integration = Schema.Struct({
  id: IntegrationID,
  teamID: TeamID,
  areaID: AreaID,
  state: IntegrationState,
  /** The target branch. */
  target: Text,
  /** C: the area's candidate. */
  source: Sha,
  /** B: the target before. */
  base: optional(Sha),
  /** K: what the target moves to. */
  candidate: optional(Sha),
  how: optional(Schema.Literals(["ff", "merge"])),
  /**
   * The user's 이 영역 반영하기 without a candidate (7.1): the branch tip goes in, and these are the subjects of the
   * commits it brings (newest first, at most 20), shown on the card. Absent for a reported candidate.
   */
  subjects: optional(Schema.Array(Schema.String)),
  newerSkipped: optional(NonNegativeInt),
  conflicts: optional(Schema.Array(Schema.String)),
  /**
   * Why it waits (7.2): uncommitted changes overlap in the folder that has the target checked out, the target is in
   * use, or a git operation is in progress there; `outside` = that folder is not the team's.
   */
  waiting: optional(
    Schema.Struct({
      why: Schema.Literals(["dirty", "in-use", "in-progress", "outside"]),
      directory: Text,
      paths: optional(Schema.Array(Schema.String)),
    }),
  ),
  verify: Schema.Struct({
    code: optional(VerifyResult),
    /** `skipped`: not needed (no heavy folder changed and no engine run asked, 4.10); T2 builds always recorded it. */
    assets: optional(Schema.Union([AssetsResult, Schema.Literal("skipped")])),
    /** Every non-heavy top-level folder of K was inside the verify folder's cone. */
    cone: optional(Schema.Struct({ ok: Schema.Boolean, missing: Schema.Array(Schema.String) })),
  }),
  advanced: optional(
    Schema.Struct({
      how: Schema.Literals(["ff-in-worktree", "update-ref"]),
      at: EpochMillis,
      directory: optional(Schema.String),
    }),
  ),
  undone: optional(Schema.Struct({ at: EpochMillis, opID: OpID })),
  /**
   * RH-20 (7.4): the user's undo waits for the folder that has the target checked out (`waiting` as for an
   * integration that waits). Its op ended, so the team's op slot is free; the undo runs again once the wait is over
   * (looked at every 30 s), and `integration.undo` again asks now. `integration.undo.cancel` drops it (RH-42).
   */
  undoing: optional(
    Schema.Struct({
      since: EpochMillis,
      by: Schema.Literals(["user", "main", "auto"]),
      why: Schema.Literals(["dirty", "in-use", "in-progress", "outside"]),
      directory: Text,
      paths: optional(Schema.Array(Schema.String)),
    }),
  ),
  pushed: optional(Schema.Struct({ at: EpochMillis, remote: Text, ref: Text, pr: optional(Schema.String) })),
  createdAt: EpochMillis,
  /** While the checks run: the one running now (1-based) of all of them (`검사 1/2`, 9.7). */
  checks: optional(Schema.Struct({ current: PositiveInt, total: PositiveInt })),
  /** Why a `failed` integration stopped. */
  failure: optional(IntegrationFailure),
}).annotate({ identifier: "OwnTeam.Integration" })

// ---------------------------------------------------------------------------------------------------------------
// Read models

export const Guard = Schema.Literals(["ok", "skew", "unmanaged"]).annotate({ identifier: "OwnTeam.Guard" })
export type Guard = typeof Guard.Type

/**
 * What this build implements (spec addition to 06 §2.7): clients hide actions whose feature is missing. `enable`
 * covers enable, disable, `team.home` and undo; `reorg.*` are the `reorg.apply` actions; `cleanup` is `disable{cleanup}`.
 */
export const Feature = Schema.Literals([
  "enable",
  "pause",
  "outbox",
  "rotate",
  "area-main",
  "area-preset",
  "team-account",
  "paths",
  "reorg.new",
  "reorg.rename",
  "settings",
  "diagnostics",
  "adopt",
  "integrate",
  "push",
  "decisions",
  "reorg.split",
  "reorg.merge",
  "reorg.retire",
  "reorg.convert",
  "reorg.move",
  "cleanup",
  "assets",
  "shared",
  /** Area peers (동료): `area.peer.add|edit|remove` and `team_dispatch{member}`. */
  "peers",
  /** Git 저장소로 만들기 (3.0): `project.gitInit.plan` and `project.gitInit`. */
  "git-init",
  /** 역할 바꾸기… and 내가 정한 영역 of the area menu (`area.edit`, 2026-10-26). */
  "area-edit",
  /** 되돌리기 취소 of an integration undo that waits (`integration.undo.cancel`, RH-42). */
  "undo-cancel",
  /** 이 대화를 담당으로 (`area.seat`): the owner seat moves onto an existing conversation of the area's folder. */
  "seat",
  /** 담당 메모 (`area.edit{note}`). */
  "owner-note",
  /**
   * 직접 작업 (2026-11-14): `Area.directWork`, `Policy.directHold` / `directTell` in `settings.*`, and
   * `area.pause{on: false}` handing a held area back.
   */
  "direct",
  /** 팀 지시문 (2026-11-14): `TeamSettings.instructions` and `SettingsPatch.instructions`. */
  "instructions",
  /** Worktree conversations (13, 2026-11-24): `worktreeChat.list` and the `worktreeChat.changed` event. */
  "worktree-chat",
]).annotate({ identifier: "OwnTeam.Feature" })
export type Feature = typeof Feature.Type

/** `ok`: at least 2.40 (2.40–2.41 enable with full folders, 4.2). `null` when Git was not found. */
export interface Git extends Schema.Schema.Type<typeof Git> {}
export const Git = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  ok: Schema.Boolean,
}).annotate({ identifier: "OwnTeam.Git" })

const Lfs = Schema.NullOr(Schema.Struct({ version: Text }))

/** `health` result. When the guard fails only `guard`, `version`, `buildId` and `features: []` are reliable. */
/**
 * The team controller of this process (RH-20, 06 §2.6): `running` once it holds `OWN_HOME\locks\team-controller.lock`,
 * `lock` while another live process (a second service on the same OWN_HOME, a stuck older one) holds it; nothing of
 * the team is written meanwhile.
 */
export interface Controller extends Schema.Schema.Type<typeof Controller> {}
export const Controller = Schema.Struct({
  state: Schema.Literals(["starting", "running", "lock"]),
  holder: optional(Schema.Struct({ pid: Schema.Number, buildId: Schema.String })),
  since: optional(EpochMillis),
}).annotate({ identifier: "OwnTeam.Controller" })

export interface Health extends Schema.Schema.Type<typeof Health> {}
export const Health = Schema.Struct({
  version: Schema.String,
  buildId: Schema.String,
  guard: Guard,
  /** `remote` inside a remote service (04 §16.5). */
  mode: optional(Schema.Literals(["local", "remote"])),
  git: optional(Git),
  lfs: optional(Lfs),
  /** This instance is the process leader (the only event publisher). */
  leader: optional(Schema.Boolean),
  features: Schema.Array(Feature),
  /** The team controller (RH-20): `lock` while another process of this OWN_HOME holds it (`holder`, since `since`). */
  controller: optional(Controller),
  /** This instance's core event stream (RH-20): `restarting` after it ended, until it reads again. */
  intake: optional(Schema.Struct({ state: Schema.Literals(["reading", "restarting"]), restarts: NonNegativeInt })),
}).annotate({ identifier: "OwnTeam.Health" })

export interface TeamListItem extends Schema.Schema.Type<typeof TeamListItem> {}
export const TeamListItem = Schema.Struct({
  id: TeamID,
  projectID: Text,
  /** The main folder. */
  home: Text,
  state: Team.fields.state,
  /** Areas that are not retired. */
  areas: NonNegativeInt,
}).annotate({ identifier: "OwnTeam.TeamListItem" })

/** Longest 일하는 방식 block of one role in 팀 지시문 (`SettingsPatch.instructions`), in characters. */
export const INSTRUCTIONS_MAX = 2_000

/**
 * Line starts a 팀 지시문 block may not have: the harness's baseline parser reads them as its own markers
 * (`own-harness/src/codex/baseline.ts`).
 */
export const INSTRUCTION_BREAKERS = ["</context>", "<context key=", "Today's date: "] as const

/** A user's 일하는 방식 block: at most {@link INSTRUCTIONS_MAX} characters, no line starting with a breaker. */
export const InstructionBlock = Schema.String.check(
  Schema.isMaxLength(INSTRUCTIONS_MAX),
  Schema.isPattern(/^(?![\s\S]*(?:^|\n)(?:<\/context>|<context key=|Today's date: ))/),
).annotate({ identifier: "OwnTeam.InstructionBlock" })

/**
 * One role's 지시문 as the model gets it (팀 지시문, 2026-11-14): `program` (written by the program, not editable),
 * `guard` (the line that puts `program` first), `standard` (the default 일하는 방식) and the user's `custom` block
 * when one is saved (absent = `standard` is used).
 */
export interface RoleText extends Schema.Schema.Type<typeof RoleText> {}
export const RoleText = Schema.Struct({
  program: Schema.String,
  guard: Schema.String,
  standard: Schema.String,
  custom: optional(Schema.String),
}).annotate({ identifier: "OwnTeam.RoleText" })

/** `settings.get` result: what 설정 `팀` shows; `commands` are the team's (shown, chosen by the program, V10). */
export interface TeamSettings extends Schema.Schema.Type<typeof TeamSettings> {}
export const TeamSettings = Schema.Struct({
  /** Effective values: `directHold` and `directTell` are filled in with their defaults (2026-11-14). */
  policy: Policy,
  commands: Commands,
  patterns: Schema.Array(Pattern),
  /** 팀 지시문 (feature `instructions`): `limit` = {@link INSTRUCTIONS_MAX}. Absent from an older server. */
  instructions: optional(Schema.Struct({ limit: NonNegativeInt, main: RoleText, owner: RoleText, peer: RoleText })),
}).annotate({ identifier: "OwnTeam.TeamSettings" })

/**
 * `settings.set` patch: policy fields to change, the full list of extra other-tool patterns, and 팀 지시문 blocks.
 * `maxAreas` is no key since 2026-11-14 (no area limit): a patch of an older client that has it decodes without it
 * (excess keys are dropped), so it changes nothing.
 */
export interface SettingsPatch extends Schema.Schema.Type<typeof SettingsPatch> {}
export const SettingsPatch = Schema.Struct({
  policy: optional(
    Schema.Struct({
      askDownloadBytes: optional(Policy.fields.askDownloadBytes),
      askDiskBytes: optional(Policy.fields.askDiskBytes),
      mergeLocal: optional(Policy.fields.mergeLocal),
      commitDecisions: optional(Policy.fields.commitDecisions),
      autoAllow: optional(Policy.fields.autoAllow),
      directHold: optional(Schema.Boolean),
      directTell: optional(DirectTell),
    }),
  ),
  patterns: optional(Schema.Array(Pattern).check(Schema.isMaxLength(64))),
  /**
   * 팀 지시문's 일하는 방식 block per role (feature `instructions`). `null` resets the role to the default; so does an
   * empty block or one equal to the default once own.team normalises it (`\r\n` → `\n`, trimmed). Absent keys stay.
   */
  instructions: optional(
    Schema.Struct({
      main: optional(Schema.NullOr(InstructionBlock)),
      owner: optional(Schema.NullOr(InstructionBlock)),
      peer: optional(Schema.NullOr(InstructionBlock)),
    }),
  ),
}).annotate({ identifier: "OwnTeam.SettingsPatch" })

/** A decision record (6.6): `decisions/NNNN-<slug>.md` in the team records folder, index KV `decision:<teamID>:<NNNN>`. */
export interface DecisionRecord extends Schema.Schema.Type<typeof DecisionRecord> {}
export const DecisionRecord = Schema.Struct({
  number: PositiveInt,
  title: Text,
  /** Path relative to the team records folder. */
  file: Text,
  at: EpochMillis,
  source: Schema.Literals(["main", "user"]),
  areas: Schema.Array(AreaID),
}).annotate({ identifier: "OwnTeam.DecisionRecord" })

/**
 * An area preset target that breaks the team's R4 (10.1): the preset (of an area, or of the team main when `areaID`
 * is absent) pins `roles` to `accountID`, so the gate runs those roles like the main until the user fixes it. `pool`
 * (07 T4): the model pool names pinned to that account, which run on the default rule when named until fixed.
 */
export interface Repair extends Schema.Schema.Type<typeof Repair> {}
export const Repair = Schema.Struct({
  areaID: optional(AreaID),
  presetID: Preset.ID,
  accountID: AccountID,
  roles: Schema.Array(Preset.Role),
  pool: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "OwnTeam.Repair" })

/** `team.account{dryRun:true}` result (10.1 step 1). */
export interface AccountPlan extends Schema.Schema.Type<typeof AccountPlan> {}
export const AccountPlan = Schema.Struct({
  /** Areas that move with the team: `rotate` = continue in a new conversation; `busy` = its tree works now. */
  areas: Schema.Array(Schema.Struct({ areaID: AreaID, rotate: Schema.Boolean, busy: Schema.Boolean })),
  /** Sessions and subagents working on the old account. */
  busy: Schema.Struct({ sessions: NonNegativeInt, children: NonNegativeInt }),
  /** own.accounts `switch.estimate` of the team main; `null` when none could be made. */
  estimate: Schema.NullOr(Estimate.Result),
  r4: Schema.Array(Repair),
}).annotate({ identifier: "OwnTeam.AccountPlan" })

/** `diagnostics` result (자세히): what own sees, never secrets. */
export interface Diagnostics extends Schema.Schema.Type<typeof Diagnostics> {}
export const Diagnostics = Schema.Struct({
  /** `git worktree list` classified (3.2). */
  inventory: Schema.Array(
    Schema.Struct({
      directory: Text,
      head: Schema.NullOr(Sha),
      branch: Schema.NullOr(Schema.String),
      locked: Schema.NullOr(Schema.String),
      class: Schema.Literals(["home", "primary", "area", "candidate", "other-tool", "hash-path", "prunable"]),
      /** Inside another worktree. */
      nested: Schema.Boolean,
      areaID: optional(AreaID),
    }),
  ),
  versions: Schema.Struct({ git: Git, lfs: Lfs }),
  locks: Schema.Array(Schema.Struct({ directory: Text, reason: Schema.String })),
  cones: Schema.Array(
    Schema.Struct({ areaID: AreaID, shape: Area.fields.shape, patterns: Schema.Array(Schema.String) }),
  ),
  lastErrors: Schema.Array(
    Schema.Struct({ at: EpochMillis, opID: optional(OpID), stepID: optional(Schema.String), message: Schema.String }),
  ),
  /** The team's last warnings and errors of this process's own.team log (RH-20; `own-team.log`), oldest first. */
  log: optional(Schema.Array(Schema.String)),
  controller: optional(Controller),
}).annotate({ identifier: "OwnTeam.Diagnostics" })

// ---------------------------------------------------------------------------------------------------------------
// Git 저장소로 만들기 (06 §3.0): a project that is not a Git repository becomes one, so team mode and worktrees can start

/** Files and their total size. */
export interface GitInitCount extends Schema.Schema.Type<typeof GitInitCount> {}
export const GitInitCount = Schema.Struct({ count: NonNegativeInt, bytes: NonNegativeInt }).annotate({
  identifier: "OwnTeam.GitInitCount",
})

/** A file of the folder, `/`-separated and relative to it. `ignored`: the proposed `.gitignore` leaves it out. */
export interface GitInitFile extends Schema.Schema.Type<typeof GitInitFile> {}
export const GitInitFile = Schema.Struct({
  path: Text,
  bytes: NonNegativeInt,
  /** A NUL byte in its first 8000 bytes (git's own test), read for files of at least `limits.binaryBytes`. */
  binary: Schema.Boolean,
  ignored: Schema.Boolean,
}).annotate({ identifier: "OwnTeam.GitInitFile" })

/** What a first commit would take: every file git sees as new, `.gitignore` rules applied. */
export interface GitInitFiles extends Schema.Schema.Type<typeof GitInitFiles> {}
export const GitInitFiles = Schema.Struct({
  kind: Schema.Literal("listed"),
  /** With the proposed `.gitignore` (the folder's own when it has one). */
  total: GitInitCount,
  /** What the proposal leaves out (zero when the folder has a `.gitignore`; `bytes` 0 when `proposalRequired`). */
  proposal: GitInitCount,
  /** Without the proposal the folder has more files than a first commit made here takes: the proposal stays on. */
  proposalRequired: Schema.Boolean,
  /** The biggest files, with and without the proposal (at most 20). */
  largest: Schema.Array(GitInitFile),
  /** Files a first commit leaves out unless the user picks them: large ones, and binary ones of 1 MB or more. */
  flagged: Schema.Array(GitInitFile),
  /** More flagged files than `flagged` lists (they are left out too). */
  flaggedMore: NonNegativeInt,
  /** Git repositories inside the folder (`sub/`): never committed (they would become broken links). */
  nested: Schema.Array(Text),
}).annotate({ identifier: "OwnTeam.GitInitFiles" })

/** `project.gitInit.plan` result: what `project.gitInit` would do, read without writing anything. */
export interface GitInitPlan extends Schema.Schema.Type<typeof GitInitPlan> {}
export const GitInitPlan = Schema.Struct({
  directory: Text,
  /** `none`: no repository yet; `unborn`: a repository without a commit (only the first commit is left to do). */
  state: Schema.Literals(["none", "unborn"]),
  /** The branch the first commit goes on: `main` for a new repository. */
  branch: Text,
  /** `user.name` and `user.email` as git reads them for this folder; `null` when not set (never made up). */
  identity: Schema.Struct({ name: Schema.NullOr(Schema.String), email: Schema.NullOr(Schema.String) }),
  gitignore: Schema.Struct({ exists: Schema.Boolean, proposal: Schema.String }),
  files: Schema.Union([
    GitInitFiles,
    /** More files than a first commit made here may take: the user commits them himself. */
    Schema.Struct({ kind: Schema.Literal("too_many"), count: NonNegativeInt, limit: NonNegativeInt }),
  ]),
  limits: Schema.Struct({ largeBytes: NonNegativeInt, binaryBytes: NonNegativeInt }),
}).annotate({ identifier: "OwnTeam.GitInitPlan" })

const IdentityLine = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^\r\n\0]*\S[^\r\n\0]*$/),
)

/** `project.gitInit{firstCommit}`: the files of the plan, the flagged ones only when listed in `include`. */
export interface GitInitCommit extends Schema.Schema.Type<typeof GitInitCommit> {}
export const GitInitCommit = Schema.Struct({
  /** Write the proposed `.gitignore` (never over an existing one). */
  gitignore: Schema.Boolean,
  /** Flagged files the user chose to commit anyway. */
  include: Schema.Array(Text).check(Schema.isMaxLength(1_000)),
  /** Asked in the dialog when git has none; saved in this repository's own settings only. */
  identity: optional(Schema.Struct({ name: IdentityLine, email: IdentityLine })),
}).annotate({ identifier: "OwnTeam.GitInitCommit" })

/** Why Git 저장소로 만들기 is refused (`git_init_refused`). */
export const GitInitRefusal = Schema.Literals(["exists", "inside", "system", "too_many", "busy"]).annotate({
  identifier: "OwnTeam.GitInitRefusal",
})
export type GitInitRefusal = typeof GitInitRefusal.Type

/** `project.gitInit` result. */
export interface GitInitResult extends Schema.Schema.Type<typeof GitInitResult> {}
export const GitInitResult = Schema.Struct({
  directory: Text,
  branch: Text,
  /** The first commit, when one was made. */
  commit: Schema.NullOr(Text),
  committed: Schema.NullOr(GitInitCount),
  /** Files left out of the first commit (flagged ones not picked, and repositories inside). */
  excluded: NonNegativeInt,
  gitignore: Schema.Literals(["written", "kept", "none"]),
  /** The folder's project once the service read it again; `null` when it could not be asked. */
  projectID: Schema.NullOr(Text),
}).annotate({ identifier: "OwnTeam.GitInitResult" })

// ---------------------------------------------------------------------------------------------------------------
// Errors (06 §2.7). Declared types become HTTP 400; a handler never throws.

export const errors = portable({
  internal_error: Schema.Struct({}),
  not_found: Schema.Struct({
    what: Schema.Literals([
      "team",
      "area",
      "op",
      "dispatch",
      "integration",
      "proposal",
      "decision",
      "directory",
      "session",
      "preset",
      "remote",
    ]),
    id: Schema.String,
  }),
  /** `unborn`: a repository without a commit yet (team mode needs a branch, 3.0). */
  not_git: Schema.Struct({ directory: Schema.String, unborn: optional(Schema.Boolean) }),
  /** Below 2.40 integration is impossible (4.2). */
  git_too_old: Schema.Struct({ version: Schema.String, minimum: Schema.String }),
  lfs_missing: Schema.Struct({ tool: Schema.Literal("git-lfs"), version: Schema.NullOr(Schema.String) }),
  team_off: Schema.Struct({ teamID: TeamID }),
  /**
   * Another op of the same team is running. `waitingFor` (RH-20): it waits for the user's confirm or for a step's wait,
   * since `since`, so the caller can say why; absent while it acts.
   */
  busy: Schema.Struct({
    teamID: TeamID,
    opID: OpID,
    kind: OpKind,
    waitingFor: optional(Schema.Literals(["confirm", "wait"])),
    since: optional(EpochMillis),
  }),
  /**
   * The team service cannot write now (RH-20): another process of this OWN_HOME holds the team controller
   * (`controller_lock`, its `pid`), so nothing is recorded.
   */
  unavailable: Schema.Struct({ why: Schema.Literals(["controller_lock"]), pid: optional(Schema.Number) }),
  /** The 8.4 check that failed. */
  not_safe_point: Schema.Struct({
    areaID: optional(AreaID),
    why: Schema.Literals(["session", "inbox", "permission", "own", "git", "form", "shell", "pty"]),
    sessionIDs: Schema.Array(SessionID),
  }),
  invalid_proposal: Schema.Struct({ rejected: Schema.Array(Rejected) }),
  nonce_invalid: Schema.Struct({}),
  /** A `#` path, a folder inside another worktree, a checkout own only reads, or a malformed folder name. */
  path_forbidden: Schema.Struct({
    path: Schema.String,
    why: Schema.Literals(["hash", "nested", "primary", "other-tool", "prunable", "invalid"]),
  }),
  dirty: Schema.Struct({ directory: Schema.String, count: NonNegativeInt, paths: Schema.Array(Schema.String) }),
  /** A compare-and-swap failed: `ref` was not `expected`. */
  conflict: Schema.Struct({ ref: Schema.String, expected: Schema.String, actual: Schema.NullOr(Schema.String) }),
  /** The target branch is checked out or used by a git operation elsewhere (7.2). */
  in_use: Schema.Struct({ branch: Schema.String, directory: Schema.NullOr(Schema.String) }),
  /** The area's folder failed the identity check or is gone (4.3, 8.8). */
  broken: Schema.Struct({ areaID: AreaID, why: BrokenReason }),
  remote_rejected: Schema.Struct({ remote: Schema.String, message: Schema.String }),
  /** Not in this build (`feature`: a `Feature` or a method), or not for this input. */
  unsupported: Schema.Struct({ feature: Schema.String }),
  /** Team R4 (10.1); same name and meaning as the own.accounts error (07 §8.1). */
  same_company_subscription: Schema.Struct({ accountID: AccountID }),
  /** The preset is not of the area main's group (07 §8.1). */
  preset_wrong_group: Schema.Struct({ group: Preset.Group }),
  /**
   * An area peer that cannot be registered or changed (동료, 2026-10-09): a subagent's conversation (`child`), the team
   * main (`main`), an owner conversation of the team (`owner`) or one that was an owner before (`previous`), already a
   * peer (`peer`), not in the area's folder (`elsewhere`), a label the area uses already (`label`), a role text over
   * 1 KB (`role`), or the area's peer limit (`limit`).
   */
  peer_invalid: Schema.Struct({
    why: Schema.Literals(["child", "main", "owner", "previous", "peer", "elsewhere", "label", "role", "limit"]),
  }),
  /**
   * A conversation that cannot take an area's owner seat (담당 대화 바꾸기): a subagent's conversation (`child`), the
   * team main, current or earlier (`main`), the area's owner already (`owner`), or not a conversation of the area's
   * folder (`elsewhere`); a conversation with no model or account to check (`account`), or whose account cannot be
   * read right now (`unknown`: try again). `note`: an owner note over 1 KB (`area.edit{note}`).
   */
  seat_invalid: Schema.Struct({
    why: Schema.Literals(["child", "main", "owner", "elsewhere", "account", "unknown", "note"]),
  }),
  /**
   * Git 저장소로 만들기 refused (3.0): the folder is a repository already (`exists`), inside the repository at `parent`
   * (`inside`), a system or home folder (`system`), has more files than a first commit made here takes (`too_many`),
   * or the same folder is being made one right now (`busy`).
   */
  git_init_refused: Schema.Struct({ why: GitInitRefusal, parent: Schema.NullOr(Schema.String) }),
  /** A first commit needs `user.name` and `user.email`; git has none here and the request gave none. */
  identity_missing: Schema.Struct({}),
  /** A git step of Git 저장소로 만들기 failed; what that call made was taken back. */
  git_failed: Schema.Struct({
    step: Schema.Literals(["init", "identity", "gitignore", "add", "commit"]),
    message: Schema.String,
  }),
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

/**
 * The error map of one method: the listed types plus `internal_error`, `unsupported` and `unavailable` (RH-20: the
 * controller lock is held elsewhere), which every method has.
 */
function pick<const Names extends ReadonlyArray<ErrorName>>(...names: Names) {
  // SAFETY: the entries are exactly the requested names plus the three every method has, taken from `errors`.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    [...names, "internal_error" as const, "unsupported" as const, "unavailable" as const].map(
      (name): [ErrorName, Schema.Top] => [name, errors[name]],
    ),
  ) as { readonly [K in Names[number] | "internal_error" | "unsupported" | "unavailable"]: (typeof errors)[K] }
}

// ---------------------------------------------------------------------------------------------------------------
// Events (06 §2.7). Only the leader publishes; each carries `eventId` (ULID) and `origin: "global"`.

export const Origin = Schema.Literals(["global"]).annotate({ identifier: "OwnTeam.Origin" })
export type Origin = typeof Origin.Type

const envelope = { eventId: EventID, origin: Origin }

export const NoticeKind = Schema.Literals([
  /** `team.account` waits for the old account's work. */
  "account.waiting",
  "account.moved",
  /** An area preset target breaks the team's R4 (10.1). */
  "preset.repair",
  "paths.added",
  "paths.kept",
  "drift.repaired",
  "rotation.done",
  "lfs.installed",
  "external.found",
  "area.broken",
  "branch.followed",
  "link.blocked",
  "link.copy.dirty",
  "reorg.skipped",
  "detached.kept",
  /** More than 12 team updates in an hour: the next ones are held until `data.until` (5.6 묶기). */
  "wake.limited",
  /** An area's folder moved and the team followed it by its identity (8.8 `폴더가 옮겨져 따라갔습니다`). */
  "folder.followed",
  /** An integration waits (7.2, `Integration.waiting`); `data.folder` names the folder it waits for. */
  "integration.waiting",
  /** Undoing an integration kept a commit made meanwhile in `refs/own/keep/*` (7.4). */
  "undo.kept",
  /** The heavy-folder list grew with the project (06 §4.4, `data.count`, `data.bytes`, `data.dirs`). */
  "heavy.grew",
  /** An ignored folder of an area reached `askDiskBytes` (06 §4.11, `data.dir`, `data.bytes`); nothing is shared. */
  "disk.ignored",
  /**
   * A step of the running op has waited 5 minutes or more (RH-20; kept open until the wait ends): `data.opID`,
   * `data.stepID`, `data.why`, `data.since`, and for a command that holds the folder `data.command`, `data.shellID`.
   */
  "op.stalled",
  /** 담당 대화 바꾸기 moved an area's owner seat: `data.sessionID` holds it now, `data.previous` held it before. */
  "seat.moved",
]).annotate({ identifier: "OwnTeam.NoticeKind" })
export type NoticeKind = typeof NoticeKind.Type

/** Values a notice is worded with (`presetID`, `bytes`, `dir`, …). */
const NoticeData = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]))

/**
 * A notice still open (`team.get` `notices`, 06 §2.7, approved before T2): a `preset.repair` until the preset is
 * fixed, `account.waiting` while its team account move waits, `area.broken` while the area is broken,
 * `integration.waiting` while an integration waits and `link.copy.dirty` while a link copy differs from its record. A
 * window opened after the event (or after a restart) still shows it; `id` stays the same while it is open.
 */
export interface OpenNotice extends Schema.Schema.Type<typeof OpenNotice> {}
export const OpenNotice = Schema.Struct({
  id: Text,
  at: EpochMillis,
  areaID: optional(AreaID),
  kind: NoticeKind,
  text: Schema.String,
  data: optional(NoticeData),
}).annotate({ identifier: "OwnTeam.OpenNotice" })

function event<const S extends Schema.ConstraintDecoder<Readonly<Record<string, unknown>>>>(schema: S) {
  return { schema: Schema.toStandardSchemaV1(schema) }
}

export const Events = {
  "team.changed": event(
    Schema.Struct({ ...envelope, teamID: TeamID, rev: NonNegativeInt }).annotate({
      identifier: "OwnTeam.Event.TeamChanged",
    }),
  ),
  /** `rev`: the team's registry revision after the change. */
  "area.changed": event(
    Schema.Struct({
      ...envelope,
      teamID: TeamID,
      areaID: AreaID,
      rev: NonNegativeInt,
      status: Status,
      paused: Paused,
    }).annotate({ identifier: "OwnTeam.Event.AreaChanged" }),
  ),
  /** `waiting`: the area's outbox size. */
  "outbox.changed": event(
    Schema.Struct({ ...envelope, teamID: TeamID, areaID: AreaID, waiting: NonNegativeInt }).annotate({
      identifier: "OwnTeam.Event.OutboxChanged",
    }),
  ),
  "integration.changed": event(
    Schema.Struct({
      ...envelope,
      teamID: TeamID,
      areaID: AreaID,
      integrationID: IntegrationID,
      state: IntegrationState,
    }).annotate({ identifier: "OwnTeam.Event.IntegrationChanged" }),
  ),
  /** `wait` (RH-20): why the step waits now; absent when it does not wait (any more). */
  "op.progress": event(
    Schema.Struct({
      ...envelope,
      teamID: TeamID,
      opID: OpID,
      stepID: Text,
      state: StepState,
      text: Schema.String,
      wait: optional(StepWait),
    }).annotate({ identifier: "OwnTeam.Event.OpProgress" }),
  ),
  /** The auto steps ended; `pending` confirm steps may remain (`state: "waiting"`). */
  "op.done": event(
    Schema.Struct({
      ...envelope,
      teamID: TeamID,
      opID: OpID,
      state: OpState,
      summary: Schema.NullOr(Summary),
      undoable: Schema.Boolean,
      pending: NonNegativeInt,
    }).annotate({ identifier: "OwnTeam.Event.OpDone" }),
  ),
  "op.confirm": event(
    Schema.Struct({ ...envelope, ...Confirm.fields }).annotate({ identifier: "OwnTeam.Event.OpConfirm" }),
  ),
  /** `data`: kind-specific values for wording (`presetID`, `bytes`, `dir`, …). */
  notice: event(
    Schema.Struct({
      ...envelope,
      teamID: TeamID,
      areaID: optional(AreaID),
      kind: NoticeKind,
      text: Schema.String,
      data: optional(NoticeData),
    }).annotate({ identifier: "OwnTeam.Event.Notice" }),
  ),
  /** A worktree conversation of `parentID` changed (13): own-web reads `worktreeChat.list` again. */
  "worktreeChat.changed": event(
    Schema.Struct({ ...envelope, parentID: Text }).annotate({ identifier: "OwnTeam.Event.WorktreeChatChanged" }),
  ),
}

// ---------------------------------------------------------------------------------------------------------------
// Definition (06 §2.7 is the only method list; T2 and T3 methods answer `unsupported` until their build)

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

const team = { teamID: TeamID }
const area = { teamID: TeamID, areaID: AreaID }
const started = Schema.Struct({ opID: OpID })
const areaResult = Schema.Struct({ area: AreaView })

export const Definition = Rpc.define({
  id: ID,
  methods: {
    health: method(empty, Health, pick()),
    "team.get": method(
      Schema.Struct({ directory: Text }),
      Schema.Struct({
        team: Schema.NullOr(Team),
        areas: Schema.Array(AreaView),
        /** Outbox size per area. */
        waiting: keyedRecord(AreaID, NonNegativeInt),
        /** The running or waiting op. */
        op: Schema.NullOr(Op),
        pending: Schema.Array(Confirm),
        /** Notices still open, oldest first (absent from older services). */
        notices: optional(Schema.Array(OpenNotice)),
      }),
      pick("not_found", "not_git"),
    ),
    "team.list": method(empty, Schema.Struct({ teams: Schema.Array(TeamListItem) }), pick()),

    /**
     * `sessionID`: the conversation being viewed; its folder becomes the main folder (3.2). `areaRoot` (06 §4.12,
     * 2026-10-27): where a new team keeps its area folders, `inside` = `<main folder>/.worktrees` (the default) or
     * `beside` = `<main folder's parent>/<name>-team`; a team turned on again keeps the place it has.
     */
    enable: method(
      Schema.Struct({
        directory: Text,
        sessionID: optional(SessionID),
        hint: optional(Schema.String.check(Schema.isMaxLength(2_000))),
        areaRoot: optional(AreaRoot),
      }),
      started,
      pick("not_found", "not_git", "git_too_old", "lfs_missing", "busy", "path_forbidden"),
    ),
    /** `cleanup`: also retire integrated, clean areas with one bundled confirm (3.8). */
    disable: method(
      Schema.Struct({ ...team, cleanup: optional(Schema.Boolean) }),
      started,
      pick("not_found", "team_off", "busy"),
    ),
    /** Changes the main folder (undoable). */
    "team.home": method(
      Schema.Struct({ ...team, directory: Text }),
      started,
      pick("not_found", "not_git", "team_off", "busy", "path_forbidden", "broken"),
    ),
    /** `on`: 모두 멈추기 (`"all"` on areas without Main 멈춤, owners interrupted); off: only `"all"` areas resume. */
    "team.pause": method(
      Schema.Struct({ ...team, on: Schema.Boolean }),
      Schema.Struct({ team: Team }),
      pick("not_found", "team_off"),
    ),
    /** Main 멈춤 (`"user"`); off wakes the stopped queue and sends waiting requests by the 5.1 rule. */
    "area.pause": method(Schema.Struct({ ...area, on: Schema.Boolean }), areaResult, pick("not_found", "team_off")),

    "op.get": method(Schema.Struct({ opID: OpID }), Schema.Struct({ op: Op }), pick("not_found")),
    /** The nonce lives 10 minutes; `skip` = 두기. */
    "op.confirm": method(
      Schema.Struct({ opID: OpID, stepID: Text, choice: Schema.Literals(["do", "skip"]), nonce: Nonce }),
      Schema.Struct({ op: Op }),
      pick("not_found", "nonce_invalid", "team_off"),
    ),
    "op.undo": method(
      Schema.Struct({ opID: OpID }),
      started,
      pick("not_found", "team_off", "busy", "not_safe_point", "dirty", "conflict"),
    ),
    /**
     * 취소 (RH-20): an op that waits (a step's wait or the user's confirms) ends `cancelled`, its remaining steps
     * skipped; `busy` while a step acts (nothing is stopped half way). A cancelled `fresh` rotation sends its request to
     * the current owner as a plain request.
     */
    "op.cancel": method(
      Schema.Struct({ opID: OpID }),
      Schema.Struct({ op: Op }),
      pick("not_found", "team_off", "busy"),
    ),
    /**
     * 바로 진행 (RH-20): the waiting step's fallback now (`force`), or the commands that hold the folder stopped first
     * (`stop-shell`). Only what the step's `wait.actions` offers; `unsupported` otherwise.
     */
    "op.force": method(
      Schema.Struct({ opID: OpID, action: optional(Schema.Literals(["force", "stop-shell"])) }),
      Schema.Struct({ op: Op }),
      pick("not_found", "team_off", "busy"),
    ),

    /** 팀에 넣기 / 빼기 (8.2). */
    "area.adopt": method(
      Schema.Struct({ ...team, directory: Text }),
      started,
      pick("not_found", "not_git", "team_off", "busy", "path_forbidden", "broken"),
    ),
    "area.unadopt": method(Schema.Struct(area), started, pick("not_found", "team_off", "busy", "not_safe_point")),

    "outbox.list": method(
      Schema.Struct(area),
      Schema.Struct({
        items: Schema.Array(Dispatch),
        /** Why the outbox does not move now; absent when the next request can go. */
        why: optional(WaitReason),
        /** Since when it waits for that reason (RH-20; the oldest request's time when this service did not see it start). */
        since: optional(EpochMillis),
        /** What holds it (RH-20). */
        cause: optional(WaitCause),
        /** Notes (쪽지) held for the area's owner and peers, oldest first (06 §5.8); absent from older services. */
        notes: optional(Schema.Array(AreaNote)),
      }),
      pick("not_found"),
    ),
    "outbox.cancel": method(Schema.Struct({ ...area, dispatchID: DispatchID }), empty, pick("not_found", "team_off")),

    /** 새 대화로 이어가기 (6.1). */
    "area.rotate": method(Schema.Struct(area), started, pick("not_found", "team_off", "busy", "broken")),
    /**
     * 이 대화를 담당으로 (담당 대화 바꾸기): the area's owner seat moves onto `sessionID`, a root conversation of the
     * area's folder (a peer of the area and an earlier owner included). The op waits until the area and that
     * conversation rest, then swaps; nothing is interrupted. The conversation keeps its model and preset, and the old
     * owner conversation stays an ordinary one. Team R4 is checked (`same_company_subscription`).
     */
    "area.seat": method(
      Schema.Struct({ ...area, sessionID: SessionID }),
      started,
      pick("not_found", "team_off", "busy", "broken", "same_company_subscription", "seat_invalid"),
    ),
    /** 메인 새 대화 (6.5). */
    "main.rotate": method(Schema.Struct(team), started, pick("not_found", "team_off", "busy")),

    /**
     * `model: null` = 팀과 같게. An account change continues in a new conversation at the next safe point, or now
     * through the own.accounts switch with `now: true`; a model or effort change always switches now (10.1).
     */
    "area.main": method(
      Schema.Struct({ ...area, model: Schema.NullOr(Model.Ref), now: optional(Schema.Boolean) }),
      Schema.Struct({ area: AreaView, opID: optional(OpID) }),
      pick("not_found", "team_off", "busy", "broken", "same_company_subscription"),
    ),
    /** 팀 계정 바꾸기 (10.1): the whole team waits for (`after-idle`) or stops (`stop`) the old account's work. */
    "team.account": method(
      Schema.Struct({
        ...team,
        target: Model.Ref,
        mode: optional(Schema.Literals(["after-idle", "stop"])),
        dryRun: optional(Schema.Boolean),
      }),
      Schema.Union([Schema.Struct({ plan: AccountPlan }), started]),
      pick("not_found", "team_off", "busy", "same_company_subscription"),
    ),
    /** Applied to the current owner conversation at once through own.accounts `session.preset.apply` (07 §5.3). */
    "area.preset": method(
      Schema.Struct({ ...area, presetID: Preset.ID }),
      areaResult,
      pick("not_found", "team_off", "broken", "same_company_subscription", "preset_wrong_group"),
    ),
    /** 큰 파일 폴더 가져오기 / 내려놓기 (4.6, 4.7). */
    "area.paths": method(
      Schema.Struct({
        ...area,
        add: optional(Schema.Array(Dir).check(Schema.isMaxLength(PATHS_MAX))),
        release: optional(Schema.Array(Dir).check(Schema.isMaxLength(PATHS_MAX))),
        reason: optional(Schema.String.check(Schema.isMaxLength(200))),
      }),
      started,
      pick("not_found", "team_off", "busy", "broken", "path_forbidden", "lfs_missing"),
    ),

    /**
     * 역할 바꾸기… and 내가 정한 영역 (06 §2.7, 2026-10-26): the area's role text (`goal`, at most 1,000 characters,
     * refused above and never cut, 2026-11-14) and its user-made mark (`false` removes it). A registry write only: no
     * op, no undo; an attached owner gets its role entry again at once when the role changed. `note` (담당 메모,
     * feature `owner-note`): the owner note, trimmed, at most {@link OWNER_NOTE_MAX} characters (`seat_invalid` with
     * `why: "note"`); an empty one removes it.
     */
    "area.edit": method(
      Schema.Struct({
        ...area,
        goal: optional(Schema.String.check(Schema.isMaxLength(1_000))),
        userMade: optional(Schema.Boolean),
        note: optional(Schema.String),
      }),
      areaResult,
      pick("not_found", "team_off", "broken", "seat_invalid"),
    ),
    /**
     * 영역 만들기's `만들 곳` (06 §2.7, §9.4, 2026-10-27, feature `area-edit`): the folder and record name a new area of
     * `slug` gets if it is made now. V6 takes `<slug>-2`, `-3`, … when an area, a branch or a non-empty folder has the
     * name; `taken` says which held the name asked for. Reads only.
     */
    "area.create.check": method(
      Schema.Struct({ ...team, slug: Slug }),
      Schema.Struct({ slug: Slug, directory: Text, taken: optional(Schema.Literals(["area", "branch", "folder"])) }),
      pick("not_found", "team_off", "not_git", "path_forbidden", "invalid_proposal"),
    ),
    /**
     * 동료로 등록… / 동료 추가… (06 §2.7, 2026-10-09): `sessionID` registers a root conversation of the area's folder (it
     * keeps its model and preset; the team allows and the peer role go on at its first main request); `create` makes a
     * new conversation in the folder on the area main with the area preset, its allows and role from the start. Team R4
     * is checked for a registered one (`same_company_subscription`).
     */
    "area.peer.add": method(
      Schema.Union([
        Schema.Struct({ ...area, sessionID: SessionID, label: Peer.fields.label, role: Peer.fields.role }),
        Schema.Struct({ ...area, create: Schema.Struct({ label: Peer.fields.label, role: Peer.fields.role }) }),
      ]),
      Schema.Struct({ area: AreaView, peer: Peer }),
      pick("not_found", "team_off", "broken", "same_company_subscription", "peer_invalid"),
    ),
    /** 역할 바꾸기…: a new label or role text (an attached peer's role entry is written again). */
    "area.peer.edit": method(
      Schema.Struct({ ...area, key: Slug, label: optional(Peer.fields.label), role: optional(Peer.fields.role) }),
      areaResult,
      pick("not_found", "team_off", "peer_invalid"),
    ),
    /**
     * 동료에서 빼기: the record goes, an attached peer loses the team allows and its role entry, and main requests that
     * waited for it are cancelled (a team note tells the main). The conversation stays the user's.
     */
    "area.peer.remove": method(Schema.Struct({ ...area, key: Slug }), areaResult, pick("not_found", "team_off")),

    /** 반영하기 (7); also retries a waiting integration. */
    "area.integrate": method(
      Schema.Struct(area),
      Schema.Struct({ opID: OpID, integrationID: IntegrationID }),
      pick("not_found", "team_off", "busy", "broken", "dirty", "in_use"),
    ),
    "integration.get": method(
      Schema.Struct({ integrationID: IntegrationID }),
      Schema.Struct({ integration: Integration }),
      pick("not_found"),
    ),
    /** Only while the target is still K (7.4). */
    "integration.undo": method(
      Schema.Struct({ integrationID: IntegrationID }),
      started,
      pick("not_found", "team_off", "busy", "not_safe_point", "conflict", "in_use"),
    ),
    /**
     * 되돌리기 취소 (7.4, RH-42, feature `undo-cancel`): the undo that waits outside its op (`Integration.undoing`) is
     * dropped and nothing changes; the integrations into the same target it held go on. `busy` while its op runs (that
     * op is `op.cancel`'s); `not_found` when no undo waits.
     */
    "integration.undo.cancel": method(
      Schema.Struct({ integrationID: IntegrationID }),
      Schema.Struct({ integration: Integration }),
      pick("not_found", "team_off", "busy"),
    ),
    /** `pr`: 검토 요청 올리기. Shows the remote, ref and commands before anything runs (7.5). */
    "integration.push.plan": method(
      Schema.Struct({ integrationID: IntegrationID, pr: optional(Schema.Boolean) }),
      Schema.Struct({
        nonce: Nonce,
        expiresAt: EpochMillis,
        remote: Text,
        ref: Text,
        commands: Schema.Array(Schema.String),
      }),
      pick("not_found", "team_off", "lfs_missing"),
    ),
    "integration.push.execute": method(
      Schema.Struct({ nonce: Nonce }),
      started,
      pick("nonce_invalid", "busy", "lfs_missing", "remote_rejected"),
    ),

    /**
     * 팀 구성 다시 보기: a judge call on the main session (`session.generate`, 8.1); `hint` is what the user typed there.
     * `plan` is the plan as `reorg.apply{proposalID}` would run it (by `auto`), and its `skipped` lists what that run
     * would skip now. own-web shows the items with checkboxes and applies the chosen ones as
     * `reorg.apply{proposalID, items}` (by `user`, 2026-10-16; by id since 2026-10-27).
     */
    "reorg.propose": method(
      Schema.Struct({ ...team, hint: optional(Schema.String.check(Schema.isMaxLength(2_000))) }),
      Schema.Struct({ proposalID: ProposalID, proposal: Proposal, plan: Plan }),
      pick("not_found", "team_off", "busy"),
    ),
    /**
     * `proposalID`: a stored judge proposal, run by `auto` (kept for older clients) or, with `items`, only the items the
     * user chose in 팀 구성 다시 보기, run by `user` as the judge wrote them (2026-10-27, with feature `area-edit`): what
     * only the user sets (a new area's model, 에이전트 방식 and user-made mark) stays out. `proposal`: a proposal the
     * user wrote (by `user`, 2.7: the area menu, 영역 만들기), which keeps them; a build without `area-edit` takes the
     * chosen items this way too (2026-10-16). A new
     * area or a split on an SSH host whose repository uses Git LFS answers `lfs_missing` until the bundled git-lfs is
     * there (4.13: own-web uploads it once and asks again, as for `enable`); `not_git` when git cannot read it.
     */
    "reorg.apply": method(
      Schema.Union([
        Schema.Struct({
          ...team,
          proposalID: ProposalID,
          items: optional(Schema.Array(ChosenItem).check(Schema.isMaxLength(256))),
        }),
        Schema.Struct({ ...team, proposal: Proposal }),
      ]),
      started,
      pick(
        "not_found",
        "team_off",
        "busy",
        "invalid_proposal",
        "path_forbidden",
        "git_too_old",
        "lfs_missing",
        "not_git",
      ),
    ),

    "decisions.list": method(
      Schema.Struct(team),
      Schema.Struct({ items: Schema.Array(DecisionRecord) }),
      pick("not_found"),
    ),
    /** 결정 적기 (6.6). */
    "decisions.add": method(
      Schema.Struct({
        ...team,
        title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        body: Schema.String.check(Schema.isMaxLength(65_536)),
      }),
      Schema.Struct({ number: PositiveInt, file: Text }),
      pick("not_found", "team_off"),
    ),

    "settings.get": method(Schema.Struct(team), TeamSettings, pick("not_found")),
    "settings.set": method(
      Schema.Struct({ ...team, patch: SettingsPatch }),
      Schema.Struct({ team: Team }),
      pick("not_found"),
    ),
    diagnostics: method(Schema.Struct(team), Diagnostics, pick("not_found")),

    /**
     * Worktree conversations (13, 2026-11-24): the ones `sessionID` started, newest first, and for a started one its
     * parent (`parent`). Reads the KV record and core's live state (running, waiting permissions and questions).
     */
    "worktreeChat.list": method(
      Schema.Struct({ sessionID: Text }),
      Schema.Struct({
        items: Schema.Array(WorktreeChat),
        parent: optional(Schema.Struct({ sessionID: Text, title: optional(Schema.String) })),
      }),
      pick(),
    ),

    /** Git 저장소로 만들기 (3.0): what `project.gitInit` would do in a folder that is not a repository; reads only. */
    "project.gitInit.plan": method(
      Schema.Struct({ directory: Text }),
      GitInitPlan,
      pick("not_found", "git_too_old", "git_init_refused"),
    ),
    /**
     * `git init -b main` in the folder (its own `.git`, no file changed), and with `firstCommit` the first commit of
     * the plan's files (team mode and worktrees need one). On a repository without a commit only the first commit.
     */
    "project.gitInit": method(
      Schema.Struct({ directory: Text, firstCommit: optional(GitInitCommit) }),
      GitInitResult,
      pick("not_found", "git_too_old", "git_init_refused", "identity_missing", "git_failed"),
    ),
  },
  events: Events,
})
export type Definition = typeof Definition

export type MethodName = keyof Definition["methods"] & string
export type EventName = keyof Definition["events"] & string

// ---------------------------------------------------------------------------------------------------------------
// Routing (06 §2.7): the tables live in `rpc-team-routing.ts`

/** own.accounts' vocabulary (02 §9.1). `local` is never given to a remote device (05 §13.5). */
export const Scope = Schema.Literals(["read", "prompt", "switch", "admin", "local"]).annotate({
  identifier: "OwnTeam.Scope",
})
export type Scope = typeof Scope.Type

/** Every own.team method goes to the control location (06 §2.7). */
export const Location = Schema.Literals(["control"]).annotate({ identifier: "OwnTeam.Location" })
export type Location = typeof Location.Type

/** Typed so that a new method cannot be added without a scope or a location. */
export { MethodScope, MethodLocation, EventOrigin } from "./rpc-team-routing.js"
