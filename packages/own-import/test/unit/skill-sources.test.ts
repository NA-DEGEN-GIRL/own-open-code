// Where the skills list looks and what tells copies apart (SK2, 2026-10-24; 09 §9.1, §9.2): the codex-multi-provider
// account homes found through its state.json only (never an auth.json), a home whose `skills` folder is a junction
// onto another root's (`sharedWith`), the Claude app's synced folders, removed and half-installed skill folders left
// out, and the fields own-web merges copies with (relative, real, modifiedAt, version, hash).
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Skills } from "../../src/skills/service.js"
import { Paths } from "../../src/sources/paths.js"
import { fixture, SENTINEL, writeText, type Fixture } from "../fixtures/make.js"
import { claudeSkill, codexSkill, skillFolder, skillMd } from "../fixtures/skills.js"
import { start } from "../support/guard.js"

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

const SLOW = 30_000
const PDF = { "SKILL.md": skillMd("pdf", "Read and write PDF files"), "scripts/fill.py": "print('pdf')\n" }

/**
 * The design's fixture (09 §9.2 SK2): the default Codex home with `pdf`, `backup\pdf` and two bundled skills; account
 * 01 with the same `pdf` and `skill-creator`; account 02 with a different `pdf` (version 2.0.0, newer); account 03
 * whose `skills` is a junction onto the default home's; Claude Code with the same `pdf` and a synced Claude app folder.
 */
async function world() {
  const item = await fixture()
  fixtures.push(item)
  const center = await item.folder("control-center")
  const profiles = ["01", "02", "03"].map((id) => path.join(center, "profiles", id, "codex"))
  await writeText(
    path.join(center, "state.json"),
    JSON.stringify({
      version: 1,
      profiles: [
        { id: "01", alias: "work", home: "C:\\ignored", auth_mode: "chatgpt" },
        { id: "02", alias: "side" },
        { id: "03", alias: null },
      ],
    }),
  )
  await Promise.all(profiles.map((home) => writeText(path.join(home, "auth.json"), `${SENTINEL}\n`)))
  const old = new Date("2026-09-01T00:00:00Z")
  const writeOld = async (folder: string, files: Readonly<Record<string, string>>) => {
    await skillFolder(folder, files)
    // Only the modification time: an access time over an hour old makes NTFS write the next read's (a watch event).
    await Promise.all(
      Object.keys(files).map((file) => fs.utimes(path.join(folder, ...file.split("/")), new Date(), old)),
    )
    return folder
  }
  await writeOld(path.join(item.codex, "skills", "pdf"), PDF)
  await writeOld(path.join(item.codex, "skills", "backup", "pdf"), PDF)
  await codexSkill(item.codex, "skill-creator", { system: true })
  await codexSkill(item.codex, "imagegen", { system: true })
  await skillFolder(path.join(item.codex, "skills", ".trash", "gone"), { "SKILL.md": skillMd("gone", "Removed") })
  await skillFolder(path.join(item.codex, "skills", ".staging", "half"), { "SKILL.md": skillMd("half", "Half") })
  await writeOld(path.join(profiles[0]!, "skills", "pdf"), PDF)
  await codexSkill(profiles[0]!, "skill-creator", { system: true })
  await skillFolder(path.join(profiles[1]!, "skills", "pdf"), {
    "SKILL.md": skillMd("pdf", "Read and write PDF files, v2", "version: 2.0.0\n"),
    "scripts/fill.py": "print('pdf 2')\n",
  })
  await fs.mkdir(profiles[2]!, { recursive: true })
  await fs.symlink(path.join(item.codex, "skills"), path.join(profiles[2]!, "skills"), "junction")
  await writeOld(path.join(item.claude, "skills", "pdf"), PDF)
  await skillFolder(path.join(item.claude, "skills", "synced", "org-1_acct-1", "docx"), {
    "SKILL.md": skillMd("docx", "Word files"),
  })
  const options = { ...item.options, controlCenter: center }
  const service = Skills.create({ home: item.home, options: () => options, nonces: new Map(), env: {}, homedir: item.dir })
  return { item, center, profiles, service, options }
}

