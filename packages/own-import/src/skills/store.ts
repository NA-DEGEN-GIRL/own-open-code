export * as SkillStore from "./store.js"

import fsp from "node:fs/promises"
import path from "node:path"
import { OwnImport } from "@own/protocol/rpc-import"
import { Fsx, Store } from "@own/runtime"
import { Schema } from "effect"

/**
 * own's own files of the skills feature (09 §9.4), the one module of `src/skills` that touches files: own's skills
 * folder (copies placed atomically), `OWN_HOME/state/skill-imports.json` (what own-import copied, through own-runtime)
 * and the staging and git folders under `OWN_HOME/tmp`. It never reads or writes another tool's folder: found skills
 * are read through `Paths` (`sources/paths.ts`) and arrive here as bytes.
 */

/** `OWN_HOME/state/skill-imports.json`: one row per own copy, never file content. */
export const RecordsFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  items: Schema.Array(OwnImport.SkillImport),
})
export type RecordsFile = typeof RecordsFile.Type

export function records(home: string) {
  return new Store.JsonFile({
    file: path.join(home, "state", "skill-imports.json"),
    schema: RecordsFile,
    fallback: (): RecordsFile => ({ schemaVersion: 1, items: [] }),
  })
}

/** One file of a skill: its path relative to the skill folder (`/`-separated) and its bytes. */
export interface File {
  readonly relative: string
  readonly bytes: Uint8Array
}

/** Whether own's skills folder has an entry `id` (a folder, a file or a link). */
export function exists(skillsDir: string, id: string) {
  return fsp.lstat(path.join(skillsDir, id)).then(
    () => true,
    () => false,
  )
}

/** Temp folders of this module are older than this when a later call sweeps them (a killed service leaves them). */
export const STALE_MS = 10 * 60 * 1000
const PREFIX = "skill-"

/**
 * Places `files` as `<skillsDir>/<id>`: written into a staging folder under `OWN_HOME/tmp` first and renamed into
 * place, so core's watcher never sees a half-written skill. `replace` moves the existing folder aside first and
 * removes it only after the new one is in place (restored when the rename fails).
 */
export async function place(input: {
  readonly home: string
  readonly skillsDir: string
  readonly id: string
  readonly files: ReadonlyArray<File>
  readonly replace: boolean
}) {
  const staging = await temp(input.home, "stage")
  const target = path.join(input.skillsDir, input.id)
  const built = path.join(staging, input.id)
  const aside = path.join(staging, "previous")
  await Promise.all(
    input.files.map(async (file) => {
      const destination = inside(built, file.relative)
      await fsp.mkdir(path.dirname(destination), { recursive: true })
      await fsp.writeFile(destination, file.bytes, { flag: "wx" })
    }),
  )
  await fsp.mkdir(input.skillsDir, { recursive: true })
  const moved = input.replace && (await exists(input.skillsDir, input.id))
  if (moved) await move(target, aside)
  await move(built, target).catch(async (error: unknown) => {
    if (moved) await move(aside, target)
    throw error
  })
  await remove(staging)
  return target
}

/**
 * Takes `<skillsDir>/<id>` out of own's skills folder: renamed into a staging folder under `OWN_HOME/tmp` first, so
 * core's watcher sees the skill go at once, then removed. `id` is a checked skill id (no separator).
 */
export async function discard(input: { readonly home: string; readonly skillsDir: string; readonly id: string }) {
  const staging = await temp(input.home, "discard")
  await move(path.join(input.skillsDir, input.id), path.join(staging, input.id))
  await remove(staging)
}

/** A fresh folder `OWN_HOME/tmp/skill-<label>-<random>`; stale ones of earlier runs go first. */
export async function temp(home: string, label: string) {
  const root = path.join(home, "tmp")
  await sweep(root)
  await fsp.mkdir(root, { recursive: true })
  return fsp.mkdtemp(path.join(root, `${PREFIX}${label}-`))
}

/** Removes a folder this module made; never throws. */
export function remove(folder: string) {
  return Fsx.removeTree(folder).catch(() => undefined)
}

/**
 * The bytes of `relative` files under a git working folder this module made (`temp`), each checked to stay inside
 * it and to be a plain file. `undefined` for a missing, linked or unreadable file.
 */
export async function readCheckout(folder: string, relative: string) {
  const file = inside(folder, relative)
  const stat = await fsp.lstat(file).catch(() => undefined)
  if (stat === undefined || !stat.isFile()) return undefined
  return fsp.readFile(file).then(
    (bytes) => new Uint8Array(bytes),
    () => undefined,
  )
}

/**
 * own-import's copy `<skillsDir>/<id>` as it is now (`상세 보기`, SK2): its plain files with bytes, sorted, links and
 * anything else left out; `undefined` past `limits` (files, bytes) or when the folder is gone.
 */
export async function readCopy(
  skillsDir: string,
  id: string,
  limits: { readonly files: number; readonly bytes: number },
): Promise<File[] | undefined> {
  const base = path.join(skillsDir, id)
  const names = await fsp.readdir(base, { recursive: true }).catch(() => undefined)
  if (names === undefined || names.length > limits.files * 4) return undefined
  const entries = await Promise.all(
    names.map(async (name) => {
      const file = path.join(base, name)
      const stat = await fsp.lstat(file).catch(() => undefined)
      return stat?.isFile() ? { file, relative: name.split(path.sep).join("/"), size: stat.size } : undefined
    }),
  )
  const plain = entries.filter((entry) => entry !== undefined)
  if (plain.length > limits.files || plain.reduce((sum, entry) => sum + entry.size, 0) > limits.bytes) return undefined
  const read = await Promise.all(
    plain.map(async (entry) => {
      const bytes = await fsp.readFile(entry.file).catch(() => undefined)
      return bytes === undefined ? undefined : { relative: entry.relative, bytes: new Uint8Array(bytes) }
    }),
  )
  if (!read.every((file) => file !== undefined)) return undefined
  return read.toSorted((a, b) => (a.relative < b.relative ? -1 : 1))
}

/** Moves a folder; across volumes (rename refuses with `EXDEV`) it copies and removes the source. */
async function move(from: string, to: string) {
  await fsp.rename(from, to).catch(async (error: unknown) => {
    if (Fsx.code(error) !== "EXDEV") throw error
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await remove(from)
  })
}

/** `relative` below `folder`, refusing anything that would leave it (`..`, absolute or drive paths, NUL). */
function inside(folder: string, relative: string) {
  const parts = relative.split("/")
  if (parts.some((part) => part === "" || part === "." || part === ".." || /[\\:\0]/.test(part)))
    throw new Error("unsafe path in a skill")
  return path.join(folder, ...parts)
}

/** Removes `OWN_HOME/tmp/skill-*` folders older than {@link STALE_MS}. */
async function sweep(root: string) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  const now = Date.now()
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX))
      .map(async (entry) => {
        const folder = path.join(root, entry.name)
        const stat = await fsp.stat(folder).catch(() => undefined)
        if (stat !== undefined && now - stat.mtimeMs > STALE_MS) await remove(folder)
      }),
  )
}
