// Skills found on this PC (09 §9.1–9.4): the list by source with format and import marks, copying into own's skills
// folder (conflicts, rename, replace, conversion), update checks, and the other tools' folders staying untouched
// (IG1's guard over the roots).
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { Skills } from "../../src/skills/service.js"
import { Paths } from "../../src/sources/paths.js"
import { fixture, sentinels, writeText, type Fixture } from "../fixtures/make.js"
import { claudeSkill, codeSkillMd, codexSkill, pluginSkill, skillFolder, skillMd } from "../fixtures/skills.js"
import { start } from "../support/guard.js"

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function setup() {
  const item = await fixture()
  fixtures.push(item)
  const skillsDir = path.join(item.dir, "own-config", "skills")
  const service = Skills.create({
    home: item.home,
    options: () => ({ ...item.options, skillsDir }),
    nonces: new Map(),
    env: {},
    homedir: item.dir,
  })
  return { item, skillsDir, service }
}

function value<T>(answer: Skills.Answer<T>): T {
  if (!answer.ok) throw new Error(`expected a value, got ${answer.error.type}`)
  return answer.value
}

const ID = Schema.decodeSync(OwnImport.SkillID)
/** A test lists the fixture roots several times; under a parallel run on Windows that can pass 5 s. */
const SLOW = 30_000

describe("skills.list", () => {
  test(
    "finds Codex (bundled too), Claude Code and plugin skills, by source, with format and scripts",
    async () => {
      const { item, service } = await setup()
      await codexSkill(item.codex, "release-notes", { files: { "scripts/collect.py": "print(1)\n" } })
      await codexSkill(item.codex, "imagegen", { system: true, yaml: "policy:\n  allow_implicit_invocation: false\n" })
      await claudeSkill(item.claude, "review", { "reference.md": "# Ref\n" })
      await pluginSkill(item.claude, { market: "official", plugin: "hookify", name: "writing-rules", installed: true })
      await pluginSkill(item.claude, {
        market: "official",
        plugin: "hookify",
        name: "writing-rules",
        installed: false,
      })
      await pluginSkill(item.claude, {
        market: "official",
        plugin: "dev",
        name: "hooky",
        installed: false,
        files: { "SKILL.md": skillMd("hooky", "Uses the plugin root", "", "Run ${CLAUDE_PLUGIN_ROOT}/x.sh\n") },
      })
      const listed = value(await service.list())
      expect(listed.directory).toBe(path.join(item.dir, "own-config", "skills"))
      expect(listed.imports).toEqual([])
      const rows = listed.items
        .map((row) => [
          row.origin,
          row.name,
          row.format.status,
          row.plugin?.name ?? null,
          row.plugin?.installed ?? null,
        ])
        .toSorted((a, b) => String(a[1]).localeCompare(String(b[1])))
      expect(rows).toEqual([
        ["claude-plugin", "hooky", "incompatible", "dev", false],
        ["codex", "imagegen", "converted", null, null],
        ["codex", "release-notes", "ok", null, null],
        ["claude-code", "review", "ok", null, null],
        // The installed copy wins over the marketplace's copy of the same plugin skill.
        ["claude-plugin", "writing-rules", "ok", "hookify", true],
      ])
      const notes = listed.items.find((row) => row.name === "release-notes")
      expect(notes).toMatchObject({
        id: "release-notes",
        system: false,
        files: 2,
        scripts: ["scripts/collect.py"],
        description: "Codex release-notes",
        directory: path.join(item.codex, "skills", "release-notes"),
      })
      expect(notes?.key).toMatch(/^sk-/)
      expect(listed.items.find((row) => row.name === "imagegen")?.system).toBe(true)
      expect(listed.items.find((row) => row.name === "hooky")?.format.problems).toEqual(["skill_variables"])
    },
    SLOW,
  )

  test(
    "a secret-looking file, a link or an over-large skill is incompatible and never read",
    async () => {
      const { item, service } = await setup()
      await codexSkill(item.codex, "with-env", { files: { ".env": "TOKEN=x\n" } })
      await codexSkill(item.codex, "with-key", { files: { "deploy.pem": "x\n" } })
      const target = await claudeSkill(item.claude, "linked-target")
      await fs.symlink(target, path.join(item.claude, "skills", "linked"), "junction")
      const big = path.join(item.codex, "skills", "big")
      await skillFolder(big, {
        "SKILL.md": skillMd("big", "many files"),
        ...Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`f/${index}.txt`, "x"])),
      })
      const guard = await start([item.codex, item.claude])
      const listed = value(await service.list())
      const problems = Object.fromEntries(listed.items.map((row) => [row.relative, row.format.problems]))
      expect(problems["skills/with-env"]).toEqual(["secret_file"])
      expect(problems["skills/with-key"]).toEqual(["secret_file"])
      // SK2: a junction onto a folder of the same skill area is followed: the same skill, one real folder.
      expect(problems["skills/linked"]).toEqual([])
      const linked = listed.items.filter((row) => row.real === listed.items.find((r) => r.relative === "skills/linked-target")?.real)
      expect(linked.map((row) => row.relative).toSorted()).toEqual(["skills/linked", "skills/linked-target"])
      expect(linked.find((row) => row.relative === "skills/linked")?.links).toEqual([
        { relative: "", target: Paths.norm(target), kind: "folder", scope: "inside", state: "copy" },
      ])
      expect(problems["skills/big"]).toEqual(["too_large"])
      expect(await guard.stop()).toEqual([])
      const opened = guard.reports.filter((report) => report.op === "open").map((report) => path.basename(report.path))
      expect(opened.filter((name) => name === ".env" || name === "deploy.pem")).toEqual([])
    },
    SLOW,
  )

  test(
    "never opens another tool's login or key files while scanning (IG1)",
    async () => {
      const { item, service } = await setup()
      await sentinels(item.codex, "codex")
      await sentinels(item.claude, "claude-code")
      await codexSkill(item.codex, "a")
      await claudeSkill(item.claude, "b")
      const guard = await start([item.codex, item.claude])
      const listed = value(await service.list())
      expect(listed.items.map((row) => row.name).toSorted()).toEqual(["a", "b"])
      expect(await guard.stop()).toEqual([])
      // The skill purpose reaches only the skill areas.
      expect(
        guard.reports
          .filter((report) => report.real !== undefined)
          .filter((report) => !/[\\/](skills|plugins)([\\/]|$)/i.test(report.path)),
      ).toEqual([])
    },
    SLOW,
  )
})

