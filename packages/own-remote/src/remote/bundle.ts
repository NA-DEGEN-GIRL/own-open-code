export * as Bundle from "./bundle.js"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"

/**
 * Local remote bundles (04 §5.2): `app\<ver>\remote\<target>.tar.gz` plus `remote\manifest.json`, written by
 * `own/scripts/build-remote.ps1`. The manifest carries the per-file sha256 the remote install checks
 * (`sha256sum -c`) and the archive hash own-remote checks before uploading. Pinned tools (06 §4.13 git-lfs) lie
 * beside the archives as plain files, `tools/<tool>/<version>/<target>/`, listed under `tools`.
 */
export const Target = Schema.Struct({
  file: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Int,
  files: Schema.Record(Schema.String, Schema.String),
})

/** A pinned tool: per target, `file` is the executable (relative to `remote\`) and `files` every file of its folder. */
export const Tool = Schema.Struct({
  version: Schema.String,
  targets: Schema.Record(Schema.String, Target),
})

export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: Schema.String,
  build_id: Schema.String,
  proto: Schema.Int,
  channel: Schema.Literal("own"),
  targets: Schema.Record(Schema.String, Target),
  tools: optional(Schema.Struct({ "git-lfs": optional(Tool) })),
})
export type Manifest = typeof Manifest.Type

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))

export interface Located {
  readonly manifest: Manifest
  readonly target: string
  readonly archive: string
  readonly bytes: number
  /** `sha256sum -c` lines for the files inside the archive. */
  readonly sums: string
}

export type LocateResult =
  | { readonly ok: true; readonly bundle: Located }
  | { readonly ok: false; readonly reason: "manifest_missing" | "target_missing" | "archive_missing"; readonly path: string }

export async function locate(dir: string, target: string): Promise<LocateResult> {
  const manifestPath = path.join(dir, "manifest.json")
  const text = await fs.readFile(manifestPath, "utf8").catch(() => undefined)
  if (text === undefined) return { ok: false, reason: "manifest_missing", path: manifestPath }
  const manifest = decode(text)
  const entry = manifest.targets[target]
  if (!entry) return { ok: false, reason: "target_missing", path: manifestPath }
  const archive = path.join(dir, path.basename(entry.file))
  const stat = await fs.stat(archive).catch(() => undefined)
  if (!stat) return { ok: false, reason: "archive_missing", path: archive }
  const sums = Object.entries(entry.files)
    .map(([file, hash]) => {
      if (file.includes("\n") || file.startsWith("/") || file.split("/").includes("..")) throw new Error(`bad path ${file}`)
      return `${hash.replace(/^sha256:/, "")}  ${file}`
    })
    .join("\n")
  return { ok: true, bundle: { manifest, target, archive, bytes: stat.size, sums } }
}

/** Reads and checks the archive against the manifest hash before it is sent (supply chain, 04 §15). */
export async function read(bundle: Located) {
  const data = new Uint8Array(await fs.readFile(bundle.archive))
  const hash = createHash("sha256").update(data).digest("hex")
  const expected = bundle.manifest.targets[bundle.target]?.sha256.replace(/^sha256:/, "")
  if (hash !== expected) throw new Error(`bundle hash mismatch for ${bundle.target}`)
  return data
}

export type ToolName = keyof NonNullable<Manifest["tools"]>

export interface LocatedTool {
  readonly tool: ToolName
  readonly version: string
  /** The tool's local folder, `<remote>\tools\<tool>\<version>\<target>`. */
  readonly dir: string
  /** File name of the executable in that folder. */
  readonly binary: string
  readonly entry: typeof Target.Type
}

export type LocateToolResult =
  | { readonly ok: true; readonly tool: LocatedTool }
  | { readonly ok: false; readonly reason: "manifest_missing" | "tool_missing" | "file_missing"; readonly path: string }

/**
 * A pinned tool of the release for a target (06 §4.13). The manifest entry must name a version and flat file names
 * the tool script can take (`[A-Za-z0-9._-]`), the executable among them; every file must exist.
 */
export async function locateTool(dir: string, tool: ToolName, target: string): Promise<LocateToolResult> {
  const manifestPath = path.join(dir, "manifest.json")
  const text = await fs.readFile(manifestPath, "utf8").catch(() => undefined)
  if (text === undefined) return { ok: false, reason: "manifest_missing", path: manifestPath }
  const pinned = decode(text).tools?.[tool]
  const entry = pinned?.targets[target]
  const parts = entry?.file.split("/") ?? []
  const binary = parts.at(-1) ?? ""
  const names = Object.keys(entry?.files ?? {})
  if (
    !pinned ||
    !entry ||
    !/^[0-9][0-9A-Za-z.+-]*$/.test(pinned.version) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    !names.includes(binary) ||
    names.some((name) => !/^[A-Za-z0-9._-]+$/.test(name))
  )
    return { ok: false, reason: "tool_missing", path: manifestPath }
  const folder = path.join(dir, ...parts.slice(0, -1))
  const missing = (
    await Promise.all(
      names.map(async (name) =>
        (await fs.stat(path.join(folder, name)).catch(() => undefined))?.isFile() ? [] : [name],
      ),
    )
  ).flat()
  if (missing.length > 0) return { ok: false, reason: "file_missing", path: path.join(folder, missing[0]!) }
  return { ok: true, tool: { tool, version: pinned.version, dir: folder, binary, entry } }
}

/**
 * Reads the tool's files and checks them against the manifest before anything is sent (06 §4.13): each file's
 * `files` hash, and the executable's `sha256` and `bytes`. `payload` is the files back to back with the executable
 * last (the tool script reads the others by size and the executable to the end of stdin).
 */
export async function readTool(located: LocatedTool) {
  const names = [
    ...Object.keys(located.entry.files)
      .filter((name) => name !== located.binary)
      .sort(),
    located.binary,
  ]
  const files = await Promise.all(
    names.map(async (name) => {
      const data = new Uint8Array(await fs.readFile(path.join(located.dir, name)))
      return { name, data, sha256: createHash("sha256").update(data).digest("hex") }
    }),
  )
  const expected = (name: string) => located.entry.files[name]!.replace(/^sha256:/, "")
  const binary = files.at(-1)!
  const wrong = [
    ...files
      .filter((file) => file.sha256 !== expected(file.name))
      .map((file) => ({ expected: expected(file.name), actual: file.sha256 })),
    ...(binary.sha256 === located.entry.sha256.replace(/^sha256:/, "") && binary.data.length === located.entry.bytes
      ? []
      : [{ expected: located.entry.sha256.replace(/^sha256:/, ""), actual: binary.sha256 }]),
  ]
  if (wrong.length > 0) return { ok: false as const, ...wrong[0]! }
  return {
    ok: true as const,
    payload: Buffer.concat(files.map((file) => file.data)),
    files: files.map((file) => ({ name: file.name, bytes: file.data.length })),
    sums: files.map((file) => `${file.sha256}  ${file.name}`).join("\n"),
  }
}
