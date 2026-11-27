export * as SkillsetFold from "./fold.js"

import type { SkillEditor } from "@opencode/plugin/promise/skill"
import type { OwnSkillset } from "@own/protocol"
import { Location } from "../location.js"

/**
 * own's skill fold (03 §19.6.1, SG 2026-10-26), pure: which of a Location's skills its switches and scopes turn off.
 * Every skill starts on in every project; a scope keeps the skills of one folder (or one flat skill file) in one
 * project (and the folders inside it), then the global switch of its id and the project switches of the folders that
 * hold the Location, shallowest first, decide. The control Location runs no conversation and keeps every skill (it answers the catalog). No I/O: the
 * snapshot is read before ({@link SkillsetRegister}).
 */

export interface Snapshot {
  readonly switches: ReadonlyArray<OwnSkillset.Switch>
  readonly scopes: ReadonlyArray<OwnSkillset.Scope>
}

export const EMPTY: Snapshot = { switches: [], scopes: [] }

/** What core gives of a skill (`Skill.Info` without its content). */
export interface Skill {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly path: string
  readonly autoinvoke?: boolean
}

/** Why `skill` is off in `directory`, or `undefined` when it is on there. */
export function judge(
  skill: Pick<Skill, "id" | "path">,
  snapshot: Snapshot,
  directory: string,
): OwnSkillset.OffBy | undefined {
  const scope = scopeOf(skill.path, snapshot.scopes)
  if (scope && !Location.within(directory, scope.directory)) return "scope"
  return switched(skill.id, snapshot, directory)
}

/**
 * The scope that keeps the skill of file `file` (SG-19): the deepest one whose `folder` is that file (a flat `<id>.md`
 * skill, whose folder other flat skills share) or holds it (its `SKILL.md`'s folder or one above it: core reads every
 * `**\/SKILL.md` below a skills folder, so the skills nested in a scoped folder go with it).
 */
export function scopeOf(file: string, scopes: ReadonlyArray<OwnSkillset.Scope>) {
  return scopes
    .filter((item) => Location.within(file, item.folder))
    .toSorted((a, b) => b.folder.length - a.folder.length)
    .at(0)
}

/** Whether the switches turn skill `id` off in `directory` (scopes aside): the last switch that reaches it decides. */
export function switched(id: string, snapshot: Snapshot, directory: string): OwnSkillset.OffBy | undefined {
  const deciding = reaching(snapshot.switches, id, directory).at(-1)
  if (deciding === undefined || deciding.enabled) return undefined
  return deciding.directory === undefined ? "global" : "project"
}

/**
 * Removes every skill {@link judge} turns off and answers them with what core had of them (never their content). The
 * control Location removes nothing.
 */
export function fold(
  editor: SkillEditor,
  snapshot: Snapshot,
  location: { readonly directory: string; readonly control: boolean },
): OwnSkillset.Off[] {
  if (location.control) return []
  return editor.list().flatMap((item) => {
    // The editor hands out deep-mutable records whose branded ids the type system no longer sees as strings.
    const skill: Skill = {
      id: String(item.id),
      name: String(item.name),
      description: item.description,
      path: String(item.path),
      autoinvoke: item.autoinvoke,
    }
    const by = judge(skill, snapshot, location.directory)
    if (by === undefined) return []
    editor.remove(skill.id)
    return [off(skill, by)]
  })
}

/**
 * Whether skill `id` is on in `directory` without a switch at exactly that place: the global switch, then the
 * switches of the folders that hold it (not the folder itself), shallowest first; on when none says otherwise. The
 * global place (`undefined`) inherits on. Scopes are not switches and are not counted.
 */
export function inherited(id: string, directory: string | undefined, snapshot: Snapshot) {
  if (directory === undefined) return true
  return (
    reaching(snapshot.switches, id, directory)
      .filter((item) => item.directory === undefined || !Location.same(item.directory, directory))
      .at(-1)?.enabled ?? true
  )
}

/** A skill's answer row of {@link fold}: what core had of it (never its content). */
export function off(skill: Skill, by: OwnSkillset.OffBy): OwnSkillset.Off {
  return {
    id: skill.id,
    by,
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    path: skill.path,
    ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
  }
}

/** The switches of `id` that reach `directory`, in the order they apply: the global one, then shallow to deep. */
function reaching(switches: ReadonlyArray<OwnSkillset.Switch>, id: string, directory: string) {
  return switches
    .filter((item) => item.id === id && (item.directory === undefined || Location.within(directory, item.directory)))
    .toSorted((a, b) => depth(a) - depth(b))
}

function depth(item: Pick<OwnSkillset.Switch, "directory">) {
  return item.directory === undefined ? -1 : item.directory.length
}
