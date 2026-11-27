#!/usr/bin/env node
// check-surface: verify the upstream contracts our code depends on (own/FORK.md §4-§5, 01 §16, 02 §10.1).
//
//   node own/scripts/check-surface.mjs                # check own/upstream-surface.json + vendored drift
//   node own/scripts/check-surface.mjs --update       # after review: record current region hashes
//   node own/scripts/check-surface.mjs --show <id>    # print the extracted regions of one entry
//   node own/scripts/check-surface.mjs --hash <path>  # normalized sha256 of a repo file (for vendored.yaml)
//   options: --json, --only <id>[,<id>], --repo <dir>, --surface <file>
//
// Each entry in own/upstream-surface.json names an upstream file and
//   require: literal snippets that must exist          → missing = BROKEN (contract break, stop the sync)
//   absent:  literal snippets that must not exist      → present = CHANGED (upstream grew something to review)
//   regions: code regions whose normalized text is hashed → hash differs = CHANGED (review, then --update)
// A region is {from, to} (first line containing `from` through the next line containing `to`), {from, block:true}
// (from the `from` line until brackets balance), {from, lines:N}, or "file" (whole file).
// Vendored copies (own/ledger/vendored.yaml) whose source hash moved are reported as DRIFT (warning only).
// Exit: 0 ok (drift allowed), 1 broken, 2 changed/unrecorded only, 64 usage error. Node 22, no dependencies.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseYaml } from "./lib/yaml-lite.mjs"
import { git, repoRoot } from "./lib/git.mjs"

export function normalizeSource(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function hashSource(text) {
  return sha256(normalizeSource(text))
}

// Returns {text} or {error}. Lines are matched on normalized text with String.includes.
export function extractRegion(source, region) {
  const text = normalizeSource(source)
  if (region === "file") return { text }
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.includes(region.from))
  if (start === -1) return { error: `region start not found: ${region.from}` }
  if (region.to !== undefined) {
    const offset = lines.slice(start + 1).findIndex((line) => line.includes(region.to))
    if (offset === -1) return { error: `region end not found after "${region.from}": ${region.to}` }
    return { text: lines.slice(start, start + offset + 2).join("\n") }
  }
  if (region.lines !== undefined) return { text: lines.slice(start, start + region.lines).join("\n") }
  if (region.block) {
    const end = blockEnd(lines, start)
    if (end === -1) return { error: `unbalanced block starting at: ${region.from}` }
    return { text: lines.slice(start, end + 1).join("\n") }
  }
  return { text: lines[start] }
}

// First line (from `start`) at whose end the bracket depth returns to zero after being opened. Strings,
// template literals, regex literals and // or /* */ comments are skipped well enough for formatted TypeScript.
function blockEnd(lines, start) {
  let depth = 0
  let opened = false
  let mode
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (mode === "block-comment") {
        if (char === "*" && line[i + 1] === "/") {
          mode = undefined
          i++
        }
        continue
      }
      if (mode !== undefined) {
        if (char === "\\") i++
        else if (char === mode) mode = undefined
        continue
      }
      if (char === "/" && line[i + 1] === "/") break
      if (char === "/" && line[i + 1] === "*") {
        mode = "block-comment"
        i++
        continue
      }
      if (char === "/" && /[(,=:[!&|?{};]$|^$/.test(line.slice(0, i).trimEnd())) {
        i = regexEnd(line, i)
        continue
      }
      if (char === '"' || char === "'" || char === "`") mode = char
      else if (char === "{" || char === "(" || char === "[") {
        depth++
        opened = true
      } else if (char === "}" || char === ")" || char === "]") depth--
    }
    if (mode === '"' || mode === "'") mode = undefined
    if (opened && depth <= 0) return index
  }
  return -1
}

// Index of the closing `/` of a regex literal starting at `start` (character classes may contain `/`).
function regexEnd(line, start) {
  let inClass = false
  for (let i = start + 1; i < line.length; i++) {
    const char = line[i]
    if (char === "\\") i++
    else if (char === "[") inClass = true
    else if (char === "]") inClass = false
    else if (char === "/" && !inClass) return i
  }
  return line.length
}

