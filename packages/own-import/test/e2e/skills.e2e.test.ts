import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import path from "node:path"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { fixture, sentinels, type Fixture } from "../fixtures/make.js"
import { claudeSkill, codexSkill, pluginSkill } from "../fixtures/skills.js"
import { start, type Guard } from "../support/guard.js"
import { call, startImportServer, until, type ImportServer } from "./support.js"

/**
 * Skills through the real server (09 §9): own-accounts and own-import loaded from their package folders by own-team's
 * harness, synthetic Codex and Claude Code skill folders as the roots, the server's `OPENCODE_CONFIG_DIR` a temp
 * folder of the harness, core's file watcher on (as the installed service runs). `skills.list` and `skills.import` go
 * over RPC, and core's own skill list (`GET /api/skill`) must then hold the copy from `%OPENCODE_CONFIG_DIR%\skills\<id>` with the converted `disable-model-invocation`. The
 * read-only guard watches the roots for the whole suite (IG1). Run from `packages/own-import`: `bun run test:e2e`.
 */

const BOOT = 300_000
const LONG = 120_000

const state = {} as { fixture: Fixture; run: ImportServer; guard: Guard }

beforeAll(async () => {
  state.fixture = await fixture({ under: "한글 #skills" })
  const item = state.fixture
  await sentinels(item.codex, "codex")
  await sentinels(item.claude, "claude-code")
  await codexSkill(item.codex, "release-notes", {
    yaml: "policy:\n  allow_implicit_invocation: false\n",
    files: { "scripts/collect.py": "print(1)\n" },
  })
  await claudeSkill(item.claude, "review")
  await pluginSkill(item.claude, { market: "market", plugin: "hookify", name: "writing-rules", installed: true })
  state.run = await startImportServer({
    name: "import-skills",
    roots: { codex: [item.codex], claude: [item.claude] },
    watch: true,
  })
  state.guard = await start([item.codex, item.claude])
}, BOOT)

afterAll(async () => {
  await state.run?.server.stop()
  await state.fixture?.cleanup()
}, LONG)

const Loaded = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, path: Schema.String, autoinvoke: Schema.optional(Schema.Boolean) }),
  ),
})
const decodeLoaded = Schema.decodeUnknownSync(Loaded)

/** core's skills at the control location (`GET /api/skill`). */
async function loaded() {
  const directory = state.run.server.control
  const response = await state.run.server.server.request("GET", "/api/skill", {
    directory,
    query: { "location[directory]": directory },
  })
  expect(response.status).toBe(200)
  return decodeLoaded(await response.json()).data
}

describe("skills through the server (09 §9)", () => {
  test(
    "health offers skills; the list finds every source with its format",
    async () => {
      expect((await call(state.run.server, "health", {})).features).toContain("skills")
      const listed = await call(state.run.server, "skills.list", {})
      const config = state.run.server.server.paths.config
      expect(listed.directory).toBe(path.join(config, "skills"))
      expect(
        listed.items
          .map((row) => [row.origin, row.name, row.format.status])
          .toSorted((a, b) => a[1].localeCompare(b[1])),
      ).toEqual([
        ["codex", "release-notes", "converted"],
        ["claude-code", "review", "ok"],
        ["claude-plugin", "writing-rules", "ok"],
      ])
    },
    LONG,
  )

  test(
    "own에서 쓰기 copies into own's skills folder and core loads it, converted",
    async () => {
      const listed = await call(state.run.server, "skills.list", {})
      const notes = listed.items.find((row) => row.name === "release-notes")
      if (notes === undefined) throw new Error("release-notes was not listed")
      const done = await call(state.run.server, "skills.import", { key: notes.key })
      expect(done.directory).toBe(path.join(state.run.server.server.paths.config, "skills", "release-notes"))
      expect(await fsp.readFile(path.join(done.directory, "scripts", "collect.py"), "utf8")).toBe("print(1)\n")
      await until(
        async () => (await loaded()).some((item) => item.id === "release-notes"),
        "core never loaded the imported skill",
      )
      const skill = (await loaded()).find((item) => item.id === "release-notes")
      expect(path.normalize(skill?.path ?? "")).toBe(path.join(done.directory, "SKILL.md"))
      expect(skill?.autoinvoke).toBe(false)
      const again = await call(state.run.server, "skills.list", {})
      expect(again.items.find((row) => row.name === "release-notes")?.imported).toEqual({
        id: Schema.decodeSync(OwnImport.SkillID)("release-notes"),
        changed: false,
      })
      expect(again.imports.map((row): string => row.id)).toEqual(["release-notes"])
    },
    LONG,
  )

  test(
    "a second import of the same name is a conflict over RPC; a phone-scoped list stays read only",
    async () => {
      const listed = await call(state.run.server, "skills.list", {})
      const notes = listed.items.find((row) => row.name === "release-notes")
      const result = await state.run.server.rpc(OwnImport.ID, "skills.import", { key: notes?.key })
      expect(result).toMatchObject({
        status: 400,
        type: "skill_conflict",
        data: { id: "release-notes", replaceable: true },
      })
      expect(OwnImport.MethodScope["skills.list"]).toBe("read")
      expect(OwnImport.MethodScope["skills.import"]).toBe("local")
    },
    LONG,
  )

  test(
    "the other tools' folders were only read (IG1)",
    async () => {
      expect(await state.guard.stop()).toEqual([])
    },
    LONG,
  )
})
