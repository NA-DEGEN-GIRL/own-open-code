// Skills `가져오기`, SK2 (2026-10-24; 03 §19.6.1, 09 §9.2): every place has a readable name (the default homes, the
// codex-multi-provider accounts by alias, added folders by name, the Claude app's synced accounts by the own account
// of that uuid), identical copies are one row with every place, copies of the same name with other content stay
// separate and marked, content already in use is in use, the search and the filters. The world is the design's fixture
// as the protocol's schemas decode it; every path is fake. The detail's sanitized body needs a real browser's DOM
// (happy-dom's breaks DOMPurify): e2e/tools/tools.pw.ts renders a hostile SKILL.md in Edge.
import { describe, expect, test } from "bun:test"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import {
  folderName,
  groupRows,
  importStatus,
  lookedIn,
  mergeFound,
  rootLabel,
  shownPath,
  sourceOf,
  visibleRows,
  type FoundRoot,
  type FoundSkill,
  type Label,
} from "./import-model"
import { skillsImportEn, skillsImportKo } from "./import-strings"
import { skillsKo } from "./strings"

const decodeFound = Schema.decodeUnknownSync(OwnImport.SkillFound)
const decodeRoot = Schema.decodeUnknownSync(OwnImport.Root)

function root(rootID: string, kind: "codex" | "claude-code", directory: string, extra: Record<string, unknown> = {}) {
  return decodeRoot({ rootID, kind, label: rootID, directory, added: false, available: true, origin: "default", ...extra })
}

/** The default homes, three codex-multi-provider accounts (03 shares the default's skills folder), one added folder. */
const ROOTS: FoundRoot[] = [
  root("codex-r0", "codex", "C:\\Users\\fixture\\.codex"),
  root("claude-r1", "claude-code", "C:\\Users\\fixture\\.claude"),
  root("codex-p1", "codex", "D:\\cc\\profiles\\01\\codex", {
    origin: "profile",
    account: { app: "codex-multi-provider", id: "01", alias: "work" },
  }),
  root("codex-p2", "codex", "D:\\cc\\profiles\\02\\codex", {
    origin: "profile",
    account: { app: "codex-multi-provider", id: "02", alias: "side" },
  }),
  root("codex-p3", "codex", "D:\\cc\\profiles\\03\\codex", {
    origin: "profile",
    account: { app: "codex-multi-provider", id: "03" },
    sharedWith: "codex-r0",
  }),
  root("codex-a1", "codex", "D:\\backup\\.codex", { origin: "added", added: true }),
]

const H1 = "1".repeat(64)
const H2 = "2".repeat(64)
const H3 = "3".repeat(64)

/** A found skill at `relative` below a root of {@link ROOTS}. */
function at(rootID: string, relative: string, name: string, extra: Record<string, unknown> = {}): FoundSkill {
  const owner = ROOTS.find((item) => item.rootID === rootID)!
  const directory = `${owner.directory}\\${relative.replaceAll("/", "\\")}`
  return decodeFound({
    key: `sk-${rootID.replace(/[^a-z0-9]/g, "")}${relative.replace(/[^a-z]/g, "")}`.slice(0, 60),
    origin: owner.kind,
    rootID,
    name,
    id: name,
    directory,
    real: directory,
    relative,
    system: relative.includes(".system"),
    files: 1,
    bytes: 10,
    scripts: [],
    format: { status: "ok", problems: [], notes: [], ignored: [] },
    ...extra,
  })
}

