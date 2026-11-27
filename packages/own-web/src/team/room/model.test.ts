// 팀 룸's model (06 §9.9, 2026-11-27): one seat per area that is not finished, in the registry's order, labelled
// `별칭 · 영역`; the state each character acts out from what the team view already has; a look seeded from the area id
// (the same id always gives the same look, different ids mostly differ). Fixtures go through the protocol's schemas.
import { describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { DOZE_MS, lookOf, roomSeats, seatState } from "./model"
import { roomEn, roomKo } from "./strings"

const decodeArea = Schema.decodeUnknownSync(OwnTeam.AreaView)
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0)

function area(id: string, fields: Record<string, unknown> = {}) {
  const slug = id.slice(3)
  return decodeArea({
    id,
    teamID: "tm_0123456789ab",
    name: slug,
    goal: "",
    origin: "created",
    state: "active",
    branch: slug,
    gitDir: `D:/repo/.git/worktrees/${slug}`,
    base: { sha: "a".repeat(40), at: 1 },
    directory: `D:/repo-team/${slug}`,
    shape: "code",
    cone: { extra: {}, kept: {} },
    owner: { sessionID: `ses_${slug}`, previous: [], attached: true },
    preset: "builtin:codex",
    paused: false,
    status: { kind: "idle", at: NOW, text: "" },
    handoff: null,
    ...fields,
  })
}

function entry(...areas: ReturnType<typeof area>[]) {
  return { areas: Object.fromEntries(areas.map((item) => [item.id, item])), order: areas.map((item) => item.id) }
}

const quiet = { running: () => false, asking: () => false, now: NOW }

describe("seats", () => {
  test("one per area that is not finished, in order, labelled `별칭 · 영역`, with the owner conversation to open", () => {
    const seats = roomSeats({
      ...quiet,
      entry: entry(
        area("ar_ui", { name: "화면", owner: { sessionID: "ses_ui", previous: [], attached: true, alias: "민지" } }),
        area("ar_old", { state: "retired", status: { kind: "retired", at: 1, text: "" } }),
        area("ar_api", { name: "서버", owner: { sessionID: null, previous: [], attached: true } }),
      ),
    })
    expect(seats.map((seat) => [seat.areaID, seat.label, seat.alias, seat.sessionID])).toEqual([
      ["ar_ui", "민지 · 화면", "민지", "ses_ui"],
      ["ar_api", "서버", undefined, undefined],
    ])
    expect(roomSeats({ ...quiet, entry: entry() })).toEqual([])
  })

  test("the state: a problem, then the user's turn, then work, then rest (dozing after a while, limits, Main 멈춤)", () => {
    const facts = { running: false, asking: false, now: NOW }
    const of = (fields: Record<string, unknown>, more: Partial<typeof facts> = {}) =>
      seatState(area("ar_ui", fields), { ...facts, ...more })
    expect(of({ status: { kind: "failed", at: NOW, text: "" } }, { asking: true })).toBe("error")
    expect(of({ state: "broken", broken: { why: "missing", at: 1 } })).toBe("error")
    expect(of({}, { asking: true, running: true })).toBe("waiting")
    expect(of({ status: { kind: "asking", at: NOW, text: "" } })).toBe("waiting")
    expect(of({ status: { kind: "blocked", at: NOW, text: "" } })).toBe("waiting")
    expect(of({}, { running: true })).toBe("working")
    expect(of({ status: { kind: "busy", at: NOW, text: "" } })).toBe("working")
    expect(of({ status: { kind: "preparing", at: NOW, text: "" } })).toBe("working")
    expect(of({ status: { kind: "waiting-quota", at: NOW, text: "" } })).toBe("sleeping")
    expect(of({ paused: "user" })).toBe("sleeping")
    expect(of({ status: { kind: "ready", at: NOW, text: "" } })).toBe("idle")
    expect(of({ status: { kind: "idle", at: NOW - DOZE_MS + 1, text: "" } })).toBe("idle")
    expect(of({ status: { kind: "idle", at: NOW - DOZE_MS, text: "" } })).toBe("sleeping")
  })

  test("running and asking are asked of the owner conversation only", () => {
    const seen: string[] = []
    const seats = roomSeats({
      entry: entry(area("ar_ui"), area("ar_api", { owner: { sessionID: null, previous: [], attached: true } })),
      running: (sessionID) => {
        seen.push(sessionID)
        return true
      },
      asking: (sessionID) => sessionID === "ses_nobody",
      now: NOW,
    })
    expect(seats.map((seat) => seat.state)).toEqual(["working", "idle"])
    expect(seen).toEqual(["ses_ui"])
  })
})

describe("looks", () => {
  test("the same area id always gives the same look; ids give varied looks", () => {
    expect(lookOf("ar_ui")).toEqual(lookOf("ar_ui"))
    const looks = Array.from({ length: 40 }, (_, index) => lookOf(`ar_area-${index}`))
    expect(new Set(looks.map((look) => JSON.stringify(look))).size).toBeGreaterThan(35)
    expect(new Set(looks.map((look) => look.body)).size).toBeGreaterThan(4)
    expect(new Set(looks.map((look) => look.prop)).size).toBeGreaterThan(3)
    // A cap or a beanie never comes with headphones or a hair style under it.
    for (const look of looks.filter((item) => item.hat !== "none")) {
      expect(look.headphones).toBe(false)
      expect(look.hairStyle).toBe("short")
    }
  })
})

describe("strings", () => {
  test("every key in both languages, no Korean in the English", () => {
    expect(Object.keys(roomEn).sort()).toEqual(Object.keys(roomKo).sort())
    for (const value of Object.values(roomEn)) expect(value).not.toMatch(/[가-힣]/)
  })
})