describe("skills.import", () => {
  test(
    "copies the folder into own's skills folder, records it and marks the source as imported",
    async () => {
      const { item, skillsDir, service } = await setup()
      await codexSkill(item.codex, "release-notes", {
        files: { "scripts/collect.py": "print(1)\n", "docs/a.md": "A\n" },
      })
      const found = value(await service.list()).items[0]
      const guard = await start([item.codex, item.claude])
      const done = value(await service.import({ key: found.key }))
      expect(await guard.stop()).toEqual([])
      expect(done).toEqual({ id: ID("release-notes"), directory: path.join(skillsDir, "release-notes") })
      const copied = path.join(skillsDir, "release-notes")
      expect(await fs.readFile(path.join(copied, "scripts", "collect.py"), "utf8")).toBe("print(1)\n")
      expect(await fs.readFile(path.join(copied, "SKILL.md"), "utf8")).toBe(
        skillMd("release-notes", "Codex release-notes"),
      )
      // A copy, not a link; the staging folder is gone.
      expect((await fs.lstat(copied)).isSymbolicLink()).toBe(false)
      expect((await fs.readdir(item.tmp)).filter((name) => name.startsWith("skill-"))).toEqual([])
      const listed = value(await service.list())
      expect(listed.items[0].imported).toEqual({ id: ID("release-notes"), changed: false })
      expect(listed.imports).toMatchObject([
        { id: "release-notes", origin: "codex", name: "release-notes", files: 3, relative: "skills/release-notes" },
      ])
      const stored = await Bun.file(path.join(item.home, "state", "skill-imports.json")).text()
      expect(stored).not.toContain("print(1)")
    },
    SLOW,
  )

  test(
    "a converted Codex skill's copy turns implicit use off; the source is not changed",
    async () => {
      const { item, skillsDir, service } = await setup()
      const folder = await codexSkill(item.codex, "imagegen", {
        system: true,
        yaml: "policy:\n  allow_implicit_invocation: false\n",
      })
      const before = await fs.readFile(path.join(folder, "SKILL.md"), "utf8")
      const found = value(await service.list()).items[0]
      value(await service.import({ key: found.key }))
      expect(await fs.readFile(path.join(folder, "SKILL.md"), "utf8")).toBe(before)
      expect(await fs.readFile(path.join(skillsDir, "imagegen", "SKILL.md"), "utf8")).toBe(
        before.replace("---\n", "---\ndisable-model-invocation: true\n"),
      )
      // Compared with the source, not the converted copy: not `changed`.
      expect(value(await service.list()).items[0].imported).toEqual({ id: ID("imagegen"), changed: false })
    },
    SLOW,
  )

  test(
    "a name own already has: the user's own skill only by renaming, own-import's copy also by replacing",
    async () => {
      const { item, skillsDir, service } = await setup()
      await skillFolder(path.join(skillsDir, "review"), { "SKILL.md": skillMd("review", "mine") })
      await claudeSkill(item.claude, "review")
      const found = value(await service.list()).items[0]
      expect(await service.import({ key: found.key })).toMatchObject({
        ok: false,
        error: { type: "skill_conflict", data: { id: "review", replaceable: false } },
      })
      expect(await service.import({ key: found.key, replace: true })).toMatchObject({
        ok: false,
        error: { type: "skill_conflict", data: { replaceable: false } },
      })
      expect(await fs.readFile(path.join(skillsDir, "review", "SKILL.md"), "utf8")).toBe(skillMd("review", "mine"))
      value(await service.import({ key: found.key, id: ID("review-claude") }))
      // Again into the copy: replaceable, and replaced with `replace`.
      expect(await service.import({ key: found.key, id: ID("review-claude") })).toMatchObject({
        ok: false,
        error: { type: "skill_conflict", data: { id: "review-claude", replaceable: true } },
      })
      await writeText(path.join(item.claude, "skills", "review", "SKILL.md"), skillMd("review", "Claude review v2"))
      expect(value(await service.list()).items[0].imported).toEqual({ id: ID("review-claude"), changed: true })
      value(await service.import({ key: found.key, id: ID("review-claude"), replace: true }))
      expect(await fs.readFile(path.join(skillsDir, "review-claude", "SKILL.md"), "utf8")).toContain("Claude review v2")
      expect(value(await service.list()).items[0].imported).toEqual({ id: ID("review-claude"), changed: false })
    },
    SLOW,
  )

  test(
    "incompatible and unknown skills are refused; without a skills folder nothing is copied",
    async () => {
      const { item, service } = await setup()
      await codexSkill(item.codex, "with-env", { files: { ".env": "TOKEN=x\n" } })
      const found = value(await service.list()).items[0]
      expect(await service.import({ key: found.key })).toMatchObject({
        ok: false,
        error: { type: "skill_incompatible", data: { problems: ["secret_file"] } },
      })
      expect(
        await service.import({ key: Schema.decodeSync(OwnImport.SkillKey)("sk-00000000000000000000") }),
      ).toMatchObject({ ok: false, error: { type: "skill_not_found" } })
      const bare = Skills.create({ home: item.home, options: () => item.options, nonces: new Map(), env: {} })
      expect(value(await bare.list()).directory).toBeNull()
      expect(await bare.import({ key: found.key })).toMatchObject({ ok: false, error: { type: "skills_unconfigured" } })
      expect(Skills.skillsDir({}, { OPENCODE_CONFIG_DIR: "C:\\cfg" })).toBe(path.join("C:\\cfg", "skills"))
    },
    SLOW,
  )
})

