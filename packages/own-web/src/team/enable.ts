// Team mode entry points (06 §9.2, §5.3). `팀 모드 켜기…` in the session menu, the palette, the project menu, the
// project row's [팀] and the worktree-group header opens a small dialog (team/enable-dialog.tsx, 2026-10-16: an
// optional goal) that calls own.team `enable{directory, sessionID, hint}`, shows progress toasts
// (`프로젝트를 살펴보는 중…` → `영역 2개를 준비하는 중…`) and then opens the team main, where the result card waits
// (team/summary.tsx). With a goal, the team main's composer then holds a discussion draft that is never sent. On an SSH host whose own.team answers `lfs_missing` (4.13: the remote team cannot reach this
// PC's release files), the bundled large-file tool goes up once through this PC's own.remote (`hosts.tools.ensure`)
// and the call runs once more (`withLfs`: enable, and the reorganizations that make an area, `reorg.apply`); a failed
// upload or a second refusal is the answer, never a loop. The Main 멈춤 switch of
// an owner conversation and 모두 멈추기 / 다시 시작 go through here too, and the peer items (동료, 2026-10-09) of a
// conversation's menus: `동료로 등록…`, `역할 바꾸기…` and `동료에서 빼기` open their panels in the area menu. So does
// `이 대화를 담당으로` (담당 대화 바꾸기, 2026-11-12): its one confirm is an area menu panel, and `runSeat` follows the
// seat move from `area.seat` to the toast that offers the way back.
// This module is in the first chunk and stays small. The team strings and view models load with the team chunk
// (`loadTeamText`), and an entry appears once they are there. Menus and the palette start that load when they open.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createSignal } from "solid-js"
import { OwnRpcError, useData, type ServerKey, type ServerRuntime } from "@/data"
import { useI18n, type I18nParams, type Locale } from "@/i18n"
import { useRouter } from "@/routing/router"
import { dismissToast, showToast, type ToastInput } from "@/switcher/toast"
import { samePath, trimSep } from "@/projects/path"
import { projectRef } from "@/worktree/api"
import { isInside } from "@/worktree/model"
import { openGitInit } from "@/discover/git-init"
import { requestComposerRestore } from "@/attachments/intents"
import { openAreaMenu, openEnableDialog } from "./intents"
import { LfsUploadFailed, lfsUpload, withLfs } from "./lfs"
import type { TeamText } from "./model"
import type { OpProgress, TeamStore } from "./store"
import type { TeamKey, teamText } from "./strings"

type TeamCatalog = typeof teamText

const [catalog, setCatalog] = createSignal<TeamCatalog>()
let loading: Promise<TeamCatalog> | undefined

/** Loads the team strings (team chunk) once. A failed load is tried again by the next call. */
export function loadTeamText() {
  loading ??= import("./strings").then(
    (module) => {
      setCatalog(() => module.teamText)
      return module.teamText
    },
    (error: unknown) => {
      loading = undefined
      throw error
    },
  )
  return loading
}

/** A team string for a first-chunk entry: `undefined` until the strings are loaded (reactive; starts the load). */
export function teamLabel(locale: Locale, key: TeamKey, params?: I18nParams) {
  const loaded = catalog()
  if (!loaded) void loadTeamText().catch(report)
  return loaded?.text(locale, key, params)
}

/** For a menu or the palette that opens: reads own.team's health once and loads the strings. */
export function prepareTeamEntries(runtime: ServerRuntime | undefined) {
  runtime?.team.ensure()
  void loadTeamText().catch(report)
}

/** Where an entry is used: a conversation, or a project row and its folder. */
export interface TeamPlace {
  readonly directory: string | undefined
  readonly projectID: string | undefined
  readonly sessionID?: string
}

/**
 * Whether `팀 모드 켜기` applies (06 §9.2). This build of own.team can enable and this connection may (`admin`, never
 * a gateway device). The folder is in a Git project. The conversation is a root one outside any team. No team is on
 * for the folder's repository: its main folder, an area folder, or a checkout the team leaves outside (3.2). Another
 * clone of the same remote has a team of its own.
 */
