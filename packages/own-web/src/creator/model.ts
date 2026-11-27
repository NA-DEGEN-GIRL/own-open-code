// Pure parts of 설정 > 확장 (17 §8.1): what each extension's status, effects and versions read as, and the error a
// failed write shows. The page (settings.tsx) renders them.
import type { Creator } from "@own/protocol/creator"
import { OwnRpcError } from "@/data"
import type { CreatorKey } from "./strings"

export type View = Creator.View

export const STATUS: Readonly<Record<Creator.Status, CreatorKey>> = {
  active: "own.ext.status.active",
  disabled: "own.ext.status.disabled",
  invalid: "own.ext.status.invalid",
  tampered: "own.ext.status.tampered",
  missing: "own.ext.status.missing",
  unavailable: "own.ext.status.unavailable",
  pending: "own.ext.status.pending",
  outdated: "own.ext.status.outdated",
}

export const TONE: Readonly<Record<Creator.Status, "ok" | "plain" | "warn" | "danger">> = {
  active: "ok",
  disabled: "plain",
  invalid: "warn",
  tampered: "danger",
  missing: "danger",
  unavailable: "warn",
  pending: "warn",
  outdated: "warn",
}

/** What kind of code an extension runs (17 §11, §12): none, an MCP server process, or a plugin in the service. */
export function kindKey(kind: View["kind"]): CreatorKey {
  return `own.ext.kind.${kind}`
}

/** A C3 extension's active version waits for the user's approval (or has it). */
export function trustState(view: Pick<View, "kind" | "trusted" | "active">) {
  if (view.kind !== "plugin") return undefined
  return view.trusted.includes(view.active) ? ("trusted" as const) : ("pending" as const)
}

export function typeKey(type: Creator.ItemType): CreatorKey {
  return `own.ext.type.${type}`
}

export function cacheKey(cache: View["effects"][number]["cache"]): CreatorKey {
  return `own.ext.cache.${cache}`
}

/** The extension holds an item that applies to every project whatever its scope (a harness's 내 지시문). */
export function globalOnly(view: Pick<View, "effects">) {
  return view.effects.some((effect) => effect.global)
}

/** Versions newest first, with whether each is the active one. */
export function versions(view: Pick<View, "versions" | "active">) {
  return view.versions
    .map((version) => ({ ...version, current: version.n === view.active }))
    .toSorted((a, b) => b.n - a.n)
}

/** `2026-11-04 14:05` in local time. */
export function when(at: number) {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The folders a scope edit leaves: `folder` added once (case-insensitively on Windows paths), or one taken out. */
export function withFolder(projects: readonly string[], folder: string) {
  const key = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  return projects.some((item) => key(item) === key(folder)) ? [...projects] : [...projects, folder]
}

export function withoutFolder(projects: readonly string[], folder: string) {
  return projects.filter((item) => item !== folder)
}

/** The message of a failed write: the RPC's problems when it has them. */
export function failure(error: unknown): { readonly key: CreatorKey; readonly problems?: string } {
  if (!(error instanceof OwnRpcError)) return { key: "own.ext.error.other" }
  if (error.type === "own.scope_denied") return { key: "own.ext.error.scope" }
  const data = error.data
  const problems =
    typeof data === "object" && data !== null && "problems" in data && Array.isArray(data.problems)
      ? data.problems
          .flatMap((problem: unknown) =>
            typeof problem === "object" && problem !== null && "message" in problem ? [String(problem.message)] : [],
          )
          .join("; ")
      : undefined
  if (error.type === "invalid") return { key: "own.ext.error.invalid", problems: problems ?? "" }
  if (error.type === "scope_invalid") return { key: "own.ext.error.folders", problems: problems ?? "" }
  return { key: "own.ext.error.other" }
}

/** What a host's line of an extension says (17 §10): the PC's decision, then the host's report when it was sent. */
export function reachKey(reach: View["remote"][number]["reach"]): CreatorKey {
  return `own.ext.reach.${reach}`
}

export function hostStateKey(line: View["remote"][number]): { readonly key: CreatorKey; readonly status?: string } | undefined {
  // Not sent any more, but the host's last report still has it on: it runs there until the host syncs (CRM-34).
  if (line.reach !== "sent") return line.state?.status === "active" ? { key: "own.ext.host.stale" } : undefined
  const status = line.state?.status
  if (status === undefined) return { key: "own.ext.host.waiting" }
  if (status === "active") return { key: "own.ext.host.active" }
  if (status === "checking") return { key: "own.ext.host.checking" }
  if (status === "failed") return { key: "own.ext.host.failed" }
  return { key: "own.ext.host.other", status }
}

/** The host selection with `host` chosen or not (only and except modes list the chosen hosts). */
export function withHost(hosts: View["hosts"], host: string, chosen: boolean): View["hosts"] {
  const ids = hosts.ids.filter((id) => id !== host)
  return { mode: hosts.mode, ids: chosen ? [...ids, host] : ids }
}

/** A host folder is an absolute path of the host (POSIX on a Linux host). */
export function hostFolderOk(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)
}
