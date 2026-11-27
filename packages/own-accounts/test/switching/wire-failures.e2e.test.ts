// End to end on a real upstream server (P1-9b, r6 F17): the e2e-kit fakes break a model reply on the wire — a reset
// before any header, a drop before or behind a delta, an EOF without the terminal event, a malformed JSON chunk, a
// Codex WebSocket close mid-response, a listener that goes away and comes back — on four own slots: a linked ChatGPT
// account over the Codex WebSocket and one over Codex HTTP SSE, an `oai` key on OpenAI Responses and a `ds` key on
// DeepSeek chat completions. own-accounts lets every break pass: the verdict its retry hook gave (read from a wire
// evidence capture window's `retry` lines, 02 §7.8) is never a switch trigger, nothing is exhausted, benched or
// suggested, and the same slot answers the next scripted reply. Core retries every break but the malformed chunk, which
// ends the turn; the next prompt then completes on the same slot. A drop right behind a tool-call delta never runs the
// tool twice. There is no stall case: core's WebSocket idle timeout is a deliberate 30 minutes.
//
// Where this differs from WP09's wording ("each failure is classified transient, and the next scripted reply completes
// the turn"): only transport failures are `transient`. An incomplete or malformed stream is core's
// `provider.invalid-output`, which carries no quota signal, so own-accounts says `unknown` ("not ours"). Neither is a
// switch trigger (only `hard` and `auth` are), which is what WP09 asks for. Core does not retry a malformed chunk
// (`SessionRunnerRetry.isRetryable`), so its next reply completes the next turn rather than the same one.
//
// Every credential is fake (fake codex-multi-provider profiles, a seeded stand-in vault); the servers bind 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodexSource, Hash } from "@own/runtime"
import type { Classify } from "../../src/telemetry/classify.js"
import {
  assistantMessages,
  opencodeConfig,
  recordServerEvents,
  removeTree,
  startFakeCodex,
  startFakeOpenAIChat,
  startFakeOpenAIResponses,
  startOpencodeServer,
  toolOutputs,
  writeCodexMultiProviderProfiles,
  type EventRecorder,
  type FakeCodex,
  type FakeOpenAIChat,
  type FakeOpenAIResponses,
  type FakeProvider,
  type ModelRef,
  type OpencodeServer,
  type RecordedRequest,
  type WireFault,
} from "../e2e-kit"
import { registryWith } from "../slots/support.js"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 60_000
const VAULT_HELPER = path.join(import.meta.dir, "../slots-auth/fixture/seed-vault-helper.ts")
const ACCOUNTS = path.join(import.meta.dir, "../..")

// Fake API keys (never real).
const OAI_KEY = "sk-proj-wireFakeKeyOai00000000000000000000001"
const DS_KEY = "sk-wireFakeKeyDeepSeek000000000000000002"

const NOTE = "wire-note.txt"
const NOTE_TEXT = "the note the read tool returns"
const RECOVERED = "recovered after the wire failure"
const AFTER_TOOL = "read it once"

interface Slot {
  readonly name: string
  readonly kind: "codex" | "oai" | "ds"
  readonly fake: "codex" | "responses" | "chat"
  readonly model: ModelRef
  readonly websocket: boolean
}

const SLOTS: ReadonlyArray<Slot> = [
  {
    name: "codex WebSocket",
    kind: "codex",
    fake: "codex",
    model: { providerID: "own-codex-wirews", id: "gpt-6-sol" },
    websocket: true,
  },
  {
    name: "codex SSE",
    kind: "codex",
    fake: "codex",
    model: { providerID: "own-codex-wiresse", id: "gpt-6-sol" },
    websocket: false,
  },
  {
    name: "openai-responses",
    kind: "oai",
    fake: "responses",
    model: { providerID: "own-oai-wireoai", id: "gpt-5.5" },
    websocket: false,
  },
  {
    name: "openai-chat (DeepSeek)",
    kind: "ds",
    fake: "chat",
    model: { providerID: "own-ds-wireds", id: "deepseek-flash" },
    websocket: false,
  },
]