export function canEnableTeam(runtime: ServerRuntime, place: TeamPlace) {
  const team = runtime.team
  if (!place.directory || !place.projectID || !team.has("enable") || !team.rpc.allowed("enable")) return false
  if (projectRef(runtime, place.projectID)?.vcs !== "git") return false
  const sessionID = place.sessionID
  if (sessionID !== undefined) {
    const child = runtime.data.session.get(sessionID)?.parentID ?? runtime.sessions.state.sessions[sessionID]?.parentID
    if (child || team.placeOf(sessionID)) return false
  }
  const directory = place.directory
  const outside = team
    .teamsOfProject(place.projectID)
    .some((entry) => entry.team.external.some((item) => samePath(item.directory, directory)))
  return !outside && !team.teamOfDirectory(directory)
}

/**
 * A peer item of a conversation's menus (동료): `동료로 등록…`, `역할 바꾸기…`, `동료에서 빼기`; and `이 대화를 담당으로`
 * (`seat`, 담당 대화 바꾸기), which the same conversations and an earlier owner get.
 */
export type PeerItem = "register" | "edit" | "remove" | "seat"

/** The words of each peer item (team/strings.ts). */
export const PEER_ITEM_KEYS = {
  register: "own.team.peer.register",
  edit: "own.team.peer.edit",
  remove: "own.team.peer.remove",
  seat: "own.team.seat.make",
} as const satisfies Record<PeerItem, TeamKey>

/** What a conversation's menus offer about peers: the area, the conversation, its peer key once it is one. */
export interface PeerEntry {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  readonly sessionID: string
  /** The peer's key (`Peer.key`) when the conversation is a peer. */
  readonly key?: string
  readonly items: readonly PeerItem[]
}

/**
 * A peer's own items (역할 바꾸기…, 동료에서 빼기), in the area menu and in the peer conversation's menus: each where
 * this build of own.team has `peers` and this connection may call its method (`admin`, never a gateway device).
 */
export function peerActions(input: {
  readonly has: (feature: OwnTeam.Feature) => boolean
  readonly allowed: (method: OwnTeam.MethodName) => boolean
}): Array<"edit" | "remove"> {
  if (!input.has("peers")) return []
  return (["edit", "remove"] as const).filter((action) =>
    input.allowed(action === "edit" ? "area.peer.edit" : "area.peer.remove"),
  )
}

/**
 * The peer items of a conversation (06 §9.4, §9.5, 동료). A peer gets {@link peerActions}. `동료로 등록…` is for a root
 * conversation in an active area's folder (its subfolders too, the deepest area) that the registry gives no role: not
 * the area's owner, not the team main and not a peer already (the sidebar's `이 영역의 다른 대화`); where this build of
 * own.team has `peers` and this connection may call `area.peer.add`. An earlier owner the seat was moved off
 * (담당 대화 바꾸기, `why: "seat"`) is offered it too (2026-11-13: a peer made the owner and moved back may be a peer
 * again); one that 새 대화로 이어가기 ended is not (own.team refuses it).
 *
 * `이 대화를 담당으로` (`seat`) is for a root conversation of that deepest active area that is not its owner: one
 * without a role, a peer of the area and an earlier owner of it; never a sub-conversation, the owner, the team main or
 * an earlier one, or a conversation whose folder is not the area's (own.team refuses each). It needs `seat` in this
 * build of own.team and a connection that may call `area.seat`. `undefined`: nothing to offer.
 */
