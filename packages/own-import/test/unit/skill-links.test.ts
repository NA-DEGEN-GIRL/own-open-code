// Links in found skills (SK2, 2026-10-24; 09 §9.3, §9.4): a link (here a junction, which needs no Windows privilege;
// a file link only where this PC may make one) is copied as what it points to. A target in a skill area or a folder
// core loads skills from is followed at once; any other local target only after the user approved its key, and
// nothing of it is listed or read before; a missing target, a loop and the places own never reads are refused.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { Skills } from "../../src/skills/service.js"
import { Paths } from "../../src/sources/paths.js"
import { fixture, sentinels, writeText, type Fixture } from "../fixtures/make.js"
import { codexSkill, skillFolder, skillMd } from "../fixtures/skills.js"
import { start } from "../support/guard.js"

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

/** Whether this PC lets a process make a file symbolic link (Developer Mode or an elevated shell). */
const canSymlink = await (async () => {
  const item = await fixture()
  const target = await writeText(path.join(item.dir, "t.txt"), "x")
  const made = await fs.symlink(target, path.join(item.dir, "l.txt"), "file").then(
    () => true,
    () => false,
  )
  await item.cleanup()
  return made
})()

async function setup() {
  const item = await fixture()
  fixtures.push(item)
  const skillsDir = path.join(item.dir, "own-config", "skills")
  const elsewhere = await item.folder("elsewhere")
  const service = Skills.create({
    home: item.home,
    options: () => ({ ...item.options, skillsDir }),
    nonces: new Map(),
    env: {},
    homedir: item.dir,
  })
  return { item, skillsDir, elsewhere, service }
}

function value<T>(answer: Skills.Answer<T>): T {
  if (!answer.ok) throw new Error(`expected a value, got ${answer.error.type}`)
  return answer.value
}

const junction = (target: string, link: string) => fs.symlink(target, link, "junction")
const ID = Schema.decodeSync(OwnImport.SkillID)
const SLOW = 30_000

/** Every entry below `folder` is a plain file or folder (`lstat`), never a link. */
async function plain(folder: string) {
  const names = await fs.readdir(folder, { recursive: true })
  const kinds = await Promise.all(names.map(async (name) => (await fs.lstat(path.join(folder, name))).isSymbolicLink()))
  return kinds.every((link) => !link)
}

describe("links inside a skill area", () => {
  test(
    "a skill folder that is a junction in the skills area is the same skill, read fully, one real folder",
    async () => {
      const { item, service } = await setup()
      const target = await codexSkill(item.codex, "pdf")
      await fs.mkdir(path.join(item.codex, "skills", "_common"), { recursive: true })
      await fs.rename(target, path.join(item.codex, "skills", "_common", "pdf"))
      await junction(path.join(item.codex, "skills", "_common", "pdf"), path.join(item.codex, "skills", "alias"))
      const listed = value(await service.list()).items
      const rows = listed.map((row) => [row.relative, row.name, row.format.status, row.links?.[0]?.state ?? null])
      expect(rows.toSorted()).toEqual([
        ["skills/_common/pdf", "pdf", "ok", null],
        ["skills/alias", "pdf", "ok", "copy"],
      ])
      expect(new Set(listed.map((row) => row.real)).size).toBe(1)
      expect(listed.find((row) => row.relative === "skills/alias")?.format.notes).toEqual(["links_copied"])
    },
    SLOW,
  )

  test(
    "a junction inside a skill onto a shared folder of the skills area is copied as files",
    async () => {
      const { item, skillsDir, service } = await setup()
      await skillFolder(path.join(item.codex, "skills", "_shared", "assets"), { "logo.svg": "<svg/>", "a/b.txt": "b" })
      const folder = await codexSkill(item.codex, "brand")
      await junction(path.join(item.codex, "skills", "_shared", "assets"), path.join(folder, "assets"))
      const found = value(await service.list()).items.find((row) => row.name === "brand")
      expect(found?.links).toEqual([
        {
          relative: "assets",
          target: Paths.norm(path.join(item.codex, "skills", "_shared", "assets")),
          kind: "folder",
          scope: "inside",
          state: "copy",
        },
      ])
      expect(found?.files).toBe(3)
      const guard = await start([item.codex, item.claude])
      value(await service.import({ key: found!.key }))
      expect(await guard.stop()).toEqual([])
      const copy = path.join(skillsDir, "brand")
      expect(await fs.readFile(path.join(copy, "assets", "a", "b.txt"), "utf8")).toBe("b")
      expect(await plain(copy)).toBe(true)
    },
    SLOW,
  )

  test.skipIf(!canSymlink)(
    "a file link inside a skill onto a file of the skills area is copied as that file",
    async () => {
      const { item, skillsDir, service } = await setup()
      const shared = await writeText(path.join(item.codex, "skills", "_shared", "notes.md"), "# shared\n")
      const folder = await codexSkill(item.codex, "notes")
      await fs.symlink(shared, path.join(folder, "notes.md"), "file")
      const found = value(await service.list()).items.find((row) => row.name === "notes")
      expect(found?.links?.map((link) => [link.relative, link.kind, link.state])).toEqual([["notes.md", "file", "copy"]])
      value(await service.import({ key: found!.key }))
      const copied = path.join(skillsDir, "notes", "notes.md")
      expect(await fs.readFile(copied, "utf8")).toBe("# shared\n")
      expect((await fs.lstat(copied)).isSymbolicLink()).toBe(false)
    },
    SLOW,
  )

  test(
    "a junction into a folder core loads skills from (~/.agents/skills) needs no approval",
    async () => {
      const { item, service } = await setup()
      const agents = await skillFolder(path.join(item.dir, ".agents", "skills", "3d-assets"), {
        "SKILL.md": skillMd("3d-assets", "Make 3D assets"),
      })
      await fs.mkdir(path.join(item.codex, "skills"), { recursive: true })
      await junction(agents, path.join(item.codex, "skills", "3d-assets"))
      const found = value(await service.list()).items
      expect(found.map((row) => [row.name, row.description, row.links?.[0]?.scope, row.links?.[0]?.state])).toEqual([
        ["3d-assets", "Make 3D assets", "known", "copy"],
      ])
      // The real folder is the one core loads: own-web marks such a row `이미 쓰는 중` by it.
      expect(found[0]?.real).toBe(Paths.norm(agents))
    },
    SLOW,
  )
})