/** The answer a broken reply was streaming: two deltas, so a drop behind the first leaves output started. */
const PARTIAL = { type: "text", text: "partial answer that breaks", deltas: 2 } as const

/** A `read` call of the workspace note. */
const read = (id: string) => ({ type: "tool-call", name: "read", input: { path: NOTE }, id }) as const

interface Failure {
  readonly name: string
  readonly fault: WireFault
  readonly websocketOnly?: boolean
  /**
   * Core does not retry it: an event that is not JSON is an `InvalidProviderOutput` without the `incomplete-stream`
   * classification (`SessionRunnerRetry.isRetryable`), so the turn ends with `provider.invalid-output` and the next
   * prompt gets the next scripted reply.
   */
  readonly final?: boolean
}

const FAILURES: ReadonlyArray<Failure> = [
  { name: "a reset before the response head", fault: { type: "reset" } },
  { name: "a drop before the first delta", fault: { type: "drop", reply: PARTIAL, after: 0 } },
  { name: "a drop behind the first delta", fault: { type: "drop", reply: PARTIAL, after: 1 } },
  { name: "an EOF without the terminal event", fault: { type: "eof", reply: PARTIAL } },
  { name: "a malformed JSON chunk", fault: { type: "malformed", reply: PARTIAL, after: 1 }, final: true },
  {
    name: "a WebSocket close mid-response",
    fault: { type: "ws-close", reply: PARTIAL, after: 1 },
    websocketOnly: true,
  },
  // Longer than core's first retry delay (2 s ± 20%), so one retry meets a refused connection.
  { name: "a listener that is gone for 3 s", fault: { type: "delayed-listen", ms: 3_000 } },
]

/**
 * The verdict own-accounts' `retry` hook gives (`Classify`) per error type core reports for a wire failure. Neither is
 * a switch trigger (only `hard` and `auth` are): the account stays usable and the same slot is retried. An incomplete
 * or malformed stream carries no quota signal, so it is `unknown` ("not ours").
 */
const VERDICT: Readonly<Record<string, Classify.Class>> = {
  "provider.transport": "transient",
  "provider.invalid-output": "unknown",
}

const fixture: {
  codex?: FakeCodex
  responses?: FakeOpenAIResponses
  chat?: FakeOpenAIChat
  server?: OpencodeServer
  events?: EventRecorder
  temp?: string
} = {}

beforeAll(async () => {
  const small = { minTokens: 0, blockTokens: 32 }
  const codex = startFakeCodex({ cache: small })
  fixture.codex = codex
  fixture.responses = startFakeOpenAIResponses({ cache: small, models: ["gpt-5.5"] })
  fixture.chat = startFakeOpenAIChat({ cache: small })
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-wire-failures-")))
  fixture.temp = temp
  const home = path.join(temp, "own-home")
  const legacy = path.join(temp, "control-center")
  await fs.mkdir(home, { recursive: true })
  const profiles = await writeCodexMultiProviderProfiles(legacy, [
    { id: "01", alias: "wire-ws", tokens: codex.login({ accountID: "acct-wire-ws" }) },
    { id: "02", alias: "wire-sse", tokens: codex.login({ accountID: "acct-wire-sse" }) },
  ])
  const linked = await Promise.all(
    profiles.map(async (profile) => ({
      identity: await sourceIdentity(profile.authPath),
      credential: {
        type: "linked-codex-source" as const,
        source: {
          app: "codex-multi-provider" as const,
          profileID: profile.id,
          alias: profile.alias,
          authPath: profile.authPath,
        },
        linkedAt: "2026-10-05T00:00:00Z",
      },
    })),
  )
  const registry = await registryWith([
    { kind: "codex", label: "Wire WS", slug: "wirews", ...required(linked[0]) },
    { kind: "codex", label: "Wire SSE", slug: "wiresse", transport: "http", ...required(linked[1]) },
    { kind: "oai", label: "Wire OAI", slug: "wireoai", identity: { keyHint: Hash.keyHint(OAI_KEY) } },
    { kind: "ds", label: "Wire DS", slug: "wireds", identity: { keyHint: Hash.keyHint(DS_KEY) } },
  ])
  await Bun.write(path.join(home, "accounts.json"), JSON.stringify(registry, null, 2))
  const seed = path.join(temp, "vault-seed.json")
  await Bun.write(
    seed,
    JSON.stringify({
      acc_wireoai: JSON.stringify({ v: 1, type: "key", key: OAI_KEY, generation: 1 }),
      acc_wireds: JSON.stringify({ v: 1, type: "key", key: DS_KEY, generation: 1 }),
    }),
  )
  const server = await startOpencodeServer({
    env: { OWN_OPEN_CODE: "1" },
    workspaceFiles: { [NOTE]: NOTE_TEXT },
    config: opencodeConfig({
      providers: {},
      plugins: [
        {
          package: ACCOUNTS,
          options: {
            home,
            buildId: `e2e-wire-failures-${process.pid}`,
            vault: { command: [process.execPath, VAULT_HELPER, seed] },
            endpoints: {
              codex: codex.baseURL,
              oauthIssuer: codex.url,
              openai: required(fixture.responses).baseURL,
              deepseek: required(fixture.chat).baseURL,
            },
            codexImportRoot: legacy,
          },
        },
      ],
    }),
  })
  fixture.server = server
  fixture.events = await recordServerEvents(server)
  await server.waitForModels(SLOTS.map((slot) => slot.model))
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.events?.close()
  await fixture.server?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.responses?.stop(), fixture.chat?.stop()])
  if (fixture.temp) await removeTree(fixture.temp)
}, 60_000)

