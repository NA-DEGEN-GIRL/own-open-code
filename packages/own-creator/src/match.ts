export * as Match from "./match.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import type { Creator } from "@own/protocol/creator"
import { harnessOf } from "@own/protocol/rpc-harness-routing"
import { Effect } from "effect"
import { Safety } from "./safety.js"
import type { CreatorStore } from "./store.js"

/** What an item's `when` is matched against: the session's harness, agent, model and project folder. */
export interface Facts {
  readonly harness: string
  readonly agent: string
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly directory: string
}

/** A session's facts, or undefined when it is gone. */
export function facts(ctx: Pick<Context, "session" | "location">, sessionID: Session.ID, agent?: string) {
  return ctx.session.get({ sessionID }).pipe(
    Effect.map(
      (info): Facts => ({
        harness: harnessOf(info.metadata as Readonly<Record<string, unknown>> | undefined),
        agent: agent ?? info.agent ?? "build",
        ...(info.model === undefined ? {} : { model: { providerID: info.model.providerID, id: info.model.id } }),
        directory: info.location.directory,
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  )
}

/** Every list `when` gives matches `facts`. */
export function when(condition: Creator.When | undefined, facts: Facts) {
  if (condition === undefined) return true
  if (condition.harness !== undefined && !condition.harness.some((harness) => harness === facts.harness)) return false
  if (condition.agent !== undefined && !condition.agent.some((glob) => wildcard(glob, facts.agent))) return false
  if (condition.model !== undefined) {
    const model = facts.model
    if (model === undefined) return false
    if (!condition.model.some((glob) => wildcard(glob, `${model.providerID}/${model.id}`) || wildcard(glob, model.id)))
      return false
  }
  if (condition.project !== undefined && !condition.project.some((folder) => Safety.inside(facts.directory, folder)))
    return false
  return true
}

/** `when` without its session parts: what a Location-wide registration (a tool, an agent) can decide. */
export function where(condition: Creator.When | undefined, directory: string) {
  if (condition?.project === undefined) return true
  return condition.project.some((folder) => Safety.inside(directory, folder))
}

/** `*` matches any run of characters, everything else itself. */
export function wildcard(glob: string, value: string) {
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${source}$`, "s").test(value)
}

/** The extensions in force in `directory`: active, on, and with `directory` inside their projects. */
export function applicable(snapshot: CreatorStore.Snapshot, directory: string) {
  return snapshot.loaded.flatMap((loaded) =>
    loaded.status === "active" && loaded.extension !== undefined && Safety.inScope(loaded.entry.projects, directory)
      ? [{ loaded, extension: loaded.extension }]
      : [],
  )
}

export type Applicable = ReturnType<typeof applicable>[number]

/** The items of one type in force, with the extension that holds them. */
export function items<T extends Creator.ItemType>(list: ReadonlyArray<Applicable>, type: T) {
  return list.flatMap((item) =>
    item.extension.items.flatMap((entry) => (isType(entry, type) ? [{ item: entry, owner: item }] : [])),
  )
}

function isType<T extends Creator.ItemType>(item: Creator.Item, type: T): item is Extract<Creator.Item, { type: T }> {
  return item.type === type
}