export function checkEntry(repo, entry) {
  const problems = []
  const changes = []
  const file = path.join(repo, entry.file)
  if (!existsSync(file)) return { id: entry.id, status: "broken", problems: [`file missing: ${entry.file}`], changes }
  const source = readFileSync(file, "utf8")
  const normalized = normalizeSource(source)
  for (const snippet of entry.require ?? [])
    if (!normalized.includes(snippet)) problems.push(`required snippet missing: ${snippet}`)
  for (const snippet of entry.absent ?? [])
    if (normalized.includes(snippet)) changes.push(`snippet appeared (review): ${snippet}`)
  const regions = (entry.regions ?? []).map((region) => extractRegion(source, region))
  for (const region of regions) if (region.error) problems.push(region.error)
  const hash =
    regions.length === 0 || regions.some((region) => region.error)
      ? undefined
      : sha256(regions.map((region) => region.text).join("\n\u0000\n"))
  if (hash !== undefined && (entry.sha256 === null || entry.sha256 === undefined))
    changes.push("region hash not recorded yet (run --update)")
  else if (hash !== undefined && hash !== entry.sha256)
    changes.push("region text changed since the recorded hash (review, then --update)")
  const status = problems.length > 0 ? "broken" : changes.length > 0 ? "changed" : "ok"
  return { id: entry.id, file: entry.file, status, problems, changes, hash, regions }
}

export function checkVendored(repo) {
  const file = path.join(repo, "own", "ledger", "vendored.yaml")
  if (!existsSync(file)) return [{ status: "drift", message: "own/ledger/vendored.yaml is missing" }]
  const entries = parseYaml(readFileSync(file, "utf8")) ?? []
  if (!Array.isArray(entries)) return [{ status: "drift", message: "vendored.yaml: top level must be a list" }]
  return entries.map((entry, index) => {
    const label = entry?.dest ?? `entry ${index + 1}`
    if (typeof entry?.source !== "string" || typeof entry?.source_sha256 !== "string")
      return { dest: label, status: "drift", message: "entry needs source and source_sha256" }
    const source = path.join(repo, entry.source)
    if (!existsSync(source)) {
      // `removed_upstream: <sha>`: upstream deleted the file with no successor, reviewed; the copy is ours from then on.
      if (typeof entry.removed_upstream === "string") return { dest: label, status: "ok" }
      return { dest: label, status: "drift", message: `upstream source removed: ${entry.source}` }
    }
    const current = hashSource(readFileSync(source, "utf8"))
    if (current !== entry.source_sha256)
      return { dest: label, status: "drift", message: `${entry.source} changed upstream (now ${current})` }
    if (typeof entry.dest === "string" && !existsSync(path.join(repo, entry.dest)))
      return { dest: label, status: "drift", message: `vendored copy missing: ${entry.dest}` }
    return { dest: label, status: "ok" }
  })
}

export function checkSurface(options) {
  const surface = loadSurface(options.surfaceFile)
  const only = options.only ? new Set(options.only) : undefined
  const entries = surface.entries.filter((entry) => only === undefined || only.has(entry.id))
  if (only !== undefined) {
    const unknown = [...only].filter((id) => !surface.entries.some((entry) => entry.id === id))
    if (unknown.length > 0) throw new UsageError(`unknown surface id: ${unknown.join(", ")}`)
  }
  const results = entries.map((entry) => checkEntry(options.repo, entry))
  const vendored = only === undefined ? checkVendored(options.repo) : []
  const broken = results.filter((result) => result.status === "broken").length
  const changed = results.filter((result) => result.status === "changed").length
  return { surface, results, vendored, broken, changed, exitCode: broken > 0 ? 1 : changed > 0 ? 2 : 0 }
}

// Record current hashes for entries that are not broken. Returns the ids whose hash was written.
export function updateSurface(options) {
  const report = checkSurface(options)
  const hashes = new Map(
    report.results.filter((result) => result.status !== "broken" && result.hash).map((result) => [result.id, result.hash]),
  )
  const updated = report.surface.entries
    .filter((entry) => hashes.has(entry.id) && entry.sha256 !== hashes.get(entry.id))
    .map((entry) => entry.id)
  const next = {
    ...report.surface,
    recordedAt: { upstream: recordedUpstream(options.repo), date: new Date().toISOString().slice(0, 10) },
    entries: report.surface.entries.map((entry) =>
      hashes.has(entry.id) ? { ...entry, sha256: hashes.get(entry.id) } : entry,
    ),
  }
  writeFileSync(options.surfaceFile, JSON.stringify(next, null, 2) + "\n")
  return { updated, broken: report.results.filter((result) => result.status === "broken") }
}

function recordedUpstream(repo) {
  const result = git(repo, ["merge-base", "HEAD", "upstream-v2"], { allowFailure: true })
  return result.status === 0 ? result.stdout.trim().slice(0, 10) : null
}

class UsageError extends Error {}

