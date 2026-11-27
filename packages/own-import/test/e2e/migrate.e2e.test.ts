import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Compaction } from "@own/protocol/compaction"
import { OwnAccounts } from "@own/protocol/rpc"
import { OwnImport } from "@own/protocol/rpc-import"
import { requestItems, type RecordedRequest } from "../../../own-accounts/test/e2e-kit"
import { ACCOUNT, CLAUDE, MODEL, SLOT, codexIdentity, same } from "../../../own-team/test/e2e/harness.js"
import { Store } from "../../src/render/store.js"
import { Brief } from "../../src/transcript/brief.js"
import { threadId } from "../fixtures/codex.js"
import { FAKE, fixture, type Fixture } from "../fixtures/make.js"
import {
  CONTENT_MARK,
  LOCAL,
  bigThread,
  call,
  containing,
  exported,
  finished,
  helperSessions,
  importedSessions,
  jobEvents,
  marks,
  measureZ,
  modelsAt,
  record,
  remoteThread,
  runJob,
  settled,
  since,
  smallThread,
  startMigrateServer,
  until,
  writeThread,
  type ImportOutput,
  type MigrateServer,
} from "./support.js"

/**
 * own.import I2 against the real server (09 §4, §5.2–5.4, §7.4 IG7, IG9, IG10, IG12): `migrate.plan`, `migrate.execute`,
 * `migrate.cancel` and `jobs.list` over synthetic Codex conversations, every model call answered by a local fake
 * (own-team's harness: ChatGPT 01–03 on one fake Codex backend, DeepSeek and Anthropic keys, the Claude subscription
 * slot through the fake claude-auth shim, and a local openai-chat provider). The small-window target is ChatGPT 01's
 * `gpt-5.6-cyber` (272k input, the smallest Codex window since upstream v2.1 dropped gpt-5.5 and older, spark included,
 * for ChatGPT accounts): its Z is measured first by ordinary turns, so a plan sizes with the real system
 * and tools. `agents.compaction.model` names ChatGPT 02, another subscription of the target's company (R4):
 * no summary may ever run there. Run from `packages/own-import`: `bun run test:e2e`.
 */

const BOOT = 300_000
const LONG = 300_000

const SPARK = { providerID: SLOT["01"], id: "gpt-5.6-cyber" } as const
const SECRETS = { apiKey: FAKE.apiKey, github: FAKE.github }
/** The fake Codex backend's answer to the helper's compaction: core takes a summary only in its template. */
const SUMMARY = ["## Objective", "- SUMMARY-FIXTURE: the installer work is planned; tests pass."].join("\n")

/** Conversations (Codex thread numbers). */
const SMALL = 21
const BIG = 22
const REMOTE = 23
const CHANGING = 24

const state = {} as {
  fixture: Fixture
  run: MigrateServer
  folder: string
  refs: Map<string, OwnImport.SourceRef>
}

beforeAll(async () => {
  state.fixture = await fixture({ under: "migrate roots" })
  state.run = await startMigrateServer({
    name: "import-migrate",
    fixture: state.fixture,
    config: { agents: { compaction: { model: `${SLOT["02"]}/gpt-5.6-sol` } } },
  })
  const server = state.run.server
  state.folder = state.run.projects.first
  const codex = state.fixture.codex
  await writeThread(codex, SMALL, smallThread(SMALL, state.folder, SECRETS))
  // Sized over gpt-5.6-cyber's 231,200 ceiling (272k window), as the 10k-character turns were over spark's 100k.
  await writeThread(codex, BIG, bigThread(BIG, state.folder, 40, 25_000))
  await writeThread(codex, REMOTE, remoteThread(REMOTE, state.folder, 30, 6, 35_000))
  await writeThread(codex, CHANGING, smallThread(CHANGING, state.folder, SECRETS))
  await record(server, state.folder)
  await modelsAt(server, [SPARK, LOCAL, MODEL.deepseek, MODEL.anthropic, CLAUDE.model], state.folder)
  // Ordinary turns on the small-window slot: own.accounts measures its Z (09 §4.3, §5.6).
  expect((await measureZ(server, SPARK, state.folder)).zSource).toBe("measured")
  const listed = await settled(server, { directory: state.folder })
  state.refs = new Map(listed.items.map((item) => [String(item.ref.id), item.ref]))
}, BOOT)

