import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnAccounts } from "@own/protocol/rpc"
import { OwnImport } from "@own/protocol/rpc-import"
import { openAICompatibleProvider } from "../../../own-accounts/test/e2e-kit"
import { ACCOUNT, MODEL, SLOT } from "../../../own-team/test/e2e/harness.js"
import { threadId } from "../fixtures/codex.js"
import { fixture, type Fixture } from "../fixtures/make.js"
import {
  bigThread,
  call,
  exported,
  finished,
  helperSessions,
  importedSessions,
  marks,
  modelsAt,
  record,
  settled,
  since,
  startMigrateServer,
  until,
  writeThread,
  type ImportOutput,
  type MigrateServer,
} from "./support.js"

/**
 * The hidden helper session of an LLM summary against the real server (09 §4.4, §4.5, §7.4 IG8): `agents.compaction.model`
 * names the DeepSeek key, a metered model, so own.accounts keeps it and core summarizes there instead of on the target
 * (`summarizer_overridden`). The helper is an archived session whose manual compaction core still runs (pinned here),
 * and it is removed afterwards; a service killed during that compaction leaves no helper once own.import activated
 * again, and own.accounts records the usage of a request core's recovery sent meanwhile. A target whose compaction is
 * native is refused for an LLM summary. Every model call is answered by a local fake (own-team's harness). Run from
 * `packages/own-import`: `bun run test:e2e`.
 */

const BOOT = 300_000
const LONG = 300_000

// The smallest Codex window (272k) since upstream v2.1 dropped gpt-5.5 and older, spark included, for ChatGPT accounts.
const SPARK = { providerID: SLOT["01"], id: "gpt-5.6-cyber" } as const
/** A config provider whose model compacts natively (`settings.compaction.type: native`, 09 §4.5). */
const NATIVE = { providerID: "nativechat", id: "native-coder" } as const
/** The fake's answer to the helper's compaction: core takes a summary only in its template. */
const SUMMARY = ["## Objective", "- SUMMARY-FIXTURE: written by the helper's summarizer."].join("\n")
const BIG = 31

const state = {} as {
  fixture: Fixture
  run: MigrateServer
  folder: string
  ref: OwnImport.SourceRef
}

beforeAll(async () => {
  state.fixture = await fixture({ under: "helper roots" })
  state.run = await startMigrateServer({
    name: "import-helper",
    fixture: state.fixture,
    config: { agents: { compaction: { model: `${MODEL.deepseek.providerID}/${MODEL.deepseek.id}` } } },
    providers: (local) => ({
      [NATIVE.providerID]: openAICompatibleProvider(local, {
        apiKey: "fake-own-import-native-key",
        models: {
          [NATIVE.id]: {
            name: "Native coder",
            limit: { context: 64_000, output: 8_000 },
            capabilities: { tools: true },
          },
        },
        settings: { compaction: { type: "native" } },
      }),
    }),
  })
  state.folder = state.run.projects.first
  // About 260k tokens: over gpt-5.6-cyber's 231,200 ceiling, so the plan needs a summary.
  await writeThread(state.fixture.codex, BIG, bigThread(BIG, state.folder, 40, 25_000))
  await record(state.run.server, state.folder)
  await modelsAt(state.run.server, [SPARK, NATIVE, MODEL.deepseek], state.folder)
  const listed = await settled(state.run.server, { directory: state.folder })
  const found = listed.items.find((item) => item.ref.id === threadId(BIG))
  if (found === undefined) throw new Error("the conversation is not listed")
  state.ref = found.ref
}, BOOT)

afterAll(async () => {
  await state.run?.stop()
  await state.fixture?.cleanup()
}, LONG)

type Plan = ImportOutput<"migrate.plan">

function plan(target: { readonly providerID: string; readonly id: string }, more: object = {}) {
  return call(state.run.server, "migrate.plan", { ref: state.ref, directory: state.folder, target, ...more })
}

function row(planned: Plan, mode: OwnImport.Mode, source?: OwnImport.SummarySource) {
  const found = planned.modes.find((item) => item.mode === mode && item.source === source)
  if (found === undefined) throw new Error(`no ${mode}/${source ?? "-"} row`)
  return found
}

const decodeSession = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
      time: Schema.Struct({ archived: optional(Schema.Finite) }),
    }),
  }),
)

/** A session's metadata and archive time as `session.get` answers them; `undefined` once it is gone. */
async function session(sessionID: string) {
  const response = await state.run.server.server.request("GET", `/api/session/${sessionID}`)
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`session.get ${sessionID}: ${response.status}`)
  return decodeSession(await response.json()).data
}

/** own.accounts' ledger lines of a session (`ledger.session`): its requests' usage, by account (02 §9.2). */
async function ledger(sessionID: string) {
  const answer = await state.run.server.rpc(OwnAccounts.ID, "ledger.session", { sessionID })
  if (answer.status !== 200) throw new Error(`ledger.session: ${answer.status} ${answer.type ?? ""}`)
  const checked = await OwnAccounts.Definition.methods["ledger.session"].output["~standard"].validate(answer.output)
  if (checked.issues) throw new Error("ledger.session does not decode")
  return checked.value.steps
}

/** The helper session a job's `job.progress{summarizing}` named. */
async function helperOf(jobID: string) {
  const event = await state.run.server.events.waitFor(
    (item) =>
      item.type === "rpc.own.import.job.progress" && item.data.jobID === jobID && item.data.step === "summarizing",
    60_000,
  )
  const helper = event.data.helperSessionID
  if (typeof helper !== "string") throw new Error("job.progress named no helper")
  return helper
}