describe("skills.updates", () => {
  test(
    "compares each local copy with its source; a deleted copy is no longer listed",
    async () => {
      const { item, skillsDir, service } = await setup()
      await codexSkill(item.codex, "a")
      await codexSkill(item.codex, "b")
      const listed = value(await service.list()).items
      for (const row of listed) value(await service.import({ key: row.key }))
      await writeText(path.join(item.codex, "skills", "a", "extra.md"), "new\n")
      await fs.rm(path.join(item.codex, "skills", "b"), { recursive: true })
      const updates = value(await service.updates()).items.toSorted((x, y) => x.id.localeCompare(y.id))
      expect(updates.map((row): [string, string] => [row.id, row.state])).toEqual([
        ["a", "changed"],
        ["b", "source_missing"],
      ])
      expect(updates[0].key).toBe(listed.find((row) => row.name === "a")?.key)
      await fs.rm(path.join(skillsDir, "a"), { recursive: true })
      expect(value(await service.list()).imports.map((row): string => row.id)).toEqual(["b"])
    },
    SLOW,
  )
})

describe("skills.remove (SM)", () => {
  test(
    "removes own-import's copy and its record; the source and folders own-import did not make stay",
    async () => {
      const { item, skillsDir, service } = await setup()
      const source = await codexSkill(item.codex, "release-notes")
      const found = value(await service.list()).items[0]
      value(await service.import({ key: found.key }))
      await skillFolder(path.join(skillsDir, "handmade"), { "SKILL.md": skillMd("handmade", "the user's own") })
      const guard = await start([item.codex, item.claude])
      expect(value(await service.remove({ id: ID("release-notes") }))).toEqual({ id: ID("release-notes") })
      expect(await guard.stop()).toEqual([])
      expect(await fs.readdir(skillsDir)).toEqual(["handmade"])
      expect(await fs.readFile(path.join(source, "SKILL.md"), "utf8")).toBe(
        skillMd("release-notes", "Codex release-notes"),
      )
      const listed = value(await service.list())
      expect(listed.imports).toEqual([])
      expect(listed.items[0].imported).toBeUndefined()
      expect((await fs.readdir(item.tmp)).filter((name) => name.startsWith("skill-"))).toEqual([])
      for (const id of ["handmade", "release-notes"]) {
        const refused = await service.remove({ id: ID(id) })
        expect(refused.ok ? undefined : refused.error).toMatchObject({ type: "skill_not_imported", data: { id } })
      }
      expect(await fs.readdir(skillsDir)).toEqual(["handmade"])
    },
    SLOW,
  )
})

