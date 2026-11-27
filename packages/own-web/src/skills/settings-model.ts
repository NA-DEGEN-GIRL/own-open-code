// 설정 > 스킬's lists (SM 2026-10-24, global first SG 2026-10-26), pure so they are unit-tested as tables: where each
// skill comes from in the page's groups (프로젝트 / 가져옴 / 전역 / Claude Code 개인 / 기본 제공), which ones are
// own-import's copies that `지우기` may remove, and the switches (own.accounts `skillset.*`): the `모든 프로젝트` rows
// with their global switch and the projects that differ, and one project's groups (`이 프로젝트의 예외`, `이 프로젝트의
// 스킬`, `모든 프로젝트 스킬`, `다른 프로젝트에서만 쓰는 스킬`, switches of skills that are gone). The fold's rules mirror
// own.accounts' `SkillsetFold` (global switch, then the folders that hold a project, shallowest first). No Solid, no DOM.
import type { SkillInfo } from "@opencode/client"
import type { OwnSkillset } from "@own/protocol"
import { baseName, samePath } from "@/projects/path"
import { switchesDiffering, switchInherited } from "@/projects/switches"
import { isInside } from "@/worktree/model"
import { skillSource, skillViews, type SkillView } from "./model"

export type SkillGroup = "project" | "imported" | "global" | "claude" | "own" | "builtin"

export const GROUPS: ReadonlyArray<SkillGroup> = ["project", "imported", "global", "claude", "own", "builtin"]

/**
 * Skills that ship with the app and have no folder: core's (`skill://<id>/SKILL.md` since v2.2.6, `/builtin/` before)
 * and own's (`/builtin/own/`, 02 §9.6 `imagegen`, `own 제공`). Neither takes a scope or opens a folder.
 */
export function builtIn(group: SkillGroup) {
  return group === "builtin" || group === "own"
}

/** What the page needs of a skill: core's list entry or the catalog's (never the content). */
export type SkillLike = Pick<SkillInfo, "id" | "name" | "description" | "autoinvoke" | "path">

export type Switch = OwnSkillset.Switch
export type Scope = OwnSkillset.Scope
export type Off = OwnSkillset.Off
export type SkillsetView = OwnSkillset.View

export interface SkillRow extends SkillView {
  readonly group: SkillGroup
  /** The skill's folder (where its SKILL.md is). */
  readonly folder: string
  /**
   * What a scope of it names (SG-19): its folder, or its own file for a flat `<id>.md` skill (core reads every `*.md`
   * of a skills folder as a skill, so their folder is shared).
   */
  readonly scopePath: string
  /** own-import's copy: the id `skills.remove` takes. */
  readonly imported?: string
}

export function skillRows(
  skills: ReadonlyArray<SkillLike>,
  input: {
    readonly directory: string | undefined
    /** own's skills folder (`skills.list` `directory`), when known. */
    readonly skillsDir?: string | null
    /** own-import's copies (`skills.list` `imports`). */
    readonly imports: ReadonlyArray<{ readonly id: string }>
  },
): SkillRow[] {
  const rows = skillViews(skills, input.directory).map((view): SkillRow => {
    const folder = parent(view.path)
    const copy = input.skillsDir
      ? input.imports.find((item) => same(folder, `${input.skillsDir}/${item.id}`))
      : undefined
    const group = groupOf(view.path, input.directory, copy !== undefined)
    const scopePath = /[\\/]SKILL\.md$/.test(view.path) ? folder : view.path
    return { ...view, group, folder, scopePath, ...(copy ? { imported: copy.id } : {}) }
  })
  return GROUPS.flatMap((group) => rows.filter((row) => row.group === group))
}