for (const slot of SLOTS)
  describe(`wire failures on the ${slot.name} slot`, () => {
    for (const failure of FAILURES.filter((item) => slot.websocket || !item.websocketOnly))
      test(
        `${failure.name}: the same slot answers the next reply ${failure.final ? "on the next turn" : "in the turn"}`,
        async () => {
          const server = required(fixture.server)
          const fake = fakeOf(slot)
          fake.reset()
          const session = await server.createSession({ model: slot.model, title: `wire ${slot.name}` })
          fake.enqueue(failure.fault, { type: "text", text: RECOVERED })
          await capture(server, session.id)
          await turn(server, session.id, `wire failure: ${failure.name}`)
          const failed = (await assistantMessages(server, session.id)).at(-1)
          if (failure.final) {
            expect(failed?.error).toMatchObject({ type: "provider.invalid-output" })
            await turn(server, session.id, "and again")
          }
          const verdicts = await captured(server)

          const requests = fake.requests.filter(isModelRequest)
          const assistants = await assistantMessages(server, session.id)
          log(slot, failure, requests, assistants, retries(session.id))
          // One broken request, then the same slot's fake answered the next scripted reply.
          expect(requests.map((request) => request.fault)).toEqual([failure.fault.type, undefined])
          expect(requests.at(-1)?.status).toBe(200)
          const last = assistants.at(-1)
          expect(last?.error).toBeUndefined()
          expect(last?.finish).toBe("stop")
          expect(texts(last)).toContain(RECOVERED)
          expect(assistants.map((message) => modelOf(message))).toEqual(assistants.map(() => slot.model))
          const errors = failure.final ? [errorOf(failed)] : retries(session.id).map((event) => errorOf(event.data))
          if (!failure.final) expect(errors.length).toBeGreaterThan(0)
          // The hook saw each failure core reported (a malformed chunk too, with core's "stop") and let it pass.
          expect(verdicts.map((line) => line.error)).toEqual(errors.map((error) => error.type))
          expect(new Set(verdicts.map((line) => line.decision))).toEqual(new Set([failure.final ? "stop" : "retry"]))
          assertNotSwitching(verdicts)
        },
        TURN_TIMEOUT,
      )

    test(
      "a drop right behind a tool-call delta never runs the tool twice",
      async () => {
        const server = required(fixture.server)
        const fake = fakeOf(slot)
        fake.reset()
        const session = await server.createSession({ model: slot.model, title: `wire ${slot.name} tool` })
        const events = required(fixture.events)
        // Reset only once core has started the broken call. After a fixed 50 ms the call's events were often still
        // unsent under CPU load, so core retried before any output and the broken call never existed (2026-10-14).
        const broken: WireFault = {
          type: "drop",
          reply: read("call_wire_broken"),
          after: 1,
          until: () =>
            events.waitFor(
              (event) =>
                event.type === "session.tool.input.started" &&
                event.data.sessionID === session.id &&
                event.data.id === "call_wire_broken",
              10_000,
            ),
        }
        fake.enqueue(broken, read("call_wire_again"), { type: "text", text: AFTER_TOOL })
        await capture(server, session.id)
        await turn(server, session.id, "wire failure: a drop behind a tool-call delta")
        const verdicts = await captured(server)

        const requests = fake.requests.filter(isModelRequest)
        const assistants = await assistantMessages(server, session.id)
        const calls = toolCalls(assistants, "read")
        log(
          slot,
          { name: "a drop behind a tool-call delta", fault: broken },
          requests,
          assistants,
          retries(session.id),
          {
            calls,
          },
        )
        expect(requests.map((request) => request.fault)).toEqual(["drop", undefined, undefined])
        // The broken call's input never completed, so core settled it as an error without running it; only the call
        // the next reply re-sent ran.
        expect(calls.map((call) => [call.id, call.status, call.ran])).toEqual([
          ["call_wire_broken", "error", false],
          ["call_wire_again", "completed", true],
        ])
        // The model saw the note exactly once.
        const outputs = toolOutputs(required(requests.at(-1)))
        expect(outputs.filter((output) => output.includes(NOTE_TEXT))).toHaveLength(1)
        expect(texts(assistants.at(-1))).toContain(AFTER_TOOL)
        expect(verdicts.map((line) => line.error)).toEqual(retries(session.id).map((event) => errorOf(event.data).type))
        assertNotSwitching(verdicts)
      },
      TURN_TIMEOUT,
    )
  })

