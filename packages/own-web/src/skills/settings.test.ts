// 설정 > 스킬 (SM 2026-10-24, SG 2026-10-26): where each skill comes from, in the page's groups and order, which rows
// are own-import's copies (the only ones `지우기` offers), the switches and scopes as the page reads them, and the
// page's strings.
import { describe, expect, test } from "bun:test"
import type { SkillInfo } from "@opencode/client"
import {
  chosenScope,
  exceptions,
  globalOff,
  globalSection,
  grouped,
  inheritedAt,
  orphanScopes,
  projectNames,
  projectSection,
  scopable,
  scopeChoices,
  scopeOf,
  skillRows,
  type SkillsetView,
  type Switch,
} from "./settings-model"
import { skillSettingsEn, skillSettingsKo } from "./settings-strings"

const skill = (id: string, path: string, extra: Partial<SkillInfo> = {}) =>
  ({ id, name: id, path, content: "", ...extra }) as SkillInfo

describe("skill groups", () => {
  test("project, own-import's copies, global, Claude Code personal, own's and built-in, in that order", () => {
    const rows = skillRows(
      [
        skill("opencode", "/builtin/opencode.md"),
        skill("imagegen", "/builtin/own/imagegen.md"),
        skill("review", "C:\\Users\\demo\\.claude\\skills\\review\\SKILL.md"),
        skill("notes", "C:\\Users\\demo\\.config\\own-open-code\\skills\\notes\\SKILL.md", { autoinvoke: true }),
        skill("mine", "C:\\Users\\demo\\.config\\own-open-code\\skills\\mine\\SKILL.md"),
        skill("deploy", "D:\\work\\game\\.opencode\\skills\\deploy\\SKILL.md"),
      ],
      {
        directory: "D:\\work\\game",
        skillsDir: "C:\\Users\\demo\\.config\\own-open-code\\skills",
        imports: [{ id: "notes" }],
      },
    )
    expect(rows.map((row) => [row.id, row.group, row.imported ?? null])).toEqual([
      ["deploy", "project", null],
      ["notes", "imported", "notes"],
      ["mine", "global", null],
      ["review", "claude", null],
      ["imagegen", "own", null],
      ["opencode", "builtin", null],
    ])
    expect(rows[1]).toMatchObject({ folder: "C:\\Users\\demo\\.config\\own-open-code\\skills\\notes", auto: true })
    expect(grouped(rows).map((entry) => [entry.group, entry.rows.length])).toEqual([
      ["project", 1],
      ["imported", 1],
      ["global", 1],
      ["claude", 1],
      ["own", 1],
      ["builtin", 1],
    ])
  })

  test("without own's skills folder nothing is a copy, so nothing can be removed", () => {
    const rows = skillRows([skill("notes", "C:\\own\\skills\\notes\\SKILL.md")], {
      directory: undefined,
      skillsDir: null,
      imports: [{ id: "notes" }],
    })
    expect(rows.map((row) => [row.group, row.imported ?? null])).toEqual([["global", null]])
  })

  test("every Korean string has English", () => {
    const keys = Object.keys(skillSettingsKo) as (keyof typeof skillSettingsKo)[]
    expect(keys.filter((key) => !skillSettingsEn[key])).toEqual([])
  })
})

// Global first (SG 2026-10-26): the switches and scopes of own.accounts `skillset.view`, as the page shows them.
const OWN = "C:\\Users\\demo\\.config\\own-open-code\\skills"
const GAME = "D:\\work\\game"
const SITE = "D:\\work\\site"
const entry = (id: string, folder = OWN) => ({ id, name: id, path: `${folder}\\${id}\\SKILL.md` })

