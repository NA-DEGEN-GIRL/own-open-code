// G7 한도 수집 (01 §16.1, AC-P15; P0-3a in own/reports/external-repos-2026-10-05.md). With the opt-in wire evidence
// capture on (02 §7.8, shape mode) the script sends a few one-word turns on each own-slot account of the user's own
// service and writes the evidence: whether every Codex request brought its usage (HTTP `x-codex-*` headers, WebSocket
// `codex.rate_limits` frames), the API keys' `x-ratelimit-*` headers, and every response header name per account kind,
// request kind and transport, marking the names own's LastResponse does not keep yet (AC-P15 "미확인 헤더 이름").
// Anthropic accounts and the Claude slot are not part of this script.
//
//   bun own/scripts/gates/g7.ts               # the plan only: accounts, models and turns (reads accounts.list, no turn)
//   bun own/scripts/gates/g7.ts --yes         # the turns on the user's install (user-run; subscriptions use their
//                                             # limits, API keys cost a little)
//   bun own/scripts/gates/g7.ts --self-test   # against the e2e-kit fakes behind a real upstream server on 127.0.0.1
//   options: --account <id or label>[,…] (default every ready own-slot account but Anthropic), --model <kind=id,…>
//            (default each group's new-conversation model), --turns N (default 2), --timeout-ms N (per turn, default
//            300000), --channel own, --control DIR, --workspace DIR, --replace (end a running capture window), --out DIR
// The capture window covers only the picked slots and is stopped when the script ends, also on failure. Each account
// gets a new session in read-only approval. Evidence: own/.out/gates/<time>-g7/evidence.{json,md} (ignored by git).
// Exit: 0 done and no must failed (self-test: passed), 1 failed, 64 usage error.

import { parseArgs } from "node:util"
import {
  KINDS,
  PROMPT,
  census,
  client,
  fakeBench,
  installed,
  limits,
  modelsOf,
  outDir,
  pick,
  readLines,
  secretsOf,
  tables,
  verdictLines,
  writeEvidence,
  type Account,
  type Api,
  type CensusRow,
  type LimitRow,
  type Line,
  type Verdict,
  type Window,
} from "./gate"

const USAGE =
  "usage: bun own/scripts/gates/g7.ts [--yes | --self-test] [--account <id or label>,…] [--model <kind=id>,…] [--turns N] [--timeout-ms N] [--channel own] [--control DIR] [--workspace DIR] [--replace] [--out DIR]"

const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        yes: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        account: { type: "string" },
        model: { type: "string" },
        turns: { type: "string", default: "2" },
        "timeout-ms": { type: "string", default: "300000" },
        channel: { type: "string", default: "own" },
        control: { type: "string" },
        workspace: { type: "string" },
        replace: { type: "boolean", default: false },
        out: { type: "string" },
      },
    }).values,
).catch((error: unknown) => usage(error instanceof Error ? error.message : String(error)))
const turns = whole(args.turns) ?? usage("--turns takes a whole number from 1")
const timeoutMs = whole(args["timeout-ms"]) ?? usage("--timeout-ms takes a whole number of milliseconds")
const models = modelsOf(args.model) ?? usage("--model takes kind=id pairs such as codex=gpt-5.5,ds=deepseek-flash")
const named = (args.account ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item !== "")

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  return process.exit(64)
}

function whole(value: string) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? number : undefined
}

// ---------------------------------------------------------------------------------------------------------------

/** One account and the model its turns use. */
interface Run {
  readonly account: Account
  readonly model: { readonly providerID: string; readonly id: string }
}

/** What one account's turns did. */
interface Row {
  readonly label: string
  readonly kind: string
  readonly providerID: string
  readonly model: string
  readonly sessionID: string | null
  readonly turns: number
  readonly ms: number
  readonly error: string | null
}

/** Runs every account's turns inside one capture window and returns the rows and the ended window. */
async function drive(
  api: Api,
  runs: ReadonlyArray<Run>,
  input: { readonly turns: number; readonly timeoutMs: number },
) {
  const minutes = Math.min(1_440, Math.ceil((runs.length * input.turns * input.timeoutMs) / 60_000) + 5)
  await api.capture.start({ mode: "shape", minutes, providerIDs: runs.map((run) => run.model.providerID) })
  const rows = await runs
    .reduce<Promise<ReadonlyArray<Row>>>(
      async (done, run) => [...(await done), await one(api, run, input)],
      Promise.resolve([]),
    )
    .catch(async (error: unknown) => {
      // The window must not outlive the script.
      await api.capture.stop().catch(() => undefined)
      throw error
    })
  const stopped = await api.capture.stop()
  if (!stopped.window) throw new Error("diagnostics.capture.stop returned no window")
  return { rows, window: stopped.window }
}

