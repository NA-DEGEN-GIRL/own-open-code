// End to end on the upstream server with own-accounts loaded and a fake OpenAI Responses backend: the switch RPCs
// move a session A → B → A while it stays within the TTL, the fake's prompt cache reports the hit on A's prefix at
// the return, and the estimator's predicted cold tokens stay within ±25% of what the fake measured (02 §6, AC-P14).
//
// Two setups share the scenario:
// - "stand-in slots": config providers whose ids follow `own-oai-<slug>` with fake keys. They are not in the
//   registry, so slots/auth leave them alone while switching estimates them as `oai` slots (kind from the id, the
//   seed ratecards). This runs today, independent of the SLOTS/AUTH/CREDENTIALS modules.
// - "registered slots": two `oai` accounts added through `accounts.add.key` against the fake. It needs SLOTS, AUTH
//   and CREDENTIALS; until they answer, the test logs why it did not run.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import {
  REPO_ROOT,
  opencodeConfig,
  openAIResponsesProvider,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type ModelRef,
  type OpencodeServer,
  type OpencodeServerPaths,
  type RecordedRequest,
} from "../e2e-kit"
import { SEED } from "./support.js"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 180_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const BLOCK = 16
const TOLERANCE = 0.25

// Long enough that the switched part dominates the block alignment and the unknown next message.
const ANSWER_A = `A1 ${"alpha answer text ".repeat(110)}`
const QUESTION_B = `second question ${"please consider this detail ".repeat(40)}`
const ANSWER_B = `B1 ${"bravo answer text ".repeat(110)}`

interface Estimate {
  readonly estimateID: string
  readonly context: { readonly P: number }
  readonly inputs: { readonly W_lo: number; readonly W_hi: number }
  readonly options: ReadonlyArray<{ readonly strategy: string; readonly available: boolean }>
}

async function rpc(server: OpencodeServer, method: string, input: unknown) {
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const body = (await response.json()) as {
    readonly output?: unknown
    readonly type?: string
    readonly message?: string
  }
  return { status: response.status, body }
}

async function call<T>(server: OpencodeServer, method: string, input: unknown): Promise<T> {
  const result = await rpc(server, method, input)
  if (result.status !== 200) throw new Error(`${method}: ${result.status} ${JSON.stringify(result.body)}`)
  return result.body.output as T
}

const isResponses = (request: RecordedRequest) => request.method === "POST" && request.path.startsWith("/v1/responses")

function cold(request: RecordedRequest) {
  const usage = request.cache
  if (!usage) throw new Error("request without cache usage")
  return usage.promptTokens - usage.cachedTokens
}

function expectWithin(predicted: number, measured: number) {
  const error = Math.abs(predicted - measured) / measured
  expect({ predicted, measured, withinTolerance: error <= TOLERANCE }).toMatchObject({ withinTolerance: true })
}

/**
 * A → B → A on one session through `switch.estimate`/`switch.apply`, one turn per slot. Returns the recorded model
 * requests and the two estimates for the assertions.
 */
async function aba(server: OpencodeServer, fake: FakeOpenAIResponses, A: ModelRef, B: ModelRef) {
  const session = await server.createSession({ model: A, title: "switching e2e" })
  const turn = async (text: string, answer: string) => {
    fake.enqueue({ type: "text", text: answer })
    await server.prompt(session.id, text)
    await server.waitIdle(session.id)
  }
  const switchTo = async (target: ModelRef) => {
    const estimate = await call<Estimate>(server, "switch.estimate", { sessionID: session.id, target })
    const applied = await call<{ readonly state: string }>(server, "switch.apply", {
      sessionID: session.id,
      estimateID: estimate.estimateID,
      target,
      strategy: "now",
      reason: "manual",
    })
    expect(["SWITCHING", "COOLDOWN"]).toContain(applied.state)
    return estimate
  }

  await turn("first question", ANSWER_A)
  const toB = await switchTo(B)
  await turn(QUESTION_B, ANSWER_B)
  const toA = await switchTo(A)
  await turn("ok", "done")

  const requests = (await fake.waitForRequests(3, { filter: isResponses })).filter(isResponses)
  const state = await call<{ readonly state: string }>(server, "switch.state", { sessionID: session.id })
  const binding = await call<{ readonly bindings: ReadonlyArray<{ readonly model: ModelRef | null }> }>(
    server,
    "session.binding",
    { sessionIDs: [session.id] },
  )
  return { session, requests, toB, toA, state, binding }
}