export function peerItems(
  runtime: Pick<ServerRuntime, "team" | "data" | "sessions">,
  place: { readonly sessionID: string; readonly directory: string | undefined },
): PeerEntry | undefined {
  const team = runtime.team
  const has = (feature: OwnTeam.Feature) => team.has(feature)
  const allowed = (method: OwnTeam.MethodName) => team.rpc.allowed(method)
  const sessionID = place.sessionID
  const directory = place.directory
  const area = directory
    ? Object.values(team.state.teams)
        .flatMap((entry) =>
          entry.order.flatMap((id) => {
            const candidate = entry.areas[id]
            return candidate?.state === "active" && isInside(candidate.directory, directory) ? [candidate] : []
          }),
        )
        .toSorted((a, b) => trimSep(b.directory).length - trimSep(a.directory).length)
        .at(0)
    : undefined
  const seat = has("seat") && allowed("area.seat")
  const found = team.peerOf(sessionID)
  if (found) {
    const ids = { teamID: found.area.teamID, areaID: found.area.id }
    const items: PeerItem[] = [
      ...peerActions({ has, allowed }),
      ...(seat && area?.teamID === ids.teamID && area.id === ids.areaID ? ["seat" as const] : []),
    ]
    return items.length ? { ...ids, sessionID, key: found.peer.key, items } : undefined
  }
  const child = runtime.data.session.get(sessionID)?.parentID ?? runtime.sessions.state.sessions[sessionID]?.parentID
  if (!area || child) return undefined
  const placed = team.placeOf(sessionID)
  // An earlier owner of the area may take its seat again. As a peer own.team takes only one the seat was moved off.
  const earlier =
    placed?.role === "owner" && placed.previous && placed.teamID === area.teamID && placed.areaID === area.id
  if (placed && !earlier) return undefined
  const items: PeerItem[] = [
    ...((!placed || placed.why === "seat") && has("peers") && allowed("area.peer.add") ? ["register" as const] : []),
    ...(seat ? ["seat" as const] : []),
  ]
  return items.length ? { teamID: area.teamID, areaID: area.id, sessionID, items } : undefined
}

/**
 * Why `이 대화를 담당으로` cannot run now although the conversation may take the seat: another task of the team is
 * running or waiting (own.team would answer `busy`). The item stays in its menu, dimmed, with these words. The task
 * is the registry's, or one this window heard progress of that has not ended: a task that waits for an area's work
 * does not change the team record, so `team.get` is not read again while it waits (as the cards, summary.tsx).
 */
export function seatBlock(team: Pick<TeamStore, "team" | "state">, teamID: OwnTeam.TeamID): TeamKey | undefined {
  if (team.team(teamID)?.op) return "own.team.seat.busy"
  return Object.values(team.state.ops).some((op) => op.teamID === teamID && !op.done) ? "own.team.seat.busy" : undefined
}

/** A peer item from a conversation's menu: the area menu at that item's panel. */
export function openPeerItem(
  serverKey: ServerKey,
  entry: PeerEntry,
  item: PeerItem,
  anchor: HTMLElement | null = null,
) {
  const ids = { serverKey, teamID: entry.teamID, areaID: entry.areaID, anchor }
  if (item === "register") return openAreaMenu({ ...ids, panel: "registerPeer", sessionID: entry.sessionID })
  if (item === "seat") return openAreaMenu({ ...ids, panel: "seat", sessionID: entry.sessionID })
  openAreaMenu({ ...ids, panel: item === "edit" ? "editPeer" : "removePeer", peer: entry.key })
}

export interface EnableRequest {
  readonly serverKey: ServerKey
  /** The folder of the conversation or project row the entry was used on. */
  readonly directory: string
  /** The conversation being viewed (06 §3.2): its folder becomes the main folder, its model the main's. */
  readonly sessionID?: string
  /** The dialog's goal (at most 2,000 characters): the judge's hint (06 §3.4). */
  readonly hint?: string
  /** The dialog's 영역 폴더 (06 §4.12, 2026-10-27); absent = the service's default (프로젝트 안). */
  readonly areaRoot?: OwnTeam.AreaRoot
  /** The team main's composer text after enabling (06 §9.3); never sent. */
  readonly draft?: string
}

