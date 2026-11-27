// Session delete, project archive and project removal (03 §19.11a). No UI: the dialogs (manage-dialog.tsx,
// project-dialog.tsx), the project `⋯` and the archive's selection call these.
//
// - Delete is upstream `DELETE /api/session/:sessionID` (`session.remove`): core interrupts a running session and
//   waits for it to go idle, then removes it with its subagent sessions (own/upstream-surface.json
//   `session-remove-interrupts`). The gateway allows it with `admin` only, so screens offer it where
//   `runtime.rpc.can("admin")`. A session that is already gone counts as deleted.
// - A project has no hide or remove API upstream (`project.update` sets the folder, name, icon and commands), and the
//   sidebar lists a project only while it has listed root sessions. So `프로젝트 보관` archives every root session of
//   the project with the project mark (flags.ts `setProject`) and `프로젝트 목록에서 삭제` deletes them all: both are
//   in session metadata or core itself, so every device (PC, phone, other windows) sees the same list. Nothing on disk
//   is touched. A new session in that project brings the project back.
// - A project with a team on is neither archived nor removed (06 TI-5: team conversations are never deleted, and an
//   archived team main or owner would vanish from the team view while it works); a team's current main, owner or
//   peer is never deleted on its own either. Earlier owners and mains (`지난 대화`) are ordinary conversations.
// - own.import's hidden summary helpers (09 §6) are never touched: removing them is own.import's job.
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import type { ServerRuntime } from "@/data"
import { isImportHelper } from "@/data/import-rpc"
import { flagsOf, type OwnFlagStore } from "./flags"

const PAGE = 200
/** Deletes in flight at once: core interrupts and waits per session, so keep the server's load small. */
const DELETE_CONCURRENCY = 2

/** Every root session of a project on the server, archived ones included; never own.import's hidden helpers. */
export async function projectSessions(client: OpenCodeClient, projectID: string) {
  const all: SessionInfo[] = []
  let cursor: string | undefined
  do {
    const page = await client.session.list({ project: projectID, parentID: null, limit: PAGE, order: "desc", cursor })
    all.push(...page.data)
    cursor = page.data.length ? (page.cursor.next ?? undefined) : undefined
  } while (cursor)
  return all.filter((info) => !info.parentID && !isImportHelper(info.metadata))
}

export interface DeleteResult {
  readonly deleted: readonly string[]
  readonly failed: readonly { readonly id: string; readonly reason: string }[]
  /** `archivedOnly`: sessions that are no longer archived on the server, left alone. */
  readonly skipped: readonly string[]
}

/**
 * Deletes root sessions (and with them their subagents), a few at a time; `progress` gets the count settled. With
 * `archivedOnly` (the archive's selection and `보관함 비우기`) each session is read first and kept unless the server
 * still has it archived: this device's archive list is a cache, and another device may have unarchived one meanwhile.
 */
export async function deleteSessions(
  client: OpenCodeClient,
  ids: readonly string[],
  options: { readonly progress?: (settled: number) => void; readonly archivedOnly?: boolean } = {},
): Promise<DeleteResult> {
  const queue = [...ids]
  const deleted: string[] = []
  const failed: { id: string; reason: string }[] = []
  const skipped: string[] = []
  const still = async (sessionID: string) => {
    if (!options.archivedOnly) return true
    const info = await client.session.get({ sessionID })
    return flagsOf(info.metadata).archived !== undefined
  }
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const sessionID = id
      await still(sessionID)
        .then((archived) => {
          if (!archived) return void skipped.push(sessionID)
          return client.session.remove({ sessionID }).then(() => void deleted.push(sessionID))
        })
        .catch(
          (error: unknown) =>
            void (notFound(error) ? deleted.push(sessionID) : failed.push({ id: sessionID, reason: reasonOf(error) })),
        )
      options.progress?.(deleted.length + failed.length + skipped.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, ids.length) }, worker))
  return { deleted, failed, skipped }
}

/**
 * `프로젝트 보관` (`on`): the project's root sessions that are not archived yet, archived with the project mark.
 * `프로젝트 복원`: the sessions that carry the mark, back in the list. Sessions archived on their own stay archived.
 */
export async function archiveProject(client: OpenCodeClient, flags: OwnFlagStore, projectID: string, on: boolean) {
  const infos = (await projectSessions(client, projectID)).filter((info) => {
    const current = flagsOf(info.metadata)
    return on ? current.archived === undefined : current.project !== undefined
  })
  const result = await flags.setProject(infos, on)
  return { total: infos.length, failed: result.failed }
}

export type ProjectTeam =
  | { readonly kind: "off" }
  | { readonly kind: "on"; readonly teamID: string }
  /** own.team has not answered (or failed): nothing may be archived or removed yet. */
  | { readonly kind: "unknown" }

/** Whether a team is on for the project (06 §3): own.team's registry, read by `team.ensure()`. */
export function projectTeam(runtime: Pick<ServerRuntime, "team">, projectID: string, git: boolean): ProjectTeam {
  const team = runtime.team
  const load = team.state.load
  if (load === "unmanaged" || load === "missing") return { kind: "off" }
  if (load !== "ready") return git ? { kind: "unknown" } : { kind: "off" }
  const on =
    team.teamsOfProject(projectID)[0]?.team.id ??
    team.state.list.find((item) => item.projectID === projectID && item.state === "on")?.id
  return on ? { kind: "on", teamID: on } : { kind: "off" }
}

/** A team's current main, owner or peer (registry, or its metadata hint before the registry answered). */
export function teamHeld(runtime: Pick<ServerRuntime, "team">, sessionID: string) {
  const place = runtime.team.placeOf(sessionID)
  return place !== undefined && !place.previous
}

/** `session.remove` of a session that is gone already: the declared 404 body's tag. */
function notFound(error: unknown) {
  return error instanceof Error && error.name === "SessionNotFoundError"
}

function reasonOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
