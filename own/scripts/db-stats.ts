// WP13 (P1-4, P2-29, P2-16 history; own/reports/external-repos-2026-10-05.md): statistics over the own session database,
// read-only, for the decisions that need real usage. The user runs it; report 1 decides GW-P14 (core patch P-016,
// script-aware Token.estimate) and report 2 informs D2.
//   1. Output token density, per provider/model, pooled per model and over everything: the characters of each assistant
//      step's text parts and tool-call input JSON (reasoning parts left out), split by code point into Hangul (syllables
//      and jamo), other CJK (ideographs, kana, bopomofo, CJK symbols, full-width forms), ASCII and other, against the
//      step's output tokens without reasoning (`tokens.output`). Least squares gives tokens per character per class
//      (plus a per-step and a per-tool-call overhead), and again in the form P-016 takes:
//      wH × Hangul + wC × CJK + (ASCII + other) / 4, with upstream's length / 4 error beside it.
//   2. Finishes, per provider/model/variant: steps ended with finish `length`, and with `stop` and no visible output
//      (WP02's output_truncated and empty_completion, counted over the history).
//   3. Inline image bytes (prompt attachments, data: URIs in tool results) per table, per session (top N), per UTC day
//      and in total, beside the database and table sizes (P2-29 screenshot retention).
// Steps come from the projected assistant messages (`session_message`): `session.step.ended` writes their finish and
// tokens, and core keeps no event rows for a local session.
//
// Read-only: bun:sqlite `readonly` plus `PRAGMA query_only`; safe beside the running service (WAL). The database file
// is never written; with the service stopped, SQLite still creates the empty -wal/-shm files any WAL reader needs. The
// report holds provider, model and session ids, counts and sizes only: never message text, tool input or image data.
//
//   bun own/scripts/db-stats.ts               # the own channel database where the launcher puts it (Get-OwnPaths):
//                                             # $XDG_DATA_HOME (else ~/.local/share) /opencode/opencode-own.db
//   bun own/scripts/db-stats.ts --db <file>   # another copy (e.g. OWN_HOME\backup\opencode-own.<ver>.<stamp>.db)
//   bun own/scripts/db-stats.ts --self-test   # a small in-memory fixture on core's table definitions, checked
//   options: --top <n> sessions in report 3 (default 10), --out <dir> (default own/.out/db-stats/<time>, ignored by git)
// Exit: 0 done (self-test: passed), 1 failed, 64 usage error.
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const REPO = path.resolve(import.meta.dir, "..", "..")
const USAGE = "usage: bun own/scripts/db-stats.ts [--db <file> | --self-test] [--top <n>] [--out <dir>]"

// An unknown or incomplete option is a usage error.
const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        db: { type: "string" },
        "self-test": { type: "boolean", default: false },
        top: { type: "string", default: "10" },
        out: { type: "string" },
      },
    }).values,
).catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  return process.exit(64)
})
const top = Number(args.top)
if (!Number.isInteger(top) || top < 1) {
  console.error(`--top must be a positive integer\n${USAGE}`)
  process.exit(64)
}

// ---------------------------------------------------------------------------------------------------------------

async function run() {
  const file = path.resolve(args.db ?? databasePath(process.env, os.homedir()))
  if (!fs.existsSync(file)) throw new Error(`no database at ${scrub(file)} (pass --db <file>)`)
  const db = open(file)
  const report = analyze(db, file, top)
  db.close()
  const out = args.out ? path.resolve(args.out) : path.join(REPO, "own", ".out", "db-stats", stamp())
  await write(out, report)
  console.log(markdown(report))
  console.log(`\nreport: ${path.join(out, "report.json")} and report.md`)
  return 0
}

/** The own channel database where the launcher's Get-OwnPaths puts it (an empty XDG_DATA_HOME counts as unset). */
function databasePath(env: NodeJS.ProcessEnv, home: string) {
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode", "opencode-own.db")
}

