// PG3 (07 §8.4): does the delegation instruction move the main's subagent use? Ten tasks (`tasks.ts`) × the four
// delegation modes {모델 기본, 요청할 때만, 도움될 때, 적극적으로} × two wordings of the `own.preset` entry {ours,
// Codex's} on GPT-6 Sol, Claude Opus 5.5 and DeepSeek. `모델 기본` writes no entry, so it runs once per task.
//
//   cd packages/own-accounts
//   bun test/pg3/delegation-ab.ts --fake                  e2e-kit fakes (scripted models), no account, no money
//   bun test/pg3/delegation-ab.ts --real                  plan only: the installed own service and its accounts
//   bun test/pg3/delegation-ab.ts --real --yes --codex-source <openai/codex>/codex-rs/prompts/src/model_messages/multi_agent.rs
//
// Options: --models gpt,claude,deepseek  --modes model,on-request,when-useful,active  --wordings ours,codex
// --tasks t01,t02  --repeat N  --concurrency N  --timeout-ms N  --min-share 0.5  --out DIR. Real mode also takes
// --channel own, --control DIR, --workspace DIR, --gpt-account, --claude-account, --deepseek-account (id or label),
// --deepseek-model. Results go to own/.out/pg3/<time>/results.{md,json} (ignored by git).
//
// Each run: a new root session on the model under test at the fixture project, approval `read-only`, the mode's preset
// applied (`평소대로` for `모델 기본`, else a temporary `PG3 <mode>` preset of that group with every role like the
// main), for the Codex wording the entry's delegation paragraph replaced by Codex's sentence, then the task prompt.
// The runner counts the main's `subagent` calls, the gate's declines and whether the main went on after a cap.
//
// Real mode is opt-in and spends quota and money: it talks to the user's own service over loopback with the password
// of its registration file (never printed), reads `accounts.list` (labels and ids only), creates the temporary presets
// and removes them at the end. The Codex sentences are read from the user's checkout of openai/codex at run time and
// never stored in this repository; `--fake` uses stand-in sentences.
//
// `--pool` runs PG13 (07 §8.4 모델 묶음 A/B) instead: the twelve pool tasks (`POOL_TASKS`) at `도움될 때` with a
// temporary model pool preset per main built from `presets.suggest` (the main account's lightest model, each other
// company's strongest subscription model, a verified local model, and a paid DeepSeek key with a $1 budget in fake
// mode), in two wordings {ours, a short Codex-like header}. It measures what the main writes as `model`: the share of
// pool names, the share of values outside the pool (a provider id, a made-up name) and whether the call after such a
// decline names a pool model or none, paid picks on tasks that need none, pool names written as `agent`, and errors.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { Preset } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import { PresetGuidance } from "../../src/presets/guidance.js"
import { isRecord, type RecordedRequest, type Reply } from "../e2e-kit/fakes/shared"
import { POOL_TASKS, TASKS, writeFixture, type Task } from "./tasks"

export const MODELS = ["gpt", "claude", "deepseek"] as const
export type ModelKey = (typeof MODELS)[number]

export const MODES = ["model", "on-request", "when-useful", "active"] as const
export type Mode = (typeof MODES)[number]

export const WORDINGS = ["ours", "codex"] as const
export type Wording = (typeof WORDINGS)[number]

const MODEL_NAME: Readonly<Record<ModelKey, string>> = {
  gpt: "GPT-6 Sol",
  claude: "Claude Opus 5.5",
  deepseek: "DeepSeek",
}

const MODE_NAME: Readonly<Record<Mode, string>> = {
  model: "모델 기본",
  "on-request": "요청할 때만",
  "when-useful": "도움될 때",
  active: "적극적으로",
}

const WORDING_NAME: Readonly<Record<Wording | "none", string>> = {
  ours: "우리 문장",
  codex: "Codex 원문",
  none: "–",
}

/** The main of one model under test: its account, preset group and model. */
export interface Main {
  readonly key: ModelKey
  readonly label: string
  readonly accountID: string
  readonly group: Preset.Group
  readonly ref: { readonly providerID: string; readonly id: string; readonly variant?: string }
}

/** One planned run. `모델 기본` has no entry, so its wording is `none`. */
export interface Run {
  readonly main: Main
  readonly mode: Mode
  readonly wording: Wording | "none"
  readonly task: Task
  readonly repeat: number
}

export interface Measure {
  /** The main's `subagent` calls, declined ones included. */
  readonly calls: number
  readonly completed: number
  /** Calls the preset gate declined (`Unknown agent: own-preset: …`). */
  readonly declined: number
  /** Of those, cap declines (07 §2.6). */
  readonly capped: number
  /** After the last cap decline the main wrote more or called again; `null` without a cap decline. */
  readonly continued: boolean | null
}

/** PG13: what the main wrote as `model` and `agent` in its `subagent` calls under a model pool. */
export interface PoolMeasure {
  /** Calls with a `model` value. */
  readonly named: number
  /** Of those, values that are a pool name. */
  readonly inPool: number
  /** Values outside the pool: a `provider/model`, a role name aside, a made-up name. */
  readonly outside: number
  /** Pool names of entries that cost money. */
  readonly paidPicks: number
  /** Calls whose `agent` is a pool name. */
  readonly agentKeys: number
  /** After the first pool decline, the next call named a pool model or none; `null` without a decline. */
  readonly recovered: boolean | null
}

export interface Row extends Measure {
  readonly model: ModelKey
  readonly mode: Mode
  readonly wording: Wording | "none"
  readonly task: string
  readonly splittable: boolean
  readonly repeat: number
  readonly sessionID: string | null
  /** What the `own.preset` entry held when the task was sent. */
  readonly entry: "none" | Wording
  readonly ms: number
  readonly error: string | null
  /** PG13 only (`--pool`). */
  readonly pool?: PoolMeasure
}

/** Where the runner talks to: the service, the folder for global own.accounts methods and the sessions' folder. */
export interface Bench {
  readonly service: ServiceTarget.Target
  readonly control: string
  readonly workspace: string
  readonly mains: ReadonlyArray<Main>
}

