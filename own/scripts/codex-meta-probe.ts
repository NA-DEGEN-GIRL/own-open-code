// PG7 (나) probe (07 §4.5, §8.4): what the Codex backend's model list answers to the request own-accounts sends
// (`CodexMeta.BACKEND`, `CodexMeta.fetchList`), so the endpoint, `client_version` and etag assumptions can be approved
// before T2.21 removes the stand-in window list (`CODEX_LONG_CONTEXT` in packages/own-accounts/src/slots/templates.ts).
//
// Three GETs of the model list and nothing else (no model request: no quota is used):
//   A. `<codex endpoint>/models?client_version=<v>` with the Codex headers own-accounts sends (`Credentials.codexHeaders`
//      with `session-id` = `BACKEND.sessionID`, plus `accept`)
//   B. the same without `client_version`
//   C. A again with `If-None-Match: <A's etag>` (skipped when A had none)
// The report has each status, the etag behaviour, the model rows (the metadata fields own reads plus slug-level facts;
// never instructions, never a header) and, for every model of own's codex template, the input window own registers
// with A's list and without any list, with whether the stand-in list may go (every model on it has a metadata window).
// It is printed and written to own/.out/pg7/<time>/probe.{json,md} (ignored by git) for the user to approve.
//
// Credentials: one Codex CLI `auth.json` (`--auth`, default `$CODEX_HOME\auth.json`, else `%USERPROFILE%\.codex\auth.json`;
// a codex-multi-provider profile's `codex\auth.json` has the same shape), read once and never written. The script never
// refreshes a token: a refresh rotates the login that the Codex CLI (and own, for a linked account) keeps using. An
// expired token stops it; run the Codex CLI once so it refreshes its own login, then probe again. Tokens, account ids and
// e-mails are never printed or written; the report is checked for the token values before anything is shown.
//
//   bun own/scripts/codex-meta-probe.ts                  # the plan only: which file, which URLs; no network
//   bun own/scripts/codex-meta-probe.ts --yes            # the three GETs against the backend (user-run, PG7 (나))
//   bun own/scripts/codex-meta-probe.ts --self-test      # the three GETs against a local fake on 127.0.0.1, checked
//   options: --auth <file>, --base-url <codex endpoint>, --client-version <v>, --out <dir>
// Exit: 0 done (self-test: passed), 1 failed, 64 usage error.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { Endpoints } from "../../packages/own-accounts/src/endpoints"
import { CodexMeta } from "../../packages/own-accounts/src/slots/codex-meta"
import { Templates } from "../../packages/own-accounts/src/slots/templates"
import { CodexModels } from "../../packages/own-protocol/src/codex-models"
import { CodexSource, Credentials } from "../../packages/own-runtime/src/index"

const REPO = path.resolve(import.meta.dir, "..", "..")
/** The production `codex` endpoint own-accounts fetches from (upstream's `codexBaseURL`). */
const CODEX_ENDPOINT = Endpoints.DEFAULTS.codex
/** The row fields the report keeps: what own reads (`CodexModels.Model`) and what explains the list's gating. */
const ROW_FIELDS = [
  "slug",
  "display_name",
  "visibility",
  "priority",
  "minimal_client_version",
  "context_window",
  "max_context_window",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "multi_agent_reasoning_effort",
  "supports_reasoning_effort_updates",
  "upgrade",
] as const

const USAGE =
  "usage: bun own/scripts/codex-meta-probe.ts [--yes | --self-test] [--auth <auth.json>] [--base-url <codex endpoint>] [--client-version <v>] [--out <dir>]"

// An unknown or incomplete option is a usage error.
const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        yes: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        auth: { type: "string" },
        "base-url": { type: "string" },
        "client-version": { type: "string" },
        out: { type: "string" },
      },
    }).values,
).catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  return process.exit(64)
})

