// Result cards of team ops (06 §9.3, §9.7, §3.8, 07 §7.4), in the team chunk. Every ended op is in the notification
// list (shell/notifications.tsx). `TeamResultCards` shows the team's open ones above the team main, newest first,
// together with its running or waiting op. A card reads its op (`op.get`) and the team record (`team.get` through the
// TeamStore), and `resultCard` turns them into lines. An integrate op (반영하기 and its upload, 7) shows the
// integration's own card instead (integrate.tsx), which follows the integration and answers its confirm; an
// integration that ran in several ops (the first `.assets` confirm, 4.10; its upload) has one card, its newest op's.
// - Enabling (9.3) says the areas, how adopted conversations are treated and the main line of 07 §7.4. Without an
//   adopted area that line is `모든 영역이 팀 메인(<모델> · <강도>)과 '<묶음의 ★>'을 씁니다`. With one it is
//   `메인과 새 영역: … @ <계정>, 프리셋 '…'`. Then the heavy folders areas leave out (0.4), the main folder `[바꾸기]`,
//   the folders left untouched and the auto-allow line `[바꾸기]` (settings 팀).
// - Then the lines that depend on what happened: active folders left outside `[팀에 넣기]`, the team's R4
//   `[이 영역 빼기]`, adopted areas that keep their account or preset (enabling, 팀에 넣기), the worst case of heavy
//   presets (10.3), disk used, the main folder's uncommitted changes, an old Git, confirms, the judge's notes and
//   suggestions, skipped items, cancelled and queued main requests, kept locks, large-file folders, a team account
//   move, integrations and uploads. Reorganizing, 팀에 넣기 / 빼기 and fetching folders reuse the card (area lines, 9.7).
// - Buttons: `[메인과 대화하기] [자세히] [되돌리기] [닫기]`. 자세히 lists the steps in plain words and the own marks
//   that protect work. A button shows only when this build of own.team has the feature (`health.features`) and this
//   connection the scope. Confirms are answered in the card: a fetch with `[받기] [나중에]`, and a removal or a
//   system change (a shared folder made read-only, the `.assets` folder) through the confirm dialog, which says what
//   is removed and what stays, or what changes and how to undo it. A gateway device only sees them. A suggestion to
//   finish an area (`[끝내기…]`) opens the area menu's 영역 끝내기 panel. A join whose 되돌리기 answers `conflict` (A
//   moved on) and a join's undo that left B out (its folder gone) say so with `[다시 만들기]` (8.2 'B 다시 만들기'),
//   which opens the area menu's 다시 만들기 panel for B.
// - Above the cards: the retire suggestions of the team's quiet areas (team/reorg.tsx, `AreaView.retirable`, 8.1).
import type { OwnTeam } from "@own/protocol/rpc-team"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Suspense,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { OwnRpcError, useData, type ServerKey, type ServerRuntime } from "@/data"
import { TEAM_META } from "@/data/team-rpc"
import { formatBytes } from "@/files/strings"
import { useI18n } from "@/i18n"
import { starOf } from "@/presets/model"
import { mainGroup, presetByID, presetName } from "@/presets/session-view"
import { presetsText } from "@/presets/strings"
import { useRouter } from "@/routing/router"
import { closeTeamResult, RESULT_TITLE, teamResults } from "@/shell/notifications"
import { accountOf, modelName, variantName } from "@/switcher/labels"
import { showToast } from "@/switcher/toast"
import { confirmBytes, isDestructive, isFetch, isSystem, TeamConfirmDialog } from "./confirm"
import { failed } from "./enable"
import IntegrationCard from "./integrate"
import { openAreaMenu, openTeamSettings } from "./intents"
import { runningOn, stepLabel, viewOnlyText, worstCase, type RunningOn, type TeamText } from "./model"
import { lfsUpload, withLfs } from "./lfs"
import { areaOf, openRecreatePanel, openRetirePanel, RetireSuggestions } from "./reorg"
import type { TeamEntry } from "./store"
import { useTeamText, type TeamKey } from "./strings"
import { OpWait } from "./wait"
import "./team.css"

/** What a button on a card does. */
export type CardAction =
  | { readonly kind: "home"; readonly directories: readonly string[] }
  | { readonly kind: "settings" }
  | { readonly kind: "adopt"; readonly directory: string }
  | { readonly kind: "unadopt"; readonly areaID: OwnTeam.AreaID }
  | { readonly kind: "clear"; readonly sessionIDs: readonly string[] }
  | { readonly kind: "retire"; readonly area: string }
  | { readonly kind: "recreate"; readonly areaID: OwnTeam.AreaID }
  /** 동료 추가… of an area the user created (영역 만들기, 2026-10-26): the area menu's peer form. */
  | { readonly kind: "addPeer"; readonly areaID: OwnTeam.AreaID }
  /** 06 §8.1 (2026-10-16): a skipped action again, as the user's own `reorg.apply{proposal}` (it waits for the area). */
  | {
      readonly kind: "redo"
      readonly proposal: OwnTeam.Proposal
      readonly areaID: OwnTeam.AreaID
      readonly item: string
    }

export interface CardLine {
  /** Empty for a line that is only its button. */
  readonly text: string
  /** `muted`: the judge's words; `warn`: something waits for the user. */
  readonly tone?: "muted" | "warn"
  readonly action?: { readonly label: string; readonly run: CardAction }
}

export interface Card {
  readonly title: string
  /** The op's state while it runs, waits, failed or was cancelled. */
  readonly state?: string
  readonly lines: readonly CardLine[]
  /** 자세히: the steps in plain words, and the own marks that protect work. */
  readonly details: readonly string[]
}