export interface EnableDeps {
  readonly team: Pick<TeamStore, "rpc" | "state" | "on" | "load">
  readonly text: TeamText
  /** An own.team failure in plain words (team/model.ts `errorText`). */
  readonly describe: (error: unknown) => string
  readonly toast: { readonly show: (input: ToastInput) => number; readonly dismiss: (id: number) => void }
  /** Opens the team main conversation. */
  readonly open: (sessionID: string) => void
  /** Puts `text` into a conversation's composer (`requestComposerRestore{mode: "fill"}`); never sends it. */
  readonly prefill: (sessionID: string, text: string) => void
  /**
   * Uploads the bundled large-file tool to the SSH host the request goes to, through this PC's own.remote
   * (`hosts.tools.ensure`, 06 §4.13). Absent where no host can get it: this PC's own service, a connection without
   * own.remote's `manage` scope.
   */
  readonly ensureLfs?: () => Promise<unknown>
  /**
   * Opens Git 저장소로 만들기 for a repository without a first save point (06 §3.0, `not_git{unborn}`). Absent where
   * this connection cannot make one (no `git-init` in this build of own.team, no `local` scope).
   */
  readonly firstSave?: (directory: string) => void
}

type Started = { readonly ok: true; readonly opID: OwnTeam.OpID } | { readonly ok: false; readonly error: unknown }

/** How long a progress toast stays when no later step replaces it (the judge and the setup may take minutes). */
const PROGRESS_MS = 10 * 60_000

/** The step after which each progress toast shows: own-team's enable steps (ops/enable.ts). */
const NEXT: Readonly<Record<string, TeamKey>> = {
  observe: "own.team.enable.progress.main",
  main: "own.team.enable.progress.judge",
}

/** Folders whose `enable` call is on its way: a second click does nothing until the service answered. */
const starting = new Set<string>()

/**
 * `팀 모드 켜기` (06 §9.2, §3.1). Calls `enable` with no dialog and shows a progress toast for each phase: the
 * inventory, the team main, the judge, and `영역 n개를 준비하는 중…` when the judge planned new areas. When the op ends,
 * it opens the team main, where the result card waits. A refused call or a failed op says why. Resolves with the op's
 * end state, or `undefined` when it did not start.
 */
