import { randomBytes } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { OwnImport } from "@own/protocol/rpc-import"
import { ServiceTarget } from "@own/runtime"
import type { ImportRpc } from "../../src/rpc.js"
import { ImportWorker } from "../../src/worker.js"
import { session, text, write } from "../fixtures/claude.js"
import { compactionItem, rollout, T0, threadId, userItem } from "../fixtures/codex.js"
import { codexRollout, writeJsonl, type Fixture } from "../fixtures/make.js"
import {
  CLAUDE,
  startTeamFakes,
  startTeamServer,
  type TeamFakes,
  type TeamServer,
  type TeamServerOptions,
} from "../../../own-team/test/e2e/harness.js"
import {
  activating,
  anthropicProvider,
  openAICompatibleProvider,
  requestItems,
  startFakeOpenAIChat,
  type FakeOpenAIChat,
  type ModelRef,
  type OpencodeServer,
  type RecordedRequest,
} from "../../../own-accounts/test/e2e-kit"

/**
 * Shared pieces of the own-import e2e and perf runs (09 §7.4 IG1, IG3, IG5, IG10). The server is own-team's real-server
 * harness with `importer: true` (own-accounts and own-import loaded from their package folders, own-team off), its
 * own-import `roots` the synthetic folders the test wrote with `test/fixtures`, and CODEX_HOME / CLAUDE_CONFIG_DIR of
 * the server pointed at empty temp folders, so nothing reads this PC's `~/.codex` or `~/.claude`. Git repositories are
 * made in the harness's temp root with `git -c …` only (no user configuration is read or changed for the commits, no
 * hooks run). Every listener binds 127.0.0.1.
 */

/** Text in every synthetic conversation that must never reach OWN_HOME, `import-index.json` or the logs (IG10). */
export const CONTENT_MARK = "ig10-content-marker-4be1d7"
/** Conversations are last written an hour before the run, so none is `진행 중일 수 있음`. */
export const OLD = new Date(Date.now() - 3_600_000)

/**
 * Sets a written file's mtime to {@link OLD} and keeps its access time now: NTFS updates an access time older than an
 * hour on the next read, which the read-only guard's watcher reports as a change of the file (IG1).
 */
async function aged(file: string) {
  await fsp.utimes(file, new Date(), OLD)
  return file
}

// ---------------------------------------------------------------------------------------------------------------
// Git projects (IG3)

/** Runs git with a fixed identity, no signing and no hooks; throws with stderr when it fails. */
export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=own-import fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      "-c",
      `core.hooksPath=${path.join(cwd, ".no-hooks")}`,
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** The folders of the IG3 project: one repository, two clones of its root commit, worktrees, odd paths. */
export interface Projects {
  readonly base: string
  /** The first clone, under a Hangul folder: the harness's project folder. */
  readonly first: string
  /** A linked worktree of the first clone that core never records (found through `git worktree list`). */
  readonly firstWorktree: string
  /** A subfolder of the first clone. */
  readonly sub: string
  /** A folder below the first clone that does not exist (`폴더 없음`). */
  readonly missing: string
  /** The second clone of the same root commit, under a `#` folder (one Project ID in core). */
  readonly second: string
  /** A linked worktree of the second clone. */
  readonly secondWorktree: string
  /** A junction to the first clone: a conversation that ran through it belongs by real path. */
  readonly link: string
  /** A folder of no project. */
  readonly elsewhere: string
}