/** Names the card shows, resolved by the caller from the stores. */
export interface CardNames {
  /** The team main (07 §7.4): model, effort, account. */
  readonly main?: RunningOn
  /** The ★ preset of the team main's group: its id and its name. */
  readonly star?: { readonly id: string; readonly name: string }
  /** The ★ preset id of a model's group: an adopted area on another company's account keeps that group's presets. */
  readonly starOf: (ref: { readonly providerID: string }) => string | undefined
  readonly preset: (presetID: string) => string
  readonly account: (accountID: string) => string
  /**
   * The account label of a model's provider; with the session that runs it, that session's account (SL-8: several
   * Claude accounts share `anthropic`, so the provider alone names only the first).
   */
  readonly accountOf: (ref: { readonly providerID: string }, sessionID?: string | null) => string | undefined
  readonly bytes: (bytes: number) => string
  /** The worst case line when some area preset is heavy (06 §10.3). */
  readonly worst?: string
}

export interface CardInput {
  readonly op: Pick<OwnTeam.Op, "kind" | "state" | "summary" | "steps">
  /** `op`: the team's running or waiting op (absent: none known). */
  readonly team?: Pick<TeamEntry, "team" | "areas" | "order"> & Partial<Pick<TeamEntry, "op">>
  /** Confirms of this op that wait. */
  readonly pending: number
  readonly names: CardNames
  /** This build has the feature and this connection the scope for an action. */
  readonly can: (action: CardAction["kind"]) => boolean
  /** The join's undo answered `conflict` (A moved on since, 8.2): only 'B 다시 만들기' is left. */
  readonly undoConflict?: boolean
  /** Skipped items this window already started again (`[다시 하기]`), by their proposal pointer. */
  readonly redone?: ReadonlySet<string>
}

const STEP_STATE: Readonly<Record<OwnTeam.StepState, TeamKey>> = {
  pending: "own.team.step.state.pending",
  done: "own.team.step.state.done",
  skipped: "own.team.step.state.skipped",
  needs_confirm: "own.team.step.state.needsConfirm",
  failed: "own.team.step.state.failed",
}

const SKIPPED: Readonly<Record<OwnTeam.SkipReason, TeamKey>> = {
  paused: "own.team.card.skipped.paused",
  busy: "own.team.card.skipped.busy",
  broken: "own.team.card.skipped.broken",
  unsupported: "own.team.card.skipped.unsupported",
  invalid: "own.team.card.skipped.invalid",
}

const CHANGED: Readonly<Record<OwnTeam.AreaChange, TeamKey>> = {
  created: "own.team.card.area.created",
  adopted: "own.team.card.area.adopted",
  renamed: "own.team.card.area.renamed",
  rotated: "own.team.card.area.rotated",
  split: "own.team.card.area.split",
  merged: "own.team.card.area.merged",
  retired: "own.team.card.area.retired",
  converted: "own.team.card.area.converted",
  unadopted: "own.team.card.area.unadopted",
  touched: "own.team.card.area.touched",
  seated: "own.team.card.area.seated",
}

const SUGGESTED: Readonly<Record<OwnTeam.Suggestion["kind"], TeamKey>> = {
  retire: "own.team.card.suggest.retire",
  convert: "own.team.card.suggest.convert",
  move: "own.team.card.suggest.move",
  split: "own.team.card.suggest.split",
  merge: "own.team.card.suggest.merge",
}

/** The card of an op (06 §9.3): title, state, lines and 자세히. Pure. */
export function resultCard(text: TeamText, input: CardInput): Card {
  const op = input.op
  const name = (areaID: string) => input.team?.areas[areaID]?.name ?? areaID.replace(/^ar_/, "")
  return {
    title: text(RESULT_TITLE[op.kind]),
    state: stateText(text, op),
    lines: [
      ...(op.kind === "enable" ? enableLines(text, input, name) : areaLines(text, input, name)),
      ...factLines(text, input, name),
      ...recreateLines(text, input, name),
    ],
    details: [
      ...op.steps.map((step) =>
        [stepLabel(text, step.kind), text(STEP_STATE[step.state]), ...(step.note ? [step.note] : [])].join(" · "),
      ),
      ...(op.summary?.lines ?? []).flatMap((line) =>
        line.kind === "ref" ? [text("own.team.card.kept", { name: line.ref })] : [],
      ),
    ],
  }
}

function stateText(text: TeamText, op: CardInput["op"]) {
  if (op.state === "done") return undefined
  if (op.state === "failed") {
    const reason = op.steps.find((step) => step.state === "failed")?.note
    return text("own.team.card.state.failed", { reason: reason ?? text("own.team.error.internalError") })
  }
  return text(`own.team.card.state.${op.state}`)
}

