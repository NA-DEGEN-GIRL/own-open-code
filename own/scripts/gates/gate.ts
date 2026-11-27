// Shared parts of the real-account gate scripts G7 and G8 (`g7.ts`, `g8.ts`; 01 §16.1; P0-3a in
// own/reports/external-repos-2026-10-05.md): the loopback client of the user's own service, the opt-in wire evidence
// capture (`diagnostics.capture.*`, 02 §7.8), summaries of its lines, the evidence files, and the fake bench the
// self-tests run on (the e2e-kit preset rig, loaded only by `--self-test`).
//
// The service password comes from its registration file and only ever goes into `Authorization` to the loopback URL.
// Provider credentials never pass through these scripts: the service injects them. The capture lines are redacted by
// the service; evidence is still checked for the service credential and for secret-looking strings before it is
// written, and nothing is written when a check finds one.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LastResponse, Redact, ServiceTarget } from "../../../packages/own-runtime/src/index"

export const REPO = path.resolve(import.meta.dir, "..", "..", "..")

/** What the gates send: a one-word answer keeps every turn as small as own's prompt allows. */
export const PROMPT = "Reply with the single word: ok"
/** Account kinds the gates drive: own slots without the Anthropic ones (Claude is out of scope here). */
export const KINDS: ReadonlySet<string> = new Set(["codex", "siwc", "oai", "ds", "xai", "or", "compat"])
/** Frame and stream event types that end a request (or fail it). */
export const TERMINAL: ReadonlySet<string> = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "response.incomplete",
  "error",
])
/** Failure types whose shapes G8 records. */
export const FAILURE: ReadonlySet<string> = new Set(["error", "response.failed", "response.incomplete"])
/** Response header names that carry limits (02 §7.1). */
export const LIMIT_NAME = /^(x-codex-|x-ratelimit-)/

// ---------------------------------------------------------------------------------------------------------------
// Service

/** Where the gate talks to: the service, the folder for global own.accounts methods and the sessions' folder. */
export interface Bench {
  readonly service: ServiceTarget.Target
  readonly control: string
  readonly workspace: string
}

/** The fields of an `accounts.list` entry the gates read; never the masked e-mail or anything secret. */
export interface Account {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly providerID: string
  readonly status: string
}

/** A capture window as `diagnostics.capture.*` returns it (02 §9.2). */
export interface Window {
  readonly id: string
  readonly mode: string
  readonly startedAt: number
  readonly until: number
  readonly end: string | null
  readonly records: number
  readonly dropped: number
  readonly steps: number
  readonly dir: string
  readonly files: ReadonlyArray<string>
}

export interface Status {
  readonly active: boolean
  readonly window: Window | undefined
}

/**
 * The installed service of `channel` with the default control folder (02 §9.1), or `undefined` when none runs. The
 * sessions' folder is `workspace`, else a new temp folder made only when `fresh` asks for one (a plan makes none).
 */
export async function installed(input: {
  readonly channel: string
  readonly control: string | undefined
  readonly workspace: string | undefined
  readonly fresh: boolean
}): Promise<Bench | undefined> {
  const service = await new ServiceTarget.Service(ServiceTarget.registrationPath(input.channel)).current()
  if (service === undefined) return undefined
  return {
    service,
    control:
      input.control ??
      path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "own-open-code", "control"),
    workspace:
      input.workspace ?? (input.fresh ? await fs.mkdtemp(path.join(os.tmpdir(), "own-gate-")) : "(a new temp folder)"),
  }
}

export type Api = ReturnType<typeof client>

