// 설정 > 승인·권한 `에이전트가 못 여는 파일·폴더` (01 §13, 03 §18.8, PP): the view model over one server's own.accounts
// `protectedPaths.*`. Each server keeps its own list (an SSH host places it in its own home folder), so the page reads
// the server picked on it. Reading is open to every connection; adding, removing and the home folder's suggestions are
// this PC's windows' alone (`local` scope, like "항상 허용"), so a phone or another PC sees the list read-only. An older
// service without the methods says so. Every change comes back as the service's view, and another window's change
// arrives as `protectedPaths.changed`.
import { createSignal } from "solid-js"
import type { ServerRuntime } from "@/data"
import { OwnRpcError, type OwnOutput } from "@/data/rpc"
import { createStatus } from "@/limits/kit"
import { ProtectedPaths } from "@own/protocol/protected-paths"
import type { ProtectedKey, ProtectedText } from "./strings"

export type ProtectedView = OwnOutput<"protectedPaths.get">
export type ProtectedSuggestion = OwnOutput<"protectedPaths.suggest">["items"][number]

/** The built-in entries by group, in the order the page shows the groups. */
export const GROUPS: ReadonlyArray<ProtectedPaths.Group> = [
  "own",
  "keys",
  "ai",
  "developer",
  "system",
  "browser",
  "wallet",
  "history",
]

export function grouped(view: ProtectedView) {
  return GROUPS.flatMap((group) => {
    const entries = view.builtIn.filter((entry) => entry.group === group)
    return entries.length === 0 ? [] : [{ group, entries }]
  })
}

/** The message for a refused `protectedPaths.add` (`protected_path_invalid`), else the generic one. */
export function addError(error: unknown, text: ProtectedText) {
  if (!(error instanceof OwnRpcError) || error.type !== "protected_path_invalid") return text("own.protected.addFailed")
  const reason =
    typeof error.data === "object" && error.data !== null && "reason" in error.data ? error.data.reason : ""
  const key = `own.protected.problem.${String(reason)}`
  return isKey(key) ? text(key, { max: ProtectedPaths.MAX_USER }) : text("own.protected.addFailed")
}

const KEYS: ReadonlySet<string> = new Set([
  "own.protected.problem.relative",
  "own.protected.problem.root",
  "own.protected.problem.home",
  "own.protected.problem.wildcard",
  "own.protected.problem.too_many",
])
function isKey(key: string): key is ProtectedKey {
  return KEYS.has(key)
}

/** An older service answers the method as unknown. */
export function unsupported(error: unknown) {
  return error instanceof OwnRpcError && error.type === "rpc.method_not_found"
}

export function protectedState(runtime: ServerRuntime, text: ProtectedText) {
  const [view, setView] = createSignal<ProtectedView>()
  const [suggestions, setSuggestions] = createSignal<ReadonlyArray<ProtectedSuggestion>>([])
  const [failure, setFailure] = createSignal<"unsupported" | "failed">()
  const [busy, setBusy] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const status = createStatus()
  const editable = () => runtime.rpc.allowed("protectedPaths.add")

  async function refreshSuggestions() {
    if (!runtime.rpc.allowed("protectedPaths.suggest")) return setSuggestions([])
    const answer = await runtime.rpc.call("protectedPaths.suggest", {}).catch(() => undefined)
    setSuggestions(answer?.items ?? [])
  }

  async function load() {
    try {
      setView(await runtime.rpc.call("protectedPaths.get", {}))
      setFailure(undefined)
    } catch (error) {
      setFailure(unsupported(error) ? "unsupported" : "failed")
      return
    }
    await refreshSuggestions()
  }

  async function add(input: string) {
    const path = input.trim()
    if (path === "" || busy()) return
    setBusy(true)
    status.clear()
    try {
      const before = view()?.user.length ?? 0
      const next = await runtime.rpc.call("protectedPaths.add", { path })
      setView(next)
      setDraft("")
      if (next.user.length === before) status.info(text("own.protected.already"))
      else status.ok(text("own.protected.added", { path }))
      await refreshSuggestions()
    } catch (error) {
      status.error(addError(error, text))
    } finally {
      setBusy(false)
    }
  }

  async function remove(path: string) {
    if (busy()) return
    setBusy(true)
    status.clear()
    try {
      setView(await runtime.rpc.call("protectedPaths.remove", { path }))
      status.ok(text("own.protected.removed", { path }))
      await refreshSuggestions()
    } catch {
      status.error(text("own.protected.removeFailed"))
    } finally {
      setBusy(false)
    }
  }

  /** Another window or device changed the list. */
  const follow = () =>
    runtime.own.on("protectedPaths.changed", (event) => {
      setView(event.data.paths)
      void refreshSuggestions()
    })

  return { view, suggestions, failure, busy, draft, setDraft, status, editable, load, add, remove, follow }
}

export type ProtectedState = ReturnType<typeof protectedState>