export async function runEnable(deps: EnableDeps, request: EnableRequest): Promise<OwnTeam.OpState | undefined> {
  const key = `${request.serverKey}\n${request.directory}`
  if (starting.has(key)) return undefined
  starting.add(key)
  const progress: { id?: number; ended: boolean } = { ended: false }
  const say = (message: string) => {
    if (progress.ended) return
    if (progress.id !== undefined) deps.toast.dismiss(progress.id)
    progress.id = deps.toast.show({ message, duration: PROGRESS_MS })
  }
  const end = () => {
    progress.ended = true
    if (progress.id !== undefined) deps.toast.dismiss(progress.id)
  }
  say(deps.text("own.team.enable.progress.inventory"))
  const ensure = deps.ensureLfs
  // 06 §4.13: one upload with its progress toast, then one more try; whatever the second answer is, it stands.
  const started = await withLfs(
    () =>
      deps.team.rpc.call("enable", {
        directory: request.directory,
        ...(request.sessionID === undefined ? {} : { sessionID: request.sessionID }),
        ...(request.hint ? { hint: request.hint } : {}),
        ...(request.areaRoot === undefined ? {} : { areaRoot: request.areaRoot }),
      }),
    ensure &&
      (async () => {
        say(deps.text("own.team.enable.progress.lfs"))
        await ensure()
        say(deps.text("own.team.enable.progress.inventory"))
      }),
  ).then(
    (output): Started => ({ ok: true, opID: output.opID }),
    (error: unknown): Started => ({ ok: false, error }),
  )
  starting.delete(key)
  if (!started.ok && started.error instanceof LfsUploadFailed) {
    end()
    deps.toast.show({
      tone: "danger",
      message: deps.text("own.team.enable.lfsFailed", { reason: deps.describe(started.error.cause) }),
    })
    return undefined
  }
  if (!started.ok) {
    end()
    const notGit = started.error instanceof OwnRpcError && started.error.type === "not_git"
    const firstSave = deps.firstSave
    if (notGit && unborn(started.error) && firstSave) {
      deps.toast.show({
        tone: "danger",
        message: deps.text("own.team.enable.unborn"),
        action: { label: deps.text("own.team.enable.firstSave"), run: () => firstSave(request.directory) },
      })
      return undefined
    }
    deps.toast.show({
      tone: "danger",
      message: notGit
        ? deps.text("own.team.enable.notGit")
        : deps.text("own.team.enable.failed", { reason: deps.describe(started.error) }),
    })
    return undefined
  }

  const opID = started.opID
  const advance = (stepID: string, state: OwnTeam.StepState) => {
    if (state !== "done") return
    const next = NEXT[stepID]
    if (next) return say(deps.text(next))
    if (stepID !== "judge") return
    void deps.team.rpc.call("op.get", { opID }).then(
      (output) => {
        const areas = plannedAreas(output.op)
        if (areas > 0) say(deps.text("own.team.enable.progress.areas", { n: areas }))
      },
      () => undefined,
    )
  }
  // Steps that ended before the answer came are in the store already; later ones arrive as events.
  Object.entries(deps.team.state.ops[opID]?.steps ?? {}).forEach(([stepID, step]) => advance(stepID, step.state))
  const stop = deps.team.on("op.progress", (event) => {
    if (event.data.opID === opID) advance(event.data.stepID, event.data.state)
  })
  const done = await opDone(deps.team, opID)
  stop()
  end()
  if (done.state === "failed") {
    const reason = await failedNote(deps.team, opID)
    deps.toast.show({
      tone: "danger",
      message: deps.text("own.team.enable.failed", { reason: reason ?? deps.text("own.team.error.internalError") }),
    })
  }
  const entry = await deps.team.load(request.directory).catch(() => undefined)
  if (entry) {
    // The team main opens first, so its composer holds the draft's key when the text arrives (split view, 03 §4.1.1).
    deps.open(entry.team.main.sessionID)
    if (request.draft) deps.prefill(entry.team.main.sessionID, request.draft)
  }
  // A user who walked away during the minutes enable takes learns the draft waits for them (review).
  if (entry && request.draft && done.state !== "failed")
    deps.toast.show({ message: deps.text("own.team.enable.doneDraft") })
  if (!entry && done.state !== "failed") deps.toast.show({ message: deps.text("own.team.enable.done") })
  return done.state
}

/** Areas an op is about to prepare: the distinct `areaID` its steps carry. */
export function plannedAreas(op: Pick<OwnTeam.Op, "steps">) {
  return new Set(op.steps.flatMap((step) => (typeof step.args.areaID === "string" ? [step.args.areaID] : []))).size
}

/** Resolves with what `op.done` said of an op, at once when the store has it already. */
export function opDone(team: Pick<TeamStore, "state" | "on">, opID: string): Promise<NonNullable<OpProgress["done"]>> {
  const known = team.state.ops[opID]?.done
  if (known) return Promise.resolve(known)
  return new Promise((resolve) => {
    const stop = team.on("op.done", (event) => {
      if (event.data.opID !== opID) return
      stop()
      resolve({
        state: event.data.state,
        summary: event.data.summary,
        undoable: event.data.undoable,
        pending: event.data.pending,
      })
    })
  })
}

/** Why an op failed: the note of its failed step, when the service still has the op. */
export function failedNote(team: Pick<TeamStore, "rpc">, opID: string) {
  return team.rpc.call("op.get", { opID }).then(
    (output) => output.op.steps.find((step) => step.state === "failed")?.note,
    () => undefined,
  )
}

/** A seat move (담당 대화 바꾸기): the area and the conversation that takes its seat. */
export interface SeatRequest {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  readonly sessionID: string
}

