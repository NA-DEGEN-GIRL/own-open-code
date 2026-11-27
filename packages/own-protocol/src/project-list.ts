export * as ProjectList from "./project-list.js"

import { Schema } from "effect"
import { EpochMillis } from "./id.js"

/**
 * 03 §4.3 프로젝트 순서와 고정: how the sidebar lists this service's projects. Every service keeps its own (this PC, an
 * SSH host, another PC), so the PC's windows and a phone agree. Ids only, never a path or a name.
 */

/** Most projects either list keeps; more than a sidebar shows. */
export const MAX_PROJECTS = 500

const ProjectID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const Projects = Schema.Array(ProjectID).check(Schema.isMaxLength(MAX_PROJECTS))

export const View = Schema.Struct({
  /** Pinned projects (`고정`), in the user's order; they come first. */
  pinned: Schema.Array(Schema.String),
  /** The other projects in the user's order, or `null`: the default order (newest conversation first). */
  order: Schema.NullOr(Schema.Array(Schema.String)),
  /** When {@link View.order} was set: a project it does not name is listed first while it was used since then. */
  orderedAt: Schema.NullOr(EpochMillis),
}).annotate({ identifier: "Own.ProjectList.View" })
export interface View extends Schema.Schema.Type<typeof View> {}

export const SetInput = Schema.Struct({
  /** The whole list of pinned projects; left out: unchanged. */
  pinned: Schema.optional(Projects),
  /** The whole order; `null` goes back to the default order; left out: unchanged. */
  order: Schema.optional(Schema.NullOr(Projects)),
}).annotate({ identifier: "Own.ProjectList.SetInput" })
export type SetInput = typeof SetInput.Type
