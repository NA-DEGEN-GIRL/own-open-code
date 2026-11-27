export * as SkillsetRegister from "./register.js"

import type { Registration } from "@opencode/plugin/promise/registration"
import type { OwnSkillset } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import { Location } from "../location.js"
import type { Module } from "../module.js"
import { SkillsetFold } from "./fold.js"
import { SkillsetStore } from "./store.js"

export interface Api extends Module.Lifecycle {
  /**
   * The first registration of the fold, made at the end of setup (after `Hooks.register`): core's built-in skills are
   * there by then; the skills of the config folders come with core's `post` plugins, which the registration made again
   * after this Location's `plugin.updated` follows.
   */
  register(): Promise<void>
}

/**
 * Folds the skill switches and scopes (03 §19.6.1, SG 2026-10-26) into this Location's skills, on this PC only (a
 * remote service's skills are its host's folders, `!deps.remote`).
 *
 * Core applies the config folders' skills in builtin plugins that activate after every configured plugin (`post`,
 * `ConfigCompatibilityPlugin` and `ConfigSkillPlugin` in `packages/core/src/plugin/internal.ts`, check-surface
 * `builtin-plugin-placement`), so a transform registered in setup never sees them; like `presets/agents.ts` and
 * own-harness's synced-skill drop (`src/skills.ts`), the fold is registered again after every local `plugin.updated`
 * so it stays last, and the previous registration is disposed. Registrations run one at a time.
 *
 * The switches are read before the first registration (core folds as soon as one is registered) and again after every
 * `skillset.changed` of the runtime broadcast, which reloads the skills (`ctx.skill.reload()`) when they changed and
 * hands the writer that work (`settle`), so the change is announced once this Location folded it. What
 * the live registrations' last folds removed answers `skillset.removed.query` for this Location's folder
 * (`skillset.view{directory}` in the control location), and a changed set is logged once (`skills_switched_off`).
 */
export function create(deps: Deps): Api {
  const log = deps.log.child("skillset")
  const hook = Hooks.guard(log)
  const store = SkillsetStore.file(deps)
  const active = deps.remote === undefined
  const state: {
    snapshot: SkillsetFold.Snapshot
    /** What each live registration's last fold removed, by its generation; this Location's answer is the union. */
    removed: Map<number, ReadonlyArray<OwnSkillset.Off>>
    folded: boolean
    logged: string
    current?: { readonly generation: number; readonly registration: Registration }
    generation: number
    read: number
    moving: Promise<void>
    stops: Array<() => void>
    stopped: boolean
  } = {
    snapshot: SkillsetFold.EMPTY,
    removed: new Map(),
    folded: false,
    logged: "",
    generation: 0,
    read: 0,
    moving: Promise.resolve(),
    stops: [],
    stopped: false,
  }

  const read = () =>
    store.read().then(
      (file): SkillsetFold.Snapshot => ({ switches: file.switches, scopes: file.scopes }),
      (error: unknown) => {
        log.warn("skill_switches_unreadable", { error })
        return SkillsetFold.EMPTY
      },
    )

  const removed = () => [...new Map([...state.removed.values()].flat().map((item) => [item.id, item])).values()]

  const record = (generation: number, off: ReadonlyArray<OwnSkillset.Off>) => {
    state.removed.set(generation, off)
    state.folded = true
    const ids = removed()
      .map((item) => item.id)
      .toSorted()
    if (ids.join("\n") === state.logged) return
    state.logged = ids.join("\n")
    log.info("skills_switched_off", { ids })
  }

  /** Registration work runs one at a time, in order; the answer settles when this work did. */
  const serial = (failure: string, work: () => Promise<void>) => {
    state.moving = state.moving.then(work).catch((error: unknown) => log.error(failure, { error }))
    return state.moving
  }

  /** Registers the fold again (now last) and drops the previous registration. */
  const relocate = async () => {
    if (state.stopped) return
    const previous = state.current
    const generation = ++state.generation
    const registration = await deps.ctx.skill.transform((editor) =>
      hook.sync("skill.transform:skillset", () =>
        record(generation, SkillsetFold.fold(editor, state.snapshot, deps.location)),
      ),
    )
    state.current = { generation, registration }
    if (previous === undefined) return
    await previous.registration.dispose()
    state.removed.delete(previous.generation)
  }

  const reread = async () => {
    const current = ++state.read
    const next = await read()
    if (current !== state.read || state.stopped) return
    if (JSON.stringify(next) === JSON.stringify(state.snapshot)) return
    state.snapshot = next
    if (deps.location.control || state.current === undefined) return
    await deps.ctx.skill.reload()
  }

  return {
    start: async () => {
      if (!active) return
      state.snapshot = await read()
      state.stops.push(
        deps.runtime.broadcast.on("skillset.changed", (change) => {
          const folded = serial("skills_reload_failed", () => reread())
          change.settle?.(folded)
        }),
        deps.runtime.broadcast.on("skillset.removed.query", (query) => {
          if (deps.location.control || !state.folded) return
          if (Location.same(query.directory, deps.location.directory)) query.reply(removed())
        }),
      )
    },
    register: async () => {
      if (!active) return
      await serial("skill_transform_register_failed", relocate)
    },
    onEvent: (event, meta) => {
      if (!active || !meta.local || event.type !== "plugin.updated") return
      void serial("skill_transform_register_failed", relocate)
    },
    stop: async () => {
      state.stopped = true
      for (const stop of state.stops.splice(0)) stop()
      await state.moving
      await state.current?.registration
        .dispose()
        .catch((error: unknown) => log.debug("skill_transform_dispose_failed", { error }))
      state.current = undefined
    },
  }
}