export function loadSurface(file) {
  const data = JSON.parse(readFileSync(file, "utf8"))
  if (data.schemaVersion !== 1 || !Array.isArray(data.entries))
    throw new UsageError(`${file}: expected {schemaVersion: 1, entries: [...]}`)
  const ids = new Set()
  for (const entry of data.entries) {
    if (typeof entry.id !== "string" || ids.has(entry.id)) throw new UsageError(`${file}: missing or duplicate id ${entry.id}`)
    ids.add(entry.id)
    if (typeof entry.file !== "string") throw new UsageError(`${file}: ${entry.id} needs a file`)
    for (const region of entry.regions ?? [])
      if (region !== "file" && (typeof region !== "object" || typeof region.from !== "string"))
        throw new UsageError(`${file}: ${entry.id} has an invalid region`)
    if (!(entry.require?.length || entry.absent?.length || entry.regions?.length))
      throw new UsageError(`${file}: ${entry.id} checks nothing (add require, absent or regions)`)
  }
  return data
}

function parseArgs(argv) {
  const options = { json: false, update: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new UsageError(`${arg} needs a value`)
      return next
    }
    if (arg === "--json") options.json = true
    else if (arg === "--update") options.update = true
    else if (arg === "--show") options.show = value()
    else if (arg === "--hash") options.hash = value()
    else if (arg === "--only") options.only = value().split(",")
    else if (arg === "--repo") options.repo = value()
    else if (arg === "--surface") options.surfaceFile = value()
    else if (arg === "-h" || arg === "--help") options.help = true
    else throw new UsageError(`unknown argument ${arg}`)
  }
  return options
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(
        "usage: node own/scripts/check-surface.mjs [--json] [--only id,...] [--update] [--show id] [--hash path] [--repo DIR] [--surface FILE]",
      )
      return
    }
    const repo = options.repo ? path.resolve(options.repo) : repoRoot(path.dirname(fileURLToPath(import.meta.url)))
    const surfaceFile = options.surfaceFile ? path.resolve(options.surfaceFile) : path.join(repo, "own", "upstream-surface.json")
    if (options.hash) {
      console.log(hashSource(readFileSync(path.resolve(repo, options.hash), "utf8")))
      return
    }
    if (options.show) {
      const entry = loadSurface(surfaceFile).entries.find((item) => item.id === options.show)
      if (!entry) throw new UsageError(`unknown surface id: ${options.show}`)
      const result = checkEntry(repo, entry)
      for (const region of result.regions ?? []) console.log((region.error ?? region.text) + "\n----")
      console.log(`status: ${result.status}${result.hash ? ` sha256 ${result.hash}` : ""}`)
      return
    }
    if (options.update) {
      const result = updateSurface({ ...options, repo, surfaceFile })
      for (const broken of result.broken) console.log(`  BROKEN ${broken.id}: ${broken.problems.join("; ")} (not updated)`)
      console.log(`check-surface: recorded ${result.updated.length} hash(es)${result.updated.length ? `: ${result.updated.join(", ")}` : ""}`)
      process.exitCode = result.broken.length > 0 ? 1 : 0
      return
    }
    const report = checkSurface({ ...options, repo, surfaceFile })
    if (options.json) {
      const { surface, ...rest } = report
      console.log(
        JSON.stringify(
          { recordedAt: surface.recordedAt, ...rest, results: rest.results.map(({ regions, ...result }) => result) },
          null,
          2,
        ),
      )
    } else printReport(report)
    process.exitCode = report.exitCode
  } catch (error) {
    console.error(`check-surface: ${error.message}`)
    process.exitCode = error instanceof UsageError ? 64 : 2
  }
}

function printReport(report) {
  const recorded = report.surface.recordedAt ?? {}
  console.log(`check-surface: ${report.results.length} entries (hashes recorded at upstream ${recorded.upstream ?? "?"}, ${recorded.date ?? "?"})`)
  for (const result of report.results) {
    if (result.status === "ok") continue
    const label = result.status === "broken" ? "BROKEN " : "CHANGED"
    const entry = report.surface.entries.find((item) => item.id === result.id)
    console.log(`  ${label} ${result.id} (${result.file ?? entry?.file})`)
    for (const line of [...result.problems, ...result.changes]) console.log(`          - ${line}`)
    if (result.status === "broken" && entry?.onBreak) console.log(`          impact: ${entry.onBreak}`)
  }
  for (const item of report.vendored.filter((vendored) => vendored.status !== "ok"))
    console.log(`  DRIFT   ${item.dest}: ${item.message}`)
  const ok = report.results.length - report.broken - report.changed
  console.log(`  ok ${ok}, changed ${report.changed}, broken ${report.broken}, vendored drift ${report.vendored.filter((v) => v.status !== "ok").length}`)
  if (report.broken > 0) console.log("  FAILED: contract break — stop the sync and design a response (own/FORK.md §5)")
  else if (report.changed > 0) console.log("  REVIEW: upstream changed code we depend on; review, then run with --update")
  else console.log("  OK")
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