test("no account was exhausted or benched and nothing failed in the hooks", async () => {
  const server = required(fixture.server)
  const events = required(fixture.events)
  expect(events.own("exhausted")).toEqual([])
  expect(events.own("switch.suggested")).toEqual([])
  const snapshot = await rpc(server, "quota.snapshot", {})
  expect(snapshot.exhausted).toEqual([])
  const accounts = await rpc(server, "accounts.list", {})
  expect(accounts).toMatchObject({
    accounts: ["acc_wirews", "acc_wiresse", "acc_wireoai", "acc_wireds"].map((id) => ({ id, status: "ready" })),
  })
  expect(server.logs()).not.toMatch(/hook_failed|switching_failed|exhaustion_record_failed/)
})

// ---------------------------------------------------------------------------------------------------------------

/** Prompts and waits until the session is idle again. */
async function turn(server: OpencodeServer, sessionID: string, text: string) {
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
}

/** The session's retries as core scheduled them (`session.retry.scheduled`). */
function retries(sessionID: string) {
  return required(fixture.events).events.filter(
    (event) => event.type === "session.retry.scheduled" && event.data.sessionID === sessionID,
  )
}

/** The `SessionError` a retry event or a failed assistant message carries. */
function errorOf(holder: Record<string, unknown> | undefined) {
  const error = isRecord(holder?.error) ? holder.error : {}
  return {
    type: String(error.type),
    message: String(error.message ?? ""),
    ...(typeof error.status === "number" ? { status: error.status } : {}),
  }
}

/**
 * own-accounts let the failure pass: the verdict its retry hook gave is the expected non-switching class for each
 * error, and nothing was exhausted or suggested.
 */
function assertNotSwitching(verdicts: ReadonlyArray<Verdict>) {
  expect(verdicts.length).toBeGreaterThan(0)
  for (const line of verdicts) expect([line.error, line.verdict]).toEqual([line.error, VERDICT[line.error]])
  const events = required(fixture.events)
  expect(events.own("exhausted")).toEqual([])
  expect(events.own("switch.suggested")).toEqual([])
}

