// Skills calls (03 §19.6): the list is the data layer's per-location catalog (`GET /api/skill`, refreshed on
// `skill.updated`), `바로 실행` is `POST /api/experimental/session/:id/skill` (core `Session.skill`: appends the skill
// message at the end of the history, so the cached prefix stays, and resumes the session).
import type { ServerRuntime } from "@/data"

/**
 * The folder's skills, read when unknown or stale (a skill switch marked every list read so far, SG-18; a fresh list
 * costs no request). When the read fails (disconnected, or refused) the list read before is the answer, stale or not,
 * as before SG; it throws only when there is none.
 */
export async function loadSkills(runtime: ServerRuntime, directory: string) {
  const location = { directory }
  const failed = await runtime.data.location.skill.sync(location).then(
    () => undefined,
    (error: unknown) => ({ error }),
  )
  const known = runtime.data.location.skill.list(location)
  if (failed && known === undefined) throw failed.error
  return known ?? []
}

/**
 * Reads the folder's skills again: own.accounts folded a skill switch there (SG). core announces a plugin's reload
 * without its Location, so the data layer does not read the list again by itself.
 */
export function reloadSkills(runtime: ServerRuntime, directory: string) {
  const location = { directory }
  runtime.data.location.skill.invalidate(location)
  return runtime.data.location.skill.sync(location).catch(() => undefined)
}

/** Appends the skill to the session and starts the agent. Throws when the server refuses (unknown skill, offline). */
export async function runSkill(runtime: ServerRuntime, sessionID: string, skillID: string) {
  await runtime.client().session.skill({ sessionID, id: skillID })
}
