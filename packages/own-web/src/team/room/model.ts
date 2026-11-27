// 팀 룸 (06 §9.9, 2026-11-27): what the room draws for a team, pure. One seat per area that is not finished, in the
// registry's order: its label (the owner alias and the area name, `별칭 · 영역`), the owner conversation a click opens,
// a state the character acts out, and a look seeded from the area id so each area keeps the same distinct character
// across reloads and devices. The state comes only from what the team view already has: the area's status, whether
// the owner conversation runs, and whether it waits for the user (a permission or a question). Nothing new is asked.
import type { OwnTeam } from "@own/protocol/rpc-team"
import type { TeamEntry } from "../store"

/** What the character acts out: typing, sitting, dozing, a raised hand with `?`, a red tint with a sweat drop. */
export type SeatState = "working" | "idle" | "sleeping" | "waiting" | "error"

export interface Look {
  readonly body: number
  readonly skin: number
  readonly hair: number
  readonly desk: number
  readonly glow: number
  readonly hairStyle: "short" | "bob" | "spiky" | "bald"
  readonly hat: "none" | "cap" | "beanie"
  readonly headphones: boolean
  readonly glasses: boolean
  readonly prop: "mug" | "plant" | "lamp" | "books" | "none"
}

export interface Seat {
  readonly areaID: string
  readonly name: string
  readonly alias?: string
  /** `민지 · UI`, or the area name alone. */
  readonly label: string
  readonly state: SeatState
  /** The owner conversation a click opens; absent while the area has none yet. */
  readonly sessionID?: string
  readonly look: Look
}

/** An idle owner whose status has not changed for this long dozes off. */
export const DOZE_MS = 15 * 60_000

export function roomSeats(input: {
  readonly entry: Pick<TeamEntry, "areas" | "order">
  /** The owner conversation runs a turn now (the session status the sidebar shows). */
  readonly running: (sessionID: string) => boolean
  /** The owner conversation (or one of its subagents) waits for a permission or a question. */
  readonly asking: (sessionID: string) => boolean
  readonly now: number
}): Seat[] {
  return input.entry.order.flatMap((id) => {
    const area = input.entry.areas[id]
    if (!area || area.state === "retired" || area.status.kind === "retired") return []
    const sessionID = area.owner.sessionID ?? undefined
    const alias = area.owner.alias || undefined
    return [
      {
        areaID: area.id,
        name: area.name,
        ...(alias ? { alias } : {}),
        label: alias ? `${alias} · ${area.name}` : area.name,
        state: seatState(area, {
          running: sessionID !== undefined && input.running(sessionID),
          asking: sessionID !== undefined && input.asking(sessionID),
          now: input.now,
        }),
        ...(sessionID ? { sessionID } : {}),
        look: lookOf(area.id),
      },
    ]
  })
}

/**
 * An area's state as the room shows it: a failed or stopped area first, then a question or permission for the user,
 * then work in progress (the owner's turn runs, or the area prepares or is busy), then rest: an owner waiting for
 * limits, under Main 멈춤, or quiet for {@link DOZE_MS} dozes; any other rest (idle, ready) sits.
 */
export function seatState(
  area: Pick<OwnTeam.AreaView, "state" | "status" | "paused">,
  facts: { readonly running: boolean; readonly asking: boolean; readonly now: number },
): SeatState {
  const kind = area.status.kind
  if (area.state === "broken" || kind === "broken" || kind === "failed") return "error"
  if (facts.asking || kind === "asking" || kind === "blocked") return "waiting"
  if (facts.running || kind === "busy" || kind === "preparing" || area.state === "retiring") return "working"
  if (kind === "waiting-quota" || area.paused !== false) return "sleeping"
  return facts.now - area.status.at >= DOZE_MS ? "sleeping" : "idle"
}

const BODY = [0x5b8def, 0xef6f6c, 0x7bc67b, 0xf2b84b, 0xa77bd9, 0x4cc3c9, 0xf28fb5, 0x8f9bb3]
const SKIN = [0xf8d9c0, 0xeec3a0, 0xd9a47a, 0xb97f56, 0x8d5a3b, 0xffe2cf]
const HAIR = [0x2b2118, 0x5a3a22, 0xa5672e, 0xe2b65b, 0x9aa3ad, 0xd8553f, 0x3d4f8f, 0x1d1d1d]
const DESK = [0xc89b6d, 0xa47148, 0xe0c39b, 0x8c6a52, 0xd8d2c4, 0x6f8fa6]
const GLOW = [0x7fd3ff, 0x9dffb0, 0xffd27f, 0xd2a8ff, 0xff9fb2]
const HAIR_STYLES = ["short", "bob", "spiky", "bald"] as const
const HATS = ["none", "none", "none", "cap", "beanie"] as const
const PROPS = ["mug", "plant", "lamp", "books", "none"] as const

/** The look of an area's character: the same area id always gives the same look (FNV-1a seeded mulberry32). */
export function lookOf(seed: string): Look {
  const next = random(hash(seed))
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!
  const hat = pick(HATS)
  return {
    body: pick(BODY),
    skin: pick(SKIN),
    hair: pick(HAIR),
    desk: pick(DESK),
    glow: pick(GLOW),
    hairStyle: hat === "none" ? pick(HAIR_STYLES) : "short",
    hat,
    // A cap or a beanie leaves no room for headphones.
    headphones: hat === "none" && next() < 0.35,
    glasses: next() < 0.35,
    prop: pick(PROPS),
  }
}

function hash(text: string) {
  return [...text].reduce((value, char) => Math.imul(value ^ char.codePointAt(0)!, 0x01000193) >>> 0, 0x811c9dc5)
}

function random(seed: number) {
  const state = { value: seed }
  return () => {
    state.value = (state.value + 0x6d2b79f5) >>> 0
    const mixed = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value)
    const out = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((out ^ (out >>> 14)) >>> 0) / 4_294_967_296
  }
}
