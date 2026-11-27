// Turn-end OS notifications (03 §9 "턴 완료", 05 §7.4): when a turn of a top-level session ends while the window is
// hidden (minimized, another virtual desktop, a background tab), the host shows `{session} — 응답 완료` (or
// `응답 실패`). Not for turns the user can see: the session on screen in a visible window, or turns the user stopped
// (`session.execution.interrupted`). Subagent (child) sessions are part of their parent's turn and never notify, nor
// do own.import's hidden summary helpers (09 §6 숨김).
// Merging (same session within 10 s) and "window has focus" are the host's (host.notify tag, desktop createNotify);
// clicking brings the window forward and opens the session. No timers (PF8): merging compares timestamps.
// Strings are kept here like src/requests/strings.ts (keys `own.notify.*`, movable into the shared catalogs).
//
// Team results (06 §9.3) are kept here too. Every team op that ends (`op.done` of any server's TeamStore) goes into
// the notification list: the latest 50, newest first, stored in this browser only. The list keeps the result card
// (team/summary.tsx) that `TeamResultSlot` shows above the team main until `닫기`. While nobody is looking, the end
// is also an OS notification that opens the team main. A card fetches its op (`op.get`) itself.
//
// Preset repairs (07 §4.3 `수리 알림 한 번`): the shell keeps this PC's repairs read (presets/repairs.ts) and
// announces each model event once, as a toast with its first action (`<후속 모델>로 고치기`, else `직접 고르기`, else
// `바꾸기`), from the lazy lines of presets/repair-notice.tsx (PF5). The lines stay in the preset button's menu, with
// its dot, and on settings 프리셋 until fixed; the models already announced are remembered in this browser.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { Option, Schema } from "effect"
import {
  createEffect,
  createRoot,
  getOwner,
  lazy,
  on,
  onCleanup,
  runWithOwner,
  Show,
  Suspense,
  untrack,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { DataLayer, ServerKey, ServerRuntime } from "@/data"
import { isImportHelper, useData } from "@/data"
import { isHelperSession } from "@/data/session-index"
import type { TeamEvent } from "@/data/team-rpc"
import { useHost } from "@/host"
import type { HostNotification, OsNotifications } from "@/host/types"
import { applyJosa, useI18n, type Locale } from "@/i18n"
import { presetRepairs, unannounced, watchRepairs } from "@/presets/repairs"
import type { Route } from "@/routing/routes"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import type { TeamKey } from "@/team/strings"
import { teamTitle } from "@/team/title"

export const turnKo = {
  "own.notify.turn.succeeded": "{session} — 응답 완료",
  "own.notify.turn.failed": "{session} — 응답 실패",
  "own.notify.turn.untitled": "제목 없는 대화",
} as const
export const turnEn: Record<keyof typeof turnKo, string> = {
  "own.notify.turn.succeeded": "{session} — response ready",
  "own.notify.turn.failed": "{session} — response failed",
  "own.notify.turn.untitled": "Untitled session",
}
export type TurnTextKey = keyof typeof turnKo

export function turnText(locale: Locale, key: TurnTextKey, params: Readonly<Record<string, string>> = {}) {
  const template = (locale === "en" ? turnEn : turnKo)[key]
  const filled = template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
  return locale === "ko" ? applyJosa(filled) : filled
}

export type TurnOutcome = "succeeded" | "failed"

/**
 * 03 §9: OS notification for a turn end only while nobody is looking. Hidden window: always. Visible but not focused
 * (another app in front): unless it is the session on screen. Visible and focused: the host drops it anyway.
 */
export function shouldNotifyTurn(input: {
  readonly capability: OsNotifications
  readonly available: boolean
  readonly hidden: boolean
  readonly focused: boolean
  readonly onScreen: boolean
}) {
  if (input.capability === "none" || !input.available) return false
  if (input.hidden) return true
  return !input.focused && !input.onScreen
}

export interface TurnNotifierInput {
  readonly data: DataLayer
  readonly capability: OsNotifications
  readonly notify?: (input: HostNotification) => void
  readonly hidden: () => boolean
  readonly focused: () => boolean
  readonly route: () => Route
  readonly locale: () => Locale
  readonly open: (serverKey: ServerKey, sessionID: string) => void
}

/** The session on screen (`/srv/:serverKey/s/:sessionID`), if any. */
function onScreen(route: Route, serverKey: ServerKey, sessionID: string) {
  return route.name === "session" && route.serverKey === serverKey && route.sessionID === sessionID
}

export function createTurnNotifier(input: TurnNotifierInput) {
  function turnEnded(serverKey: ServerKey, runtime: ServerRuntime, sessionID: string, outcome: TurnOutcome) {
    const notify = input.notify
    if (
      !notify ||
      !shouldNotifyTurn({
        capability: input.capability,
        available: true,
        hidden: input.hidden(),
        focused: input.focused(),
        onScreen: onScreen(input.route(), serverKey, sessionID),
      })
    )
      return
    const row = runtime.sessions.state.sessions[sessionID]
    const info = runtime.data.session.get(sessionID)
    // Child sessions (subagents) end inside their parent's turn; the parent's own end notifies. own.import's hidden
    // summary helpers (09 §6 숨김) never do: the import's own end is announced by its dialog.
    if (row?.parentID || info?.parentID) return
    if (isHelperSession(serverKey, sessionID) || isImportHelper(info?.metadata)) return
    const locale = input.locale()
    const role = runtime.team.placeOf(sessionID)?.role
    const title = teamTitle(info?.title || row?.title, role, locale) || turnText(locale, "own.notify.turn.untitled")
    notify({
      title: turnText(locale, `own.notify.turn.${outcome}`, { session: title }),
      tag: `own:turn:${serverKey}:${sessionID}`,
      onClick: () => input.open(serverKey, sessionID),
    })
  }

  createEffect(() => {
    if (input.capability === "none" || !input.notify) return
    for (const entry of input.data.servers.list()) {
      const runtime = input.data.get(entry.key)
      if (!runtime) continue
      onCleanup(
        runtime.bus.on("session.execution.succeeded", (event) =>
          turnEnded(entry.key, runtime, event.data.sessionID, "succeeded"),
        ),
      )
      onCleanup(
        runtime.bus.on("session.execution.failed", (event) =>
          turnEnded(entry.key, runtime, event.data.sessionID, "failed"),
        ),
      )
    }
  })
  return { turnEnded }
}

/** Mount once in the shell (next to RequestNotifications): turn ends, team results and preset repairs. */
export function TurnNotifications() {
  const data = useData()
  const host = useHost()
  const router = useRouter()
  const i18n = useI18n()
  const input: TurnNotifierInput = {
    data,
    capability: host.capabilities.osNotifications,
    notify: host.notify ? (notification) => host.notify?.(notification) : undefined,
    hidden: () => document.visibilityState === "hidden",
    focused: () => host.window?.isFocused() ?? document.hasFocus(),
    route: router.route,
    locale: i18n.locale,
    open: (serverKey, sessionID) => {
      host.window?.show()
      router.navigate({ name: "session", serverKey, sessionID })
    },
  }
  createTurnNotifier(input)
  createTeamResultNotifier(input)
  createRepairNotifier(data)
  return null
}

// ---- Preset repairs (07 §4.3) ----

const ANNOUNCED_KEY = "own.web.presets.repairsAnnounced"

/**
 * Reads this PC's repairs and shows each model event once (a toast with the line's first action). The lines are a lazy
 * chunk (PF5), loaded only for a model event to announce; their hooks run in the notifier's owner.
 */
function createRepairNotifier(data: DataLayer) {
  const owner = getOwner()
  watchRepairs(data.local().own)
  createEffect(
    on(presetRepairs, (list) => {
      if (!list) return
      const next = unannounced(list, readAnnounced())
      writeAnnounced(next.seen)
      if (!next.fresh.length) return
      void import("@/presets/repair-notice").then(
        (module) =>
          runWithOwner(owner, () => {
            const actions = module.useRepairActions()
            actions
              .lines()
              .filter((line) => next.fresh.some((repair) => repair.model === line.model))
              .forEach((line) => {
                const action = actions.toastAction(line)
                showToast({ message: line.text, ...(action ? { action } : {}) })
              })
          }),
        (error: unknown) => console.error("[own-web] preset repairs", error),
      )
    }),
  )
}

const decodeAnnounced = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

function readAnnounced(): readonly string[] {
  return Option.getOrElse(decodeAnnounced(stored(ANNOUNCED_KEY) ?? "[]"), () => [])
}

function writeAnnounced(models: readonly string[]) {
  try {
    localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(models))
  } catch {}
}

