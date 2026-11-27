import { afterEach, describe, expect, test } from "bun:test"
import { Glob } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import plugin from "../../src/index.js"
import { Build } from "../../src/build.js"
import { Options } from "../../src/options.js"
import { Singleton } from "../../src/singleton.js"
import { Paths } from "../../src/sources/paths.js"
import {
  claudeSession,
  codexRollout,
  fixture,
  sentinels,
  stateDb,
  writeJsonl,
  writeText,
  type Fixture,
} from "../fixtures/make.js"
import { isNeverOpen, start } from "../support/guard.js"

const SRC = path.join(import.meta.dir, "..", "..", "src")
/** The only modules that touch another tool's files (09 §2.1) or open SQLite (09 §2.3). */
const READERS = ["sources/paths.ts", "index/snapshot.ts"]
/**
 * The one module that touches own's own skill files (09 §9.4): own's skills folder, `skill-imports.json` and its temp
 * folders. It never names another tool's root; found skills reach it as bytes read through `paths.ts`.
 */
const OWN_FILES = ["skills/store.ts"]

async function sources() {
  const files = await Array.fromAsync(new Glob("**/*.ts").scan({ cwd: SRC }))
  return Promise.all(
    files.map(async (file) => ({
      file: file.replaceAll("\\", "/"),
      text: await Bun.file(path.join(SRC, file)).text(),
    })),
  )
}

const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function make() {
  const item = await fixture()
  fixtures.push(item)
  return item
}

