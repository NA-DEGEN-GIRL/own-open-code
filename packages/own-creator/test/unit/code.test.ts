// The walls around C2 and C3 code (own/docs/17 §11.6, §12.3): the early lint of the sources (a lint, not a boundary),
// the allow-listed environment own's tools and the sandbox host run with, and — the real boundary — own's WebAssembly
// sandbox, which gives a C2 server no host globals and reaches the disk only through own's fenced bridge.
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Code } from "../../src/code.js"
import { Runtime } from "../../src/runtime.js"
import { Safety } from "../../src/safety.js"
import { Staging } from "../../src/staging.js"
import { CreatorStore } from "../../src/store.js"
import { mcpManifest, pluginManifest, tempDir } from "./fixtures.js"

setDefaultTimeout(120_000)
const bun = process.execPath

const problemsOf = (manifest: unknown) => {
  const checked = CreatorStore.checkManifest(manifest)
  return checked.ok ? [] : checked.problems.map((problem) => problem.message)
}

const server = (source: string, extra: Record<string, unknown> = {}) => {
  const manifest = mcpManifest("walls", extra)
  manifest.items[0]!.files = { "server.ts": source }
  return manifest
}
const plugin = (source: string) => pluginManifest("walls", source)

describe("the early lint (not a boundary)", () => {
  test("the fixtures pass", () => {
    expect(problemsOf(mcpManifest())).toEqual([])
    expect(problemsOf(pluginManifest())).toEqual([])
  })

  test.each([
    ["node:fs import", `import fs from "node:fs"\nexport const home = fs`, "may not import 'node:fs'"],
    ["child_process import", `import { spawn } from "child_process"\nexport const s = spawn`, "may not import 'child_process'"],
    ["node:path import (no Node in the sandbox)", `import path from "node:path"\nexport const p = path`, "may not import 'node:path'"],
    ["process", `export const home = process.env.USERPROFILE`, "'process' does not exist in own's sandbox"],
    ["Bun", `export const file = Bun.file("x")`, "'Bun' does not exist in own's sandbox"],
    ["global fetch", `export const go = () => fetch("https://example.com")`, "use context.fetch"],
    ["dynamic import", `export const m = import("node:fs")`, "dynamic import()"],
    ["import.meta", `export const u = import.meta.url`, "import.meta"],
    ["constructor escape", `export const f = (() => 0).constructor`, ".constructor"],
    ["a package not declared", `import yaml from "yaml"\nexport const y = yaml`, "may not import 'yaml'"],
  ])("a server lint refuses %s", (_label, source, message) => {
    expect(problemsOf(server(source)).join("\n")).toContain(message)
  })

  test("names inside strings, regular expressions and member access are not uses", () => {
    expect(problemsOf(server(`declare const obj: { process: number }\nexport const text = "process the Bun file"\nexport const item = obj.process`))).toEqual([])
    // A regex literal is blanked, so the sandbox-absent name inside it is not read as a use (the regex is harmless).
    expect(problemsOf(server(`export const re = /process|Bun/\nexport const n = "a/b".split("/").length`))).toEqual([])
  })

  test("only lower-case .ts/.js/.mts/.mjs are code; .tsx, .cts and friends are refused", () => {
    expect(problemsOf(server(`export const a = 1`, {})).join("\n")).toEqual("")
    const withTsx = mcpManifest("walls")
    withTsx.items[0]!.files = { "server.ts": `export const a = 1`, "helper.tsx": `export const b = 1` }
    expect(problemsOf(withTsx).join("\n")).toContain("code files are .ts, .js, .mts or .mjs")
  })

  test("a relative import names a file of the item; a plugin's needs an explicit extension", () => {
    const missing = mcpManifest("walls")
    missing.items[0]!.files = { "server.ts": `import { x } from "./nope"\nexport const y = x` }
    expect(problemsOf(missing).join("\n")).toContain("names no file of the item")
    expect(problemsOf(plugin(`import { definePlugin } from "./own-plugin"\nexport default definePlugin({ hooks: {} })`)).join("\n")).toContain(
      "needs an explicit extension",
    )
  })

  test("a plugin may import only its own files and may not reach the network or switch the typecheck off", () => {
    expect(problemsOf(plugin(`import { definePlugin } from "./own-plugin.ts"\nexport default definePlugin({ hooks: { context: () => void fetch("https://x") } })`)).join("\n")).toContain(
      "may not use 'fetch'",
    )
    expect(problemsOf(plugin(`import { Effect } from "effect"\nexport default Effect`)).join("\n")).toContain("may import only its own files")
    expect(problemsOf(plugin(`// @ts-nocheck\nimport { definePlugin } from "./own-plugin.ts"\nexport default definePlugin({ hooks: {} })`)).join("\n")).toContain(
      "@ts-nocheck",
    )
    expect(problemsOf(plugin(`import { definePlugin } from "./own-plugin.ts"\n// @TS-Ignore\nexport default definePlugin({ hooks: {} })`)).join("\n")).toContain(
      "@ts-nocheck, @ts-ignore, @ts-expect-error",
    )
  })

  test("dependencies and config files: only the allow-list, never an installer or runtime config", () => {
    expect(problemsOf(server(`import { z } from "zod"\nexport const a = z`, { dependencies: { zod: "3.23.8" } }))).toEqual([])
    expect(problemsOf(server(`export const a = 1`, { dependencies: { "left-pad": "1.3.0" } })).join("\n")).toContain(
      "'left-pad' is not on own's allow-list",
    )
    expect(problemsOf(server(`export const a = 1`, { dependencies: { lodash: "4.17.21" } })).join("\n")).toContain("not on own's allow-list")
    for (const bad of [".npmrc", "sub/.npmrc", ".yarnrc.yml", ".env", "sub/.env.local"]) {
      const m = mcpManifest("walls")
      m.items[0]!.files = { "server.ts": `export const a = 1`, [bad]: "x" }
      expect(problemsOf(m).join("\n")).toContain("configures an installer or runtime")
    }
  })

  test("an exact dependency version is required; a range is refused", () => {
    expect(problemsOf(server(`export const a = 1`, { dependencies: { zod: "^3.23.8" } })).join("\n")).not.toEqual("")
  })

  test("blankStrings keeps template expressions and blanks regexes", () => {
    expect(Code.blankStrings("const a = `x ${process} y`")).toBe("const a = `${process}`")
    expect(Code.blankStrings("const a = /process/.test(x)")).toBe("const a = /r/.test(x)")
  })
})

