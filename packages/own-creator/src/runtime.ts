export * as Runtime from "./runtime.js"

import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Fsx } from "@own/runtime"
// Each file below is own's code that runs outside this plugin: in a version folder (the helpers a server or plugin
// imports, the shim core loads) or in a child process (the MCP host, the plugin check). Bun reads them as text here and
// inlines the text into the release bundle; the package's typecheck checks them as modules.
// @ts-expect-error a source file read as text
import MCP_HOST from "./runtime/mcp-host.js" with { type: "text" }
// @ts-expect-error a source file read as text
import OWN_MCP from "./runtime/own-mcp.js" with { type: "text" }
// @ts-expect-error a source file read as text
import OWN_PLUGIN from "./runtime/own-plugin.js" with { type: "text" }
// @ts-expect-error a source file read as text
import OWN_SHIM from "./runtime/own-shim.js" with { type: "text" }
// Typed as the module it is (it has a default export); the import still reads its text.
import PLUGIN_SERVER from "./runtime/own-plugin-server.js" with { type: "text" }
// @ts-expect-error a source file read as text
import PLUGIN_CHECK from "./runtime/plugin-check.js" with { type: "text" }
import PLUGIN_GLOBALS from "./text/plugin-globals.d.ts.txt" with { type: "text" }

/** Files own writes into a C2 server's folder (own's in-sandbox helper). */
export const SERVER_FILES: Readonly<Record<string, string>> = { "own-mcp.ts": String(OWN_MCP) }

/** The single JavaScript file staging bundles a C2 server into; own's host loads it inside the sandbox. */
export const BUNDLE = "server.bundle.js"

/** Files own writes into a C3 version's folder: the API, the shim, the entry core loads, the globals for the typecheck. */
export const PLUGIN_FILES: Readonly<Record<string, string>> = {
  "own-plugin.ts": String(OWN_PLUGIN),
  "own-shim.ts": String(OWN_SHIM),
  "server.ts": String(PLUGIN_SERVER),
  "own-plugin-env.d.ts": String(PLUGIN_GLOBALS),
}

/** own's child-process scripts, written into `OWN_HOME\creator\runtime` (17 §4.1). */
const SCRIPTS: Readonly<Record<string, string>> = {
  "mcp-host.ts": String(MCP_HOST),
  "plugin-check.ts": String(PLUGIN_CHECK),
}

/** Where the store keeps its working files. */
export function paths(root: string) {
  return {
    runtime: path.join(root, "runtime"),
    host: path.join(root, "runtime", "mcp-host.ts"),
    check: path.join(root, "runtime", "plugin-check.ts"),
    stage: path.join(root, "stage"),
    temp: path.join(root, "temp"),
    cache: path.join(root, "cache", "bun"),
    logs: path.join(root, "logs"),
    crashes: path.join(root, "run", "crashes.jsonl"),
  }
}

export function logFile(root: string, id: string) {
  return path.join(root, "logs", `${id}.log`)
}

/** Writes own's scripts into the runtime folder when their text changed. */
export async function materialize(root: string) {
  const folder = paths(root).runtime
  await fs.mkdir(folder, { recursive: true })
  await Promise.all(
    Object.entries(SCRIPTS).map(async ([name, text]) => {
      const file = path.join(folder, name)
      if ((await Fsx.readText(file).catch(() => undefined)) !== text) await Fsx.writeAtomic(file, text)
    }),
  )
}

/**
 * The folder of `@types` a C2 server is typechecked against (Bun's and Node's declarations): the release bundle's copy
 * beside this plugin (`types\node_modules\@types`), else the one this package resolves in a source run.
 */
export function typesRoot(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.join(here, "types", "node_modules", "@types")
  if (existsSync(path.join(bundled, "bun"))) return bundled
  try {
    return path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@types/bun/package.json"))))
  } catch {
    return undefined
  }
}

/**
 * own's WebAssembly JavaScript engine (QuickJS) for a C2 sandbox: the absolute module paths of `quickjs-emscripten-core`
 * and a release variant. The release bundle copies them beside own-creator's index.js (`own-remote bundle.ts`
 * `CREATOR_QUICKJS`), a source run resolves them from own-creator's dependencies.
 */
export function quickjs(): { readonly core: string; readonly variant: string } {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.join(here, "quickjs")
  if (existsSync(path.join(bundled, "core", "index.mjs")) && existsSync(path.join(bundled, "variant", "index.mjs")))
    return { core: path.join(bundled, "core", "index.mjs"), variant: path.join(bundled, "variant", "index.mjs") }
  const from = fileURLToPath(import.meta.url)
  return {
    core: Bun.resolveSync("quickjs-emscripten-core", path.dirname(from)),
    variant: Bun.resolveSync("@jitl/quickjs-wasmfile-release-sync", path.dirname(from)),
  }
}

/**
 * Bundles a C2 server or one of its test files into a single JavaScript file for the sandbox: `./own-mcp.ts`, the
 * server's own files and its installed dependencies inlined, TypeScript transpiled, macros refused. Node and Bun
 * built-ins are not provided, so an import of one (which the lint already refuses) fails the bundle too.
 */
export async function bundle(input: { readonly entry: string; readonly cwd: string; readonly out: string }) {
  const built = await Bun.build({
    entrypoints: [input.entry],
    target: "browser",
    format: "esm",
    // SAFETY: `macro: false` refuses `with { type: "macro" }` imports instead of running them (absent from the types).
    ...({ macro: false } as Record<string, unknown>),
  }).catch((error: unknown) => ({ success: false as const, logs: [error], outputs: [] as Array<{ text(): Promise<string> }> }))
  if (!built.success) return { ok: false as const, detail: built.logs.map((entry) => String(entry)).join("\n").slice(0, 2_000) }
  const text = await built.outputs[0]!.text()
  await Fsx.writeSynced(input.out, text)
  return { ok: true as const }
}

/** Appends lines to the extension's log, moving it to `.1` past 256 KiB. */
export async function log(root: string, id: string, lines: ReadonlyArray<string>) {
  const file = logFile(root, id)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const size = (await fs.stat(file).catch(() => undefined))?.size ?? 0
  if (size > LOG_BYTES) await Fsx.rename(file, `${file}.1`).catch(() => undefined)
  const stamp = new Date().toISOString()
  await fs.appendFile(file, lines.map((line) => `${stamp} ${line}\n`).join(""))
}

export const LOG_BYTES = 256 * 1024

/** The end of the extension's log, newest last. */
export async function readLog(root: string, id: string, max = 300) {
  const file = logFile(root, id)
  const read = async (name: string) => (await Fsx.readText(name).catch(() => undefined)) ?? ""
  const text = [await read(`${file}.1`), await read(file)].join("")
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-max)
}