async function one(api: Api, run: Run, input: { readonly turns: number; readonly timeoutMs: number }): Promise<Row> {
  const started = Date.now()
  const base = {
    label: run.account.label,
    kind: run.account.kind,
    providerID: run.model.providerID,
    model: run.model.id,
  }
  const failed = (sessionID: string | null, count: number) => async (error: unknown) => {
    // A turn that timed out may still be working; stop it so it spends nothing more.
    if (sessionID !== null) await api.interrupt(sessionID).catch(() => undefined)
    return {
      ...base,
      sessionID,
      turns: count,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const sessionID = await api.createSession(run.model, `G7 · ${run.account.label}`).catch(() => null)
  if (sessionID === null) return failed(null, 0)(new Error("session.create failed"))
  const turn = async (index: number): Promise<Row> => {
    if (index >= input.turns) return { ...base, sessionID, turns: index, ms: Date.now() - started, error: null }
    await api.prompt(sessionID, PROMPT)
    await api.waitIdle(sessionID, input.timeoutMs)
    return turn(index + 1)
  }
  return api
    .readOnly(sessionID)
    .then(() => turn(0))
    .catch(failed(sessionID, 0))
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence

interface Evidence {
  readonly gate: "G7"
  readonly ac: "AC-P15"
  readonly mode: "real" | "self-test"
  readonly date: string
  readonly capture: Omit<Window, "dir">
  readonly runs: ReadonlyArray<Row>
  readonly verdicts: ReadonlyArray<Verdict>
  readonly limits: ReadonlyArray<LimitRow>
  readonly census: ReadonlyArray<CensusRow>
  /** Response header names own's LastResponse does not keep, over every kind (AC-P15). */
  readonly unknownNames: ReadonlyArray<string>
}

function evidenceOf(input: {
  readonly mode: Evidence["mode"]
  readonly window: Window
  readonly rows: ReadonlyArray<Row>
  readonly lines: ReadonlyArray<Line>
}): Evidence {
  const limitRows = limits(input.lines)
  const censusRows = census(input.lines)
  const unknownNames = [
    ...new Set(
      censusRows
        .filter((row) => row.event === "response")
        .flatMap((row) => row.names.filter((item) => !item.kept).map((item) => item.name)),
    ),
  ].toSorted()
  return {
    gate: "G7",
    ac: "AC-P15",
    mode: input.mode,
    date: new Date().toISOString(),
    capture: {
      id: input.window.id,
      mode: input.window.mode,
      startedAt: input.window.startedAt,
      until: input.window.until,
      end: input.window.end,
      records: input.window.records,
      dropped: input.window.dropped,
      steps: input.window.steps,
      files: input.window.files,
    },
    runs: input.rows,
    verdicts: verdicts(input.window, input.rows, limitRows, unknownNames),
    limits: limitRows,
    census: censusRows,
    unknownNames,
  }
}

function verdicts(
  window: Window,
  rows: ReadonlyArray<Row>,
  limitRows: ReadonlyArray<LimitRow>,
  unknownNames: ReadonlyArray<string>,
): ReadonlyArray<Verdict> {
  const codex = limitRows.filter((row) => row.accountKind === "codex")
  const keys = limitRows.filter((row) => row.accountKind !== "codex")
  const failedRuns = rows.filter((row) => row.error !== null)
  return [
    window.records === 0
      ? {
          check: "capture",
          result: "fail",
          detail: `the window recorded nothing over ${window.steps} own-slot step(s): see the capture_empty alert (plugins blocked, hook order)`,
        }
      : {
          check: "capture",
          result: "info",
          detail: `${window.records} line(s), ${window.dropped} dropped, ${window.steps} own-slot step(s)`,
        },
    ...(failedRuns.length === 0
      ? []
      : [
          {
            check: "turns",
            result: "fail" as const,
            detail: failedRuns.map((row) => `${row.label}: ${row.error}`).join("; "),
          },
        ]),
    codex.length === 0
      ? { check: "Codex usage on every request", result: "not-run", detail: "no Codex request was captured" }
      : codex.every((row) => row.requests > 0 && row.withLimits === row.requests)
        ? {
            check: "Codex usage on every request",
            result: "pass",
            detail: codex.map((row) => `${row.transport} ${row.withLimits}/${row.requests}`).join(", "),
          }
        : {
            check: "Codex usage on every request",
            result: "fail",
            detail: `${codex.map((row) => `${row.transport} ${row.withLimits}/${row.requests}`).join(", ")}; 01 §16.1 fallback: P-005 or the HTTP transport`,
          },
    ...(codex.length > 0 && !codex.some((row) => row.transport === "ws")
      ? [{ check: "Codex WebSocket path", result: "not-run" as const, detail: "no WebSocket request was captured" }]
      : []),
    ...keys.map((row) => ({
      check: `${row.accountKind} limit headers`,
      result: "info" as const,
      detail: `${row.providerID} ${row.transport}: ${row.withLimits}/${row.requests} response(s) with x-ratelimit-*/x-codex-*${row.sources.length > 0 ? ` (${row.sources.join(", ")})` : ""}`,
    })),
    {
      check: "response header names LastResponse does not keep",
      result: "info",
      detail: unknownNames.length === 0 ? "none" : unknownNames.join(", "),
    },
  ]
}

function markdown(evidence: Evidence) {
  return [
    `# G7 한도 수집 (AC-P15), ${evidence.mode}`,
    "",
    `- 날짜: ${evidence.date}`,
    `- 수집 창: ${evidence.capture.id} (${evidence.capture.mode}), 줄 ${evidence.capture.records}, 버림 ${evidence.capture.dropped}, step ${evidence.capture.steps}`,
    "",
    "## 판정",
    "",
    ...verdictLines(evidence.verdicts),
    "",
    "## 실행",
    "",
    "| 계정 | kind | slot | 모델 | 턴 | ms | 오류 |",
    "|---|---|---|---|---|---|---|",
    ...evidence.runs.map(
      (row) =>
        `| ${row.label} | ${row.kind} | ${row.providerID} | ${row.model} | ${row.turns} | ${row.ms} | ${row.error ?? "–"} |`,
    ),
    "",
    ...tables({ limits: evidence.limits, census: evidence.census }),
  ].join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Modes

async function plan() {
  const bench = await installed({
    channel: args.channel,
    control: args.control,
    workspace: args.workspace,
    fresh: false,
  })
  if (bench === undefined) return noService()
  const api = client(bench)
  const runs = await runsOf(api)
  if (runs === undefined) return 1
  console.log(`G7 plan (the user's install, channel ${args.channel}): ${turns} one-word turn(s) per account.`)
  runs.forEach((run) =>
    console.log(`- ${run.account.label} (${run.account.kind}) ${run.model.providerID}/${run.model.id}`),
  )
  console.log(
    `${runs.length * turns} turn(s) plus title requests. Subscriptions use their limits; API keys cost a little (own's prompt is about 10–20K input tokens per turn).`,
  )
  console.log("Plan only. Add --yes to start.")
  return 0
}

async function live() {
  const bench = await installed({
    channel: args.channel,
    control: args.control,
    workspace: args.workspace,
    fresh: true,
  })
  if (bench === undefined) return noService()
  const api = client(bench)
  const runs = await runsOf(api)
  if (runs === undefined) return 1
  if (runs.length === 0) {
    console.error("No account to drive.")
    return 1
  }
  const running = await api.capture.status()
  if (running.active && !args.replace) {
    console.error(`A capture window runs (${running.window?.id}); end it first (g8.ts --collect) or pass --replace.`)
    return 1
  }
  const result = await drive(api, runs, { turns, timeoutMs })
  const evidence = evidenceOf({
    mode: "real",
    window: result.window,
    rows: result.rows,
    lines: await readLines(result.window),
  })
  const files = await writeEvidence(outDir("g7", args.out), evidence, markdown(evidence), secretsOf(bench.service))
  console.log(verdictLines(evidence.verdicts).join("\n"))
  console.log(`evidence: ${files.md}\n          ${files.json}`)
  return evidence.verdicts.some((item) => item.result === "fail") ? 1 : 0
}

/** The picked accounts with their models; `undefined` (after a message) when a name or a model is missing. */
async function runsOf(api: Api): Promise<ReadonlyArray<Run> | undefined> {
  const accounts = await api.accounts()
  const picked = pick(accounts, named, KINDS)
  if (picked.missing.length > 0) {
    console.error(`No own-slot account (Anthropic aside) named ${picked.missing.join(", ")}.`)
    return undefined
  }
  const defaults = await api.defaults()
  const runs = picked.picked.map((account) => ({
    account,
    id: models.get(account.kind) ?? defaults.get(account.kind),
  }))
  const unknown = runs.filter((run) => run.id === undefined)
  if (unknown.length > 0) {
    console.error(
      `No default model for ${[...new Set(unknown.map((run) => run.account.kind))].join(", ")}; pass --model <kind=id>.`,
    )
    return undefined
  }
  return runs.map((run) => ({ account: run.account, model: { providerID: run.account.providerID, id: run.id ?? "" } }))
}

function noService() {
  console.error(`No running own service (channel ${args.channel}). Start it first (own start).`)
  return 1
}

/** Two turns on a fake ChatGPT account (WebSocket) and on a fake DeepSeek key, then checks of the evidence. */
async function selfTest() {
  const fake = await fakeBench("g7")
  const checks: Array<readonly [string, boolean]> = []
  const check = (name: string, ok: boolean) => checks.push([name, ok])
  const run = async () => {
    const api = client(fake.bench)
    const accounts = await api.accounts()
    const runs = accounts.flatMap((account): Run[] =>
      account.kind === "codex" || account.kind === "ds"
        ? [
            {
              account,
              model: { providerID: account.providerID, id: account.kind === "codex" ? "gpt-6-sol" : "deepseek-flash" },
            },
          ]
        : [],
    )
    check("two accounts to drive", runs.length === 2)
    // The real mode's pick: every ready own-slot account with its group's new-conversation model (presets.list).
    const picked = await runsOf(api)
    check(
      "the real mode picks both accounts with a default model",
      picked?.length === 2 && picked.every((item) => item.model.id !== ""),
    )
    const result = await drive(api, runs, { turns: 2, timeoutMs: 120_000 })
    check(
      "every turn ended",
      result.rows.every((row) => row.error === null && row.turns === 2),
    )
    check("the window ended as stopped", result.window.end === "stopped" && !(await api.capture.status()).active)
    const lines = await readLines(result.window)
    const evidence = evidenceOf({ mode: "self-test", window: result.window, rows: result.rows, lines })
    const ws = evidence.limits.find((row) => row.accountKind === "codex" && row.transport === "ws")
    check(
      "Codex WebSocket requests each brought codex.rate_limits",
      !!ws && ws.requests >= 2 && ws.withLimits === ws.requests,
    )
    check(
      "the Codex verdict passes",
      evidence.verdicts.some((item) => item.check === "Codex usage on every request" && item.result === "pass"),
    )
    check(
      "DeepSeek HTTP responses are in the census with their header names",
      evidence.census.some(
        (row) =>
          row.accountKind === "ds" &&
          row.transport === "http" &&
          row.names.some((item) => item.name === "content-type"),
      ),
    )
    check(
      "the Codex handshake header names are in the census",
      evidence.census.some(
        (row) => row.event === "handshake" && row.names.some((item) => item.name === "chatgpt-account-id"),
      ),
    )
    check("no must failed", !evidence.verdicts.some((item) => item.result === "fail"))
    const files = await writeEvidence(outDir("g7-self-test", args.out), evidence, markdown(evidence), [
      ...secretsOf(fake.bench.service),
      ...fake.secrets,
    ])
    const written = (await Bun.file(files.json).text()) + (await Bun.file(files.md).text())
    check(
      "no credential in the evidence",
      [...secretsOf(fake.bench.service), ...fake.secrets].every((secret) => !written.includes(secret)),
    )
    console.log(`evidence: ${files.md}`)
  }
  await run().finally(() => fake.stop())
  checks.forEach((item) => console.log(`${item[1] ? "ok  " : "FAIL"} ${item[0]}`))
  const failed = checks.filter((item) => !item[1]).length
  console.log(
    failed === 0 ? `self-test ok: ${checks.length}/${checks.length} checks` : `self-test FAILED: ${failed} check(s)`,
  )
  return failed === 0 ? 0 : 1
}

const code = await (args["self-test"] ? selfTest() : args.yes ? live() : plan()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  return 1
})
process.exit(code)