describe("switches and scopes", () => {
  const switches: Switch[] = [
    { id: "pdf", enabled: false },
    { id: "pdf", directory: GAME, enabled: true },
    // Inherits GAME's on: no exception of its own.
    { id: "pdf", directory: `${GAME}\\sub`, enabled: true },
    { id: "notes", directory: SITE, enabled: false },
    { id: "notes", directory: "D:\\work\\a", enabled: false },
    { id: "notes", directory: "D:\\work\\b", enabled: false },
    { id: "notes", directory: "D:\\work\\c", enabled: false },
  ]

  test("what a place inherits, the global switch, and the projects that differ", () => {
    expect(inheritedAt(switches, "pdf", undefined)).toBe(true)
    expect(inheritedAt(switches, "pdf", GAME)).toBe(false)
    expect(inheritedAt(switches, "pdf", `${GAME}\\sub`)).toBe(true)
    expect(inheritedAt(switches, "pdf", "d:/work/game/sub/deeper")).toBe(true)
    expect(globalOff(switches, "pdf")).toBe(true)
    expect(globalOff(switches, "notes")).toBe(false)
    expect(exceptions(switches, "pdf")).toEqual({ off: [], only: [GAME] })
    expect(exceptions(switches, "notes").off).toHaveLength(4)
    expect(projectNames(exceptions(switches, "notes").off)).toEqual({
      shown: [
        { directory: SITE, name: "site" },
        { directory: "D:\\work\\a", name: "a" },
        { directory: "D:\\work\\b", name: "b" },
      ],
      more: 1,
    })
  })

  test("쓰는 곳: every project, this project, and another project a scope names", () => {
    expect(scopeChoices(undefined, GAME)).toEqual([{ type: "all" }, { type: "here", directory: GAME }])
    const scope = { folder: `${OWN}\\pdf`, directory: SITE }
    const choices = scopeChoices(scope, GAME)
    expect(choices).toEqual([{ type: "all" }, { type: "here", directory: GAME }, { type: "folder", directory: SITE }])
    expect(chosenScope(choices, scope)).toBe(2)
    expect(chosenScope(choices, undefined)).toBe(0)
    expect(scopeChoices({ folder: `${OWN}\\pdf`, directory: "d:/work/game" }, GAME)).toHaveLength(2)
    expect(scopeChoices(undefined, undefined)).toEqual([{ type: "all" }])
    expect(
      [scopable({ group: "imported" }), scopable({ group: "builtin" }), scopable({ group: "own" }), scopable({ group: "project" })],
    ).toEqual([true, false, false, false])
  })

  test("모든 프로젝트: the catalog without scoped skills; global switches of unknown ids are gone", () => {
    const view: SkillsetView = {
      catalog: [
        entry("pdf"),
        entry("deploy"),
        entry("notes"),
        { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md" },
      ],
      switches: [...switches, { id: "old", enabled: false }],
      scopes: [{ folder: `${OWN}\\deploy`, directory: GAME }],
    }
    const section = globalSection(view, { skillsDir: OWN, imports: [{ id: "notes" }] })
    expect(section.rows.map((item) => [item.row.id, item.row.group, item.off])).toEqual([
      ["notes", "imported", false],
      ["pdf", "global", true],
      ["opencode", "builtin", false],
    ])
    expect(section.rows[1]!.exceptions).toEqual({ off: [], only: [GAME] })
    expect(section.gone).toEqual(["old"])
  })

  // Review finding (2026-10-26): a scope matched only a skill whose SKILL.md sat in its folder, as the fold did, and a
  // flat skill's scope named the folder every flat skill there shares; a scope left by a deleted folder showed nowhere.
  test("scopes hold nested skills, a flat skill is scoped by its file, and scopes of no skill are orphans", () => {
    const pack = `${OWN}\\pack`
    const flat = { id: "flat", name: "flat", path: `${OWN}\\flat.md` }
    const view: SkillsetView = {
      catalog: [
        entry("pack"),
        { id: "nested", name: "nested", path: `${pack}\\nested\\SKILL.md` },
        { id: "deeper", name: "deeper", path: `${pack}\\nested\\deeper\\SKILL.md` },
        flat,
        { id: "other", name: "other", path: `${OWN}\\other.md` },
      ],
      switches: [],
      scopes: [
        { folder: pack, directory: GAME },
        { folder: `${pack}\\nested\\deeper`, directory: SITE },
        { folder: `${OWN}\\flat.md`, directory: GAME },
        // Its folder was deleted by hand; `packaged` only starts like `pack`.
        { folder: `${OWN}\\gone`, directory: SITE },
        { folder: `${OWN}\\packaged`, directory: GAME },
      ],
    }
    // Rows come sorted by name.
    const rows = skillRows(view.catalog, { directory: undefined, imports: [] })
    expect(rows.map((row) => [row.id, row.scopePath, scopeOf(view.scopes, row.path)?.directory ?? null])).toEqual([
      ["deeper", `${pack}\\nested\\deeper`, SITE],
      ["flat", `${OWN}\\flat.md`, GAME],
      ["nested", `${pack}\\nested`, GAME],
      ["other", `${OWN}\\other.md`, null],
      ["pack", pack, GAME],
    ])
    const section = globalSection(view, { imports: [] })
    expect(section.rows.map((item) => item.row.id)).toEqual(["other"])
    expect(section.orphans).toEqual([
      { folder: `${OWN}\\gone`, directory: SITE },
      { folder: `${OWN}\\packaged`, directory: GAME },
    ])
    expect(orphanScopes({ catalog: [flat], scopes: [{ folder: `${OWN}\\flat.md`, directory: GAME }] })).toEqual([])
    const here = projectSection(view, { directory: GAME, listed: [], imports: [] })
    expect(here.own.map((item) => item.row.id)).toEqual(["flat", "nested", "pack"])
    expect(here.elsewhere.map((item) => item.row.id)).toEqual(["deeper"])
  })

  test("one project: its exceptions, its own and scoped skills, everyone's, other projects', and gone ids", () => {
    const view: SkillsetView = {
      catalog: [entry("pdf"), entry("deploy"), entry("site-only"), entry("notes")],
      switches: [
        { id: "pdf", enabled: false },
        { id: "pdf", directory: GAME, enabled: true },
        { id: "notes", directory: GAME, enabled: false },
        { id: "local-off", directory: GAME, enabled: false },
        { id: "vanished", directory: GAME, enabled: false },
        // Another project's switch is not this one's.
        { id: "deploy", directory: SITE, enabled: false },
      ],
      scopes: [
        { folder: `${OWN}\\deploy`, directory: GAME },
        { folder: `${OWN}\\site-only`, directory: SITE },
      ],
      off: [
        { id: "notes", by: "project", name: "notes", path: `${OWN}\\notes\\SKILL.md` },
        { id: "site-only", by: "scope", name: "site-only", path: `${OWN}\\site-only\\SKILL.md` },
        { id: "local-off", by: "project", name: "Local", path: `${GAME}\\.opencode\\skills\\local-off\\SKILL.md` },
        { id: "vanished", by: "project" },
      ],
    }
    const section = projectSection(view, {
      directory: GAME,
      listed: [entry("pdf"), entry("deploy"), entry("local-on", `${GAME}\\.opencode\\skills`)],
      skillsDir: OWN,
      imports: [],
    })
    expect(section.exceptions.map((item) => [item.row.id, item.enabled])).toEqual([
      ["pdf", true],
      ["notes", false],
    ])
    expect(section.own.map((item) => [item.row.id, item.on, item.by ?? null, item.scope?.directory ?? null])).toEqual([
      ["local-off", false, "project", null],
      ["local-on", true, null, null],
      ["deploy", true, null, GAME],
    ])
    expect(section.all.map((item) => [item.row.id, item.on])).toEqual([
      ["notes", false],
      ["pdf", true],
    ])
    expect(section.elsewhere.map((item) => [item.row.id, item.scope.directory])).toEqual([["site-only", SITE]])
    expect(section.gone).toEqual(["vanished"])
  })
})