export interface SeatDeps {
  readonly team: Pick<TeamStore, "rpc" | "state" | "on" | "load">
  readonly text: TeamText
  /** A refused seat move in plain words (team/model.ts `seatErrorText`). */
  readonly describe: (error: unknown) => string
  readonly toast: EnableDeps["toast"]
  /** A conversation's title as the sidebar shows it. */
  readonly name: (sessionID: string) => string
}

/**
 * `바꾸기` of the seat confirm (담당 대화 바꾸기, 2026-11-12): calls `area.seat` and follows its op. Until the op ends
 * a toast says the seat moves when the area's current work ends (the op's card says the same while it waits and offers
 * 취소). When the op ends and the area's owner is the chosen conversation, a toast says it and offers the way back,
 * `다시 <old>(으)로`: this again with the conversation that held the seat (its title cut to {@link BACK_NAME}
 * characters: the button sits beside the sentence and a long title left the sentence no width). Main 멈춤 that was on
 * before the move stays on (06 §5.3), so a second toast says the main's requests do not reach the new owner until it
 * is off (whether any waits now or not) and offers `메인 멈춤 끄기` (`area.pause{on:false}`) where this connection may. A refused call or a failed op says why; a cancelled wait changed nothing and says nothing
 * more. Resolves with the op's end state, or `undefined` when it did not start.
 */
/** The most characters of a conversation's title in the way-back button of the seat toast. */
export const BACK_NAME = 12

export async function runSeat(deps: SeatDeps, request: SeatRequest): Promise<OwnTeam.OpState | undefined> {
  const known = deps.team.state.teams[request.teamID]
  const home = known?.team.home.directory
  const from = known?.areas[request.areaID]?.owner.sessionID
  const started = await deps.team.rpc
    .call("area.seat", { teamID: request.teamID, areaID: request.areaID, sessionID: request.sessionID })
    .then(
      (output): Started => ({ ok: true, opID: output.opID }),
      (error: unknown): Started => ({ ok: false, error }),
    )
  if (!started.ok) {
    deps.toast.show({ tone: "danger", message: deps.describe(started.error) })
    return undefined
  }
  const waiting = deps.toast.show({ message: deps.text("own.team.seat.started"), duration: PROGRESS_MS })
  const done = await opDone(deps.team, started.opID)
  deps.toast.dismiss(waiting)
  if (done.state === "failed") {
    const reason = await failedNote(deps.team, started.opID)
    deps.toast.show({
      tone: "danger",
      message: reason ? deps.text("own.team.seat.failedWhy", { reason }) : deps.text("own.team.seat.failed"),
    })
    return done.state
  }
  const entry = home ? await deps.team.load(home).catch(() => undefined) : undefined
  const area = entry?.areas[request.areaID]
  if (!area || area.owner.sessionID !== request.sessionID) return done.state
  const held = [...(from ? deps.name(from) : "")]
  deps.toast.show({
    message: deps.text("own.team.seat.done", { name: deps.name(request.sessionID), area: area.name }),
    ...(from && from !== request.sessionID
      ? {
          action: {
            label: deps.text("own.team.seat.back", {
              name: held.length > BACK_NAME ? `${held.slice(0, BACK_NAME).join("").trimEnd()}…` : held.join(""),
            }),
            run: () => void runSeat(deps, { ...request, sessionID: from }),
          },
        }
      : {}),
  })
  if (area.paused === false) return done.state
  deps.toast.show({
    message: deps.text("own.team.seat.paused", { area: area.name }),
    ...(deps.team.rpc.allowed("area.pause")
      ? {
          action: {
            label: deps.text("own.team.action.pauseOff"),
            run: () =>
              void deps.team.rpc
                .call("area.pause", { teamID: request.teamID, areaID: request.areaID, on: false })
                .catch((error: unknown) => deps.toast.show({ tone: "danger", message: deps.describe(error) })),
          },
        }
      : {}),
  })
  return done.state
}