// ---- Team results (06 §9.3) ----

/** One ended team op in the notification list. */
export interface TeamResult {
  readonly serverKey: ServerKey
  readonly teamID: string
  readonly opID: string
  /** When the op last ended (`op.done`): an op that waited for confirms ends again later. */
  readonly at: number
  readonly state: OwnTeam.OpState
  /** `닫기` took it away from above the team main; the list keeps it. */
  readonly closed: boolean
}

/** The result card's title by op kind (06 §9.3, §9.7): the OS notification says the same. */
export const RESULT_TITLE: Readonly<Record<OwnTeam.OpKind, TeamKey>> = {
  enable: "own.team.card.title.enable",
  reorg: "own.team.card.title.reorg",
  integrate: "own.team.card.title.integrate",
  rotate: "own.team.card.title.rotate",
  paths: "own.team.card.title.paths",
  retire: "own.team.card.title.retire",
  disable: "own.team.card.title.disable",
  undo: "own.team.card.title.undo",
  home: "own.team.card.title.home",
  adopt: "own.team.card.title.adopt",
  unadopt: "own.team.card.title.unadopt",
  "team-account": "own.team.card.title.teamAccount",
  heavy: "own.team.card.title.heavy",
  seat: "own.team.card.title.seat",
}

const RESULTS_KEY = "own.web.team.results"
const RESULT_LIMIT = 50

