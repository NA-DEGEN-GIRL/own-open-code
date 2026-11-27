export * as Porcelain from "./porcelain.js"

/**
 * Parsers for the `-z` outputs own.team reads (06 §3.2, §4.5, §11.2 "porcelain `-z` 파서"). Paths are taken verbatim
 * (`core.quotepath=false` and `-z` mean no quoting), so a path may contain spaces, a leading `-` or non-ASCII text.
 */

/** NUL-separated fields without the empty one after the last terminator. */
export function fields(stdout: string) {
  const parts = stdout.split("\0")
  return parts.at(-1) === "" ? parts.slice(0, -1) : parts
}

export type Entry =
  /** `1`: changed tracked entry. `xy` is the two-letter staged/unstaged state (`D.` = deletion staged, file gone). */
  | { readonly kind: "changed"; readonly xy: string; readonly path: string }
  /** `2`: renamed or copied; `from` is the original path. */
  | { readonly kind: "renamed"; readonly xy: string; readonly path: string; readonly from: string }
  | { readonly kind: "unmerged"; readonly xy: string; readonly path: string }
  | { readonly kind: "untracked"; readonly path: string }
  | { readonly kind: "ignored"; readonly path: string }

export interface Branch {
  readonly oid?: string
  /** `(detached)` when HEAD is detached. */
  readonly head?: string
  readonly upstream?: string
  readonly ahead?: number
  readonly behind?: number
}

export interface Status {
  readonly entries: readonly Entry[]
  /** The `# branch.*` headers (`--branch`). */
  readonly branch: Branch
}

/** `git status --porcelain=v2 -z [--branch]`. */
export function status(stdout: string): Status {
  const parts = fields(stdout)
  const entries: Entry[] = []
  const branch: Branch[] = []
  // Sequential: a `2` record is followed by its original path as a separate field, whatever that path looks like.
  for (let index = 0; index < parts.length; index++) {
    const field = parts[index]
    if (field.startsWith("# ")) {
      branch.push(header(field.slice(2)))
      continue
    }
    const entry = parseEntry(field, parts[index + 1])
    if (entry) entries.push(entry)
    if (entry?.kind === "renamed") index++
  }
  return { entries, branch: Object.assign({}, ...branch) }
}

/**
 * Right after `worktree add --no-checkout` the index is empty and every file of HEAD shows as a staged deletion
 * (`D.`), with nothing else (06 §4.5, [R-review] e7). A worktree in this state is unpopulated: steps 2-4 come first.
 */
export function onlyStagedDeletions(value: Status) {
  return value.entries.length > 0 && value.entries.every((entry) => entry.kind === "changed" && entry.xy === "D.")
}

export interface Worktree {
  /** As git prints it: forward slashes on Windows. */
  readonly path: string
  readonly head?: string
  /** Full ref (`refs/heads/x`); absent when detached or bare. */
  readonly branch?: string
  readonly detached: boolean
  readonly bare: boolean
  /** The lock reason (empty for a lock without one); absent when not locked. */
  readonly locked?: string
  /** Its folder is gone (`git worktree prune` would drop it); the reason, possibly empty. */
  readonly prunable?: string
}

/** `git worktree list --porcelain -z`: NUL-terminated lines, an empty one after each worktree, the main one first. */
export function worktrees(stdout: string): Worktree[] {
  return stdout
    .split("\0\0")
    .map((record) => record.split("\0").filter(Boolean))
    .flatMap((lines) => {
      const head = lines[0]
      if (!head?.startsWith("worktree ")) return []
      const value = (name: string) => {
        const line = lines.find((item) => item === name || item.startsWith(`${name} `))
        return line === undefined ? undefined : line.slice(name.length + 1)
      }
      return [
        {
          path: head.slice("worktree ".length),
          head: value("HEAD"),
          branch: value("branch"),
          detached: lines.includes("detached"),
          bare: lines.includes("bare"),
          locked: value("locked"),
          prunable: value("prunable"),
        },
      ]
    })
}

/** `git ls-files --sparse -z`: files, and one `dir/` entry per collapsed sparse directory. */
export function sparseDirectories(stdout: string) {
  return fields(stdout)
    .filter((entry) => entry.endsWith("/"))
    .map((entry) => entry.slice(0, -1))
}

function parseEntry(field: string, next: string | undefined): Entry | undefined {
  const kind = field[0]
  if (kind === "?") return { kind: "untracked", path: field.slice(2) }
  if (kind === "!") return { kind: "ignored", path: field.slice(2) }
  const xy = field.slice(2, 4)
  // Fields before the path: `1` has 8, `2` has 9 (the last is the score), `u` has 10.
  if (kind === "1") return { kind: "changed", xy, path: after(field, 8) }
  if (kind === "2") return { kind: "renamed", xy, path: after(field, 9), from: next ?? "" }
  if (kind === "u") return { kind: "unmerged", xy, path: after(field, 10) }
  return undefined
}

/** The rest of `field` after `count` space-separated tokens (the path may itself contain spaces). */
function after(field: string, count: number) {
  return field.split(" ").slice(count).join(" ")
}

function header(text: string): Branch {
  const space = text.indexOf(" ")
  const name = text.slice(0, space)
  const value = text.slice(space + 1)
  if (name === "branch.oid") return { oid: value }
  if (name === "branch.head") return { head: value }
  if (name === "branch.upstream") return { upstream: value }
  if (name === "branch.ab") {
    const [ahead, behind] = value.split(" ")
    return { ahead: Number(ahead), behind: Math.abs(Number(behind)) }
  }
  return {}
}