describe("skills.detail (SK2)", () => {
  test(
    "a found skill: every frontmatter key, the body, the files, the hash and own-import's copy of it",
    async () => {
      const { item, service } = await setup()
      await codexSkill(item.codex, "release-notes", {
        files: {
          "SKILL.md": skillMd(
            "release-notes",
            "Write release notes",
            "version: 1.2.0\nallowed-tools: [Read, Grep]\nlicense: MIT\n",
            "# Release notes\n\n<script>alert(1)</script>\n",
          ),
          "scripts/collect.py": "print(1)\n",
        },
      })
      const found = value(await service.list()).items[0]!
      const shown = value(await service.detail({ key: found.key }))
      expect(shown).toMatchObject({
        name: "release-notes",
        description: "Write release notes",
        directory: found.directory,
        frontmatter: [
          { key: "name", value: "release-notes" },
          { key: "description", value: "Write release notes" },
          { key: "version", value: "1.2.0" },
          { key: "allowed-tools", value: "Read, Grep" },
          { key: "license", value: "MIT" },
        ],
        // The body as text; the client renders it as untrusted markdown.
        body: "\n# Release notes\n\n<script>alert(1)</script>\n",
        truncated: false,
        fileCount: 2,
      })
      expect(shown.files.map((file) => file.relative)).toEqual(["SKILL.md", "scripts/collect.py"])
      expect(shown.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(shown.imported).toBeUndefined()
      value(await service.import({ key: found.key }))
      expect(value(await service.detail({ key: found.key })).imported).toMatchObject({
        record: { id: "release-notes", hash: shown.hash },
        source: "same",
      })
      expect(
        await service.detail({ key: Schema.decodeSync(OwnImport.SkillKey)("sk-00000000000000000000") }),
      ).toMatchObject({ ok: false, error: { type: "skill_not_found" } })
    },
    SLOW,
  )

  test(
    "a hostile SKILL.md (an alias bomb of 9 levels) answers fast with the values it does not show marked",
    async () => {
      const { item, service } = await setup()
      const levels = [
        `l0: &l0 [${Array(9).fill('"lol"')}]`,
        ...Array.from({ length: 8 }, (_, index) => `l${index + 1}: &l${index + 1} [${Array(9).fill(`*l${index}`)}]`),
      ]
      await codexSkill(item.codex, "bomb", {
        files: { "SKILL.md": skillMd("bomb", "Explodes", `${levels.join("\n")}\n`) },
      })
      const found = value(await service.list()).items[0]!
      const started = performance.now()
      const shown = value(await service.detail({ key: found.key }))
      expect(performance.now() - started).toBeLessThan(5_000)
      expect(shown.name).toBe("bomb")
      expect(shown.frontmatter.find((entry) => entry.key === "l8")).toEqual({
        key: "l8",
        value: "",
        omitted: "aliases",
      })
      expect(shown.frontmatter.filter((entry) => entry.omitted === "aliases").map((entry) => entry.key)).toEqual([
        "l4",
        "l5",
        "l6",
        "l7",
        "l8",
      ])
      expect(shown.body).toBe("\nFollow the steps.\n")
    },
    SLOW,
  )

  test(
    "a SKILL.md over 1 MiB is too large, not missing: the list says its size, the detail too; over 500 files say so",
    async () => {
      const { item, service } = await setup()
      const huge = skillMd("huge", "Too big", "", `${"x".repeat(1024 * 1024)}\n`)
      await codexSkill(item.codex, "huge", { files: { "SKILL.md": huge } })
      await codexSkill(item.codex, "many", {
        files: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`docs/${index}.md`, "x\n"])),
      })
      const items = value(await service.list()).items
      const big = items.find((entry) => entry.id === "huge")!
      expect(big.format).toMatchObject({
        status: "incompatible",
        problems: ["too_large"],
        large: { skillMd: Buffer.byteLength(huge) },
      })
      const shown = value(await service.detail({ key: big.key }))
      expect(shown.skillMd).toEqual({ state: "too_large", size: Buffer.byteLength(huge) })
      expect(shown.frontmatter).toEqual([])
      expect(shown.body).toBeUndefined()
      // More than 500: the walk stops at 501, so the list says "over 500", not a count it never finished.
      const many = items.find((entry) => entry.id === "many")!
      expect(many.format.problems).toEqual(["too_large"])
      expect(many.format.large?.files).toBeGreaterThan(500)
      expect(value(await service.detail({ key: many.key })).skillMd).toBeUndefined()
    },
    SLOW,
  )

  test(
    "own-import's copy: read from own's skills folder, with its record and the source now",
    async () => {
      const { item, service } = await setup()
      const source = await codexSkill(item.codex, "imagegen", { yaml: "policy:\n  allow_implicit_invocation: false\n" })
      const found = value(await service.list()).items[0]!
      value(await service.import({ key: found.key }))
      const copy = value(await service.detail({ copy: ID("imagegen") }))
      // The copy as it is (converted), the source's hash it was copied from.
      expect(copy.frontmatter[0]).toEqual({ key: "disable-model-invocation", value: "true" })
      expect(copy.imported).toMatchObject({ record: { id: "imagegen", origin: "codex" }, source: "same" })
      expect(copy.hash).toBe(copy.imported?.record.hash)
      await writeText(path.join(source, "extra.md"), "new\n")
      expect(value(await service.detail({ copy: ID("imagegen") })).imported?.source).toBe("changed")
      await fs.rm(source, { recursive: true })
      expect(value(await service.detail({ copy: ID("imagegen") })).imported?.source).toBe("source_missing")
      expect(await service.detail({ copy: ID("other") })).toMatchObject({ ok: false, error: { type: "skill_not_found" } })
    },
    SLOW,
  )

  test(
    "a skill core loads in a project: the folder core reports, read like another tool's, keys never opened",
    async () => {
      const item = await fixture()
      fixtures.push(item)
      const project = await item.folder("project")
      const folder = await skillFolder(path.join(project, ".claude", "skills", "deploy"), {
        "SKILL.md": skillMd("deploy", "Deploy the app", "version: 3\n"),
        "deploy.pem": "secret\n",
        "notes.md": "n\n",
      })
      const flat = await writeText(
        path.join(project, ".opencode", "skill", "quick.md"),
        skillMd("quick", "A quick one", "", "Do it.\n"),
      )
      const service = Skills.create({
        home: item.home,
        options: () => item.options,
        nonces: new Map(),
        env: {},
        homedir: item.dir,
        loaded: async (directory) =>
          directory === project
            ? [
                { id: "deploy", path: path.join(folder, "SKILL.md") },
                { id: "quick", path: flat },
                { id: "builtin", path: "/builtin/skill/SKILL.md" },
              ]
            : undefined,
      })
      const reports: Paths.Report[] = []
      const stop = Paths.observe((report) => reports.push(report))
      const deploy = value(await service.detail({ directory: project, loaded: "deploy" }))
      stop()
      expect(deploy).toMatchObject({ name: "deploy", directory: Paths.norm(folder), fileCount: 2 })
      expect(deploy.frontmatter.find((entry) => entry.key === "version")?.value).toBe("3")
      expect(deploy.files.map((file) => file.relative)).toEqual(["SKILL.md", "notes.md"])
      // A secret-looking file makes the skill unreadable as a whole: no hash, and it was never opened.
      expect(deploy.hash).toBeUndefined()
      expect(deploy.format?.problems).toEqual(["secret_file"])
      expect(reports.filter((report) => report.op === "open" && /deploy\.pem$/.test(report.path))).toEqual([])
      const quick = value(await service.detail({ directory: project, loaded: "quick" }))
      expect(quick).toMatchObject({ name: "quick", body: "\nDo it.\n", fileCount: 1, files: [{ relative: "quick.md" }] })
      expect(quick.hash).toMatch(/^[0-9a-f]{64}$/)
      for (const loaded of ["builtin", "missing"])
        expect(await service.detail({ directory: project, loaded })).toMatchObject({
          ok: false,
          error: { type: "skill_not_found" },
        })
      expect(await service.detail({ directory: item.dir, loaded: "deploy" })).toMatchObject({ ok: false })
    },
    SLOW,
  )
})

