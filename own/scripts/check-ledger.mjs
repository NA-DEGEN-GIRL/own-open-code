#!/usr/bin/env node
// check-ledger: the fork's diff against upstream must equal the core-patch ledger (own/FORK.md §6.4).
//
//   node own/scripts/check-ledger.mjs [--base upstream-v2] [--head HEAD] [--worktree] [--json] [--allow-pending]
//   node own/scripts/check-ledger.mjs --list-files        # active+planned patch files and pending cherry-pick files
//
// 1. changed = git diff --name-only <merge-base(base, head)> <head>   (--worktree: against the working tree,
//    including untracked files, so uncommitted edits are checked before committing; untracked files inside a
//    skip-worktree symlink entry are the Windows copy of the link target (own/FORK.md) and are skipped with a warning)
// 2. drop allowed paths: own/**, packages/own-*/**, bun.lock
// 3. drop files of cherry-picks whose upstream_sha is not yet an ancestor of the merge-base
//    (absorbed entries are reported as "remove entry"), unless an active patch also lists the file (both diffs live
//    there; the patch's markers are checked)
// 4. the rest must equal the files of `status: active` patches: unknown diff, planned-with-diff and
//    active-without-diff are failures
// 5. every active patch file carries `OWN-PATCH(P-xxx) begin/end` markers spanning <= max_lines (default 30), except a
//    file flagged `generated: true` (generator output such as the regenerated client, which cannot carry markers; its
//    check is that the generator leaves no diff, recorded in the patch's `verify`), or `unmarked: true` (a file that
//    cannot carry a comment, such as LICENSE). It must still differ from upstream.
//    A file flagged `removed: true` is one the fork deletes: it must not exist (a merge that brings it back fails here).
// 6. at most MAX_ACTIVE active patches; one with `over_budget: true` is outside the count but must record the user's
//    `exception_approval` (own/FORK.md §6.1 rule 5)
// 7. a patch with `awaiting_approval: true` (any status) fails: it waits for the user's decision and may not reach
//    main or a release. `--allow-pending` turns this into a warning for runs on the branch that prepares the patch;
//    nothing in the release chain passes it (own/FORK.md §6.4).
// Exit: 0 ok, 1 ledger violation, 2 usage/git/ledger-format error.
// Node 22 only; no Bun and no npm dependencies.

import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseYaml } from "./lib/yaml-lite.mjs"
import { git, gitPaths, gitText, isAncestor, repoRoot, showFile } from "./lib/git.mjs"

export const STATUSES = ["planned", "active", "candidate", "upstreamed", "dropped", "rejected"]
export const DEFAULT_MAX_LINES = 30
export const MAX_ACTIVE = 6
export const MVP_PLANNED_BUDGET = 2

export function isAllowedPath(file) {
  return file === "bun.lock" || file.startsWith("own/") || /^packages\/own-[^/]+(\/|$)/.test(file)
}