function open(file: string) {
  const db = new Database(file, { readonly: true })
  db.exec("PRAGMA query_only = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}

function analyze(db: Database, file: string, top: number): Report {
  const tables = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  )
  if (!tables.has("session_message")) throw new Error("not an OpenCode v2 session database (no session_message table)")
  const steps = readSteps(db)
  return {
    version: 1,
    generated: new Date().toISOString(),
    database: databaseInfo(db, file, tables),
    steps: steps.counts,
    density: density(steps.samples),
    finishes: steps.finishes,
    images: images(db, tables, top),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reports 1 and 2: assistant steps

/** Finishes whose step usage covers the step's content (error, unknown and content-filter may stop mid-output). */
const USABLE = new Set(["stop", "tool-calls", "length"])

type Exclusion = "failed" | "unfinished" | "finish" | "noUsage" | "noOutput" | "noText" | "reasoningInOutput"

interface Chars {
  readonly hangul: number
  readonly cjk: number
  readonly ascii: number
  readonly other: number
  /** UTF-16 units: what upstream `Token.estimate` divides by 4. */
  readonly units: number
}

interface Step {
  readonly providerID: string
  readonly modelID: string
  readonly variant: string | undefined
  readonly finish: string | undefined
  readonly failed: boolean
  readonly tokens: { readonly output: number; readonly reasoning: number; readonly total: number } | undefined
  readonly chars: Chars
  readonly tools: number
  /** Reasoning parts with text: when the usage reports no reasoning tokens, `output` likely includes them. */
  readonly reasoningText: boolean
}

interface Sample {
  readonly providerID: string
  readonly modelID: string
  readonly chars: Chars
  readonly tools: number
  /** `tokens.output`: visible output, reasoning excluded. */
  readonly tokens: number
}

interface FinishRow {
  readonly providerID: string
  readonly modelID: string
  readonly variant: string | null
  readonly steps: number
  /** Projected `session.step.ended` (a finish and no error). */
  readonly ended: number
  readonly length: number
  /** Finish `stop` with `tokens.output` 0. */
  readonly stopEmpty: number
  readonly stopEmptyReasoning: number
  /** Of stopEmpty: the provider reported no usage at all. */
  readonly stopEmptyNoUsage: number
  /** Projected `session.step.failed`. */
  readonly failed: number
  readonly first: string
  readonly last: string
}

function readSteps(db: Database) {
  const counts = {
    assistant: 0,
    invalid: 0,
    used: 0,
    excluded: { failed: 0, unfinished: 0, finish: 0, noUsage: 0, noOutput: 0, noText: 0, reasoningInOutput: 0 },
  }
  const samples: Sample[] = []
  const finishes = new Map<string, FinishRow>()
  const rows = db.query<{ time: number; valid: number; data: string }, []>(
    "SELECT time_created AS time, json_valid(data) AS valid, data FROM session_message WHERE type = 'assistant'",
  )
  for (const row of rows.iterate()) {
    counts.assistant++
    // json_valid first: JSON.parse never sees an unreadable row, so no parse error can echo its text.
    const step = row.valid ? stepOf(JSON.parse(row.data)) : undefined
    if (!step) {
      counts.invalid++
      continue
    }
    const key = [step.providerID, step.modelID, step.variant ?? ""].join("\u0000")
    finishes.set(key, tally(finishes.get(key), step, row.time))
    const sample = sampleOf(step)
    if (typeof sample === "string") {
      counts.excluded[sample]++
      continue
    }
    counts.used++
    samples.push(sample)
  }
  return {
    counts,
    samples,
    finishes: [...finishes.values()].toSorted((a, b) => b.steps - a.steps),
  }
}

function stepOf(value: unknown): Step | undefined {
  if (!isRecord(value) || !isRecord(value.model) || !Array.isArray(value.content)) return undefined
  const model = value.model
  if (typeof model.providerID !== "string" || typeof model.id !== "string") return undefined
  const parts = value.content.filter(isRecord)
  const tools = parts.filter((part) => part.type === "tool")
  return {
    providerID: model.providerID,
    modelID: model.id,
    variant: typeof model.variant === "string" ? model.variant : undefined,
    finish: typeof value.finish === "string" ? value.finish : undefined,
    failed: value.error !== undefined,
    tokens: tokensOf(value.tokens),
    chars: count([
      ...parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])),
      ...tools.map(toolInput),
    ]),
    tools: tools.length,
    reasoningText: parts.some(
      (part) => part.type === "reasoning" && typeof part.text === "string" && part.text.length > 0,
    ),
  }
}

/** The arguments as the model wrote them, near enough: a streaming call keeps the raw text, later states the record. */
function toolInput(part: Readonly<Record<string, unknown>>) {
  const input = isRecord(part.state) ? part.state.input : undefined
  if (typeof input === "string") return input
  return JSON.stringify(input ?? {})
}

function tokensOf(value: unknown) {
  if (!isRecord(value)) return undefined
  const cache = isRecord(value.cache) ? value.cache : undefined
  const output = finite(value.output)
  const reasoning = finite(value.reasoning)
  return {
    output,
    reasoning,
    total: finite(value.input) + output + reasoning + finite(cache?.read) + finite(cache?.write),
  }
}

function sampleOf(step: Step): Sample | Exclusion {
  if (step.failed) return "failed"
  if (step.finish === undefined) return "unfinished"
  if (!USABLE.has(step.finish)) return "finish"
  if (!step.tokens || step.tokens.total === 0) return "noUsage"
  if (step.tokens.output === 0) return "noOutput"
  if (step.chars.units === 0) return "noText"
  if (step.reasoningText && step.tokens.reasoning === 0) return "reasoningInOutput"
  return {
    providerID: step.providerID,
    modelID: step.modelID,
    chars: step.chars,
    tools: step.tools,
    tokens: step.tokens.output,
  }
}

function tally(row: FinishRow | undefined, step: Step, time: number): FinishRow {
  const day = dayOf(time)
  const ended = !step.failed && step.finish !== undefined
  const stopEmpty = ended && step.finish === "stop" && (step.tokens?.output ?? 0) === 0
  const base = row ?? {
    providerID: step.providerID,
    modelID: step.modelID,
    variant: step.variant ?? null,
    steps: 0,
    ended: 0,
    length: 0,
    stopEmpty: 0,
    stopEmptyReasoning: 0,
    stopEmptyNoUsage: 0,
    failed: 0,
    first: day,
    last: day,
  }
  return {
    ...base,
    steps: base.steps + 1,
    ended: base.ended + (ended ? 1 : 0),
    length: base.length + (ended && step.finish === "length" ? 1 : 0),
    stopEmpty: base.stopEmpty + (stopEmpty ? 1 : 0),
    stopEmptyReasoning: base.stopEmptyReasoning + (stopEmpty && (step.tokens?.reasoning ?? 0) > 0 ? 1 : 0),
    stopEmptyNoUsage: base.stopEmptyNoUsage + (stopEmpty && (step.tokens?.total ?? 0) === 0 ? 1 : 0),
    failed: base.failed + (step.failed ? 1 : 0),
    first: day < base.first ? day : base.first,
    last: day > base.last ? day : base.last,
  }
}

const HANGUL = [
  [0x1100, 0x11ff], // Jamo
  [0x3130, 0x318f], // Compatibility Jamo
  [0xa960, 0xa97f], // Jamo Extended-A
  [0xac00, 0xd7a3], // Syllables
  [0xd7b0, 0xd7ff], // Jamo Extended-B
  [0xffa0, 0xffdc], // Halfwidth Jamo
] as const
// Checked after HANGUL, so the Hangul blocks inside these ranges stay Hangul.
const CJK = [
  [0x2e80, 0x9fff], // radicals, CJK symbols and punctuation, kana, bopomofo, enclosed, Extension A, Unified Ideographs
  [0xf900, 0xfaff], // Compatibility Ideographs
  [0xfe30, 0xfe4f], // Compatibility Forms
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x20000, 0x3ffff], // Extensions B and later, Compatibility Ideographs Supplement
] as const

function count(texts: ReadonlyArray<string>): Chars {
  const chars = { hangul: 0, cjk: 0, ascii: 0, other: 0, units: 0 }
  for (const text of texts) {
    chars.units += text.length
    for (const char of text) chars[classOf(char.codePointAt(0) ?? 0)]++
  }
  return chars
}