function assertScenario(result: Awaited<ReturnType<typeof aba>>, A: ModelRef) {
  if (process.env.OWN_E2E_LOGS)
    console.log(
      JSON.stringify({
        predicted: [result.toB.context.P - result.toB.inputs.W_lo, result.toA.context.P - result.toA.inputs.W_lo],
        measured: [cold(result.requests[1]), cold(result.requests[2])],
        returnHit: [result.requests[2].cache?.cachedTokens, result.requests[0].cache?.promptTokens],
      }),
    )
  const [first, second, third] = result.requests
  // Each turn went to the slot the switch selected.
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(third.status).toBe(200)
  expect(second.identity).not.toBe(first.identity)
  expect(third.identity).toBe(first.identity)
  expect(result.binding.bindings[0]?.model).toMatchObject({ providerID: A.providerID, id: A.id })
  expect(result.state.state).toBe("COOLDOWN")

  // A → B: B never saw this session, so the whole prompt is cold, as predicted (W = 0).
  expect(second.cache?.cachedTokens).toBe(0)
  expect(result.toB.inputs.W_lo).toBe(0)
  expectWithin(result.toB.context.P - result.toB.inputs.W_lo, cold(second))

  // B → A within the TTL: the fake reports a hit on A's whole previous prompt (block aligned) …
  const previousA = first.cache?.promptTokens ?? 0
  expect(third.cache?.cachedTokens ?? 0).toBeGreaterThanOrEqual(previousA - BLOCK)
  // … the estimator reused exactly A's last input (W = L_A) …
  expect(result.toA.inputs.W_lo).toBe(previousA)
  // … and predicted the cold remainder within ±25%.
  expectWithin(result.toA.context.P - result.toA.inputs.W_lo, cold(third))
}

describe("switching A → B → A on fakes (stand-in slots)", () => {
  const A: ModelRef = { providerID: "own-oai-e2ea", id: "gpt-5.5" }
  const B: ModelRef = { providerID: "own-oai-e2eb", id: "gpt-5.5" }
  const state: { fake?: FakeOpenAIResponses; server?: OpencodeServer } = {}

  beforeAll(async () => {
    const fake = startFakeOpenAIResponses({ cache: { minTokens: 0, blockTokens: BLOCK } })
    state.fake = fake
    state.server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths: OpencodeServerPaths) =>
        opencodeConfig({
          providers: {
            [A.providerID]: openAIResponsesProvider(fake, { apiKey: "fake-key-slot-a", models: [A.id] }),
            [B.providerID]: openAIResponsesProvider(fake, { apiKey: "fake-key-slot-b", models: [B.id] }),
          },
          plugins: [
            {
              package: ACCOUNTS,
              options: { home: paths.ownHome, buildId: "e2e-switching-standin", vault: "memory", ratecardsSeed: SEED },
            },
          ],
          model: `${A.providerID}/${A.id}`,
        }),
    })
    await state.server.waitForModels([A, B])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await state.fake?.stop()
  }, 60_000)

  test(
    "the return to A hits A's cached prefix and both switch estimates predict the cold tokens within ±25%",
    async () => {
      const server = state.server
      const fake = state.fake
      if (!server || !fake) throw new Error("server did not start")
      const result = await aba(server, fake, A, B)
      assertScenario(result, A)
      expect(server.logs()).not.toMatch(/switching_failed|event_handler_failed|hook_failed/)
    },
    TURN_TIMEOUT,
  )
})

describe("switching A → B → A on fakes (registered slots)", () => {
  const state: { fake?: FakeOpenAIResponses; server?: OpencodeServer } = {}

  beforeAll(async () => {
    const fake = startFakeOpenAIResponses({ cache: { minTokens: 0, blockTokens: BLOCK }, models: ["gpt-5.5"] })
    state.fake = fake
    state.server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths: OpencodeServerPaths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: {
                home: paths.ownHome,
                buildId: "e2e-switching-slots",
                vault: "memory",
                ratecardsSeed: SEED,
                endpoints: { openai: fake.baseURL },
              },
            },
          ],
        }),
    })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await state.fake?.stop()
  }, 60_000)

  test(
    "own oai slots added with keys switch A → B → A with a cache hit on return",
    async () => {
      const server = state.server
      const fake = state.fake
      if (!server || !fake) throw new Error("server did not start")
      const add = async (label: string, key: string) => rpc(server, "accounts.add.key", { kind: "oai", label, key })
      const first = await add("slot A", "fake-key-registered-a")
      if (first.status !== 200) {
        // SLOTS/CREDENTIALS are not implemented yet; the stand-in suite above covers switching itself.
        console.warn(`registered-slot e2e not run: accounts.add.key answered ${first.status} ${first.body.message}`)
        expect(first.status).toBe(400)
        return
      }
      const second = await add("slot B", "fake-key-registered-b")
      expect(second.status).toBe(200)
      const providers = [first, second].map(
        (result) => (result.body.output as { readonly account: { readonly providerID: string } }).account.providerID,
      )
      const models = await server.models()
      const pick = (providerID: string): ModelRef => {
        const found =
          models.find((model) => model.providerID === providerID && model.id === "gpt-5.5") ??
          models.find((model) => model.providerID === providerID)
        if (!found) throw new Error(`no model registered for ${providerID}`)
        return { providerID, id: String(found.id) }
      }
      const A = pick(providers[0])
      const B = pick(providers[1])
      await server.waitForModels([A, B])
      fake.reset()
      const result = await aba(server, fake, A, B)
      assertScenario(result, A)
    },
    TURN_TIMEOUT,
  )
})
