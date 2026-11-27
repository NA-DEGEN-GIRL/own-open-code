// Staging of code versions (own/docs/17 §11.4, §12.3) with the real Bun: install-free C2 servers through typecheck,
// their own tests and the smoke test through own's host, and C3 plugins through typecheck, tests, the e2e and golden
// checks. A failing step writes no version.
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Creator } from "@own/protocol/creator"
import { Staging } from "../../src/staging.js"
import { CreatorStore } from "../../src/store.js"
import { mcpManifest, pluginManifest, tempDir } from "./fixtures.js"
import { startRegistry } from "./registry.js"

setDefaultTimeout(120_000)

const bun = process.execPath

async function fresh() {
  const home = await tempDir()
  return { home, store: new CreatorStore.Store(home, { app: "local" }) }
}

function decoded(manifest: unknown) {
  const checked = CreatorStore.checkManifest(manifest)
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems))
  return checked.extension
}

describe("staging a C2 server", () => {
  test("typecheck, its tests and the smoke test pass, and the store takes the folder as the version", async () => {
    const { store } = await fresh()
    const staged = await Staging.run(store, decoded(mcpManifest()), { bun })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    expect(staged.checks.map((check) => check.name)).toEqual(["words: typecheck", "words: tests: counts words", "words: smoke"])
    const created = await store.create(mcpManifest(), "model", {}, undefined, staged.staged)
    if (!created.ok) throw new Error(JSON.stringify(created))
    const dir = store.versionDir("words", 1)
    expect(await fs.readFile(path.join(dir, "servers", "words", "own-mcp.ts"), "utf8")).toContain("export function serve")
    expect(created.snapshot.loaded[0]!.status).toBe("active")
    expect(created.snapshot.file.extensions[0]!.versions[0]!.checks?.map((check) => check.name)).toContain("words: smoke")
    await expect(fs.stat(staged.staged.dir)).rejects.toThrow()
  })

  test("an allow-listed dependency installs from the registry without its install scripts", async () => {
    const { store } = await fresh()
    const registry = await startRegistry()
    try {
      const manifest = mcpManifest("parsed", {
        dependencies: { yaml: "9.9.9" },
        smoke: [{ tool: "parse", arguments: { text: "a: 1" }, expect: "parsed:a: 1" }],
      })
      manifest.items[0]!.files = {
        "server.ts": `import { serve } from "./own-mcp"
import { parse } from "yaml"

serve({ name: "parsed", tools: { parse: { description: "Parses", input: { type: "object", properties: { text: { type: "string" } } }, run: (args) => parse(String(args.text)) } } })
`,
      }
      const staged = await Staging.run(store, decoded(manifest), { bun, registry: registry.url })
      if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
      expect(staged.checks.map((check) => check.name)).toEqual(["words: install", "words: typecheck", "words: smoke"])
      expect(registry.requests).toContain("/yaml")
      const installed = path.join(staged.staged.dir, "servers", "words", "node_modules", "yaml")
      expect(await fs.readFile(path.join(installed, "index.js"), "utf8")).toContain("parsed:")
      await expect(fs.stat(path.join(installed, "POSTINSTALL_RAN"))).rejects.toThrow()
      await Staging.discard(staged.staged)
    } finally {
      await registry.stop()
    }
  })

  test("a type error fails the typecheck, writes nothing and removes the stage", async () => {
    const { store } = await fresh()
    const manifest = mcpManifest("broken")
    const item = manifest.items[0]!
    item.files["server.ts"] = `${item.files["server.ts"]}\nconst wrong: string = 1\n`
    const staged = await Staging.run(store, decoded(manifest), { bun })
    expect(staged.ok).toBe(false)
    if (staged.ok) return
    expect(staged.problems[0]!.path).toBe("stage.words: typecheck")
    expect(staged.problems[0]!.message).toContain("TS2322")
    expect(await fs.readdir(path.join(store.root, "stage")).catch(() => [])).toEqual([])
  })

  test("a failing test of the extension stops it", async () => {
    const { store } = await fresh()
    const manifest = mcpManifest("untested")
    manifest.items[0]!.files["tools.test.ts"] = manifest.items[0]!.files["tools.test.ts"]!.replace("words: 3", "words: 4")
    const staged = await Staging.run(store, decoded(manifest), { bun })
    expect(staged.ok).toBe(false)
    if (staged.ok) return
    expect(staged.problems.map((problem) => problem.path)).toEqual(["stage.words: tests: counts words"])
  })

  test("a smoke call whose answer lacks the expected text stops it", async () => {
    const { store } = await fresh()
    const manifest = mcpManifest("smoky", { smoke: [{ tool: "count_words", arguments: { text: "x" }, expect: "words: 9" }] })
    const staged = await Staging.run(store, decoded(manifest), { bun })
    expect(staged.ok).toBe(false)
    if (staged.ok) return
    expect(staged.problems[0]!.message).toContain("without 'words: 9'")
  })
})

