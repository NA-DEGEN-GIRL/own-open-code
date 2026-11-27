export * as CodePlugins from "./plugins.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Creator } from "@own/protocol/creator"
import type { Registry } from "@own/protocol"
import { Fsx, Home, Lock, Store } from "@own/runtime"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Runtime } from "./runtime.js"
import { Safety } from "./safety.js"
import type { CreatorStore } from "./store.js"

/**
 * C3 in the service (17 §12.4): a code plugin loads through core's local plugin path, an entry at the end of the
 * `plugins` list of the own global config (`%OPENCODE_CONFIG_DIR%\opencode.jsonc`) naming its version folder. An entry
 * exists only while the switch is on and the active version is one the user trusted in Settings (status `active`);
 * every other creator entry is removed. Before an entry is added, own-accounts' `trust.json` gets an approval of the
 * version folder's hash for every Location this service runs own.creator in, so own-accounts finds the new plugin
 * trusted and keeps injecting credentials there; approvals of versions that no longer load are removed after their
 * entry. The launcher keeps creator entries where they are (at the end) when it rewrites its own entries.
 *
 * Core reloads plugins from the first changed entry on, so adding, changing or removing a creator entry at the end
 * reloads no own plugin.
 */

/** Locations whose own.creator instance runs in this process, per store: they get trust approvals. */
const locations = new Map<string, Set<string>>()

/** A crash cleared in this process restarts the plugin: its config entry changes (`restart`). */
const restarts = new Map<string, number>()

export function track(root: string, directory: string) {
  const set = locations.get(root) ?? new Set<string>()
  locations.set(root, set)
  set.add(directory)
  return () => void set.delete(directory)
}

export function restarted(root: string, id: string) {
  restarts.set(`${root}\n${id}`, Date.now())
}

export interface Wanted {
  readonly id: string
  readonly n: number
  readonly dir: string
  readonly hash: string
  readonly entry: string
}

/** The C3 versions that load now: on, trusted, intact, of this app version, with the switch on. */
export function wanted(snapshot: CreatorStore.Snapshot): ReadonlyArray<Wanted> {
  return snapshot.loaded.flatMap((loaded) => {
    const item = loaded.extension?.items.find((entry): entry is Creator.PluginCode => entry.type === "plugin.code")
    const info = loaded.entry.versions.find((version) => version.n === loaded.entry.active)
    if (item === undefined || info === undefined || loaded.status !== "active") return []
    return [{ id: loaded.entry.id, n: loaded.entry.active, dir: loaded.dir, hash: info.hash, entry: Creator.entryOf(item) }]
  })
}

/** The trust source own-accounts lists a creator version under: its server entry (`Trust.sourceOf`). */
export function source(dir: string) {
  return `local:${path.join(dir, "server.ts")}`
}

/**
 * Brings `trust.json` and the config's `plugins` to what `snapshot` wants: approvals first, then the config entries,
 * then the approvals of versions that no longer load. Returns what changed, or why the config could not be written.
 */
export async function sync(
  store: CreatorStore.Store,
  snapshot: CreatorStore.Snapshot,
  configDir: string | undefined,
  options: { readonly create?: boolean } = {},
) {
  const want = wanted(snapshot)
  const directories = [...(locations.get(store.root) ?? [])]
  const trust = Store.trust({ layout: Home.layout(store.home), mutex: trustMutex })
  const ext = path.join(store.root, "ext")
  const isCreator = (entry: Registry.TrustEntry) =>
    entry.source.startsWith("local:") && Safety.inside(entry.source.slice("local:".length), ext)
  const approvedAt = new Date().toISOString()
  if (want.length > 0)
    await trust.update((current) => {
      const missing = want.flatMap((item) =>
        directories
          .filter(
            (directory) =>
              !current.some(
                (entry) =>
                  same(entry.location, directory) && same(entry.source, source(item.dir)) && entry.sha256 === item.hash,
              ),
          )
          .map((directory) => ({ location: directory, source: source(item.dir), sha256: item.hash, approvedAt })),
      )
      return missing.length === 0 ? undefined : [...current, ...missing]
    })
  const config =
    configDir === undefined
      ? { changed: false, reason: "no_config_dir" }
      : await writeConfig(store, configDir, want, options.create === true)
  const stale = (entry: Registry.TrustEntry) =>
    isCreator(entry) && !want.some((item) => same(entry.source, source(item.dir)) && entry.sha256 === item.hash)
  // Read first: most reloads have nothing to remove and need not take the registry lock.
  const current = await trust.read().catch((): Registry.TrustFile => [])
  if (current.some(stale))
    await trust.update((file) => {
      const next = file.filter((entry) => !stale(entry))
      return next.length === file.length ? undefined : next
    })
  return config
}

const trustMutex = new Lock.Mutex()

/**
 * The config's creator entries made to match `want`: stale ones removed, missing ones appended at the end. `create`
 * (an SSH host, 17 §10): the host's `opencode.jsonc` may not exist yet; own-remote rewrites its own `opencode.json` at
 * every connection, so the creator entries live in the `.jsonc` file core reads after it, and nothing else of it
 * changes. With nothing to add, a missing file stays missing.
 */