export function checkLedger(options) {
  const repo = options.repo
  const base = options.base ?? "upstream-v2"
  const head = options.head ?? "HEAD"
  const errors = []
  const warnings = []

  const patches = loadPatches(repo, errors)
  const cherryPicks = loadCherryPicks(repo, errors)
  if (errors.length > 0) return { ok: false, fatal: true, errors, warnings }

  const mergeBase = gitText(repo, ["merge-base", base, head])
  const untracked = options.worktree ? gitPaths(repo, ["ls-files", "--others", "--exclude-standard"]) : []
  const links = options.worktree && untracked.length > 0 ? materializedLinks(repo) : []
  const inside = (file, link) => file.startsWith(`${link}/`)
  const copies = untracked.filter((file) => links.some((link) => inside(file, link)))
  const copied = links.filter((link) => copies.some((file) => inside(file, link)))
  if (copies.length > 0)
    warnings.push(
      `${copies.length} untracked file(s) inside skip-worktree symlink entries ignored (${copied.join(", ")}): ` +
        "materialized link targets of a Windows checkout (own/FORK.md)",
    )
  const changed = options.worktree
    ? unique([
        ...gitPaths(repo, ["diff", "--name-only", "--no-renames", mergeBase]),
        ...untracked.filter((file) => !copies.includes(file)),
      ])
    : gitPaths(repo, ["diff", "--name-only", "--no-renames", mergeBase, head])

  const pendingPicks = cherryPicks.filter((pick) => {
    const ancestor = isAncestor(repo, pick.upstream_sha, mergeBase)
    if (ancestor === undefined) {
      errors.push(`cherry-pick ${pick.upstream_sha}: commit not found (fetch upstream first)`)
      return false
    }
    if (ancestor) warnings.push(`cherry-pick ${pick.upstream_sha} is absorbed by the merge-base — remove the entry`)
    return !ancestor
  })
  const pickedFiles = new Set(pendingPicks.flatMap((pick) => pick.files))

  const upstreamChanges = changed.filter((file) => !isAllowedPath(file))
  const byPath = groupFilesByPath(patches)
  const activeFiles = new Set(patches.filter((p) => p.status === "active").flatMap((p) => p.files.map((f) => f.path)))
  const remaining = upstreamChanges.filter((file) => !pickedFiles.has(file) || activeFiles.has(file))

  for (const file of remaining) {
    if (activeFiles.has(file)) continue
    const owners = byPath.get(file) ?? []
    const planned = owners.filter((owner) => owner.patch.status === "planned")
    if (planned.length > 0) {
      errors.push(`${file}: differs from upstream but ${ids(planned)} is planned — set status: active in the same commit`)
      continue
    }
    if (owners.length > 0) {
      errors.push(`${file}: differs from upstream but ${ids(owners)} is ${owners[0].patch.status} (only active patches may change upstream files)`)
      continue
    }
    errors.push(`${file}: differs from upstream and is not in own/ledger/core-patches.yaml or cherry-picks.yaml`)
  }

  const remainingSet = new Set(remaining)
  const readFile = (file) =>
    options.worktree ? readWorktreeFile(repo, file) : showFile(repo, head, file)
  for (const patch of patches) {
    if (patch.status === "active") checkActive(patch, remainingSet, readFile, errors)
    if (patch.status === "planned" || patch.status === "candidate") checkAnchors(patch, readFile, warnings)
    if (patch.status === "planned" && (!patch.verify || !patch.remove_when))
      warnings.push(`${patch.id}: planned patches should record verify and remove_when`)
  }

  const active = patches.filter((patch) => patch.status === "active")
  const planned = patches.filter((patch) => patch.status === "planned")
  const overBudget = active.filter((patch) => patch.over_budget === true)
  for (const patch of overBudget)
    if (typeof patch.exception_approval !== "string" || patch.exception_approval.trim() === "")
      errors.push(`${patch.id}: over_budget patches must record the user's exception_approval`)
  if (overBudget.length > 0)
    warnings.push(`${ids(overBudget.map((patch) => ({ patch })))} active over the budget of ${MAX_ACTIVE} by user exception`)
  const budgeted = active.length - overBudget.length
  if (budgeted > MAX_ACTIVE) errors.push(`${budgeted} active patches exceed the budget of ${MAX_ACTIVE}`)
  const pending = patches.filter((patch) => patch.awaiting_approval === true)
  for (const patch of pending)
    if (options.allowPending)
      warnings.push(`${patch.id}: awaiting the user's approval (allowed by --allow-pending; never on main or a release)`)
    else errors.push(`${patch.id}: awaiting_approval: true — the user has not approved this patch (own/FORK.md §6.4)`)
  if (planned.length > MVP_PLANNED_BUDGET)
    warnings.push(`${planned.length} planned patches exceed the MVP budget of ${MVP_PLANNED_BUDGET}`)

  return {
    ok: errors.length === 0,
    fatal: false,
    base,
    head,
    mergeBase,
    worktree: Boolean(options.worktree),
    changed: changed.length,
    ignored: changed.length - upstreamChanges.length,
    upstreamChanges,
    cherryPicked: upstreamChanges.filter((file) => pickedFiles.has(file)),
    active: active.map((patch) => patch.id),
    planned: planned.map((patch) => patch.id),
    pending: pending.map((patch) => patch.id),
    errors,
    warnings,
  }
}