function value<T>(answer: Skills.Answer<T>): T {
  if (!answer.ok) throw new Error(`expected a value, got ${answer.error.type}`)
  return answer.value
}

describe("skills.list sources (SK2)", () => {
  test(
    "account homes from state.json only, labelled by alias; a junction-shared home says whose folder it is",
    async () => {
      const { item, center, profiles, service } = await world()
      const guard = await start([center])
      const listed = value(await service.list())
      expect(await guard.stop()).toEqual([])
      // No auth.json was opened or stat'ed: the homes come from the ids in state.json.
      expect(guard.reports.filter((report) => /auth\.json$/i.test(report.path))).toEqual([])
      const codex = listed.roots.find((root) => root.directory === Paths.norm(item.codex))
      expect(listed.roots.map((root) => [root.kind, root.origin, root.account?.id ?? null, root.label])).toEqual([
        ["codex", "option", null, `Codex · ${Paths.norm(item.codex)}`],
        ["claude-code", "option", null, `Claude Code · ${Paths.norm(item.claude)}`],
        ["codex", "profile", "01", "Codex · work"],
        ["codex", "profile", "02", "Codex · side"],
        ["codex", "profile", "03", "Codex · 03"],
      ])
      expect(listed.roots[2]?.account).toEqual({ app: "codex-multi-provider", id: "01", alias: "work" })
      expect(listed.roots[2]?.directory).toBe(Paths.norm(profiles[0]!))
      expect(listed.roots[4]?.sharedWith).toBe(codex?.rootID)
      expect(listed.roots.filter((root) => root.sharedWith !== undefined)).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "every place a skill was found, with what tells copies apart; removed and half-installed folders left out",
    async () => {
      const { item, profiles, service } = await world()
      const listed = value(await service.list())
      const rootOf = new Map(listed.roots.map((root) => [root.rootID, root]))
      const rows = listed.items
        .map((row) => [row.name, rootOf.get(row.rootID)?.account?.id ?? rootOf.get(row.rootID)?.kind, row.relative])
        .toSorted((a, b) => String(a).localeCompare(String(b)))
      expect(rows).toEqual([
        ["docx", "claude-code", "skills/synced/org-1_acct-1/docx"],
        ["imagegen", "codex", "skills/.system/imagegen"],
        ["pdf", "01", "skills/pdf"],
        ["pdf", "02", "skills/pdf"],
        ["pdf", "claude-code", "skills/pdf"],
        ["pdf", "codex", "skills/backup/pdf"],
        ["pdf", "codex", "skills/pdf"],
        ["skill-creator", "01", "skills/.system/skill-creator"],
        ["skill-creator", "codex", "skills/.system/skill-creator"],
      ])
      const pdfs = listed.items.filter((row) => row.name === "pdf")
      const hashes = new Set(pdfs.map((row) => row.hash))
      expect(hashes.size).toBe(2)
      const other = pdfs.find((row) => row.directory.startsWith(Paths.norm(profiles[1]!)))
      expect(other?.version).toBe("2.0.0")
      expect(pdfs.filter((row) => row.hash === other?.hash)).toHaveLength(1)
      expect(pdfs.every((row) => row.hash?.length === 64)).toBe(true)
      expect(pdfs.every((row) => (row.modifiedAt ?? 0) > 0)).toBe(true)
      expect(other!.modifiedAt!).toBeGreaterThan(pdfs.find((row) => row.relative === "skills/backup/pdf")!.modifiedAt!)
      const creators = listed.items.filter((row) => row.name === "skill-creator")
      expect(creators[0]?.hash).toBeDefined()
      expect(creators[0]?.hash).toBe(creators[1]?.hash)
      // A skill found once is not hashed (the list stays cheap); `hashes` asks for all.
      expect(listed.items.find((row) => row.name === "imagegen")?.hash).toBeUndefined()
      expect(value(await service.list({ hashes: true })).items.every((row) => row.hash !== undefined)).toBe(true)
      expect(listed.items.find((row) => row.name === "docx")?.synced).toEqual({
        folder: "org-1_acct-1",
        org: "org-1",
        account: "acct-1",
      })
      expect(listed.items.every((row) => row.real === Paths.norm(row.directory))).toBe(true)
      expect(listed.items.find((row) => row.relative === "skills/pdf" && row.rootID === listed.roots[0]?.rootID)).toBeDefined()
      expect(item).toBeDefined()
    },
    SLOW,
  )

  test(
    "without a control center (the option null, or test roots without it) no account home is read",
    async () => {
      const { item, service, options } = await world()
      expect(value(await service.list()).roots).toHaveLength(5)
      const none = Skills.create({
        home: item.home,
        options: () => ({ ...options, controlCenter: null }),
        nonces: new Map(),
        env: {},
        homedir: item.dir,
      })
      expect(value(await none.list()).roots.map((root) => root.origin)).toEqual(["option", "option"])
      expect(Paths.controlCenter({ roots: { codex: [item.codex] } })).toBeUndefined()
      expect(Paths.controlCenter({ controlCenter: null })).toBeUndefined()
      expect(Paths.controlCenter({ controlCenter: "D:\\cc" })).toBe("D:\\cc")
      expect(Paths.controlCenter({})).toBe("D:\\#Projects\\codex-multi-provider\\work\\control-center")
    },
    SLOW,
  )

  test(
    "an account whose whole codex home is a junction onto ~/.codex shares that home's skills (one place, not two)",
    async () => {
      const { item, center, service } = await world()
      const home = path.join(center, "profiles", "04", "codex")
      await fs.mkdir(path.dirname(home), { recursive: true })
      await fs.symlink(item.codex, home, "junction")
      await writeText(
        path.join(center, "state.json"),
        JSON.stringify({
          version: 1,
          profiles: [
            { id: "01", alias: "work" },
            { id: "04", alias: "mirror" },
          ],
        }),
      )
      const listed = value(await service.list())
      const codex = listed.roots.find((root) => root.directory === Paths.norm(item.codex))!
      const mirror = listed.roots.find((root) => root.account?.id === "04")!
      expect(mirror.sharedWith).toBe(codex.rootID)
      expect(codex.sharedWith).toBeUndefined()
      // Its skills are the default home's only, not listed again under the account.
      expect(listed.items.filter((row) => row.rootID === mirror.rootID)).toEqual([])
      expect(listed.items.filter((row) => row.rootID === codex.rootID && row.relative === "skills/pdf")).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "skills core loads outside the roots (own's folder by hand, ~/.agents/skills, the project) answer their hashes",
    async () => {
      const item = await fixture()
      fixtures.push(item)
      const project = await item.folder("project")
      const ownSkills = await item.folder("own-config", "skills")
      await skillFolder(path.join(item.codex, "skills", "pdf"), PDF)
      await skillFolder(path.join(item.codex, "skills", "translate-tool"), {
        "SKILL.md": skillMd("translate", "Translate text"),
        "examples/a.md": "Hallo\n",
      })
      await skillFolder(path.join(item.codex, "skills", "notes"), { "SKILL.md": skillMd("notes", "Take notes") })
      const placed = await skillFolder(path.join(ownSkills, "pdf"), PDF)
      const agents = await skillFolder(path.join(item.dir, ".agents", "skills", "translate"), {
        "SKILL.md": skillMd("translate", "Translate text"),
        "examples/a.md": "Hallo\n",
      })
      const local = await skillFolder(path.join(project, ".opencode", "skill", "notes"), {
        "SKILL.md": skillMd("notes", "Take other notes"),
      })
      const service = Skills.create({
        home: item.home,
        options: () => ({ ...item.options, skillsDir: ownSkills }),
        nonces: new Map(),
        env: {},
        homedir: item.dir,
        loaded: async (directory) =>
          directory === project
            ? [
                { id: "pdf", path: path.join(placed, "SKILL.md") },
                { id: "translate", path: path.join(agents, "SKILL.md") },
                { id: "notes", path: path.join(local, "SKILL.md") },
                { id: "builtin", path: "/builtin/skill/SKILL.md" },
              ]
            : undefined,
      })
      // Without a project nothing core loads is read.
      const plain = value(await service.list())
      expect(plain.loaded).toBeUndefined()
      expect(plain.items.every((row) => row.hash === undefined)).toBe(true)
      const listed = value(await service.list({ directory: project }))
      const found = (id: string) => listed.items.find((row) => row.id === id)!
      // Same files, so both sides are hashed: own's hand-placed pdf and ~/.agents' translate are the same content.
      expect(listed.loaded?.map((entry) => [entry.id, entry.path])).toEqual([
        ["pdf", Paths.norm(path.join(placed, "SKILL.md"))],
        ["translate", Paths.norm(path.join(agents, "SKILL.md"))],
      ])
      expect(listed.loaded?.find((entry) => entry.id === "pdf")?.hash).toBe(found("pdf").hash)
      expect(listed.loaded?.find((entry) => entry.id === "translate")?.hash).toBe(found("translate-tool").hash)
      // The project's notes has other files (sizes): neither read nor answered.
      expect(found("notes").hash).toBeUndefined()
      // A second list reads no file again for the hash while the files stay the same (SKILL.md is read for the format).
      const reports: Paths.Report[] = []
      const stop = Paths.observe((report) => reports.push(report))
      const again = value(await service.list({ directory: project }))
      stop()
      expect(again.loaded).toEqual(listed.loaded)
      expect(reports.filter((report) => report.op === "open" && /examples/.test(report.path))).toEqual([])
    },
    SLOW,
  )

  test(
    "an account home added by hand keeps its place and gets the account",
    async () => {
      const { item, profiles, service } = await world()
      await Paths.configure(Paths.sources(item.home), [{ kind: "codex", directory: profiles[1]! }])
      const roots = value(await service.list()).roots
      const added = roots.filter((root) => root.directory === Paths.norm(profiles[1]!))
      expect(added).toHaveLength(1)
      expect(added[0]).toMatchObject({ added: true, origin: "added", account: { id: "02", alias: "side" } })
      expect(roots.indexOf(added[0]!)).toBe(2)
    },
    SLOW,
  )
})

describe("format false positives (SK2)", () => {
  test(
    "an .env template, a lock file and a package folder do not make a skill incompatible",
    async () => {
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
      await codexSkill(item.codex, "tool", {
        files: {
          ".env.example": "TOKEN=\n",
          "uv.lock": "version = 1\n",
          ...Object.fromEntries(Array.from({ length: 520 }, (_, index) => [`node_modules/p${index}/index.js`, "x"])),
          ".venv/bin/python": "x",
          "src/main.py": "print(1)\n",
        },
      })
      await codexSkill(item.codex, "secret", { files: { ".env": "TOKEN=x\n" } })
      const listed = value(await service.list()).items
      const tool = listed.find((row) => row.name === "tool")
      expect(tool?.format).toMatchObject({ status: "ok", problems: [], notes: ["left_out_folders"] })
      expect(tool?.files).toBe(4)
      expect(listed.find((row) => row.name === "secret")?.format.problems).toEqual(["secret_file"])
      const guard = await start([item.codex, item.claude])
      value(await service.import({ key: tool!.key }))
      expect(await guard.stop()).toEqual([])
      const copy = path.join(skillsDir, "tool")
      expect((await fs.readdir(copy, { recursive: true })).map((name) => name.replaceAll("\\", "/")).toSorted()).toEqual(
        [".env.example", "SKILL.md", "src", "src/main.py", "uv.lock"],
      )
    },
    SLOW,
  )
})