describe("09 §9.12: a SKILL.md whose frontmatter is code", () => {
  test(
    "list, detail and import over Codex, Claude Code, a marketplace clone and core's skills never run it; refused",
    async () => {
      const item = await fixture()
      fixtures.push(item)
      const marker = (name: string) => path.join(item.dir, `ran-${name}`)
      await codexSkill(item.codex, "codex-js", { files: { "SKILL.md": codeSkillMd(marker("codex")) } })
      await claudeSkill(item.claude, "claude-js", { "SKILL.md": codeSkillMd(marker("claude"), "---javascript") })
      await pluginSkill(item.claude, {
        market: "someone-else",
        plugin: "tools",
        name: "plugin-js",
        installed: false,
        files: { "SKILL.md": codeSkillMd(marker("plugin"), "--- js") },
      })
      const project = await item.folder("project")
      const folder = await skillFolder(path.join(project, ".claude", "skills", "loaded-js"), {
        "SKILL.md": codeSkillMd(marker("loaded")),
      })
      const flat = await writeText(path.join(project, ".opencode", "skill", "flat-js.md"), codeSkillMd(marker("flat")))
      const service = Skills.create({
        home: item.home,
        options: () => ({ ...item.options, skillsDir: path.join(item.dir, "own-config", "skills") }),
        nonces: new Map(),
        env: {},
        homedir: item.dir,
        loaded: async (directory) =>
          directory === project
            ? [
                { id: "loaded-js", path: path.join(folder, "SKILL.md") },
                { id: "flat-js", path: flat },
              ]
            : undefined,
      })
      const refused = { status: "incompatible", problems: ["frontmatter_language"] }
      const ran = async () => (await fs.readdir(item.dir)).filter((name) => name.startsWith("ran-"))
      for (const row of value(await service.list()).items) await service.detail({ key: row.key })
      await service.detail({ directory: project, loaded: "loaded-js" })
      await service.detail({ directory: project, loaded: "flat-js" })
      // Nothing ran (on 8d8c7960f3 the list and the details wrote every marker).
      expect(await ran()).toEqual([])
      for (const hashes of [false, true]) {
        const listed = value(await service.list({ hashes }))
        expect(listed.items.map((row): unknown[] => [row.id, row.format.status, row.format.problems]).toSorted()).toEqual([
          ["claude-js", "incompatible", ["frontmatter_language"]],
          ["codex-js", "incompatible", ["frontmatter_language"]],
          ["plugin-js", "incompatible", ["frontmatter_language"]],
        ])
        // The name is the folder's: nothing of the file was read.
        expect(listed.items.map((row) => row.name).toSorted()).toEqual(["claude-js", "codex-js", "plugin-js"])
        for (const row of listed.items) {
          const shown = value(await service.detail({ key: row.key }))
          expect(shown).toMatchObject({ name: row.id, frontmatter: [], format: refused })
          expect(await service.import({ key: row.key })).toMatchObject({
            ok: false,
            error: { type: "skill_incompatible", data: { problems: ["frontmatter_language"] } },
          })
        }
      }
      expect(value(await service.list({ directory: project })).items).toHaveLength(3)
      expect(value(await service.detail({ directory: project, loaded: "loaded-js" }))).toMatchObject({
        name: "loaded-js",
        frontmatter: [],
        format: refused,
      })
      expect(value(await service.detail({ directory: project, loaded: "flat-js" }))).toMatchObject({
        name: "flat-js",
        frontmatter: [],
      })
      expect(await ran()).toEqual([])
    },
    SLOW,
  )
})