/** Builds {@link Projects} below `base` (synchronous: the harness's project builder). */
export function projects(base: string): Projects {
  const first = path.join(base, "한글 작업", "own-open-code")
  const second = path.join(base, "#Projects", "own-open-code")
  const elsewhere = path.join(base, "elsewhere")
  const link = path.join(base, "link")
  fs.mkdirSync(path.join(first, "packages", "core"), { recursive: true })
  fs.mkdirSync(path.dirname(second), { recursive: true })
  fs.mkdirSync(elsewhere, { recursive: true })
  fs.writeFileSync(path.join(first, "README.md"), "fixture\n")
  fs.writeFileSync(path.join(first, "packages", "core", "index.ts"), "export {}\n")
  git(first, "init", "-q")
  git(first, "add", ".")
  git(first, "commit", "-q", "-m", "root")
  git(base, "clone", "-q", first, second)
  const firstWorktree = path.join(first, ".worktrees", "first-wt")
  const secondWorktree = path.join(second, ".worktrees", "cl-perf")
  git(first, "worktree", "add", "-q", "-b", "wt-first", firstWorktree)
  git(second, "worktree", "add", "-q", "-b", "wt-second", secondWorktree)
  fs.symlinkSync(first, link, "junction")
  return {
    base,
    first,
    firstWorktree,
    sub: path.join(first, "packages", "core"),
    missing: path.join(first, "removed-folder"),
    second,
    secondWorktree,
    link,
    elsewhere,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The server

export interface ImportServer {
  readonly server: TeamServer
  readonly projects: Projects
}

/**
 * The harness with own-import (and own-accounts) loaded from their package folders, the IG3 project, and own-import's
 * roots set to `roots`. Core records both clones once a session exists in each (a Location resolves its project).
 */
export async function startImportServer(input: {
  readonly name: string
  readonly roots: { readonly codex: ReadonlyArray<string>; readonly claude: ReadonlyArray<string> }
  /** Keeps core's file watcher on, as the installed service runs (the skills suite: core loads a copied skill). */
  readonly watch?: boolean
}): Promise<ImportServer> {
  const holder: { projects?: Projects } = {}
  const server = await startTeamServer({
    name: input.name,
    team: false,
    importer: true,
    importOptions: { roots: input.roots },
    ...(input.watch ? { watchConfig: true } : {}),
    project: (base) => {
      holder.projects = projects(base)
      return holder.projects.first
    },
  })
  const built = holder.projects
  if (built === undefined) throw new Error("the project builder did not run")
  return { server, projects: built }
}

/** Makes core record a folder for its project (a session there resolves the Location). */
export async function record(server: TeamServer, directory: string) {
  await server.createSession({ directory, title: "own-import e2e" })
}

// ---------------------------------------------------------------------------------------------------------------
// RPC

type Methods = OwnImport.Definition["methods"]
export type ImportOutput<M extends OwnImport.MethodName> = NonNullable<
  Methods[M]["output"]["~standard"]["types"]
>["output"]

/** An own.import method at the control location; throws unless 200 and decodes the output with its schema. */
export async function call<M extends OwnImport.MethodName>(
  server: TeamServer,
  method: M,
  input: unknown,
): Promise<ImportOutput<M>> {
  const result = await server.rpc(OwnImport.ID, method, input)
  if (result.status !== 200)
    throw new Error(`own.import ${method}: HTTP ${result.status} ${result.type ?? ""} ${result.message ?? ""}`)
  const checked = await OwnImport.Definition.methods[method].output["~standard"].validate(result.output)
  if (checked.issues)
    throw new Error(`own.import ${method}: the output does not decode: ${JSON.stringify(checked.issues)}`)
  return checked.value
}

/** A Worker answer (`ImportWorker.create`'s `call`) decoded with the method's output schema; throws on a failure. */
export async function decoded<M extends ImportWorker.Method>(
  method: M,
  answer: ImportRpc.Answer,
): Promise<ImportOutput<M>> {
  if (!answer.ok) throw new Error(`own.import ${method}: ${answer.error.type} ${answer.error.message}`)
  const checked = await OwnImport.Definition.methods[method].output["~standard"].validate(answer.value)
  if (checked.issues)
    throw new Error(`own.import ${method}: the answer does not decode: ${JSON.stringify(checked.issues)}`)
  return checked.value
}

/** `sessions.list` until the index is complete (`scanning: false`). */
export async function settled(
  server: TeamServer,
  input: OwnImport.Definition["methods"]["sessions.list"]["input"]["Encoded"],
) {
  const deadline = Date.now() + 60_000
  const once = async (): Promise<ImportOutput<"sessions.list">> => {
    const listed = await call(server, "sessions.list", input)
    if (!listed.scanning) return listed
    if (Date.now() > deadline) throw new Error("sessions.list kept scanning for a minute")
    await Bun.sleep(200)
    return once()
  }
  return once()
}

const decodeWorktrees = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ directory: Schema.String })))

