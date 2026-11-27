// Creator extensions across the other features (merge round 11, MR14), on own-team's e2e harness: own-accounts and
// own-team with the fake providers, then own-harness, own-omo (its built runtime, `bun run bundle` in own-omo) and
// own-creator last, as the release lists them. One extension with a prompt fragment, a command tool `ext_say` and a
// tool rule (`echo forbidden` is denied) is written into the store after boot (the store's watch applies it). The local
// fake answers queued replies (dsh adds its runtime context after the user's text, which the directive responder would
// read as the newest user text); the fake `claude` follows own-team's directives, where `[tool ext_say {…}]` calls the
// command tool through Code Mode's `execute`. Verdicts:
// - A local model (a keyless `로컬 모델` account on a fake Chat Completions server) under every harness (opencode,
//   codex, pi, dsh, omo, claude-code): the first request carries the fragment and names `ext_say`, the tool runs, and
//   the rule refuses the forbidden word.
// - A Claude Agent account (the fake `claude`): the fragment reaches Claude's appended system prompt, the tool runs
//   through the provider's `opencode` MCP server, and the rule refuses the forbidden word.
// - Approval modes: 묻기 asks the shell approval for the tool's command, 읽기 전용 refuses it without asking.
// - A subagent the extension defines (`crosscheck`) runs through core's subagent tool, under own-accounts' preset gate
//   (the cap counts every agent's call), and its own requests carry the fragment and the rule.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  REPO_ROOT,
  childOf,
  instructionEntries,
  startFakeOpenAIChat,
  toolParts,
  type FakeOpenAIChat,
  type Reply,
  type ToolPart,
} from "../../../own-accounts/test/e2e-kit"
import { readLog } from "../../../own-team/test/e2e/fake-claude.js"
import {
  BOOT_TIMEOUT,
  CLAUDE_AGENT,
  claudeAgentFolder,
  permissions,
  reply,
  startTeamServer,
  until,
  type TeamServer,
} from "../../../own-team/test/e2e/harness.js"
import { responder } from "../../../own-team/test/e2e/directives.js"
import { CreatorStore } from "../../src/store.js"

const STEP_TIMEOUT = 240_000
const FRAGMENT = "CROSS-FRAGMENT-7Q: keep answers to one line."
const LOCAL_MODEL = "cross-local-1"
const SAY = (word: string) => `[tool ext_say {"word":"${word}"}]`
const BOTH = `${SAY("pelican")} ${SAY("forbidden")}`
/** Code Mode's call of the command tool, as the local fake answers it. */
const say = (word: string): Reply => ({
  type: "tool-call",
  name: "execute",
  input: { code: `return await tools.ext_say(${JSON.stringify({ word })})` },
})
const DONE: Reply = { type: "text", text: "done" }
const SAID = [say("pelican"), say("forbidden"), DONE]
const OMO_RUNTIME = path.join(REPO_ROOT, "own", ".out", "omo", "omo-runtime.js")

const RULES = {
  full: [
    { action: "edit", resource: "**", effect: "allow" },
    { action: "shell", resource: "**", effect: "allow" },
  ],
  ask: [
    { action: "edit", resource: "**", effect: "ask" },
    { action: "shell", resource: "**", effect: "ask" },
  ],
  "read-only": [
    { action: "edit", resource: "**", effect: "deny" },
    { action: "shell", resource: "**", effect: "deny" },
  ],
} as const

const EXTENSION = {
  format: "own.ext/1",
  id: "cross-check",
  title: "Cross check",
  items: [
    { type: "prompt.fragment", id: "mark", text: FRAGMENT },
    {
      type: "tool.command",
      name: "say",
      description: "Says one word back",
      command: "echo {{word}}",
      params: { word: { type: "string", description: "The word" } },
    },
    {
      type: "tool.rule",
      rules: [{ permission: "shell", pattern: "*forbidden*", effect: "deny", reason: "not that word" }],
    },
    { type: "agent", name: "crosscheck", description: "Checks one thing", mode: "subagent", prompt: "Check it." },
  ],
}

