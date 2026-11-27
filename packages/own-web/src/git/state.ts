// Git state of the review tab's folder for the Git actions (03 §19.2): branch, upstream, ahead/behind and which
// files are staged, read with the fixed `git status --porcelain=v2 --branch` command through `shell.create` (the v2
// VCS API has no index state). Also whether `gh` is installed (for `PR 만들기`) and which shell the server runs
// commands with (quoting, commands.ts).
//
// Read only while `active()` (the review tab is visible in a mode with Git actions), again on file changes and
// branch updates of the folder (debounced, skipped while the session runs a turn: the turn end refreshes once) and
// after every Git action. No polling (R9).
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import { debounce } from "@/review/debounce"
import { GH_COMMAND, parseStatus, shellKind, STATUS_COMMAND, type GitStatus, type ShellKind } from "./commands"
import { runCommand, succeeded } from "./runner"

const REFRESH_MS = 1_500
const READ_TIMEOUT_MS = 20_000

/** `gh --version` once per server runtime and folder. */
const ghByFolder = new WeakMap<ServerRuntime, Map<string, Promise<boolean>>>()

export function createGitState(input: {
  readonly runtime: () => ServerRuntime | undefined
  readonly directory: () => string | undefined
  readonly active: () => boolean
  readonly running: () => boolean
}) {
  const [stamp, setStamp] = createSignal(0)
  const [store, setStore] = createStore({
    value: undefined as
      | { readonly directory: string; readonly status: GitStatus; readonly shell: ShellKind; readonly gh?: boolean }
      | undefined,
    loading: false,
    error: undefined as string | undefined,
  })
  const refresh = debounce(() => setStamp((value) => value + 1), REFRESH_MS)
  onCleanup(() => refresh.cancel())
  const read = { id: "", token: 0 }

  createEffect(() => {
    const runtime = input.runtime()
    const directory = input.directory()
    const id = JSON.stringify([runtime?.key, directory, stamp()])
    if (!input.active() || !runtime || !directory || runtime.connection.status() !== "connected") return
    if (read.id === id) return
    read.id = id
    const token = ++read.token
    setStore({ loading: true })
    void runCommand(runtime, { directory, command: STATUS_COMMAND, timeoutMs: READ_TIMEOUT_MS, label: "status" })
      .then(async (result) => {
        if (token !== read.token) return
        if (!succeeded(result)) return setStore({ loading: false, error: result.output.trim() || result.status })
        const shell = shellKind(result.shell)
        const status = parseStatus(result.output)
        setStore({ value: { directory, status, shell }, loading: false, error: undefined })
        const gh = await ghAvailable(runtime, directory)
        if (token === read.token) setStore("value", (value) => (value ? { ...value, gh } : value))
      })
      .catch((error: unknown) => {
        if (token === read.token)
          setStore({ loading: false, error: error instanceof Error ? error.message : String(error) })
      })
  })

  createEffect(() => {
    const runtime = input.runtime()
    if (!runtime) return
    const ofFolder = (location: { readonly directory?: string } | undefined) =>
      !location?.directory || location.directory === untrack(input.directory)
    const schedule = () => {
      if (!untrack(input.running)) refresh.schedule()
    }
    const offs = [
      runtime.bus.on("filesystem.changed", (event) => ofFolder(event.location) && schedule()),
      runtime.bus.on("vcs.branch.updated", (event) => ofFolder(event.location) && refresh.schedule()),
      runtime.bus.on("session.execution.succeeded", () => refresh.schedule()),
      runtime.bus.on("session.execution.failed", () => refresh.schedule()),
      runtime.bus.on("session.execution.interrupted", () => refresh.schedule()),
      runtime.bus.on("server.connected", () => refresh.schedule()),
    ]
    onCleanup(() => offs.forEach((off) => off()))
  })

  const current = () => (store.value?.directory === input.directory() ? store.value : undefined)
  return {
    status: () => current()?.status,
    shell: () => current()?.shell,
    gh: () => current()?.gh,
    loading: () => store.loading,
    error: () => store.error,
    /** Reads again now (after a Git action). */
    refresh() {
      refresh.cancel()
      setStamp((value) => value + 1)
    },
  }
}

export type GitState = ReturnType<typeof createGitState>

function ghAvailable(runtime: ServerRuntime, directory: string) {
  const folders = ghByFolder.get(runtime) ?? new Map<string, Promise<boolean>>()
  ghByFolder.set(runtime, folders)
  const known = folders.get(directory)
  if (known) return known
  const probe = runCommand(runtime, { directory, command: GH_COMMAND, timeoutMs: READ_TIMEOUT_MS, label: "gh" })
    .then(succeeded)
    .catch(() => false)
  folders.set(directory, probe)
  return probe
}