/** 9.3 / 07 §7.4: the areas, adopted conversations, the main line, the main folder, untouched folders, auto-allow. */
function enableLines(text: TeamText, input: CardInput, name: (areaID: string) => string): CardLine[] {
  const team = input.team
  const made = (input.op.summary?.lines ?? []).flatMap((line) =>
    line.kind === "area" && (line.change === "created" || line.change === "adopted")
      ? [{ areaID: line.areaID, adopted: line.change === "adopted" }]
      : [],
  )
  // 다시 켜기 (3.8) makes nothing: the card names the areas the team has.
  const placed =
    made.length > 0 || !team
      ? made
      : team.order.flatMap((areaID) => {
          const area = team.areas[areaID]
          return area && area.state !== "retired" ? [{ areaID, adopted: area.origin === "adopted" }] : []
        })
  const adopted = placed.some((item) => item.adopted)
  const main = input.names.main
  const star = input.names.star
  const areas =
    placed.length === 0
      ? text("own.team.card.noAreas")
      : [
          text("own.team.card.areas", { n: placed.length, names: placed.map((item) => name(item.areaID)).join(" · ") }),
          ...(adopted ? [text("own.team.card.adoptedFolders")] : []),
        ].join(" ")
  const mainLine =
    main && star
      ? adopted
        ? text("own.team.card.mainAndNew", { main: runningOn(text, main), preset: star.name })
        : text("own.team.card.allAreas", {
            main: runningOn(text, { model: main.model, effort: main.effort }),
            preset: star.name,
          })
      : undefined
  const head = [
    { text: areas },
    ...(adopted ? [{ text: text("own.team.card.adoptedRole") }] : []),
    ...(mainLine ? [{ text: mainLine }] : []),
    // 0.4: `큰 파일 폴더 3개(14.7 GB)는 영역 폴더에 받지 않습니다`.
    ...(input.op.summary?.lines ?? []).flatMap((line) =>
      line.kind === "heavy" && line.dirs.length > 0
        ? [{ text: text("own.team.card.heavy", { n: line.dirs.length, size: input.names.bytes(line.bytes) }) }]
        : [],
    ),
  ]
  if (!team) return head
  const external = team.team.external
  const tools = external.filter((item) => item.why === "other-tool").length
  const folders = external
    .filter((item) => item.why === "primary" || item.why === "hash-path")
    .map((item) => item.directory)
    .join(", ")
  // 3.2: a main folder is a checkout that is no other tool's, has no `#` and is no area.
  const homes = external
    .filter((item) => (item.why === "primary" || item.why === "left") && !item.directory.includes("#"))
    .map((item) => item.directory)
  const outside =
    tools > 0 && folders
      ? text("own.team.card.outside", { n: tools, folders })
      : tools > 0
        ? text("own.team.card.outsideTools", { n: tools })
        : folders
          ? text("own.team.card.outsideFolders", { folders })
          : undefined
  const change = text("own.team.action.change")
  return [
    ...head,
    {
      text: text("own.team.card.home", { folder: team.team.home.directory }),
      action:
        homes.length > 0 && input.can("home")
          ? { label: change, run: { kind: "home", directories: homes } }
          : undefined,
    },
    ...(outside ? [{ text: outside }] : []),
    ...(team.team.policy.autoAllow
      ? [
          {
            text: text("own.team.card.autoAllow"),
            action: input.can("settings") ? { label: change, run: { kind: "settings" as const } } : undefined,
          },
        ]
      : []),
  ]
}

/**
 * Area lines of other ops (reorganizing, finishing, undoing): `'<영역>' 영역을 만들었습니다` and so on. An area the user
 * created (영역 만들기, 2026-10-26) that is still active offers `동료 추가…`.
 */
function areaLines(text: TeamText, input: CardInput, name: (areaID: string) => string): CardLine[] {
  return (input.op.summary?.lines ?? []).flatMap((line): CardLine[] => {
    if (line.kind !== "area") return []
    const area = input.team?.areas[line.areaID]
    const peer =
      line.change === "created" && area?.state === "active" && area.userMade !== undefined && input.can("addPeer")
    return [
      {
        text: text(CHANGED[line.change], { area: name(line.areaID), from: line.from ? name(line.from) : "" }),
        ...(peer
          ? { action: { label: text("own.team.areaMenu.addPeer"), run: { kind: "addPeer", areaID: line.areaID } } }
          : {}),
      },
    ]
  })
}