// Files whose upstream history matters for a merge: active and planned patch files plus pending cherry-picks.
export function listFiles(options) {
  const errors = []
  const patches = loadPatches(options.repo, errors)
  const cherryPicks = loadCherryPicks(options.repo, errors)
  if (errors.length > 0) throw new Error(errors.join("\n"))
  const mergeBase = gitText(options.repo, ["merge-base", options.base ?? "upstream-v2", options.head ?? "HEAD"])
  return unique([
    ...patches
      .filter((patch) => patch.status === "active" || patch.status === "planned")
      .flatMap((patch) => patch.files.map((file) => file.path)),
    ...cherryPicks
      .filter((pick) => isAncestor(options.repo, pick.upstream_sha, mergeBase) === false)
      .flatMap((pick) => pick.files),
  ]).sort()
}

function checkActive(patch, remaining, readFile, errors) {
  if (!patch.verify) errors.push(`${patch.id}: active patches must record verify (own/FORK.md §6.1 rule 6)`)
  if (!patch.remove_when) errors.push(`${patch.id}: active patches must record remove_when (own/FORK.md §6.1 rule 6)`)
  for (const file of patch.files) {
    if (!remaining.has(file.path)) {
      errors.push(`${patch.id}: ${file.path} is active but has no diff against upstream (stale — mark upstreamed/dropped)`)
      continue
    }
    // Generator output, and files that cannot carry comments (LICENSE: the licence text must stay exact), are
    // checked by their patch's `verify`, not by markers.
    if (file.generated === true || file.unmarked === true) continue
    const text = readFile(file.path)
    if (file.removed === true) {
      if (text !== undefined) errors.push(`${patch.id}: ${file.path} is back (removed: true) - git rm it again`)
      continue
    }
    if (text === undefined) {
      errors.push(`${patch.id}: ${file.path} does not exist in the checked revision`)
      continue
    }
    const spans = markerSpans(text, patch.id)
    if (spans.error) {
      errors.push(`${patch.id}: ${file.path}: ${spans.error}`)
      continue
    }
    const total = spans.lines.reduce((sum, lines) => sum + lines, 0)
    const limit = file.max_lines ?? DEFAULT_MAX_LINES
    if (total > limit) errors.push(`${patch.id}: ${file.path}: ${total} lines between markers exceed max_lines ${limit}`)
  }
}

function checkAnchors(patch, readFile, warnings) {
  for (const file of patch.files) {
    if (!file.anchor) continue
    const text = readFile(file.path)
    if (text === undefined) {
      warnings.push(`${patch.id}: ${file.path} no longer exists upstream — follow the rename or redesign (own/FORK.md §5)`)
      continue
    }
    if (!normalize(text).includes(file.anchor))
      warnings.push(`${patch.id}: anchor not found in ${file.path} — update files[].anchor`)
  }
}

// Line counts between `OWN-PATCH(P-xxx) begin` and the matching `end`, in file order.
export function markerSpans(text, id) {
  const begin = `OWN-PATCH(${id}) begin`
  const end = `OWN-PATCH(${id}) end`
  const lines = normalize(text).split("\n")
  const spans = []
  let open
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(begin)) {
      if (open !== undefined) return { error: `nested "${begin}" at line ${i + 1}` }
      open = i
    } else if (lines[i].includes(end)) {
      if (open === undefined) return { error: `"${end}" without begin at line ${i + 1}` }
      spans.push(i - open - 1)
      open = undefined
    }
  }
  if (open !== undefined) return { error: `"${begin}" at line ${open + 1} has no end marker` }
  if (spans.length === 0) return { error: `missing "// ${begin}" / "// ${end}" markers` }
  return { lines: spans }
}

