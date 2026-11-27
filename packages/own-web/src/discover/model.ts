// What the discoverability entry points offer (03 §4.3.1). Team mode and worktrees only exist for Git projects, and a
// project that is not one used to show nothing at all: the user could not tell a missing feature from a hidden one.
// These rules decide, per project row and connection, between the action, a short "Git 저장소에서만" explanation and
// nothing (the connection cannot do it: no own.team build with `enable`, a device without the `admin` or `prompt`
// scope, or the project list has not answered yet). The first-run hints remember their `닫기` per browser profile.
import { createRoot, createSignal } from "solid-js"
import type { ServerRuntime } from "@/data"
import { isDefaultFolder } from "@/projects/default-folder"
import { canEnableTeam } from "@/team/enable"
import type { DiscoverKey } from "./strings"

/** The project row's team button: open the team view, start team mode, or explain that it needs Git. */
export type TeamEntry =
  | { readonly kind: "view" }
  | { readonly kind: "enable"; readonly directory: string }
  | { readonly kind: "notGit" }

/** The project row's `⑂` button: the worktree menu, or the explanation that worktrees need Git. */
export type WorktreeEntry = "menu" | "notGit"

export interface ProjectPlace {
  readonly projectID: string
  /** The project row's folder (its canonical root). */
  readonly directory: string | undefined
}

/**
 * A team that is on is always shown (viewing needs no scope). Otherwise only where this build of own.team can enable
 * and this connection may (`admin`): `notGit` for a project that is not a Git repository, `enable` where
 * {@link canEnableTeam} says team mode can start. `undefined` until the project list and own.team's health answered.
 */
export function teamEntry(runtime: ServerRuntime, place: ProjectPlace): TeamEntry | undefined {
  const team = runtime.team
  if (team.teamsOfProject(place.projectID).length > 0) return { kind: "view" }
  const info = runtime.data.project.get(place.projectID)
  if (!info || !team.has("enable") || !team.rpc.allowed("enable")) return undefined
  if (info.vcs !== "git") return { kind: "notGit" }
  const directory = place.directory
  return directory && canEnableTeam(runtime, { directory, projectID: place.projectID })
    ? { kind: "enable", directory }
    : undefined
}

/**
 * Worktrees need a connection that may prompt (05 §13.5) and are the team view's areas once a team is on (06 §9.4), so
 * a team project gets no `⑂` button. `undefined` until the project list answered.
 */
export function worktreeEntry(runtime: ServerRuntime, projectID: string): WorktreeEntry | undefined {
  if (!runtime.rpc.can("prompt") || runtime.team.teamsOfProject(projectID).length > 0) return undefined
  const info = runtime.data.project.get(projectID)
  if (!info) return undefined
  return info.vcs === "git" ? "menu" : "notGit"
}

/**
 * `Git 저장소로 만들기…` (06 §3.0) for a project that is not a Git repository, where this build of own.team has it and
 * this connection may write the folder (`local`: never a gateway device, like upstream `vcs.init`). It runs on the
 * service that owns the project (this PC or the SSH host). `undefined` until the project list and the health answered.
 * Never for the 기본 대화 폴더 (03 §5.1): every folderless conversation shares it, so it stays a plain folder; its note
 * says so and the menus offer `프로젝트 폴더 열기…` instead (menus.ts `notGitAction`).
 */
export function gitInitEntry(runtime: ServerRuntime, place: ProjectPlace): string | undefined {
  const info = runtime.data.project.get(place.projectID)
  const team = runtime.team
  if (!info || info.vcs === "git" || !place.directory || isDefaultFolder(runtime, place.directory)) return undefined
  return team.has("git-init") && team.rpc.allowed("project.gitInit") ? place.directory : undefined
}

/**
 * The one-line note a menu shows for a project that is not a Git repository, naming what it cannot do here. The 기본
 * 대화 폴더 says instead why it stays a plain folder and where team mode and work folders are (a project folder).
 */
export function notGitNote(runtime: ServerRuntime, place: ProjectPlace): DiscoverKey | undefined {
  const team = teamEntry(runtime, place)?.kind === "notGit"
  const worktree = worktreeEntry(runtime, place.projectID) === "notGit"
  const shared = isDefaultFolder(runtime, place.directory)
  if (team && worktree) return shared ? "own.discover.defaultFolder.both" : "own.discover.notGit.both"
  if (team) return notGitFeatureNote(runtime, place, "team")
  if (worktree) return notGitFeatureNote(runtime, place, "worktree")
  return undefined
}

/** The explanation of the dimmed `[팀]` or `⑂` button and its palette command; the 기본 대화 폴더 has its own. */
export function notGitFeatureNote(runtime: ServerRuntime, place: ProjectPlace, feature: "team" | "worktree") {
  if (isDefaultFolder(runtime, place.directory))
    return feature === "team" ? "own.discover.defaultFolder.team" : "own.discover.defaultFolder.worktree"
  return feature === "team" ? "own.discover.notGit.team" : "own.discover.notGit.worktree"
}

const STORAGE_KEY = "own.web.discover.hints"

const hints = createRoot(() => {
  const [closed, setClosed] = createSignal(readClosed())
  return { closed, setClosed }
})

/** The first-run hints were closed in this browser profile (a per-viewer convenience; storage may be unavailable). */
export const hintsClosed = hints.closed

export function setHintsClosed(closed: boolean) {
  hints.setClosed(closed)
  try {
    if (closed) localStorage.setItem(STORAGE_KEY, "closed")
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private windows and blocked storage: the choice lasts for this page only.
  }
}

function readClosed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "closed"
  } catch {
    return false
  }
}
