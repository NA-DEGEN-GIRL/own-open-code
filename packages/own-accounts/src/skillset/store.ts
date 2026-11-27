export * as SkillsetStore from "./store.js"

import { Schema } from "effect"
import { OwnSkillset } from "@own/protocol"
import { Store } from "@own/runtime"
import type { Deps } from "../deps.js"

/**
 * The skill switches and scopes (03 §19.6.1, SG 2026-10-26): `OWN_HOME\skill-switches.json`, skill ids and folders
 * only, never a skill's content. Only the control Location's instance writes (both `skillset.*` methods arrive there);
 * every instance reads it for its fold, before its first skill transform and after every `skillset.changed`.
 */
export const File = Schema.Struct({
  version: Schema.Literal(1),
  switches: Schema.Array(OwnSkillset.Switch).check(Schema.isMaxLength(OwnSkillset.MAX_SWITCHES)),
  scopes: Schema.Array(OwnSkillset.Scope).check(Schema.isMaxLength(OwnSkillset.MAX_SCOPES)),
})
export type File = typeof File.Type

export const EMPTY: File = { version: 1, switches: [], scopes: [] }

/** The file of this instance's runtime home. Writes go through its mutex (one control instance writes). */
export function file(deps: Pick<Deps, "runtime">) {
  return new Store.JsonFile({ file: deps.runtime.layout.skillSwitches, schema: File, fallback: () => EMPTY })
}