function groupOf(path: string, directory: string | undefined, copy: boolean): SkillGroup {
  if (skillSource(path, directory) === "project") return "project"
  if (copy) return "imported"
  const slashed = normalize(path)
  if (slashed.startsWith("/builtin/own/")) return "own"
  if (slashed.startsWith("/builtin/") || slashed.startsWith("skill://")) return "builtin"
  if (/\/\.claude\/skills\//.test(slashed)) return "claude"
  return "global"
}

export function grouped(rows: ReadonlyArray<SkillRow>) {
  return GROUPS.map((group) => ({ group, rows: rows.filter((row) => row.group === group) })).filter(
    (entry) => entry.rows.length > 0,
  )
}

/** The folder of a skill file (where its SKILL.md is). */
export function parent(path: string) {
  const slashed = path.replaceAll("\\", "/")
  const index = slashed.lastIndexOf("/")
  return index > 0 ? path.slice(0, index) : path
}

function normalize(path: string) {
  const slashed = path.replaceAll("\\", "/")
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}

function same(a: string, b: string) {
  return normalize(a).replace(/\/+$/, "") === normalize(b).replace(/\/+$/, "")
}

// ---------------------------------------------------------------------------------------------------------------
// Switches and scopes (SG)

/** Whether `id` is on at a place without its own switch there (the global place inherits on). */
export function inheritedAt(switches: ReadonlyArray<Switch>, id: string, directory: string | undefined) {
  return switchInherited(
    switches.filter((item) => item.id === id),
    directory,
  )
}

/** Whether the global switch turned `id` off. */
export function globalOff(switches: ReadonlyArray<Switch>, id: string) {
  return switches.some((item) => item.id === id && item.directory === undefined && !item.enabled)
}

/** The projects whose switch of `id` differs from what they inherit: off there, or on there only. */
export function exceptions(switches: ReadonlyArray<Switch>, id: string) {
  const differ = switchesDiffering(switches.filter((item) => item.id === id))
  return {
    off: differ.filter((item) => !item.enabled).map((item) => item.directory),
    only: differ.filter((item) => item.enabled).map((item) => item.directory),
  }
}

/** A line of projects: their base names, the first `limit`, and how many more. */
export function projectNames(directories: ReadonlyArray<string>, limit = 3) {
  return {
    shown: directories.slice(0, limit).map((directory) => ({ directory, name: baseName(directory) })),
    more: Math.max(0, directories.length - limit),
  }
}

/**
 * The scope that keeps the skill of file `path` (`이 프로젝트만`), as own.accounts' fold judges it (SG-19): the deepest
 * one whose folder is that file (a flat skill) or holds it (its folder or one above it: nested skills go with it).
 */
export function scopeOf(scopes: ReadonlyArray<Scope>, path: string) {
  return scopes
    .filter((scope) => isInside(scope.folder, path))
    .toSorted((a, b) => b.folder.length - a.folder.length)
    .at(0)
}

/**
 * Scopes that hold no skill of the catalog (SG-21): their folder was deleted by hand, or the skill moved. A later copy
 * of that name would be kept in that project, so the page offers to clear them.
 */
export function orphanScopes(view: Pick<SkillsetView, "catalog" | "scopes">) {
  return view.scopes.filter((scope) => !view.catalog.some((skill) => isInside(scope.folder, skill.path)))
}

/**
 * `쓰는 곳` of a skill folder: every project, the page's project (`이 프로젝트만 (name)`), and the project its scope
 * names when that is another one (`{name} 프로젝트만`).
 */
export type ScopeChoice =
  | { readonly type: "all" }
  | { readonly type: "here"; readonly directory: string }
  | { readonly type: "folder"; readonly directory: string }

export function scopeChoices(scope: Scope | undefined, page: string | undefined): ScopeChoice[] {
  return [
    { type: "all" },
    ...(page === undefined ? [] : [{ type: "here" as const, directory: page }]),
    ...(scope === undefined || (page !== undefined && samePath(scope.directory, page))
      ? []
      : [{ type: "folder" as const, directory: scope.directory }]),
  ]
}

/** The choice the select shows for a scope. */
export function chosenScope(choices: ReadonlyArray<ScopeChoice>, scope: Scope | undefined) {
  if (scope === undefined) return 0
  return Math.max(
    0,
    choices.findIndex((choice) => choice.type !== "all" && samePath(choice.directory, scope.directory)),
  )
}

/** Who may change a row's `쓰는 곳`: not core's built-ins, not a project's own skills. */
export function scopable(row: Pick<SkillRow, "group">) {
  return !builtIn(row.group) && row.group !== "project"
}

/** A `모든 프로젝트` row: a catalog skill used everywhere (no scope), its global switch and its exceptions. */
export interface GlobalRow {
  readonly row: SkillRow
  readonly off: boolean
  readonly exceptions: ReturnType<typeof exceptions>
}

/**
 * The `모든 프로젝트` section: the catalog's skills in their groups, without the ones a scope keeps in one project (they
 * are listed under that project), and the global switches of ids no skill has (`지금은 없는 스킬이에요`).
 */
export function globalSection(
  view: Pick<SkillsetView, "catalog" | "switches" | "scopes">,
  input: { readonly skillsDir?: string | null; readonly imports: ReadonlyArray<{ readonly id: string }> },
) {
  const rows = skillRows(view.catalog, { directory: undefined, ...input })
  const known = new Set(view.catalog.map((skill) => skill.id))
  return {
    rows: rows
      .filter((row) => scopeOf(view.scopes, row.path) === undefined)
      .map(
        (row): GlobalRow => ({
          row,
          off: globalOff(view.switches, row.id),
          exceptions: exceptions(view.switches, row.id),
        }),
      ),
    gone: [
      ...new Set(
        view.switches.filter((item) => item.directory === undefined && !known.has(item.id)).map((item) => item.id),
      ),
    ],
    orphans: orphanScopes(view),
  }
}

/** A skill as one project sees it: on or off there and why, with its scope when it has one. */
export interface ProjectSkill {
  readonly row: SkillRow
  readonly on: boolean
  readonly by?: OwnSkillset.OffBy
  readonly scope?: Scope
}

/**
 * One project's groups. `listed`: what core loads there (`GET /api/skill`), `view.off`: what own.accounts' fold took
 * away there. `exceptions`: the catalog's skills whose switch at exactly this folder differs from what it inherits;
 * `own`: the project's own folder's skills and the catalog's skills a scope keeps here; `all`: the catalog's skills
 * used everywhere; `elsewhere`: the catalog's skills a scope keeps in another project; `gone`: switches at this folder
 * of ids no skill has.
 */
export function projectSection(
  view: SkillsetView,
  input: {
    readonly directory: string
    readonly listed: ReadonlyArray<SkillLike>
    readonly skillsDir?: string | null
    readonly imports: ReadonlyArray<{ readonly id: string }>
  },
) {
  const options = { skillsDir: input.skillsDir, imports: input.imports }
  const off = new Map((view.off ?? []).map((item) => [item.id, item]))
  const catalog = skillRows(view.catalog, { directory: undefined, ...options })
  const stateOf = (row: SkillRow): Pick<ProjectSkill, "on" | "by"> => {
    const removed = off.get(row.id)
    return removed ? { on: false, by: removed.by } : { on: true }
  }
  // The project's own folder: what core loads there and what the fold took away there, by path.
  const removedHere = (view.off ?? []).flatMap((item) =>
    item.path === undefined ? [] : [{ id: item.id, name: item.name ?? item.id, path: item.path, ...pick(item) }],
  )
  const local = skillRows([...input.listed, ...removedHere], { directory: input.directory, ...options }).filter(
    (row) => row.group === "project",
  )
  const scoped = catalog.flatMap((row) => {
    const scope = scopeOf(view.scopes, row.path)
    return scope === undefined ? [] : [{ row, scope }]
  })
  const unscoped = catalog.filter((row) => scopeOf(view.scopes, row.path) === undefined)
  const here = view.switches.filter(
    (item) =>
      item.directory !== undefined &&
      samePath(item.directory, input.directory) &&
      item.enabled !== inheritedAt(view.switches, item.id, input.directory),
  )
  const known = new Set([...catalog, ...local].map((row) => row.id))
  return {
    exceptions: here.flatMap((item) => {
      const row = unscoped.find((candidate) => candidate.id === item.id)
      return row ? [{ row, enabled: item.enabled }] : []
    }),
    own: [
      ...local.map((row): ProjectSkill => ({ row, ...stateOf(row) })),
      ...scoped
        .filter((item) => isInside(item.scope.directory, input.directory))
        .map((item): ProjectSkill => ({ row: item.row, ...stateOf(item.row), scope: item.scope })),
    ],
    all: unscoped.map((row): ProjectSkill => ({ row, ...stateOf(row) })),
    elsewhere: scoped.filter((item) => !isInside(item.scope.directory, input.directory)),
    gone: [
      ...new Set(
        view.switches
          .filter(
            (item) => item.directory !== undefined && samePath(item.directory, input.directory) && !known.has(item.id),
          )
          .map((item) => item.id),
      ),
    ],
  }
}

function pick(item: Off) {
  return {
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.autoinvoke === undefined ? {} : { autoinvoke: item.autoinvoke }),
  }
}