/** The lines that depend on what the op did, in the order of 06 §9.3. */
function factLines(text: TeamText, input: CardInput, name: (areaID: string) => string): CardLine[] {
  const lines = input.op.summary?.lines ?? []
  const of = <K extends OwnTeam.SummaryLine["kind"]>(kind: K) =>
    lines.filter((line): line is Extract<OwnTeam.SummaryLine, { kind: K }> => line.kind === kind)
  const names = input.names
  const queued = of("queued")
  const queuedCount = queued.reduce((sum, line) => sum + line.count, 0)
  const cancelled = of("cancelled").length
  return [
    ...of("unadopted").map((line): CardLine => {
      const detail = [
        ...(line.changes > 0 ? [text("own.team.card.unadopted.changes", { n: line.changes })] : []),
        ...(line.ahead > 0 ? [text("own.team.card.unadopted.ahead", { n: line.ahead })] : []),
      ].join(", ")
      return {
        text: text("own.team.card.unadopted", { folder: shortName(line.directory), detail }),
        tone: "warn",
        action: input.can("adopt")
          ? { label: text("own.team.action.adopt"), run: { kind: "adopt", directory: line.directory } }
          : undefined,
      }
    }),
    ...of("r4").map(
      (line): CardLine => ({
        text: text("own.team.card.r4", {
          area: name(line.areaID),
          account: names.account(line.accountID),
          team: names.main?.account ?? "",
        }),
        action: input.can("unadopt")
          ? { label: text("own.team.action.removeArea"), run: { kind: "unadopt", areaID: line.areaID } }
          : undefined,
      }),
    ),
    ...(input.op.kind === "enable" || input.op.kind === "adopt" ? keepsLines(text, input) : []),
    // 06 §4.4: the heavy list grew with the project (the enable card says its own list above).
    ...(input.op.kind === "heavy"
      ? of("heavy").map((line) => ({
          text: text("own.team.card.heavyGrew", {
            n: line.dirs.length,
            size: names.bytes(line.bytes),
            dirs: line.dirs.join(", "),
          }),
        }))
      : []),
    ...(names.worst ? [{ text: names.worst }] : []),
    ...of("prepare").map((line) => ({ text: text("own.team.card.prepare", { size: names.bytes(line.bytes) }) })),
    ...of("home-changes").map((line) => ({ text: text("own.team.card.homeChanges", { n: line.count }) })),
    ...of("old-git").map((line) => ({ text: text("own.team.card.oldGit", { version: line.version }) })),
    ...(input.pending > 0
      ? [{ text: text("own.team.card.confirms", { n: input.pending }), tone: "warn" as const }]
      : []),
    ...of("notes").map((line) => ({ text: line.text, tone: "muted" as const })),
    ...of("suggest").map((line): CardLine => {
      const suggestion = line.suggestion
      return {
        text: text(SUGGESTED[suggestion.kind], {
          area: suggestion.area === undefined ? "" : name(`ar_${suggestion.area}`),
          folder: suggestion.worktree === undefined ? "" : shortName(suggestion.worktree),
          why: suggestion.why,
        }),
        tone: "muted",
        action:
          suggestion.kind === "retire" && suggestion.area !== undefined && input.can("retire")
            ? { label: text("own.team.action.retire"), run: { kind: "retire", area: suggestion.area } }
            : undefined,
      }
    }),
    ...of("skipped").map((line): CardLine => {
      const redo = redoOf(input, line)
      return {
        text: text(SKIPPED[line.why], { area: line.areaID ? name(line.areaID) : line.item }),
        ...(redo ? { action: { label: text("own.team.card.redo"), run: redo } } : {}),
      }
    }),
    ...(cancelled > 0 ? [{ text: text("own.team.card.cancelled", { n: cancelled }) }] : []),
    ...(queuedCount > 0 && input.can("clear")
      ? [
          {
            text: "",
            action: {
              label: text("own.team.card.clearQueued", { n: queuedCount }),
              run: { kind: "clear" as const, sessionIDs: [...new Set(queued.map((line) => line.sessionID))] },
            },
          },
        ]
      : []),
    ...of("lock-kept").map((line) => ({ text: text("own.team.card.lockKept", { folder: line.directory }) })),
    ...of("paths").flatMap((line) => {
      if (line.change === "added")
        return [
          {
            text: text("own.team.card.paths.added", {
              area: name(line.areaID),
              n: line.dirs.length,
              size: names.bytes(line.bytes),
            }),
          },
        ]
      if (line.change === "released")
        return [{ text: text("own.team.card.paths.released", { area: name(line.areaID), n: line.dirs.length }) }]
      return line.dirs.map((dir) => ({ text: text("own.team.card.paths.kept", { dir }) }))
    }),
    ...of("account").map((line) => ({
      text: text("own.team.card.account", {
        // The account the server recorded (SL-8); a summary written before it names the model's provider.
        account:
          (line.accountID ? names.account(line.accountID) : names.accountOf(line.model)) ?? line.model.providerID,
        n: line.areas,
      }),
    })),
    ...of("integrated").flatMap((line) => [
      { text: text("own.team.card.integrated", { area: name(line.areaID) }) },
      ...(line.newerSkipped > 0 ? [{ text: text("own.team.card.newerSkipped", { n: line.newerSkipped }) }] : []),
    ]),
    ...of("pushed").map((line) => ({
      text: text("own.team.card.pushed", { area: name(line.areaID), remote: line.remote }),
    })),
  ]
}

/**
 * `[다시 하기]` on a skipped line of a reorganization (06 §8.1, TC-D4, 2026-10-16): a split, join or file-shape change
 * the main's or the judge's run skipped for a busy or Main 멈춤 area, offered as the user's own action. Not while a
 * team op runs (it would answer busy), and not once the team shows it done, so a second click never makes a second
 * area (review): the split's area exists, the joined area left, or the shape is the asked one.
 */
function redoOf(
  input: CardInput,
  line: Extract<OwnTeam.SummaryLine, { readonly kind: "skipped" }>,
): CardAction | undefined {
  const op = line.op
  const team = input.team
  if (input.op.kind !== "reorg" || !op || !line.areaID || !team || team.op || !input.can("redo")) return
  if (input.redone?.has(line.item)) return
  // The proposal names an area by id, slug or name (`areaOf`).
  if (op.op === "split" && areaOf(team, op.slug) !== undefined) return
  if (op.op === "merge" && areaOf(team, op.from)?.state !== "active") return
  if (op.op === "convert" && areaOf(team, op.area)?.shape === op.shape) return
  if (op.op !== "split" && op.op !== "merge" && op.op !== "convert") return
  return { kind: "redo", proposal: { version: 1, ops: [op] }, areaID: line.areaID, item: line.item }
}

/**
 * 'B 다시 만들기' (06 §8.2): a join whose undo answered `conflict` because A moved on (`undoConflict`), and a join's
 * undo that left B out because its folder is gone (B is still finished). Each offers `[다시 만들기]`: a new area from
 * B's record (the area menu's 다시 만들기 panel).
 */
function recreateLines(text: TeamText, input: CardInput, name: (areaID: string) => string): CardLine[] {
  const op = input.op
  const action = (areaID: OwnTeam.AreaID) =>
    input.can("recreate")
      ? { label: text("own.team.action.recreate"), run: { kind: "recreate" as const, areaID } }
      : undefined
  const conflict = input.undoConflict ? joinedAreas(op, "merge-into") : []
  const gone =
    op.kind === "undo"
      ? joinedAreas(op, "merge-undo-area").filter((pair) => input.team?.areas[pair.from]?.state === "retired")
      : []
  return [
    ...conflict.map(
      (pair): CardLine => ({
        text: text("own.team.card.recreate.conflict", { into: name(pair.into), area: name(pair.from) }),
        tone: "warn",
        action: action(pair.from),
      }),
    ),
    ...gone.map(
      (pair): CardLine => ({
        text: text("own.team.card.recreate.gone", { area: name(pair.from) }),
        tone: "warn",
        action: action(pair.from),
      }),
    ),
  ]
}