describe("staging a C3 plugin", () => {
  test("typecheck, e2e and golden pass for a hook that appends after the conversation", async () => {
    const { store } = await fresh()
    const staged = await Staging.run(store, decoded(pluginManifest()), { bun })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    expect(staged.checks.map((check) => check.name)).toEqual([
      "typecheck",
      "load",
      "e2e context",
      "golden context stable",
      "golden context prefix",
    ])
    await Staging.discard(staged.staged)
  })

  test("a hook that throws fails the e2e", async () => {
    const { store } = await fresh()
    const source = `import { definePlugin } from "./own-plugin.ts"\nexport default definePlugin({ hooks: { context: () => { throw new Error("boom") } } })\n`
    const staged = await Staging.run(store, decoded(pluginManifest("thrower", source)), { bun })
    expect(staged.ok).toBe(false)
    if (staged.ok) return
    expect(staged.problems[0]).toMatchObject({ path: "stage.e2e context" })
    expect(staged.problems[0]!.message).toContain("boom")
  })

  test("a hook that changes the system prompt fails the golden unless it declares cache 'breaks'", async () => {
    const { store } = await fresh()
    const source = `import { definePlugin } from "./own-plugin.ts"\nexport default definePlugin({ hooks: { context: (request) => { request.system[0]!.text += " Extra." } } })\n`
    const kept = await Staging.run(store, decoded(pluginManifest("system", source)), { bun })
    expect(kept.ok).toBe(false)
    if (kept.ok) return
    expect(kept.problems.map((problem) => problem.path)).toEqual(["stage.golden context prefix"])
    const declared = await Staging.run(store, decoded(pluginManifest("system", source, { cache: "breaks" })), { bun })
    expect(declared.ok).toBe(true)
    if (declared.ok) await Staging.discard(declared.staged)
  })

  test("a hook that is not a pure function of the request fails the golden", async () => {
    const { store } = await fresh()
    const source = `import { definePlugin } from "./own-plugin.ts"\nconst seen = { count: 0 }\nexport default definePlugin({ hooks: { context: (request) => { seen.count += 1; request.messages.push({ role: "user", content: String(seen.count) }) } } })\n`
    const staged = await Staging.run(store, decoded(pluginManifest("impure", source)), { bun })
    expect(staged.ok).toBe(false)
    if (staged.ok) return
    expect(staged.problems.map((problem) => problem.path)).toEqual(["stage.golden context stable"])
  })

  test("code that reaches for Node does not typecheck against own's plugin API", async () => {
    const { store } = await fresh()
    // Past the static check (no banned name), the typecheck has no Node or Bun declarations to offer.
    const source = `import { definePlugin } from "./own-plugin.ts"\ndeclare const later: { env: Record<string, string> }\nexport default definePlugin({ hooks: { context: (request) => { request.messages.push({ role: "user", content: new TextEncoder().encode("x").length }) } } })\n`
    const staged = await Staging.run(store, decoded(pluginManifest("noder", source)), { bun })
    expect(staged.ok).toBe(false)
    if (staged.ok) return
    expect(staged.problems[0]!.path).toBe("stage.typecheck")
    expect(Creator.kindOf(decoded(pluginManifest()))).toBe("plugin")
  })
})
