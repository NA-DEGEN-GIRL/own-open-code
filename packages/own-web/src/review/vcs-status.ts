// Data of the Git branch/status chip of 03 §19.15 ([gap] 30, src/git/chip.tsx): `⑂ main · ±3` next to the session
// title, clicking it opens the review tab. Data: vcs.get (branch) and vcs.status (uncommitted files with line
// counts), both cheap and patch-free. Refreshed on branch updates and file changes of the folder, on turn ends and
// after a Git action of this window (`notifyGitChanged`: staging or a commit may not touch a watched file),
// debounced, and only while `active()` (a hidden chip fetches nothing; R9 no polling).
import type { VcsFileStatus } from "@opencode/client"
import { createEffect, createRoot, createSignal, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useData, type ServerKey } from "@/data"
import { debounce } from "./debounce"

export interface VcsStatusSummary {
  readonly files: number
  readonly additions: number
  readonly deletions: number
}

export function summarizeStatus(list: readonly VcsFileStatus[]): VcsStatusSummary {
  return list.reduce(
    (total, item) => ({
      files: total.files + 1,
      additions: total.additions + item.additions,
      deletions: total.deletions + item.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  )
}

const REFRESH_MS = 1_000

/** Git actions of this window per server and folder, so the chips refresh after them. */
const [written, setWritten] = createRoot(() => createStore<Record<string, number>>({}))

export function notifyGitChanged(serverKey: ServerKey, directory: string) {
  setWritten(writtenKey(serverKey, directory), (value) => (value ?? 0) + 1)
}

const writtenKey = (serverKey: ServerKey, directory: string) => JSON.stringify([serverKey, directory])

export function createVcsStatus(input: {
  readonly serverKey: () => ServerKey
  readonly directory: () => string | undefined
  readonly active: () => boolean
  /** A turn is running in the session on screen: its file writes wait for the turn end (R3, PF2–PF4). */
  readonly running?: () => boolean
}) {
  const data = useData()
  const [stamp, setStamp] = createSignal(0)
  const [store, setStore] = createStore({
    value: undefined as
      | {
          readonly directory: string
          readonly git: boolean
          readonly branch?: string
          readonly summary: VcsStatusSummary
        }
      | undefined,
  })
  const refresh = debounce(() => setStamp((value) => value + 1), REFRESH_MS)
  onCleanup(() => refresh.cancel())
  const fetched = { id: "" }

  createEffect(() => {
    const runtime = data.get(input.serverKey())
    const directory = input.directory()
    const id = JSON.stringify([
      directory,
      stamp(),
      directory ? (written[writtenKey(input.serverKey(), directory)] ?? 0) : 0,
    ])
    if (!input.active() || !runtime || !directory || runtime.connection.status() !== "connected") return
    if (fetched.id === id) return
    fetched.id = id
    const client = runtime.client()
    const location = { directory }
    void Promise.all([client.vcs.get({ location }), client.vcs.status({ location })])
      .then(([info, status]) => {
        if (fetched.id !== id) return
        setStore("value", {
          directory,
          git: Boolean(info.data.provider),
          branch: info.data.branch.current,
          summary: summarizeStatus(status.data),
        })
      })
      .catch(() => undefined)
  })

  createEffect(() => {
    const runtime = data.get(input.serverKey())
    if (!runtime) return
    const ofFolder = (location: { readonly directory?: string } | undefined) =>
      !location?.directory || location.directory === input.directory()
    const offs = [
      runtime.bus.on("vcs.branch.updated", (event) => ofFolder(event.location) && refresh.schedule()),
      runtime.bus.on(
        "filesystem.changed",
        (event) => ofFolder(event.location) && !untrack(() => input.running?.()) && refresh.schedule(),
      ),
      runtime.bus.on("session.execution.succeeded", () => refresh.schedule()),
      runtime.bus.on("session.execution.failed", () => refresh.schedule()),
      runtime.bus.on("session.execution.interrupted", () => refresh.schedule()),
      runtime.bus.on("server.connected", () => refresh.schedule()),
    ]
    onCleanup(() => offs.forEach((off) => off()))
  })

  const current = () => (store.value?.directory === input.directory() ? store.value : undefined)
  return {
    /** undefined until known. */
    git: () => current()?.git,
    branch: () => current()?.branch,
    summary: () => current()?.summary,
  }
}