/**
 * An in-process own-import service (`ImportWorker.create`) reaching the same server through the harness's loopback
 * proxy with own-import's password: the allowlist reports (`Paths.observe`) of a real run can be watched only in this
 * process. `worktrees` asks the server's `worktree.list` route, as the plugin's `ctx.worktree.list` does.
 */
export function inProcess(
  server: TeamServer,
  input: {
    readonly home: string
    readonly roots: ImportWorker.Settings["options"]["roots"]
    readonly resolve?: ImportWorker.ServiceInput["resolve"]
  },
) {
  const option = server.service.importOption
  const service = ImportWorker.create({
    home: input.home,
    resolve: input.resolve,
    worktrees: async (projectID) => {
      const url = new URL("/api/worktree", option.url)
      url.searchParams.set("projectID", projectID)
      url.searchParams.set("location[directory]", server.control)
      const response = await fetch(url, { headers: { authorization: ServiceTarget.basic(option.password) } })
      const listed = Option.getOrUndefined(decodeWorktrees(await response.json().catch(() => undefined)))
      return listed?.map((item) => item.directory) ?? []
    },
    emit: () => {},
  })
  const settings: ImportWorker.Settings = {
    options: { home: input.home, roots: input.roots, service: option },
    channel: "local",
  }
  return {
    service,
    call: (method: ImportWorker.Method, payload: unknown) =>
      service.call(method, payload, settings, new AbortController().signal),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Conversations

/** A Codex thread: a prompt with {@link CONTENT_MARK}, an answer, one shell call with its output, a final answer. */
export function codexRecords(n: number, cwd: string, prompt: string) {
  const turn = `turn-${n}`
  return rollout({ start: T0 + n * 60_000 })
    .meta({ id: threadId(n), cwd })
    .taskStarted(turn)
    .turnContext({ model: "gpt-5.5", cwd, turnId: turn })
    .user(`${prompt} ${CONTENT_MARK}`)
    .assistant(`답변 ${n}: 테스트를 돌려 보겠습니다.`, "commentary")
    .call("shell", { command: ["bun", "test"] }, `call_e2e_${n}`)
    .output(`call_e2e_${n}`, `${n} pass`)
    .assistant(`끝났습니다 ${n}.`)
    .taskComplete(turn)
    .records()
}

/** Writes a Codex thread where Codex keeps it, an hour old; `at` names its date folder (default a minute per `n`). */
export async function writeCodex(
  root: string,
  n: number,
  cwd: string,
  prompt: string,
  options: { readonly zst?: boolean; readonly at?: number } = {},
) {
  const at = options.at ?? T0 + n * 60_000
  return aged(
    await writeJsonl(codexRollout(root, { id: threadId(n), at, zst: options.zst }), codexRecords(n, cwd, prompt)),
  )
}

/** Writes a Claude Code conversation (a prompt with {@link CONTENT_MARK} and an answer), an hour old. */
export async function writeClaude(root: string, id: string, cwd: string, prompt: string) {
  const input = { cwd, id, version: "2.1.288" }
  const built = session(input)
  built.user(`${prompt} ${CONTENT_MARK}`)
  built.assistant([text(`Claude 답변: ${prompt}`)], { id: `msg_FAKE_${id.slice(-4)}` })
  return aged(await write(root, input, built))
}

/** A Codex rollout of `turns` turns, each with a tool output of `outputBytes`: a long walk for a search. */
export async function bigCodex(root: string, n: number, cwd: string, turns: number, outputBytes: number) {
  const builder = rollout({ start: T0 }).meta({ id: threadId(n), cwd })
  const filler = "lorem ipsum dolor sit amet ".repeat(Math.ceil(outputBytes / 27)).slice(0, outputBytes)
  Array.from({ length: turns }, (_, index) => index).forEach((index) =>
    builder
      .user(`질문 ${index}`)
      .call("shell", { command: ["bun", "test"] }, `call_big_${index}`)
      .output(`call_big_${index}`, filler)
      .assistant(`답변 ${index}`),
  )
  return aged(await writeJsonl(codexRollout(root, { id: threadId(n), at: T0 }), builder.records()))
}

// ---------------------------------------------------------------------------------------------------------------
// Privacy scans (IG10)

/** The files below `dir` (recursively) whose bytes contain one of `needles`, with the needles they contain. */
export async function containing(dir: string, needles: ReadonlyArray<string>) {
  const names = await fsp.readdir(dir, { recursive: true }).catch(() => [])
  const found = await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name)
      const stat = await fsp.stat(file).catch(() => undefined)
      if (stat === undefined || !stat.isFile()) return []
      const bytes = await fsp.readFile(file).catch(() => Buffer.alloc(0))
      const hits = needles.filter((needle) => bytes.includes(Buffer.from(needle)))
      return hits.length === 0 ? [] : [{ file, needles: hits }]
    }),
  )
  return found.flat()
}