// Defined before `results`, whose store reads the stored list when this module loads.
const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))

/** A stored entry as this build writes it (the store is this browser's; an older or broken one is dropped). */
const decodeResult = Schema.decodeUnknownOption(
  Schema.Struct({
    serverKey: Schema.String,
    teamID: Schema.String,
    opID: Schema.String,
    at: Schema.Number,
    state: Schema.Literals(["running", "waiting", "done", "failed", "cancelled"]),
    closed: Schema.Boolean,
  }),
)

const results = createRoot(() => {
  const [state, setState] = createStore<{ items: TeamResult[] }>({ items: readResults() })
  return { state, setState }
})

/** The notification list's team results, newest first (reactive). */
export function teamResults(): readonly TeamResult[] {
  return results.state.items
}

/** Records an op's end, newest first. An op that ends again moves to the top and shows again. */
export function recordTeamResult(result: Omit<TeamResult, "closed">) {
  results.setState(
    "items",
    produce((items) => {
      const index = items.findIndex((item) => item.serverKey === result.serverKey && item.opID === result.opID)
      if (index >= 0) items.splice(index, 1)
      items.unshift({ ...result, closed: false })
      if (items.length > RESULT_LIMIT) items.length = RESULT_LIMIT
    }),
  )
  writeResults()
}

/** `닫기` on a card: it leaves the team main and stays in the list. */
export function closeTeamResult(serverKey: ServerKey, opID: string) {
  const known = results.state.items.find((item) => item.serverKey === serverKey && item.opID === opID)
  if (!known || known.closed) return
  results.setState("items", (items) =>
    items.map((item) => (item.serverKey === serverKey && item.opID === opID ? { ...item, closed: true } : item)),
  )
  writeResults()
}

