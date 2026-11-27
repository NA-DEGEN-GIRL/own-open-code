// The user's output limit on a real upstream server (02 §4.9, OL 2026-10-19), as the fake providers receive it: an
// Anthropic key (Messages `max_tokens`), a DeepSeek key with thinking on and off (chat `max_tokens`), an OpenAI key
// (Responses `max_output_tokens`) and a Codex account over the WebSocket (`response.create`). Each setting goes in
// through `policy.set` like Settings > 출력 상한 does, and the next request of a new session shows it:
// - default: core's limit, min(the model's output, 256,000); none for OpenAI and Codex (02 §4.1).
// - 보내지 않기: none, except Claude's 32,000 (the Messages API requires one) and DeepSeek thinking-off's 65,536.
// - 이 값을 넘기지 않기 393,216: DeepSeek V4 gets its whole output (core patch P-032); 8,000: everyone that gets one.
// A Claude model with a manual thinking budget shows why a change can rewrite that conversation's cache once: the
// adapter fits the budget under half the limit. Compaction is not exercised here (unit tests). Every credential is
// fake (a fake codex-multi-provider profile, a seeded stand-in vault); the servers bind 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OutputLimit } from "@own/protocol"
import { CodexSource, Hash } from "@own/runtime"
import {
  opencodeConfig,
  removeTree,
  startFakeAnthropic,
  startFakeCodex,
  startFakeOpenAIChat,
  startFakeOpenAIResponses,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type FakeAnthropic,
  type FakeCodex,
  type FakeOpenAIChat,
  type FakeOpenAIResponses,
  type FakeProvider,
  type ModelRef,
  type OpencodeServer,
  type RecordedRequest,
} from "../e2e-kit"
import { registryWith } from "../slots/support.js"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const VAULT_HELPER = path.join(import.meta.dir, "../slots-auth/fixture/seed-vault-helper.ts")
const ACCOUNTS = path.join(import.meta.dir, "../..")

// Fake API keys (never real).
const OAI_KEY = "sk-proj-outputFakeKeyOai000000000000000001"
const DS_KEY = "sk-outputFakeKeyDeepSeek00000000000000002"
const ANTH_KEY = "sk-ant-outputFakeKeyAnthropic000000000003"

type Fake = "anthropic" | "chat" | "responses" | "codex"

interface Target {
  readonly name: string
  readonly fake: Fake
  readonly model: ModelRef
}

const CLAUDE: Target = {
  name: "Claude",
  fake: "anthropic",
  model: { providerID: "own-anth-olanth", id: "claude-opus-5-5" },
}
const CLAUDE_BUDGET: Target = {
  name: "Claude with a thinking budget",
  fake: "anthropic",
  // Claude Haiku 4.5: a thinking budget on `max` and 64,000 output, as Sonnet 4.5 had before upstream v2.4.1's catalog
  // dropped it from the bundled templates.
  model: { providerID: "own-anth-olanth", id: "claude-haiku-4-5", variant: "max" },
}
const DS_ON: Target = {
  name: "DeepSeek, thinking on",
  fake: "chat",
  model: { providerID: "own-ds-olds", id: "deepseek-v4-pro", variant: "high" },
}
const DS_OFF: Target = {
  name: "DeepSeek, thinking off",
  fake: "chat",
  model: { providerID: "own-ds-olds", id: "deepseek-v4-pro", variant: "none" },
}
const OPENAI: Target = { name: "OpenAI key", fake: "responses", model: { providerID: "own-oai-oloai", id: "gpt-5.5" } }
const CODEX: Target = { name: "Codex", fake: "codex", model: { providerID: "own-codex-olcodex", id: "gpt-6-sol" } }
const TARGETS = [CLAUDE, CLAUDE_BUDGET, DS_ON, DS_OFF, OPENAI, CODEX]

const fixture: {
  anthropic?: FakeAnthropic
  chat?: FakeOpenAIChat
  responses?: FakeOpenAIResponses
  codex?: FakeCodex
  server?: OpencodeServer
  temp?: string
} = {}