/** Waits until `check` is true (polling), or throws `message` after `timeoutMs`. */
export async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message)
    await Bun.sleep(100)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// I2: the migration server (09 §7.4 IG7–IG10, IG12)

/** Hop-by-hop and body-framing headers the streaming proxy does not copy. */
const DROPPED = new Set([
  "authorization",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "content-encoding",
])

export interface StreamingProxy {
  /** own.import's `service` option: this proxy and its fresh fake password. */
  readonly option: { readonly url: string; readonly password: string }
  stop(): Promise<void>
}

/**
 * A loopback proxy for own.import's `service` option that streams each answer as it comes. The helper follows its
 * session log (`experimental.session.log?follow=true`, 09 §4.4), a server-sent stream that does not end by itself,
 * which own-team's harness proxy cannot pass (it reads every answer whole). `target` names the running server; while
 * there is none (the first boot, a restart) the proxy answers 503, and 502 when the server went away mid-call.
 */
export function startStreamingProxy(
  target: () => Pick<OpencodeServer, "url" | "authorization"> | undefined,
): StreamingProxy {
  const password = randomBytes(18).toString("base64url")
  const expected = ServiceTarget.basic(password)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A followed log is quiet between its events; Bun's default idle timeout would cut it.
    idleTimeout: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== expected)
        return Response.json({ _tag: "Unauthorized", message: "unauthorized" }, { status: 401 })
      const current = target()
      if (current === undefined)
        return Response.json({ _tag: "ServiceUnavailable", message: "no server" }, { status: 503 })
      const url = new URL(request.url)
      const headers = new Headers(
        [...request.headers.entries()].filter((entry) => !DROPPED.has(entry[0].toLowerCase())),
      )
      headers.set("authorization", current.authorization)
      const answer = await fetch(new URL(url.pathname + url.search, current.url), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        redirect: "manual",
        signal: request.signal,
      }).catch(() => undefined)
      if (answer === undefined)
        return Response.json({ _tag: "BadGateway", message: "the server went away" }, { status: 502 })
      return new Response(answer.body, {
        status: answer.status,
        headers: [...answer.headers.entries()].filter((entry) => !DROPPED.has(entry[0].toLowerCase())),
      })
    },
  })
  return {
    option: { url: `http://127.0.0.1:${server.port}`, password },
    stop: async () => {
      await server.stop(true)
    },
  }
}

/** The local openai-chat provider and model (IG12 `local`): a config provider served by a fake on this PC. */
export const LOCAL = { providerID: "localchat", id: "local-coder" } as const

