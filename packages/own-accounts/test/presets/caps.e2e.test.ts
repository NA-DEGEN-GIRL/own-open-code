// End to end on a real upstream server: the subagent caps of 07 §2.6 after decision SC (2026-11-03). A conversation has
// no subagent total unless the user sets one: on `평소대로` more than the old 100 subagents run in one conversation and
// none is refused, while the fan-out caps still hold: the seventh new subagent of one user message is refused
// (`perMessage`, 6), and a fourth background subagent while three run is refused (`concurrent`, 3).
//
// own-accounts loads from its package directory (`startPresetRig`) with one linked ChatGPT account answering from a
// fake Codex backend. The scripted model reads a directive in the parent's last user text (`[spawn N]`,
// `[background N]`) and then calls the subagent tool once per step until N calls were made, whatever their results; a
// child answers at once, or after a pause when its prompt says `<<slow>>` (so background children stay running). Every
// credential is fake; the server binds 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Preset } from "@own/protocol"
import {
  afterToolResult,
  lastUserText,
  startFakeCodex,
  startPresetRig,
  toolError,
  type FakeCodex,
  type PresetRig,
  type RecordedRequest,
  type Reply,
  type ToolPart,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const RUN_TIMEOUT = 600_000

const ONE = { accountID: "acct-caps-01", email: "caps@example.test", plan: "plus" }
const MAIN = { providerID: "own-codex-pg01", id: "gpt-6-sol", variant: "high" }

const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
/** New subagents per user message on `평소대로` (07 §2.6), and how many messages pass the old total of 100. */
const PER_MESSAGE = 6
const MESSAGES = 17
/** How long a background child takes, so the parent's launches all happen while the earlier children run. */
const SLOW_MS = 8_000

/** The parent's plan for the current user message: subagent calls still to make and whether they run in background. */
const plan = { remaining: 0, background: false }

const fixture: { codex?: FakeCodex; rig?: PresetRig } = {}

beforeAll(async () => {
  // Hundreds of requests: the fake's usage windows (1 point per request by default) must not run out.
  const codex = startFakeCodex({
    cache: { minTokens: 0, blockTokens: 32 },
    usagePerRequest: { primary: 0, secondary: 0 },
    responder: reply,
  })
  fixture.codex = codex
  fixture.rig = await startPresetRig({
    name: "caps",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login(ONE) }],
    models: [MAIN],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await fixture.codex?.stop()
}, 60_000)

describe("no conversation total by default (07 §2.6, SC 2026-11-03)", () => {
  const state: { root?: string } = {}

  beforeAll(async () => {
    state.root = (await required(fixture.rig).server.createSession({ model: MAIN })).id
  })

  test(
    `${PER_MESSAGE * MESSAGES} subagents in one conversation on 평소대로, none refused`,
    async () => {
      const rig = required(fixture.rig)
      const root = required(state.root)
      for (const index of Array.from({ length: MESSAGES }, (_, at) => at)) {
        await rig.server.prompt(root, `[spawn ${PER_MESSAGE}] 메시지 ${index + 1}`)
        await settled(root, PER_MESSAGE * (index + 1))
      }
      const calls = await subagentCalls(root)
      expect(calls).toHaveLength(PER_MESSAGE * MESSAGES)
      expect(calls.filter((call) => call.state.status !== "completed").map(toolError)).toEqual([])
      const view = await rig.call("session.preset.get", { sessionID: root })
      expect(view).toMatchObject({ caps: { concurrent: 3, perMessage: 6, perSession: null } })
      expect(countsOf(view)?.session).toBe(PER_MESSAGE * MESSAGES)
    },
    RUN_TIMEOUT,
  )

  test(
    "the per-message cap still holds: the seventh new subagent of one message is refused",
    async () => {
      const rig = required(fixture.rig)
      const root = required(state.root)
      const before = (await subagentCalls(root)).length
      await rig.server.prompt(root, `[spawn ${PER_MESSAGE + 1}] 하나 더`)
      await settled(root, before + PER_MESSAGE + 1)
      const calls = (await subagentCalls(root)).slice(before)
      expect(calls.map((call) => call.state.status)).toEqual([...Array(PER_MESSAGE).fill("completed"), "error"])
      expect(toolError(required(calls.at(-1)))).toContain(
        Preset.rejection({ reason: "caps", cap: "perMessage", max: PER_MESSAGE }),
      )
    },
    RUN_TIMEOUT,
  )
})

test(
  "the running cap still holds: a fourth background subagent while three run is refused",
  async () => {
    const rig = required(fixture.rig)
    const root = (await rig.server.createSession({ model: MAIN })).id
    await rig.server.prompt(root, "[background 4] 동시에")
    await rig.server.waitIdle(root)
    const calls = await subagentCalls(root)
    expect(calls.map((call) => call.state.status)).toEqual(["completed", "completed", "completed", "error"])
    expect(toolError(required(calls.at(-1)))).toContain(Preset.rejection({ reason: "caps", cap: "concurrent", max: 3 }))
    // The three children finish in the background; their notices wake the parent, which only answers.
    await waitFor(async () => countsOf(await rig.call("session.preset.get", { sessionID: root }))?.running === 0)
    await rig.server.waitIdle(root)
  },
  RUN_TIMEOUT,
)

test("no hook failed", () => {
  expect(required(fixture.rig).server.logs()).not.toMatch(/hook_failed|preset_gate_undecided/)
})

// ---------------------------------------------------------------------------------------------------------------

/**
 * The scripted model. A child answers (after {@link SLOW_MS} when told `<<slow>>`). The parent starts a plan on a
 * directive and makes its next subagent call after every tool result (or background notice) until the plan is done.
 */
function reply(request: RecordedRequest): Reply | undefined {
  const text = lastUserText(request)
  if (!afterToolResult(request) && text.includes(SUBAGENT_PROMPT))
    return text.includes("<<slow>>")
      ? { type: "text", text: "느린 자식 작업을 마쳤습니다.", delayMs: SLOW_MS }
      : { type: "text", text: "자식 작업을 마쳤습니다." }
  const directive = /\[(spawn|background) (\d+)\]/.exec(text)
  if (!afterToolResult(request) && directive) {
    plan.remaining = Number(directive[2])
    plan.background = directive[1] === "background"
  }
  if (plan.remaining === 0) return { type: "text", text: "답변" }
  // Since upstream v2.3.0 (#63382) every subagent runs in the background and its call returns at once: a `spawn` plan
  // makes its next call when the child reported (a `<background-result>` notice), one child at a time as before.
  if (!plan.background && afterToolResult(request) && !text.includes("<background-result"))
    return { type: "text", text: "자식의 결과를 기다립니다." }
  plan.remaining -= 1
  return {
    type: "tool-call",
    name: "subagent",
    input: {
      agent: "general",
      description: "작은 일",
      prompt: plan.background ? "<<slow>> 천천히 살펴보기" : "살펴보기",
      ...(plan.background ? { background: true } : {}),
    },
  }
}

/**
 * Every subagent call of a session, oldest first, across all pages of its assistant messages (`toolParts` reads the
 * first page only, fewer than this file makes).
 */
async function subagentCalls(sessionID: string) {
  const server = required(fixture.rig).server
  const pages = async (cursor: string | undefined, found: ReadonlyArray<unknown>): Promise<ReadonlyArray<unknown>> => {
    const query =
      cursor === undefined ? "type=assistant&order=asc&limit=200" : `type=assistant&limit=200&cursor=${cursor}`
    const page = await server.call("GET", `/api/session/${sessionID}/message?${query}`)
    const items = isRecord(page) && Array.isArray(page.data) ? page.data : []
    const next = isRecord(page) && isRecord(page.cursor) ? page.cursor.next : undefined
    const all = [...found, ...items]
    return typeof next === "string" && items.length === 200 ? pages(encodeURIComponent(next), all) : all
  }
  return (await pages(undefined, []))
    .flatMap((message) => (isRecord(message) && Array.isArray(message.content) ? message.content : []))
    .filter(
      (part): part is ToolPart =>
        isRecord(part) && part.type === "tool" && part.name === "subagent" && isRecord(part.state),
    )
}

/**
 * A `spawn` message is done once the session holds `calls` subagent calls and no child still runs (children report in
 * the background since upstream v2.3.0), and the parent answered the last report.
 */
async function settled(root: string, calls: number) {
  const rig = required(fixture.rig)
  await waitFor(
    async () =>
      (await subagentCalls(root)).length >= calls &&
      countsOf(await rig.call("session.preset.get", { sessionID: root }))?.running === 0,
    RUN_TIMEOUT,
  )
  await rig.server.waitIdle(root)
}

/** `session.preset.get`'s subagent counts. */
function countsOf(view: Record<string, unknown>) {
  return isRecord(view.counts) ? view.counts : undefined
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(200)
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