const ITEMS: FoundSkill[] = [
  at("codex-r0", "skills/pdf", "pdf", { hash: H1, modifiedAt: 1_000 }),
  at("codex-r0", "skills/backup/pdf", "pdf", { hash: H1, modifiedAt: 900 }),
  at("codex-p1", "skills/pdf", "pdf", { hash: H1, modifiedAt: 1_100 }),
  at("codex-p2", "skills/pdf", "pdf", { hash: H2, modifiedAt: 2_000, version: "2.0.0", description: "v2" }),
  at("claude-r1", "skills/pdf", "pdf", { hash: H1 }),
  at("codex-r0", "skills/.system/skill-creator", "skill-creator", { hash: H3 }),
  at("codex-p1", "skills/.system/skill-creator", "skill-creator", { hash: H3 }),
  at("codex-r0", "skills/.system/imagegen", "imagegen"),
  at("claude-r1", "skills/synced/org-1_acct-1/docx", "docx", {
    synced: { folder: "org-1_acct-1", org: "org-1", account: "acct-1" },
  }),
]
/** own loads Claude Code's personal pdf (core's compatibility root `~/.claude/skills`). */
const LOADED = [{ id: "pdf", path: "C:/Users/fixture/.claude/skills/pdf/SKILL.md" }]

/** A label as the Korean catalog fills it. */
function text(label: Label): string {
  const catalog: Readonly<Record<string, string>> = { ...skillsKo, ...skillsImportKo }
  const template = catalog[label.key] ?? label.key
  return Object.entries(label.params ?? {}).reduce(
    (out: string, [name, value]) => out.replace(`{${name}}`, String(value)),
    template,
  )
}

describe("places", () => {
  test("each root has a readable name: the default homes, accounts by alias or id, added ones by folder", () => {
    expect(ROOTS.map((item) => text(rootLabel(item, ROOTS)))).toEqual([
      "Codex (기본 폴더)",
      "Claude Code (기본)",
      "Codex · 계정 work",
      "Codex · 계정 side",
      "Codex · 계정 03",
      "Codex · 폴더 backup\\.codex",
    ])
    // A root of the plugin option or $CODEX_HOME is the default one too; a second one is named by its folder.
    const option = [
      root("a", "codex", "C:\\t\\one\\codex", { origin: "option" }),
      root("b", "codex", "C:\\t\\two", { origin: "option" }),
    ]
    expect(option.map((item) => text(rootLabel(item, option)))).toEqual(["Codex (기본 폴더)", "Codex · 폴더 two"])
    expect([folderName("D:\\x\\.claude"), folderName("D:\\x\\tools"), folderName("C:\\codex")]).toEqual([
      "x\\.claude",
      "tools",
      "C:\\codex",
    ])
  })

  test("an account and an added folder of the same name never read alike (SK2 2026-10-25)", () => {
    const roots = [
      root("codex-r0", "codex", "C:\\Users\\fixture\\.codex"),
      root("codex-p1", "codex", "D:\\cc\\profiles\\01\\codex", {
        origin: "profile",
        account: { app: "codex-multi-provider", id: "01", alias: "work" },
      }),
      root("codex-a1", "codex", "D:\\work", { origin: "added", added: true }),
      root("claude-a1", "claude-code", "D:\\work", { origin: "added", added: true }),
    ]
    const labels = roots.map((item) => text(rootLabel(item, roots)))
    expect(labels).toEqual(["Codex (기본 폴더)", "Codex · 계정 work", "Codex · 폴더 work", "Claude Code · 폴더 work"])
    expect(new Set(labels).size).toBe(labels.length)
  })

  test("a Claude app synced folder is named after the own Claude account of that uuid, else by its id", () => {
    const docx = ITEMS.at(-1)!
    expect(text(sourceOf(docx, ROOTS).label)).toBe("Claude Code · 동기화된 계정 acct-1")
    expect(text(sourceOf(docx, ROOTS, [{ label: "회사", uuid: "ACCT-1" }]).label)).toBe("Claude Code · 계정 회사")
    const plugin = decodeFound({
      ...at("claude-r1", "plugins/cache/m/p/1.0.0/skills/rules", "rules"),
      origin: "claude-plugin",
      plugin: { name: "p", marketplace: "m", installed: true },
    })
    expect(text(sourceOf(plugin, ROOTS).label)).toBe("Claude Code 플러그인 · m")
  })

  test("the head lists every root looked in, in place order, and says which shares another's folder", () => {
    const rows = mergeFound({ items: ITEMS, roots: ROOTS, loaded: LOADED, imports: [] })
    const head = lookedIn(ROOTS, rows)
    expect(head.map((place) => [text(place.label), place.state ?? null, place.count])).toEqual([
      ["Codex (기본 폴더)", null, 3],
      ["Codex · 폴더 backup\\.codex", null, 0],
      ["Codex · 계정 work", null, 2],
      ["Codex · 계정 side", null, 1],
      ["Codex · 계정 03", "shared", 0],
      ["Claude Code (기본)", null, 2],
    ])
    expect(text(head[4]!.shared!)).toBe("Codex (기본 폴더)")
  })
})