describe("creator extensions across local models, Claude Agent, harnesses and approval modes", () => {
  const state: { team?: TeamServer; local?: FakeOpenAIChat; model?: { providerID: string; id: string } } = {}

  beforeAll(async () => {
    if (!fs.existsSync(OMO_RUNTIME)) throw new Error(`build own-omo's runtime first: ${OMO_RUNTIME}`)
    state.local = startFakeOpenAIChat({ models: [LOCAL_MODEL], anonymous: true, responder: responder() })
    const team = await startTeamServer({
      name: "creator-cross",
      claudeAgent: true,
      plugins: (ownHome) => [
        { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
        { package: path.join(REPO_ROOT, "packages/own-omo"), options: {} },
        { package: path.join(REPO_ROOT, "packages/own-creator"), options: { home: ownHome } },
      ],
    })
    state.team = team
    const added = await team.accounts("accounts.add.key", {
      kind: "compat",
      label: "Cross local",
      options: {
        baseURL: state.local.baseURL,
        local: { format: "chat" },
        models: [{ id: LOCAL_MODEL, contextLimit: 131_072, outputLimit: 16_000 }],
      },
    })
    const account = added.account as { readonly providerID: string }
    state.model = { providerID: account.providerID, id: LOCAL_MODEL }
    await team.server.waitForModels([state.model])
    const created = await new CreatorStore.Store(team.ownHome).create(EXTENSION, "model")
    if (!created.ok) throw new Error(JSON.stringify(created))
    await until(async () => {
      const listed = await team.rpc("own.creator", "list", {}, team.project)
      return JSON.stringify(listed.output ?? {}).includes('"status":"active"')
    }, "own.creator never applied the extension")
  }, BOOT_TIMEOUT * 2)

  afterAll(async () => {
    await state.team?.stop()
    await state.local?.stop()
  }, 120_000)

  /** One turn in a new session; the requests the local fake got for it and the session's `execute` calls. */
  async function run(
    text: string,
    replies: ReadonlyArray<Reply>,
    input: { readonly harness?: OwnHarness.HarnessID; readonly mode?: keyof typeof RULES; readonly claude?: boolean },
  ) {
    const team = required(state.team)
    const local = required(state.local)
    const sessionID = await team.createSession({
      title: "creator cross",
      model: input.claude ? CLAUDE_AGENT.model : required(state.model),
      permissions: RULES[input.mode ?? "full"],
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(input.harness ?? "opencode") },
    })
    local.reset()
    local.enqueue(...replies)
    const before = local.requests.length
    await team.turn(sessionID, text)
    const requests = local.requests.slice(before).filter((request) => request.method === "POST")
    return { sessionID, requests, calls: await toolParts(team.server, sessionID, "execute") }
  }

  test.each(["opencode", "codex", "pi", "dsh", "omo", "claude-code"] as const)(
    "a local model under %s: the fragment, the command tool and the rule apply",
    async (harness) => {
      const result = await run(BOTH, SAID, { harness })
      const first = required(result.requests[0])
      expect(first.body).toContain(FRAGMENT)
      expect(first.body).toContain("ext_say")
      expectSaid(result.calls)
    },
    STEP_TIMEOUT,
  )

  test(
    "a Claude Agent account: the fragment reaches Claude's system prompt, the tool runs, the rule refuses",
    async () => {
      const team = required(state.team)
      const result = await run(BOTH, [], { claude: true })
      expect(result.requests).toEqual([])
      const lines = readLog(claudeAgentFolder(team.ownHome))
      const init = required(
        lines.findLast(
          (line) =>
            line.kind === "in" &&
            line.message?.type === "control_request" &&
            (line.message.request as { subtype?: string } | undefined)?.subtype === "initialize",
        ),
      )
      expect(String((init.message?.request as { appendSystemPrompt?: unknown }).appendSystemPrompt)).toContain(FRAGMENT)
      // The fake logs tool names only: Code Mode's `execute` carries the catalog that names `ext_say`.
      const step = required(lines.findLast((line) => line.kind === "request"))
      expect(JSON.stringify(step.request?.tools)).toContain('"execute"')
      expectSaid(result.calls)
    },
    STEP_TIMEOUT,
  )

  test(
    "묻기 asks the shell approval for the tool's command; 읽기 전용 refuses it without asking",
    async () => {
      const team = required(state.team)
      const sessionID = await team.createSession({
        title: "creator cross ask",
        model: required(state.model),
        permissions: RULES.ask,
      })
      const asked: string[] = []
      const answering = (async () => {
        await until(async () => {
          const pending = await permissions(team, sessionID)
          for (const request of pending) {
            asked.push(`${String(request.action)}:${JSON.stringify(request.resources)}`)
            await reply(team, sessionID, String(request.id), "once")
          }
          return asked.length > 0
        }, "no approval was asked")
      })()
      required(state.local).reset()
      required(state.local).enqueue(say("pelican"), DONE)
      await team.turn(sessionID, SAY("pelican"))
      await answering
      expect(asked.some((line) => line.startsWith("shell:") && line.includes("pelican"))).toBe(true)
      expect(JSON.stringify(required((await toolParts(team.server, sessionID, "execute"))[0]).state)).toContain(
        "pelican",
      )

      const readOnly = await run(SAY("pelican"), [say("pelican"), DONE], { mode: "read-only" })
      expect(await permissions(team, readOnly.sessionID)).toEqual([])
      const refused = JSON.stringify(required(readOnly.calls[0]).state)
      expect(refused).not.toContain("exit 0")
    },
    STEP_TIMEOUT,
  )

  test(
    "a subagent the extension defines runs under the gate, with the fragment and the rule",
    async () => {
      const team = required(state.team)
      // Subagents run in the background since upstream v2.3.0 (#63382): the parent's next request and the child's run
      // at once, so a FIFO of replies would mix them. The directive responder answers each request from its own user
      // text instead (the parent's `[subagent …]`, the child's two `[tool ext_say …]`).
      const result = await run(`[subagent crosscheck ${BOTH}]`, [], {})
      const call = required((await toolParts(team.server, result.sessionID, "subagent"))[0])
      expect(call.state.status).toBe("completed")
      const child = await childOf(team.server, call)
      await team.server.waitIdle(child.id)
      expect(child.agent).toBe("crosscheck")
      expect(JSON.stringify(await instructionEntries(team.server, child.id))).toContain(FRAGMENT)
      expectSaid(await toolParts(team.server, child.id, "execute"))
    },
    STEP_TIMEOUT,
  )
})

/** The two `ext_say` calls of {@link BOTH}: the first ran, the rule refused the second. */
function expectSaid(calls: ReadonlyArray<ToolPart>) {
  expect(calls.length).toBe(2)
  const [said, refused] = calls.map((call) => JSON.stringify(call.state))
  expect(said).toContain("pelican")
  expect(said).toContain("exit 0")
  expect(refused).toContain("not that word")
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("missing value")
  return value
}