export interface MigrateServer extends ImportServer {
  readonly fakes: TeamFakes
  /** The fake behind {@link LOCAL}. */
  readonly local: FakeOpenAIChat
  stop(): Promise<void>
}

/**
 * own-team's harness with own-accounts and own-import loaded from their package folders (own-team off), the Claude
 * subscription slot (the fake claude-auth shim), the {@link LOCAL} provider, the IG3 git project and own-import's
 * self-HTTP through a {@link startStreamingProxy}. `config` adds top-level config (`agents`, …) and `providers` more
 * config providers. Every model call goes to a local fake (own-team `directives.ts` answers what is not queued).
 */
export async function startMigrateServer(input: {
  readonly name: string
  readonly fixture: Fixture
  readonly config?: Readonly<Record<string, unknown>>
  readonly providers?: (local: FakeOpenAIChat) => Readonly<Record<string, unknown>>
}): Promise<MigrateServer> {
  const fakes = startTeamFakes()
  const local = startFakeOpenAIChat({ cache: { minTokens: 0, blockTokens: 32 } })
  const holder: { server?: TeamServer; projects?: Projects } = {}
  const proxy = startStreamingProxy(() => holder.server?.server)
  const options: TeamServerOptions = {
    name: input.name,
    team: false,
    importer: true,
    claude: true,
    fakes,
    importOptions: {
      roots: { codex: [input.fixture.codex], claude: [input.fixture.claude] },
      service: proxy.option,
    },
    project: (base) => {
      holder.projects = projects(base)
      return holder.projects.first
    },
    config: {
      ...input.config,
      // The harness's own `providers` (the Claude slot's) are replaced by this list, so it names that one again.
      providers: {
        anthropic: anthropicProvider(fakes.anthropic, { apiKey: CLAUDE.key, models: [CLAUDE.model.id] }),
        [LOCAL.providerID]: openAICompatibleProvider(local, {
          apiKey: "fake-own-import-local-key",
          models: {
            [LOCAL.id]: {
              name: "Local coder",
              limit: { context: 64_000, output: 8_000 },
              capabilities: { tools: true },
            },
          },
        }),
        ...input.providers?.(local),
      },
    },
  }
  const stopFakes = async () => {
    await proxy.stop()
    await Promise.all([fakes.stop(), local.stop()])
  }
  const server = await startTeamServer(options).catch(async (error: unknown) => {
    await stopFakes()
    throw error
  })
  holder.server = server
  const built = holder.projects
  if (built === undefined) throw new Error("the project builder did not run")
  return {
    server,
    projects: built,
    fakes,
    local,
    stop: async () => {
      await server.stop()
      await stopFakes()
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Conversations to move (09 §7.3: synthetic, written from the documented format)

/** Writes a Codex thread's records where Codex keeps it, an hour old. */
export async function writeThread(root: string, n: number, records: ReadonlyArray<unknown>) {
  return aged(await writeJsonl(codexRollout(root, { id: threadId(n), at: T0 + n * 60_000 }), records))
}

/**
 * Two short turns with a shell call each (`exec_command`, as Codex calls it). Exactly two secrets, both fake: an API
 * key in the first tool output and a GitHub token in the second request; the first request names
 * {@link CONTENT_MARK}.
 */
export function smallThread(n: number, cwd: string, secrets: { readonly apiKey: string; readonly github: string }) {
  return rollout({ start: T0 + n * 60_000 })
    .meta({ id: threadId(n), cwd })
    .taskStarted(`small-${n}-0`)
    .turnContext({ model: "gpt-5.5", cwd, turnId: `small-${n}-0` })
    .user(`설치기를 정리해 줘 ${CONTENT_MARK}`)
    .assistant("테스트를 먼저 돌려 보겠습니다.", "commentary")
    .call("exec_command", { cmd: "bun test" }, `call_small_${n}_0`)
    .output(`call_small_${n}_0`, `3 pass\nOPENAI_API_KEY=${secrets.apiKey}`)
    .assistant("테스트가 통과했습니다.")
    .taskComplete(`small-${n}-0`)
    .taskStarted(`small-${n}-1`)
    .user(`이 토큰은 지워 줘 ${secrets.github}`)
    .call("exec_command", { cmd: "git status" }, `call_small_${n}_1`)
    .output(`call_small_${n}_1`, "nothing to commit")
    .assistant("지울 것이 없습니다.")
    .taskComplete(`small-${n}-1`)
    .records()
}

/** Tool output of `chars` characters (about `chars / 4` tokens): what makes a conversation large. */
export function filler(chars: number, seed: number) {
  return `output ${seed}: ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(chars / 27))}`.slice(0, chars)
}

/** One turn of {@link bigThread}: `질문 <index>`, a shell call with `chars` of output, `답변 <index>`. */
function bigTurn(builder: ReturnType<typeof rollout>, n: number, index: number, chars: number) {
  return builder
    .user(`질문 ${index}`)
    .call("exec_command", { cmd: `bun test --filter ${index}` }, `call_big_${n}_${index}`)
    .output(`call_big_${n}_${index}`, filler(chars, index))
    .assistant(`답변 ${index}`)
}

/** `turns` turns of {@link bigTurn}: larger than a small window as it is (09 §4.3 `does_not_fit`). */
export function bigThread(n: number, cwd: string, turns: number, chars: number) {
  const builder = rollout({ start: T0 + n * 60_000 }).meta({ id: threadId(n), cwd })
  Array.from({ length: turns }, (_, index) => index).forEach((index) => bigTurn(builder, n, index, chars))
  return builder.records()
}

/**
 * `before` large turns, a Codex remote compaction (its summary is encrypted, 09 §4.1), then `after` short turns: the
 * fill crosses the remote boundary up to the capacity.
 */
export function remoteThread(n: number, cwd: string, before: number, after: number, chars: number) {
  const builder = rollout({ start: T0 + n * 60_000 }).meta({ id: threadId(n), cwd })
  Array.from({ length: before }, (_, index) => index).forEach((index) => bigTurn(builder, n, index, chars))
  builder.compacted("", [...Array.from({ length: before }, (_, index) => userItem(`질문 ${index}`)), compactionItem()])
  Array.from({ length: after }, (_, index) => before + index).forEach((index) =>
    builder.user(`짧은 질문 ${index}`).assistant(`짧은 답변 ${index}`),
  )
  return builder.records()
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs, sessions and requests

const Finished = Schema.Struct({
  jobID: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
  sessionID: optional(Schema.String),
  error: optional(Schema.Struct({ type: Schema.String, message: Schema.String, cause: optional(Schema.String) })),
})
const decodeFinished = Schema.decodeUnknownSync(Finished)

/** `job.finished` of `jobID`, past or future, decoded. */
export async function finished(server: TeamServer, jobID: string, timeoutMs = 300_000) {
  const event = await server.events.waitFor(
    (item) => item.type === "rpc.own.import.job.finished" && item.data.jobID === jobID,
    timeoutMs,
  )
  return decodeFinished(event.data)
}

/** Runs a plan's nonce (`migrate.execute`) and waits for the job's end. */
export async function runJob(server: TeamServer, nonce: string, timeoutMs = 300_000) {
  const started = await call(server, "migrate.execute", { nonce })
  return finished(server, started.jobID, timeoutMs)
}

/** The `rpc.own.import.job.*` events of `jobID` so far, oldest first. */
export function jobEvents(server: TeamServer, jobID: string) {
  return server.events.events.filter((item) => item.type.startsWith("rpc.own.import.job.") && item.data.jobID === jobID)
}

const decodeExported = Schema.decodeUnknownSync(Schema.Struct({ data: SessionTransfer.Data }))

/** A session's stored transcript (`experimental.session.export`), decoded with `SessionTransfer.Data` (IG7). */
export async function exported(server: TeamServer, sessionID: string) {
  return decodeExported(await server.server.call("GET", `/api/experimental/session/${sessionID}/export`)).data
}

const decodeRoots = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: optional(Schema.String),
        metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
        time: Schema.Struct({ archived: optional(Schema.Finite) }),
      }),
    ),
  }),
)

