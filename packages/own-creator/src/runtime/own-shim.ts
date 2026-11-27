// own-shim.ts: how a creator code plugin runs (own/docs/17 §12.2). own writes it into every C3 version beside the
// version's `server.ts` (own-plugin-server.ts), which core loads from the `plugins` list like any local plugin and which
// registers the hooks this file runs; staging's e2e (plugin-check.ts) runs the same file on fixed requests. It imports
// the plugin's entry and gives its hooks a filtered view:
//
// - Only the `context` and `compaction` hooks exist. The plugin gets a JSON copy of the system prompt, the messages and
//   the tool names, never the request's headers, provider options or anything own-accounts injects, and no other
//   domain of the plugin API (no tools, sessions, credentials, RPC, shell or config).
// - What the hook changed is read back: the system texts, the messages it edited or added, a compaction's prompt.
// - A hook that throws, returns something that is not a request, or runs longer than its time stops the plugin in this
//   Location: the event goes on as if the plugin were not there, the crash is written where own.creator reads it
//   (Settings > 확장 shows it), and the plugin stays off here until the user clears it. The service never stops.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export interface ShimOptions {
  readonly entry: string
  readonly version: number
  readonly log: string
  readonly crashes: string
  readonly hookMs: number
  /** The version folder's hash own.creator wrote into this entry; the shim re-checks it before importing (F5). */
  readonly hash?: string
}

export type Hook = "context" | "compaction"

/** The plugin of one Location: the hooks it has and how to run one on an event (never throws). */
export interface Runner {
  readonly hooks: ReadonlyArray<Hook>
  readonly run: (hook: Hook, event: Record<string, unknown>) => Promise<void>
}

/**
 * Loads the plugin of the version in `folder` for `directory`, or undefined when it stays off there (it crashed there
 * before, it does not load, or it exports no plugin). `extension` is the extension's id.
 */
export async function load(input: unknown, folder: string, extension: string, directory: string): Promise<Runner | undefined> {
  const options = readOptions(input)
  if (options === undefined) return undefined
  const where = { ...options, extension }
  if (crashed(where, directory)) {
    log(where, `v${options.version} stays off in ${directory} (it crashed there)`)
    return undefined
  }
  // A fresh hash of the version folder, checked against the one own.creator wrote into this entry (F5): a version
  // whose files changed after it was trusted, or that holds a symbolic link or junction, never imports. The size/mtime
  // cache is not used here; every load reads the bytes.
  const fresh = folderHash(folder)
  if (fresh === undefined) return void crash(where, directory, "load", new Error("the version's folder holds a link"))
  if (options.hash !== undefined && fresh !== options.hash)
    return void crash(where, directory, "load", new Error("the version's files changed after it was approved"))
  const loaded = await import(pathToFileURL(path.join(folder, options.entry)).href).then(
    (module: unknown) => ({ module }),
    (error: unknown) => ({ error }),
  )
  if ("error" in loaded) return void crash(where, directory, "load", loaded.error)
  const hooks = readHooks(loaded.module)
  if (hooks === undefined) return void crash(where, directory, "load", new Error("the entry exports no definePlugin"))
  const state = { off: false }
  log(where, `v${options.version} loaded in ${directory}`)
  return {
    hooks: (["context", "compaction"] as const).filter((hook) => hooks[hook] !== undefined),
    run: async (hook, event) => {
      const handler = hooks[hook]
      if (state.off || handler === undefined) return
      const view = viewOf(event, hook)
      const outcome = await within(options.hookMs, () => handler(view)).then(
        () => apply(event, view, hook),
        (error: unknown) => error,
      )
      if (outcome === undefined) return
      state.off = true
      crash(where, directory, hook, outcome)
    },
  }
}

interface Hooks {
  readonly context?: (request: unknown) => unknown
  readonly compaction?: (request: unknown) => unknown
}

function readHooks(module: unknown): Hooks | undefined {
  const exported = isRecord(module) ? module.default : undefined
  const hooks = isRecord(exported) ? exported.hooks : undefined
  if (!isRecord(hooks)) return undefined
  const pick = (name: Hook) =>
    typeof hooks[name] === "function" ? (hooks[name] as (request: unknown) => unknown) : undefined
  return { context: pick("context"), compaction: pick("compaction") }
}

/** A JSON copy of what a hook may see. */
function viewOf(event: Record<string, unknown>, hook: Hook) {
  const model = isRecord(event.model) ? event.model : {}
  const system = Array.isArray(event.system) ? event.system : []
  return {
    sessionID: String(event.sessionID),
    agent: String(event.agent ?? ""),
    model: { providerID: String(model.providerID ?? ""), id: String(model.id ?? "") },
    system: system.flatMap((part) =>
      isRecord(part) && part.type === "text" ? [{ type: "text", text: String(part.text) }] : [],
    ),
    messages: copy(Array.isArray(event.messages) ? event.messages : []),
    tools: Object.keys(isRecord(event.tools) ? event.tools : {}),
    ...(hook === "compaction" && typeof event.prompt === "string" ? { prompt: event.prompt } : {}),
  }
}