export interface Options {
  readonly concurrency: number
  readonly timeoutMs: number
  /** Needed when a run uses the Codex wording. */
  readonly codex?: CodexWording
  /** Suffix of the temporary preset names. */
  readonly stamp: string
  readonly log?: (line: string) => void
  /** PG13: a model pool preset per main instead of the mode presets (`--pool`). */
  readonly pool?: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// Plan

export function plan(input: {
  readonly mains: ReadonlyArray<Main>
  readonly modes: ReadonlyArray<Mode>
  readonly wordings: ReadonlyArray<Wording>
  readonly tasks: ReadonlyArray<Task>
  readonly repeat: number
}): ReadonlyArray<Run> {
  return input.mains.flatMap((main) =>
    input.modes.flatMap((mode) =>
      (mode === "model" ? (["none"] as const) : input.wordings).flatMap((wording) =>
        input.tasks.flatMap((task) =>
          Array.from({ length: input.repeat }, (_, index) => ({ main, mode, wording, task, repeat: index + 1 })),
        ),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Codex wording

/** Codex's two delegation sentences (openai/codex `codex-rs/prompts/src/model_messages/multi_agent.rs`). */
export interface CodexWording {
  readonly explicit: string
  readonly proactive: string
}

/** Stand-in sentences for `--fake` and the tests: the fake models recognise them; the real text is never stored. */
export const STAND_IN: CodexWording = {
  explicit: "PG3 stand-in for the Codex explicit-request sentence: no subagents unless the user asks for them.",
  proactive: "PG3 stand-in for the Codex proactive sentence: delegate independent parts of the work.",
}

/** Reads the two `&str` constants from Codex's source file; `undefined` when either is missing. */
export function readCodexWording(source: string): CodexWording | undefined {
  const constant = (name: string) => {
    const raw = new RegExp(`const ${name}: &str = "((?:[^"\\\\]|\\\\.)*)";`).exec(source)?.[1]
    return raw?.replace(/\\(.)/g, (_, char: string) => ESCAPES[char] ?? char)
  }
  const explicit = constant("EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT")
  const proactive = constant("PROACTIVE_MULTI_AGENT_MODE_TEXT")
  return explicit && proactive ? { explicit, proactive } : undefined
}

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\" }

/** Our mode's delegation paragraph, as `Preset.renderGuidance` writes it (no role cards). */
function paragraph(delegation: "when-useful" | "active") {
  const text = Preset.renderGuidance({ delegation, ultra: false, caps: Preset.CAPS, cards: {} })?.text ?? ""
  return text.split("\n\n")[0]?.split("\n")[1] ?? ""
}

const sentences = (text: string) => text.split(/(?<=\.)\s+/)

/**
 * What `적극적으로` adds to `도움될 때` in our wording ("subagents first, in the background", 07 §2.5). Codex has one
 * proactive sentence, so its `적극적으로` variant is that sentence plus this.
 */
export const ACTIVE_EXTRA = sentences(paragraph("active"))
  .filter(
    (sentence) => !sentence.startsWith("Delegation mode:") && !sentences(paragraph("when-useful")).includes(sentence),
  )
  .join(" ")

/**
 * The entry with Codex's delegation sentence in place of ours: the header line, the role cards and the caps line stay
 * (07 §3.3 compares only the wording). `요청할 때만` takes the explicit-request sentence, `도움될 때` the proactive one,
 * `적극적으로` the proactive one plus {@link ACTIVE_EXTRA}.
 */
export function codexVariant(ours: string, mode: Exclude<Mode, "model">, codex: CodexWording) {
  const [head = "", ...rest] = ours.split("\n\n")
  const header = head.split("\n")[0] ?? ""
  const sentence =
    mode === "on-request" ? codex.explicit : mode === "active" ? `${codex.proactive} ${ACTIVE_EXTRA}` : codex.proactive
  return [`${header}\n${sentence}`, ...rest].join("\n\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Running

export async function execute(bench: Bench, runs: ReadonlyArray<Run>, options: Options): Promise<ReadonlyArray<Row>> {
  const api = client(bench.service)
  const pools = options.pool ? await createPoolPresets(api, bench, runs, options.stamp) : new Map<string, PoolPreset>()
  const presets = options.pool
    ? new Map([...pools].map(([key, item]) => [key, item.id]))
    : await createPresets(api, bench, runs, options.stamp)
  return pool(runs, options.concurrency, async (run, index) => {
    const row = await runOne(api, bench, presets, run, options, pools.get(presetKey(run.main.group, run.mode)))
    options.log?.(
      `${index + 1}/${runs.length} ${row.model} ${row.mode} ${row.wording} ${row.task}: ${row.error ?? `${row.calls} call(s), ${row.declined} declined`}`,
    )
    return row
  }).finally(() => removePresets(api, bench, presets))
}

async function runOne(
  api: Api,
  bench: Bench,
  presets: ReadonlyMap<string, string>,
  run: Run,
  options: Options,
  pooled?: PoolPreset,
): Promise<Row> {
  const started = Date.now()
  const base = {
    model: run.main.key,
    mode: run.mode,
    wording: run.wording,
    task: run.task.id,
    splittable: run.task.splittable,
    repeat: run.repeat,
  }
  const failed =
    (sessionID: string | null) =>
    async (error: unknown): Promise<Row> => {
      // A run that timed out may still be working; stop it (best effort) so it does not spend more.
      if (sessionID !== null) await api.interrupt(bench.workspace, sessionID).catch(() => undefined)
      return {
        ...base,
        sessionID,
        entry: "none",
        calls: 0,
        completed: 0,
        declined: 0,
        capped: 0,
        continued: null,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  const steps = async (sessionID: string): Promise<Row> => {
    await api.rpc("session.approval.set", { sessionID, mode: "read-only" }, bench.workspace)
    const presetID = presets.get(presetKey(run.main.group, run.mode)) ?? Preset.builtinID(run.main.group)
    await api.rpc("session.preset.apply", { sessionID, presetID }, bench.workspace)
    const entry = pooled
      ? await setPoolWording(api, bench, sessionID, run)
      : await setWording(api, bench, sessionID, run, options.codex)
    await api.prompt(bench.workspace, sessionID, run.task.prompt)
    await settle(api, bench.workspace, sessionID, options.timeoutMs)
    const messages = await api.assistantMessages(bench.workspace, sessionID)
    const measured = measure(messages)
    return {
      ...base,
      ...measured,
      sessionID,
      entry,
      ms: Date.now() - started,
      error: null,
      ...(pooled ? { pool: measurePool(messages, pooled.keys, pooled.paid) } : {}),
    }
  }
  const title = `PG3 · ${run.main.key} · ${run.mode} · ${run.wording} · ${run.task.id}`
  return api
    .createSession(bench.workspace, run.main.ref, title)
    .then((sessionID) => steps(sessionID).catch(failed(sessionID)), failed(null))
}

/** Leaves our entry or writes the Codex variant; reports what the entry holds. */
async function setWording(
  api: Api,
  bench: Bench,
  sessionID: string,
  run: Run,
  codex: CodexWording | undefined,
): Promise<"none" | Wording> {
  const current = (await api.entries(bench.workspace, sessionID)).find((entry) => entry.key === PresetGuidance.KEY)
  if (current === undefined || typeof current.value !== "string") return "none"
  if (run.wording !== "codex" || run.mode === "model") return "ours"
  if (codex === undefined) throw new Error("the Codex wording was not loaded (--codex-source)")
  await api.putEntry(bench.workspace, sessionID, codexVariant(current.value, run.mode, codex))
  return "codex"
}

/**
 * PG13's short Codex-like header in place of ours (07 §3.3 모델 묶음): it names the list and what to pass, without
 * saying that a name is the user's explicit request.
 */
export const POOL_SHORT = "Subagent models. Pass one name below as `model` and the kind of work as `agent`."

/** The pool block with {@link POOL_SHORT} in place of our header line; the cards and the two last lines stay. */
export function poolVariant(ours: string) {
  return ours
    .split("\n")
    .map((line) => (line.startsWith("Subagent models.") ? POOL_SHORT : line))
    .join("\n")
}

/** Leaves our pool entry or writes the short variant; reports what the entry holds. */
async function setPoolWording(api: Api, bench: Bench, sessionID: string, run: Run): Promise<"none" | Wording> {
  const current = (await api.entries(bench.workspace, sessionID)).find((entry) => entry.key === PresetGuidance.KEY)
  if (current === undefined || typeof current.value !== "string") return "none"
  if (run.wording !== "codex") return "ours"
  await api.putEntry(bench.workspace, sessionID, poolVariant(current.value))
  return "codex"
}

const presetKey = (group: Preset.Group, mode: Mode) => `${group}|${mode}`

/** A temporary model pool preset (PG13): its id, its names and the names of entries that cost money. */
export interface PoolPreset {
  readonly id: string
  readonly keys: ReadonlyArray<string>
  readonly paid: ReadonlyArray<string>
}

/**
 * PG13's pool for one group from `presets.suggest` (07 §11): the main account's lightest model, each other company's
 * strongest model of the first (roomiest) subscription account, the first verified local model, and the first paid
 * entry of a DeepSeek key. Raw prices only.
 */
export function poolFixture(offer: Preset.PoolOffer): ReadonlyArray<Preset.PoolCandidate> {
  const priced = (list: ReadonlyArray<Preset.PoolCandidate>, order: 1 | -1) =>
    list.toSorted((a, b) => ((a.price ?? Infinity) - (b.price ?? Infinity)) * order)
  const candidates = offer.candidates
  const main = priced(
    candidates.filter((item) => item.account === undefined),
    1,
  )[0]
  const firsts = [
    ...Map.groupBy(
      candidates.filter((item) => item.runs === "subscription"),
      (item) => item.company ?? "",
    ).values(),
  ].flatMap((list) => {
    const account = list[0]?.account
    return priced(
      list.filter((item) => item.account === account),
      -1,
    ).slice(0, 1)
  })
  const local = candidates.find((item) => item.runs === "local" && item.card?.windowVerified === true)
  const paid = candidates.find((item) => item.runs === "paid" && item.company === "deepseek")
  return [main, ...firsts, local, paid].filter((item) => item !== undefined)
}

/** One temporary model pool preset per group of the runs (`도움될 때`), built by {@link poolFixture}. */
async function createPoolPresets(api: Api, bench: Bench, runs: ReadonlyArray<Run>, stamp: string) {
  const groups = [...new Set(runs.map((run) => run.main.group))]
  const created = await Promise.allSettled(
    groups.map(async (group) => {
      const suggested = await api.rpc("presets.suggest", { group }, bench.control)
      const offer = Schema.decodeUnknownSync(Preset.PoolOffer)(suggested.pool)
      const entries = poolFixture(offer)
      const saved = await api.rpc(
        "presets.set",
        {
          preset: {
            name: `PG13 pool ${stamp}`,
            group,
            workers: {
              mode: "same",
              roles: {},
              pool: entries.map((item) => ({
                key: item.key,
                model: item.model,
                ...(item.account === undefined ? {} : { account: item.account }),
              })),
            },
            delegation: "when-useful",
            caps: Preset.CAPS,
            ultraCaps: null,
          },
        },
        bench.control,
      )
      const preset = Schema.decodeUnknownSync(Preset.Info)(saved.preset)
      const pool = preset.workers.pool ?? []
      const costs = (key: string) =>
        entries.some((item) => item.key === key && (item.runs === "paid" || item.runs === "main-paid"))
      const value: PoolPreset = {
        id: preset.id,
        keys: pool.map((entry) => entry.key),
        paid: pool.flatMap((entry) => (costs(entry.key) ? [entry.key] : [])),
      }
      return [presetKey(group, "when-useful"), value] as const
    }),
  )
  const made = new Map(created.flatMap((item) => (item.status === "fulfilled" ? [item.value] : [])))
  const failure = created.find((item) => item.status === "rejected")
  if (failure === undefined) return made
  await removePresets(api, bench, new Map([...made].map(([key, item]) => [key, item.id])))
  throw failure.reason
}

/** One temporary preset per group and mode the runs use (every role like the main), `평소대로` for `모델 기본`. */
async function createPresets(api: Api, bench: Bench, runs: ReadonlyArray<Run>, stamp: string) {
  const needed = [
    ...new Set(runs.filter((run) => run.mode !== "model").map((run) => presetKey(run.main.group, run.mode))),
  ]
  const created = await Promise.allSettled(
    needed.map(async (key) => {
      const run = runs.find((item) => presetKey(item.main.group, item.mode) === key)
      if (run === undefined || run.mode === "model") throw new Error(`no run for preset ${key}`)
      const saved = await api.rpc(
        "presets.set",
        {
          preset: {
            name: `PG3 ${run.mode} ${stamp}`,
            group: run.main.group,
            workers: { mode: "same", roles: {} },
            delegation: run.mode,
            caps: Preset.CAPS,
            ultraCaps: null,
          },
        },
        bench.control,
      )
      const id = isRecord(saved.preset) ? saved.preset.id : undefined
      if (typeof id !== "string") throw new Error(`presets.set returned no id for ${key}`)
      return [key, id] as const
    }),
  )
  const made = new Map(created.flatMap((item) => (item.status === "fulfilled" ? [item.value] : [])))
  const failure = created.find((item) => item.status === "rejected")
  if (failure === undefined) return made
  // Real mode writes the user's presets.json: take back what was made before giving up.
  await removePresets(api, bench, made)
  throw failure.reason
}

async function removePresets(api: Api, bench: Bench, presets: ReadonlyMap<string, string>) {
  await Promise.all(
    [...presets.values()].map((presetID) =>
      api.rpc("presets.remove", { presetID }, bench.control).catch(() => undefined),
    ),
  )
}

/** Runs `work` over `items` with at most `limit` at once, keeping the input order in the result. */
async function pool<T, R>(items: ReadonlyArray<T>, limit: number, work: (item: T, index: number) => Promise<R>) {
  const results: R[] = []
  const queue = items.entries()
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (const [index, item] of queue) results[index] = await work(item, index)
    }),
  )
  return results
}

// ---------------------------------------------------------------------------------------------------------------
// Measuring

const UNKNOWN_AGENT = "Unknown agent: "

/** Counts the main's `subagent` calls in its assistant messages (oldest first) and what came after a cap decline. */
export function measure(messages: ReadonlyArray<unknown>): Measure {
  const parts = messages.flatMap((message) =>
    isRecord(message) && Array.isArray(message.content) ? message.content.filter(isRecord) : [],
  )
  const calls = parts.flatMap((part, index) =>
    part.type === "tool" && part.name === "subagent" && isRecord(part.state) ? [{ index, state: part.state }] : [],
  )
  const declined = calls.flatMap((call) => {
    const error =
      isRecord(call.state.error) && typeof call.state.error.message === "string" ? call.state.error.message : ""
    const rejection = error.startsWith(UNKNOWN_AGENT) ? Preset.parse(error.slice(UNKNOWN_AGENT.length)) : undefined
    return rejection ? [{ index: call.index, rejection }] : []
  })
  const capped = declined.filter((item) => item.rejection.reason === "caps")
  const last = capped.at(-1)
  return {
    calls: calls.length,
    completed: calls.filter((call) => call.state.status === "completed").length,
    declined: declined.length,
    capped: capped.length,
    continued:
      last === undefined
        ? null
        : parts
            .slice(last.index + 1)
            .some((part) => part.type === "tool" || (part.type === "text" && String(part.text ?? "").trim() !== "")),
  }
}

/** PG13: the `model` and `agent` values of the main's `subagent` calls (the LLM's input as core recorded it). */
export function measurePool(
  messages: ReadonlyArray<unknown>,
  keys: ReadonlyArray<string>,
  paid: ReadonlyArray<string>,
): PoolMeasure {
  const calls = messages
    .flatMap((message) => (isRecord(message) && Array.isArray(message.content) ? message.content.filter(isRecord) : []))
    .flatMap((part) =>
      part.type === "tool" && part.name === "subagent" && isRecord(part.state) && isRecord(part.state.input)
        ? [{ input: part.state.input, state: part.state }]
        : [],
    )
  const values = calls.map((call) => (typeof call.input.model === "string" ? call.input.model : undefined))
  const named = values.filter((value) => value !== undefined)
  const declined = calls.findIndex((call) => {
    const error =
      isRecord(call.state.error) && typeof call.state.error.message === "string" ? call.state.error.message : ""
    const rejection = error.startsWith(UNKNOWN_AGENT) ? Preset.parse(error.slice(UNKNOWN_AGENT.length)) : undefined
    return rejection !== undefined && "models" in rejection
  })
  const next = declined < 0 ? undefined : values[declined + 1]
  return {
    named: named.length,
    inPool: named.filter((value) => keys.includes(value)).length,
    outside: named.filter((value) => !keys.includes(value) && Preset.roleOf(value) === undefined).length,
    paidPicks: named.filter((value) => paid.includes(value)).length,
    agentKeys: calls.filter((call) => typeof call.input.agent === "string" && keys.includes(call.input.agent)).length,
    recovered: declined < 0 ? null : declined + 1 >= calls.length ? false : next === undefined || keys.includes(next),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Results

export interface Cell {
  readonly model: ModelKey
  readonly mode: Mode
  readonly wording: Wording | "none"
  readonly runs: number
  readonly errors: number
  readonly splittable: number
  /** Splittable runs with at least one subagent call. */
  readonly splitUsed: number
  readonly other: number
  readonly otherUsed: number
  readonly calls: number
  readonly declined: number
  /** Runs with a cap decline, and how many of them went on afterwards. */
  readonly capRuns: number
  readonly continued: number
}

export interface Verdict {
  readonly gate: string
  readonly model: ModelKey
  readonly wording: Wording | "none"
  readonly result: "pass" | "fail" | "recorded" | "not run"
  readonly detail: string
}

export interface Meta {
  readonly mode: "fake" | "real"
  readonly date: string
  readonly mains: ReadonlyArray<{
    readonly key: ModelKey
    readonly label: string
    readonly group: string
    readonly model: string
  }>
  readonly tasks: ReadonlyArray<string>
  readonly codexWording: string
  readonly minShare: number
}

export interface Report {
  readonly meta: Meta
  readonly cells: ReadonlyArray<Cell>
  readonly verdicts: ReadonlyArray<Verdict>
  readonly advice: ReadonlyArray<string>
  readonly rows: ReadonlyArray<Row>
}

export function cells(rows: ReadonlyArray<Row>): ReadonlyArray<Cell> {
  const keys = [...new Set(rows.map((row) => `${row.model}|${row.mode}|${row.wording}`))]
  return keys.map((key) => {
    const group = rows.filter((row) => `${row.model}|${row.mode}|${row.wording}` === key)
    const ok = group.filter((row) => row.error === null)
    const first = group[0]!
    const split = ok.filter((row) => row.splittable)
    const other = ok.filter((row) => !row.splittable)
    const capRuns = ok.filter((row) => row.capped > 0)
    return {
      model: first.model,
      mode: first.mode,
      wording: first.wording,
      runs: group.length,
      errors: group.length - ok.length,
      splittable: split.length,
      splitUsed: split.filter((row) => row.calls > 0).length,
      other: other.length,
      otherUsed: other.filter((row) => row.calls > 0).length,
      calls: ok.reduce((sum, row) => sum + row.calls, 0),
      declined: ok.reduce((sum, row) => sum + row.declined, 0),
      capRuns: capRuns.length,
      continued: capRuns.filter((row) => row.continued === true).length,
    }
  })
}

/**
 * PG3's pass criteria (07 §8.4): `모델 기본` GPT never delegates unasked (others are recorded to correct 07 §2.5's
 * hint); `요청할 때만` never delegates; `도움될 때` and `적극적으로` delegate on at least `minShare` of the splittable
 * tasks; a call over a cap is followed by other work or a retry.
 */
export function verdicts(list: ReadonlyArray<Cell>, minShare: number): ReadonlyArray<Verdict> {
  const used = (cell: Cell) => `${cell.splitUsed}/${cell.splittable} split, ${cell.otherUsed}/${cell.other} other`
  const byMode = list.map((cell): Verdict => {
    const base = { gate: MODE_NAME[cell.mode], model: cell.model, wording: cell.wording }
    const counted = cell.splittable + cell.other
    if (counted === 0) return { ...base, result: "not run", detail: `${cell.errors} error(s)` }
    if (cell.mode === "model" && cell.model !== "gpt") return { ...base, result: "recorded", detail: used(cell) }
    if (cell.mode === "model" || cell.mode === "on-request")
      return { ...base, result: cell.calls === 0 ? "pass" : "fail", detail: `${cell.calls} call(s); ${used(cell)}` }
    if (cell.splittable === 0) return { ...base, result: "not run", detail: "no splittable task ran" }
    return {
      ...base,
      result: cell.splitUsed / cell.splittable >= minShare ? "pass" : "fail",
      detail: `${used(cell)} (needs ≥ ${Math.round(minShare * 100)}% of split)`,
    }
  })
  // `모델 기본` runs count only when one met a cap (Claude may delegate there on its own).
  const pairs = [...new Set(list.map((cell) => `${cell.model}|${cell.wording}`))].filter(
    (pair) =>
      !pair.endsWith("|none") || list.some((cell) => `${cell.model}|${cell.wording}` === pair && cell.capRuns > 0),
  )
  const caps = pairs.map((pair): Verdict => {
    const group = list.filter((cell) => `${cell.model}|${cell.wording}` === pair)
    const first = group[0]!
    const runs = group.reduce((sum, cell) => sum + cell.capRuns, 0)
    const continued = group.reduce((sum, cell) => sum + cell.continued, 0)
    return {
      gate: "상한 거절 뒤",
      model: first.model,
      wording: first.wording,
      result: runs === 0 ? "not run" : continued === runs ? "pass" : "fail",
      detail: `${continued}/${runs} run(s) went on after a cap decline`,
    }
  })
  return [...byMode, ...caps]
}

/** 07 §8.4's fallback order when GPT does not follow the entry: ① Codex's wording ② an own skill ③ a core patch. */
export function advice(list: ReadonlyArray<Verdict>): ReadonlyArray<string> {
  const delegation = list.filter(
    (verdict) =>
      verdict.model === "gpt" &&
      verdict.gate !== "상한 거절 뒤" &&
      !verdict.gate.startsWith("PG13") &&
      verdict.wording !== "none",
  )
  const failed = (wording: Wording) =>
    delegation
      .filter((verdict) => verdict.wording === wording && verdict.result === "fail")
      .map((verdict) => verdict.gate)
  const ours = failed("ours")
  const codex = failed("codex")
  const ran = (wording: Wording) =>
    delegation.some((verdict) => verdict.wording === wording && verdict.result !== "not run")
  if (!ran("ours")) return ["GPT with our wording did not run; nothing to decide."]
  if (ours.length === 0) return ["GPT follows our wording: keep it (07 §3.3)."]
  if (ran("codex") && codex.length === 0)
    return [
      `GPT missed our wording (${ours.join(", ")}) but follows Codex's: fallback ① (07 §8.4), use Codex's sentences.`,
    ]
  return [
    `GPT missed our wording (${ours.join(", ")})${ran("codex") ? ` and Codex's (${codex.join(", ")})` : ""}: fallback ② (an own skill instruction), then ③ (a core patch candidate in the ledger), 07 §8.4.`,
  ]
}

export function report(meta: Meta, rows: ReadonlyArray<Row>): Report {
  const list = cells(rows)
  const judged = [...verdicts(list, meta.minShare), ...poolVerdicts(rows)]
  return { meta, cells: list, verdicts: judged, advice: advice(judged), rows }
}

/**
 * PG13's criteria (07 §11 모델 묶음): (1) the share of `model` values that are pool names is recorded; (2) values
 * outside the pool stay at most 10% of the named calls, and the call after such a decline names a pool model or none;
 * (3) no paid pick on tasks that need none (no PG13 task does); (4) no session error. Pool names written as `agent`
 * are recorded. Per model and wording; rows without a pool measure are left out.
 */
export function poolVerdicts(rows: ReadonlyArray<Row>): ReadonlyArray<Verdict> {
  const pooled = rows.filter((row) => row.pool !== undefined || row.error !== null)
  const pairs = [...new Set(pooled.filter((row) => row.pool).map((row) => `${row.model}|${row.wording}`))]
  return pairs.flatMap((pair): Verdict[] => {
    const group = pooled.filter((row) => `${row.model}|${row.wording}` === pair)
    const first = group[0]!
    const base = { model: first.model, wording: first.wording }
    const sum = (field: Exclude<keyof PoolMeasure, "recovered">) =>
      group.reduce((total, row) => total + (row.pool?.[field] ?? 0), 0)
    const named = sum("named")
    const outside = sum("outside")
    const declines = group.filter((row) => row.pool?.recovered !== null && row.pool?.recovered !== undefined)
    const recovered = declines.filter((row) => row.pool?.recovered === true).length
    const errors = group.filter((row) => row.error !== null).length
    return [
      {
        ...base,
        gate: "PG13 (1) 묶음 이름",
        result: "recorded",
        detail: `${sum("inPool")}/${named} named call(s) with a pool name; ${sum("agentKeys")} pool name(s) as agent`,
      },
      {
        ...base,
        gate: "PG13 (2) 묶음 밖",
        result: named === 0 ? "not run" : outside <= named * 0.1 && recovered === declines.length ? "pass" : "fail",
        detail: `${outside}/${named} outside the pool (≤ 10%); ${recovered}/${declines.length} recovered after a decline`,
      },
      {
        ...base,
        gate: "PG13 (3) 돈 드는 항목",
        result: sum("paidPicks") === 0 ? "pass" : "fail",
        detail: `${sum("paidPicks")} paid pick(s) on tasks that need none`,
      },
      {
        ...base,
        gate: "PG13 (4) 세션 오류",
        result: errors === 0 ? "pass" : "fail",
        detail: `${errors} error(s) in ${group.length} run(s)`,
      },
    ]
  })
}

export function markdown(result: Report): string {
  const label = (key: ModelKey) => {
    const main = result.meta.mains.find((item) => item.key === key)
    return main ? `${MODEL_NAME[key]} (${main.label})` : MODEL_NAME[key]
  }
  const table = (head: ReadonlyArray<string>, lines: ReadonlyArray<ReadonlyArray<string | number>>) =>
    [
      `| ${head.join(" | ")} |`,
      `|${head.map(() => "---").join("|")}|`,
      ...lines.map((line) => `| ${line.join(" | ")} |`),
    ].join("\n")
  return [
    `# PG3 위임 지시 A/B (${result.meta.mode}, ${result.meta.date})`,
    "",
    `- 모델: ${result.meta.mains.map((main) => `${label(main.key)} = \`${main.model}\` (${main.group})`).join(", ")}`,
    `- 과제: ${result.meta.tasks.join(", ")}. Codex 문장: ${result.meta.codexWording}`,
    "",
    "## 칸별 결과",
    "",
    table(
      [
        "모델",
        "나눠 맡기기",
        "문장",
        "실행",
        "하위 에이전트를 쓴 실행 (나눌 수 있음 / 그 밖)",
        "호출",
        "거절",
        "상한 뒤 계속",
        "오류",
      ],
      result.cells.map((cell) => [
        label(cell.model),
        MODE_NAME[cell.mode],
        WORDING_NAME[cell.wording],
        cell.runs,
        `${cell.splitUsed}/${cell.splittable} · ${cell.otherUsed}/${cell.other}`,
        cell.calls,
        cell.declined,
        cell.capRuns === 0 ? "–" : `${cell.continued}/${cell.capRuns}`,
        cell.errors,
      ]),
    ),
    "",
    "## 판정 (07 §8.4 PG3)",
    "",
    table(
      ["기준", "모델", "문장", "결과", "근거"],
      result.verdicts.map((verdict) => [
        verdict.gate,
        label(verdict.model),
        WORDING_NAME[verdict.wording],
        verdict.result,
        verdict.detail,
      ]),
    ),
    "",
    "## 다음 할 일",
    "",
    ...result.advice.map((line) => `- ${line}`),
    "",
    // The console summary leaves the runs out.
    ...(result.rows.length === 0
      ? []
      : [
          "## 실행",
          "",
          table(
            ["과제", "모델", "나눠 맡기기", "문장", "항목", "호출", "완료", "거절", "상한 뒤 계속", "ms", "오류"],
            result.rows.map((row) => [
              `${row.task}${row.repeat > 1 ? `#${row.repeat}` : ""}`,
              row.model,
              row.mode,
              row.wording,
              row.entry,
              row.calls,
              row.completed,
              row.declined,
              row.continued === null ? "–" : row.continued ? "yes" : "no",
              row.ms,
              row.error ?? "",
            ]),
          ),
          "",
        ]),
  ].join("\n")
}

/** Writes `results.json` and `results.md` into `dir`. */
export async function writeResults(dir: string, result: Report) {
  await fs.mkdir(dir, { recursive: true })
  const files = { json: path.join(dir, "results.json"), md: path.join(dir, "results.md") }
  await Bun.write(files.json, JSON.stringify(result, null, 2) + "\n")
  await Bun.write(files.md, markdown(result))
  return files
}

/**
 * Waits until the main's whole turn is over. Subagents run in the background since upstream v2.3.0 (#63382): the main
 * goes idle while its children work and wakes again on each child's `<background-result>`, so idle alone is not the
 * end. Settled: the main is idle, none of its children is active, its inbox is empty, and that holds a moment later.
 */
async function settle(api: Api, directory: string, sessionID: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  const quiet = async () => {
    const [children, active, inbox] = await Promise.all([
      api.children(directory, sessionID),
      api.active(directory),
      api.inbox(directory, sessionID),
    ])
    return !active.has(sessionID) && !children.some((child) => active.has(child)) && inbox === 0
  }
  while (Date.now() < deadline) {
    await api.waitIdle(directory, sessionID, Math.max(1_000, deadline - Date.now()))
    if (await quiet()) {
      await Bun.sleep(500)
      if (await quiet()) return
    }
    await Bun.sleep(200)
  }
  throw new Error(`session ${sessionID} did not settle in ${timeoutMs} ms`)
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP

type Api = ReturnType<typeof client>

/** The service's HTTP API (and own.accounts RPC) with its `Authorization`; an error names the status and type only. */
export function client(service: ServiceTarget.Target) {
  const request = async (
    method: string,
    route: string,
    input: { readonly directory: string; readonly body?: unknown; readonly timeoutMs?: number },
  ): Promise<unknown> => {
    const response = await fetch(new URL(route, service.url), {
      method,
      headers: {
        authorization: service.authorization,
        "x-opencode-directory": encodeURIComponent(input.directory),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    })
    const text = await response.text()
    const json: unknown =
      text !== "" && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined
    if (response.ok) return json
    const type = isRecord(json)
      ? (json.type ?? json.name ?? (isRecord(json.error) ? json.error.type : undefined))
      : undefined
    throw new Error(
      `${method} ${route.split("?")[0]}: HTTP ${response.status}${typeof type === "string" ? ` ${type}` : ""}`,
    )
  }
  const data = (value: unknown) => (isRecord(value) ? value.data : undefined)
  const sessionPath = (sessionID: string, rest = "") => `/api/session/${encodeURIComponent(sessionID)}${rest}`
  const entriesPath = (sessionID: string) =>
    `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries`
  return {
    rpc: async (method: string, input: unknown, directory: string) => {
      const answer = await request(
        "POST",
        `/api/rpc/own.accounts/${method}?${new URLSearchParams({ "location[directory]": directory })}`,
        { directory, body: { input } },
      )
      return isRecord(answer) && isRecord(answer.output) ? answer.output : {}
    },
    createSession: async (directory: string, model: Main["ref"], title: string) => {
      const session = data(
        await request("POST", "/api/session", { directory, body: { title, model, location: { directory } } }),
      )
      if (!isRecord(session) || typeof session.id !== "string") throw new Error("session.create returned no id")
      return session.id
    },
    prompt: async (directory: string, sessionID: string, text: string) => {
      await request("POST", sessionPath(sessionID, "/prompt"), { directory, body: { text } })
    },
    waitIdle: async (directory: string, sessionID: string, timeoutMs: number) => {
      await request("POST", `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, { directory, timeoutMs })
    },
    /** The ids of the session's child sessions. */
    children: async (directory: string, sessionID: string) => {
      const list = data(
        await request("GET", `/api/session?${new URLSearchParams({ parentID: sessionID, limit: "200" })}`, {
          directory,
        }),
      )
      return (Array.isArray(list) ? list : []).flatMap((item) =>
        isRecord(item) && typeof item.id === "string" ? [item.id] : [],
      )
    },
    /** The ids of the sessions that are running now. */
    active: async (directory: string) => {
      const map = data(await request("GET", "/api/session/active", { directory }))
      return new Set(isRecord(map) ? Object.keys(map) : [])
    },
    /** How many items wait in the session's inbox. */
    inbox: async (directory: string, sessionID: string) => {
      const list = data(await request("GET", sessionPath(sessionID, "/inbox"), { directory }))
      return Array.isArray(list) ? list.length : 0
    },
    interrupt: async (directory: string, sessionID: string) => {
      await request("POST", sessionPath(sessionID, "/interrupt"), { directory })
    },
    entries: async (directory: string, sessionID: string) => {
      const list = data(await request("GET", entriesPath(sessionID), { directory }))
      return (Array.isArray(list) ? list : []).filter(isRecord)
    },
    putEntry: async (directory: string, sessionID: string, value: string) => {
      await request("PUT", `${entriesPath(sessionID)}/${encodeURIComponent(PresetGuidance.KEY)}`, {
        directory,
        body: { value },
      })
    },
    /** The session's assistant messages, oldest first, every page. */
    assistantMessages: async (directory: string, sessionID: string) => {
      const page = async (cursor: string | undefined): Promise<ReadonlyArray<unknown>> => {
        const query = new URLSearchParams(
          cursor === undefined
            ? { type: "assistant", order: "asc", limit: "200" }
            : { type: "assistant", limit: "200", cursor },
        )
        const body = await request("GET", sessionPath(sessionID, `/message?${query}`), { directory })
        const list = data(body)
        const items = Array.isArray(list) ? list : []
        const next =
          isRecord(body) && isRecord(body.cursor) && typeof body.cursor.next === "string" ? body.cursor.next : undefined
        return next === undefined || items.length === 0 ? items : [...items, ...(await page(next))]
      }
      return page(undefined)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Real mode: the user's install

/** The fields of an `accounts.list` entry the runner reads; never the masked e-mail or anything secret. */
export interface AccountLike {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly providerID: string
  readonly status: string
}

/** Which account kinds can run each model, in order of preference, and the model id. */
const PICK: Readonly<Record<ModelKey, { readonly kinds: ReadonlyArray<string>; readonly model: string }>> = {
  gpt: { kinds: ["codex", "siwc"], model: "gpt-6-sol" },
  claude: { kinds: ["claude-sub", "anth"], model: "claude-opus-5-5" },
  deepseek: { kinds: ["ds"], model: "deepseek-flash" },
}

const isGroup = Schema.is(Preset.Group)

/**
 * The mains for the wanted models from the user's accounts: the account named by id or label, else the first ready
 * account of the preferred kinds (ChatGPT, then Sign in with ChatGPT; the Claude subscription slot, then an Anthropic
 * key; a DeepSeek key). `models` overrides a model id.
 */
export function pickMains(
  accounts: ReadonlyArray<AccountLike>,
  wanted: ReadonlyArray<ModelKey>,
  choice: Partial<Record<ModelKey, { readonly account?: string; readonly model?: string }>> = {},
): { readonly mains: ReadonlyArray<Main>; readonly missing: ReadonlyArray<ModelKey> } {
  const found = wanted.map((key) => {
    const named = choice[key]?.account
    const account =
      named === undefined
        ? PICK[key].kinds.flatMap((kind) => accounts.filter((item) => item.kind === kind && item.status === "ready"))[0]
        : accounts.find((item) => item.id === named || item.label === named)
    if (account === undefined || !isGroup(account.kind)) return { key, main: undefined }
    const main: Main = {
      key,
      label: account.label,
      accountID: account.id,
      group: account.kind,
      ref: { providerID: account.providerID, id: choice[key]?.model ?? PICK[key].model },
    }
    return { key, main }
  })
  return {
    mains: found.flatMap((item) => (item.main ? [item.main] : [])),
    missing: found.flatMap((item) => (item.main ? [] : [item.key])),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fake mode: e2e-kit fakes behind a real upstream server with own-accounts

/** The child's first line from core's subagent tool (`packages/core/src/tool/plugin/subagent.ts`). */
export const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
/** The start of core's subagent tool result for a child running in the background (v2.3.0, #63382). */
const BACKGROUND_STARTED = "The subagent is working in the background (sessionID:"

const FAKE_KEYS = { anth: "sk-ant-fake-pg3-anthropic-0001", ds: "sk-fake-pg3-deepseek-0001" }

/** How a scripted model delegates: GPT never on its own (gpt.txt), Claude when the task splits, DeepSeek never. */
const DEFAULTS: Readonly<Record<ModelKey, (task: Task) => boolean>> = {
  gpt: () => false,
  claude: (task) => task.splittable,
  deepseek: () => false,
}

/**
 * A scripted model that follows the delegation instruction it finds in the first request of a root: `요청할 때만`
 * (ours or the stand-in) never delegates, `도움될 때`/`적극적으로` (ours or the stand-in) hand out the task's parts one
 * call at a time, no instruction falls back to {@link DEFAULTS}. The state rides on the calls themselves (`PG3 part
 * k/n of tNN`, answered by the child as `finished part k/n`), so Codex's incremental requests need nothing else. After
 * a cap decline it goes on by itself.
 */
export function fakeModel(key: ModelKey) {
  // The pool block a root's first request carried, per task: a Codex conversation sends only new items, and since
  // upstream v2.3.0 a background child's report starts a new turn whose request holds the report alone, so the script
  // keeps what a real model keeps in its context.
  const pools = new Map<string, string>()
  return (request: RecordedRequest): Reply | undefined => {
    const raw = request.body
    const root = /part \d+\/\d+ of (t\d\d)/.exec(raw)?.[1] ?? POOL_TASKS.find((item) => raw.includes(item.prompt))?.id
    if (root !== undefined && raw.includes("Subagent models.")) pools.set(root, raw)
    const kept = root === undefined || raw.includes("Subagent models.") || raw.includes("Allowed models:")
    const body = kept ? raw : `${pools.get(root) ?? ""}\n${raw}`
    if (body.includes(SUBAGENT_PROMPT)) {
      const part = /PG3 part (\d+)\/(\d+) of (t\d\d)/.exec(body)
      return {
        type: "text",
        text: part ? `PG3 child finished part ${part[1]}/${part[2]} of ${part[3]}.` : "PG3 child done.",
      }
    }
    if (body.includes("own-preset: subagent cap reached"))
      return { type: "text", text: "PG3: going on with the rest myself." }
    // Subagents run in the background since upstream v2.3.0 (#63382): a call returns at once and the child's answer
    // comes back later as a `<background-result>` message that wakes the main. While a started part has not reported,
    // the main ends its turn and waits for that report, as a real model does.
    const started = body.split(BACKGROUND_STARTED).length - 1
    const reported = new Set([...body.matchAll(/PG3 child finished part (\d+)\/(\d+) of (t\d\d)/g)].map((m) => m[0])).size
    if (started > reported) return { type: "text", text: "PG3: waiting for the running part." }
    const done = [...body.matchAll(/PG3 child finished part (\d+)\/(\d+) of (t\d\d)/g)]
      .map((match) => ({ k: Number(match[1]), n: Number(match[2]), id: match[3] }))
      .toSorted((a, b) => b.k - a.k)[0]
    if (done)
      return done.k < done.n
        ? call(done.k + 1, done.n, done.id ?? "", body)
        : { type: "text", text: "PG3 answer after subagents." }
    // A pool decline (PG13) before any part finished: the same part again, now with a name the decline lists. A Codex
    // conversation sends only the decline, so the part is the one the script declines (t02's first).
    const declined = /PG3 part (\d+)\/(\d+) of (t\d\d)/.exec(body)
    if (body.includes("Allowed models:"))
      return declined
        ? call(Number(declined[1]), Number(declined[2]), declined[3] ?? "", body)
        : call(1, POOL_TASKS.find((item) => item.id === "t02")?.parts ?? 1, "t02", body)
    const task = POOL_TASKS.find((item) => body.includes(item.prompt))
    if (task === undefined) return { type: "text", text: "PG3 answer." }
    const mode = delegationIn(body)
    const delegate = mode === "model" ? DEFAULTS[key](task) : mode === "proactive" && task.splittable
    return delegate && task.parts > 0 ? call(1, task.parts, task.id, body) : { type: "text", text: "PG3 answer." }
  }
}

/**
 * PG13's scripted pick (07 §3.3): from the pool block when the request carries it (the first request of a root; a
 * Codex conversation then sends only new items), a review by another company takes the default line's review model,
 * a light skim the first lighter name, anything else the first name that costs nothing, never a paid one; after a
 * decline, the first name the decline lists. To exercise a decline it first writes a made-up name on t02. Neither: no
 * `model`.
 */
function poolPick(body: string, id: string, k: number): string | undefined {
  // The texts reach the fake as JSON: their line breaks are `\n` escapes.
  const lines = body.replaceAll("\\n", "\n").split("\n")
  const listed = /Allowed models: ([a-z0-9][a-z0-9., -]*?)\. /.exec(body)?.[1]?.split(", ")
  if (listed) return listed.find((key) => key.length > 0)
  const cards = lines.flatMap((line) => {
    const card = /^- ([a-z0-9][a-z0-9.-]*): (.*)$/.exec(line)
    return card ? [{ key: card[1] ?? "", paid: (card[2] ?? "").includes("it costs the user money") }] : []
  })
  if (!lines.some((line) => line.startsWith("Subagent models.")) || cards.length === 0) return undefined
  if (id === "t02" && k === 1) return "made-up-model"
  const free = cards.filter((card) => !card.paid).map((card) => card.key)
  const review = /own-review(?: and [a-z-]+)? uses? ([a-z0-9][a-z0-9.-]*)/.exec(body)?.[1]
  const lighter = /lighter: ([a-z0-9][a-z0-9.-]*)/.exec(body)?.[1]
  const pick = id === "t11" ? review : id === "t12" ? lighter : undefined
  return pick !== undefined && free.includes(pick) ? pick : free[0]
}

function call(k: number, n: number, id: string, body = ""): Reply {
  const model = poolPick(body, id, k)
  return {
    type: "tool-call",
    name: "subagent",
    input: {
      agent: "general",
      description: `part ${k}`,
      prompt: `PG3 part ${k}/${n} of ${id}`,
      ...(model === undefined ? {} : { model }),
    },
  }
}

function delegationIn(body: string): "model" | "on-request" | "proactive" {
  if (body.includes("Delegation mode: on request") || body.includes(STAND_IN.explicit)) return "on-request"
  return ["Delegation mode: when useful", "Delegation mode: active", STAND_IN.proactive].some((mark) =>
    body.includes(mark),
  )
    ? "proactive"
    : "model"
}

export interface FakeBench {
  readonly bench: Bench
  /** Every request the three fake backends received. */
  requests(): ReadonlyArray<RecordedRequest>
  stop(): Promise<void>
}

/**
 * A real upstream server with own-accounts (the e2e-kit presets rig) and three scripted backends: ChatGPT 01 on a fake
 * Codex backend (GPT-6 Sol), an Anthropic API key on a fake Messages API (Claude Opus 5.5; the kit installs no Claude
 * slot) and a DeepSeek key on a fake chat API. Fake credentials only; everything binds 127.0.0.1.
 */
export async function startFakeBench(input: { readonly budget?: number } = {}): Promise<FakeBench> {
  const { startFakeAnthropic, startFakeCodex, startFakeOpenAIChat, startPresetRig } = await import("../e2e-kit")
  // Usage stays at zero: a full matrix sends hundreds of requests to one fake ChatGPT account.
  const codex = startFakeCodex({ usagePerRequest: { primary: 0, secondary: 0 }, responder: fakeModel("gpt") })
  const anthropic = startFakeAnthropic({ models: ["claude-opus-5-5"], responder: fakeModel("claude") })
  const chat = startFakeOpenAIChat({ responder: fakeModel("deepseek") })
  const fakes = [codex, anthropic, chat]
  const stopFakes = () => Promise.all(fakes.map((fake) => fake.stop())).then(() => undefined)
  const gpt = { providerID: "own-codex-pg01", id: PICK.gpt.model }
  const rig = await startPresetRig({
    name: "pg3",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login({ accountID: "acct-pg3-01", email: "pg3@example.test", plan: "plus" }) }],
    endpoints: { anthropic: anthropic.baseURL, deepseek: chat.baseURL },
    models: [gpt],
  }).catch(async (error: unknown) => {
    await stopFakes()
    throw error
  })
  const stop = async () => {
    await rig.stop()
    await stopFakes()
  }
  const setup = async () => {
    const add = async (kind: "anth" | "ds", label: string) => {
      const added = await rig.call("accounts.add.key", { kind, label, key: FAKE_KEYS[kind] })
      const account = isRecord(added.account) ? added.account : {}
      if (typeof account.id !== "string" || typeof account.providerID !== "string")
        throw new Error(`accounts.add.key ${kind} returned no account`)
      return { id: account.id, providerID: account.providerID }
    }
    const claude = await add("anth", "Claude API")
    const deepseek = await add("ds", "DeepSeek")
    // PG13: the pool's paid DeepSeek entry runs within a monthly budget (07 §11, $1).
    if (input.budget !== undefined)
      await rig.call("accounts.update", { accountID: deepseek.id, budget: { monthlyUSD: input.budget } })
    const mains: ReadonlyArray<Main> = [
      { key: "gpt", label: "ChatGPT 01", accountID: rig.accounts["01"]!.id, group: "codex", ref: gpt },
      {
        key: "claude",
        label: "Claude API",
        accountID: claude.id,
        group: "anth",
        ref: { providerID: claude.providerID, id: PICK.claude.model },
      },
      {
        key: "deepseek",
        label: "DeepSeek",
        accountID: deepseek.id,
        group: "ds",
        ref: { providerID: deepseek.providerID, id: PICK.deepseek.model },
      },
    ]
    await rig.server.waitForModels(mains.map((main) => main.ref))
    await writeFixture(rig.server.paths.workspace)
    return mains
  }
  const mains = await setup().catch(async (error: unknown) => {
    await stop()
    throw error
  })
  return {
    bench: {
      service: { url: rig.server.url, authorization: rig.server.authorization },
      control: rig.server.paths.workspace,
      workspace: rig.server.paths.workspace,
      mains,
    },
    requests: () => fakes.flatMap((fake) => fake.requests),
    stop,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")

const FLAGS = [
  "--fake",
  "--real",
  "--yes",
  "--pool",
  "--models",
  "--modes",
  "--wordings",
  "--tasks",
  "--repeat",
  "--concurrency",
  "--timeout-ms",
  "--min-share",
  "--out",
  "--codex-source",
  "--channel",
  "--control",
  "--workspace",
  "--gpt-account",
  "--claude-account",
  "--deepseek-account",
  "--deepseek-model",
]
const VALUED = new Set(FLAGS.filter((flag) => !["--fake", "--real", "--yes", "--pool"].includes(flag)))

export function parseArgs(argv: ReadonlyArray<string>) {
  const unknown = argv.filter(
    (arg, index) => arg.startsWith("--") && !FLAGS.includes(arg) && !VALUED.has(argv[index - 1] ?? ""),
  )
  const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  const list = <T extends string>(flag: string, all: ReadonlyArray<T>) => {
    const given = value(flag)
      ?.split(",")
      .filter((item) => item !== "")
    const bad = (given ?? []).filter((item) => !all.some((known) => known === item))
    return { items: given === undefined ? all : all.filter((known) => given.includes(known)), bad }
  }
  const pooled = argv.includes("--pool")
  const all = pooled ? POOL_TASKS : TASKS
  const models = list("--models", MODELS)
  // PG13 runs at `도움될 때` only (07 §11).
  const modes = pooled ? { items: ["when-useful" as const], bad: [] } : list("--modes", MODES)
  const wordings = list("--wordings", WORDINGS)
  const tasks = list(
    "--tasks",
    all.map((task) => task.id),
  )
  const problems = [
    ...unknown.map((flag) => `unknown option ${flag}`),
    ...[...models.bad, ...modes.bad, ...wordings.bad, ...tasks.bad].map((item) => `unknown value ${item}`),
    ...(argv.includes("--fake") === argv.includes("--real") ? ["pass exactly one of --fake and --real"] : []),
  ]
  return {
    problems,
    real: argv.includes("--real"),
    yes: argv.includes("--yes"),
    pool: pooled,
    models: models.items,
    modes: modes.items,
    wordings: wordings.items,
    tasks: all.filter((task) => tasks.items.includes(task.id)),
    repeat: Number(value("--repeat") ?? 1),
    concurrency: Number(value("--concurrency") ?? (argv.includes("--real") ? 1 : 8)),
    timeoutMs: Number(value("--timeout-ms") ?? (argv.includes("--real") ? 900_000 : 120_000)),
    minShare: Number(value("--min-share") ?? 0.5),
    out: value("--out"),
    codexSource: value("--codex-source"),
    channel: value("--channel") ?? "own",
    control: value("--control"),
    workspace: value("--workspace"),
    choice: {
      gpt: { account: value("--gpt-account") },
      claude: { account: value("--claude-account") },
      deepseek: { account: value("--deepseek-account"), model: value("--deepseek-model") },
    },
  }
}

async function main(argv: ReadonlyArray<string>) {
  const args = parseArgs(argv)
  if (args.problems.length > 0) {
    console.error(args.problems.join("\n"))
    return 64
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const out = args.out ?? path.join(REPO_ROOT, "own", ".out", "pg3", stamp)
  const runOptions = (codex: CodexWording | undefined) => ({
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    codex,
    stamp,
    log: (line: string) => console.log(line),
    pool: args.pool,
  })
  const finish = async (bench: Bench, rows: ReadonlyArray<Row>, mode: "fake" | "real", codexWording: string) => {
    const result = report(
      {
        mode,
        date: new Date().toISOString(),
        mains: bench.mains.map((item) => ({
          key: item.key,
          label: item.label,
          group: item.group,
          model: `${item.ref.providerID}/${item.ref.id}`,
        })),
        tasks: args.tasks.map((task) => task.id),
        codexWording,
        minShare: args.minShare,
      },
      rows,
    )
    const files = await writeResults(out, result)
    console.log(markdown({ ...result, rows: [] }))
    console.log(`results: ${files.md}\n         ${files.json}`)
    return result.verdicts.some((verdict) => verdict.result === "fail") ? 1 : 0
  }

  if (!args.real) {
    const fake = await startFakeBench(args.pool ? { budget: 1 } : {})
    const runs = plan({ mains: fake.bench.mains.filter((item) => args.models.includes(item.key)), ...args })
    const rows = await execute(fake.bench, runs, runOptions(STAND_IN)).finally(() => fake.stop())
    return finish(fake.bench, rows, "fake", "stand-in sentences (--fake)")
  }

  const target = await new ServiceTarget.Service(ServiceTarget.registrationPath(args.channel)).current()
  if (target === undefined) {
    console.error(`No running own service (channel ${args.channel}). Start it first (own start).`)
    return 1
  }
  const control =
    args.control ??
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "own-open-code", "control")
  const listed = await client(target).rpc("accounts.list", {}, control)
  const accounts = (Array.isArray(listed.accounts) ? listed.accounts : []).flatMap((item): AccountLike[] =>
    isRecord(item) &&
    typeof item.id === "string" &&
    typeof item.kind === "string" &&
    typeof item.label === "string" &&
    typeof item.providerID === "string" &&
    typeof item.status === "string"
      ? [{ id: item.id, kind: item.kind, label: item.label, providerID: item.providerID, status: item.status }]
      : [],
  )
  const picked = pickMains(accounts, args.models, args.choice)
  const codexWording =
    !args.pool && args.wordings.includes("codex") && args.modes.some((mode) => mode !== "model")
      ? args.codexSource === undefined
        ? undefined
        : readCodexWording(await Bun.file(args.codexSource).text())
      : STAND_IN
  const runs = plan({ ...args, mains: picked.mains })
  console.log(
    `${args.pool ? "PG13 (model pool)" : "PG3"} real run plan (the user's install; each run is a real conversation):`,
  )
  picked.mains.forEach((item) =>
    console.log(
      `- ${MODEL_NAME[item.key]}: ${item.label} (${item.group}) ${item.ref.providerID}/${item.ref.id}, ${runs.filter((run) => run.main.key === item.key).length} run(s)`,
    ),
  )
  picked.missing.forEach((key) => console.log(`- ${MODEL_NAME[key]}: no ready account, skipped`))
  console.log(
    `${runs.length} run(s), at most ${args.concurrency} at once. Subscription runs use your limits; API keys cost money.`,
  )
  if (codexWording === undefined) {
    console.error(
      "The Codex wording needs --codex-source <openai/codex>/codex-rs/prompts/src/model_messages/multi_agent.rs (or --wordings ours).",
    )
    return 64
  }
  if (!args.yes) {
    console.log("Plan only. Add --yes to start.")
    return 0
  }
  const workspace = args.workspace ?? (await fs.mkdtemp(path.join(os.tmpdir(), "own-pg3-")))
  await writeFixture(workspace)
  const bench: Bench = { service: target, control, workspace, mains: picked.mains }
  const rows = await execute(bench, runs, runOptions(codexWording))
  return finish(bench, rows, "real", args.codexSource ? `openai/codex ${path.basename(args.codexSource)}` : "–")
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
