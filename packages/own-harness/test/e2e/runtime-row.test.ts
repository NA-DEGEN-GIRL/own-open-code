// Runtime acceptance end to end (07 §4.5, 10 §6.14): a ChatGPT account's Codex model list serves `gpt-6.9-nova`, a
// model no bundled catalog has (test/golden/codex/runtime-row-catalog.json: Codex 0.171.0's gpt-6.2-sol row, renamed).
// own-accounts fetches the list from the fake Codex backend and takes the row; own.harness asks for it
// (`codexModels.rows`) and runs the model from it. The request must be what Codex CLI 0.171.0 sends when its catalog is
// that served row (`model_catalog_json`, as a ChatGPT login reads `/models`): exec-runtime-row.json, compared as the
// GPT-6 goldens are (golden-code-mode.ts), with `spawn_agent` listing the served model only. Before runtime acceptance
// the row was left out and counted, and the model ran on Codex's fallback prompt and tools.
// The session runs on a fake OpenAI Responses provider, as the CLI capture did; the fakes bind 127.0.0.1 and every
// credential is fake. Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { CodexModels, OwnAccounts } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Schema } from "effect"
import {
  REPO_ROOT,
  openAIResponsesProvider,
  sessionInfo,
  startFakeCodex,
  startFakeOpenAIResponses,
  startPresetRig,
  waitUntil,
  type FakeCodex,
  type FakeOpenAIResponses,
  type PresetRig,
} from "../../../own-accounts/test/e2e-kit"
import { expectCodeModeParity, normalize, type Body } from "./golden-code-mode.js"

setDefaultTimeout(120_000)

const GOLDENS = path.join(import.meta.dir, "..", "golden", "codex")
const BOOT_TIMEOUT = 240_000
const MODEL = "gpt-6.9-nova"
const SERVED: { models: Array<Record<string, unknown>> } = await Bun.file(
  path.join(GOLDENS, "runtime-row-catalog.json"),
).json()
const ONE = { accountID: "acct-rr-01", email: "one@example.test", plan: "pro" }

const fixture: { fake?: FakeOpenAIResponses; codex?: FakeCodex; rig?: PresetRig } = {}

beforeAll(async () => {
  const fake = startFakeOpenAIResponses({ models: [MODEL] })
  // The served list: the new model's row, and a malformed row own leaves out (so `left` is exercised too).
  const codex = startFakeCodex({
    modelList: () => ({ models: [...SERVED.models, { slug: "gpt-7-preview", visibility: "list", tool_mode: "code_mode" }] }),
  })
  Object.assign(fixture, { fake, codex })
  fixture.rig = await startPresetRig({
    name: "rr",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login(ONE) }],
    control: true,
    projectConfig: true,
    plugins: [path.join(REPO_ROOT, "packages/own-harness")],
    workspaceFiles: { "AGENTS.md": "Answer in one short sentence.\n", "hello.txt": "hello from the workspace\n" },
    config: {
      providers: {
        "fake-a": openAIResponsesProvider(fake, { apiKey: "fake-key-a", models: { [MODEL]: { name: MODEL } } }),
      },
    },
    models: [{ providerID: "fake-a", id: MODEL }],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.fake?.stop(), fixture.codex?.stop()])
}, 60_000)

describe("a model the bundled catalog does not know runs from its served row (10 §6.14)", () => {
  test("own-accounts takes the row: not counted, the left-out one named with its field", async () => {
    const rig = required(fixture.rig)
    const rows = await waitUntil(async () => {
      const answer = Schema.decodeUnknownSync(CodexModels.Rows)(await rig.call("codexModels.rows", {}))
      return answer.rows?.some((row) => row.slug === MODEL) && answer
    }, "the served row never arrived")
    expect(rows.rows?.map((row) => row.slug)).toEqual([MODEL])
    const view = Schema.decodeUnknownSync(CodexModels.View)(await rig.call("codexModels.get", {}))
    expect(view).toMatchObject({
      rejected: 1,
      left: [{ slug: "gpt-7-preview", field: "tool_mode", value: '"code_mode"' }],
      borrowed: [],
    })
  })

  test("own's request equals Codex 0.171.0's for that row, but for the known gaps", async () => {
    const rig = required(fixture.rig)
    const fake = required(fixture.fake)
    const server = rig.server
    Bun.spawnSync(["git", "init", "-q"], { cwd: server.paths.workspace })
    const golden: { model: string; requests: Array<{ body: Body }> } = await Bun.file(
      path.join(GOLDENS, "exec-runtime-row.json"),
    ).json()
    expect(golden.model).toBe(MODEL)
    const created = (await server.call("POST", "/api/session", {
      body: {
        title: "runtime row",
        model: { providerID: "fake-a", id: MODEL },
        location: { directory: server.paths.workspace },
        metadata: { [OwnHarness.META_KEY]: OwnHarness.value("codex") },
      },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    await waitUntil(
      async () => OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) !== undefined,
      "own.harness did not bind the session",
    )
    // The capture ran with full access and no approvals (`danger-full-access`, `never`).
    const rules = JSON.stringify((await sessionInfo(server, sessionID)).permissions ?? [])
    const approval = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/session.approval.set`, {
      body: { input: { sessionID, mode: "full" } },
      query: { "location[directory]": server.paths.workspace },
      directory: server.paths.workspace,
    })
    expect(approval.status).toBe(200)
    // The mode's rules reach the session a moment after the answer (2.2.6-own.18 tier: the first request still ran under
    // the default rules and got `workspace-write`); the request has to see them.
    await waitUntil(
      async () => JSON.stringify((await sessionInfo(server, sessionID)).permissions ?? []) !== rules,
      "the full approval mode never reached the session",
    )
    const theirs = golden.requests.map((request) => normalize(request.body) as Body)
    const program = theirs[1]!.input.find((item) => item.type === "custom_tool_call")!.input as string
    fake.enqueue(
      { type: "tool-call", name: "exec", input: {}, freeform: program },
      { type: "text", text: "It says hello from the workspace." },
    )
    const before = fake.requests.length
    await server.prompt(sessionID, "Show me what is in hello.txt.")
    await server.waitIdle(sessionID)
    const ours = fake.requests
      .slice(before)
      .map((request) => request.json as Body)
      .filter((body) => JSON.stringify(body.input).includes("Show me what is in hello.txt."))
    expect(ours).toHaveLength(2)
    const mine = ours.map((body) => normalize(body, server.paths.workspace) as Body)
    // The served row's instructions, not Codex's fallback prompt (what the model got before runtime acceptance).
    expect(mine[0]!.input[1]!.content[0].text).toBe(theirs[0]!.input[1]!.content[0].text)
    // With own-accounts loaded, core's web search and `opencode` tools are not all there: only those own adds may differ.
    expectCodeModeParity(mine, theirs, true)
  }, 180_000)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture not ready")
  return value
}