beforeAll(async () => {
  const codex = startFakeCodex()
  Object.assign(fixture, {
    codex,
    anthropic: startFakeAnthropic(),
    chat: startFakeOpenAIChat(),
    responses: startFakeOpenAIResponses({ models: ["gpt-5.5"] }),
  })
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-output-limit-")))
  fixture.temp = temp
  const home = path.join(temp, "own-home")
  const legacy = path.join(temp, "control-center")
  await fs.mkdir(home, { recursive: true })
  const [profile] = await writeCodexMultiProviderProfiles(legacy, [
    { id: "01", alias: "output-limit", tokens: codex.login({ accountID: "acct-output-limit" }) },
  ])
  const source = required(profile)
  const registry = await registryWith([
    {
      kind: "codex",
      label: "Codex",
      slug: "olcodex",
      identity: await sourceIdentity(source.authPath),
      credential: {
        type: "linked-codex-source",
        source: {
          app: "codex-multi-provider",
          profileID: source.id,
          alias: source.alias,
          authPath: source.authPath,
        },
        linkedAt: "2026-10-19T00:00:00Z",
      },
    },
    { kind: "oai", label: "OpenAI", slug: "oloai", identity: { keyHint: Hash.keyHint(OAI_KEY) } },
    { kind: "ds", label: "DeepSeek", slug: "olds", identity: { keyHint: Hash.keyHint(DS_KEY) } },
    { kind: "anth", label: "Anthropic", slug: "olanth", identity: { keyHint: Hash.keyHint(ANTH_KEY) } },
  ])
  await Bun.write(path.join(home, "accounts.json"), JSON.stringify(registry, null, 2))
  const seed = path.join(temp, "vault-seed.json")
  await Bun.write(
    seed,
    JSON.stringify({
      acc_oloai: JSON.stringify({ v: 1, type: "key", key: OAI_KEY, generation: 1 }),
      acc_olds: JSON.stringify({ v: 1, type: "key", key: DS_KEY, generation: 1 }),
      acc_olanth: JSON.stringify({ v: 1, type: "key", key: ANTH_KEY, generation: 1 }),
    }),
  )
  fixture.server = await startOpencodeServer({
    env: { OWN_OPEN_CODE: "1" },
    config: opencodeConfig({
      providers: {},
      plugins: [
        {
          package: ACCOUNTS,
          options: {
            home,
            buildId: `e2e-output-limit-${process.pid}`,
            vault: { command: [process.execPath, VAULT_HELPER, seed] },
            endpoints: {
              codex: codex.baseURL,
              oauthIssuer: codex.url,
              openai: required(fixture.responses).baseURL,
              deepseek: required(fixture.chat).baseURL,
              anthropic: required(fixture.anthropic).baseURL,
            },
            codexImportRoot: legacy,
          },
        },
      ],
    }),
  })
  await fixture.server.waitForModels(TARGETS.map((target) => target.model))
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.server?.stop()
  await Promise.all([fixture.anthropic?.stop(), fixture.chat?.stop(), fixture.responses?.stop(), fixture.codex?.stop()])
  if (fixture.temp) await removeTree(fixture.temp)
}, 60_000)