/**
 * `팀 모드 켜기…` for a component (06 §9.2, 2026-10-16): opens the goal dialog (team/enable-dialog.tsx), which runs
 * {@link useRunEnable}. Every entry point ignores the result.
 */
export function useEnableTeam() {
  return (request: EnableRequest) => openEnableDialog(request)
}

/** {@link runEnable} with this window's toasts, locale and router; the dialog calls it. */
export function useRunEnable() {
  const data = useData()
  const router = useRouter()
  const i18n = useI18n()
  return async (request: EnableRequest) => {
    const runtime = data.get(request.serverKey)
    if (!runtime) return undefined
    const [strings, { errorText }] = await Promise.all([loadTeamText(), import("./model")])
    const text: TeamText = (key, params) => strings.text(i18n.locale(), key, params)
    const upload = lfsUpload(data, request.serverKey)
    return runEnable(
      {
        team: runtime.team,
        text,
        describe: (error) => errorText(text, error),
        toast: { show: showToast, dismiss: dismissToast },
        open: (sessionID) => {
          router.navigate({ name: "session", serverKey: request.serverKey, sessionID })
          requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
        },
        prefill: (sessionID, text) =>
          requestAnimationFrame(() =>
            requestComposerRestore({ serverKey: request.serverKey, sessionID, text, attachments: [], mode: "fill" }),
          ),
        ...(upload ? { ensureLfs: upload } : {}),
        ...(runtime.team.has("git-init") && runtime.team.rpc.allowed("project.gitInit")
          ? {
              // The dialog's `팀 모드 켜기…` afterwards starts from the same conversation as this attempt.
              firstSave: (directory: string) =>
                openGitInit({
                  serverKey: request.serverKey,
                  directory,
                  ...(request.sessionID ? { sessionID: request.sessionID } : {}),
                }),
            }
          : {}),
      },
      request,
    )
  }
}

/** `not_git{unborn}`: a repository without a first save point (06 §3.0). */
function unborn(error: OwnRpcError) {
  return typeof error.data === "object" && error.data !== null && "unborn" in error.data && error.data.unborn === true
}

/** Main 멈춤 of an area (06 §5.3), from the owner conversation's menu: `area.pause{on}`. A failure says why. */
export function pauseArea(
  runtime: ServerRuntime,
  area: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID },
  on: boolean,
  locale: Locale,
) {
  return runtime.team.rpc.call("area.pause", { teamID: area.teamID, areaID: area.areaID, on }).then(
    () => undefined,
    (error: unknown) => failed(locale, error),
  )
}

/**
 * 모든 영역 멈추기 / 다시 시작 (06 §5.3): `team.pause{on}`, then says what it did; after pausing, the toast offers
 * [다시 시작] (UI-D14: no confirm, the undo is one click away).
 */
export function pauseTeam(runtime: ServerRuntime, teamID: OwnTeam.TeamID, on: boolean, locale: Locale): Promise<void> {
  return runtime.team.rpc.call("team.pause", { teamID, on }).then(
    async () => {
      const strings = await loadTeamText()
      showToast({
        message: strings.text(locale, on ? "own.team.pauseAll.done" : "own.team.resumeAll.done"),
        ...(on
          ? {
              action: {
                label: strings.text(locale, "own.team.menu.resumeAll"),
                run: () => void pauseTeam(runtime, teamID, false, locale),
              },
            }
          : {}),
      })
    },
    (error: unknown) => failed(locale, error),
  )
}

/** A failed team action as a toast, in the words of team/model.ts `errorText`. */
export async function failed(locale: Locale, error: unknown) {
  const [strings, { errorText }] = await Promise.all([loadTeamText(), import("./model")])
  showToast({ tone: "danger", message: errorText((key, params) => strings.text(locale, key, params), error) })
}

function report(error: unknown) {
  console.error("[own-web] team strings", error)
}