describe("links outside the roots", () => {
  test(
    "wait for approval; nothing of the target is listed or read before; approved, read, copied and recorded",
    async () => {
      const { item, skillsDir, elsewhere, service } = await setup()
      const target = await skillFolder(path.join(elsewhere, "3d-assets"), {
        "SKILL.md": skillMd("3d-assets", "Make 3D assets"),
        "scripts/make.py": "print(3)\n",
      })
      await fs.mkdir(path.join(item.codex, "skills"), { recursive: true })
      await junction(target, path.join(item.codex, "skills", "3d-assets"))
      const guard = await start([item.codex, elsewhere])
      const first = value(await service.list()).items
      expect(await guard.stop()).toEqual([])
      // Only the target's own kind was asked (one stat), never a listing or an open below it.
      const below = guard.reports.filter(
        (report) => report.real !== undefined && Paths.inside(report.real, elsewhere) && report.op !== "stat",
      )
      expect(below).toEqual([])
      expect(first).toHaveLength(1)
      const pending = first[0]!
      expect(pending).toMatchObject({ name: "3d-assets", files: 0, format: { status: "ok", problems: [] } })
      expect(pending.description).toBeUndefined()
      const link = pending.links?.[0]
      expect(link).toMatchObject({ relative: "", target: Paths.norm(target), scope: "outside", state: "approve" })
      expect(link?.linkKey).toMatch(/^lk-[0-9a-f]{20}$/)
      expect(await service.import({ key: pending.key })).toMatchObject({
        ok: false,
        error: { type: "skill_links", data: { reason: "unapproved", linkKeys: [link?.linkKey] } },
      })
      const approved = [link!.linkKey!]
      const read = value(await service.list({ approvedLinks: approved })).items[0]!
      expect(read).toMatchObject({ description: "Make 3D assets", files: 2, scripts: ["scripts/make.py"] })
      expect(read.links?.[0]).toMatchObject({ state: "copy", approved: true, linkKey: link?.linkKey })
      expect(read.format.notes).toEqual(["links_copied"])
      value(await service.import({ key: read.key, approvedLinks: approved }))
      const copy = path.join(skillsDir, "3d-assets")
      expect(await fs.readFile(path.join(copy, "scripts", "make.py"), "utf8")).toBe("print(3)\n")
      expect(await plain(copy)).toBe(true)
      expect((await fs.lstat(copy)).isSymbolicLink()).toBe(false)
      const listed = value(await service.list({ approvedLinks: approved }))
      expect(listed.imports[0]?.links).toEqual([{ relative: "", target: Paths.norm(target), linkKey: link!.linkKey! }])
      expect(listed.items[0]?.imported).toEqual({ id: ID("3d-assets"), changed: false })
      expect(value(await service.updates()).items).toEqual([{ id: ID("3d-assets"), state: "same", key: read.key }])

      // Re-pointed: the old approval no longer fits (the key holds the target), and the copy cannot be checked.
      const moved = await skillFolder(path.join(elsewhere, "other"), { "SKILL.md": skillMd("3d-assets", "Other") })
      await fs.rm(path.join(item.codex, "skills", "3d-assets"))
      await junction(moved, path.join(item.codex, "skills", "3d-assets"))
      expect(await service.import({ key: read.key, approvedLinks: approved, replace: true })).toMatchObject({
        ok: false,
        error: { type: "skill_links", data: { reason: "changed" } },
      })
      expect(value(await service.updates()).items.map((row) => row.state)).toEqual(["unknown"])
    },
    SLOW,
  )

  test(
    "links into another tool's logins, a root's other files or OWN_HOME are refused and never opened",
    async () => {
      const { item, service } = await setup()
      await sentinels(item.codex, "codex")
      await writeText(path.join(item.codex, "sessions", "2026", "x.jsonl"), "{}\n")
      await writeText(path.join(item.home, "secret.json"), "{}\n")
      const folder = await codexSkill(item.codex, "sneaky")
      await junction(path.join(item.codex, "sessions"), path.join(folder, "sessions"))
      await junction(item.home, path.join(folder, "home"))
      if (canSymlink) await fs.symlink(path.join(item.codex, "auth.json"), path.join(folder, "notes.md"), "file")
      const guard = await start([item.codex])
      const found = value(await service.list()).items.find((row) => row.name === "sneaky")
      expect(await guard.stop()).toEqual([])
      expect(found?.format).toMatchObject({ status: "incompatible", problems: ["links"] })
      expect(found?.links?.map((link) => [link.relative, link.state, link.reason]).toSorted()).toEqual(
        [
          ["home", "refused", "denied"],
          ["sessions", "refused", "denied"],
          ...(canSymlink ? [["notes.md", "refused", "denied"]] : []),
        ].toSorted(),
      )
      const touched = guard.reports.filter(
        (report) =>
          report.real !== undefined &&
          (Paths.inside(report.real, item.home) ||
            Paths.inside(report.real, path.join(item.codex, "sessions")) ||
            /auth\.json$/i.test(report.real)),
      )
      expect(touched).toEqual([])
    },
    SLOW,
  )

  test(
    "a dangling junction is broken, a loop is refused and the scan ends",
    async () => {
      const { item, elsewhere, service } = await setup()
      const gone = await item.folder("gone")
      const folder = await codexSkill(item.codex, "loopy")
      await junction(folder, path.join(folder, "loop"))
      await junction(gone, path.join(folder, "gone"))
      await fs.rm(gone, { recursive: true })
      await junction(path.join(elsewhere, "missing"), path.join(item.codex, "skills", "missing")).catch(async () => {
        // Windows makes a junction only onto a folder that exists: make one and remove it.
        await fs.mkdir(path.join(elsewhere, "missing"))
        await junction(path.join(elsewhere, "missing"), path.join(item.codex, "skills", "missing"))
        await fs.rm(path.join(elsewhere, "missing"), { recursive: true })
      })
      const listed = value(await service.list()).items
      const loopy = listed.find((row) => row.name === "loopy")
      expect(loopy?.links?.map((link) => [link.relative, link.reason]).toSorted()).toEqual([
        ["gone", "broken"],
        ["loop", "cycle"],
      ])
      const missing = listed.find((row) => row.relative === "skills/missing")
      expect(missing?.links?.[0]).toMatchObject({ relative: "", state: "refused", reason: "broken" })
      expect(missing?.format.problems).toEqual(["links"])
    },
    SLOW,
  )

  test(
    "a network target is refused before it is resolved; a target over the limits is too large",
    async () => {
      const { item, service } = await setup()
      const link = path.join(item.codex, "skills", "x")
      const other = await item.folder("real")
      await fs.mkdir(path.join(item.codex, "skills"), { recursive: true })
      await junction(other, link)
      const root = { ...Paths.defaults({ options: item.options })[0]!, reach: { allowed: [], blocked: [], roots: [] } }
      expect(await Paths.classifyLink(root, link, [], () => "\\\\server\\share\\skills\\x")).toMatchObject({
        ok: false,
        reason: "network",
      })
      expect(await Paths.classifyLink(root, link, [])).toMatchObject({ ok: true, kind: "folder", scope: "outside" })
      await fs.rm(link)
      const data = await skillFolder(
        path.join(item.codex, "skills", "_data"),
        Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`f${index}.txt`, "x"])),
      )
      const folder = await codexSkill(item.codex, "big")
      await junction(data, path.join(folder, "data"))
      const big = value(await service.list()).items.find((row) => row.name === "big")
      expect(big?.format.problems).toEqual(["too_large"])
    },
    SLOW,
  )
})
