// P-034 with a fixed Claude thinking budget, end to end (CC-12): Claude 3.7 and 4.0–4.5 think with a fixed budget
// (core variant.ts `claudeInfo.manual`; here Haiku 4.5's `high`, 16,000 tokens), drop earlier turns' thinking once a
// plain user message follows, and a compaction's smaller output limit may cut the budget, so the whole history would
// not read the cached request. Core keeps the older request without a second hook run and records `thinking`; the
// same conversation without a variant (no thinking) gets the whole history. The e2e kit's fake Anthropic ignores
// `thinking`; what matters is what core sends. The verdict fixture stands in for own-accounts' warm verdict (CC-16), so
// own-harness asks for the full prefix every time.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  anthropicProvider,
  opencodeConfig,
  sessionInfo,
  startFakeAnthropic,
  startOpencodeServer,
  type FakeAnthropic,
  type OpencodeServer,
  type RecordedRequest,
} from "../../../own-accounts/test/e2e-kit"
import { Checkpoint } from "../../src/checkpoint.js"
import { HARNESS_PLUGINS, keptPrompt } from "./full-prefix.js"

const HAIKU = { providerID: "fake-claude", id: "claude-haiku-4-5" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const CHECKPOINT = Checkpoint.SECTIONS.map((heading) => `${heading}\n- ${heading.replace(/#/g, "").trim()} item`).join(
  "\n",
)

type Body = {
  messages: Array<{ role: string; content: unknown }>
  thinking?: { type: string; budget_tokens?: number }
  [key: string]: unknown
}

let fake: FakeAnthropic
let server: OpencodeServer

const agentRequests = () =>
  (fake?.requests ?? []).filter(
    (request) =>
      request.method === "POST" &&
      ((request.json as { tools?: ReadonlyArray<unknown> } | null)?.tools?.length ?? 0) > 0,
  )

beforeAll(async () => {
  fake = startFakeAnthropic({ models: [HAIKU.id] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-claude": anthropicProvider(fake, {
            apiKey: "fake-anthropic-key",
            models: {
              // Effort support on a 4.5 model resolves to budget variants: `high` (16,000) and `max`.
              [HAIKU.id]: {
                name: HAIKU.id,
                capabilities: { reasoning: { supported: true, effort: ["low", "medium", "high"] } },
                limit: { context: 200_000, output: 64_000 },
              },
            },
          }),
        },
        plugins: HARNESS_PLUGINS,
      })
    },
  })
  await server.waitForModels([HAIKU])
}, 180_000)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

describe("full-prefix compaction with a fixed thinking budget (P-034, CC-12)", () => {
  test("Haiku 4.5 high: the older request, recorded `thinking`, and no kept-start prompt", async () => {
    const sessionID = await session("high")
    await turn(sessionID, "First question about the parser.", "First answer.")
    const [previous] = await turn(sessionID, "Second question about the lexer.", "Second answer.")
    const primary = previous!.json as Body
    expect(primary.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 })
    const compaction = await compact(sessionID)
    expect(compaction).toHaveLength(1)
    const body = compaction[0]!.json as Body
    // The older part (everything before the second question) and the first run's prompt.
    expect(text(body.messages.at(-1)!.content)).toBe(Checkpoint.prompt())
    expect(body.messages.some((message) => text(message.content).includes("Second question about the lexer."))).toBe(
      false,
    )
    expect(body.thinking?.type).toBe("enabled")
    expect(await stored(sessionID)).toMatchObject({ prefix: { request: "older", reason: "thinking" } })
  }, 150_000)

  test("the same model without a variant thinks not, and gets the whole history", async () => {
    const sessionID = await session(undefined)
    await turn(sessionID, "Plain question about the parser.", "Plain answer.")
    const [previous] = await turn(sessionID, "Plain follow-up about the lexer.", "Plain follow-up answer.")
    expect((previous!.json as Body).thinking).toBeUndefined()
    const compaction = await compact(sessionID)
    expect(compaction).toHaveLength(1)
    const body = compaction[0]!.json as Body
    expect(text(body.messages.at(-1)!.content)).toBe(keptPrompt("Plain follow-up about the lexer."))
    expect(await stored(sessionID)).toMatchObject({ prefix: { request: "full" } })
  }, 150_000)
})

/** A new session on the fake Haiku with the opencode harness, once the harness bound it. */
async function session(variant: string | undefined) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: "full prefix thinking",
      model: { ...HAIKU, ...(variant === undefined ? {} : { variant }) },
      location: { directory: server.paths.workspace },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value("opencode") },
    },
  })) as { data: { id: string } }
  while (
    OwnHarness.bound((await sessionInfo(server, created.data.id)).metadata as Record<string, unknown>) === undefined
  )
    await Bun.sleep(50)
  return created.data.id
}

/** One prompt answered with `reply`; the agent requests that carried it. */
async function turn(sessionID: string, prompt: string, reply: string) {
  fake.enqueue({ type: "text", text: reply })
  const before = agentRequests().length
  await server.prompt(sessionID, prompt)
  await server.waitIdle(sessionID)
  return agentRequests()
    .slice(before)
    .filter((request) => request.body.includes(prompt))
}

/** `/compact` with a valid checkpoint reply; the agent requests it sent. */
async function compact(sessionID: string): Promise<RecordedRequest[]> {
  fake.enqueue({ type: "text", text: `<checkpoint>\n${CHECKPOINT}\n</checkpoint>` })
  const before = agentRequests().length
  await server.call("POST", `/api/session/${sessionID}/compact`, { body: {} })
  await server.waitIdle(sessionID)
  return agentRequests().slice(before)
}

/** The checkpoint's metadata as core stored it. */
async function stored(sessionID: string) {
  const found = (await server.call("GET", `/api/session/${sessionID}/message`, {
    query: { type: "compaction", order: "desc", limit: "1" },
  })) as { data: Array<{ metadata?: Record<string, unknown> }> }
  return found.data[0]?.metadata
}

function text(content: unknown) {
  return typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("")
}