describe("the server's environment (own's tools and the sandbox host)", () => {
  const source = {
    PATH: "C:\\Windows\\System32;C:\\Users\\someone\\.bun\\bin",
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\Users\\someone",
    USERNAME: "someone",
    APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
    TEMP: "C:\\Users\\someone\\AppData\\Local\\Temp",
    OPENAI_API_KEY: "sk-secret-value-1234567890",
    OWN_HOME: "C:\\own",
    OPENCODE_CONFIG_DIR: "C:\\cfg",
    GITHUB_TOKEN: "ghp_secret",
    CLAUDE_CONFIG_DIR: "C:\\claude",
    LANG: "ko_KR.UTF-8",
  }

  test("is the allow-list, identity variables empty, profile folders out of PATH, no TEMP unless own's tools get one", () => {
    const env = Safety.serverEnv(source, { temp: "C:\\t\\x" })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OWN_HOME).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.USERPROFILE).toBe("")
    expect(env.APPDATA).toBe("")
    expect(env.PATH).toBe(process.platform === "win32" ? "C:\\Windows\\System32" : source.PATH)
    expect(env.LANG).toBe("ko_KR.UTF-8")
    expect(env.TEMP).toBe("C:\\t\\x")
    // The sandbox host gets no TEMP at all (L5): own's TEMP never leads into OWN_HOME.
    const host = Safety.serverEnv(source, {})
    expect(host.TEMP).toBeUndefined()
    expect(host.TMP).toBeUndefined()
  })
})