const code = await (args["self-test"] ? selfTest() : args.yes ? live() : plan()).catch((error: unknown) => {
  console.error(`codex-meta-probe: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
process.exit(code)

// ---------------------------------------------------------------------------------------------------------------

interface Input {
  readonly authPath: string
  /** The `codex` endpoint (`…/backend-api/codex`). */
  readonly baseURL: string
  readonly clientVersion: string
}

/** No network: the login file as `CodexSource.inspect` sees it (no token value) and the three requests. */
async function plan() {
  const input = inputOf()
  const login = await CodexSource.inspect(input.authPath)
  console.log(`login file: ${input.authPath}`)
  console.log(
    login.ok
      ? `  ChatGPT login, plan ${login.summary.identity.plan ?? "unknown"}, access token ${login.expired ? "EXPIRED (run the Codex CLI once)" : "valid"}`
      : `  unusable: ${login.problem}`,
  )
  const urls = requests(input)
  console.log("requests (GET, Codex headers, no model request):")
  console.log(`  A ${urls.a}`)
  console.log(`  B ${urls.b}`)
  console.log(`  C ${urls.a}  If-None-Match: <A's etag>`)
  console.log("Run again with --yes to send them (PG7 (나), 07 §8.4).")
  return 0
}

/** The three GETs against the backend; the report is printed and written under own/.out/pg7. */
async function live() {
  const input = inputOf()
  const out = args.out ? path.resolve(args.out) : path.join(REPO, "own", ".out", "pg7", stamp())
  const report = await probe(input)
  await write(out, report)
  console.log(markdown(report))
  console.log(`\nreport: ${path.join(out, "probe.json")} and probe.md`)
  return 0
}

function inputOf(): Input {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  return {
    authPath: path.resolve(args.auth ?? path.join(home, "auth.json")),
    baseURL: (args["base-url"] ?? CODEX_ENDPOINT).replace(/\/+$/, ""),
    clientVersion: args["client-version"] ?? CodexMeta.BACKEND.clientVersion,
  }
}

function requests(input: Input) {
  const base = `${input.baseURL}${CodexMeta.BACKEND.path}`
  return { a: `${base}?client_version=${encodeURIComponent(input.clientVersion)}`, b: base }
}

// ---------------------------------------------------------------------------------------------------------------

/** One GET as the report keeps it. */
interface Answer {
  readonly url: string
  readonly sentEtag: boolean
  readonly status: number | "network" | "timeout"
  readonly etag?: string
  readonly cacheControl?: string
  readonly contentType?: string
  /** Rows of the body's `models` list that decode as own reads them, and how many were left out. */
  readonly models?: number
  readonly rejected?: number
  readonly rows?: ReadonlyArray<Readonly<Record<string, unknown>>>
  /** A body that is not a model list, cut short (an error text never carries a token). */
  readonly body?: string
}

interface Report {
  readonly at: string
  readonly endpoint: string
  readonly clientVersion: string
  readonly sessionID: string
  readonly plan?: string
  readonly a: Answer
  readonly b: Answer
  readonly c: Answer | "skipped: A had no etag"
  readonly findings: {
    /** Slugs only A lists, only B lists. */
    readonly onlyWithClientVersion: ReadonlyArray<string>
    readonly onlyWithoutClientVersion: ReadonlyArray<string>
    readonly etag: string
  }
  /**
   * Each codex template model (no `-fast` twin): its largest input in A's list (`metadata`), the input window own
   * registers with A's list and without any list (absent = the live catalog's), and whether the stand-in list is
   * what gives it its window without metadata.
   */
  readonly windows: ReadonlyArray<{
    readonly id: string
    readonly metadata?: number
    readonly withList?: number
    readonly withoutList?: number
    readonly standIn: boolean
  }>
  /** T2.21: every model of the stand-in list has its window in A's list, so the list can go. */
  readonly standInCovered: boolean
}

async function probe(input: Input): Promise<Report> {
  const read = await CodexSource.read(input.authPath)
  if (!read.ok) throw new Error(`the login file cannot be used (${read.problem}): ${input.authPath}`)
  const summary = read.snapshot.summary
  if (summary.expiresAt <= Date.now())
    throw new Error("the access token has expired; run the Codex CLI once so it refreshes its login (never done here)")
  const account = summary.identity.chatgptAccountId
  if (!account) throw new Error("the login file names no ChatGPT account")
  const secret = read.snapshot.secret
  const headers = {
    ...Credentials.codexHeaders(secret.access(), account, CodexMeta.BACKEND.sessionID),
    accept: "application/json",
  }
  const urls = requests(input)
  const first = await get(urls.a, headers)
  const a = first.answer
  const b = (await get(urls.b, headers)).answer
  const c = a.etag
    ? (await get(urls.a, { ...headers, "if-none-match": a.etag })).answer
    : ("skipped: A had no etag" as const)
  const slugs = (answer: Answer) => (answer.rows ?? []).map((row) => String(row.slug))
  // What own would store from A: the rows own decodes (`CodexMeta.fetchList`).
  const snapshot: CodexModels.Snapshot | undefined = first.decoded && {
    source: "backend",
    fetchedAt: Date.now(),
    models: first.decoded.models,
  }
  const template = await Templates.bundled("codex")
  const windows = (template?.models ?? [])
    .filter((model) => !model.id.endsWith("-fast"))
    .map((model) => {
      const row = CodexModels.find(snapshot, model.id)
      const metadata = row && CodexModels.maxInput(row)
      const withList = snapshot ? Templates.codexLimit(model, snapshot)?.input : undefined
      const withoutList = Templates.codexLimit(model, emptySnapshot())?.input
      return {
        id: String(model.id),
        ...(metadata === undefined ? {} : { metadata }),
        ...(withList === undefined ? {} : { withList }),
        ...(withoutList === undefined ? {} : { withoutList }),
        // The stand-in list is what gives a model 872k without metadata (07 §6.2 #4).
        standIn: withoutList === 872_000,
      }
    })
  const report: Report = {
    at: new Date().toISOString(),
    endpoint: input.baseURL,
    clientVersion: input.clientVersion,
    sessionID: CodexMeta.BACKEND.sessionID,
    ...(summary.identity.plan ? { plan: summary.identity.plan } : {}),
    a,
    b,
    c,
    findings: {
      onlyWithClientVersion: slugs(a).filter((slug) => !slugs(b).includes(slug)),
      onlyWithoutClientVersion: slugs(b).filter((slug) => !slugs(a).includes(slug)),
      etag:
        typeof c === "string"
          ? "A sent no etag: own's fetch then downloads the whole list every time"
          : c.status === 304
            ? "A's etag sent back as If-None-Match answered 304: own keeps its snapshot without a download"
            : `A's etag sent back as If-None-Match answered ${c.status}, not 304`,
    },
    windows,
    standInCovered: windows.filter((model) => model.standIn).every((model) => model.metadata !== undefined),
  }
  // Defense in depth: nothing of the login may reach the report.
  const text = JSON.stringify(report)
  if (
    [secret.access(), secret.refresh(), secret.idToken(), account].some((value) => value !== "" && text.includes(value))
  )
    throw new Error("the report would contain a credential or an account id; nothing was printed or written")
  return report
}

/** A list snapshot with no rows: `Templates.codexLimit`'s no-metadata path (an absent argument reads the module's). */
function emptySnapshot(): CodexModels.Snapshot {
  return { source: "backend", fetchedAt: 0, models: [] }
}

/** One GET: what the report keeps, and the rows own would decode from a model list. */
async function get(url: string, headers: Readonly<Record<string, string>>) {
  const timeout = AbortSignal.timeout(CodexMeta.BACKEND.timeoutMs)
  const sentEtag = "if-none-match" in headers
  const response = await fetch(url, { headers, signal: timeout }).catch(() => undefined)
  if (!response) return { answer: { url, sentEtag, status: timeout.aborted ? "timeout" : "network" } satisfies Answer }
  const etag = response.headers.get("etag")
  const cacheControl = response.headers.get("cache-control")
  const contentType = response.headers.get("content-type")
  const meta = {
    url,
    sentEtag,
    status: response.status,
    ...(etag === null ? {} : { etag }),
    ...(cacheControl === null ? {} : { cacheControl }),
    ...(contentType === null ? {} : { contentType }),
  }
  const text = await response.text().catch(() => "")
  // `Response.json` parses without throwing into this code; anything else is no list.
  const body: unknown = await new Response(text).json().catch(() => undefined)
  const decoded = CodexModels.decode(body)
  const list = isRecord(body) && Array.isArray(body.models) ? body.models : undefined
  if (!list || !decoded)
    return { answer: { ...meta, ...(text === "" ? {} : { body: text.slice(0, 300) }) } satisfies Answer }
  return {
    answer: {
      ...meta,
      models: decoded.models.length,
      rejected: decoded.rejected,
      rows: list.filter(isRecord).map(rowOf),
    } satisfies Answer,
    decoded,
  }
}

/** The kept fields of one row; long texts cut, levels as their effort names. */
function rowOf(row: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    ROW_FIELDS.flatMap((field) => {
      const value = row[field]
      if (value === undefined) return []
      if (field === "supported_reasoning_levels" && Array.isArray(value))
        return [[field, value.map((level: unknown) => (isRecord(level) ? String(level.effort) : String(level)))]]
      return [[field, typeof value === "string" ? value.slice(0, 120) : value]]
    }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------------------------------------------

async function write(dir: string, report: Report) {
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "probe.json"), `${JSON.stringify(report, null, 2)}\n`)
  await Bun.write(path.join(dir, "probe.md"), `${markdown(report)}\n`)
}

function markdown(report: Report) {
  const line = (name: string, answer: Answer) =>
    `| ${name} | ${answer.sentEtag ? "yes" : "no"} | ${answer.status} | ${answer.etag ?? "–"} | ${answer.models ?? "–"}${answer.rejected ? ` (${answer.rejected} left out)` : ""} | ${answer.cacheControl ?? "–"} |`
  const rows = report.a.rows ?? []
  return [
    `# PG7 (나) Codex model list probe (${report.at})`,
    "",
    `endpoint \`${report.endpoint}/models\`, client_version \`${report.clientVersion}\`, session-id \`${report.sessionID}\`, plan ${report.plan ?? "unknown"}`,
    "",
    "| request | If-None-Match | status | etag | models | cache-control |",
    "|---|---|---|---|---|---|",
    line("A with client_version", report.a),
    line("B without client_version", report.b),
    typeof report.c === "string" ? `| C | – | ${report.c} | | | |` : line("C A + If-None-Match", report.c),
    "",
    `- only with client_version: ${report.findings.onlyWithClientVersion.join(", ") || "none"}`,
    `- only without client_version: ${report.findings.onlyWithoutClientVersion.join(", ") || "none"}`,
    `- etag: ${report.findings.etag}`,
    ...(report.a.body ? [`- A body: ${report.a.body}`] : []),
    "",
    "## Model rows (A)",
    "",
    "| slug | priority | context | max context | default | levels | multi-agent | effort updates | upgrade | min client |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.slug} | ${row.priority ?? "–"} | ${row.context_window ?? "–"} | ${row.max_context_window ?? "–"} | ${row.default_reasoning_level ?? "–"} | ${Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.join(",") : "–"} | ${row.multi_agent_reasoning_effort ?? "–"} | ${row.supports_reasoning_effort_updates ?? "–"} | ${isRecord(row.upgrade) ? `${row.upgrade.model} ${row.upgrade.retirement_at ?? ""}`.trim() : "–"} | ${row.minimal_client_version ?? "–"} |`,
    ),
    "",
    "## Windows own registers (codex template)",
    "",
    "| model | A's max input | registered with A's list | registered without a list | stand-in list |",
    "|---|---|---|---|---|",
    ...report.windows.map(
      (model) =>
        `| ${model.id} | ${model.metadata ?? "–"} | ${model.withList ?? "catalog"} | ${model.withoutList ?? "catalog"} | ${model.standIn ? "yes" : ""} |`,
    ),
    "",
    `Stand-in list covered by the metadata (T2.21 may delete it): ${report.standInCovered ? "yes" : "NO"}`,
  ].join("\n")
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * The probe against a local fake of the model list (127.0.0.1) with a fake login file in a temp folder, serving the
 * Codex model list fixture of own-accounts' tests: only with `client_version` does the list have the newer rows and an
 * etag, `If-None-Match` answers 304, a wrong credential 401, and one stand-in model (gpt-5.6-luna) comes without its
 * window, so the report must say the stand-in list cannot go yet. Checks the requests' headers against own's fetch,
 * the report's findings, and that no token, account id or e-mail is in it.
 */
async function selfTest() {
  // Test fixtures (fake tokens and profiles), loaded only here: the plan and the live run never import test code.
  const { chatGPTAccount, mintChatGPTTokens } = await import(
    "../../packages/own-accounts/test/e2e-kit/fixtures/chatgpt-tokens"
  )
  const { writeCodexMultiProviderProfiles } = await import(
    "../../packages/own-accounts/test/e2e-kit/fixtures/codex-multi-provider"
  )
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-pg7-selftest-"))
  const account = chatGPTAccount({ accountID: "acct-pg7-selftest", plan: "pro", email: "probe@example.test" })
  const tokens = mintChatGPTTokens(account, Date.now(), 60 * 60_000)
  const [profile] = await writeCodexMultiProviderProfiles(root, [{ id: "01", alias: "probe", tokens }])
  const fixture: unknown = await Bun.file(
    path.join(REPO, "packages/own-accounts/test/slots/fixture/codex-models.json"),
  ).json()
  const all = (isRecord(fixture) && Array.isArray(fixture.models) ? fixture.models.filter(isRecord) : []).map((row) =>
    row.slug === "gpt-5.6-luna" ? { ...row, context_window: null, max_context_window: null } : row,
  )
  const seen: Array<Readonly<Record<string, string>>> = []
  const etag = '"pg7-selftest-1"'
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      seen.push(Object.fromEntries(request.headers))
      if (url.pathname !== "/backend-api/codex/models") return Response.json({ detail: "Not Found" }, { status: 404 })
      if (
        request.headers.get("authorization") !== `Bearer ${tokens.accessToken}` ||
        request.headers.get("chatgpt-account-id") !== account.accountID
      )
        return Response.json({ detail: "Could not validate your credentials" }, { status: 401 })
      if (!url.searchParams.has("client_version"))
        return Response.json({ models: all.filter((row) => row.minimal_client_version === undefined) })
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } })
      return Response.json({ models: all }, { headers: { etag, "cache-control": "private, max-age=300" } })
    },
  })
  const result = await probe({
    authPath: required(profile).authPath,
    baseURL: `http://127.0.0.1:${server.port}/backend-api/codex`,
    clientVersion: CodexMeta.BACKEND.clientVersion,
  }).finally(() => server.stop(true))
  const text = `${JSON.stringify(result)}\n${markdown(result)}`
  const own = Credentials.codexHeaders(tokens.accessToken, account.accountID, CodexMeta.BACKEND.sessionID)
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    [
      "A answered 200 with the list and an etag",
      result.a.status === 200 && result.a.etag === etag && (result.a.models ?? 0) > 0,
    ],
    ["A's malformed fixture row was left out", result.a.rejected === 1],
    [
      "B answered 200 without the rows that need a client version",
      result.b.status === 200 && result.findings.onlyWithClientVersion.includes("gpt-6.1-sol"),
    ],
    ["C sent A's etag back and got 304", typeof result.c !== "string" && result.c.sentEtag && result.c.status === 304],
    [
      "every request carried own's Codex headers",
      seen.length === 3 &&
        seen.every((headers) =>
          Object.entries({ ...own, accept: "application/json" }).every(([name, value]) => headers[name] === value),
        ),
    ],
    [
      "every stand-in model but the one without a window takes its window from the list",
      result.windows
        .filter((model) => model.standIn)
        .every((model) => (model.id === "gpt-5.6-luna") === (model.metadata === undefined)),
    ],
    ["so the stand-in list cannot go yet", !result.standInCovered],
    [
      "no token, account id or e-mail in the report",
      [tokens.accessToken, tokens.refreshToken, tokens.idToken, account.accountID, account.email].every(
        (value) => !text.includes(value),
      ),
    ],
  ]
  if (args.out) await write(path.resolve(args.out), result)
  await fs.rm(root, { recursive: true, force: true })
  for (const [name, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`)
  const passed = checks.every((check) => check[1])
  console.log(passed ? "self-test ok" : "self-test FAILED")
  return passed ? 0 : 1
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("self-test fixture missing")
  return value
}
