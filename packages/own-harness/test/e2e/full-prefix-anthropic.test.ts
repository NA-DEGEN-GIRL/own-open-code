// P-034 on Anthropic Messages, the cache the full-prefix request is for, end to end with the e2e kit's fake (breakpoint
// cache: at most four `cache_control` breakpoints, each reading the newest entry within 20 blocks, 5-minute entries
// refreshed when read). For every harness (codex, pi, dsh, opencode) the compaction body is the previous primary body
// with only the newer messages and the kept-start prompt after it (`cache_control` aside: the tail breakpoint moves to
// the new last message). Then a turn that takes two steps: by the compaction the entry at the end of the older part was
// last read six minutes before, so the older request would rewrite everything after the system prompt and tools, while
// the full-prefix request reads the whole previous request from the entry its last step wrote. The verdict fixture
// stands in for own-accounts' warm verdict (CC-16); without one (a session titled NO_VERDICT) own-harness sends the
// older part, on Anthropic too.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
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
import { expectFullPrefix, HARNESS_PLUGINS, keptPrompt, NO_VERDICT } from "./full-prefix.js"

const MODEL = { providerID: "fake-claude", id: "claude-sonnet-5" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const CHECKPOINT = Checkpoint.SECTIONS.map((heading) => `${heading}\n- ${heading.replace(/#/g, "").trim()} item`).join("\n")
/** Each agent request (one with tools: not a title) is three minutes after the one before, on the fake's clock. */
const STEP_MS = 3 * 60_000
const START = Date.UTC(2026, 9, 24, 0, 0, 0)

type Body = { messages: Array<{ role: string; content: unknown }>; [key: string]: unknown }

let fake: FakeAnthropic
let server: OpencodeServer

const agentRequests = () =>
  (fake?.requests ?? []).filter(
    (request) =>
      request.method === "POST" && ((request.json as { tools?: ReadonlyArray<unknown> } | null)?.tools?.length ?? 0) > 0,
  )

beforeAll(async () => {
  fake = startFakeAnthropic({
    models: ["claude-sonnet-5"],
    // The fake records a request after answering it, so the one being answered is the next index.
    clock: { now: () => START + agentRequests().length * STEP_MS },
  })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      fs.writeFileSync(path.join(paths.workspace, "notes.txt"), "one\ntwo\n")
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-claude": anthropicProvider(fake, {
            apiKey: "fake-anthropic-key",
            models: { "claude-sonnet-5": { name: "claude-sonnet-5" } },
          }),
        },
        plugins: HARNESS_PLUGINS,
      })
    },
  })
  await server.waitForModels([MODEL])
}, 180_000)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

describe("full-prefix compaction on Anthropic Messages (P-034)", () => {
  for (const harness of ["codex", "pi", "dsh", "opencode"] as const)
    test(
      `${harness}: the compaction body is the previous body plus the newer messages and the kept-start prompt`,
      async () => {
        const sessionID = await session(harness)
        await turn(sessionID, "First question about the parser.", [{ type: "text", text: "First answer." }])
        const [previous] = await turn(sessionID, "Second question about the lexer.", [
          { type: "text", text: "Second answer." },
        ])
        const compaction = await compact(sessionID)
        expect(compaction).toHaveLength(1)
        const body = compaction[0]!.json as Body
        expect(text(body.messages.at(-1)!.content)).toBe(keptPrompt("Second question about the lexer."))
        expectFullPrefix(withoutCacheControl(previous!.json), withoutCacheControl(body), "messages")
        // The newest entry the previous request wrote covers all of it.
        expect(compaction[0]!.cache!.cachedTokens).toBeGreaterThanOrEqual(previous!.cache!.promptTokens)
      },
      150_000,
    )

  test(
    "after a turn longer than the cache lifetime the full prefix still reads the whole previous request",
    async () => {
      const sessionID = await session("opencode")
      await turn(sessionID, "Plain question.", [{ type: "text", text: "Plain answer." }])
      // Two steps, three minutes apart: the older part's last entry is read at the first and expires before the end.
      const steps = await turn(sessionID, "Read notes.txt, please.", [
        { type: "tool-call", name: "read", input: { filePath: "notes.txt" } },
        { type: "text", text: "It has two lines." },
      ])
      expect(steps).toHaveLength(2)
      const compaction = await compact(sessionID)
      const last = steps.at(-1)!
      expect(compaction[0]!.at - steps[0]!.at).toBe(2 * STEP_MS)
      expect(compaction[0]!.cache!.cachedTokens).toBeGreaterThanOrEqual(last.cache!.promptTokens)
      // What core stored for the compaction: that read, so all but the newest reply and the prompt (about 10% of this
      // short conversation) came from the cache.
      const stored = (await server.call("GET", `/api/session/${sessionID}/message`, {
        query: { type: "compaction", order: "desc", limit: "1" },
      })) as { data: Array<{ tokens?: { input: number; cache: { read: number; write: number } } }> }
      const tokens = stored.data[0]!.tokens!
      expect(tokens.cache.read).toBe(compaction[0]!.cache!.cachedTokens)
      expect(tokens.cache.read / (tokens.input + tokens.cache.read + tokens.cache.write)).toBeGreaterThan(0.85)
    },
    150_000,
  )

  test(
    "without own-accounts' verdict own-harness fails closed: the older part only, as before P-034",
    async () => {
      const sessionID = await session("opencode", NO_VERDICT)
      await turn(sessionID, "First question about the parser.", [{ type: "text", text: "First answer." }])
      await turn(sessionID, "Second question about the lexer.", [{ type: "text", text: "Second answer." }])
      const compaction = await compact(sessionID)
      expect(compaction).toHaveLength(1)
      const body = compaction[0]!.json as Body
      expect(text(body.messages.at(-1)!.content)).toBe(Checkpoint.prompt())
      expect(compaction[0]!.body).not.toContain("Second question about the lexer.")
      // No hook asked for the whole history, so core records nothing (P-034).
      const stored = (await server.call("GET", `/api/session/${sessionID}/message`, {
        query: { type: "compaction", order: "desc", limit: "1" },
      })) as { data: Array<{ metadata?: Record<string, unknown> }> }
      expect(stored.data[0]!.metadata?.prefix).toBeUndefined()
    },
    150_000,
  )
})

/** A new session on the fake Claude model with `harness`, once the harness bound it. */
async function session(harness: OwnHarness.HarnessID, title = "full prefix") {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title,
      model: MODEL,
      location: { directory: server.paths.workspace },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
    },
  })) as { data: { id: string } }
  while (OwnHarness.bound((await sessionInfo(server, created.data.id)).metadata as Record<string, unknown>) === undefined)
    await Bun.sleep(50)
  return created.data.id
}

/** One prompt with the scripted replies; the agent requests that carried it. */
async function turn(sessionID: string, prompt: string, replies: Parameters<FakeAnthropic["enqueue"]>) {
  fake.enqueue(...replies)
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

function text(content: unknown) {
  return typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("")
}

/** The body without its breakpoints: where they sit is not part of the cached bytes. */
function withoutCacheControl(value: unknown): Record<string, unknown> {
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(strip)
    if (item === null || typeof item !== "object") return item
    return Object.fromEntries(Object.entries(item).flatMap(([key, entry]) => (key === "cache_control" ? [] : [[key, strip(entry)]])))
  }
  return strip(value) as Record<string, unknown>
}