function loadPatches(repo, errors) {
  const data = readLedger(repo, "core-patches.yaml", errors)
  if (data === undefined) return []
  const seen = new Set()
  return data.flatMap((entry, index) => {
    const where = `core-patches.yaml entry ${index + 1}`
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${where}: expected a mapping`)
      return []
    }
    if (typeof entry.id !== "string" || !/^P-\d{3}$/.test(entry.id)) errors.push(`${where}: id must look like P-001`)
    else if (seen.has(entry.id)) errors.push(`${where}: duplicate id ${entry.id}`)
    else seen.add(entry.id)
    if (!STATUSES.includes(entry.status)) errors.push(`${where}: status must be one of ${STATUSES.join(", ")}`)
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      errors.push(`${where}: files must be a non-empty list`)
      return []
    }
    const files = entry.files.flatMap((file) => {
      if (file === null || typeof file !== "object" || typeof file.path !== "string" || file.path === "") {
        errors.push(`${where}: every files[] item needs a path`)
        return []
      }
      if (file.path.includes("\\")) errors.push(`${where}: use forward slashes in ${file.path}`)
      if (isAllowedPath(file.path)) errors.push(`${where}: ${file.path} is our own path, not an upstream file`)
      if (file.max_lines !== undefined && !(Number.isInteger(file.max_lines) && file.max_lines > 0))
        errors.push(`${where}: max_lines must be a positive integer`)
      if (file.anchor !== undefined && file.anchor !== null && typeof file.anchor !== "string")
        errors.push(`${where}: anchor must be a string`)
      if (file.generated !== undefined && typeof file.generated !== "boolean")
        errors.push(`${where}: generated must be true or false`)
      if (file.unmarked !== undefined && typeof file.unmarked !== "boolean")
        errors.push(`${where}: unmarked must be true or false`)
      if (file.unmarked === true && (file.max_lines !== undefined || file.marker !== undefined))
        errors.push(`${where}: ${file.path} is unmarked, so marker and max_lines do not apply`)
      if (file.removed !== undefined && typeof file.removed !== "boolean")
        errors.push(`${where}: removed must be true or false`)
      if (file.removed === true && (file.max_lines !== undefined || file.generated === true))
        errors.push(`${where}: ${file.path} is removed, so max_lines and generated do not apply`)
      if (file.generated === true && file.max_lines !== undefined)
        errors.push(`${where}: ${file.path} is generated (no markers), so max_lines does not apply`)
      return [file]
    })
    return [{ ...entry, files }]
  })
}

function loadCherryPicks(repo, errors) {
  const data = readLedger(repo, "cherry-picks.yaml", errors)
  if (data === undefined) return []
  return data.flatMap((entry, index) => {
    const where = `cherry-picks.yaml entry ${index + 1}`
    if (entry === null || typeof entry !== "object" || typeof entry.upstream_sha !== "string") {
      errors.push(`${where}: upstream_sha must be a quoted or plain hex string`)
      return []
    }
    if (!/^[0-9a-f]{7,40}$/.test(entry.upstream_sha)) errors.push(`${where}: upstream_sha must be hex`)
    if (!Array.isArray(entry.files) || entry.files.some((file) => typeof file !== "string")) {
      errors.push(`${where}: files must be a list of paths`)
      return []
    }
    return [entry]
  })
}

function readLedger(repo, name, errors) {
  const file = path.join(repo, "own", "ledger", name)
  if (!existsSync(file)) {
    errors.push(`missing own/ledger/${name}`)
    return undefined
  }
  try {
    const data = parseYaml(readFileSync(file, "utf8"))
    if (data === null) return []
    if (!Array.isArray(data)) {
      errors.push(`own/ledger/${name}: top level must be a list`)
      return undefined
    }
    return data
  } catch (error) {
    errors.push(`own/ledger/${name}: ${error.message}`)
    return undefined
  }
}

function groupFilesByPath(patches) {
  const map = new Map()
  for (const patch of patches)
    for (const file of patch.files) map.set(file.path, [...(map.get(file.path) ?? []), { patch, file }])
  return map
}

// Index entries that are symlinks (mode 120000) marked skip-worktree: the FORK.md workaround copies the link target
// in place of the link, so git sees a directory link's copied files as untracked.
function materializedLinks(repo) {
  const skipped = new Set(
    gitPaths(repo, ["ls-files", "-v"])
      .filter((line) => line.startsWith("S "))
      .map((line) => line.slice(2)),
  )
  return gitPaths(repo, ["ls-files", "-s"])
    .map((line) => line.match(/^120000 [0-9a-f]+ \d+\t(.+)$/)?.[1])
    .filter((file) => file !== undefined && skipped.has(file))
}

function readWorktreeFile(repo, file) {
  const target = path.join(repo, file)
  return existsSync(target) ? readFileSync(target, "utf8") : undefined
}

function ids(owners) {
  return unique(owners.map((owner) => owner.patch.id)).join(", ")
}

function unique(items) {
  return [...new Set(items)]
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n")
}

function parseArgs(argv) {
  const options = { base: "upstream-v2", head: "HEAD", worktree: false, json: false, listFiles: false, allowPending: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--worktree") options.worktree = true
    else if (arg === "--json") options.json = true
    else if (arg === "--allow-pending") options.allowPending = true
    else if (arg === "--list-files") options.listFiles = true
    else if (arg === "--base" || arg === "--head" || arg === "--repo") {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      options[arg.slice(2)] = value
    } else if (arg === "-h" || arg === "--help") options.help = true
    else throw new Error(`unknown argument ${arg}`)
  }
  return options
}

function main() {
  const options = (() => {
    try {
      return parseArgs(process.argv.slice(2))
    } catch (error) {
      console.error(`check-ledger: ${error.message}`)
      process.exit(2)
    }
  })()
  if (options.help) {
    console.log(
      "usage: node own/scripts/check-ledger.mjs [--base upstream-v2] [--head HEAD] [--worktree] [--json] [--list-files] [--repo DIR] [--allow-pending]",
    )
    return
  }
  const repo = options.repo ? path.resolve(options.repo) : repoRoot(path.dirname(fileURLToPath(import.meta.url)))
  try {
    if (options.listFiles) {
      const files = listFiles({ ...options, repo })
      if (files.length > 0) process.stdout.write(files.join("\n") + "\n")
      return
    }
    const result = checkLedger({ ...options, repo })
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else report(result)
    process.exitCode = result.ok ? 0 : result.fatal ? 2 : 1
  } catch (error) {
    console.error(`check-ledger: ${error.message}`)
    process.exitCode = 2
  }
}

function report(result) {
  if (result.fatal) {
    for (const error of result.errors) console.error(`  ERROR ${error}`)
    console.error("check-ledger: ledger files are invalid")
    return
  }
  const range = result.worktree ? `${result.base}...(working tree)` : `${result.base}...${result.head}`
  console.log(`check-ledger: ${range} (merge-base ${result.mergeBase.slice(0, 10)})`)
  console.log(
    `  changed files: ${result.changed} (own/packages/own-*/bun.lock: ${result.ignored}, upstream: ${result.upstreamChanges.length}, cherry-picked: ${result.cherryPicked.length})`,
  )
  console.log(
    `  active patches: ${result.active.join(", ") || "none"} · planned: ${result.planned.join(", ") || "none"} · awaiting approval: ${result.pending.join(", ") || "none"}`,
  )
  for (const warning of result.warnings) console.log(`  WARN  ${warning}`)
  for (const error of result.errors) console.log(`  ERROR ${error}`)
  console.log(result.ok ? "  OK" : `  FAILED (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
