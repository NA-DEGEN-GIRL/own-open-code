// G8 retry 제어 (01 §16.1, AC-P17a; P0-3a in own/reports/external-repos-2026-10-05.md): the real shapes of
// exhaustion and failure answers and what own's retry hook decided, from the opt-in wire evidence capture (02 §7.8,
// shape mode). A real exhaustion cannot be provoked on purpose, so there are two ways in:
//   watch    a long capture window (default a day) over every own slot while the user works as usual. --collect ends
//            it and writes the evidence: each distinct error body, failure event and failure frame shape (HTTP, HTTP
//            stream, WebSocket), and the retry hook's verdicts and decisions with core's error type and status.
//   drive    one one-word turn on an account the user knows is exhausted (--account): the turn's duration against the
//            must "{retry:false} ends the turn within 30 s" for the path it took, with the same evidence.
// The x-should-retry part (AC-P24), switchModel on the retry path (AC-P17b) and the Claude slot are not part of it.
//
//   bun own/scripts/gates/g8.ts                                # the plan only
//   bun own/scripts/gates/g8.ts --watch [--minutes 1440]       # start the window and return (no model request)
//   bun own/scripts/gates/g8.ts --collect                      # end the running window (or read the last one ended)
//   bun own/scripts/gates/g8.ts --account <id or label> --yes  # drive one turn (an account that is not exhausted
//                                                              # answers normally and uses a little quota or money)
//   bun own/scripts/gates/g8.ts --self-test                    # an exhausted fake ChatGPT account behind a real
//                                                              # upstream server on 127.0.0.1, then watch and collect
//   options: --model <id> (default the account group's new-conversation model), --timeout-ms N (default 120000),
//            --channel own, --control DIR, --workspace DIR, --replace (end a running capture window), --out DIR
// A window lives in the service process: --collect after a service restart finds nothing (the files stay 7 days under
// <OWN_HOME>\diagnostics\captures). Evidence: own/.out/gates/<time>-g8/evidence.{json,md} (ignored by git).
// Exit: 0 done and no must failed (self-test: passed), 1 failed, 64 usage error.

import { parseArgs } from "node:util"
import {
  KINDS,
  PROMPT,
  client,
  failures,
  fakeBench,
  installed,
  outDir,
  pick,
  readLines,
  retries,
  secretsOf,
  tables,
  verdictLines,
  writeEvidence,
  type Account,
  type Api,
  type FailureShape,
  type Line,
  type RetryRow,
  type Verdict,
  type Window,
} from "./gate"

/** 01 §16.1 G8 must: a hard exhaustion ends the turn within this. */
const MUST_MS = 30_000

const USAGE =
  "usage: bun own/scripts/gates/g8.ts [--watch [--minutes N] | --collect | --account <id or label> --yes | --self-test] [--model <id>] [--timeout-ms N] [--channel own] [--control DIR] [--workspace DIR] [--replace] [--out DIR]"

const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        yes: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        watch: { type: "boolean", default: false },
        collect: { type: "boolean", default: false },
        minutes: { type: "string", default: "1440" },
        account: { type: "string" },
        model: { type: "string" },
        "timeout-ms": { type: "string", default: "120000" },
        channel: { type: "string", default: "own" },
        control: { type: "string" },
        workspace: { type: "string" },
        replace: { type: "boolean", default: false },
        out: { type: "string" },
      },
    }).values,
).catch((error: unknown) => usage(error instanceof Error ? error.message : String(error)))
const minutes = whole(args.minutes, 1_440) ?? usage("--minutes takes a whole number from 1 to 1440")
const timeoutMs = whole(args["timeout-ms"], Number.MAX_SAFE_INTEGER) ?? usage("--timeout-ms takes a whole number")
if ([args.watch, args.collect, args.account !== undefined, args["self-test"]].filter(Boolean).length > 1)
  usage("pick one of --watch, --collect, --account and --self-test")
if (args.yes && args.account === undefined) usage("--yes drives a turn and needs --account")

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  return process.exit(64)
}

function whole(value: string, max: number) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 && number <= max ? number : undefined
}

// ---------------------------------------------------------------------------------------------------------------

/** The driven turn: how long it took and how it ended. */
interface Turn {
  readonly label: string
  readonly kind: string
  readonly providerID: string
  readonly model: string
  /** `accounts.list` status before the turn. */
  readonly status: string
  readonly sessionID: string | null
  readonly ms: number
  readonly error: string | null
}