describe("one row per identical skill", () => {
  const rows = mergeFound({ items: ITEMS, roots: ROOTS, loaded: LOADED, imports: [] })
  const codexPdf = rows.filter((row) => row.item.name === "pdf" && row.item.origin === "codex")

  test("identical copies are one row with every place; the default home's copy represents them", () => {
    expect(rows.map((row) => [row.item.name, row.item.origin, row.places.length])).toEqual([
      ["docx", "claude-code", 1],
      ["imagegen", "codex", 1],
      ["pdf", "codex", 3],
      ["pdf", "codex", 1],
      ["pdf", "claude-code", 1],
      ["skill-creator", "codex", 2],
    ])
    const same = codexPdf[0]!
    expect([same.item.rootID, same.item.relative]).toEqual(["codex-r0", "skills/pdf"])
    expect(same.places.map((place) => [place.item.rootID, place.item.relative])).toEqual([
      ["codex-r0", "skills/pdf"],
      ["codex-r0", "skills/backup/pdf"],
      ["codex-p1", "skills/pdf"],
    ])
  })

  test("copies of the same name with other content stay separate and marked; content in use is in use", () => {
    expect(codexPdf.map((row) => [row.item.hash, row.differs, row.status])).toEqual([
      [H1, true, "inUse"],
      [H2, true, "available"],
    ])
    // The same pdf as ~/.claude/skills's: `이미 쓰는 중 (Claude Code (기본))`, no `pdf-codex` copy offered.
    expect(text(codexPdf[0]!.inUseBy!.label)).toBe("Claude Code (기본)")
    expect(rows.find((row) => row.item.origin === "claude-code" && row.item.name === "pdf")?.status).toBe("inUse")
    expect(rows.find((row) => row.item.name === "skill-creator")?.differs).toBe(false)
  })

  test("the representative: in use first, then own-import's copy, then the default home's, then the newest", () => {
    const imported = ITEMS.map((item) =>
      item.rootID === "codex-p1" && item.name === "pdf"
        ? decodeFound({ ...item, imported: { id: "pdf", changed: false } })
        : item,
    )
    const row = mergeFound({ items: imported, roots: ROOTS, loaded: [], imports: [] }).find(
      (entry) => entry.item.hash === H1 && entry.item.origin === "codex",
    )
    expect([String(row?.item.rootID), row?.status]).toEqual(["codex-p1", "imported"])
    const elsewhere = [
      at("codex-p1", "skills/pdf", "pdf", { hash: H1, modifiedAt: 1_100 }),
      at("codex-a1", "skills/pdf", "pdf", { hash: H1, modifiedAt: 5_000 }),
      at("codex-a1", "skills/old/pdf", "pdf", { hash: H1, modifiedAt: 9_000 }),
    ]
    // No default home's copy: the added folder (before the accounts), its shallower folder over a newer deeper one.
    expect(mergeFound({ items: elsewhere, roots: ROOTS, loaded: [], imports: [] })[0]?.item.relative).toBe("skills/pdf")
    expect(String(mergeFound({ items: elsewhere, roots: ROOTS, loaded: [], imports: [] })[0]?.item.rootID)).toBe("codex-a1")
  })

  test("content own-import already copied (by hash) is in this app; a changed source shows on its row", () => {
    const records = Schema.decodeUnknownSync(Schema.Array(OwnImport.SkillImport))([
      { id: "pdf-v2", origin: "codex", name: "pdf", importedAt: 1, hash: H2, files: 2 },
    ])
    expect(mergeFound({ items: ITEMS, roots: ROOTS, loaded: [], imports: records }).find((row) => row.item.hash === H2)?.status).toBe(
      "imported",
    )
    const changed = ITEMS.map((item) =>
      item.hash === H2 ? decodeFound({ ...item, imported: { id: "pdf-v2", changed: true } }) : item,
    )
    expect(mergeFound({ items: changed, roots: ROOTS, loaded: [], imports: [] }).find((row) => row.item.hash === H2)?.status).toBe(
      "changed",
    )
  })

  test("one folder reached through a link is one place; a link outside the roots waits for approval", () => {
    const target = at("codex-r0", "skills/_common/brand", "brand")
    const alias = at("codex-r0", "skills/brand", "brand", {
      real: target.directory,
      links: [{ relative: "", target: target.directory, kind: "folder", scope: "inside", state: "copy" }],
    })
    const outside = at("codex-r0", "skills/3d-assets", "3d-assets", {
      links: [
        {
          relative: "",
          target: "D:\\elsewhere\\3d-assets",
          kind: "folder",
          scope: "outside",
          state: "approve",
          linkKey: "lk-0123456789abcdef0123",
        },
      ],
    })
    const merged = mergeFound({ items: [alias, target, outside], roots: ROOTS, loaded: [], imports: [] })
    expect(merged.map((row) => [row.item.name, row.places.length, row.places[0]?.aliases.length, row.status])).toEqual([
      ["3d-assets", 1, 0, "approve"],
      ["brand", 1, 1, "available"],
    ])
    expect(merged[1]?.item.relative).toBe("skills/_common/brand")
    expect(importStatus(outside, [])).toBe("approve")
  })

  test("until the skills own loads are known, every row waits (checking) and none is offered (SK2 2026-10-25)", () => {
    const waiting = mergeFound({ items: ITEMS, roots: ROOTS, loaded: undefined, imports: [] })
    expect(new Set(waiting.map((row) => row.status))).toEqual(new Set(["checking"]))
    const label = (source: { readonly label: Label }) => text(source.label)
    expect(visibleRows(waiting, { query: "", filter: "available", builtins: true, label }).rows).toEqual([])
  })

  test("the same content core loads from a place that is no root: in use, and under another id said so", () => {
    const items = [
      at("codex-r0", "skills/pdf", "pdf", { hash: H1 }),
      at("codex-r0", "skills/translate-tool", "translate-tool", { hash: H2 }),
      at("codex-r0", "skills/notes", "notes", { hash: H3 }),
      at("codex-r0", "skills/pdf-old", "pdf-old", { hash: "4".repeat(64) }),
    ]
    const loaded = [
      { id: "pdf", path: "C:\\own\\skills\\pdf\\SKILL.md" },
      { id: "translate", path: "C:\\Users\\fixture\\.agents\\skills\\translate\\SKILL.md" },
      { id: "notes", path: "D:\\app\\.opencode\\skill\\notes\\SKILL.md" },
    ]
    const twins = [
      { id: "pdf", path: loaded[0]!.path, hash: H1 },
      { id: "translate", path: loaded[1]!.path, hash: H2 },
      { id: "notes", path: loaded[2]!.path, hash: H3 },
    ]
    const records = Schema.decodeUnknownSync(Schema.Array(OwnImport.SkillImport))([
      { id: "pdf-archive", origin: "codex", name: "pdf", importedAt: 1, hash: "4".repeat(64), files: 1 },
    ])
    const rows = mergeFound({ items, roots: ROOTS, loaded, imports: records, twins, directory: "D:\\app" })
    const row = (id: string) => rows.find((entry) => entry.item.id === id)!
    // own's skills folder by hand (no root): the same pdf is in use, not offered as `pdf-codex`.
    expect([row("pdf").status, text(row("pdf").inUseBy!.label), row("pdf").sameAs]).toEqual([
      "inUse",
      "전역",
      undefined,
    ])
    expect([row("notes").status, text(row("notes").inUseBy!.label)]).toEqual(["inUse", "프로젝트"])
    // Another id with the same content: in use, with the id it has here.
    expect([row("translate-tool").status, row("translate-tool").sameAs, row("translate-tool").inUseBy]).toEqual([
      "inUse",
      "translate",
      undefined,
    ])
    // own-import's copy of the same content under another id: in this app, said which.
    expect([row("pdf-old").status, row("pdf-old").sameAs]).toEqual(["imported", "pdf-archive"])
  })

  test("in use through a link: own loads the real folder (a junction into ~/.agents/skills)", () => {
    const linked = at("codex-r0", "skills/3d", "3d", { real: "C:\\Users\\fixture\\.agents\\skills\\3d" })
    expect(importStatus(linked, [{ id: "3d", path: "C:\\Users\\fixture\\.agents\\skills\\3d\\SKILL.md" }])).toBe("inUse")
  })
})

