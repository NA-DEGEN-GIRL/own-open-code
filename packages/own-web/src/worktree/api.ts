// Server calls of the worktree flow (03 §19.3; 01 §17.1 #19: `worktree.*` and `session.move`).
//
// Location rules (01 §15):
//   - `worktree.list/create/remove/refresh` take a project id and no location; `project.update` (startup script,
//     `commands.start`) too.
//   - Branches for the base selector come from `vcs.branch.list` at the project's canonical root, a Location that
//     exists already (never an arbitrary folder, 01 G15).
//   - `session.move` names the destination; the server resolves and boots it. From `session.moved` on, the session's
//     stored `location.directory` is the new folder and every session call (own RPC through src/data's
//     `sessionDirectory`, shell calls in src/background) follows it; nothing here caches the old one.
//   - own.accounts `worktree.inspect` (the cleanup guard) is a global method: src/data sends it to the control location.
import type { ServerRuntime } from "@/data"
import { samePath } from "@/projects/path"
import { isInside, type WorktreeEntry } from "./model"

export interface ProjectRef {
  readonly id: string
  /** Canonical root: the main checkout, source of new worktrees (`worktree.create{from}`). */
  readonly root: string
  readonly vcs?: string
  /** `commands.start`: the startup script the server runs in each new worktree. */
  readonly start?: string
}

/**
 * The project of a folder the UI already knows, without a request: the project rows (their folder or a subfolder),
 * a session row in that folder (worktree sessions carry their project id), then createData's location info.
 */
export function knownProjectID(runtime: ServerRuntime, directory: string) {
  const index = runtime.sessions.state
  const projects = Object.values(index.projects)
  const exact = projects.find((row) => samePath(row.directory, directory))
  if (exact) return exact.id
  const session = Object.values(index.sessions).find((row) => samePath(row.directory, directory))
  if (session) return session.projectID
  const inside = projects
    .filter((row) => isInside(row.directory, directory))
    .toSorted((a, b) => b.directory.length - a.directory.length)[0]
  if (inside) return inside.id
  return runtime.data.location.info({ directory })?.project.id
}

/** A root session of a Git project on a connection that may prompt (device scopes, 05 §13.5). */
export function canMoveSession(runtime: ServerRuntime, sessionID: string) {
  const info = runtime.data.session.get(sessionID)
  const row = runtime.sessions.state.sessions[sessionID]
  if (info?.parentID ?? row?.parentID) return false
  const projectID = info?.projectID ?? row?.projectID
  const project = projectID ? projectRef(runtime, projectID) : undefined
  return project?.vcs === "git" && runtime.rpc.can("prompt")
}

/**
 * The project's own checkout as the glossary names it (03 §14.1, 06 §9.1): `메인 폴더` in a project with a team on,
 * where the team main works, else `프로젝트 폴더`.
 */
export function rootLabelKey(runtime: ServerRuntime, projectID: string) {
  return runtime.team.teamsOfProject(projectID).length > 0
    ? ("own.worktree.home" as const)
    : ("own.worktree.local" as const)
}

/** Reactive: the project's root, VCS and startup script from createData's project list (`project.updated` keeps it). */
export function projectRef(runtime: ServerRuntime, projectID: string): ProjectRef | undefined {
  const info = runtime.data.project.get(projectID)
  const row = runtime.sessions.state.projects[projectID]
  const root = info?.canonical ?? row?.directory
  if (!root) return undefined
  return { id: projectID, root, vcs: info?.vcs, start: info?.commands?.start }
}

/** `GET /api/project` once per connection (createData dedups); the worktree UI needs `vcs` and `commands`. */
export function syncProjects(runtime: ServerRuntime) {
  if (runtime.connection.status() !== "connected") return
  void runtime.data.project.sync().catch(() => undefined)
}

export async function listWorktrees(runtime: ServerRuntime, projectID: string): Promise<WorktreeEntry[]> {
  return runtime.client().worktree.list({ projectID })
}

/** Creates a worktree from the project root at `base` (a branch or ref; HEAD when absent). The server then runs the
 * project's startup script in it before answering, so this can take a while. Returns the canonical new folder. */
export async function createWorktree(runtime: ServerRuntime, project: ProjectRef, base?: string) {
  const created = await runtime.client().worktree.create({ projectID: project.id, from: project.root, branch: base })
  return created.directory
}

/**
 * own.accounts `worktree.inspect` (06 §10.4 #5): nested repositories, the lock and the ignored files of a linked
 * worktree of `root`, read before the cleanup may run and again right before it. The server reads only folders in the
 * project's worktree table. A control-location read; rejects with `OwnRpcError` (also when the server has no own
 * plugin), and the dialog then fails closed.
 */
export async function inspectWorktree(runtime: ServerRuntime, project: ProjectRef, directory: string) {
  return runtime.rpc.call("worktree.inspect", { projectID: project.id, root: project.root, directory })
}

export async function removeWorktree(runtime: ServerRuntime, projectID: string, directory: string, force: boolean) {
  await runtime.client().worktree.remove({ projectID, directory, force })
}

/** Discovers worktrees made outside the app (`git worktree add`) and drops vanished ones. */
export async function refreshWorktrees(runtime: ServerRuntime, projectID: string) {
  await runtime.client().worktree.refresh({ projectID })
}

/** `POST /api/session/:id/move` — applied at the delivery boundary (`steer`: after the current step). */
export async function moveSession(
  runtime: ServerRuntime,
  sessionID: string,
  directory: string,
  delivery?: "steer" | "queue",
) {
  await runtime.client().session.move({ sessionID, directory, delivery })
}

export async function listBranches(runtime: ServerRuntime, root: string, search: string) {
  const response = await runtime
    .client()
    .vcs.branch.list({ location: { directory: root }, search: search || undefined, limit: 50 })
  return response.data
}

/** `PATCH /api/project/:id{commands:{start}}`; an empty script clears it. */
export async function saveStartScript(runtime: ServerRuntime, projectID: string, start: string) {
  await runtime.client().project.update({ projectID, commands: { start: start.trim() } })
}
