// File tree state of one location (03 §19.4 "트리(가상 목록)"). Folders load on expand with `fs.list` (direct
// children only), rows are the expanded part flattened by upstream's `flattenLiveFileTreeV2`, and a refresh lists
// the root and the expanded folders again (`reconcile` by path, so unchanged rows keep their DOM, R1). Collapsed
// folders forget their listing and read it again when opened. `.git` is left out like editors do.
import { batch, createEffect, createMemo, createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ancestors, dirname, normalizePath } from "./paths"
import { flattenLiveFileTreeV2, type FileNode } from "./upstream/file-tree-v2-model"

export interface ListedEntry {
  readonly path: string
  readonly type: "file" | "directory"
}

/** `fs.list` of a folder ("" = the location root); rejects when the folder is gone. */
export type ListFolder = (folder: string) => Promise<readonly ListedEntry[]>

/** At most this many folders are listed again per refresh; deeper expanded ones reload when shown again. */
const REFRESH_FOLDERS = 48
const PARALLEL = 6

export function createTree(list: ListFolder) {
  const [state, setState] = createStore({
    children: {} as Record<string, FileNode[] | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    errors: {} as Record<string, string | undefined>,
    expanded: {} as Record<string, boolean | undefined>,
  })
  const inflight = new Map<string, Promise<void>>()

  function load(folder: string, force = false): Promise<void> {
    const running = inflight.get(folder)
    if (running) return running
    if (!force && state.children[folder]) return Promise.resolve()
    setState("loading", folder, true)
    const job = list(folder)
      .then((entries) => {
        const nodes = entries.flatMap((entry) => toNode(entry))
        batch(() => {
          setState("children", folder, reconcile(nodes, { key: "path" }))
          setState("errors", folder, undefined)
        })
      })
      .catch((error: unknown) => {
        // A folder that disappeared since it was listed: drop it instead of showing an error row.
        if (force && state.children[folder] && folder) return forget(folder)
        setState("errors", folder, error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        inflight.delete(folder)
        setState("loading", folder, undefined)
      })
    inflight.set(folder, job)
    return job
  }

  function forget(folder: string) {
    batch(() => {
      setState("children", folder, undefined)
      setState("expanded", folder, undefined)
      setState("errors", folder, undefined)
    })
  }

  const isOpen = (folder: string) => folder === "" || ancestors(`${folder}/x`).every((path) => state.expanded[path])

  const rows = createMemo(() =>
    flattenLiveFileTreeV2(
      (folder) => state.children[folder] ?? [],
      (path) => state.expanded[path] === true,
    ),
  )

  // Expanded folders inside a folder that was collapsed (and so forgot its listing) load again once shown.
  createEffect(() => {
    for (const row of rows()) {
      const path = row.node.path
      if (row.node.type !== "directory" || !state.expanded[path]) continue
      if (!state.children[path] && !state.loading[path] && !state.errors[path]) void load(path)
    }
  })

  function expand(folder: string) {
    setState("expanded", folder, true)
    return load(folder)
  }

  return {
    state,
    rows,
    load,
    expand,
    collapse(folder: string) {
      setState("expanded", folder, undefined)
    },
    toggle(folder: string) {
      if (state.expanded[folder]) return void setState("expanded", folder, undefined)
      void expand(folder)
    },
    /** Expands every folder above `path` (loading them in order) so its row exists. */
    async reveal(path: string) {
      await load("")
      for (const folder of ancestors(path)) await expand(folder)
    },
    /** `file` / `directory` when the parent folder is listed, else `undefined`. */
    typeOf(path: string) {
      return state.children[dirname(path)]?.find((node) => node.path === path)?.type
    },
    /** Lists the root and the visible expanded folders again; hidden listings are dropped. */
    async refresh() {
      const loaded = Object.keys(state.children).filter((folder) => state.children[folder])
      const visible = loaded.filter(isOpen).toSorted((a, b) => a.split("/").length - b.split("/").length)
      const kept = new Set(visible.slice(0, REFRESH_FOLDERS))
      batch(() =>
        loaded.filter((folder) => !kept.has(folder)).forEach((folder) => setState("children", folder, undefined)),
      )
      const order = [...kept]
      for (let index = 0; index < order.length; index += PARALLEL)
        await Promise.all(order.slice(index, index + PARALLEL).map((folder) => load(folder, true)))
    },
  }
}

export type Tree = ReturnType<typeof createTree>

function toNode(entry: ListedEntry): FileNode[] {
  const path = normalizePath(entry.path)
  const name = path.split("/").at(-1) ?? path
  if (!path || path === "." || (entry.type === "directory" && name === ".git")) return []
  return [{ name, path, absolute: path, type: entry.type, ignored: false }]
}

/** One tree per location, shared by the sessions of that folder; the oldest of more than 8 is dropped. */
const trees = new Map<string, { readonly tree: Tree; readonly dispose: () => void }>()
const TREES_MAX = 8

export function treeFor(key: string, list: ListFolder) {
  const existing = trees.get(key)
  if (existing) {
    trees.delete(key)
    trees.set(key, existing)
    return existing.tree
  }
  const created = createRoot((dispose) => ({ tree: createTree(list), dispose }))
  trees.set(key, created)
  if (trees.size > TREES_MAX) {
    const [oldest, value] = trees.entries().next().value!
    trees.delete(oldest)
    value.dispose()
  }
  return created.tree
}