function classOf(code: number) {
  if (code < 0x80) return "ascii"
  if (HANGUL.some((range) => code >= range[0] && code <= range[1])) return "hangul"
  if (CJK.some((range) => code >= range[0] && code <= range[1])) return "cjk"
  return "other"
}

// ---------------------------------------------------------------------------------------------------------------
// Report 1: least squares

interface Term {
  readonly name: string
  readonly of: (sample: Sample) => number
}

interface Coefficient {
  readonly value: number
  readonly se: number
}

type Fit =
  | {
      readonly ok: true
      readonly coef: Readonly<Record<string, Coefficient>>
      readonly r2: number | null
      readonly rmse: number
    }
  | { readonly ok: false; readonly reason: string }

interface Accuracy {
  /** Σ estimate / Σ tokens: below 1 underestimates. */
  readonly ratio: number
  /** Mean absolute error per step, relative to its tokens. */
  readonly mape: number
}

interface DensityRow {
  /** null: pooled over providers (byModel, all). */
  readonly providerID: string | null
  /** null: pooled over models (all). */
  readonly modelID: string | null
  readonly steps: number
  readonly tokens: number
  readonly chars: Chars
  readonly toolCalls: number
  readonly fit: Fit
  readonly patch: Fit
  readonly upstream: Accuracy | null
  readonly patched: Accuracy | null
}

const CLASS_TERMS: ReadonlyArray<Term> = [
  { name: "hangul", of: (sample) => sample.chars.hangul },
  { name: "cjk", of: (sample) => sample.chars.cjk },
]
const FREE_TERMS: ReadonlyArray<Term> = [
  ...CLASS_TERMS,
  { name: "ascii", of: (sample) => sample.chars.ascii },
  { name: "other", of: (sample) => sample.chars.other },
  { name: "step", of: () => 1 },
  { name: "toolCall", of: (sample) => sample.tools },
]

function density(samples: ReadonlyArray<Sample>) {
  const pooled = (key: (sample: Sample) => string, provider: boolean) =>
    [...Map.groupBy(samples, key).values()]
      .map((group) => densityRow(group, provider ? (group[0]?.providerID ?? null) : null, group[0]?.modelID ?? null))
      .toSorted((a, b) => b.steps - a.steps)
  return {
    byProvider: pooled((sample) => `${sample.providerID}\u0000${sample.modelID}`, true),
    byModel: pooled((sample) => sample.modelID, false),
    all: densityRow(samples, null, null),
  }
}

function densityRow(samples: ReadonlyArray<Sample>, providerID: string | null, modelID: string | null): DensityRow {
  const patch = fit(samples, CLASS_TERMS, (sample) => sample.tokens - (sample.chars.ascii + sample.chars.other) / 4)
  const weight = (name: string) => (patch.ok ? (patch.coef[name]?.value ?? 0) : 0)
  return {
    providerID,
    modelID,
    steps: samples.length,
    tokens: sum(samples, (sample) => sample.tokens),
    chars: {
      hangul: sum(samples, (sample) => sample.chars.hangul),
      cjk: sum(samples, (sample) => sample.chars.cjk),
      ascii: sum(samples, (sample) => sample.chars.ascii),
      other: sum(samples, (sample) => sample.chars.other),
      units: sum(samples, (sample) => sample.chars.units),
    },
    toolCalls: sum(samples, (sample) => sample.tools),
    fit: fit(samples, FREE_TERMS, (sample) => sample.tokens),
    patch,
    upstream: accuracy(samples, (sample) => sample.chars.units / 4),
    patched: patch.ok
      ? accuracy(
          samples,
          (sample) =>
            weight("hangul") * sample.chars.hangul +
            weight("cjk") * sample.chars.cjk +
            (sample.chars.ascii + sample.chars.other) / 4,
        )
      : null,
  }
}

/** Ordinary least squares over the terms that occur, with standard errors; no intercept unless a term is constant. */
function fit(samples: ReadonlyArray<Sample>, terms: ReadonlyArray<Term>, target: (sample: Sample) => number): Fit {
  const columns = terms
    .filter((term) => samples.some((sample) => term.of(sample) !== 0))
    .map((term) => {
      // Scaled to unit length, so the pivot test reads "this term is (nearly) a combination of the others".
      const scale = Math.sqrt(sum(samples, (sample) => term.of(sample) ** 2))
      return { name: term.name, scale, of: (sample: Sample) => term.of(sample) / scale }
    })
  if (columns.length === 0) return { ok: false, reason: "no data" }
  if (samples.length <= columns.length)
    return { ok: false, reason: `${samples.length} steps for ${columns.length} terms` }
  const inverse = invert(columns.map((a) => columns.map((b) => sum(samples, (sample) => a.of(sample) * b.of(sample)))))
  if (!inverse) return { ok: false, reason: "collinear terms" }
  const moment = columns.map((column) => sum(samples, (sample) => column.of(sample) * target(sample)))
  const scaled = inverse.map((row) => sum(row, (value, j) => value * (moment[j] ?? 0)))
  const predict = (sample: Sample) => sum(columns, (column, i) => column.of(sample) * (scaled[i] ?? 0))
  const rss = sum(samples, (sample) => (target(sample) - predict(sample)) ** 2)
  const mean = sum(samples, target) / samples.length
  const tss = sum(samples, (sample) => (target(sample) - mean) ** 2)
  const variance = rss / (samples.length - columns.length)
  return {
    ok: true,
    coef: Object.fromEntries(
      columns.map((column, i) => [
        column.name,
        {
          value: (scaled[i] ?? 0) / column.scale,
          se: Math.sqrt(Math.max(0, variance * (inverse[i]?.[i] ?? 0))) / column.scale,
        },
      ]),
    ),
    r2: tss > 0 ? 1 - rss / tss : null,
    rmse: Math.sqrt(rss / samples.length),
  }
}

