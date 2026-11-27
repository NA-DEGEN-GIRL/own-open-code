// `URL로 설치` (09 §9.5) against a git server on 127.0.0.1 (`git http-backend`): URL rules, the preview that downloads
// only the tree and the manifests, the pinned install, conflicts and replacing, update checks, and the refusals
// (a server without partial clone, an unknown repository, a URL that is not https).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { SkillGit } from "../../src/skills/git.js"
import { Skills } from "../../src/skills/service.js"
import { fixture, type Fixture } from "../fixtures/make.js"
import { codeSkillMd, skillMd } from "../fixtures/skills.js"
import { git, serve, type Server } from "../support/git-server.js"

const ID = Schema.decodeSync(OwnImport.SkillID)
const PAYLOAD = "own-import-payload-7d3e: not downloaded before the install"
/** Every git process takes a moment on Windows (about a second each here), and a test runs a few dozen. */
const SLOW = 180_000

const MARKETPLACE = JSON.stringify({
  name: "fixture-market",
  plugins: [
    { name: "docs", source: "./plugins/docs" },
    { name: "remote-one", source: { source: "github", repo: "example/other", path: "plugins/one" } },
    { name: "npm-one", source: { source: "npm", package: "x" } },
  ],
})

const FILES = {
  ".claude-plugin/marketplace.json": MARKETPLACE,
  "plugins/docs/skills/release-notes/SKILL.md": skillMd("release-notes", "Write release notes"),
  "plugins/docs/skills/release-notes/scripts/collect.py": `print("${PAYLOAD}")\n`,
  "plugins/docs/skills/hooky/SKILL.md": skillMd("hooky", "Has hooks", "hooks:\n  Stop: []\n"),
  "skills/codexy/SKILL.md": skillMd("codexy", "A Codex skill"),
  "skills/codexy/agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n",
  "README.md": `# Fixture\n${PAYLOAD}\n`,
}

let server: Server
const fixtures: Fixture[] = []

beforeAll(async () => {
  server = await serve()
})
afterAll(async () => {
  await server.close()
})
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function setup() {
  const item = await fixture()
  fixtures.push(item)
  const skillsDir = path.join(item.dir, "own-config", "skills")
  const nonces = new Map()
  const service = Skills.create({ home: item.home, options: () => ({ ...item.options, skillsDir }), nonces, env: {} })
  return { item, skillsDir, service, nonces }
}

function value<T>(answer: Skills.Answer<T>): T {
  if (!answer.ok) throw new Error(`expected a value, got ${answer.error.type} ${JSON.stringify(answer.error.data)}`)
  return answer.value
}

async function temps(home: string) {
  return (await fs.readdir(path.join(home, "tmp")).catch(() => [])).filter((name) => name.startsWith("skill-"))
}

describe("parseRepo", () => {
  test("https URLs, GitHub shorthand and tree links; http only to a loopback host", () => {
    expect(SkillGit.parseRepo({ url: "anthropics/skills" })).toEqual({
      url: "https://github.com/anthropics/skills.git",
    })
    expect(SkillGit.parseRepo({ url: "https://github.com/openai/skills/tree/main/skills/.curated/notes" })).toEqual({
      url: "https://github.com/openai/skills.git",
      ref: "main",
      folder: "skills/.curated/notes",
    })
    expect(SkillGit.parseRepo({ url: "https://github.com/o/r/blob/v1/skills/a/SKILL.md" })).toEqual({
      url: "https://github.com/o/r.git",
      ref: "v1",
      folder: "skills/a",
    })
    expect(SkillGit.parseRepo({ url: "https://github.com/o/r.git", ref: "dev", folder: "/x/y/" })).toEqual({
      url: "https://github.com/o/r.git",
      ref: "dev",
      folder: "x/y",
    })
    expect(SkillGit.parseRepo({ url: "https://git.example.test/team/skills.git/?x=1#y" })).toEqual({
      url: "https://git.example.test/team/skills.git",
    })
    expect(SkillGit.parseRepo({ url: "http://127.0.0.1:9/a.git" })).toEqual({ url: "http://127.0.0.1:9/a.git" })
    for (const url of [
      "http://example.test/a.git",
      "ftp://example.test/a.git",
      "https://user:secret@example.test/a.git",
      "git@github.com:o/r.git",
      "file:///C:/repo",
      "C:\\repo",
    ])
      expect([url, SkillGit.parseRepo({ url })]).toEqual([url, undefined])
    for (const input of [
      { url: "https://example.test/a.git", ref: "--upload-pack=x" },
      { url: "https://example.test/a.git", ref: "a..b" },
      { url: "https://example.test/a.git", folder: "../x" },
      { url: "https://example.test/a.git", folder: "a/%2e%2e/b" },
    ])
      expect([input, SkillGit.parseRepo(input)]).toEqual([input, undefined])
  })
})

