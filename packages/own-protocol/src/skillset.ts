export * as OwnSkillset from "./skillset.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"

/**
 * Skills are global first (03 §19.6.1, decisions SG 2026-10-26): every skill this app loads from its own folders (own's
 * skills folder, the user's global folders, Claude Code's personal folder, core's built-in ones) is used in every
 * project, and a project's own folder (`.opencode/skills`) only in that project. On top of that own.accounts keeps two
 * kinds of record in `OWN_HOME\skill-switches.json` and removes what they turn off from each project's skills (its
 * `skill.transform`, never the control Location's):
 * - a switch: one skill id off (or on again) in every project (no `directory`) or in one project folder and the folders
 *   inside it; project switches override the global one, the deepest folder last;
 * - a scope (`쓰는 곳` `이 프로젝트만`): the skills of `folder` (a skill's folder, with the skills nested below it, or
 *   a flat `<id>.md` skill's own file, SG-19) are used only in `directory` and the folders inside it, whatever the
 *   switches say elsewhere; the deepest scope that holds a skill decides.
 * Never a skill's content; ids and folders only.
 */

/** A folder or a text of the records: 1 to 4,096 characters. */
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))

/** A skill id as core gives it (`Skill.ID`). */
const ID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

/** At most this many switches and scopes are kept. */
export const MAX_SWITCHES = 2_000
export const MAX_SCOPES = 500

/** One skill on or off in every project (no `directory`) or in one project folder and the folders inside it. */
export interface Switch extends Schema.Schema.Type<typeof Switch> {}
export const Switch = Schema.Struct({ id: ID, directory: optional(Text), enabled: Schema.Boolean }).annotate({
  identifier: "Own.Skillset.Switch",
})

/**
 * The skills of `folder` are used only in `directory` and the folders inside it: a skill's folder (where its
 * `SKILL.md` is, and every skill nested below it) or a flat skill's `<id>.md` file (its folder is shared, SG-19).
 */
export interface Scope extends Schema.Schema.Type<typeof Scope> {}
export const Scope = Schema.Struct({ folder: Text, directory: Text }).annotate({ identifier: "Own.Skillset.Scope" })

/** A skill of the catalog (the skills every project gets before any switch), never its content. */
export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: optional(Schema.String),
  path: Schema.String,
  autoinvoke: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Skillset.Entry" })

/**
 * Why a skill is off in a project: its scope keeps it in another project (`scope`), the global switch (`global`), a
 * project switch (`project`). A skill the project's Location removed carries what core had of it; a switch of an id no
 * skill has (any more) is id only.
 */
export const OffBy = Schema.Literals(["scope", "global", "project"]).annotate({ identifier: "Own.Skillset.OffBy" })
export type OffBy = typeof OffBy.Type

export interface Off extends Schema.Schema.Type<typeof Off> {}
export const Off = Schema.Struct({
  id: Schema.String,
  by: OffBy,
  name: optional(Schema.String),
  description: optional(Schema.String),
  path: optional(Schema.String),
  autoinvoke: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Skillset.Off" })

/**
 * `skillset.view`: the catalog, every switch and scope, and with a project folder what is off there (`off`, from that
 * project's own Location when it is open, else judged over the catalog).
 */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  catalog: Schema.Array(Entry),
  switches: Schema.Array(Switch),
  scopes: Schema.Array(Scope),
  off: optional(Schema.Array(Off)),
}).annotate({ identifier: "Own.Skillset.View" })

export interface ViewInput extends Schema.Schema.Type<typeof ViewInput> {}
export const ViewInput = Schema.Struct({ directory: optional(Text) }).annotate({ identifier: "Own.Skillset.ViewInput" })

/** One switch to set (`enabled`) or to delete (`null`): in every project without `directory`, else in that folder. */
export interface Change extends Schema.Schema.Type<typeof Change> {}
export const Change = Schema.Struct({
  id: ID,
  directory: optional(Text),
  enabled: Schema.NullOr(Schema.Boolean),
}).annotate({ identifier: "Own.Skillset.Change" })

/** The scope of `folder` (a skill's folder or a flat skill's file): one project, or every project again (`null`). */
export interface ScopeChange extends Schema.Schema.Type<typeof ScopeChange> {}
export const ScopeChange = Schema.Struct({ folder: Text, directory: Schema.NullOr(Text) }).annotate({
  identifier: "Own.Skillset.ScopeChange",
})

/** `skillset.switch`: the scopes first, then the changes, in one write; at least one of either. */
export interface SwitchInput extends Schema.Schema.Type<typeof SwitchInput> {}
export const SwitchInput = Schema.Struct({
  changes: Schema.Array(Change).check(Schema.isMaxLength(400)),
  scopes: optional(Schema.Array(ScopeChange).check(Schema.isMaxLength(200))),
}).annotate({ identifier: "Own.Skillset.SwitchInput" })
