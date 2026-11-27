export * as OwnerAlias from "./alias.js"

import { OwnTeam } from "@own/protocol"

/**
 * 별칭 (`Owner.alias`, feature `owner-alias`, 2026-11-27): the user's short name for an area's owner seat. It stays with
 * the seat (rotation, 새 대화로 이어가기, 담당 대화 바꾸기, account changes), the team main may name the area by it
 * (`MainTools.area`), and the main's team update shows `별칭 · 영역(slug)`. It never reaches the owner's own role entry
 * or its conversation title, so naming an owner changes no prompt of that owner.
 */

/** Line breaks, tabs and other control characters: the alias is one short line in the main's update. */
const CONTROL = /\p{Cc}/u

/**
 * Why `alias` (already trimmed, not empty) cannot name the area `areaID`: too long or not one plain line (`alias`), or
 * another active area of the team already answers to it as its name, slug or alias, or a peer of any area has it as its
 * label or key (`alias-taken`). Compared without case, as the main may write it either way.
 */
export function problem(
  alias: string,
  areaID: OwnTeam.AreaID,
  areas: ReadonlyArray<OwnTeam.Area>,
): "alias" | "alias-taken" | undefined {
  if (alias.length > OwnTeam.OWNER_ALIAS_MAX || CONTROL.test(alias) || alias.startsWith("ar_")) return "alias"
  const wanted = fold(alias)
  const taken = areas
    .filter((area) => area.state !== "retired")
    .flatMap((area) => [
      ...(area.id === areaID ? [] : [area.name, area.id.slice("ar_".length), area.owner.alias ?? ""]),
      ...(area.peers ?? []).flatMap((peer) => [peer.label, peer.key]),
    ])
  return taken.some((name) => fold(name) === wanted) ? "alias-taken" : undefined
}

/** The area's alias matches `name` (the main's words), without case. */
export function matches(area: Pick<OwnTeam.Area, "owner">, name: string) {
  const alias = area.owner.alias
  return alias !== undefined && alias !== "" && fold(alias) === fold(name.trim())
}

/** `민지 · UI`: the alias before the area name when the seat has one, else the name alone. */
export function label(area: Pick<OwnTeam.Area, "owner" | "name">) {
  return area.owner.alias ? `${area.owner.alias} · ${area.name}` : area.name
}

function fold(text: string) {
  return text.trim().toLowerCase()
}
