export * as Refs from "./refs.js"

import { Git } from "./run.js"

/**
 * own's git markers (06 §2.4): `refs/own/keep/<sha>`, `refs/own/hold/<area|assets>/<opID>` and
 * `refs/own/integrate/<igID>/{base,source,candidate}`, and new branches. All are create-only: `update-ref <ref> <oid>
 * <zero>` fails when the ref exists, and a `--stdin` transaction creates all of its refs or none ([R-adopt]).
 *
 * Resuming after a restart (06 §8.5) reads "already exists" by the kind of ref: a `keep` or `integrate` ref (and a
 * branch) is done when it already holds the same value; a `hold` ref is done whatever its value, because its commit
 * carries a time. Git's message is never parsed (it is translated in some locales): after a failure the refs are
 * read back.
 */

export interface Item {
  readonly ref: string
  readonly oid: string
}

export type Created =
  /** `created: false` = it already existed and counts as done (resume). `oid` is the ref's value now. */
  | { readonly ok: true; readonly created: boolean; readonly oid: string }
  /** It exists with another value (a `keep`, `integrate` or branch ref). */
  | {
      readonly ok: false
      readonly error: "exists"
      readonly ref: string
      readonly oid: string
      readonly message: string
    }
  | { readonly ok: false; readonly error: "invalid" | "git"; readonly message: string }

export type CreatedAll =
  | { readonly ok: true; readonly created: boolean }
  | {
      readonly ok: false
      readonly error: "exists"
      readonly refs: ReadonlyArray<{ readonly ref: string; readonly oid: string | null; readonly expected: string }>
      readonly message: string
    }
  | { readonly ok: false; readonly error: "invalid" | "git"; readonly message: string }

/** A `hold` ref is done once it exists, whatever its value (06 §2.4). */
export function anyValue(ref: string) {
  return ref.startsWith("refs/own/hold/")
}

/** The all-zero name of the same length as `oid`: "must not exist" for `update-ref`. */
export function zero(oid: string) {
  return "0".repeat(oid.length)
}

/**
 * A full ref name own may write: `refs/…`, no whitespace or control characters, none of `~^:?*[\`, no `..`, `//` or
 * `@{`, no component starting with `.` and none ending with `.lock`. A subset of `git check-ref-format`.
 */
export function valid(ref: string) {
  if (!ref.startsWith("refs/") || ref.endsWith("/") || ref.endsWith(".")) return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref) || ref.includes("..") || ref.includes("//") || ref.includes("@{"))
    return false
  return ref.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
}

/** Create one ref that must not exist yet. */
export async function create(directory: string, item: Item, message = "own.team"): Promise<Created> {
  if (!valid(item.ref)) return { ok: false, error: "invalid", message: `쓸 수 없는 이름이에요: ${item.ref}` }
  const result = await Git.run(["update-ref", "-m", message, item.ref, item.oid, zero(item.oid)], {
    cwd: directory,
    write: true,
    worktree: true,
  })
  if (result.ok) return { ok: true, created: true, oid: item.oid }
  if (result.reason === "refused") return { ok: false, error: "invalid", message: result.message }
  const existing = await read(directory, item.ref)
  if (existing === undefined || existing === null) return { ok: false, error: "git", message: result.message }
  if (existing === item.oid || anyValue(item.ref)) return { ok: true, created: false, oid: existing }
  return {
    ok: false,
    error: "exists",
    ref: item.ref,
    oid: existing,
    message: `이미 다른 저장 지점(${existing})에 있어요: ${item.ref}`,
  }
}

/**
 * Create several refs in one `update-ref --stdin` transaction (06 §8.5). When it fails, the refs are read back: if
 * every existing one counts as done, the missing ones are created in one more transaction; any other value is
 * `exists` and nothing was written by this call.
 */
export async function createAll(directory: string, items: readonly Item[], message = "own.team"): Promise<CreatedAll> {
  const invalid = items.find((item) => !valid(item.ref))
  if (invalid) return { ok: false, error: "invalid", message: `쓸 수 없는 이름이에요: ${invalid.ref}` }
  const first = await transaction(directory, items, message)
  if (first.ok) return { ok: true, created: true }
  if (first.reason === "refused") return { ok: false, error: "invalid", message: first.message }
  const observed = await Promise.all(
    items.map(async (item) => ({ ref: item.ref, expected: item.oid, oid: await read(directory, item.ref) })),
  )
  if (observed.some((item) => item.oid === undefined)) return { ok: false, error: "git", message: first.message }
  const conflicting = observed.filter(
    (item) => typeof item.oid === "string" && item.oid !== item.expected && !anyValue(item.ref),
  )
  if (conflicting.length > 0)
    return {
      ok: false,
      error: "exists",
      refs: observed.map((item) => ({ ref: item.ref, expected: item.expected, oid: item.oid ?? null })),
      message: `이미 다른 저장 지점에 있어요: ${conflicting.map((item) => `${item.ref}(${item.oid})`).join(", ")}`,
    }
  const missing = items.filter((_, index) => observed[index].oid === null)
  // Nothing existed, so the transaction failed for another reason.
  if (missing.length === items.length) return { ok: false, error: "git", message: first.message }
  if (missing.length === 0) return { ok: true, created: false }
  const second = await transaction(directory, missing, message)
  if (second.ok) return { ok: true, created: true }
  return { ok: false, error: "git", message: second.message }
}

/** The ref's value; `null` when it does not exist; `undefined` when git could not answer. */
export async function read(directory: string, ref: string): Promise<string | null | undefined> {
  // `for-each-ref` exits 0 for a missing ref (`show-ref --verify` exits 128 for both a missing ref and an error, and
  // `--exists` needs Git 2.43). It also matches longer names below `ref/`, so only the exact name counts.
  const result = await Git.run(["for-each-ref", "--format=%(refname)%00%(objectname)", ref], {
    cwd: directory,
    worktree: true,
  })
  if (!result.ok) return undefined
  const line = result.stdout
    .split("\n")
    .map((entry) => entry.split("\0"))
    .find((parts) => parts[0] === ref)
  return line?.[1] ?? null
}

/**
 * Delete `ref` only while it still holds `oid` (CAS). The one place own deletes a ref it made: a branch the enable
 * just created, still at its base and used by no folder (06 TI-4), and an `integrate` ref after use (06 §2.4).
 */
export async function removeIf(directory: string, item: Item, message = "own.team"): Promise<Removed> {
  if (!valid(item.ref)) return { ok: false, error: "invalid", message: `쓸 수 없는 이름이에요: ${item.ref}` }
  const result = await Git.run(["update-ref", "-m", message, "-d", item.ref, item.oid], {
    cwd: directory,
    write: true,
    worktree: true,
  })
  if (result.ok) return { ok: true }
  return { ok: false, error: result.reason === "refused" ? "invalid" : "git", message: result.message }
}

export type Removed =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "invalid" | "git"; readonly message: string }

function transaction(directory: string, items: readonly Item[], message: string) {
  return Git.run(["update-ref", "-m", message, "--stdin"], {
    cwd: directory,
    write: true,
    worktree: true,
    stdin: Git.lines(["start", ...items.map((item) => `create ${item.ref} ${item.oid}`), "prepare", "commit"]),
  })
}
