// Review state shared by the lazy review chunk and the light hooks (badge, footer link, intents): per session the
// chosen mode (and whether the user picked it), base, active file and list visibility, plus the last turn's changed
// file count for the tab badge. Per window, in memory. The viewer preferences (split/unified, expand) are per-viewer
// conveniences in localStorage; losing them only restores the defaults.
import { createStore } from "solid-js/store"
import type { ServerKey } from "@/data"
import type { DiffStyle, ExpandMode, ReviewMode } from "./model"

export interface ReviewSessionState {
  readonly mode?: ReviewMode
  /** The user chose the mode; turn ends no longer switch it to `마지막 턴`. */
  readonly manual: boolean
  /** A base the user picked for `브랜치 대 base` (a branch name from vcs.branch.list). */
  readonly base?: string
  readonly file?: string
  readonly listOpen: boolean
  /** Files the last finished turn changed, for the tab badge; `seen` once the review tab showed that turn. */
  readonly lastTurn?: { readonly count: number; readonly seen: boolean }
}

export interface ReviewPrefs {
  readonly diffStyle: DiffStyle
  readonly expandMode: ExpandMode
}

const PREFS_KEY = "own.web.review.prefs"
const EMPTY: ReviewSessionState = { manual: false, listOpen: true }

export function reviewKey(serverKey: ServerKey, sessionID: string) {
  return `${serverKey}/${sessionID}`
}

const [sessions, setSessions] = createStore<Record<string, ReviewSessionState>>({})
const [prefs, setPrefs] = createStore<ReviewPrefs>(readPrefs())

export const reviewState = {
  get: (key: string): ReviewSessionState => sessions[key] ?? EMPTY,
  setMode(key: string, mode: ReviewMode, manual: boolean) {
    setSessions(key, (current) => ({ ...(current ?? EMPTY), mode, manual: manual || (current?.manual ?? false) }))
  },
  setBase: (key: string, base: string) => setSessions(key, (current) => ({ ...(current ?? EMPTY), base })),
  setFile: (key: string, file: string) => setSessions(key, (current) => ({ ...(current ?? EMPTY), file })),
  setListOpen: (key: string, listOpen: boolean) => setSessions(key, (current) => ({ ...(current ?? EMPTY), listOpen })),
  setLastTurn: (key: string, count: number) =>
    setSessions(key, (current) => ({ ...(current ?? EMPTY), lastTurn: { count, seen: false } })),
  markLastTurnSeen(key: string) {
    const lastTurn = sessions[key]?.lastTurn
    if (!lastTurn || lastTurn.seen) return
    setSessions(key, (current) => ({ ...(current ?? EMPTY), lastTurn: { count: lastTurn.count, seen: true } }))
  },
}

export const reviewPrefs = {
  get: () => prefs,
  setDiffStyle(diffStyle: DiffStyle) {
    setPrefs({ diffStyle })
    writePrefs()
  },
  setExpandMode(expandMode: ExpandMode) {
    setPrefs({ expandMode })
    writePrefs()
  },
}

function readPrefs(): ReviewPrefs {
  const fallback: ReviewPrefs = { diffStyle: "unified", expandMode: "collapse" }
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<ReviewPrefs> | null
    return {
      diffStyle: stored?.diffStyle === "split" ? "split" : fallback.diffStyle,
      expandMode: stored?.expandMode === "expand" ? "expand" : fallback.expandMode,
    }
  } catch {
    return fallback
  }
}

function writePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ diffStyle: prefs.diffStyle, expandMode: prefs.expandMode }))
  } catch {}
}