/** Every root session, archived ones too, with its metadata. */
export async function rootSessions(server: TeamServer) {
  return decodeRoots(await server.server.call("GET", "/api/session", { query: { parentID: "null", limit: "200" } }))
    .data
}

/** The hidden helper sessions (09 §4.4): metadata `own.import.helper`. */
export async function helperSessions(server: TeamServer) {
  return (await rootSessions(server)).filter((item) => {
    const meta = OwnImport.decodeMetadata(item.metadata)
    return meta !== undefined && OwnImport.isHelper(meta)
  })
}

/** Imported sessions (an `own.import` value that is not a helper's). */
export async function importedSessions(server: TeamServer) {
  return (await rootSessions(server)).filter((item) => {
    const meta = OwnImport.decodeMetadata(item.metadata)
    return meta !== undefined && !OwnImport.isHelper(meta)
  })
}

/** The model requests among a fake's recordings: not a token refresh, a handshake or a usage poll. */
export function modelRequests(requests: ReadonlyArray<RecordedRequest>) {
  return requests.filter((request) => request.model !== undefined && requestItems(request).length > 0)
}

/** Every fake's recordings, to tell which provider got a call. */
export function recordings(run: Pick<MigrateServer, "fakes" | "local">) {
  return {
    codex: run.fakes.codex.requests,
    deepseek: run.fakes.deepseek.requests,
    anthropic: run.fakes.anthropic.requests,
    local: run.local.requests,
  }
}

