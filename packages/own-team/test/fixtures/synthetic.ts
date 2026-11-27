/**
 * F3 (06 §11.2): a synthetic repository of `entries` files written by `git fast-import`, so nothing is checked out
 * and 100k entries take seconds. About 1.5% are code (`src/`, `docs/`, `tools/`, `Assets/Scripts/`); the rest sit in
 * the heavy folders as LFS pointers to objects that exist nowhere. A worktree that checked out a heavy file would
 * fail its smudge, so a leak cannot pass silently.
 *
 * The home is a non-bare repository without a checkout (empty index): `worktree add` only needs the repository.
 */
import path from "node:path"
import { git, init } from "./repo.js"

export const F3_HEAVY = ["Assets/Textures", "Assets/Audio", "Content"] as const

/** The cone the complement of {@link F3_HEAVY} gives for this layout. */
export const F3_CONE = ["Assets/Scripts", "docs", "src", "tools"] as const

export interface F3 {
  readonly home: string
  readonly head: string
  /** Files in the code part (the cone, plus the forced root and `Assets/` files). */
  readonly code: readonly string[]
  readonly entries: number
}

export function synthetic(root: string, entries = 100_000): F3 {
  const home = init(path.join(root, "home"))
  const codeCount = Math.max(20, Math.round(entries * 0.015))
  const code = [
    "README.md",
    ".gitattributes",
    "Assets/Textures.meta",
    ...Array.from({ length: codeCount }, (_, index) => codeFile(index)),
  ]
  const heavy = Array.from({ length: Math.max(0, entries - code.length) }, (_, index) => heavyFile(index))
  const pointer = [
    "version https://git-lfs.github.com/spec/v1",
    `oid sha256:${"5".repeat(64)}`,
    "size 2000000",
    "",
  ].join("\n")
  const attributes = "*.png filter=lfs diff=lfs merge=lfs -text\n*.wav filter=lfs diff=lfs merge=lfs -text\n"
  const stream = [
    blob(1, "export const value = 1\n"),
    blob(2, pointer),
    blob(3, attributes),
    "commit refs/heads/main",
    "mark :4",
    "committer own-team test <own-team@example.invalid> 1700000000 +0000",
    data("F3"),
    ...code.map((file) => `M 100644 :${file === ".gitattributes" ? 3 : 1} ${file}`),
    ...heavy.map((file) => `M 100644 :2 ${file}`),
    "",
  ].join("\n")
  git(home, ["fast-import", "--quiet"], { stdin: stream })
  return {
    home,
    head: git(home, ["rev-parse", "main"]).trim(),
    code: code.toSorted(),
    entries: code.length + heavy.length,
  }
}

function codeFile(index: number) {
  const area = ["src", "docs", "tools", "Assets/Scripts"][index % 4]
  return `${area}/m${Math.floor(index / 40) % 25}/f${index}.ts`
}

function heavyFile(index: number) {
  const area = F3_HEAVY[index % F3_HEAVY.length]
  const extension = area === "Assets/Audio" ? "wav" : "png"
  return `${area}/d${Math.floor(index / 100) % 200}/x${index}.${extension}`
}

function blob(mark: number, content: string) {
  return ["blob", `mark :${mark}`, data(content)].join("\n")
}

function data(content: string) {
  return `data ${Buffer.byteLength(content)}\n${content}`
}