/** What a capture window's `retry` line says of one retry hook call (capture.ts `onRetry`). */
interface Verdict {
  readonly error: string
  readonly verdict: string
  readonly decision: string
}

/** Starts a wire evidence capture window (hash mode) for the session; it ends the window of the test before. */
async function capture(server: OpencodeServer, sessionID: string) {
  await rpc(server, "diagnostics.capture.start", { mode: "hash", sessionID, minutes: 10 })
}

/** Stops the window (its lines are on disk then) and answers its `retry` lines, oldest first. */
async function captured(server: OpencodeServer): Promise<Verdict[]> {
  const status = await rpc(server, "diagnostics.capture.stop", {})
  const window = isRecord(status.window) ? status.window : {}
  const dir = String(window.dir)
  const files = Array.isArray(window.files) ? window.files.map(String) : []
  const texts = await Promise.all(
    files
      .filter((file) => !file.endsWith("windows.jsonl"))
      .map((file) => fs.readFile(path.join(dir, ...file.split("/")), "utf8")),
  )
  return texts
    .flatMap((text) => text.split("\n").filter((line) => line !== ""))
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord)
    .filter((line) => line.event === "retry")
    .toSorted((a, b) => Number(a.ts) - Number(b.ts))
    .map((line) => ({
      error: String(isRecord(line.error) ? line.error.type : ""),
      verdict: String(line.verdict),
      decision: String(line.decision),
    }))
}

function fakeOf(slot: Slot): FakeProvider {
  if (slot.fake === "codex") return required(fixture.codex)
  if (slot.fake === "responses") return required(fixture.responses)
  return required(fixture.chat)
}

/** Model requests only: Responses and chat POSTs and Codex WebSocket frames (not handshakes or model lists). */
function isModelRequest(request: RecordedRequest) {
  return request.method === "WS" || (request.method === "POST" && /\/(responses|chat\/completions)$/.test(request.path))
}

function texts(message: Record<string, unknown> | undefined) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .flatMap((part: unknown) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("")
}

/** The session's calls of `name`, oldest first: id, status, and whether the tool ran (`time.ran`). */
function toolCalls(assistants: readonly Record<string, unknown>[], name: string) {
  return assistants
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "tool" && part.name === name)
    .map((part) => ({
      id: part.id,
      status: isRecord(part.state) ? part.state.status : undefined,
      ran: isRecord(part.time) && part.time.ran !== undefined,
      error: isRecord(part.state) ? part.state.error : undefined,
    }))
}

function modelOf(message: Record<string, unknown>) {
  const model = message.model
  return isRecord(model) ? { providerID: model.providerID, id: model.id } : undefined
}

async function rpc(server: OpencodeServer, method: string, input: unknown) {
  const response = await server.request("POST", `/api/rpc/own.accounts/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const body: unknown = await response.json()
  if (response.status !== 200 || !isRecord(body) || !isRecord(body.output))
    throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body.output
}

async function sourceIdentity(authPath: string) {
  const read = await CodexSource.read(authPath)
  if (!read.ok) throw new Error(`fixture source unreadable: ${read.problem}`)
  const identity = read.snapshot.summary.identity
  if (!identity.chatgptAccountId || !identity.fingerprint) throw new Error("fixture source without identity")
  return { chatgptAccountId: identity.chatgptAccountId, fingerprint: identity.fingerprint }
}

/** With `OWN_E2E_LOGS=1`: what each scenario sent and saw, for diagnosing a wire-shape change. */
function log(
  slot: Slot,
  failure: Failure,
  requests: readonly RecordedRequest[],
  assistants: readonly Record<string, unknown>[],
  scheduled: readonly { readonly data: Record<string, unknown> }[],
  extra: Record<string, unknown> = {},
) {
  if (!process.env.OWN_E2E_LOGS) return
  console.log(
    JSON.stringify({
      slot: slot.name,
      failure: failure.name,
      requests: requests.map((request) => [request.transport, request.status, request.fault]),
      assistants: assistants.map((message) => ({ finish: message.finish, error: message.error, text: texts(message) })),
      retries: scheduled.map((event) => event.data.error),
      ...extra,
    }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