describe("own's sandbox fence (the boundary)", () => {
  // One staged server with a `read` tool, then run it in the sandbox against a project holding a vault folder.
  async function staged() {
    const home = await tempDir()
    const store = new CreatorStore.Store(home, { app: "local" })
    const manifest = mcpManifest("reader")
    manifest.items[0]!.smoke = []
    const checked = CreatorStore.checkManifest(manifest)
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems))
    const result = await Staging.run(store, checked.extension, { bun })
    if (!result.ok) throw new Error(JSON.stringify(result.checks))
    return { home, store, dir: result.staged.dir }
  }

  // Starts the sandbox host on `bundle`, sends `messages` and collects the answers until one with id `until` arrived.
  // The host is killed and awaited before returning, so the test's temp folders are free to remove.
  async function host(
    where: Awaited<ReturnType<typeof staged>>,
    input: { project: string; bundle: string; messages: ReadonlyArray<unknown>; until: number; timeoutSeconds?: number },
  ) {
    const fence = Safety.fence({
      project: input.project,
      home: where.home,
      env: process.env,
      item: { hosts: [], ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }) },
    })
    const command = Staging.hostCommand({
      bun,
      host: Runtime.paths(where.store.root).host,
      bundle: input.bundle,
      quickjs: Runtime.quickjs(),
      fence,
      log: Runtime.logFile(where.store.root, "reader"),
      label: "reader probe",
    })
    const child = Bun.spawn(command, { cwd: input.project, env: Safety.serverEnv(process.env, {}), stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    for (const message of input.messages) child.stdin.write(`${JSON.stringify(message)}\n`)
    void child.stdin.flush()
    const decoder = new TextDecoder()
    let buffer = ""
    const answers: Array<Record<string, unknown>> = []
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) if (line.trim() !== "") answers.push(JSON.parse(line) as Record<string, unknown>)
      if (answers.some((answer) => answer.id === input.until)) break
    }
    child.stdin.end()
    child.kill()
    await child.exited
    return answers
  }

  async function callRead(where: Awaited<ReturnType<typeof staged>>, project: string, file: string) {
    const answers = await host(where, {
      project,
      bundle: path.join(where.dir, "servers", "words", Runtime.BUNDLE),
      messages: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: file } } },
      ],
      until: 2,
    })
    const answer = answers.find((item) => item.id === 2)
    const result = (answer?.result ?? {}) as { content?: Array<{ text?: string }> }
    return (result.content ?? []).map((part) => part.text ?? "").join("\n")
  }

  test("a server whose tools/list loops forever is interrupted at the call deadline and the host keeps answering", async () => {
    const where = await staged()
    const project = await tempDir()
    // A bundle written straight to disk: staging's checks would not matter here, only the host's deadline does.
    const bundle = path.join(project, "loop-server.js")
    await fs.writeFile(
      bundle,
      `__own.serve({ info: { name: "loop", version: "1.0.0" }, list: () => { while (true) {} }, call: async () => "{}" })\n`,
    )
    const started = Date.now()
    const answers = await host(where, {
      project,
      bundle,
      timeoutSeconds: 1,
      messages: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 3, method: "ping", params: {} },
      ],
      until: 3,
    })
    expect(Date.now() - started).toBeLessThan(60_000)
    const listed = answers.find((item) => item.id === 2) as { error?: { message?: string }; result?: unknown } | undefined
    expect(listed?.result).toBeUndefined()
    expect(listed?.error?.message ?? "").toContain("tools/list failed")
    expect(answers.find((item) => item.id === 3)).toMatchObject({ result: {} })
  })

  test("reads the project; refuses `..`, absolute paths, the vault and credential folders", async () => {
    const where = await staged()
    const root = await tempDir()
    const project = path.join(root, "project")
    await fs.mkdir(path.join(project, "sub"), { recursive: true })
    await fs.writeFile(path.join(project, "notes.txt"), "PROJECT-NOTES")
    await fs.mkdir(path.join(where.home, "vault"), { recursive: true })
    await fs.writeFile(path.join(where.home, "vault", "acc.dpapi"), "VAULT-SECRET")
    await fs.mkdir(path.join(project, ".ssh"), { recursive: true })
    await fs.writeFile(path.join(project, ".ssh", "id_rsa"), "KEY-SECRET")
    await fs.writeFile(path.join(root, "outside.txt"), "OUTSIDE")

    expect(await callRead(where, project, "notes.txt")).toContain("PROJECT-NOTES")
    expect(await callRead(where, project, "../outside.txt")).toContain("leaves the project")
    expect(await callRead(where, project, path.join(root, "outside.txt"))).toContain("not a path inside the project")
    expect(await callRead(where, project, ".ssh/id_rsa")).toContain("protected file or folder")
    const vault = path.relative(project, path.join(where.home, "vault", "acc.dpapi")).replaceAll("\\", "/")
    const stolen = await callRead(where, project, vault)
    expect(stolen).not.toContain("VAULT-SECRET")
    expect(await callRead(where, project, "notes.txt::$DATA")).toContain("not a path inside the project")
  })
})
