export * as SkillsetService from "./service.js"

import path from "node:path"
import { OwnSkillset } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Location } from "../location.js"
import { SkillsetFold } from "./fold.js"
import { SkillsetStore } from "./store.js"

/**
 * The `skillset.*` methods of own.accounts (03 §19.6.1, SG 2026-10-26) on the control Location's instance. The catalog
 * is the control Location's skills (every skill a project gets before switches: own's skills folder, the global and
 * Claude Code folders, core's built-ins; the control Location folds nothing away). What is off in a project comes from
 * that project's own Location when it is open in this process (`skillset.removed.query`), else it is judged over the
 * catalog with the switches of ids the catalog does not have added by id. A change writes the file once, tells every
 * Location (`skillset.changed` on the runtime broadcast), waits until the open ones folded it, then tells open pages
 * (the `skillset.changed` event) and answers. Logs count, never name a folder.
 */

/** How long a change waits for the open Locations to fold it before it is announced anyway. */
export const SETTLE_MS = 5_000

export type Failure = { readonly message: string; readonly field: "directory" | "folder" | "changes" | "scopes" }
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure }

export function create(deps: Deps) {
  const store = SkillsetStore.file(deps)
  const log = deps.log.child("skillset")

  const fail = (field: Failure["field"], message: string): Answer<never> => ({ ok: false, error: { field, message } })

  async function view(input: OwnSkillset.ViewInput = {}): Promise<OwnSkillset.View> {
    const [file, listed] = await Promise.all([store.read(), deps.ctx.skill.list()])
    const catalog = listed.data.map((skill) => entry(skill))
    const records = { switches: file.switches, scopes: file.scopes }
    const directory = input.directory
    if (directory === undefined || !path.isAbsolute(directory)) return { catalog, ...records }
    return { catalog, ...records, off: offIn(directory, catalog, records) }
  }

  /** What is off in `directory`: its own Location's last fold, or judged over the catalog. */
  function offIn(directory: string, catalog: ReadonlyArray<OwnSkillset.Entry>, snapshot: SkillsetFold.Snapshot) {
    const replies: OwnSkillset.Off[] = []
    const answered = { any: false }
    deps.runtime.broadcast.emit("skillset.removed.query", {
      directory,
      reply: (removed) => {
        answered.any = true
        replies.push(...removed)
      },
    })
    if (answered.any) return unique(replies)
    const judged = catalog.flatMap((skill) => {
      const by = SkillsetFold.judge(skill, snapshot, directory)
      return by === undefined ? [] : [SkillsetFold.off(skill, by)]
    })
    // A project's own skills are not in the catalog: their switches are answered by id.
    const known = new Set(catalog.map((skill) => skill.id))
    const unknown = [
      ...new Set(
        snapshot.switches
          .filter(
            (item) => item.directory !== undefined && !known.has(item.id) && Location.within(directory, item.directory),
          )
          .map((item) => item.id),
      ),
    ].flatMap((id) => {
      const by = SkillsetFold.switched(id, snapshot, directory)
      return by === undefined ? [] : [{ id, by }]
    })
    return [...judged, ...unknown]
  }

  async function change(input: OwnSkillset.SwitchInput): Promise<Answer<OwnSkillset.View>> {
    const scopes = input.scopes ?? []
    if (input.changes.length + scopes.length === 0) return fail("changes", "nothing to change")
    if (input.changes.some((item) => item.directory !== undefined && !path.isAbsolute(item.directory)))
      return fail("directory", "a project folder must be absolute")
    if (scopes.some((item) => !path.isAbsolute(item.folder))) return fail("folder", "a skill folder must be absolute")
    if (scopes.some((item) => item.directory !== null && !path.isAbsolute(item.directory)))
      return fail("directory", "a project folder must be absolute")
    const over: { field?: "changes" | "scopes" } = {}
    await store.update((current) => {
      // The scopes first: a skill imported for one project gets its scope before anything else of the change.
      const nextScopes = scopes.reduce<ReadonlyArray<OwnSkillset.Scope>>(
        (list, item) => [
          ...list.filter((scope) => !Location.same(scope.folder, item.folder)),
          ...(item.directory === null ? [] : [{ folder: item.folder, directory: item.directory }]),
        ],
        current.scopes,
      )
      const switches = input.changes.reduce<ReadonlyArray<OwnSkillset.Switch>>(apply, current.switches)
      if (switches.length > OwnSkillset.MAX_SWITCHES) over.field = "changes"
      if (nextScopes.length > OwnSkillset.MAX_SCOPES) over.field = "scopes"
      if (over.field) return undefined
      return { ...current, switches: [...switches], scopes: [...nextScopes] }
    })
    if (over.field) return fail(over.field, "more switches or scopes than are kept")
    log.info("skills_switch_saved", { changes: input.changes.length, scopes: scopes.length })
    await settled()
    void deps.emitter.global("skillset.changed", {})
    return { ok: true, value: await view() }
  }

  /**
   * Tells every Location and waits (at most {@link SETTLE_MS}) until each open one folded the change: core announces a
   * plugin's reload without its Location, so a page reads a project's skills again on `skillset.changed` or this answer.
   */
  async function settled() {
    const folds: Promise<unknown>[] = []
    deps.runtime.broadcast.emit("skillset.changed", { settle: (folded) => folds.push(folded) })
    const timer: { cancel?: () => void } = {}
    const late = new Promise<void>((resolve) => {
      timer.cancel = deps.clock.schedule(SETTLE_MS, resolve)
    })
    await Promise.race([Promise.allSettled(folds), late])
    timer.cancel?.()
  }

  return { view, change }
}

export type Service = ReturnType<typeof create>

/**
 * One change on the switches: the switch at exactly its place is replaced, or deleted (`null`). A value equal to what
 * the place inherits without it is a deletion (so a global `on` is never stored): a stale `on` would hold a later
 * global `off` back in that project.
 */
function apply(switches: ReadonlyArray<OwnSkillset.Switch>, change: OwnSkillset.Change) {
  const rest = switches.filter((item) => !(item.id === change.id && samePlace(item.directory, change.directory)))
  const enabled = change.enabled
  if (enabled === null) return rest
  if (SkillsetFold.inherited(change.id, change.directory, { switches: rest, scopes: [] }) === enabled) return rest
  return [
    ...rest,
    { id: change.id, ...(change.directory === undefined ? {} : { directory: change.directory }), enabled },
  ]
}

function samePlace(a: string | undefined, b: string | undefined) {
  if (a === undefined || b === undefined) return a === b
  return Location.same(a, b)
}

/** A catalog row: what core gives of a skill, never its content. */
function entry(skill: SkillsetFold.Skill): OwnSkillset.Entry {
  return {
    id: skill.id,
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    path: skill.path,
    ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
  }
}

/** One row per skill id (two Locations of one folder both answering). */
function unique(rows: ReadonlyArray<OwnSkillset.Off>) {
  return [...new Map(rows.map((row) => [row.id, row])).values()]
}
