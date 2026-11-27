// Skills `가져오기` (03 §19.6.1, 09 §9): the status of each found skill (in use through a compatibility root, own's copy,
// changed source, not a fit, importable), the groups by source, rename suggestions and name conflicts with loaded
// skills, the updates list, the strings for every protocol problem and note, and the scope gate (the list is `read`,
// copying and installing are `local`). Fixtures go through the protocol's schemas; every path and skill is fake.
import { describe, expect, test } from "bun:test"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { createImportRpc } from "@/data/import-rpc"
import { ALL_SCOPES, type OwnScope } from "@/data/rpc"
import {
  importStatus,
  loadedConflict,
  pendingUpdates,
  shortCommit,
  suggestID,
  validSkillID,
  type FoundSkill,
} from "./import-model"
import { skillsImportEn, skillsImportKo } from "./import-strings"

const decodeFound = Schema.decodeUnknownSync(OwnImport.SkillFound)

/** A found skill as the client's typed answer holds it. */
function found(name: string, extra: Record<string, unknown> = {}): FoundSkill {
  return decodeFound({
    key: `sk-${name.replace(/[^a-z]/g, "")}0000`,
    origin: "codex",
    rootID: "codex-0123456789ab",
    name,
    id: name,
    directory: `C:\\Users\\fixture\\.codex\\skills\\${name}`,
    system: false,
    files: 1,
    bytes: 10,
    scripts: [],
    format: { status: "ok", problems: [], notes: [], ignored: [] },
    ...extra,
  })
}

describe("importStatus", () => {
  test("in use when own loads that very SKILL.md (compatibility root), by path without case or separator", () => {
    const claude = found("review", {
      origin: "claude-code",
      directory: "C:\\Users\\fixture\\.claude\\skills\\review",
    })
    expect(importStatus(claude, [{ id: "review", path: "c:/users/fixture/.claude/skills/review/SKILL.md" }])).toBe(
      "inUse",
    )
    // Same name elsewhere is not "in use": it is a name conflict (loadedConflict).
    expect(importStatus(found("review"), [{ id: "review", path: "C:/repo/.opencode/skills/review/SKILL.md" }])).toBe(
      "available",
    )
  })

  test("own's copy, a changed source, an incompatible format, else importable", () => {
    expect(importStatus(found("a", { imported: { id: "a", changed: false } }), [])).toBe("imported")
    expect(importStatus(found("a", { imported: { id: "a-codex", changed: true } }), [])).toBe("changed")
    const blocked = found("b", { format: { status: "incompatible", problems: ["hooks"], notes: [], ignored: [] } })
    expect(importStatus(blocked, [])).toBe("incompatible")
    expect(
      importStatus(found("c", { format: { status: "converted", problems: [], notes: [], ignored: [] } }), []),
    ).toBe("available")
  })
})

describe("ids and updates", () => {
  test("a rename suggestion is a valid id no loaded or imported skill has", () => {
    expect(suggestID("review", "claude-code", [])).toBe("review-claude")
    expect(suggestID("review", "claude-code", ["Review-Claude"])).toBe("review-claude-2")
    expect(suggestID("notes", "git", ["notes-repo", "notes-repo-2"])).toBe("notes-repo-3")
    const long = suggestID("a".repeat(64), "claude-plugin", [])
    expect(long.length).toBeLessThanOrEqual(64)
    expect(validSkillID(long)).toBe(true)
    expect(["ok", "a.b_c-1", "-x", "x.", "con", "a/b", "한글", ""].map(validSkillID)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })

  test("a loaded skill of the same id in another folder is a conflict; the folder itself is not", () => {
    const loaded = [{ id: "Review", path: "C:/repo/.opencode/skills/review/SKILL.md" }]
    expect(loadedConflict("review", "C:\\Users\\fixture\\.codex\\skills\\review", loaded)).toEqual(loaded[0])
    expect(loadedConflict("review", "C:\\repo\\.opencode\\skills\\review", loaded)).toBeUndefined()
    expect(loadedConflict("other", undefined, loaded)).toBeUndefined()
  })

  test("the updates list shows what is not the same; a commit is shown short", () => {
    const decode = Schema.decodeUnknownSync(Schema.Array(OwnImport.SkillUpdate))
    const items = decode([
      { id: "a", state: "same" },
      { id: "b", state: "changed", key: "sk-b0000" },
      { id: "c", state: "source_missing" },
    ])
    expect(pendingUpdates(items).map((item): string => item.id)).toEqual(["b", "c"])
    expect(shortCommit("0123456789abcdef0123")).toBe("0123456789ab")
  })
})

describe("strings", () => {
  test("every protocol problem, note, origin and fetch reason has Korean and English text", () => {
    const keys: (keyof typeof skillsImportKo)[] = [
      ...OwnImport.SkillProblem.literals.map((problem) => `own.skills.import.problem.${problem}` as const),
      ...OwnImport.SkillNote.literals.map((note) => `own.skills.import.note.${note}` as const),
      ...OwnImport.SkillOrigin.literals.map((origin) => `own.skills.import.origin.${origin}` as const),
      ...OwnImport.FetchProblem.literals.map((reason) => `own.skills.import.error.${reason}` as const),
    ]
    expect(keys.filter((key) => !skillsImportKo[key] || !skillsImportEn[key])).toEqual([])
    expect(skillsImportKo["own.skills.import.trust"]).toContain("실행 파일")
  })
})

describe("scope gate (09 §9.6)", () => {
  test("a phone with read sees the list; copying, previewing, installing and update checks need local", () => {
    const rpc = (scopes: ReadonlyArray<OwnScope>) =>
      createImportRpc({
        client: () => {
          throw new Error("not called")
        },
        control: async () => "C:/control",
        scopes: () => new Set(scopes),
      })
    const phone = rpc(["read", "prompt"])
    expect(phone.allowed("skills.list")).toBe(true)
    for (const method of ["skills.import", "skills.preview", "skills.install", "skills.updates"] as const)
      expect(phone.allowed(method)).toBe(false)
    const pc = rpc([...ALL_SCOPES])
    expect(pc.allowed("skills.import")).toBe(true)
    expect(pc.allowed("skills.install")).toBe(true)
  })
})