/** The `{into, from}` (A and B) of an op's join steps of `kind` that are done (06 §8.2, own.team `reorg/merge.ts`). */
export function joinedAreas(op: Pick<OwnTeam.Op, "steps">, kind: "merge-into" | "merge-undo-area") {
  return op.steps.flatMap((step) => {
    const into = step.args.into
    const from = step.args.from
    return step.kind === kind && step.state === "done" && isAreaID(into) && isAreaID(from) ? [{ into, from }] : []
  })
}

function isAreaID(value: unknown): value is OwnTeam.AreaID {
  // own.team writes `ar_<slug>` (OwnTeam.AreaID); the client keeps the schema graph out of its chunks.
  return typeof value === "string" && value.startsWith("ar_")
}

/**
 * 9.3: adopted areas that keep another account than the team main's, or a preset other than the ★ of their area
 * main's group (the team main's for an area that follows the team): every adopted area after enabling, the ones this
 * op took in after 팀에 넣기.
 */
function keepsLines(text: TeamText, input: CardInput): CardLine[] {
  const team = input.team
  const names = input.names
  if (!team) return []
  const taken = new Set(
    (input.op.summary?.lines ?? []).flatMap((line) =>
      line.kind === "area" && line.change === "adopted" ? [line.areaID] : [],
    ),
  )
  return team.order.flatMap((id): CardLine[] => {
    const area = team.areas[id]
    if (!area || area.origin !== "adopted" || area.state === "retired") return []
    if (input.op.kind === "adopt" && !taken.has(area.id)) return []
    // The account its owner runs on, so two Claude accounts of the team tell apart (SL-8).
    const account = area.main ? names.accountOf(area.main.model, area.owner.sessionID) : undefined
    const star = area.main ? names.starOf(area.main.model) : names.star?.id
    return [
      ...(account && names.main?.account && account !== names.main.account
        ? [{ text: text("own.team.card.keepsAccount", { area: area.name, account }) }]
        : []),
      ...(star && area.preset !== star
        ? [{ text: text("own.team.card.keepsPreset", { area: area.name, preset: names.preset(area.preset) }) }]
        : []),
    ]
  })
}

/** The open result cards of a team above its main conversation, newest first, with its running or waiting op. */
export function TeamResultCards(props: { readonly serverKey: ServerKey; readonly teamID: string }) {
  const data = useData()
  const runtime = () => data.get(props.serverKey)
  const open = createMemo(() =>
    teamResults()
      .filter((item) => item.serverKey === props.serverKey && item.teamID === props.teamID && !item.closed)
      .map((item) => item.opID),
  )
  // Op ids, so a card stays mounted (and keeps its op) while the list around it changes. The running op is the
  // registry's, and any op this window heard progress of that has not ended yet, newest first: one started elsewhere
  // (the area menu's 반영하기, an owner's `team_integrate`) does not change the team record, so `team.get` does not
  // name it until it waits or ends.
  const shown = createMemo(() => {
    const team = runtime()?.team
    const heard = Object.entries(team?.state.ops ?? {})
      .filter((entry) => entry[1].teamID === props.teamID && !entry[1].done)
      .map((entry) => entry[0])
      .toReversed()
    const live = [team?.team(props.teamID)?.op?.id, ...heard].filter(
      (opID, index, all): opID is string => opID !== undefined && !open().includes(opID) && all.indexOf(opID) === index,
    )
    // Every card shows (2026-11-14: no area limit, so no cap either); a repeated integration hides below.
    return [...live, ...open()]
  })
  // One integration may run in several ops (steps 0-6, then the first `.assets` confirm, 4.10; its upload, 7.5): it
  // gets one card, the one of its newest op (op ids are ULIDs, so they sort by time).
  const [integrations, setIntegrations] = createStore<Record<string, string>>({})
  const duplicate = (opID: string) => {
    const integrationID = integrations[opID]
    return integrationID !== undefined && shown().some((other) => other > opID && integrations[other] === integrationID)
  }
  return (
    <div class="own-team-cards" data-testid="team-cards">
      <RetireSuggestions serverKey={props.serverKey} teamID={props.teamID} />
      <For each={shown()}>
        {(opID) => (
          // Each card waits for its own op, so a new one does not blank the others.
          <Suspense>
            <TeamResultCard
              serverKey={props.serverKey}
              teamID={props.teamID}
              opID={opID}
              closable={open().includes(opID)}
              hidden={duplicate(opID)}
              onIntegration={(integrationID) => setIntegrations(opID, integrationID)}
            />
          </Suspense>
        )}
      </For>
    </div>
  )
}

