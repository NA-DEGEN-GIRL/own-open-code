// Per-viewer sidebar conveniences in localStorage (03 §3: window state stays out of the URL; 4.2: storage failures
// fall back to defaults). Nothing here is secret: collapsed projects, opened subagent lists, list density, and the
// last account list (labels and colors only) so saved rows show their chips before the service answers (PF1).
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { AccountLike } from "./model"

const SAVE_DELAY = 400

export type Density = "comfortable" | "compact"

const DENSITY_KEY = "own.web.sidebar.density"
const [density, setDensitySignal] = createSignal<Density>(readDensity())

/** 설정 > 일반 > "세션 목록 밀도" (4.3): the settings page calls `setSidebarDensity`. */
export const sidebarDensity = density

export function setSidebarDensity(next: Density) {
  setDensitySignal(next)
  write(DENSITY_KEY, next)
}

function readDensity(): Density {
  return read(DENSITY_KEY) === "compact" ? "compact" : "comfortable"
}

const [archiveView, setArchiveViewSignal] = createSignal(false)

/** 19.11 `보관함` view: every server tree lists its archived sessions instead of the working list. Not persisted. */
export const sidebarArchiveView = archiveView

export function setSidebarArchiveView(next: boolean) {
  setArchiveViewSignal(next)
}

export interface SidebarPrefsState {
  /** projectID → collapsed. Projects are open by default. */
  collapsed: Record<string, true>
  /** Root sessionID → its subagent rows are shown. Subagents are folded by default (03 §3). */
  expanded: Record<string, true>
}

export function createSidebarPrefs(windowKey: string) {
  const key = `own.web.sidebar.${windowKey}`
  const [state, setState] = createStore<SidebarPrefsState>({ collapsed: {}, expanded: {}, ...load(key) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => write(key, JSON.stringify(state)), SAVE_DELAY)
  }
  const toggle = (field: keyof SidebarPrefsState, id: string, value?: boolean) => {
    const next = value ?? !state[field][id]
    setState(
      field,
      produce((map) => {
        if (next) map[id] = true
        else delete map[id]
      }),
    )
    save()
  }
  return {
    state,
    collapsed: (projectID: string) => state.collapsed[projectID] === true,
    expanded: (sessionID: string) => state.expanded[sessionID] === true,
    toggleProject: (projectID: string, collapsed?: boolean) => toggle("collapsed", projectID, collapsed),
    toggleChildren: (sessionID: string, expanded?: boolean) => toggle("expanded", sessionID, expanded),
  }
}

export type SidebarPrefs = ReturnType<typeof createSidebarPrefs>

function load(key: string): Partial<SidebarPrefsState> {
  try {
    const value: unknown = JSON.parse(read(key) ?? "null")
    if (typeof value !== "object" || value === null) return {}
    return {
      collapsed: "collapsed" in value ? flags(value.collapsed) : {},
      expanded: "expanded" in value ? flags(value.expanded) : {},
    }
  } catch {
    return {}
  }
}

function flags(value: unknown): Record<string, true> {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([id, flag]) => (flag === true ? [[id, true as const]] : [])))
}

// ---------------------------------------------------------------------------------------------------------------
// Saved account list per server: chips of saved rows before `accounts.list` answers.

const ACCOUNT_FIELDS = ["id", "providerID", "label", "shortLabel", "color", "thirdParty", "status"] as const

export function readSavedAccounts(serverKey: string): AccountLike[] {
  try {
    const value: unknown = JSON.parse(read(`own.web.sidebar.accounts.${serverKey}`) ?? "[]")
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is AccountLike =>
        typeof item === "object" &&
        item !== null &&
        ACCOUNT_FIELDS.every((field) => field in item) &&
        typeof item.id === "string" &&
        typeof item.providerID === "string" &&
        typeof item.label === "string",
    )
  } catch {
    return []
  }
}

export function saveAccounts(serverKey: string, accounts: readonly AccountLike[]) {
  const plain = accounts.map((account) => ({
    id: account.id,
    providerID: account.providerID,
    label: account.label,
    shortLabel: account.shortLabel,
    color: account.color,
    thirdParty: account.thirdParty,
    status: account.status,
  }))
  write(`own.web.sidebar.accounts.${serverKey}`, JSON.stringify(plain))
}

function read(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}