describe("search, filters and groups", () => {
  const rows = mergeFound({ items: ITEMS, roots: ROOTS, loaded: LOADED, imports: [] })
  const label = (source: { readonly label: Label }) => text(source.label)
  const names = (input: Partial<Parameters<typeof visibleRows>[1]>) =>
    visibleRows(rows, { query: "", filter: "all", builtins: false, label, ...input }).rows.map(
      (row) => `${row.item.name}:${row.item.origin}:${row.item.hash?.[0] ?? "-"}`,
    )

  test("bundled skills hide unless asked, and say how many", () => {
    expect(names({})).toEqual(["docx:claude-code:-", "pdf:codex:1", "pdf:codex:2", "pdf:claude-code:1"])
    expect(visibleRows(rows, { query: "", filter: "all", builtins: false, label }).hidden).toBe(2)
    expect(names({ builtins: true })).toHaveLength(6)
  })

  test("search by name, description, a place's name or its folder; every word must match", () => {
    expect(names({ query: "v2" })).toEqual(["pdf:codex:2"])
    expect(names({ query: "work" })).toEqual(["pdf:codex:1"])
    expect(names({ query: "backup pdf" })).toEqual(["pdf:codex:1"])
    expect(names({ query: "@docx" })).toEqual(["docx:claude-code:-"])
    expect(names({ query: "없는말" })).toEqual([])
  })

  test("filters: importable, already here, other content, not a fit; one place only", () => {
    expect(names({ filter: "available" })).toEqual(["docx:claude-code:-", "pdf:codex:2"])
    expect(names({ filter: "present" })).toEqual(["pdf:codex:1", "pdf:claude-code:1"])
    expect(names({ filter: "differs" })).toEqual(["pdf:codex:1", "pdf:codex:2"])
    expect(names({ filter: "incompatible" })).toEqual([])
    expect(names({ source: "codex-p2" })).toEqual(["pdf:codex:2"])
  })

  test("rows group by the representative's place, in place order; paths show below their root", () => {
    const groups = groupRows(visibleRows(rows, { query: "", filter: "all", builtins: true, label }).rows)
    expect(groups.map((group) => [text(group.source.label), group.rows.length])).toEqual([
      ["Codex (기본 폴더)", 3],
      ["Codex · 계정 side", 1],
      ["Claude Code (기본)", 1],
      ["Claude Code · 동기화된 계정 acct-1", 1],
    ])
    expect(shownPath(ITEMS[1]!)).toBe("skills\\backup\\pdf")
  })

  test("every new text has Korean and English", () => {
    const keys = Object.keys(skillsImportKo).filter(
      (key) =>
        key.startsWith("own.skills.import.source.") || key.startsWith("own.skills.detail.") || key.includes(".link"),
    ) as (keyof typeof skillsImportKo)[]
    expect(keys.length).toBeGreaterThan(30)
    expect(keys.filter((key) => !skillsImportEn[key])).toEqual([])
  })
})