/** Records every team op that ends and, while nobody is looking, tells the OS; a click opens the team main. */
export function createTeamResultNotifier(input: TurnNotifierInput) {
  function ended(serverKey: ServerKey, runtime: ServerRuntime, event: TeamEvent<"op.done">) {
    const data = event.data
    recordTeamResult({ serverKey, teamID: data.teamID, opID: data.opID, at: event.created, state: data.state })
    const notify = input.notify
    const main = runtime.team.team(data.teamID)?.team.main.sessionID
    if (
      !notify ||
      !shouldNotifyTurn({
        capability: input.capability,
        available: true,
        hidden: input.hidden(),
        focused: input.focused(),
        onScreen: main !== undefined && onScreen(input.route(), serverKey, main),
      })
    )
      return
    void resultNotification(runtime, data, input.locale()).then((words) =>
      notify({
        ...words,
        tag: `own:team:${serverKey}:${data.opID}`,
        onClick: main === undefined ? undefined : () => input.open(serverKey, main),
      }),
    )
  }

  createEffect(() => {
    for (const entry of input.data.servers.list()) {
      const runtime = input.data.get(entry.key)
      if (!runtime) continue
      onCleanup(runtime.team.on("op.done", (event) => ended(entry.key, runtime, event)))
    }
  })
}

/** The OS notification of a team result: the card's title, and the state when the op did not simply finish. */
async function resultNotification(runtime: ServerRuntime, data: TeamEvent<"op.done">["data"], locale: Locale) {
  const [{ teamText }, op] = await Promise.all([
    import("@/team/strings"),
    runtime.team.rpc.call("op.get", { opID: data.opID }).then(
      (output) => output.op,
      () => undefined,
    ),
  ])
  const title = teamText.text(locale, op ? RESULT_TITLE[op.kind] : "own.team.name")
  if (data.state === "done") return { title }
  if (data.state === "failed") {
    const reason =
      op?.steps.find((step) => step.state === "failed")?.note ?? teamText.text(locale, "own.team.error.internalError")
    return { title, body: teamText.text(locale, "own.team.card.state.failed", { reason }) }
  }
  return { title, body: teamText.text(locale, `own.team.card.state.${data.state}`) }
}

const TeamResultCards = lazy(() => import("@/team/summary").then((module) => ({ default: module.TeamResultCards })))

/**
 * The result cards above the team main conversation (06 §9.3): the team's results that were not closed and its
 * running or waiting op. Mounted by the session banners; loads the card chunk only for a team main.
 */
export function TeamResultSlot(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const runtime = () => data.get(props.serverKey())
  const teamID = () => {
    const sessionID = props.sessionID()
    const place = sessionID ? runtime()?.team.placeOf(sessionID) : undefined
    return place?.role === "main" && !place.previous ? place.teamID : undefined
  }
  // A main known from its metadata only (the registry has not answered yet): read the registry.
  createEffect(() => {
    if (teamID()) untrack(() => runtime()?.team.ensure())
  })
  const shown = () => {
    const id = teamID()
    if (!id) return undefined
    const open = results.state.items.some(
      (item) => item.serverKey === props.serverKey() && item.teamID === id && !item.closed,
    )
    // Retire suggestions (06 §8.1 `끝낼 수 있음`) show as cards even when no result card or op is open.
    return open || runtime()?.team.team(id)?.op || (runtime()?.team.retireCandidates(id).length ?? 0) > 0
      ? id
      : undefined
  }
  return (
    <Show when={shown()}>
      {(id) => (
        <Suspense>
          <TeamResultCards serverKey={props.serverKey()} teamID={id()} />
        </Suspense>
      )}
    </Show>
  )
}

function readResults(): TeamResult[] {
  const list = Option.getOrElse(decodeList(stored(RESULTS_KEY) ?? "[]"), () => [])
  return list.flatMap((item) => Option.toArray(decodeResult(item))).slice(0, RESULT_LIMIT)
}

/** `localStorage.getItem`, which throws where storage is blocked (private modes): then nothing is stored. */
function stored(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeResults() {
  try {
    localStorage.setItem(RESULTS_KEY, JSON.stringify(results.state.items))
  } catch {}
}