/** Gauss-Jordan inverse with partial pivoting; undefined when a pivot vanishes. */
function invert(matrix: ReadonlyArray<ReadonlyArray<number>>) {
  const rows = matrix.map((row, i) => [...row, ...matrix.map((_, j) => (i === j ? 1 : 0))])
  for (const column of matrix.keys()) {
    const pivot = rows.reduce(
      (best, row, index) =>
        index >= column && Math.abs(row[column] ?? 0) > Math.abs(rows[best]?.[column] ?? 0) ? index : best,
      column,
    )
    const lead = rows[pivot] ?? []
    const value = lead[column] ?? 0
    if (Math.abs(value) < 1e-10) return undefined
    rows[pivot] = rows[column] ?? []
    const normalized = lead.map((cell) => cell / value)
    rows[column] = normalized
    rows.forEach((row, index) => {
      if (index === column) return
      const factor = row[column] ?? 0
      rows[index] = row.map((cell, j) => cell - factor * (normalized[j] ?? 0))
    })
  }
  return rows.map((row) => row.slice(matrix.length))
}

function accuracy(samples: ReadonlyArray<Sample>, estimate: (sample: Sample) => number): Accuracy | null {
  if (samples.length === 0) return null
  return {
    ratio: sum(samples, estimate) / sum(samples, (sample) => sample.tokens),
    mape: sum(samples, (sample) => Math.abs(estimate(sample) - sample.tokens) / sample.tokens) / samples.length,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Report 3: inline images, and the database sizes

interface Bytes {
  readonly parts: number
  /** Characters as stored (base64 or the whole data: URI): the bytes the database holds. */
  readonly stored: number
  /** The image bytes they encode. */
  readonly decoded: number
}

const ZERO: Bytes = { parts: 0, stored: 0, decoded: 0 }

interface SessionBytes {
  readonly total: Bytes
  readonly tables: Readonly<Record<string, Bytes>>
}

/** The JSON columns that can hold inline images, by the session they belong to. */
const SOURCES = [
  { table: "session_message", column: "data", session: "session_id", time: "time_created" },
  { table: "session_inbox", column: "payload", session: "session_id", time: "time_created" },
  { table: "session_pending", column: "data", session: "session_id", time: "time_created" },
  { table: "event", column: "data", session: "aggregate_id", time: "created" },
] as const

function images(db: Database, tables: ReadonlySet<string>, top: number) {
  const totals = new Map<string, Bytes>()
  const sessions = new Map<string, SessionBytes>()
  const days = new Map<string, Bytes>()
  for (const source of SOURCES.filter((source) => tables.has(source.table))) {
    const rows = db.query<{ session: string; time: number; data: string }, []>(
      `SELECT ${source.session} AS session, ${source.time} AS time, ${source.column} AS data FROM ${source.table} ` +
        `WHERE instr(${source.column}, 'image/') > 0 AND json_valid(${source.column})`,
    )
    for (const row of rows.iterate()) {
      const found = inlineImages(JSON.parse(row.data))
      if (found.parts === 0) continue
      const session: SessionBytes = sessions.get(row.session) ?? { total: ZERO, tables: {} }
      totals.set(source.table, plus(totals.get(source.table) ?? ZERO, found))
      days.set(dayOf(row.time), plus(days.get(dayOf(row.time)) ?? ZERO, found))
      sessions.set(row.session, {
        total: plus(session.total, found),
        tables: { ...session.tables, [source.table]: plus(session.tables[source.table] ?? ZERO, found) },
      })
    }
  }
  return {
    total: [...totals.values()].reduce(plus, ZERO),
    tables: Object.fromEntries(totals),
    sessions: sessions.size,
    top: [...sessions]
      .map((entry) => ({ sessionID: entry[0], ...entry[1].total, tables: entry[1].tables }))
      .toSorted((a, b) => b.stored - a.stored)
      .slice(0, top),
    days: [...days].map((entry) => ({ day: entry[0], ...entry[1] })).toSorted((a, b) => a.day.localeCompare(b.day)),
  }
}

function inlineImages(value: unknown): Bytes {
  if (Array.isArray(value)) return value.map(inlineImages).reduce(plus, ZERO)
  if (!isRecord(value)) return ZERO
  // Prompt.FileAttachment {data: base64, mime}: user prompts, inbox and pending payloads.
  if (typeof value.mime === "string" && value.mime.startsWith("image/") && typeof value.data === "string")
    return { parts: 1, stored: value.data.length, decoded: base64Size(value.data.length, value.data) }
  // Tool.FileContent {uri: data:image/...}: tool results (screenshots, read, MCP).
  if (typeof value.uri === "string" && value.uri.startsWith("data:image/")) {
    const comma = value.uri.indexOf(",")
    const payload = value.uri.length - comma - 1
    return {
      parts: 1,
      stored: value.uri.length,
      decoded: value.uri.slice(0, comma).endsWith(";base64") ? base64Size(payload, value.uri) : payload,
    }
  }
  return Object.values(value).map(inlineImages).reduce(plus, ZERO)
}

/** Decoded size of a base64 payload of `length` characters that `text` ends with (only its padding is read). */
function base64Size(length: number, text: string) {
  return Math.floor((length * 3) / 4) - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0)
}

function plus(a: Bytes, b: Bytes): Bytes {
  return { parts: a.parts + b.parts, stored: a.stored + b.stored, decoded: a.decoded + b.decoded }
}

function databaseInfo(db: Database, file: string, tables: ReadonlySet<string>) {
  const pragma = (name: string) =>
    Number(Object.values(db.query<Record<string, number>, []>(`PRAGMA ${name}`).get() ?? {})[0] ?? 0)
  return {
    path: scrub(file),
    files: { db: sizeOf(file), wal: sizeOf(`${file}-wal`), shm: sizeOf(`${file}-shm`) },
    pages: { count: pragma("page_count"), size: pragma("page_size"), free: pragma("freelist_count") },
    tables: Object.fromEntries(
      SOURCES.filter((source) => tables.has(source.table)).map((source) => [
        source.table,
        db
          .query<
            { rows: number; bytes: number },
            []
          >(`SELECT count(*) AS rows, coalesce(sum(length(CAST(${source.column} AS BLOB))), 0) AS bytes ` + `FROM ${source.table}`)
          .get() ?? { rows: 0, bytes: 0 },
      ]),
    ),
  }
}

function sizeOf(file: string) {
  return fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
}

/** The path with the home directory shown as ~ (the report may be pasted elsewhere). */
function scrub(file: string) {
  const relative = path.relative(os.homedir(), file)
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : path.join("~", relative)
}

// ---------------------------------------------------------------------------------------------------------------
// Output

type Report = Readonly<{
  version: 1
  generated: string
  database: ReturnType<typeof databaseInfo>
  steps: ReturnType<typeof readSteps>["counts"]
  density: ReturnType<typeof density>
  finishes: ReadonlyArray<FinishRow>
  images: ReturnType<typeof images>
}>

async function write(dir: string, report: Report) {
  fs.mkdirSync(dir, { recursive: true })
  await Bun.write(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  await Bun.write(path.join(dir, "report.md"), `${markdown(report)}\n`)
}

function markdown(report: Report) {
  const rows = [...report.density.byProvider, ...report.density.byModel, report.density.all]
  const name = (row: DensityRow) => `| ${row.providerID ?? "*"} | ${row.modelID ?? "*"} |`
  const coef = (result: Fit, term: string) => {
    const value = result.ok ? result.coef[term] : undefined
    return value ? `${fixed(value.value)} ± ${fixed(value.se)}` : "–"
  }
  const rate = (value: Accuracy | null) => (value ? `${value.ratio.toFixed(3)} | ${percent(value.mape)}` : "– | –")
  const steps = report.steps
  const files = report.database.files
  const pages = report.database.pages
  const inline = report.images
  const excluded = Object.entries(steps.excluded).map((entry) => `${entry[0]} ${number(entry[1])}`)
  const tables = Object.entries(report.database.tables).map(
    (entry) => `${entry[0]} ${number(entry[1].rows)} rows, ${bytes(entry[1].bytes)} JSON`,
  )
  return [
    "# own session database statistics",
    "",
    `- generated ${report.generated} from \`${report.database.path}\`: ${bytes(files.db)} (wal ${bytes(files.wal)}, shm ${bytes(files.shm)}), ${number(pages.count)} pages of ${pages.size} B, ${number(pages.free)} free`,
    `- tables: ${tables.join("; ")}`,
    `- assistant steps: ${number(steps.assistant)} read, ${number(steps.invalid)} unreadable, ${number(steps.used)} used in report 1; left out: ${excluded.join(", ")}`,
    "",
    "## 1. Output token density",
    "",
    "Per step: `tokens.output` (visible output, reasoning excluded) against the code points of its text parts and tool-call input JSON; reasoning parts are left out. Hangul = syllables and jamo; CJK = other ideographs, kana, bopomofo, CJK symbols and full-width forms. `*` rows pool providers (same model) or everything.",
    "",
    "| provider | model | steps | output tokens | Hangul | CJK | ASCII | other | tool calls |",
    "|---|---|--:|--:|--:|--:|--:|--:|--:|",
    ...rows.map(
      (row) =>
        `${name(row)} ${number(row.steps)} | ${number(row.tokens)} | ${number(row.chars.hangul)} | ${number(row.chars.cjk)} | ${number(row.chars.ascii)} | ${number(row.chars.other)} | ${number(row.toolCalls)} |`,
    ),
    "",
    "Least squares, tokens per character (± standard error), with per-step and per-tool-call overhead:",
    "",
    "| provider | model | Hangul | CJK | ASCII | other | per step | per tool call | R² | note |",
    "|---|---|--:|--:|--:|--:|--:|--:|--:|---|",
    ...rows.map(
      (row) =>
        `${name(row)} ${["hangul", "cjk", "ascii", "other", "step", "toolCall"].map((term) => coef(row.fit, term)).join(" | ")} | ${row.fit.ok && row.fit.r2 !== null ? row.fit.r2.toFixed(3) : "–"} | ${row.fit.ok ? "" : row.fit.reason} |`,
    ),
    "",
    "P-016 form (GW-P14): estimate = wH × Hangul + wC × CJK + (ASCII + other) / 4, fitted by least squares; Σ estimate / Σ tokens and mean absolute error per step, against upstream's length / 4:",
    "",
    "| provider | model | wH | wC | length/4 Σ ratio | length/4 error | P-016 Σ ratio | P-016 error |",
    "|---|---|--:|--:|--:|--:|--:|--:|",
    ...rows.map(
      (row) =>
        `${name(row)} ${coef(row.patch, "hangul")} | ${coef(row.patch, "cjk")} | ${rate(row.upstream)} | ${rate(row.patched)} |`,
    ),
    "",
    "## 2. Truncated and empty finishes",
    "",
    "Projected steps: `ended` = `session.step.ended` (a finish, no error), `failed` = `session.step.failed`. Empty = finish `stop` with `tokens.output` 0.",
    "",
    "| provider | model | variant | steps | ended | length | empty | empty, reasoning > 0 | empty, no usage | failed | first | last |",
    "|---|---|---|--:|--:|--:|--:|--:|--:|--:|---|---|",
    ...report.finishes.map(
      (row) =>
        `| ${row.providerID} | ${row.modelID} | ${row.variant ?? "–"} | ${number(row.steps)} | ${number(row.ended)} | ${number(row.length)} | ${number(row.stopEmpty)} | ${number(row.stopEmptyReasoning)} | ${number(row.stopEmptyNoUsage)} | ${number(row.failed)} | ${row.first} | ${row.last} |`,
    ),
    "",
    "## 3. Inline image bytes",
    "",
    `${number(inline.total.parts)} image parts in ${number(inline.sessions)} sessions: ${bytes(inline.total.stored)} stored, ${bytes(inline.total.decoded)} decoded.`,
    "",
    "| table | parts | stored | decoded | share of the table's JSON |",
    "|---|--:|--:|--:|--:|",
    ...Object.entries(inline.tables).map(
      (entry) =>
        `| ${entry[0]} | ${number(entry[1].parts)} | ${bytes(entry[1].stored)} | ${bytes(entry[1].decoded)} | ${percent(entry[1].stored / (report.database.tables[entry[0]]?.bytes || 1))} |`,
    ),
    "",
    `Top ${inline.top.length} sessions by stored bytes:`,
    "",
    "| session | parts | stored | decoded | by table |",
    "|---|--:|--:|--:|---|",
    ...inline.top.map((row) => {
      const parts = Object.entries(row.tables).map((entry) => `${entry[0]} ${bytes(entry[1].stored)}`)
      return `| ${row.sessionID} | ${number(row.parts)} | ${bytes(row.stored)} | ${bytes(row.decoded)} | ${parts.join(", ")} |`
    }),
    "",
    "By day (UTC, the row's time):",
    "",
    "| day | parts | stored | decoded |",
    "|---|--:|--:|--:|",
    ...inline.days.map((row) => `| ${row.day} | ${number(row.parts)} | ${bytes(row.stored)} | ${bytes(row.decoded)} |`),
  ].join("\n")
}

function number(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

/** Three decimals, without a "-0.000" for a rounding-error negative. */
function fixed(value: number) {
  return (Math.abs(value) < 0.0005 ? 0 : value).toFixed(3)
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function bytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  const exponent = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10))
  return exponent === 0 ? `${value} B` : `${(value / 1024 ** exponent).toFixed(1)} ${units[exponent]}`
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function dayOf(time: number) {
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString().slice(0, 10) : "unknown"
}

function sum<T>(items: ReadonlyArray<T>, of: (item: T, index: number) => number) {
  return items.reduce((total, item, index) => total + of(item, index), 0)
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test

/** The fixture's tables, created from core's generated schema so a renamed column fails here first. */
const FIXTURE_TABLES = ["session_message", "session_inbox", "session_pending", "event"]
/** In tool inputs, reasoning, tool results and prompts: the report must never contain it. */
const MARKER = "SELFTEST-SECRET-db-stats"
const TOOL_INPUT = { pattern: "나나", path: MARKER }
const TOOL_HANGUL = 2
const TOOL_ASCII = JSON.stringify(TOOL_INPUT).length - TOOL_HANGUL
/** Step compositions: code points per class in the text part, and tool calls (each adds TOOL_INPUT's JSON). */
const MIXES = [
  { hangul: 40, cjk: 0, ascii: 10, other: 0, tools: 0 },
  { hangul: 5, cjk: 3, ascii: 80, other: 2, tools: 1 },
  { hangul: 0, cjk: 0, ascii: 120, other: 0, tools: 2 },
  { hangul: 70, cjk: 8, ascii: 30, other: 4, tools: 0 },
  { hangul: 12, cjk: 0, ascii: 5, other: 9, tools: 1 },
  { hangul: 33, cjk: 21, ascii: 60, other: 0, tools: 3 },
  { hangul: 0, cjk: 14, ascii: 7, other: 1, tools: 0 },
  { hangul: 90, cjk: 2, ascii: 45, other: 6, tools: 2 },
  { hangul: 25, cjk: 5, ascii: 15, other: 3, tools: 1 },
  { hangul: 60, cjk: 0, ascii: 0, other: 12, tools: 0 },
]
type Mix = (typeof MIXES)[number]
const LONG: Mix = { hangul: 200, cjk: 0, ascii: 30, other: 0, tools: 0 }
const SHORT: Mix = { hangul: 5, cjk: 3, ascii: 8, other: 2, tools: 0 }
/** own-codex-01 gpt-x: a free-form truth with overheads. */
const CODEX = { hangul: 0.9, cjk: 1.2, ascii: 0.3, other: 0.5, step: 4, toolCall: 6 }
/** deepseek-flash on two slots: exactly the P-016 form. */
const FLASH = { hangul: 1.1, cjk: 0.8, ascii: 0.25, other: 0.25, step: 0, toolCall: 0 }
const DAY_A = Date.UTC(2026, 9, 4, 12)
const DAY_B = Date.UTC(2026, 9, 5, 3)

/**
 * The analysis on a fixture built in memory and opened the way a real run opens the database (read-only, from a temp
 * file): the fits recover the densities the fixture was generated with (reasoning text would break them), excluded
 * steps are counted by reason, the finish counts and image bytes match, the file is unchanged and the report holds no
 * text, marker or image data.
 */
async function selfTest() {
  const fixture = new Database(":memory:")
  fixture.exec("PRAGMA foreign_keys = OFF")
  coreTables().forEach((statement) => fixture.exec(statement))
  const expected = seed(fixture)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-db-stats-selftest-"))
  const file = path.join(root, "opencode-own.db")
  await Bun.write(file, fixture.serialize())
  fixture.close()
  const before = Bun.hash(fs.readFileSync(file))
  const db = open(file)
  const report = analyze(db, file, 1)
  const writeRefused = throws(() => db.exec("CREATE TABLE probe (x TEXT)"))
  const queryOnly = db.query<{ query_only: number }, []>("PRAGMA query_only").get()?.query_only === 1
  db.close()
  const unchanged = Bun.hash(fs.readFileSync(file)) === before
  fs.rmSync(root, { recursive: true, force: true })

  const text = `${JSON.stringify(report)}\n${markdown(report)}`
  const codex = report.density.byProvider.find((row) => row.providerID === "own-codex-01")
  const alt = report.density.byProvider.find((row) => row.providerID === "own-ds-alt")
  const flash = report.density.byModel.find((row) => row.modelID === "deepseek-flash")
  const finish = (providerID: string, variant: string | null) =>
    report.finishes.find((row) => row.providerID === providerID && row.variant === variant)
  const first = report.images.top[0]
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    [
      "opened read-only: a write is refused, query_only is on, the file is unchanged",
      writeRefused && queryOnly && unchanged,
    ],
    [
      "27 assistant rows: 1 unreadable, 21 used, the rest left out by reason",
      has(report.steps, { assistant: 27, invalid: 1, used: 21 }) &&
        has(report.steps.excluded, {
          failed: 1,
          unfinished: 1,
          finish: 0,
          noUsage: 1,
          noOutput: 1,
          noText: 0,
          reasoningInOutput: 1,
        }),
    ],
    [
      "characters per class: text parts plus tool-call input JSON, reasoning left out",
      codex !== undefined &&
        codex.chars.hangul === sum(MIXES, (mix) => mix.hangul + TOOL_HANGUL * mix.tools) &&
        codex.chars.ascii === sum(MIXES, (mix) => mix.ascii + TOOL_ASCII * mix.tools) &&
        codex.chars.cjk === sum(MIXES, (mix) => mix.cjk) &&
        codex.chars.other === sum(MIXES, (mix) => mix.other) &&
        codex.toolCalls === sum(MIXES, (mix) => mix.tools),
    ],
    ["the free fit recovers own-codex-01's densities and overheads", codex !== undefined && recovers(codex.fit, CODEX)],
    [
      "pooled per model, deepseek-flash (two slots) recovers the P-016 form and fits it exactly",
      flash !== undefined &&
        flash.steps === 11 &&
        recovers(flash.fit, FLASH) &&
        recovers(flash.patch, { hangul: FLASH.hangul, cjk: FLASH.cjk }) &&
        (flash.patched?.mape ?? 1) < 1e-9 &&
        (flash.upstream?.mape ?? 0) > 0.1 &&
        (flash.upstream?.ratio ?? 1) < 1,
    ],
    [
      "too few steps for the free fit are reported, the two-term P-016 fit still runs",
      alt !== undefined && !alt.fit.ok && recovers(alt.patch, { hangul: FLASH.hangul, cjk: FLASH.cjk }),
    ],
    ["the all-models row pools every used step", report.density.all.steps === 21],
    [
      "finishes: length, empty stop (reasoning, no usage) and failed per provider/model/variant",
      has(finish("own-ds-main", "none"), {
        steps: 3,
        ended: 3,
        length: 1,
        stopEmpty: 2,
        stopEmptyReasoning: 1,
        stopEmptyNoUsage: 1,
        failed: 0,
      }) &&
        has(finish("own-ds-main", null), { steps: 5, ended: 5, length: 0, stopEmpty: 0 }) &&
        has(finish("own-codex-01", null), { steps: 13, ended: 11, length: 0, stopEmpty: 0, failed: 1 }),
    ],
    [
      "image bytes per table, in total, for the top session and per UTC day (the PDF is not counted)",
      has(report.images.tables.session_message, expected.message) &&
        has(report.images.tables.event, expected.event) &&
        has(report.images.tables.session_inbox, expected.inbox) &&
        report.images.tables.session_pending === undefined &&
        has(report.images.total, [expected.message, expected.event, expected.inbox].reduce(plus, ZERO)) &&
        report.images.sessions === 2 &&
        report.images.top.length === 1 &&
        has(first, { sessionID: "ses_img_a", decoded: expected.message.decoded + expected.event.decoded }) &&
        report.images.days.map((row) => `${row.day}:${row.decoded}`).join(",") ===
          `2026-10-04:${expected.message.decoded + expected.event.decoded},2026-10-05:${expected.inbox.decoded}`,
    ],
    [
      "no message text, marker, Hangul/CJK or image data in the report",
      !text.includes(MARKER) &&
        !/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3\u4e00-\u9fff]/.test(text) &&
        expected.payloads.every((payload) => !text.includes(payload.slice(0, 32))),
    ],
    [
      "the default database follows the launcher: XDG_DATA_HOME, else ~/.local/share",
      databasePath({ XDG_DATA_HOME: path.join(root, "data") }, root) ===
        path.join(root, "data", "opencode", "opencode-own.db") &&
        databasePath({ XDG_DATA_HOME: "" }, root) === path.join(root, ".local", "share", "opencode", "opencode-own.db"),
    ],
  ]
  if (args.out) await write(path.resolve(args.out), report)
  for (const check of checks) console.log(`  ${check[1] ? "ok  " : "FAIL"} ${check[0]}`)
  const passed = checks.every((check) => check[1])
  console.log(passed ? "self-test ok" : "self-test FAILED")
  return passed ? 0 : 1
}

function coreTables() {
  const source = fs.readFileSync(path.join(REPO, "packages", "core", "src", "database", "schema.gen.ts"), "utf8")
  const statements = new Map(
    [...source.matchAll(/run\(`\s*(CREATE TABLE \\`(\w+)\\`[\s\S]*?\);)\s*`\)/g)].map((match) => [
      match[2],
      (match[1] ?? "").replaceAll("\\`", "`"),
    ]),
  )
  return FIXTURE_TABLES.map((table) => {
    const statement = statements.get(table)
    if (!statement) throw new Error(`core schema.gen.ts has no CREATE TABLE ${table}`)
    return statement
  })
}

/** Rows shaped like core's projections (message data = the encoded message without id and type). */
function seed(db: Database) {
  const tool = (index: number, content: ReadonlyArray<unknown>) => ({
    type: "tool",
    id: `call_${index}`,
    name: "grep",
    state: { status: "completed", input: TOOL_INPUT, content },
    time: { created: DAY_A },
  })
  const text = (mix: Mix) => ({
    type: "text",
    text: `${"가".repeat(mix.hangul)}${"中".repeat(mix.cjk)}${"a".repeat(mix.ascii)}${"é".repeat(mix.other)}`,
  })
  const tokens = (truth: Readonly<Record<string, number>>, mix: Mix) =>
    (truth.hangul ?? 0) * (mix.hangul + TOOL_HANGUL * mix.tools) +
    (truth.cjk ?? 0) * mix.cjk +
    (truth.ascii ?? 0) * (mix.ascii + TOOL_ASCII * mix.tools) +
    (truth.other ?? 0) * mix.other +
    (truth.step ?? 0) +
    (truth.toolCall ?? 0) * mix.tools
  const assistant = (input: {
    providerID: string
    modelID: string
    variant?: string
    content: ReadonlyArray<unknown>
    finish?: string
    output?: number
    reasoning?: number
    usage?: boolean
    error?: boolean
  }) => ({
    agent: "build",
    model: { id: input.modelID, providerID: input.providerID, variant: input.variant },
    content: input.content,
    finish: input.finish,
    tokens:
      input.output === undefined
        ? undefined
        : {
            input: input.usage === false ? 0 : 1200,
            output: input.output,
            reasoning: input.reasoning ?? 0,
            cache: { read: input.usage === false ? 0 : 300, write: 0 },
          },
    error: input.error ? { type: "unknown", message: "fixture" } : undefined,
    time: { created: DAY_A, completed: DAY_A },
  })
  const contentOf = (mix: Mix, reasoning: boolean) => [
    ...(reasoning ? [{ type: "reasoning", text: `생각 ${MARKER} `.repeat(20) }] : []),
    text(mix),
    ...Array.from({ length: mix.tools }, (_, call) => tool(call, [{ type: "text", text: MARKER }])),
  ]
  const finishOf = (mix: Mix) => (mix.tools > 0 ? "tool-calls" : "stop")
  const row = (data: unknown, sessionID = "ses_density", type = "assistant") =>
    [sessionID, type, DAY_A, typeof data === "string" ? data : JSON.stringify(data)] as const
  const bytesOf = (length: number) => Buffer.from(Array.from({ length }, (_, i) => (i * 37) % 256)).toString("base64")
  const png = bytesOf(301)
  const jpeg = `data:image/jpeg;base64,${bytesOf(602)}`
  const webp = bytesOf(100)
  const screenshot = [{ type: "file", uri: jpeg, mime: "image/jpeg" }]
  const codex = { providerID: "own-codex-01", modelID: "gpt-x" }
  const none = { providerID: "own-ds-main", modelID: "deepseek-flash", variant: "none" }
  const messages = [
    ...MIXES.map((mix, index) =>
      row(
        assistant({
          ...codex,
          content: contentOf(mix, index % 2 === 0),
          finish: finishOf(mix),
          output: tokens(CODEX, mix),
          reasoning: index % 2 === 0 ? 77 : 0,
        }),
      ),
    ),
    ...MIXES.map((mix, index) =>
      row(
        assistant({
          providerID: index % 2 === 0 ? "own-ds-main" : "own-ds-alt",
          modelID: "deepseek-flash",
          content: contentOf(mix, false),
          finish: finishOf(mix),
          output: tokens(FLASH, mix),
        }),
      ),
    ),
    // Truncated: used for density too (its usage covers its text).
    row(assistant({ ...none, content: [text(LONG)], finish: "length", output: tokens(FLASH, LONG) })),
    // Empty stops: hidden reasoning only, and no usage reported at all.
    row(assistant({ ...none, content: [], finish: "stop", output: 0, reasoning: 50 })),
    row(assistant({ ...none, content: [], finish: "stop", output: 0, usage: false })),
    // Reasoning text but no reasoning tokens: the output count likely includes it.
    row(
      assistant({ ...codex, content: [{ type: "reasoning", text: MARKER }, text(SHORT)], finish: "stop", output: 999 }),
    ),
    row(assistant({ ...codex, content: [text(SHORT)], finish: "error", output: 5, error: true })),
    row(`{"model":{"id":"gpt-x","providerID":"own-codex-01"},"content":[`),
    row(
      {
        text: MARKER,
        files: [
          { data: png, mime: "image/png", source: { type: "inline" }, name: MARKER },
          { data: bytesOf(50), mime: "application/pdf", source: { type: "inline" } },
        ],
        time: { created: DAY_A },
      },
      "ses_img_a",
      "user",
    ),
    // Unfinished (no step.ended yet), with a screenshot in its tool result.
    row(assistant({ ...codex, content: [tool(0, screenshot)] }), "ses_img_a"),
  ]
  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  messages.forEach((message, index) =>
    insertMessage.run(
      `msg_${String(index).padStart(4, "0")}`,
      message[0],
      message[1],
      index,
      message[2],
      message[2],
      message[3],
    ),
  )
  db.prepare("INSERT INTO event (id, aggregate_id, seq, created, type, data) VALUES (?, ?, ?, ?, ?, ?)").run(
    "evt_0001",
    "ses_img_a",
    1,
    DAY_A,
    "session.tool.success.2",
    JSON.stringify({
      sessionID: "ses_img_a",
      assistantMessageID: "msg_0027",
      id: "call_0",
      content: screenshot,
      executed: true,
    }),
  )
  db.prepare(
    "INSERT INTO session_inbox (id, session_id, type, payload, delivery, enqueued_seq, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg_inbox",
    "ses_img_b",
    "user",
    JSON.stringify({ text: MARKER, files: [{ data: webp, mime: "image/webp", source: { type: "inline" } }] }),
    "steer",
    1,
    DAY_B,
  )
  return {
    message: { parts: 2, stored: png.length + jpeg.length, decoded: 301 + 602 },
    event: { parts: 1, stored: jpeg.length, decoded: 602 },
    inbox: { parts: 1, stored: webp.length, decoded: 100 },
    payloads: [png, jpeg.slice(jpeg.indexOf(",") + 1), webp],
  }
}

function recovers(result: Fit, truth: Readonly<Record<string, number>>) {
  if (!result.ok) return false
  return Object.entries(truth).every((entry) => {
    const value = result.coef[entry[0]]?.value ?? 0
    return Math.abs(value - entry[1]) <= 1e-6 * Math.max(1, Math.abs(entry[1]))
  })
}

/** Whether `actual` exists and has each of `expected`'s fields with the same value. */
function has(actual: object | undefined, expected: object) {
  if (actual === undefined) return false
  const values = new Map(Object.entries(actual))
  return Object.entries(expected).every((entry) => values.get(entry[0]) === entry[1])
}

function throws(action: () => unknown) {
  try {
    action()
  } catch {
    return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------
// Entry, last: every module constant above is initialized by now.

const code = await (args["self-test"] ? selfTest() : run()).catch((error: unknown) => {
  console.error(`db-stats: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
process.exit(code)