describe("the helper session (IG8)", () => {
  test("agents.compaction.model summarizes instead of the target and the plan says so", async () => {
    const planned = await plan(SPARK)
    expect(planned.summarizer?.overridden).toBe(true)
    expect([String(planned.summarizer?.model.providerID), String(planned.summarizer?.model.id)]).toEqual([
      MODEL.deepseek.providerID,
      MODEL.deepseek.id,
    ])
    expect(planned.warnings).toContain("summarizer_overridden")
    const llm = row(planned, "summary", "llm")
    expect([llm.available, llm.recommended]).toEqual([true, true])
    // The summary goes to another company than the tool's: `다른 회사` on that row (09 §4.5).
    expect(llm.send.crossCompany).toBe(true)
    expect(llm.send.now).toBeGreaterThan(0)
  })

  test(
    "the archived helper's manual compaction runs on the summarizer, its usage is recorded, and it is removed",
    async () => {
      const server = state.run.server
      const planned = await plan(SPARK)
      state.run.fakes.deepseek.enqueue({ type: "text", text: SUMMARY, delayMs: 3_000 })
      const from = marks(state.run)
      const started = await call(server, "migrate.execute", { nonce: planned.nonce })
      const helper = await helperOf(started.jobID)
      // Core does not treat archived sessions apart: the helper is archived and its compaction runs (09 §4.4, IG8).
      await until(async () => (await session(helper)) !== undefined, "the helper was never imported")
      const running = await session(helper)
      expect(running?.time.archived).toBeGreaterThan(0)
      expect(OwnImport.decodeMetadata(running?.metadata)).toEqual({ v: 1, helper: true, jobID: started.jobID })
      const done = await finished(server, started.jobID)
      expect(done.outcome).toBe("succeeded")
      const sent = since(state.run, from)
      expect([sent.deepseek?.length, sent.codex?.length, sent.anthropic?.length, sent.local?.length]).toEqual([
        1, 0, 0, 0,
      ])
      expect(await session(helper)).toBeUndefined()
      expect(await helperSessions(server)).toEqual([])
      const data = await exported(server, done.sessionID ?? "")
      const checkpoint = data.messages.findLast((message) => message.type === "compaction")
      if (checkpoint?.type !== "compaction" || checkpoint.status !== "completed") throw new Error("no checkpoint")
      expect(checkpoint.summary).toContain(SUMMARY)
      expect([String(checkpoint.model?.providerID), String(checkpoint.model?.id)]).toEqual([
        MODEL.deepseek.providerID,
        MODEL.deepseek.id,
      ])
      // The summary's usage stays in own.accounts' account ledger after the helper is gone (09 §4.4 사용량 기록, Q1).
      await until(
        async () => (await ledger(helper)).some((line) => line.accountID === ACCOUNT.deepseek),
        "the summary's usage was not recorded",
      )
    },
    LONG,
  )

  test(
    "a kill-restart during the helper's compaction leaves no helper after activation; recovery usage is recorded",
    async () => {
      const server = state.run.server
      const imported = (await importedSessions(server)).length
      const planned = await plan(SPARK)
      // The compaction request is held at the fake while the service is killed.
      state.run.fakes.deepseek.enqueue({ type: "text", text: SUMMARY, delayMs: 120_000 })
      const from = marks(state.run)
      const started = await call(server, "migrate.execute", { nonce: planned.nonce })
      const helper = await helperOf(started.jobID)
      await until(
        () => (since(state.run, from).deepseek?.length ?? 0) > 0,
        "the summary never reached the fake",
        60_000,
      )
      // A request core's recovery sends after the restart is answered at once.
      state.run.fakes.deepseek.enqueue({ type: "text", text: SUMMARY })
      const killed = marks(state.run)
      await server.restart({ kill: true })
      await until(async () => (await helperSessions(server)).length === 0, "a helper is left after activation", 60_000)
      expect(await session(helper)).toBeUndefined()
      // own.import's activation cleanup removed it (`rpc.ts` `cleanup`), not the job that died.
      await until(
        () => server.server.logs().includes('"msg":"helpers_removed"'),
        "the activation cleanup did not report the helper",
        30_000,
      )
      // The job died with the service: nothing runs and nothing was imported (09 §4.8 서비스 재시작).
      expect(await call(server, "jobs.list", {})).toEqual({ jobs: [] })
      expect((await importedSessions(server)).length).toBe(imported)
      const recovered = since(state.run, killed).deepseek ?? []
      // Core's recovery may have resent the summary before own.import's cleanup ran (⚠IG8): its usage is recorded.
      if (recovered.some((request) => request.status === 200))
        await until(
          async () => (await ledger(helper)).some((line) => line.accountID === ACCOUNT.deepseek),
          "the recovery request's usage was not recorded",
        )
      process.stderr.write(`IG8 kill-restart: ${recovered.length} recovery request(s) after the restart\n`)
    },
    LONG,
  )

  test("a target that compacts natively cannot summarize with an LLM", async () => {
    // The restart above made the folder's Location anew: its providers load again.
    await modelsAt(state.run.server, [NATIVE], state.folder)
    const planned = await plan(NATIVE)
    expect(planned.summarizer).toBeNull()
    expect(row(planned, "full")).toMatchObject({ available: false, reason: "does_not_fit" })
    expect(row(planned, "summary", "llm")).toMatchObject({ available: false, reason: "native_compaction" })
    expect(row(planned, "summary", "brief")).toMatchObject({ available: true, recommended: true })
  })
})