async function driveTurn(
  api: Api,
  account: Account,
  model: { readonly providerID: string; readonly id: string },
): Promise<{ readonly turn: Turn; readonly window: Window }> {
  await api.capture.start({
    mode: "shape",
    minutes: Math.ceil(timeoutMs / 60_000) + 5,
    providerIDs: [account.providerID],
  })
  const base = { label: account.label, kind: account.kind, providerID: model.providerID, model: model.id }
  const started = { at: Date.now() }
  const run = async (): Promise<Turn> => {
    const sessionID = await api.createSession(model, `G8 · ${account.label}`)
    const failed = async (error: unknown): Promise<Turn> => {
      await api.interrupt(sessionID).catch(() => undefined)
      return {
        ...base,
        status: account.status,
        sessionID,
        ms: Date.now() - started.at,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    const turn = async (): Promise<Turn> => {
      await api.readOnly(sessionID)
      started.at = Date.now()
      await api.prompt(sessionID, PROMPT)
      await api.waitIdle(sessionID, timeoutMs)
      return { ...base, status: account.status, sessionID, ms: Date.now() - started.at, error: null }
    }
    return turn().catch(failed)
  }
  const turn = await run().catch(
    (error: unknown): Turn => ({
      ...base,
      status: account.status,
      sessionID: null,
      ms: 0,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  const stopped = await api.capture.stop()
  if (!stopped.window) throw new Error("diagnostics.capture.stop returned no window")
  return { turn, window: stopped.window }
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence

interface Evidence {
  readonly gate: "G8"
  readonly ac: "AC-P17a"
  readonly mode: "watch" | "drive" | "self-test"
  readonly date: string
  readonly capture: Omit<Window, "dir">
  readonly turn: Turn | null
  readonly verdicts: ReadonlyArray<Verdict>
  readonly failures: ReadonlyArray<FailureShape>
  readonly retries: ReadonlyArray<RetryRow>
}

function evidenceOf(input: {
  readonly mode: Evidence["mode"]
  readonly window: Window
  readonly turn: Turn | null
  readonly lines: ReadonlyArray<Line>
}): Evidence {
  const failureRows = failures(input.lines)
  const retryRows = retries(input.lines)
  return {
    gate: "G8",
    ac: "AC-P17a",
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
    turn: input.turn,
    verdicts: verdicts(input.window, input.turn, failureRows, retryRows),
    failures: failureRows,
    retries: retryRows,
  }
}

function verdicts(
  window: Window,
  turn: Turn | null,
  failureRows: ReadonlyArray<FailureShape>,
  retryRows: ReadonlyArray<RetryRow>,
): ReadonlyArray<Verdict> {
  const hard = retryRows.filter((row) => row.verdict === "hard")
  const stopped = retryRows.filter((row) => row.decision === "stop")
  const paths = [...new Set(failureRows.map((row) => `${row.transport ?? "–"} ${row.source}`))]
  return [
    window.records === 0
      ? {
          check: "capture",
          result: window.steps > 0 ? "fail" : "info",
          detail:
            window.steps > 0
              ? `the window recorded nothing over ${window.steps} own-slot step(s): see the capture_empty alert`
              : "nothing ran in the window",
        }
      : {
          check: "capture",
          result: "info",
          detail: `${window.records} line(s), ${window.dropped} dropped, ${window.steps} own-slot step(s)`,
        },
    {
      check: "failure shapes",
      result: "info",
      detail: failureRows.length === 0 ? "none seen" : `${failureRows.length} distinct shape(s) on ${paths.join(", ")}`,
    },
    {
      check: "retry hook",
      result: "info",
      detail:
        retryRows.length === 0
          ? "not called"
          : `${retryRows.reduce((sum, row) => sum + row.count, 0)} call(s), ${hard.length} hard verdict row(s), ${stopped.length} stop decision row(s)`,
    },
    ...(turn === null ? [] : [turnVerdict(turn, failureRows, hard.length > 0, stopped.length > 0)]),
  ]
}

/** AC-P17a for the driven turn: exhausted, stopped by the hook and over within {@link MUST_MS}. */
function turnVerdict(turn: Turn, failureRows: ReadonlyArray<FailureShape>, hard: boolean, stopped: boolean): Verdict {
  const path = [...new Set(failureRows.map((row) => row.transport ?? "–"))].join("+") || "–"
  const check = `AC-P17a ${turn.kind} ${path}: {retry:false} ends the turn within 30 s`
  if (turn.error !== null) return { check, result: "fail", detail: `the turn failed: ${turn.error}` }
  if (!hard)
    return {
      check,
      result: "not-run",
      detail: `no hard exhaustion was seen (account status before the turn: ${turn.status}); the turn took ${turn.ms} ms`,
    }
  if (stopped && turn.ms <= MUST_MS)
    return { check, result: "pass", detail: `hard verdict, stop decision, the turn ended in ${turn.ms} ms` }
  return {
    check,
    result: "fail",
    detail: `${stopped ? "stop decision" : "no stop decision"}, the turn ended in ${turn.ms} ms; 01 §16.1 fallback: P-004`,
  }
}

function markdown(evidence: Evidence) {
  return [
    `# G8 retry 제어 (AC-P17a), ${evidence.mode}`,
    "",
    `- 날짜: ${evidence.date}`,
    `- 수집 창: ${evidence.capture.id} (${evidence.capture.mode}, ${evidence.capture.end ?? "running"}), 줄 ${evidence.capture.records}, 버림 ${evidence.capture.dropped}, step ${evidence.capture.steps}`,
    ...(evidence.turn
      ? [
          `- 턴: ${evidence.turn.label} (${evidence.turn.kind}, 상태 ${evidence.turn.status}) ${evidence.turn.providerID}/${evidence.turn.model}, ${evidence.turn.ms} ms${evidence.turn.error ? `, 오류 ${evidence.turn.error}` : ""}`,
        ]
      : []),
    "",
    "## 판정",
    "",
    ...verdictLines(evidence.verdicts),
    "",
    ...tables({ failures: evidence.failures, retries: evidence.retries }),
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
  const running = await api.capture.status()
  console.log(`G8 (the user's install, channel ${args.channel}).`)
  console.log(
    running.active
      ? `A capture window runs: ${running.window?.id} until ${new Date(running.window?.until ?? 0).toISOString()}, ${running.window?.records} line(s) so far.`
      : "No capture window runs.",
  )
  const accounts = (await api.accounts()).filter((item) => KINDS.has(item.kind))
  accounts.forEach((item) => console.log(`- ${item.label} (${item.kind}) ${item.providerID}: ${item.status}`))
  console.log(
    [
      "--watch starts a shape window over every own slot (no model request); --collect ends it and writes the evidence.",
      "--account <id or label> --yes drives one one-word turn on an exhausted account and times it (must: 30 s).",
    ].join("\n"),
  )
  return 0
}

async function watch() {
  const bench = await installed({
    channel: args.channel,
    control: args.control,
    workspace: args.workspace,
    fresh: false,
  })
  if (bench === undefined) return noService()
  const api = client(bench)
  const running = await api.capture.status()
  if (running.active && !args.replace) {
    console.error(`A capture window runs (${running.window?.id}); collect it first (--collect) or pass --replace.`)
    return 1
  }
  const started = await api.capture.start({ mode: "shape", minutes })
  console.log(
    `Capture window ${started.window?.id} runs until ${new Date(started.window?.until ?? 0).toISOString()} over every own slot.`,
  )
  console.log(
    "Use own as usual; run `bun own/scripts/gates/g8.ts --collect` when an account ran out (before the service restarts).",
  )
  return 0
}

async function collect() {
  const bench = await installed({
    channel: args.channel,
    control: args.control,
    workspace: args.workspace,
    fresh: false,
  })
  if (bench === undefined) return noService()
  const api = client(bench)
  const current = await api.capture.status()
  const status = current.active ? await api.capture.stop() : current
  if (!status.window) {
    console.error("The service has no capture window (none started since it started). Run --watch first.")
    return 1
  }
  return finish("watch", status.window, null, secretsOf(bench.service))
}

async function drive() {
  const bench = await installed({
    channel: args.channel,
    control: args.control,
    workspace: args.workspace,
    fresh: true,
  })
  if (bench === undefined) return noService()
  const api = client(bench)
  const picked = pick(await api.accounts(), [args.account ?? ""], KINDS)
  const account = picked.picked[0]
  if (account === undefined) {
    console.error(`No own-slot account (Anthropic aside) named ${args.account}.`)
    return 1
  }
  const id = args.model ?? (await api.defaults()).get(account.kind)
  if (id === undefined) {
    console.error(`No default model for ${account.kind}; pass --model <id>.`)
    return 1
  }
  const running = await api.capture.status()
  if (running.active && !args.replace) {
    console.error(`A capture window runs (${running.window?.id}); collect it first (--collect) or pass --replace.`)
    return 1
  }
  if (account.status !== "exhausted")
    console.log(`${account.label} is ${account.status}, not exhausted: the turn will most likely answer normally.`)
  const result = await driveTurn(api, account, { providerID: account.providerID, id })
  return finish("drive", result.window, result.turn, secretsOf(bench.service))
}

async function finish(mode: Evidence["mode"], window: Window, turn: Turn | null, secrets: ReadonlyArray<string>) {
  const evidence = evidenceOf({ mode, window, turn, lines: await readLines(window) })
  const files = await writeEvidence(outDir("g8", args.out), evidence, markdown(evidence), secrets)
  console.log(verdictLines(evidence.verdicts).join("\n"))
  console.log(`evidence: ${files.md}\n          ${files.json}`)
  return evidence.verdicts.some((item) => item.result === "fail") ? 1 : 0
}

function noService() {
  console.error(`No running own service (channel ${args.channel}). Start it first (own start).`)
  return 1
}

/**
 * The fake ChatGPT account at 100 % (the WebSocket `error` frame of the e2e-kit fake): the driven turn must pass the
 * must. Then a watch window over a normal DeepSeek turn, collected.
 */
async function selfTest() {
  const fake = await fakeBench("g8")
  const checks: Array<readonly [string, boolean]> = []
  const check = (name: string, ok: boolean) => checks.push([name, ok])
  const secrets = [...secretsOf(fake.bench.service), ...fake.secrets]
  const run = async () => {
    const api = client(fake.bench)
    const accounts = await api.accounts()
    const codex = accounts.find((item) => item.kind === "codex")
    const deepseek = accounts.find((item) => item.kind === "ds")
    check("a fake ChatGPT and a fake DeepSeek account", codex !== undefined && deepseek !== undefined)
    if (codex === undefined || deepseek === undefined) return
    fake.codex.setUsage(fake.codexAccountID, { primary: 100 })
    const driven = await driveTurn(api, codex, { providerID: codex.providerID, id: "gpt-6-sol" })
    const lines = await readLines(driven.window)
    const evidence = evidenceOf({ mode: "self-test", window: driven.window, turn: driven.turn, lines })
    check("the turn ended without an error", driven.turn.error === null)
    check(
      "the WebSocket usage_limit_reached frame shape is recorded",
      evidence.failures.some(
        (row) =>
          row.transport === "ws" &&
          row.source === "frame" &&
          row.type === "error" &&
          JSON.stringify(row.shape).includes('"type":"usage_limit_reached"'),
      ),
    )
    check(
      "the retry hook line has a hard verdict and a stop decision",
      evidence.retries.some((row) => row.verdict === "hard" && row.decision === "stop"),
    )
    check(
      "AC-P17a passes",
      evidence.verdicts.some((item) => item.check.startsWith("AC-P17a") && item.result === "pass"),
    )
    const files = await writeEvidence(outDir("g8-self-test", args.out), evidence, markdown(evidence), secrets)
    console.log(`evidence: ${files.md}`)

    const watched = await api.capture.start({ mode: "shape", minutes: 5 })
    check("a watch window starts over every own slot", watched.active)
    const sessionID = await api.createSession({ providerID: deepseek.providerID, id: "deepseek-flash" }, "G8 watch")
    await api.readOnly(sessionID)
    await api.prompt(sessionID, PROMPT)
    await api.waitIdle(sessionID, 120_000)
    const collected = await api.capture.stop()
    check(
      "collect ends it with the DeepSeek turn recorded",
      collected.window?.end === "stopped" &&
        (await readLines(collected.window)).some((line) => line.accountKind === "ds"),
    )
    const written = (await Bun.file(files.json).text()) + (await Bun.file(files.md).text())
    check(
      "no credential in the evidence",
      secrets.every((secret) => !written.includes(secret)),
    )
  }
  await run().finally(() => fake.stop())
  checks.forEach((item) => console.log(`${item[1] ? "ok  " : "FAIL"} ${item[0]}`))
  const failed = checks.filter((item) => !item[1]).length
  console.log(
    failed === 0 ? `self-test ok: ${checks.length}/${checks.length} checks` : `self-test FAILED: ${failed} check(s)`,
  )
  return failed === 0 ? 0 : 1
}

const code = await (
  args["self-test"]
    ? selfTest()
    : args.watch
      ? watch()
      : args.collect
        ? collect()
        : args.account !== undefined && args.yes
          ? drive()
          : plan()
).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  return 1
})
process.exit(code)
