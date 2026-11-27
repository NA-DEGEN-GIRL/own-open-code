// 별칭 (owner alias, 06 §2.7, §9.4, 2026-11-27) on the screens: the editor's form (trimmed, at most 12 characters on one
// line, not a name the team already answers to, empty removes it), the names it may not take, `별칭 · 영역`, the area
// menu's 별칭 바꾸기… item (an active area, with the feature and the scope), the area row's alias, the strings in both
// languages and the wire's `area.edit{alias}`. Fixtures go through the protocol's schemas.
import { describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { teamText } from "./strings"
import { aliasForm, aliasLabel, aliasTaken, areaActions, areaGroups, areaRow, OWNER_ALIAS_MAX } from "./view-model"

const TEAM = "tm_0123456789ab"
const decodeArea = Schema.decodeUnknownSync(OwnTeam.AreaView)

function area(id: string, fields: Record<string, unknown> = {}) {
  const slug = id.slice(3)
  return decodeArea({
    id,
    teamID: TEAM,
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
    owner: { sessionID: "ses_owner", previous: [], attached: true },
    preset: "builtin:codex",
    paused: false,
    status: { kind: "idle", at: 1, text: "" },
    handoff: null,
    ...fields,
  })
}

const ko = (key: Parameters<typeof teamText.text>[1], params?: Record<string, string | number>) =>
  teamText.text("ko", key, params)
const en = (key: Parameters<typeof teamText.text>[1], params?: Record<string, string | number>) =>
  teamText.text("en", key, params)

describe("별칭 form", () => {
  test("trimmed; at most 12 characters; one line; not `ar_`; empty removes it", () => {
    expect(OWNER_ALIAS_MAX).toBe(OwnTeam.OWNER_ALIAS_MAX)
    expect(aliasForm("  민지 ", [])).toEqual({ alias: "민지", left: 10, line: true, free: true, ok: true })
    expect(aliasForm("", [])).toMatchObject({ alias: "", ok: true })
    expect(aliasForm("가".repeat(12), [])).toMatchObject({ left: 0, ok: true })
    expect(aliasForm("가".repeat(13), [])).toMatchObject({ left: -1, ok: false })
    expect(aliasForm("민\n지", [])).toMatchObject({ line: false, ok: false })
    expect(aliasForm("ar_ui", [])).toMatchObject({ line: false, ok: false })
  })

  test("a name the team already answers to is taken, without case; the area's own names are not", () => {
    const ui = area("ar_ui", { name: "UI", owner: { sessionID: "ses_a", previous: [], attached: true, alias: "민지" } })
    const save = area("ar_save", {
      name: "세이브",
      peers: [
        { key: "reviewer", sessionID: "ses_p", label: "리뷰어", role: "", attached: true, origin: "created", at: 1 },
      ],
    })
    const gone = area("ar_old", { name: "옛 영역", state: "retired", status: { kind: "retired", at: 1, text: "" } })
    const entry = { areas: { [ui.id]: ui, [save.id]: save, [gone.id]: gone }, order: [ui.id, save.id, gone.id] }
    const taken = aliasTaken(entry, save.id)
    expect(taken).toEqual(["UI", "ui", "민지", "리뷰어", "reviewer"])
    for (const name of ["ui", "민지", "REVIEWER"])
      expect(aliasForm(name, taken)).toMatchObject({ free: false, ok: false })
    expect(aliasForm("세이브", taken)).toMatchObject({ ok: true })
    expect(aliasForm("옛 영역", taken)).toMatchObject({ ok: true })
  })

  test("`별칭 · 영역`, the name alone without one; the area row carries it beside its label", () => {
    const named = area("ar_ui", {
      name: "UI",
      owner: { sessionID: "ses_a", previous: [], attached: true, alias: "민지" },
    })
    expect(aliasLabel(named)).toBe("민지 · UI")
    expect(aliasLabel(area("ar_ui", { name: "UI" }))).toBe("UI")
    const row = areaRow(ko, named, { home: "D:/repo", waiting: 0, preset: { name: "평소대로", builtin: true } })
    expect(row).toMatchObject({ label: "UI · 담당", alias: "민지" })
    expect(
      areaRow(ko, area("ar_ui"), { home: "D:/repo", waiting: 0, preset: { name: "x", builtin: true } }),
    ).not.toHaveProperty("alias")
  })
})

describe("별칭 바꾸기… in the area menu", () => {
  test("an active area, where own.team has `owner-alias` and the connection may call `area.edit`; in 설정 after 역할", () => {
    const all = (feature: OwnTeam.Feature) => feature === "owner-alias" || feature === "area-edit"
    const allowed = () => true
    const actions = areaActions({ area: area("ar_ui"), has: all, allowed })
    expect(actions).toContain("alias")
    expect(areaGroups(actions).find((group) => group.group === "settings")?.actions).toEqual([
      "role",
      "alias",
      "userMade",
    ])
    expect(areaActions({ area: area("ar_ui"), has: (feature) => feature === "area-edit", allowed })).not.toContain(
      "alias",
    )
    expect(areaActions({ area: area("ar_ui"), has: all, allowed: () => false })).not.toContain("alias")
    const retired = area("ar_ui", { state: "retired", status: { kind: "retired", at: 1, text: "" } })
    expect(areaActions({ area: retired, has: all, allowed })).not.toContain("alias")
  })

  test("the wire takes `area.edit{alias}`, an empty one too", async () => {
    const takes = async (input: unknown) =>
      (await OwnTeam.Definition.methods["area.edit"].input["~standard"].validate(input)).issues === undefined
    expect(await takes({ teamID: TEAM, areaID: "ar_ui", alias: "민지" })).toBe(true)
    expect(await takes({ teamID: TEAM, areaID: "ar_ui", alias: "" })).toBe(true)
  })

  test("words in both languages", () => {
    expect(ko("own.team.areaMenu.alias")).toBe("별칭 바꾸기…")
    expect(en("own.team.areaMenu.alias")).toBe("Change alias…")
    expect(ko("own.team.areaMenu.aliasNow", { alias: "민지" })).toBe("지금: 민지")
    expect(ko("own.team.alias.saved", { area: "UI", alias: "민지" })).toBe("'UI' 영역의 별칭을 '민지'로 바꿨어요")
    expect(en("own.team.alias.saved", { area: "UI", alias: "Mina" })).toBe("The 'UI' area's alias is now 'Mina'")
    expect(ko("own.team.alias.left", { n: 10 })).toBe("10자 남음")
  })
})