async function writeConfig(store: CreatorStore.Store, configDir: string, want: ReadonlyArray<Wanted>, create: boolean) {
  const file = path.join(configDir, "opencode.jsonc")
  const read = (await Fsx.readText(file).catch(() => undefined)) ?? undefined
  const text = read ?? (create && want.length > 0 ? "{}\n" : undefined)
  if (text === undefined) return { changed: false, reason: "no_config" }
  const next = configWith(text, store.root, want.map((item) => entryOf(store, item)))
  if (next === undefined) return { changed: false, reason: "config_unreadable" }
  if (next === text) return { changed: false }
  await fs.mkdir(configDir, { recursive: true })
  await Fsx.writeAtomic(file, next)
  return { changed: true }
}

/** The config entry of one version: its folder and the shim's options. */
export function entryOf(store: CreatorStore.Store, item: Wanted) {
  const restart = restarts.get(`${store.root}\n${item.id}`)
  return {
    package: item.dir.replaceAll("\\", "/"),
    options: {
      entry: item.entry,
      version: item.n,
      log: Runtime.logFile(store.root, item.id),
      crashes: Runtime.paths(store.root).crashes,
      hookMs: 2_000,
      // The shim re-hashes the folder against this before importing the entry (F5).
      hash: item.hash,
      ...(restart === undefined ? {} : { restart }),
    },
  }
}

/**
 * `text` with the creator entries of `root` (string or `{package}` entries naming a folder under `root\ext`) made equal
 * to `entries`: a matching one stays where it is, a stale one goes, a missing one is appended. Undefined when the text
 * is not a JSONC object.
 */
export function configWith(text: string, root: string, entries: ReadonlyArray<ReturnType<typeof entryOf>>) {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const plugins = "plugins" in value && Array.isArray(value.plugins) ? (value.plugins as unknown[]) : []
  const ext = path.join(root, "ext")
  const format = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } }
  const packageOf = (entry: unknown) =>
    typeof entry === "string"
      ? entry
      : typeof entry === "object" && entry !== null && "package" in entry && typeof entry.package === "string"
        ? entry.package
        : undefined
  const stale = plugins
    .map((entry, index) => ({ entry, index, target: packageOf(entry) }))
    .filter((item) => item.target !== undefined && Safety.inside(item.target, ext))
    .filter((item) => !entries.some((wanted) => JSON.stringify(wanted) === JSON.stringify(item.entry)))
  const present = plugins.filter((entry) => entries.some((wanted) => JSON.stringify(wanted) === JSON.stringify(entry)))
  const removed = stale
    .toSorted((a, b) => b.index - a.index)
    .reduce((current, item) => applyEdits(current, modify(current, ["plugins", item.index], undefined, format)), text)
  const missing = entries.filter((wanted) => !present.some((entry) => JSON.stringify(entry) === JSON.stringify(wanted)))
  return missing.reduce((current, wanted) => {
    const now: unknown = parse(current, [], { allowTrailingComma: true })
    const count =
      typeof now === "object" && now !== null && "plugins" in now && Array.isArray(now.plugins) ? now.plugins.length : 0
    return applyEdits(current, modify(current, ["plugins", count], wanted, { ...format, isArrayInsertion: true }))
  }, removed)
}

/** The crashes of C3 plugins (`run\crashes.jsonl`, written by the shim), by extension id. */
export async function crashes(root: string): Promise<ReadonlyMap<string, ReadonlyArray<Creator.Crash>>> {
  const text = (await Fsx.readText(Runtime.paths(root).crashes).catch(() => undefined)) ?? ""
  const found = new Map<string, Creator.Crash[]>()
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .forEach((line) => {
      const entry = parseLine(line)
      if (entry === undefined) return
      const list = found.get(entry.id) ?? []
      found.set(entry.id, [...list, entry.crash].slice(-20))
    })
  return found
}

/** Removes the crashes of `id` so its plugin runs again (Settings' 다시 켜기); the plugin reloads. */
export async function clearCrashes(root: string, id: string) {
  const file = Runtime.paths(root).crashes
  const text = (await Fsx.readText(file).catch(() => undefined)) ?? ""
  const kept = text.split("\n").filter((line) => line.trim() !== "" && parseLine(line)?.id !== id)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Fsx.writeAtomic(file, kept.length === 0 ? "" : `${kept.join("\n")}\n`)
  restarted(root, id)
}

function parseLine(line: string) {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== "object" || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.directory !== "string") return undefined
    return {
      id: record.id,
      crash: {
        directory: record.directory,
        version: typeof record.version === "number" ? record.version : 0,
        at: typeof record.at === "number" ? record.at : 0,
        hook: String(record.hook ?? ""),
        message: String(record.message ?? ""),
      },
    }
  } catch {
    return undefined
  }
}

function same(a: string, b: string) {
  if (a.startsWith("local:") && b.startsWith("local:")) return same(a.slice(6), b.slice(6))
  return Safety.inside(a, b) && Safety.inside(b, a)
}
