// Worktree state shared by the new-session selector, the move and cleanup dialogs and the sidebar groups:
//   - the new-session choice per project (`serverKey:projectID`), remembered in localStorage as a per-viewer
//     convenience (03 §5.1 "그 프로젝트에서 마지막으로 쓴" rule, like upstream `workspaces.lastUsed`); storage
//     failures only lose the memory;
//   - which project is creating a worktree right now (the selector shows it, the composer keeps send locked);
//   - one `worktree.list` per project, reloaded on `worktree.updated` (no polling, R9).
import { batch, createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { ServerKey, ServerRuntime } from "@/data"
import { listWorktrees } from "./api"
import type { Choice, WorktreeEntry } from "./model"

const STORAGE_KEY = "own.web.worktree.choice"
const STORED_LIMIT = 50

export const projectKey = (serverKey: ServerKey, projectID: string) => `${serverKey}:${projectID}`

interface ListState {
  readonly items?: WorktreeEntry[]
  readonly error?: string
  readonly loading: boolean
}

const state = createRoot(() => {
  const [choices, setChoices] = createStore<Record<string, Choice>>(readStored())
  const [lists, setLists] = createStore<Record<string, ListState>>({})
  const [creating, setCreating] = createSignal<string>()
  return { choices, setChoices, lists, setLists, creating, setCreating }
})

export const worktreeChoices = {
  get: (key: string): Choice | undefined => state.choices[key],
  set(key: string, choice: Choice) {
    state.setChoices(key, reconcile(choice))
    writeStored(state.choices)
  },
  /** The project key a worktree is being created for (new session or move), if any. */
  creating: state.creating,
  setCreating: state.setCreating,
}

export function worktreeList(key: string) {
  return state.lists[key]
}

const watched = new WeakSet<ServerRuntime>()

/**
 * Loads a project's worktrees (once, or again with `force`), and from the first load on keeps every loaded project
 * of that server current on `worktree.updated`.
 */
export function loadWorktrees(runtime: ServerRuntime, serverKey: ServerKey, projectID: string, force = false) {
  const key = projectKey(serverKey, projectID)
  if (!watched.has(runtime)) {
    watched.add(runtime)
    runtime.bus.on("worktree.updated", (event) => {
      const updated = projectKey(serverKey, event.data.projectID)
      if (state.lists[updated]) void fetchList(runtime, updated, event.data.projectID)
    })
  }
  const current = state.lists[key]
  if (!force && current && (current.items || current.loading)) return
  void fetchList(runtime, key, projectID)
}

async function fetchList(runtime: ServerRuntime, key: string, projectID: string) {
  state.setLists(key, (previous) => ({ ...previous, loading: true }))
  try {
    const items = await listWorktrees(runtime, projectID)
    batch(() => state.setLists(key, { items: [...items], loading: false, error: undefined }))
  } catch (error) {
    state.setLists(key, (previous) => ({
      items: previous?.items,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

function readStored(): Record<string, Choice> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
        const choice = storedChoice(value)
        return choice ? [[key, choice]] : []
      }),
    )
  } catch {
    return {}
  }
}

function storedChoice(value: unknown): Choice | undefined {
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (item.mode !== "local" && item.mode !== "new" && item.mode !== "existing") return undefined
  return {
    mode: item.mode,
    base: typeof item.base === "string" ? item.base : undefined,
    existing: typeof item.existing === "string" ? item.existing : undefined,
  }
}

function writeStored(choices: Record<string, Choice>) {
  try {
    const entries = Object.entries(choices).slice(-STORED_LIMIT)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Private windows and blocked storage: the choice lasts for this page only.
  }
}