afterAll(async () => {
  await state.run?.stop()
  await state.fixture?.cleanup()
}, LONG)

// ---------------------------------------------------------------------------------------------------------------
// Helpers

type Plan = ImportOutput<"migrate.plan">

function refOf(n: number) {
  const ref = state.refs.get(threadId(n))
  if (ref === undefined) throw new Error(`thread ${n} is not listed`)
  return ref
}

function plan(n: number, target: { readonly providerID: string; readonly id: string }, more: object = {}) {
  return call(state.run.server, "migrate.plan", { ref: refOf(n), directory: state.folder, target, ...more })
}

function row(planned: Plan, mode: OwnImport.Mode, source?: OwnImport.SummarySource) {
  const found = planned.modes.find((item) => item.mode === mode && item.source === source)
  if (found === undefined) throw new Error(`no ${mode}/${source ?? "-"} row`)
  return found
}

/** The `[redacted:<8 hex>]` marker of log redaction, which must never reach a model (09 §4.2). */
const HASH_MARKER = /\[redacted:[0-9a-f]{8}\]/

/** Items of a model request that are tool calls or results in any wire format (Responses, chat, Anthropic). */
function toolItems(request: RecordedRequest) {
  return requestItems(request).filter((item) => {
    const text = JSON.stringify(item) ?? ""
    return (
      /"type":"(?:function_call|function_call_output|custom_tool_call|custom_tool_call_output|tool_use|tool_result)"/.test(
        text,
      ) ||
      /"role":"tool"/.test(text) ||
      /"tool_calls":\[\{/.test(text)
    )
  })
}

/** The roles of the request items that carry imported tool records (not the notice that names their tag). */
function recordRoles(request: RecordedRequest) {
  return requestItems(request).flatMap((item) => {
    const text = JSON.stringify(item) ?? ""
    if (!text.includes(Store.ACTIVITY_INTRO)) return []
    const role = /"role":"([a-z]+)"/.exec(text)?.[1]
    return [role ?? "none"]
  })
}

/** The first follow-up of an imported session: exactly one model request, answered. */
async function followUp(sessionID: string, text = "이어서 진행해 줘") {
  const from = marks(state.run)
  await state.run.server.turn(sessionID, text)
  const requests = Object.values(since(state.run, from)).flat()
  expect(requests.map((request) => request.status)).toEqual([200])
  return requests[0]
}

async function compactions(sessionID: string) {
  return (await exported(state.run.server, sessionID)).messages.filter((message) => message.type === "compaction")
}

// ---------------------------------------------------------------------------------------------------------------

describe("own.import I2 through the server", () => {
  test("health offers migrate and no job runs", async () => {
    expect((await call(state.run.server, "health", {})).features).toEqual(["view", "search", "migrate", "skills"])
    expect(await call(state.run.server, "jobs.list", {})).toEqual({ jobs: [] })
  })

  test(
    "IG7, IG10: a small conversation moves as it is; the first follow-up sees no foreign tool part",
    async () => {
      const server = state.run.server
      const planned = await plan(SMALL, MODEL["01"])
      expect([row(planned, "full").available, row(planned, "full").recommended]).toEqual([true, true])
      expect(row(planned, "summary", "llm").reason).toBe("fits")
      // IG10: the send notice on every row, and the two fake secrets counted.
      for (const mode of planned.modes)
        expect(mode.send).toMatchObject({ accountID: ACCOUNT["01"], company: "openai", crossCompany: false })
      expect(row(planned, "full").send.withFirst).toBeGreaterThan(0)
      expect(planned.redactions).toBe(2)
      expect(planned.warnings).not.toContain("cross_company")

      const done = await runJob(server, planned.nonce)
      expect(done.outcome).toBe("succeeded")
      const sessionID = done.sessionID ?? ""
      const events = jobEvents(server, done.jobID)
      expect(
        events.map((item) => [item.type.replace("rpc.own.import.", ""), item.data.step ?? item.data.outcome]),
      ).toEqual([
        ["job.progress", "reading"],
        ["job.progress", "importing"],
        ["job.finished", "succeeded"],
      ])
      // Only the control Location's instance publishes (09 §5.3).
      expect(events.every((item) => same(item.location?.directory ?? "", server.control))).toBe(true)

      // IG7: the stored transcript decodes; no provider state, reasoning, usage or tool part; secrets by name only.
      const data = await exported(server, sessionID)
      expect(OwnImport.decodeMetadata(data.info.metadata)).toMatchObject({
        kind: "codex",
        sourceID: threadId(SMALL),
        mode: "full",
        checkpoint: null,
        storedFull: true,
        redactions: 2,
      })
      const stored = JSON.stringify(data.messages)
      expect(stored).not.toContain(FAKE.apiKey)
      expect(stored).not.toContain(FAKE.github)
      expect(stored).toContain("[redacted:API key]")
      expect(stored).toContain("[redacted:GitHub token]")
      expect(stored).not.toMatch(HASH_MARKER)
      expect(stored).not.toContain("providerState")
      for (const message of data.messages.filter((item) => item.type === "assistant"))
        expect(JSON.stringify(message)).not.toMatch(/"type":"(?:tool|reasoning)"/)

      const first = await followUp(sessionID)
      expect(first.identity).toBe(codexIdentity("01"))
      expect(toolItems(first)).toEqual([])
      expect(recordRoles(first).length).toBeGreaterThan(0)
      expect(new Set(recordRoles(first))).toEqual(new Set(["user"]))
      expect(first.body).not.toMatch(HASH_MARKER)
      expect(first.body).not.toContain(FAKE.apiKey)
      expect(first.body).toContain("[redacted:API key]")
      // The import notice is the last thing the model reads of the history (09 §4.2).
      expect(first.body).toContain("The conversation above was imported from Codex.")
    },
    LONG,
  )

  test(
    "09 §5.5: the viewer and both searches show a secret by its name only",
    async () => {
      const server = state.run.server
      const ref = refOf(SMALL)
      const read = JSON.stringify(await call(server, "sessions.read", { ref, directory: state.folder }))
      expect([read.includes(FAKE.apiKey), read.includes(FAKE.github)]).toEqual([false, false])
      expect([read.includes("[redacted:API key]"), read.includes("[redacted:GitHub token]")]).toEqual([true, true])
      const one = await call(server, "sessions.search", { directory: state.folder, ref, query: "OPENAI_API_KEY" })
      expect(one.hits.map((hit) => hit.snippet.includes("[redacted:API key]"))).toEqual([true])
      // A query that only matched inside a secret finds nothing.
      expect(
        (await call(server, "sessions.search", { directory: state.folder, ref, query: "FAKE0000own0import" })).hits,
      ).toEqual([])
      const folder = await call(server, "sessions.search", { directory: state.folder, query: "토큰은 지워" })
      expect(folder.hits.length).toBeGreaterThan(0)
      expect(folder.hits.map((hit) => [hit.snippet.includes(FAKE.github), hit.snippet.includes("[redacted:")])).toEqual(
        folder.hits.map(() => [false, true]),
      )
    },
    LONG,
  )

  test(
    "IG7: two imports of the same conversation send the same model-visible bytes; own.accounts answers for them",
    async () => {
      const server = state.run.server
      // One job at a time (09 §4.8): the second import starts after the first ended.
      const sent: Array<{ readonly sessionID: string; readonly outcome: string; readonly existing: string[] }> = []
      for (const _ of [0, 1]) {
        const planned = await plan(SMALL, MODEL["01"])
        const done = await runJob(server, planned.nonce)
        sent.push({
          sessionID: done.sessionID ?? "",
          outcome: done.outcome,
          existing: planned.existing.map((item) => item.sessionID),
        })
      }
      expect(sent.map((item) => item.outcome)).toEqual(["succeeded", "succeeded"])
      // A plan right after an import already names it (09 §4.7 열기 / 새로 가져오기).
      expect(sent[1].existing).toContain(sent[0].sessionID)
      const requests: Array<{ readonly sessionID: string; readonly request: RecordedRequest }> = []
      for (const item of sent) requests.push({ sessionID: item.sessionID, request: await followUp(item.sessionID) })
      const visible = requests.map((item) =>
        JSON.stringify(requestItems(item.request)).replaceAll(item.sessionID, "<session>"),
      )
      expect(visible[0]).toBe(visible[1])
      // The display providerID (`codex-cli`) of the imported assistant messages breaks none of these (IG7 ⚠).
      for (const method of ["cache.state", "ledger.session", "switch.state"]) {
        const answer = await server.rpc(OwnAccounts.ID, method, { sessionID: sent[0].sessionID })
        expect([method, answer.status]).toEqual([method, 200])
      }
    },
    LONG,
  )
  test(
    "IG12: the first follow-up succeeds on every slot kind the fakes answer; own.accounts measures no Z from it",
    async () => {
      const server = state.run.server
      // ChatGPT (`codex`) is the IG7 case above.
      const kinds = [
        { kind: "ds", target: MODEL.deepseek, fake: "deepseek" },
        { kind: "anth", target: MODEL.anthropic, fake: "anthropic" },
        { kind: "claude-sub", target: CLAUDE.model, fake: "anthropic" },
        { kind: "local", target: LOCAL, fake: "local" },
      ] as const
      for (const item of kinds) {
        const planned = await plan(SMALL, item.target)
        expect([item.kind, row(planned, "full").available]).toEqual([item.kind, true])
        // Another company than the tool's: `다른 회사` whatever the row (09 §4.5).
        expect([item.kind, planned.warnings.includes("cross_company")]).toEqual([item.kind, true])
        expect([item.kind, planned.modes.every((mode) => mode.send.crossCompany)]).toEqual([item.kind, true])
        const done = await runJob(server, planned.nonce)
        expect([item.kind, done.outcome]).toEqual([item.kind, "succeeded"])
        const from = marks(state.run)
        await server.turn(done.sessionID ?? "", "이어서 진행해 줘")
        const sent = since(state.run, from)
        expect([item.kind, sent[item.fake]?.map((request) => request.status)]).toEqual([item.kind, [200]])
        const first = sent[item.fake]?.[0]
        if (first === undefined) throw new Error(`${item.kind}: no request`)
        expect([item.kind, toolItems(first)]).toEqual([item.kind, []])
        expect([item.kind, [...new Set(recordRoles(first))]]).toEqual([item.kind, ["user"]])
        expect([item.kind, HASH_MARKER.test(first.body)]).toEqual([item.kind, false])
      }
      // No ordinary session ran on the DeepSeek slot yet: the imported ones, which ran at `state.folder`, left its Z
      // unmeasured (09 §4.2, IG7), at the control Location (the slot's samples are the process's, 09 §5.6) and at the
      // folder alike, while ordinary turns there are measured.
      for (const directory of [undefined, state.folder]) {
        const estimated = await server.accounts("estimate.request", { target: MODEL.deepseek, requests: [] }, directory)
        expect({ directory, zSource: estimated.zSource }).toEqual({ directory, zSource: "default" })
      }
      expect((await measureZ(server, MODEL.deepseek, state.folder)).zSource).toBe("measured")
    },
    LONG,
  )

  // own-team's harness points `siwc` slots at an OpenAI endpoint that answers 404 and seeds no `oai` key, so no fake
  // answers these kinds: IG12 records them as not covered (the real part is user-run, 09 §7.4).
  test.todo("IG12: siwc and oai slots (no answering fake in the e2e kit: not covered)", () => {})

  test(
    "IG9: past a Codex remote compaction 그대로 fills across the boundary up to C, with no LLM call and no compaction after",
    async () => {
      const server = state.run.server
      const planned = await plan(REMOTE, SPARK)
      expect(planned.size.zSource).toBe("measured")
      expect(planned.boundary.checkpoint).toBe("codex-remote")
      const full = row(planned, "full")
      expect([full.available, full.recommended, full.send.now]).toEqual([true, true, 0])
      // `전체 기록 요약` stays a choice, never the default (09 §4.3).
      expect(row(planned, "summary", "llm").recommended).toBe(false)
      const tail = planned.size.tail
      if (tail === undefined) throw new Error("no fill")
      // The remote compaction stands after turn 29: the fill crossed it.
      expect(tail.fromTurn).toBeLessThan(29)
      expect(tail.fromTurn).toBeGreaterThan(0)
      expect(tail.tokens).toBeLessThanOrEqual(planned.size.capacity)
      expect(planned.size.ratio).toBeLessThanOrEqual(1)

      const from = marks(state.run)
      const done = await runJob(server, planned.nonce)
      expect(done.outcome).toBe("succeeded")
      expect(Object.values(since(state.run, from)).flat()).toEqual([])
      const sessionID = done.sessionID ?? ""
      const data = await exported(server, sessionID)
      expect(OwnImport.decodeMetadata(data.info.metadata)).toMatchObject({ mode: "full", checkpoint: "codex-remote" })
      const checkpoint = data.messages.findLast((message) => message.type === "compaction")
      if (checkpoint?.type !== "compaction" || checkpoint.status !== "completed") throw new Error("no checkpoint")
      expect(checkpoint.summary).toContain(Brief.HEADER)
      expect(checkpoint.model).toBeUndefined()
      const before = (await compactions(sessionID)).length
      await followUp(sessionID)
      expect((await compactions(sessionID)).length).toBe(before)
    },
    LONG,
  )

  test(
    "IG9, R4: 요약해서 이어가기 keeps the tail verbatim up to C and summarizes the rest once, on the target's account",
    async () => {
      const server = state.run.server
      const planned = await plan(BIG, SPARK)
      expect(row(planned, "full")).toMatchObject({ available: false, reason: "does_not_fit" })
      const llm = row(planned, "summary", "llm")
      expect([llm.available, llm.recommended]).toEqual([true, true])
      expect(llm.send.now).toBeGreaterThan(0)
      expect(row(planned, "summary", "brief").available).toBe(true)
      // `agents.compaction.model` names ChatGPT 02, another subscription of the target's company: own.accounts drops
      // it from the hidden agent, so the target summarizes (09 §4.5, 07 R4).
      const summarizer = planned.summarizer
      expect([String(summarizer?.model.providerID), String(summarizer?.model.id), summarizer?.overridden]).toEqual([
        SPARK.providerID,
        SPARK.id,
        false,
      ])
      const tail = planned.size.tail
      if (tail === undefined) throw new Error("no tail")
      // The tail fills the window up to C, far more than core's `keep` (07 R8, IG9).
      expect(tail.tokens).toBeGreaterThan(Compaction.KEEP_TOKENS)
      expect(tail.tokens).toBeLessThanOrEqual(planned.size.capacity)

      state.run.fakes.codex.enqueue({ type: "text", text: SUMMARY })
      const from = marks(state.run)
      const done = await runJob(server, planned.nonce)
      expect(done.outcome).toBe("succeeded")
      const sent = since(state.run, from)
      expect(sent.codex?.map((request) => request.identity)).toEqual([codexIdentity("01")])
      expect([sent.deepseek, sent.anthropic, sent.local].flat()).toEqual([])
      const sessionID = done.sessionID ?? ""
      const data = await exported(server, sessionID)
      expect(OwnImport.decodeMetadata(data.info.metadata)).toMatchObject({
        mode: "summary",
        checkpoint: "llm",
        summarizer: { providerID: SPARK.providerID, id: SPARK.id },
        tailFromTurn: tail.fromTurn,
      })
      const at = data.messages.findLastIndex((message) => message.type === "compaction")
      const checkpoint = data.messages[at]
      if (checkpoint?.type !== "compaction" || checkpoint.status !== "completed") throw new Error("no checkpoint")
      expect(checkpoint.summary).toContain(SUMMARY)
      expect(checkpoint.summary).toContain(Brief.HEADER)
      expect(checkpoint.reason).toBe("manual")
      const users = data.messages.slice(at + 1).flatMap((message) => (message.type === "user" ? [message.text] : []))
      expect(users[0]).toBe(`질문 ${tail.fromTurn}`)
      expect(users).toHaveLength(40 - tail.fromTurn)
      expect(await helperSessions(server)).toEqual([])
      const before = (await compactions(sessionID)).length
      await followUp(sessionID)
      expect((await compactions(sessionID)).length).toBe(before)
    },
    LONG,
  )

  test(
    "IG9: a failed summary ends the job; nothing is retried on any account and nothing is imported",
    async () => {
      const server = state.run.server
      const before = (await importedSessions(server)).length
      const planned = await plan(BIG, SPARK, { mode: "summary", source: "llm" })
      state.run.fakes.codex.enqueue({
        type: "error",
        status: 400,
        body: { error: { type: "invalid_request_error", message: "fixture: the summary request is refused" } },
      })
      const from = marks(state.run)
      const done = await runJob(server, planned.nonce)
      expect(done.outcome).toBe("failed")
      expect(done.error?.type).toBe("summary_failed")
      await Bun.sleep(3_000)
      const sent = since(state.run, from)
      expect(sent.codex?.length).toBeGreaterThan(0)
      expect([...new Set(sent.codex?.map((request) => request.identity))]).toEqual([codexIdentity("01")])
      expect([sent.deepseek, sent.anthropic, sent.local].flat()).toEqual([])
      expect(await helperSessions(server)).toEqual([])
      expect((await importedSessions(server)).length).toBe(before)
    },
    LONG,
  )

  test(
    "09 §4.8: job_busy while a summary runs, a cancel before the import leaves nothing, a used nonce is refused",
    async () => {
      const server = state.run.server
      const slow = await plan(BIG, SPARK, { mode: "summary", source: "llm" })
      const quick = await plan(SMALL, MODEL["01"])
      const before = (await importedSessions(server)).length
      state.run.fakes.codex.enqueue({ type: "text", text: SUMMARY, delayMs: 60_000 })
      const from = marks(state.run)
      const started = await call(server, "migrate.execute", { nonce: slow.nonce })
      await until(
        () => (since(state.run, from).codex?.length ?? 0) > 0,
        "the summary request never reached the fake",
        60_000,
      )
      const listed = await call(server, "jobs.list", {})
      expect(listed.jobs.map((job) => [job.jobID, job.step, job.sessionID === undefined])).toEqual([
        [started.jobID, "summarizing", false],
      ])
      const busy = await server.rpc(OwnImport.ID, "migrate.execute", { nonce: quick.nonce })
      expect([busy.status, busy.type, busy.data]).toEqual([400, "job_busy", { jobID: started.jobID }])
      expect(await call(server, "migrate.cancel", { jobID: started.jobID })).toEqual({ cancelled: true })
      expect((await finished(server, started.jobID)).outcome).toBe("cancelled")
      expect(await helperSessions(server)).toEqual([])
      expect((await importedSessions(server)).length).toBe(before)
      expect(await call(server, "jobs.list", {})).toEqual({ jobs: [] })
      // The busy answer left the other plan valid; once used, its nonce is refused.
      expect((await runJob(server, quick.nonce)).outcome).toBe("succeeded")
      const reused = await server.rpc(OwnImport.ID, "migrate.execute", { nonce: quick.nonce })
      expect([reused.status, reused.type]).toEqual([400, "nonce_invalid"])
      const gone = await server.rpc(OwnImport.ID, "migrate.cancel", { jobID: started.jobID })
      expect([gone.status, gone.type]).toEqual([400, "job_not_found"])
    },
    LONG,
  )

  test(
    "09 §4.8: a conversation rewritten between the plan and the job ends it with source_changed",
    async () => {
      const server = state.run.server
      const before = (await importedSessions(server)).length
      const planned = await plan(CHANGING, MODEL["01"])
      await writeThread(
        state.fixture.codex,
        CHANGING,
        smallThread(CHANGING, state.folder, { apiKey: FAKE.apiKey, github: "rewritten request" }),
      )
      const done = await runJob(server, planned.nonce)
      expect([done.outcome, done.error?.type]).toEqual(["failed", "source_changed"])
      expect((await importedSessions(server)).length).toBe(before)
    },
    LONG,
  )

  test(
    "IG10: no conversation text or fake secret in OWN_HOME, import-index.json or own.import's log lines",
    async () => {
      const server = state.run.server
      const home = server.ownHome
      await until(() => Bun.file(path.join(home, "state", "import-index.json")).exists(), "no import-index.json")
      const needles = [CONTENT_MARK, FAKE.apiKey, FAKE.github, "설치기를 정리해 줘", "lorem ipsum dolor"]
      expect(await containing(home, needles)).toEqual([])
      const lines = server.server
        .logs()
        .split(/\r?\n/)
        .filter((line) => line.includes('"scope":"own.import"'))
      expect(needles.filter((needle) => lines.some((line) => line.includes(needle)))).toEqual([])
    },
    LONG,
  )
})