/** How many requests each fake has recorded so far: the start of a window to compare with {@link since}. */
export function marks(run: Pick<MigrateServer, "fakes" | "local">) {
  return Object.fromEntries(Object.entries(recordings(run)).map((entry) => [entry[0], entry[1].length]))
}

/** The model requests each fake recorded after {@link marks}. */
export function since(run: Pick<MigrateServer, "fakes" | "local">, from: Readonly<Record<string, number>>) {
  return Object.fromEntries(
    Object.entries(recordings(run)).map((entry) => [entry[0], modelRequests(entry[1].slice(from[entry[0]] ?? 0))]),
  )
}

/**
 * Ordinary turns on `target` in `directory` until own.accounts measured the slot's Z (09 §5.6), in at most three new
 * sessions (the first session of a Location is not always sampled). Answers the last `estimate.request`, asked at the
 * control Location as own.import asks it: the slot's samples are the process's, whatever Location ran the turns.
 */
export async function measureZ(server: TeamServer, target: ModelRef, directory: string) {
  const once = async (left: number): Promise<Readonly<Record<string, unknown>>> => {
    const sessionID = await server.createSession({ model: target, title: "measure Z", directory })
    await server.turn(sessionID, "hello")
    const estimated = await server.accounts("estimate.request", { target, requests: [] })
    if (estimated.zSource === "measured" || left <= 1) return estimated
    return once(left - 1)
  }
  return once(3)
}

const decodeModels = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ providerID: Schema.String, id: Schema.String })) }),
)

/**
 * Waits until `refs` are listed at `directory`'s Location (`GET /api/model` there): a Location loads its providers
 * after it starts, so a plan there right away may not find its target yet (`target_unavailable`).
 */
export async function modelsAt(server: TeamServer, refs: ReadonlyArray<ModelRef>, directory: string) {
  await until(
    async () => {
      // The server answers 503 while the Location's plugins still activate (server/src/location.ts waits 5 s).
      const answer = await server.server
        .call("GET", "/api/model", { directory, query: { "location[directory]": directory } })
        .catch(activating)
      if (answer === undefined) return false
      const listed = decodeModels(answer).data
      return refs.every((ref) => listed.some((model) => model.providerID === ref.providerID && model.id === ref.id))
    },
    `models not listed at ${directory}`,
    120_000,
  )
}