export function TeamResultCard(props: {
  readonly serverKey: ServerKey
  readonly teamID: string
  readonly opID: string
  /** A recorded result can be closed; a live op cannot until it ends. */
  readonly closable: boolean
  /** A newer op of the same integration has the card (TeamResultCards). */
  readonly hidden?: boolean
  /** The integration this op works on, once its op is read. */
  readonly onIntegration?: (integrationID: OwnTeam.IntegrationID) => void
}) {
  const data = useData()
  const router = useRouter()
  const i18n = useI18n()
  const text = useTeamText()
  const id = `own-team-card-${props.opID}`
  const runtime = () => data.get(props.serverKey)
  const [op, { refetch }] = createResource(
    () => props.opID,
    (opID) =>
      runtime()
        ?.team.rpc.call("op.get", { opID })
        .then(
          (output) => output.op,
          () => undefined,
        ),
  )
  const stop = runtime()?.team.on("op.done", (event) => {
    if (event.data.opID === props.opID) void refetch()
  })
  // RH-20: a step that ended moves the card's wait to the next one.
  const moved = runtime()?.team.on("op.progress", (event) => {
    if (event.data.opID === props.opID && event.data.state !== "pending") void refetch()
  })
  onCleanup(() => {
    stop?.()
    moved?.()
  })
  const entry = () => runtime()?.team.team(props.teamID)
  // The bindings of the team main and the owners: the account each runs on (SL-8, `CardNames.accountOf`). Keyed by
  // the ids, so a registry update that keeps them reads nothing again.
  const holders = createMemo(() => {
    const team = entry()
    if (!team) return ""
    const owners = team.order.flatMap((areaID) => team.areas[areaID]?.owner.sessionID ?? [])
    return [team.team.main.sessionID, ...owners].join(" ")
  })
  createEffect(
    on([runtime, holders], ([current, ids]) => {
      if (current && ids) onCleanup(current.own.watchVisible(ids.split(" ")))
    }),
  )
  const confirms = () => entry()?.pending.filter((item) => item.opID === props.opID) ?? []
  const [details, setDetails] = createSignal(false)
  const [homes, setHomes] = createSignal<readonly string[]>()
  const [working, setWorking] = createSignal(false)
  const [dialog, setDialog] = createSignal<readonly OwnTeam.Confirm[]>()

  const names = createMemo((): CardNames => {
    const current = runtime()
    const team = entry()
    const locale = i18n.locale()
    const groups = data.local().own.state.presetGroups
    const preset = (presetID: string) => {
      const found = presetByID(groups, presetID)
      return found ? presetName(found, presetsText(locale, "own.preset.builtin")) : presetID
    }
    const bytes = (value: number) => formatBytes(locale, value)
    const account = (accountID: string) => current?.own.state.accounts[accountID]?.label ?? accountID
    const accountOfModel = (ref: { readonly providerID: string }, sessionID?: string | null) =>
      current ? accountOf(current, ref.providerID, sessionID ?? undefined)?.label : undefined
    const starFor = (model: { readonly providerID: string }) => {
      const group = current ? mainGroup(model, (providerID) => accountOf(current, providerID)) : undefined
      return group ? starOf(group, groups[group]) : undefined
    }
    const ref = current && team ? mainModel(current, team.team.main.sessionID) : undefined
    if (!current || !team || !ref) return { preset, account, accountOf: accountOfModel, starOf: starFor, bytes }
    const star = starFor(ref)
    const mainAccount = accountOfModel(ref, team.team.main.sessionID)
    const main: RunningOn = {
      model: modelName(current, ref, team.team.home.directory),
      ...(ref.variant ? { effort: variantName(i18n, ref.variant) } : {}),
      ...(mainAccount ? { account: mainAccount } : {}),
    }
    const worst = worstCase(
      text,
      team.order.flatMap((areaID) => {
        const area = team.areas[areaID]
        return area && area.state !== "retired" ? [{ presetID: area.preset }] : []
      }),
      (presetID) => presetByID(groups, presetID),
      data.local().own.state.presetSettings.ultraCaps,
      {
        ...(main.account ? { shared: main.account } : {}),
        metered: (accountID) => {
          const billing = current.own.state.accounts[accountID]?.billing
          return billing === "metered" || billing === "prepaid"
        },
      },
    )
    return {
      main,
      ...(star ? { star: { id: star, name: preset(star) } } : {}),
      starOf: starFor,
      preset,
      account,
      accountOf: accountOfModel,
      bytes,
      ...(worst?.heavy ? { worst: worst.line } : {}),
    }
  })

  const can = (action: CardAction["kind"]) => {
    const team = runtime()?.team
    if (!team) return false
    if (action === "home") return team.has("enable") && team.rpc.allowed("team.home")
    if (action === "settings") return team.has("settings")
    if (action === "adopt") return team.has("adopt") && team.rpc.allowed("area.adopt")
    if (action === "unadopt") return team.has("adopt") && team.rpc.allowed("area.unadopt")
    if (action === "retire") return team.has("reorg.retire") && team.rpc.allowed("reorg.apply")
    if (action === "recreate") return team.has("reorg.new") && team.rpc.allowed("reorg.apply")
    if (action === "addPeer") return team.has("peers") && team.rpc.allowed("area.peer.add")
    if (action === "redo") return team.rpc.allowed("reorg.apply")
    return runtime()?.rpc.can("prompt") === true
  }

  /** The join's undo answered `conflict` (A moved on, 8.2): the card offers 'B 다시 만들기' instead of 되돌리기. */
  const [blocked, setBlocked] = createSignal(false)
  /** Skipped items started again from this card (`[다시 하기]`). */
  const [redone, setRedone] = createSignal<ReadonlySet<string>>(new Set())
  const card = createMemo(() => {
    const current = op.latest
    const team = entry()
    return current
      ? resultCard(text, {
          op: current,
          ...(team ? { team } : {}),
          pending: confirms().length,
          names: names(),
          can,
          undoConflict: blocked(),
          redone: redone(),
        })
      : undefined
  })
  const undoable = () => {
    const team = runtime()?.team
    const current = op.latest
    return (
      current?.undo?.available === true &&
      current.state !== "running" &&
      !blocked() &&
      team?.has("enable") === true &&
      team.rpc.allowed("op.undo")
    )
  }
  const local = () => runtime()?.team.rpc.allowed("op.confirm") === true
  /** The PC the service runs on, as the gateway names it to a device (06 §9.8). */
  const pc = () => runtime()?.entry()?.pc
  const removals = () => confirms().filter(isDestructive)
  /** System changes (9.7): the dialog says what changes and how to undo it. */
  const changes = () => confirms().filter((confirm) => !isDestructive(confirm) && isSystem(confirm))
  const inPlace = () => confirms().filter((confirm) => !isDestructive(confirm) && !isSystem(confirm))

  /** Runs a team call with the card's buttons held; a failure says why. */
  async function act(call: (current: ServerRuntime) => Promise<unknown>) {
    const current = runtime()
    if (!current || working()) return
    setWorking(true)
    await call(current).catch((error: unknown) => failed(i18n.locale(), error))
    setWorking(false)
  }

  function run(action: CardAction, anchor: HTMLElement) {
    const teamID = entry()?.team.id
    if (action.kind === "home") return setHomes((open) => (open ? undefined : action.directories))
    if (action.kind === "settings")
      return openTeamSettings({ serverKey: props.serverKey, ...(teamID ? { teamID } : {}) })
    if (!teamID) return
    if (action.kind === "adopt")
      return void act(async (current) => {
        await current.team.rpc.call("area.adopt", { teamID, directory: action.directory })
        showToast({ message: text("own.team.adopt.running", { folder: shortName(action.directory) }) })
      })
    if (action.kind === "unadopt")
      return void act((current) => current.team.rpc.call("area.unadopt", { teamID, areaID: action.areaID }))
    if (action.kind === "retire") {
      // 8.2 끝내기: its panel says what stays before the user's own `reorg.apply` (the suggestion names a slug).
      const area = areaOf(entry(), action.area)
      if (area) openRetirePanel({ serverKey: props.serverKey, teamID, areaID: area.id, anchor })
      return
    }
    if (action.kind === "addPeer")
      return openAreaMenu({ serverKey: props.serverKey, teamID, areaID: action.areaID, anchor, panel: "addPeer" })
    // 8.2 'B 다시 만들기': its panel says what it makes before the user's own `reorg.apply`.
    if (action.kind === "recreate")
      return openRecreatePanel({ serverKey: props.serverKey, teamID, areaID: action.areaID, anchor })
    // 8.1 [다시 하기]: the skipped action as the user's own; it waits for its area's safe point (TI-9).
    if (action.kind === "redo")
      return void act(async (current) => {
        await withLfs(
          () => current.team.rpc.call("reorg.apply", { teamID, proposal: action.proposal }),
          lfsUpload(data, props.serverKey),
        )
        setRedone((items) => new Set([...items, action.item]))
        const area = entry()?.areas[action.areaID]?.name ?? action.areaID.replace(/^ar_/, "")
        showToast({ message: text("own.team.card.redo.started", { area }) })
      })
    return void act((current) => Promise.all(action.sessionIDs.map((sessionID) => clearQueued(current, sessionID))))
  }

  /** 되돌리기; a join that can no longer be undone (`conflict`, 8.2) turns into its 'B 다시 만들기' line. */
  function undo() {
    void act((current) =>
      current.team.rpc.call("op.undo", { opID: props.opID }).catch((error: unknown) => {
        const joined = op.latest ? joinedAreas(op.latest, "merge-into").length > 0 : false
        if (!(error instanceof OwnRpcError && error.type === "conflict" && joined)) throw error
        setBlocked(true)
      }),
    )
  }

  function talkToMain() {
    const main = entry()?.team.main.sessionID
    if (!main) return
    router.navigate({ name: "session", serverKey: props.serverKey, sessionID: main })
    requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
  }

  function answer(confirm: OwnTeam.Confirm, choice: "do" | "skip") {
    void act((current) =>
      current.team.rpc.call("op.confirm", {
        opID: confirm.opID,
        stepID: confirm.stepID,
        choice,
        nonce: confirm.nonce,
      }),
    )
  }

  createEffect(() => {
    const integrationID = integrationOfOp(op.latest)
    if (integrationID) props.onIntegration?.(integrationID)
  })

  return (
    <Switch>
      <Match when={props.hidden}>{null}</Match>
      <Match when={integrationOfOp(op.latest)} keyed>
        {(integrationID) => (
          <IntegrationCard
            serverKey={props.serverKey}
            integrationID={integrationID}
            {...(op.latest ? { opID: op.latest.id } : {})}
            {...(props.closable ? { onClose: () => closeTeamResult(props.serverKey, props.opID) } : {})}
          />
        )}
      </Match>
      <Match when={card()}>
        {(shown) => (
          <section
            class="own-team-card"
            aria-labelledby={`${id}-title`}
            data-testid="team-card"
            data-kind={op.latest?.kind}
            data-state={op.latest?.state}
          >
            <h3 id={`${id}-title`} class="own-team-card-title">
              {shown().title}
            </h3>
            <Show when={shown().state}>
              {(state) => (
                <p class="own-team-card-state" data-testid="team-card-state">
                  {state()}
                </p>
              )}
            </Show>
            <Show
              when={
                op.latest && (op.latest.state === "running" || op.latest.state === "waiting") ? op.latest : undefined
              }
            >
              {(live) => <OpWait serverKey={props.serverKey} op={live()} onChanged={() => void refetch()} />}
            </Show>
            <ul class="own-team-card-lines">
              <For each={shown().lines}>
                {(line) => (
                  <li class="own-team-card-line" data-tone={line.tone} data-testid="team-card-line">
                    <Show when={line.text}>
                      <span>{line.text}</span>
                    </Show>
                    <Show when={line.action}>
                      {(action) => (
                        <button
                          type="button"
                          class="own-team-link"
                          data-testid={`team-card-${action().run.kind}`}
                          disabled={working()}
                          aria-expanded={action().run.kind === "home" ? homes() !== undefined : undefined}
                          onClick={(event) => run(action().run, event.currentTarget)}
                        >
                          {action().label}
                        </button>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={homes()}>
              {(directories) => (
                <ul class="own-team-choices" data-testid="team-card-homes">
                  <For each={directories()}>
                    {(directory) => (
                      <li>
                        <button
                          type="button"
                          class="own-team-choice"
                          disabled={working()}
                          onClick={() => {
                            const teamID = entry()?.team.id
                            setHomes(undefined)
                            if (teamID) void act((current) => current.team.rpc.call("team.home", { teamID, directory }))
                          }}
                        >
                          {directory}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              )}
            </Show>
            <Show when={confirms().length > 0}>
              <ul class="own-team-confirms" data-testid="team-card-confirms">
                <For each={inPlace()}>
                  {(confirm) => (
                    <li class="own-team-confirm">
                      <span class="own-team-confirm-text">{confirm.text}</span>
                      <Show
                        when={local()}
                        fallback={<span class="own-team-muted">{viewOnlyText(text, "confirm", pc())}</span>}
                      >
                        <span class="own-team-confirm-buttons">
                          <button
                            type="button"
                            class="own-team-btn"
                            data-primary
                            disabled={working()}
                            onClick={() => answer(confirm, "do")}
                          >
                            {text(isFetch(confirm) ? "own.team.confirm.fetch" : "own.team.confirm.do")}
                          </button>
                          <button
                            type="button"
                            class="own-team-btn"
                            disabled={working()}
                            onClick={() => answer(confirm, "skip")}
                          >
                            {text(isFetch(confirm) ? "own.team.confirm.later" : "own.team.confirm.keep")}
                          </button>
                        </span>
                      </Show>
                    </li>
                  )}
                </For>
                <For each={changes()}>
                  {(confirm) => (
                    <li class="own-team-confirm">
                      <span class="own-team-confirm-text">{confirm.text}</span>
                      <span class="own-team-confirm-buttons">
                        <button
                          type="button"
                          class="own-team-btn"
                          data-primary
                          aria-haspopup="dialog"
                          data-testid="team-card-system"
                          onClick={() => setDialog([confirm])}
                        >
                          {text("own.team.confirm.open")}
                        </button>
                      </span>
                    </li>
                  )}
                </For>
                <Show when={removals().length > 0}>
                  <li class="own-team-confirm">
                    <span class="own-team-confirm-text">
                      {removals().length > 1
                        ? text("own.team.confirm.bulk", {
                            n: removals().length,
                            size: formatBytes(
                              i18n.locale(),
                              removals().reduce((sum, confirm) => sum + confirmBytes(confirm), 0),
                            ),
                          })
                        : removals()[0]?.text}
                    </span>
                    <span class="own-team-confirm-buttons">
                      <button
                        type="button"
                        class="own-team-btn"
                        data-danger
                        aria-haspopup="dialog"
                        data-testid="team-card-remove"
                        onClick={() => setDialog(removals())}
                      >
                        {text("own.team.confirm.remove")}
                      </button>
                    </span>
                  </li>
                </Show>
              </ul>
            </Show>
            <Show when={details()}>
              <ul class="own-team-details" data-testid="team-card-details">
                <For each={shown().details}>{(line) => <li>{line}</li>}</For>
              </ul>
            </Show>
            <div class="own-team-card-actions">
              <Show when={entry()}>
                <button type="button" class="own-team-btn" data-primary onClick={talkToMain}>
                  {text("own.team.action.talkToMain")}
                </button>
              </Show>
              <button
                type="button"
                class="own-team-btn"
                aria-expanded={details()}
                data-testid="team-card-details-toggle"
                onClick={() => setDetails((open) => !open)}
              >
                {text("own.team.action.details")}
              </button>
              <Show when={undoable()}>
                <button
                  type="button"
                  class="own-team-btn"
                  data-testid="team-card-undo"
                  disabled={working()}
                  onClick={undo}
                >
                  {text("own.team.action.undo")}
                </button>
              </Show>
              <Show when={props.closable}>
                <button
                  type="button"
                  class="own-team-btn"
                  data-testid="team-card-close"
                  onClick={() => closeTeamResult(props.serverKey, props.opID)}
                >
                  {text("own.team.action.close")}
                </button>
              </Show>
            </div>
            <Show when={dialog()}>
              {(list) => (
                <TeamConfirmDialog
                  serverKey={props.serverKey}
                  confirms={list()}
                  pc={pc()}
                  onClose={() => setDialog(undefined)}
                />
              )}
            </Show>
          </section>
        )}
      </Match>
    </Switch>
  )
}

/** The integration an integrate op works on (반영하기 or its upload, 06 §7): its steps carry `integrationID`. */
export function integrationOfOp(op: Pick<OwnTeam.Op, "kind" | "steps"> | undefined) {
  if (op?.kind !== "integrate") return undefined
  return op.steps.map((step) => step.args.integrationID).find(isIntegrationID)
}

function isIntegrationID(value: unknown): value is OwnTeam.IntegrationID {
  // own.team writes `ig_<ULID>` (OwnTeam.IntegrationID); the client keeps the schema graph out of its chunks.
  return typeof value === "string" && /^ig_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
}

/** The team main's model now: its binding, else what the session data knows. */
function mainModel(runtime: ServerRuntime, sessionID: string) {
  return (
    runtime.own.state.binding[sessionID]?.model ??
    runtime.data.session.get(sessionID)?.model ??
    runtime.sessions.state.sessions[sessionID]?.model
  )
}

/** `[담당 대기열의 메인 요청 n개 지우기]` (3.8): cancels the main requests still in an owner's queue, nothing else. */
async function clearQueued(runtime: ServerRuntime, sessionID: string) {
  const items = await runtime.client().session.inbox.list({ sessionID })
  const requests = items.filter(
    (item) => item.type === "user" && item.payload.metadata?.[TEAM_META.dispatch] !== undefined,
  )
  await Promise.all(requests.map((item) => runtime.client().session.inbox.cancel({ sessionID, inboxID: item.id })))
}

/** The last segment of a path: folders show their short name (06 §9.1). */
function shortName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  )
}