/** Starting the other tools: `codex app-server` migrates and compacts its store on start (IM-D2). */
const LAUNCH = [
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(\s*\[?\s*["'`](?:[^"'`]*[\\/])?(?:codex|claude)(?:\.exe|\.cmd)?["'`]/i,
  /\bcmd\s*:\s*\[\s*["'`](?:[^"'`]*[\\/])?(?:codex|claude)(?:\.exe|\.cmd)?["'`]/i,
  /\$`\s*(?:codex|claude)\b/i,
  /["'`]app-server["'`]/i,
]

/** File system and SQLite access outside the two reader modules. */
const FILE_ACCESS = [
  /\bfrom\s+["'](?:node:)?fs(?:\/promises)?["']/,
  /\b(?:import|require)\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']/,
  /["']bun:sqlite["']/,
  /\bBun\.(?:file|mmap|write)\s*\(/,
  /\bnew\s+Database\s*\(/,
]

const matches = (patterns: ReadonlyArray<RegExp>, text: string) => patterns.some((pattern) => pattern.test(text))

describe("source hygiene (IM-D2, IG1)", () => {
  test("the patterns catch what they are for", () => {
    for (const sample of [
      'Bun.spawn(["codex", "app-server"])',
      "spawn('C:/tools/claude.exe', args)",
      'Bun.spawn({ cmd: ["claude", "-p"] })',
      "await $`codex exec`",
    ])
      expect([sample, matches(LAUNCH, sample)]).toEqual([sample, true])
    expect(matches(LAUNCH, 'Bun.spawn(["git", "worktree", "list", "--porcelain"])')).toBe(false)
    for (const sample of [
      'import fs from "node:fs"',
      "import { readFile } from 'fs/promises'",
      'const fs = await import("node:fs")',
      'import { Database } from "bun:sqlite"',
      "Bun.file(path)",
    ])
      expect([sample, matches(FILE_ACCESS, sample)]).toEqual([sample, true])
    expect(matches(FILE_ACCESS, 'import zlib from "node:zlib"')).toBe(false)
  })

  test("src never starts Codex or Claude Code", async () => {
    const launches = (await sources()).filter((source) => matches(LAUNCH, source.text))
    expect(launches.map((source) => source.file)).toEqual([])
  })

  test("only sources/paths.ts and index/snapshot.ts touch files or SQLite, and skills/store.ts own's skill files", async () => {
    const all = await sources()
    expect(all.map((source) => source.file)).toEqual(expect.arrayContaining([...READERS, ...OWN_FILES]))
    const offenders = all.filter(
      (source) => ![...READERS, ...OWN_FILES].includes(source.file) && matches(FILE_ACCESS, source.text),
    )
    expect(offenders.map((source) => source.file)).toEqual([])
    const store = all.find((source) => source.file === "skills/store.ts")?.text ?? ""
    // No root of another tool reaches the writer: it imports neither the allowlist nor the roots, and opens no SQLite.
    expect(store).not.toMatch(
      /from\s+["'][^"']*sources\/paths|bun:sqlite|CODEX_HOME|CLAUDE_CONFIG_DIR|["'`]\.(?:codex|claude)/,
    )
  })

  test("paths.ts opens read-only and never writes; snapshot.ts opens SQLite read-only and only on the copy", async () => {
    const paths = await Bun.file(path.join(SRC, "sources", "paths.ts")).text()
    const opens = [...paths.matchAll(/fsp\.open\(([^)]*)\)/g)].map((match) => match[1])
    expect(opens).toEqual(['checked.real, "r"'])
    expect(paths).not.toMatch(
      /fsp?\.(?:writeFile|appendFile|rm|unlink|rename|mkdir|copyFile|utimes|truncate|symlink)\w*\(/,
    )
    const snapshot = await Bun.file(path.join(SRC, "index", "snapshot.ts")).text()
    expect([...snapshot.matchAll(/new Database\(([^)]*)\)/g)].map((match) => match[1])).toEqual([
      "file, { readonly: true }",
    ])
    // The source is read through Paths.withFile with purpose "copy"; the only file it writes is the copy.
    expect(snapshot).toMatch(/Paths\.withFile\(root, from, "copy"/)
    expect([...snapshot.matchAll(/fsp\.(?:open|writeFile|appendFile|copyFile)\(([^,]*),/g)].map((m) => m[1])).toEqual([
      "to",
    ])
  })

  test("the fixtures only write: nothing is read or copied from a real profile", async () => {
    const make = await Bun.file(path.join(import.meta.dir, "..", "fixtures", "make.ts")).text()
    expect(make).not.toMatch(/readFile|copyFile|\bcp\(|homedir\(|process\.env/)
  })
})

describe("the read-only guard catches what is not a read", () => {
  test("its never-open list covers every sentinel", async () => {
    const item = await make()
    const files = [...(await sentinels(item.codex, "codex")), ...(await sentinels(item.claude, "claude-code"))]
    expect(files.filter((file) => !isNeverOpen(file))).toEqual([])
    const allowed = [
      codexRollout(item.codex, { id: "t1", at: "2026-10-08T09:00:00Z" }),
      path.join(item.codex, "session_index.jsonl"),
      path.join(item.codex, "state_5.sqlite"),
      path.join(item.codex, "state_5.sqlite-wal"),
      claudeSession(item.claude, "C:\\work\\proj", "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d5e"),
    ]
    expect(allowed.filter(isNeverOpen)).toEqual([])
  })

  test("writes, creates, renames, deletes and new DB siblings", async () => {
    const item = await make()
    const rollout = await writeJsonl(codexRollout(item.codex, { id: "t1", at: "2026-10-08T09:00:00Z" }), [{ a: 1 }])
    const other = await writeText(path.join(item.codex, "session_index.jsonl"), "{}\n")
    const state = stateDb(item.codex, { keepOpen: false })
    const guard = await start([item.codex])
    await fs.appendFile(rollout, '{"a":2}\n')
    await writeText(path.join(item.codex, "new.txt"), "x")
    await fs.rename(other, `${other}.bak`)
    await writeText(`${state.file}-wal`, "")
    const violations = await guard.stop()
    const kinds = (file: string) => violations.filter((item) => item.path === file).map((item) => item.kind)
    expect(kinds(rollout)).toEqual(expect.arrayContaining(["changed", "event"]))
    expect(kinds(path.join(item.codex, "new.txt"))).toEqual(expect.arrayContaining(["created", "event"]))
    expect(kinds(other)).toEqual(expect.arrayContaining(["removed", "event"]))
    expect(kinds(`${state.file}-wal`)).toEqual(expect.arrayContaining(["sibling"]))
  })

  test("pure reads through the allowlist leave it clean", async () => {
    const item = await make()
    const root = Paths.defaults({ options: { roots: { codex: [item.codex], claude: [] } } })[0]
    const rollout = await writeJsonl(codexRollout(item.codex, { id: "t1", at: "2026-10-08T09:00:00Z" }), [{ a: 1 }])
    await sentinels(item.codex, "codex")
    const guard = await start([item.codex])
    await Paths.list(root, item.codex)
    await Paths.read(root, rollout)
    await Paths.read(root, path.join(item.codex, "auth.json"))
    expect(await guard.stop()).toEqual([])
  })
})

describe("loading does nothing (PF1/PF6)", () => {
  const app = { name: "opencode", version: Build.EXPECTED_APP_VERSION, channel: "local" }

  // Loading registers `own.import` at the Location (rpc.ts); the registration itself does no I/O.
  function context(options: unknown) {
    const rpc = { register: () => Effect.succeed({ events: { emit: () => Effect.void } }) }
    return { app, options, location: { directory: os.tmpdir() }, rpc } as unknown as Plugin.Context
  }

  /** The OWN_HOME that build's singleton was created with, as a later instance sees it. */
  const homeOf = (buildId: string, home: string) =>
    Singleton.acquire({ buildId, options: Options.decode({ home }) }).pipe(Effect.map((shared) => shared.home))

  test("the plugin reads no root, writes nothing and joins the build's singleton", async () => {
    const item = await make()
    await writeJsonl(codexRollout(item.codex, { id: "t1", at: "2026-10-08T09:00:00Z" }), [{ a: 1 }])
    stateDb(item.codex, { keepOpen: false })
    await sentinels(item.codex, "codex")
    const guard = await start([item.codex, item.claude, item.home])
    const previous = process.env[Build.ENV_MARKER]
    process.env[Build.ENV_MARKER] = "1"
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const options = { ...item.options, buildId: "hygiene-load" }
          yield* plugin.effect(context(options))
          yield* plugin.effect(context(options))
          return yield* homeOf("hygiene-load", path.join(item.dir, "other-home"))
        }),
      ),
    ).finally(() => {
      if (previous === undefined) delete process.env[Build.ENV_MARKER]
      else process.env[Build.ENV_MARKER] = previous
    })
    expect(seen).toBe(path.resolve(item.home))
    expect(await guard.stop()).toEqual([])
    expect(guard.reports).toEqual([])
    expect(await fs.readdir(item.home)).toEqual([])
    // The last instance left: the next one creates the entry anew.
    expect(await Effect.runPromise(Effect.scoped(homeOf("hygiene-load", item.dir)))).toBe(path.resolve(item.dir))
  })

  test("a failed guard joins nothing", async () => {
    const item = await make()
    const previous = process.env[Build.ENV_MARKER]
    delete process.env[Build.ENV_MARKER]
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(context({ ...item.options, buildId: "hygiene-guard" }))
          return yield* homeOf("hygiene-guard", item.dir)
        }),
      ),
    ).finally(() => {
      if (previous !== undefined) process.env[Build.ENV_MARKER] = previous
    })
    expect(seen).toBe(path.resolve(item.dir))
  })

  test("invalid options and a non-loopback service are refused", () => {
    expect(() => Options.decode({ roots: { codex: [""] } })).toThrow()
    expect(() => Options.decode({ service: { url: "http://192.168.0.2:4096", password: "x" } })).toThrow()
    expect(() => Options.decode({ service: { url: "https://127.0.0.1:4096", password: "x" } })).toThrow()
    expect(Options.decode({ service: { url: "http://127.0.0.1:4096", password: "x" } }).service?.url).toBe(
      "http://127.0.0.1:4096",
    )
    expect(Options.decode({ service: { url: "http://localhost:4096", password: "x" } }).service?.url).toBe(
      "http://localhost:4096",
    )
    expect(Options.decode(undefined)).toEqual({})
  })

  test("a slot is created once per build and closed with the last instance", async () => {
    const created: string[] = []
    const closed: string[] = []
    const slot = Singleton.slot(
      "hygiene-slot",
      (shared) => {
        created.push(shared.buildId)
        return { id: created.length }
      },
      (value) => Effect.sync(() => closed.push(`closed ${value.id}`)),
    )
    const run = (buildId: string) =>
      Singleton.acquire({ buildId, options: {} }).pipe(Effect.map((shared) => shared.get(slot).id))
    const ids = await Effect.runPromise(Effect.scoped(Effect.all([run("slot-a"), run("slot-a"), run("slot-b")])))
    expect(ids).toEqual([1, 1, 2])
    expect(created).toEqual(["slot-a", "slot-b"])
    expect(closed.sort()).toEqual(["closed 1", "closed 2"])
  })
})