/** The service's HTTP API and own.accounts RPC with its `Authorization`; an error names the status and type only. */
export function client(bench: Bench) {
  const request = async (
    method: string,
    route: string,
    input: { readonly directory: string; readonly body?: unknown; readonly timeoutMs?: number },
  ): Promise<unknown> => {
    const response = await fetch(new URL(route, bench.service.url), {
      method,
      headers: {
        authorization: bench.service.authorization,
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
    const type = isRecord(json) ? (json.type ?? json.name) : undefined
    throw new Error(
      `${method} ${route.split("?")[0]}: HTTP ${response.status}${typeof type === "string" ? ` ${type}` : ""}`,
    )
  }
  const rpc = async (method: string, input: unknown, directory = bench.control) => {
    const answer = await request(
      "POST",
      `/api/rpc/own.accounts/${method}?${new URLSearchParams({ "location[directory]": directory })}`,
      { directory, body: { input } },
    )
    return isRecord(answer) && isRecord(answer.output) ? answer.output : {}
  }
  const sessionPath = (sessionID: string, rest = "") => `/api/session/${encodeURIComponent(sessionID)}${rest}`
  return {
    accounts: async () => {
      const listed = await rpc("accounts.list", {})
      return (Array.isArray(listed.accounts) ? listed.accounts : []).flatMap((item): Account[] =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.kind === "string" &&
        typeof item.label === "string" &&
        typeof item.providerID === "string" &&
        typeof item.status === "string"
          ? [{ id: item.id, kind: item.kind, label: item.label, providerID: item.providerID, status: item.status }]
          : [],
      )
    },
    /** The new-conversation default model of each provider group (07 §2.2). */
    defaults: async () => {
      const listed = await rpc("presets.list", {})
      return new Map(
        (Array.isArray(listed.groups) ? listed.groups : []).flatMap(
          (item): Array<[string, string]> =>
            isRecord(item) && typeof item.group === "string" && isRecord(item.defaultModel)
              ? typeof item.defaultModel.id === "string"
                ? [[item.group, item.defaultModel.id]]
                : []
              : [],
        ),
      )
    },
    capture: {
      start: async (input: {
        readonly mode: "hash" | "shape"
        readonly minutes: number
        readonly providerIDs?: ReadonlyArray<string>
      }) => statusOf(await rpc("diagnostics.capture.start", input)),
      stop: async () => statusOf(await rpc("diagnostics.capture.stop", {})),
      status: async () => statusOf(await rpc("diagnostics.capture.status", {})),
    },
    createSession: async (model: { readonly providerID: string; readonly id: string }, title: string) => {
      const answer = await request("POST", "/api/session", {
        directory: bench.workspace,
        body: { title, model, location: { directory: bench.workspace } },
      })
      const session = isRecord(answer) ? answer.data : undefined
      if (!isRecord(session) || typeof session.id !== "string") throw new Error("session.create returned no id")
      return session.id
    },
    /** Read-only approval: a gate turn never edits or runs anything without asking (07 §2.4). */
    readOnly: (sessionID: string) =>
      rpc("session.approval.set", { sessionID, mode: "read-only" }, bench.workspace).then(() => undefined),
    prompt: async (sessionID: string, text: string) => {
      await request("POST", sessionPath(sessionID, "/prompt"), { directory: bench.workspace, body: { text } })
    },
    waitIdle: async (sessionID: string, timeoutMs: number) => {
      await request("POST", `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, {
        directory: bench.workspace,
        timeoutMs,
      })
    },
    interrupt: async (sessionID: string) => {
      await request("POST", sessionPath(sessionID, "/interrupt"), { directory: bench.workspace })
    },
  }
}

/** Picks the gate's accounts: the named ones (id or label), else every ready account of `kinds`. */
export function pick(accounts: ReadonlyArray<Account>, named: ReadonlyArray<string>, kinds: ReadonlySet<string>) {
  if (named.length === 0)
    return { picked: accounts.filter((item) => kinds.has(item.kind) && item.status === "ready"), missing: [] }
  const found = named.map((name) => ({
    name,
    account: accounts.find((item) => item.id === name || item.label === name),
  }))
  return {
    picked: found.flatMap((item) => (item.account && kinds.has(item.account.kind) ? [item.account] : [])),
    missing: found.flatMap((item) => (item.account && kinds.has(item.account.kind) ? [] : [item.name])),
  }
}

/** `kind=model` pairs of `--model` (`codex=gpt-5.5,ds=deepseek-flash`); `undefined` when one is malformed. */
export function modelsOf(list: string | undefined) {
  const items = (list ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => /^([a-z]+)=(\S+)$/.exec(item))
  if (items.some((item) => item === null)) return undefined
  return new Map(items.flatMap((item) => (item ? [[item[1] ?? "", item[2] ?? ""] as const] : [])))
}

// ---------------------------------------------------------------------------------------------------------------
// Capture lines (written by packages/own-accounts/src/telemetry/capture.ts)

/** One capture line; `data` is the whole record. */
export interface Line {
  readonly event: string
  readonly ts: number
  readonly sessionID: string
  readonly providerID: string
  readonly accountKind: string
  readonly kind: string | null
  readonly transport: string | null
  readonly data: Readonly<Record<string, unknown>>
}

/** The window's lines of every session file it wrote (its summary file holds counts only). */
export async function readLines(window: Window): Promise<ReadonlyArray<Line>> {
  const texts = await Promise.all(
    window.files
      .filter((file) => !file.endsWith("windows.jsonl"))
      .map((file) => fs.readFile(path.join(window.dir, ...file.split("/")), "utf8").catch(() => "")),
  )
  return texts
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.trim() !== "")
    .flatMap((text) => {
      const line = lineOf(JSON.parse(text))
      return line && line.data.capture === window.id ? [line] : []
    })
    .toSorted((a, b) => a.ts - b.ts)
}

function lineOf(value: unknown): Line | undefined {
  if (!isRecord(value) || typeof value.event !== "string" || typeof value.ts !== "number") return undefined
  return {
    event: value.event,
    ts: value.ts,
    sessionID: String(value.sessionID),
    providerID: String(value.providerID),
    accountKind: typeof value.accountKind === "string" ? value.accountKind : "?",
    kind: typeof value.kind === "string" ? value.kind : null,
    transport: typeof value.transport === "string" ? value.transport : null,
    data: value,
  }
}

export interface NameCount {
  readonly name: string
  readonly count: number
  /** `LastResponse` keeps it today (02 §7.2); a response header name that is not kept is what AC-P15 asks to see. */
  readonly kept: boolean
}

export interface CensusRow {
  readonly accountKind: string
  readonly kind: string | null
  readonly transport: string | null
  /** `response` (HTTP response headers) or `handshake` (WebSocket request headers; responses have no hook). */
  readonly event: string
  readonly count: number
  readonly names: ReadonlyArray<NameCount>
}

/** Header names per account kind, request kind, transport and event, each with how many lines carried it. */
export function census(lines: ReadonlyArray<Line>): ReadonlyArray<CensusRow> {
  const groups = Map.groupBy(
    lines.filter((line) => line.event === "response" || line.event === "handshake"),
    (line) => [line.accountKind, line.kind, line.transport, line.event].join("|"),
  )
  return [...groups.values()].map((group) => {
    const first = group[0] as Line
    const counts = Map.groupBy(
      group.flatMap((line) => strings(line.data.names)),
      (name) => name,
    )
    return {
      accountKind: first.accountKind,
      kind: first.kind,
      transport: first.transport,
      event: first.event,
      count: group.length,
      names: [...counts.entries()]
        .map((entry) => ({ name: entry[0], count: entry[1].length, kept: kept(entry[0]) }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    }
  })
}

function kept(name: string) {
  return LastResponse.HEADER_NAMES.has(name) || LastResponse.HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export interface LimitRow {
  readonly providerID: string
  readonly accountKind: string
  readonly transport: string
  /** HTTP: response lines. WebSocket: frames that end a request ({@link TERMINAL}). */
  readonly requests: number
  /** HTTP: responses with a limit header ({@link LIMIT_NAME}). WebSocket: `codex.rate_limits` frames, at most `requests`. */
  readonly withLimits: number
  /** The limit header names or frame type seen. */
  readonly sources: ReadonlyArray<string>
}

/**
 * Whether each request brought its limits: per slot and transport. A WebSocket frame names no request, so the frames
 * are counted: one `codex.rate_limits` frame per finished request is full coverage.
 */
export function limits(lines: ReadonlyArray<Line>): ReadonlyArray<LimitRow> {
  const http = lines.filter((line) => line.event === "response" && line.transport === "http")
  const frames = lines.filter((line) => line.event === "frame" && line.transport === "ws")
  const rows = [
    ...[...Map.groupBy(http, (line) => line.providerID).values()].map((group) => {
      const named = group.map((line) => strings(line.data.names).filter((name) => LIMIT_NAME.test(name)))
      return {
        providerID: (group[0] as Line).providerID,
        accountKind: (group[0] as Line).accountKind,
        transport: "http",
        requests: group.length,
        withLimits: named.filter((names) => names.length > 0).length,
        sources: [...new Set(named.flat())].toSorted(),
      }
    }),
    ...[...Map.groupBy(frames, (line) => line.providerID).values()].map((group) => {
      const requests = group.filter((line) => TERMINAL.has(String(line.data.type))).length
      const rateLimits = group.filter((line) => line.data.type === "codex.rate_limits").length
      return {
        providerID: (group[0] as Line).providerID,
        accountKind: (group[0] as Line).accountKind,
        transport: "ws",
        requests,
        withLimits: Math.min(requests, rateLimits),
        sources: rateLimits > 0 ? ["codex.rate_limits"] : [],
      }
    }),
  ]
  return rows.toSorted((a, b) => `${a.providerID}|${a.transport}`.localeCompare(`${b.providerID}|${b.transport}`))
}

export interface FailureShape {
  readonly accountKind: string
  readonly transport: string | null
  /** `response` (an HTTP error body), `stream` (an event of an HTTP stream) or `frame` (a WebSocket frame). */
  readonly source: string
  /** The HTTP status, or the event or frame type. */
  readonly type: string
  readonly hash: string
  readonly count: number
  /** Only in shape mode. */
  readonly shape: unknown
}

/** The distinct shapes of error bodies and of failure events and frames (02 §5.2, 01 §16.1 G8 "실제 형태"). */
export function failures(lines: ReadonlyArray<Line>): ReadonlyArray<FailureShape> {
  const items = lines.flatMap((line) => {
    const base = { accountKind: line.accountKind, transport: line.transport }
    if (line.event === "response" && isRecord(line.data.body))
      return [{ ...base, source: "response", type: String(line.data.status), evidence: line.data.body }]
    if (line.event === "frame" && FAILURE.has(String(line.data.type)))
      return [{ ...base, source: "frame", type: String(line.data.type), evidence: line.data }]
    if (line.event === "stream")
      return (Array.isArray(line.data.shapes) ? line.data.shapes : [])
        .filter((item) => isRecord(item) && FAILURE.has(String(item.type)))
        .map((item) => ({
          ...base,
          source: "stream",
          type: String((item as Record<string, unknown>).type),
          evidence: item,
        }))
    return []
  })
  const groups = Map.groupBy(items, (item) =>
    [item.accountKind, item.transport, item.source, item.type, isRecord(item.evidence) ? item.evidence.hash : ""].join(
      "|",
    ),
  )
  return [...groups.values()].map((group) => {
    const first = group[0] as (typeof items)[number]
    const evidence = isRecord(first.evidence) ? first.evidence : {}
    return {
      accountKind: first.accountKind,
      transport: first.transport,
      source: first.source,
      type: first.type,
      hash: String(evidence.hash ?? ""),
      count: group.length,
      shape: evidence.shape ?? null,
    }
  })
}

export interface RetryRow {
  readonly accountKind: string
  /** core's error type (its RateLimit/QuotaExceeded classification) and status. */
  readonly error: string
  readonly status: number | null
  /** own-accounts' verdict (02 §5.2) and the decision core got. */
  readonly verdict: string
  readonly decision: string
  readonly count: number
}

export function retries(lines: ReadonlyArray<Line>): ReadonlyArray<RetryRow> {
  const items = lines
    .filter((line) => line.event === "retry")
    .map((line) => {
      const error = isRecord(line.data.error) ? line.data.error : {}
      return {
        accountKind: line.accountKind,
        error: String(error.type ?? "?"),
        status: typeof error.status === "number" ? error.status : null,
        verdict: String(line.data.verdict ?? "?"),
        decision: String(line.data.decision ?? "?"),
      }
    })
  return [...Map.groupBy(items, (item) => JSON.stringify(item)).values()].map((group) => ({
    ...(group[0] as (typeof items)[number]),
    count: group.length,
  }))
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence files

/** One gate check: `pass`/`fail` for a must, `info` for a record, `not-run` when nothing exercised it. */
export interface Verdict {
  readonly check: string
  readonly result: "pass" | "fail" | "info" | "not-run"
  readonly detail: string
}

/**
 * Writes `evidence.json` and `evidence.md` into `dir`. Nothing is written when either text holds one of `secrets` or
 * the evidence has a secret-looking string (`Redact.findings`, placeholders like `<str:12>` aside); the error lists
 * the paths only.
 */
export async function writeEvidence(dir: string, evidence: unknown, md: string, secrets: ReadonlyArray<string>) {
  const json = JSON.stringify(evidence, null, 2) + "\n"
  if (secrets.some((secret) => secret !== "" && (json.includes(secret) || md.includes(secret))))
    throw new Error("the evidence contains the service credential; nothing was written")
  const found = Redact.findings(withoutPlaceholders(evidence))
  if (found.length > 0)
    throw new Error(
      `the evidence has secret-looking values; nothing was written: ${found.map((item) => `${item.path} (${item.reason})`).join(", ")}`,
    )
  await fs.mkdir(dir, { recursive: true })
  const files = { json: path.join(dir, "evidence.json"), md: path.join(dir, "evidence.md") }
  await Bun.write(files.json, json)
  await Bun.write(files.md, md)
  return files
}

/** The service credential in every form a report could carry it: the header value and the password itself. */
export function secretsOf(service: ServiceTarget.Target) {
  const encoded = service.authorization.replace(/^Basic\s+/i, "")
  const password = Buffer.from(encoded, "base64")
    .toString("utf8")
    .replace(/^opencode:/, "")
  return [service.authorization, encoded, password].filter((item) => item.length >= 8)
}

function withoutPlaceholders(value: unknown): unknown {
  if (typeof value === "string") return /^<[a-z+0-9:-]+>$/.test(value) ? "" : value
  if (Array.isArray(value)) return value.map(withoutPlaceholders)
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map((entry) => [entry[0], withoutPlaceholders(entry[1])]))
  return value
}

/** Markdown tables of the shared summaries. */
export function tables(input: {
  readonly census?: ReadonlyArray<CensusRow>
  readonly limits?: ReadonlyArray<LimitRow>
  readonly failures?: ReadonlyArray<FailureShape>
  readonly retries?: ReadonlyArray<RetryRow>
}) {
  const cell = (value: unknown) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ")
  return [
    ...(input.limits && input.limits.length > 0
      ? [
          "## 요청마다 한도",
          "",
          "| slot | kind | transport | 요청 | 한도 있음 | 출처 |",
          "|---|---|---|---|---|---|",
          ...input.limits.map(
            (row) =>
              `| ${row.providerID} | ${row.accountKind} | ${row.transport} | ${row.requests} | ${row.withLimits} | ${cell(row.sources.join(", ") || "–")} |`,
          ),
          "",
        ]
      : []),
    ...(input.census && input.census.length > 0
      ? [
          "## 헤더 이름",
          "",
          "`*` = LastResponse가 지금 남기지 않는 응답 헤더 이름(AC-P15). `handshake` 줄은 WebSocket 요청 헤더다.",
          "",
          "| kind | 요청 | transport | 줄 | 이름(줄 수) |",
          "|---|---|---|---|---|",
          ...input.census.map(
            (row) =>
              `| ${row.accountKind} | ${row.kind ?? "–"} | ${row.transport ?? "–"} ${row.event} | ${row.count} | ${cell(row.names.map((item) => `${item.kept || row.event !== "response" ? "" : "*"}${item.name}(${item.count})`).join(", "))} |`,
          ),
          "",
        ]
      : []),
    ...(input.failures && input.failures.length > 0
      ? [
          "## 오류 모양",
          "",
          ...input.failures.flatMap((item) => [
            `- ${item.accountKind} ${item.transport ?? "–"} ${item.source} \`${item.type}\` ×${item.count} (hash ${item.hash})`,
            ...(item.shape === null ? [] : ["", "  ```json", `  ${JSON.stringify(item.shape)}`, "  ```", ""]),
          ]),
          "",
        ]
      : []),
    ...(input.retries && input.retries.length > 0
      ? [
          "## retry hook",
          "",
          "| kind | core 오류 | status | 판정 | 결정 | 횟수 |",
          "|---|---|---|---|---|---|",
          ...input.retries.map(
            (row) =>
              `| ${row.accountKind} | ${row.error} | ${row.status ?? "–"} | ${row.verdict} | ${row.decision} | ${row.count} |`,
          ),
          "",
        ]
      : []),
  ]
}

export function verdictLines(verdicts: ReadonlyArray<Verdict>) {
  return verdicts.map((item) => `- **${item.result}** ${item.check}: ${item.detail}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test bench

/**
 * A real upstream server with own-accounts (the e2e-kit preset rig) on fake backends: one linked ChatGPT account on a
 * fake Codex backend (WebSocket, as own's codex slots default to) and a DeepSeek key on a fake chat API. Fake
 * credentials only; everything binds 127.0.0.1.
 */
export async function fakeBench(name: string) {
  const { startFakeCodex, startFakeOpenAIChat, startPresetRig } = await import(
    "../../../packages/own-accounts/test/e2e-kit"
  )
  const codex = startFakeCodex()
  const chat = startFakeOpenAIChat()
  const stopFakes = () => Promise.all([codex.stop(), chat.stop()]).then(() => undefined)
  const gpt = { providerID: "own-codex-pg01", id: "gpt-6-sol" }
  const tokens = codex.login({ accountID: "acct-gate-01", email: "gate@example.test", plan: "plus" })
  const rig = await startPresetRig({
    name,
    codex,
    chatgpt: [{ id: "01", tokens }],
    endpoints: { deepseek: chat.baseURL },
    models: [gpt],
  }).catch(async (error: unknown) => {
    await stopFakes()
    throw error
  })
  const stop = async () => {
    await rig.stop()
    await stopFakes()
  }
  const added = await rig
    .call("accounts.add.key", { kind: "ds", label: "DeepSeek gate", key: "sk-fake-gate-deepseek-0001" })
    .catch(async (error: unknown) => {
      await stop()
      throw error
    })
  const account = isRecord(added.account) ? added.account : {}
  const deepseek = { providerID: String(account.providerID), id: "deepseek-flash" }
  await rig.server.waitForModels([gpt, deepseek]).catch(async (error: unknown) => {
    await stop()
    throw error
  })
  return {
    bench: {
      service: { url: rig.server.url, authorization: rig.server.authorization },
      control: rig.server.paths.workspace,
      workspace: rig.server.paths.workspace,
    } satisfies Bench,
    codex,
    codexAccountID: "acct-gate-01",
    secrets: [tokens.accessToken, tokens.refreshToken, tokens.idToken, "sk-fake-gate-deepseek-0001"],
    stop,
  }
}

// ---------------------------------------------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function statusOf(output: Readonly<Record<string, unknown>>): Status {
  const window = isRecord(output.window) ? output.window : undefined
  return {
    active: output.active === true,
    window:
      window && typeof window.id === "string" && typeof window.dir === "string"
        ? {
            id: window.id,
            mode: String(window.mode),
            startedAt: Number(window.startedAt),
            until: Number(window.until),
            end: typeof window.end === "string" ? window.end : null,
            records: Number(window.records),
            dropped: Number(window.dropped),
            steps: Number(window.steps),
            dir: window.dir,
            files: strings(window.files),
          }
        : undefined,
  }
}

/** `own/.out/gates/<time>-<gate>` (ignored by git). */
export function outDir(gate: string, out: string | undefined) {
  return out
    ? path.resolve(out)
    : path.join(REPO, "own", ".out", "gates", `${new Date().toISOString().replace(/[:.]/g, "-")}-${gate}`)
}