describe("output limit setting on the wire (02 §4.9)", () => {
  test(
    "default: core's min(model output, 256,000); OpenAI and Codex get none",
    async () => {
      await setting(null)
      expect(await sent()).toEqual({
        Claude: 128_000,
        "Claude with a thinking budget": 64_000,
        "DeepSeek, thinking on": 256_000,
        "DeepSeek, thinking off": 256_000,
        "OpenAI key": null,
        Codex: null,
      })
    },
    TURN_TIMEOUT,
  )

  test(
    "보내지 않기: none, except Claude's required 32,000 and DeepSeek thinking-off's 65,536",
    async () => {
      await setting({ mode: "omit", maxTokens: OutputLimit.CORE_CAP })
      expect(await sent()).toEqual({
        Claude: OutputLimit.CLAUDE_DEFAULT,
        "Claude with a thinking budget": OutputLimit.CLAUDE_DEFAULT,
        "DeepSeek, thinking on": null,
        "DeepSeek, thinking off": OutputLimit.DS_THINKING_OFF,
        "OpenAI key": null,
        Codex: null,
      })
    },
    TURN_TIMEOUT,
  )

  test(
    "이 값을 넘기지 않기: 393,216 gives DeepSeek V4 its whole output; 8,000 caps every limit sent",
    async () => {
      await setting({ mode: "cap", maxTokens: 393_216 })
      expect(await sent()).toEqual({
        Claude: 128_000,
        "Claude with a thinking budget": 64_000,
        "DeepSeek, thinking on": 393_216,
        "DeepSeek, thinking off": 393_216,
        "OpenAI key": null,
        Codex: null,
      })
      await setting({ mode: "cap", maxTokens: 8_000 })
      expect(await sent()).toEqual({
        Claude: 8_000,
        "Claude with a thinking budget": 8_000,
        "DeepSeek, thinking on": 8_000,
        "DeepSeek, thinking off": 8_000,
        "OpenAI key": null,
        Codex: null,
      })
    },
    TURN_TIMEOUT,
  )

  test(
    "a manual thinking budget follows the limit, so a change rewrites that Claude conversation's cache once",
    async () => {
      const budgets: Array<number | null> = []
      for (const value of [null, { mode: "omit", maxTokens: OutputLimit.CORE_CAP }] as const) {
        await setting(value)
        const request = await lastRequest(CLAUDE_BUDGET)
        const thinking = isRecord(request.json) && isRecord(request.json.thinking) ? request.json.thinking : {}
        budgets.push(typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : null)
      }
      // The `max` variant's 31,999 fits under half of 64,000; under 32,000 it becomes half of that (`fitThinkingBudget`).
      expect(budgets).toEqual([31_999, 16_000])
    },
    TURN_TIMEOUT,
  )
})

async function setting(outputLimit: OutputLimit.SettingInput | null) {
  const output = await rpc(required(fixture.server), "policy.set", { patch: { outputLimit } })
  const policy = isRecord(output.policy) ? output.policy : {}
  expect(policy.outputLimit).toEqual(outputLimit ?? undefined)
}

/** The output limit each target's next request carries, by target name (`null` = none). One at a time: fakes are shared. */
async function sent() {
  const limits: Record<string, number | null> = {}
  for (const target of TARGETS) limits[target.name] = limitOf(await lastRequest(target))
  return limits
}

/** A new session on the target's model, one prompt, and the model request it made. */
async function lastRequest(target: Target) {
  const server = required(fixture.server)
  const fake = fakeOf(target.fake)
  const before = fake.requests.length
  const session = await server.createSession({ model: target.model, title: `output limit ${target.name}` })
  await server.prompt(session.id, "hi")
  await server.waitIdle(session.id)
  const requests = fake.requests.slice(before).filter(isModelRequest)
  expect(requests).toHaveLength(1)
  return required(requests[0])
}

function limitOf(request: RecordedRequest) {
  const body = isRecord(request.json) ? request.json : {}
  const value = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens
  return typeof value === "number" ? value : null
}

function fakeOf(fake: Fake): FakeProvider {
  if (fake === "anthropic") return required(fixture.anthropic)
  if (fake === "chat") return required(fixture.chat)
  if (fake === "responses") return required(fixture.responses)
  return required(fixture.codex)
}

/** Model requests only: Messages, Responses and chat POSTs and Codex `response.create` frames. */
function isModelRequest(request: RecordedRequest) {
  if (request.method === "WS") return isRecord(request.json) && request.json.type === "response.create"
  return request.method === "POST" && /\/(messages|responses|chat\/completions)$/.test(request.path.split("?")[0] ?? "")
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