describe("skills.preview and skills.install", () => {
  test(
    "the preview reads the tree and the manifests only; install copies the chosen skills at that commit",
    async () => {
      const url = await server.repo("market", FILES)
      const commit = (await git(["rev-parse", "main"], path.join(server.root, "market.git"))).trim()
      const { item, skillsDir, service } = await setup()
      const preview = value(await service.preview({ url }))
      expect(preview).toMatchObject({ url, commit, layout: "marketplace" })
      expect(preview.external).toEqual([
        { plugin: "remote-one", repo: { url: "https://github.com/example/other.git", folder: "plugins/one" } },
        { plugin: "npm-one" },
      ])
      const rows = preview.items.map((row) => [
        row.name,
        row.folder,
        row.plugin ?? null,
        row.format.status,
        row.scripts,
      ])
      expect(rows).toEqual([
        ["codexy", "skills/codexy", null, "converted", []],
        ["hooky", "plugins/docs/skills/hooky", "docs", "incompatible", []],
        ["release-notes", "plugins/docs/skills/release-notes", "docs", "ok", ["scripts/collect.py"]],
      ])
      expect(preview.items.find((row) => row.name === "release-notes")?.files).toEqual([
        "SKILL.md",
        "scripts/collect.py",
      ])
      // The script's content and the README were not downloaded: their blobs are missing from the partial clone.
      const [clone] = await temps(item.home)
      const work = path.join(item.home, "tmp", clone, "repo")
      const missing = await git(["rev-list", "--objects", "--missing=print", commit], work)
      const blob = (
        await git(["rev-parse", `${commit}:plugins/docs/skills/release-notes/scripts/collect.py`], work)
      ).trim()
      const readme = (await git(["rev-parse", `${commit}:README.md`], work)).trim()
      expect(missing).toContain(`?${blob}`)
      expect(missing).toContain(`?${readme}`)
      const manifest = (await git(["rev-parse", `${commit}:plugins/docs/skills/release-notes/SKILL.md`], work)).trim()
      expect(missing).not.toContain(`?${manifest}`)

      const key = (name: string) => preview.items.find((row) => row.name === name)?.key ?? preview.items[0].key
      // A commit pushed after the preview does not change what is installed.
      await server.repo("market", {
        "plugins/docs/skills/release-notes/scripts/collect.py": "print('later')\n",
      })
      expect(await service.install({ nonce: preview.nonce, keys: [key("hooky")] })).toMatchObject({
        ok: false,
        error: { type: "skill_incompatible", data: { problems: ["hooks"] } },
      })
      const done = value(
        await service.install({
          nonce: preview.nonce,
          keys: [key("release-notes"), key("codexy")],
          renames: [{ key: key("codexy"), id: ID("codex-y") }],
        }),
      )
      expect(done.installed).toEqual([
        { id: ID("release-notes"), directory: path.join(skillsDir, "release-notes") },
        { id: ID("codex-y"), directory: path.join(skillsDir, "codex-y") },
      ])
      expect(await fs.readFile(path.join(skillsDir, "release-notes", "scripts", "collect.py"), "utf8")).toContain(
        PAYLOAD,
      )
      expect(await fs.readFile(path.join(skillsDir, "codex-y", "SKILL.md"), "utf8")).toStartWith(
        "---\ndisable-model-invocation: true\nname: codexy\n",
      )
      expect(await fs.readFile(path.join(skillsDir, "codex-y", "agents", "openai.yaml"), "utf8")).toContain("policy")
      expect(await temps(item.home)).toEqual([])
      expect(await service.install({ nonce: preview.nonce, keys: [key("release-notes")] })).toMatchObject({
        ok: false,
        error: { type: "nonce_invalid" },
      })
      const listed = value(await service.list())
      expect(listed.imports.find((row) => row.id === "release-notes")).toMatchObject({
        origin: "git",
        url,
        commit: preview.commit,
        folder: "plugins/docs/skills/release-notes",
        files: 2,
      })
    },
    SLOW,
  )

  test(
    "09 §9.12: a repository's SKILL.md whose frontmatter is code is refused in the preview, never run, not installed",
    async () => {
      const { item, service } = await setup()
      const marker = (name: string) => path.join(item.dir, `ran-${name}`)
      const url = await server.repo("code-front", {
        ".claude-plugin/marketplace.json": MARKETPLACE,
        "plugins/docs/skills/plugin-js/SKILL.md": codeSkillMd(marker("plugin")),
        "skills/repo-js/SKILL.md": codeSkillMd(marker("repo"), "---javascript"),
        "skills/repo-js/agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n",
        "skills/plain/SKILL.md": skillMd("plain", "A plain skill"),
      })
      const preview = value(await service.preview({ url }))
      const ran = async () => (await fs.readdir(item.dir)).filter((name) => name.startsWith("ran-"))
      // Nothing ran (on 8d8c7960f3 the preview wrote both markers before anything was installed).
      expect(await ran()).toEqual([])
      expect(
        preview.items.map((row) => [row.name, row.format.status, row.format.problems]).toSorted(),
      ).toEqual([
        ["plain", "ok", []],
        ["plugin-js", "incompatible", ["frontmatter_language"]],
        ["repo-js", "incompatible", ["frontmatter_language"]],
      ])
      for (const row of preview.items.filter((entry) => entry.name !== "plain"))
        expect(await service.install({ nonce: preview.nonce, keys: [row.key] })).toMatchObject({
          ok: false,
          error: { type: "skill_incompatible", data: { problems: ["frontmatter_language"] } },
        })
      expect(await ran()).toEqual([])
    },
    SLOW,
  )

  test(
    "an installed skill: conflict on preview, replace on install, update check against the remote",
    async () => {
      const url = await server.repo("update", FILES)
      const { skillsDir, service } = await setup()
      const first = value(await service.preview({ url, folder: "skills" }))
      expect(first.items.map((row) => row.name)).toEqual(["codexy"])
      value(await service.install({ nonce: first.nonce, keys: [first.items[0].key] }))
      expect(value(await service.updates()).items).toEqual([{ id: ID("codexy"), state: "same", commit: first.commit }])
      await server.repo("update", { "skills/codexy/SKILL.md": skillMd("codexy", "A Codex skill, v2") })
      const checked = value(await service.updates()).items
      expect(checked[0].state).toBe("changed")
      const second = value(await service.preview({ url, folder: "skills" }))
      expect(second.commit).toBe(checked[0].commit ?? "")
      expect(second.items[0].conflict).toEqual({ replaceable: true })
      expect(await service.install({ nonce: second.nonce, keys: [second.items[0].key] })).toMatchObject({
        ok: false,
        error: { type: "skill_conflict", data: { id: "codexy", replaceable: true } },
      })
      value(await service.install({ nonce: second.nonce, keys: [second.items[0].key], replace: true }))
      expect(await fs.readFile(path.join(skillsDir, "codexy", "SKILL.md"), "utf8")).toContain("v2")
      expect(value(await service.updates()).items).toEqual([{ id: ID("codexy"), state: "same", commit: second.commit }])
    },
    SLOW,
  )

  test(
    "refusals: no partial clone, an unknown repository, a URL that is not https",
    async () => {
      const url = await server.repo("full-only", FILES, { filter: false })
      const { item, service } = await setup()
      expect(await service.preview({ url })).toMatchObject({
        ok: false,
        error: { type: "fetch_failed", data: { reason: "no_partial_clone" } },
      })
      expect(await service.preview({ url: `${server.origin}/missing.git` })).toMatchObject({
        ok: false,
        error: { type: "fetch_failed", data: { reason: "not_found" } },
      })
      expect(await service.preview({ url, folder: "no/such/folder" })).toMatchObject({
        ok: false,
        error: { type: "fetch_failed" },
      })
      expect(await service.preview({ url: "http://example.test/a.git" })).toMatchObject({
        ok: false,
        error: { type: "url_invalid" },
      })
      expect(await temps(item.home)).toEqual([])
    },
    SLOW,
  )
})
