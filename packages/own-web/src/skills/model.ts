// Skills list decisions (03 §19.6), pure so they are unit-tested as tables: where a skill comes from (the project
// folder, the user's global skills, or core's built-in ones), the search order, and whether `바로 실행`
// (`session.skill`) is possible.
import type { SkillInfo } from "@opencode/client"

/**
 * `builtin`: one of core's own skills (in memory as `skill://<id>/SKILL.md` since upstream v2.2.6, a `/builtin/` path
 * before), `기본 제공` here as in 설정 > 스킬 (SK2).
 */
export type SkillSource = "project" | "global" | "builtin"

const ORDER: Readonly<Record<SkillSource, number>> = { project: 0, global: 1, builtin: 2 }

export interface SkillView {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** The agent may load it by itself (`autoinvoke`). */
  readonly auto: boolean
  readonly source: SkillSource
  readonly path: string
}

/** Rows shown at once; more is reached by searching (skill lists are tens, rarely hundreds). */
export const VISIBLE_SKILLS = 200

export function skillViews(
  skills: ReadonlyArray<Pick<SkillInfo, "id" | "name" | "description" | "autoinvoke" | "path">>,
  directory: string | undefined,
): SkillView[] {
  return skills
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description?.replace(/\s+/g, " ").trim() || undefined,
      auto: skill.autoinvoke === true,
      source: skillSource(skill.path, directory),
      path: skill.path,
    }))
    .toSorted((a, b) => ORDER[a.source] - ORDER[b.source] || a.name.localeCompare(b.name))
}

/** A skill file inside the session folder is the project's; core's own are built in; everything else is global. */
export function skillSource(path: string, directory: string | undefined): SkillSource {
  const file = normalize(path)
  if (file.startsWith("/builtin/") || file.startsWith("skill://")) return "builtin"
  if (!directory) return "global"
  const folder = normalize(directory).replace(/\/+$/, "")
  return file === folder || file.startsWith(`${folder}/`) ? "project" : "global"
}

function normalize(path: string) {
  // Windows paths compare without case and with either separator.
  const slashed = path.replaceAll("\\", "/")
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}

/**
 * Search: id or name equal, then prefix, then a word prefix, then contained anywhere, then the description. Ties
 * keep the list order (project first, then by name). An empty query keeps everything.
 */
export function filterSkills(skills: readonly SkillView[], query: string): SkillView[] {
  const wanted = query.trim().replace(/^@/, "").toLowerCase()
  if (!wanted) return [...skills]
  return skills
    .map((skill, index) => ({ skill, index, score: score(skill, wanted) }))
    .filter((item) => item.score !== undefined)
    .toSorted((a, b) => a.score! - b.score! || a.index - b.index)
    .map((item) => item.skill)
}

function score(skill: SkillView, wanted: string) {
  const id = skill.id.toLowerCase()
  const name = skill.name.toLowerCase()
  if (id === wanted || name === wanted) return 0
  if (id.startsWith(wanted) || name.startsWith(wanted)) return 1
  if ([...id.split(/[-_./\s]+/), ...name.split(/[-_./\s]+/)].some((word) => word.startsWith(wanted))) return 2
  if (id.includes(wanted) || name.includes(wanted)) return 3
  if (skill.description?.toLowerCase().includes(wanted)) return 4
  return undefined
}

export type RunBlock = "noSession" | "busy" | "child" | "scope"

/**
 * `바로 실행` appends the skill and resumes the session (`POST /api/experimental/session/:id/skill`). It needs an open
 * top-level session that is idle: core publishes the skill message directly (not through the inbox), so during a
 * turn the chip (sent with the next message) is the safe way.
 */
export function runBlock(input: {
  readonly sessionID: string | undefined
  readonly busy: boolean
  readonly child: boolean
  readonly canPrompt: boolean
}): RunBlock | undefined {
  if (!input.sessionID) return "noSession"
  if (input.child) return "child"
  if (!input.canPrompt) return "scope"
  if (input.busy) return "busy"
  return undefined
}
