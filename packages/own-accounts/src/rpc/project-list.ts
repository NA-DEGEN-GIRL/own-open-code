export * as ProjectListRpc from "./project-list.js"

import { Option, Schema } from "effect"
import { Kv, ProjectList } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: 프로젝트 순서와 고정 (03 §4.3). How the sidebar lists this service's projects: one KV row per service, so every
 * window and device of it agrees. Global methods at the control Location; stateless.
 */
export type Methods = "projectList.get" | "projectList.set"

const decode = Schema.decodeUnknownOption(ProjectList.View)
const EMPTY: ProjectList.View = { pinned: [], order: null, orderedAt: null }

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  const read = async () => Option.getOrElse(decode(await deps.ctx.storage.get(Kv.projectList)), () => EMPTY)
  // One change at a time: two devices that change one half each must not write back each other's old one.
  const state: { queue: Promise<unknown> } = { queue: Promise.resolve() }
  return {
    "projectList.get": read,
    "projectList.set": (input) => {
      const result = state.queue.then(() => change(input))
      state.queue = result.catch(() => undefined)
      return result
    },
  }

  async function change(input: ProjectList.SetInput) {
    const stored = await read()
    const order = input.order === undefined ? stored.order : input.order && [...new Set(input.order)]
    const list: ProjectList.View = {
      pinned: input.pinned === undefined ? stored.pinned : [...new Set(input.pinned)],
      order,
      orderedAt: input.order === undefined ? stored.orderedAt : order && deps.clock.now(),
    }
    await deps.ctx.storage.set(Kv.projectList, list)
    deps.log.child("project-list").info("project_list_set", {
      pinned: list.pinned.length,
      ordered: list.order !== null,
    })
    void deps.emitter.global("projectList.changed", { list })
    return list
  }
}