/** Writes back what the hook changed; anything else it did to the copy is ignored. Answers an error to stop it. */
function apply(event: Record<string, unknown>, view: ReturnType<typeof viewOf>, hook: Hook) {
  if (!Array.isArray(view.system) || !Array.isArray(view.messages)) return new Error("the hook replaced the request")
  const system = Array.isArray(event.system) ? event.system : []
  const texts = view.system.map((part) => (isRecord(part) ? String(part.text) : ""))
  const same = texts.length === system.length && texts.every((text, index) => isRecord(system[index]) && system[index].text === text)
  if (!same)
    event.system = texts.map((text, index) => {
      const before = system[index]
      return isRecord(before) && before.type === "text" ? { ...before, text } : { type: "text", text }
    })
  const messages = Array.isArray(event.messages) ? event.messages : []
  const originals = copy(messages)
  const changed =
    view.messages.length !== messages.length ||
    view.messages.some((message, index) => JSON.stringify(message) !== JSON.stringify(originals[index]))
  // A message the hook left as it was keeps its original object (with what JSON cannot carry).
  if (changed)
    event.messages = view.messages.map((message, index) =>
      JSON.stringify(message) === JSON.stringify(originals[index]) ? messages[index] : message,
    )
  if (hook === "compaction" && typeof event.prompt === "string" && typeof view.prompt === "string")
    event.prompt = view.prompt
  return undefined
}

function within(ms: number, run: () => unknown) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the hook ran longer than ${ms} ms`)), ms)
    Promise.resolve()
      .then(run)
      .then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
  })
}

type Where = Pick<ShimOptions, "crashes" | "version" | "log"> & { readonly extension: string }

function crash(options: Where, directory: string, hook: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
  try {
    fs.mkdirSync(path.dirname(options.crashes), { recursive: true })
    fs.appendFileSync(
      options.crashes,
      `${JSON.stringify({ id: options.extension, directory, version: options.version, at: Date.now(), hook, message })}\n`,
    )
  } catch {
    // Not being able to record a crash must not fail the hook either.
  }
  log(options, `v${options.version} stopped in ${directory}: ${hook} threw: ${message}`)
}

function crashed(options: Where, directory: string) {
  try {
    return fs
      .readFileSync(options.crashes, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .some((line) => {
        const entry: unknown = JSON.parse(line)
        return (
          isRecord(entry) &&
          entry.id === options.extension &&
          entry.version === options.version &&
          same(String(entry.directory), directory)
        )
      })
  } catch {
    return false
  }
}

function log(options: Pick<ShimOptions, "log">, line: string) {
  if (options.log === "") return
  try {
    fs.mkdirSync(path.dirname(options.log), { recursive: true })
    fs.appendFileSync(options.log, `${new Date().toISOString()} plugin ${line}\n`)
  } catch {
    // The log is best effort.
  }
}

function readOptions(input: unknown): ShimOptions | undefined {
  if (!isRecord(input)) return undefined
  const entry = input.entry
  if (typeof entry !== "string" || entry.includes("..") || path.isAbsolute(entry)) return undefined
  if (typeof input.version !== "number" || typeof input.log !== "string" || typeof input.crashes !== "string")
    return undefined
  return {
    entry,
    version: input.version,
    log: input.log,
    crashes: input.crashes,
    hookMs: typeof input.hookMs === "number" ? input.hookMs : 2_000,
    ...(typeof input.hash === "string" ? { hash: input.hash } : {}),
  }
}

/**
 * SHA-256 of every file under `dir` the way own-runtime's `Hash.folder` computes it (sorted relative `/`-paths, each
 * path, a NUL, its bytes, a NUL), with `lstat` and no cache. Returns undefined when the folder holds a symbolic link,
 * a junction or any other non-file, non-folder entry (which must never load, F5).
 */
function folderHash(dir: string): string | undefined {
  const files: string[] = []
  const walk = (prefix: string): boolean => {
    for (const name of fs.readdirSync(path.join(dir, ...prefix.split("/").filter(Boolean)))) {
      const relative = prefix === "" ? name : `${prefix}/${name}`
      const stat = fs.lstatSync(path.join(dir, ...relative.split("/")))
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return false
      if (stat.isDirectory()) {
        if (!walk(relative)) return false
      } else files.push(relative)
    }
    return true
  }
  try {
    if (!walk("")) return undefined
  } catch {
    return undefined
  }
  const hash = createHash("sha256")
  for (const file of files.toSorted()) {
    hash.update(`${file}\0`)
    hash.update(fs.readFileSync(path.join(dir, ...file.split("/"))))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function same(a: string, b: string) {
  const key = (value: string) => {
    const forward = path.resolve(value).replaceAll("\\", "/")
    return process.platform === "win32" ? forward.toLowerCase() : forward
  }
  return key(a) === key(b)
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
