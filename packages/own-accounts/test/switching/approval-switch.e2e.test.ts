// End to end on a real upstream server: a session's approval mode survives model switches (02 §9.2, 03 §18.8), and
// web search's first use asks for a search service with a form, which is not a permission (03 §18.2).
//
// Reported on 2.0.24-own.2: after `지금 전환` from GPT-6.1 Sol to GPT-6 Astra on the same `siwc` account, a session in
// `전체 허용` showed `웹 검색을 허용할까요?`. The session's rules still ended with the `full` bundle; the card was core's
// first-use choice of a search service (`websearch:provider` in the server-wide KV, never set before), asked the first
// time any model called the `websearch` tool. The model before the switch had only used `webfetch`.
//
// - `full` holds across a switch on the same account, to another account and back: shell, patch and webfetch run with
//   no `permission.asked`, and `session.approval.get` still reads `full` with the same rules.
// - Without a chosen service, `websearch` under `full` never asks with a permission request. With a ChatGPT account
//   own's `own-chatgpt` service (02 §9.2) is the default, so the first use asks nothing at all; without one, core asks
//   once with the `websearch.provider` form instead.
//
// own-accounts loads from its package directory (`startPresetRig`) with two linked ChatGPT accounts answering from one
// fake Codex backend, plus a local plugin that adds the search service `fake-search` (no network). The scripted model
// reads a directive in the last user text. Every credential is fake; the server binds 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import {
  afterToolResult,
  lastUserText,
  sessionInfo,
  startFakeCodex,
  startPresetRig,
  toolParts,
  waitUntil,
  WEBSEARCH_FIXTURE_PLUGIN,
  type FakeCodex,
  type PresetRig,
  type RecordedRequest,
  type Reply,
  type ServerEvent,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).

/** What `여러 서비스 함께` would ask (MS): own's default, ChatGPT and core's keyless services (never a plugin's). */
const MULTI = { services: ["own-chatgpt", "exa", "firecrawl", "parallel", "tavily", "tinyfish"], custom: false }

setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const ACCOUNTS = {
  "01": { accountID: "acct-as-01", email: "one@example.test", plan: "plus" },
  "02": { accountID: "acct-as-02", email: "two@example.test", plan: "plus" },
} as const
const SOL_01 = { providerID: "own-codex-pg01", id: "gpt-6-sol", variant: "high" }
const LUNA_01 = { providerID: "own-codex-pg01", id: "gpt-6-luna", variant: "high" }
const SOL_02 = { providerID: "own-codex-pg02", id: "gpt-6-sol", variant: "high" }
const AFTER_TOOL = "도구 결과를 읽었습니다."

const fixture: { codex?: FakeCodex; rig?: PresetRig; session?: string } = {}

beforeAll(async () => {
  const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: 32 }, responder: reply })
  fixture.codex = codex
  fixture.rig = await startPresetRig({
    name: "approval-switch",
    codex,
    chatgpt: [
      { id: "01", tokens: codex.login(ACCOUNTS["01"]) },
      { id: "02", tokens: codex.login(ACCOUNTS["02"]) },
    ],
    plugins: [WEBSEARCH_FIXTURE_PLUGIN],
    // `websearch.set` writes the global config; an installed service reloads it through the file watcher.
    watchConfig: true,
    models: [SOL_01, LUNA_01, SOL_02],
  })
  const session = await fixture.rig.server.createSession({ model: SOL_01 })
  fixture.session = session.id
  expect(await fixture.rig.call("session.approval.set", { sessionID: session.id, mode: "full" })).toMatchObject({
    mode: "full",
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await fixture.codex?.stop()
}, 60_000)

describe("`full` approval across model switches (02 §9.2, 03 §18.8)", () => {
  const steps = [
    { name: "before any switch", target: undefined },
    { name: "after a switch on the same account (Sol → Luna)", target: LUNA_01 },
    { name: "after a switch to another account", target: SOL_02 },
    { name: "after switching back", target: SOL_01 },
  ] as const

  for (const step of steps)
    test(
      `${step.name}: shell, patch and webfetch run without asking`,
      async () => {
        const rig = required(fixture.rig)
        const sessionID = required(fixture.session)
        const before = await rig.call("session.approval.get", { sessionID })
        if (step.target) await switchTo(sessionID, step.target)
        const after = await rig.call("session.approval.get", { sessionID })
        expect(after).toMatchObject({ mode: "full" })
        expect(after.rules).toEqual(before.rules)
        for (const directive of ["[shell]", "[patch]", "[webfetch]"]) {
          const asked = asks().length
          await turn(sessionID, `${directive} ${step.name}`)
          expect(asks().slice(asked)).toEqual([])
        }
        const model = step.target ?? SOL_01
        const last = required(fixture.codex).requests.findLast((request) => request.model !== undefined)
        expect(last?.model).toBe(model.id)
        const shells = await toolParts(rig.server, sessionID, "shell")
        expect(shells.at(-1)?.state.status).toBe("completed")
        const patches = await toolParts(rig.server, sessionID, "patch")
        expect(patches.at(-1)?.state.status).toBe("completed")
        // The webfetch target answers 404; what matters is that nobody was asked.
        expect((await toolParts(rig.server, sessionID, "webfetch")).length).toBeGreaterThan(0)
      },
      TURN_TIMEOUT,
    )
})

describe("web search's first use (03 §18.2)", () => {
  test(
    "under `full` with a ChatGPT account, ChatGPT search is the default: nobody is asked, neither a form nor a permission",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(fixture.session)
      await switchTo(sessionID, LUNA_01)
      const asked = asks().length
      const asking = forms().length
      await turn(sessionID, "[websearch] 최신 BIOS")
      const [search] = (await toolParts(rig.server, sessionID, "websearch")).slice(-1)
      expect(search?.state.status).toBe("completed")
      expect(search?.state.metadata).toMatchObject({ provider: "own-chatgpt" })
      expect(asks().slice(asked)).toEqual([])
      expect(forms().slice(asking)).toEqual([])
      // The session is still `full`: the next shell call is not asked either.
      await turn(sessionID, "[shell] 웹 검색 뒤")
      expect(asks().slice(asked)).toEqual([])
    },
    TURN_TIMEOUT,
  )
})

describe("the web search service chosen once in settings (`websearch.*`, 03 §18.2)", () => {
  test("nothing is chosen in the config file yet; an unlisted service is refused", async () => {
    const rig = required(fixture.rig)
    // `keys`: no listed service has a key of the user's (the fake one has a key method, like Exa and Parallel).
    expect(await rig.call("websearch.get")).toEqual({ keys: {}, multi: MULTI })
    const refused = await rig.rpc("websearch.set", { choice: { type: "service", id: "no-such-search" } })
    expect(refused.status).not.toBe(200)
    expect(refused.error).toMatchObject({ type: "websearch_unavailable", data: { reason: "unknown_service" } })
    expect(await rig.call("websearch.get")).toEqual({ keys: {}, multi: MULTI })
  })

  test(
    "a chosen service is core's `websearch` key: after a switch to another account the search runs, nobody is asked",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(fixture.session)
      const choice = { type: "service", id: "fake-search" }
      expect(await rig.call("websearch.set", { choice })).toEqual({ choice, keys: {}, multi: MULTI })
      expect(await rig.call("websearch.get")).toEqual({ choice, keys: {}, multi: MULTI })
      const config = await Bun.file(path.join(rig.server.paths.config, "opencode.jsonc")).json()
      expect(config.websearch).toEqual({ provider: "fake-search" })
      await configured((value) => isRecord(value) && value.provider === "fake-search")
      await switchTo(sessionID, SOL_02)
      const asked = asks().length
      const asking = forms().length
      await turn(sessionID, "[websearch] 최신 BIOS")
      const [search] = (await toolParts(rig.server, sessionID, "websearch")).slice(-1)
      expect(search?.state.status).toBe("completed")
      expect(search?.state.metadata).toMatchObject({ provider: "fake-search" })
      expect(asks().slice(asked)).toEqual([])
      expect(forms().slice(asking)).toEqual([])
    },
    TURN_TIMEOUT,
  )

  test(
    "`off` drops the tool from the next request and a later choice brings it back (다시 켜기)",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(fixture.session)
      expect(await rig.call("websearch.set", { choice: { type: "off" } })).toEqual({
        choice: { type: "off" },
        keys: {},
        multi: MULTI,
      })
      await configured((value) => value === false)
      await turn(sessionID, "웹 검색 꺼짐")
      expect(lastTools()).not.toContain("websearch")
      const any = { type: "any" }
      expect(await rig.call("websearch.set", { choice: any })).toEqual({ choice: any, keys: {}, multi: MULTI })
      expect(await rig.call("websearch.get")).toEqual({ choice: any, keys: {}, multi: MULTI })
      await configured((value) => isRecord(value) && value.provider === "random")
      await turn(sessionID, "웹 검색 다시 켬")
      expect(lastTools()).toContain("websearch")
    },
    TURN_TIMEOUT,
  )

  test(
    "`기본으로` (`default`) removes the key: the next search is ChatGPT's again; a stored key shows in `keys`",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(fixture.session)
      expect(await rig.call("websearch.set", { choice: { type: "default" } })).toEqual({ keys: {}, multi: MULTI })
      expect(await rig.call("websearch.get")).toEqual({ keys: {}, multi: MULTI })
      const config = await Bun.file(path.join(rig.server.paths.config, "opencode.jsonc")).json()
      expect(config).not.toHaveProperty("websearch")
      await unconfigured()
      const asking = forms().length
      await turn(sessionID, "[websearch] 최신 BIOS")
      const [search] = (await toolParts(rig.server, sessionID, "websearch")).slice(-1)
      expect(search?.state.status).toBe("completed")
      expect(search?.state.metadata).toMatchObject({ provider: "own-chatgpt" })
      expect(forms().slice(asking)).toEqual([])
      // A key stored for a listed service's integration (here through core's own route, as the upstream app does).
      await rig.server.call("POST", "/api/integration/fake-search/connect/key", {
        body: { key: "fake-search-key-0001" },
      })
      expect(await rig.call("websearch.get")).toEqual({ keys: { "fake-search": "key" }, multi: MULTI })
    },
    TURN_TIMEOUT,
  )
})

test("no hook failed", () => {
  expect(required(fixture.rig).server.logs()).not.toMatch(/hook_failed/)
})

// ---------------------------------------------------------------------------------------------------------------

/** `지금 전환` as own-web sends it, then waits until the session runs on `target`. */
async function switchTo(sessionID: string, target: { readonly providerID: string; readonly id: string }) {
  const rig = required(fixture.rig)
  await rig.call("switch.apply", { sessionID, target, strategy: "now", reason: "manual" })
  await waitUntil(
    async () => {
      const model = (await sessionInfo(rig.server, sessionID)).model
      return isRecord(model) && model.providerID === target.providerID && model.id === target.id
    },
    `the session never moved to ${target.providerID}/${target.id}`,
    60_000,
  )
}

async function turn(sessionID: string, text: string) {
  const rig = required(fixture.rig)
  await rig.server.prompt(sessionID, text)
  await rig.server.waitIdle(sessionID)
}

/** The scripted model: a tool result gets a short text; a directive calls one tool. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(request)
  if (text.includes("[shell]")) return { type: "tool-call", name: "shell", input: { command: "echo approval" } }
  if (text.includes("[patch]")) {
    const file = `approval-${Bun.hash(text).toString(16)}.txt`
    return {
      type: "tool-call",
      name: "patch",
      input: { patchText: ["*** Begin Patch", `*** Add File: ${file}`, "+full", "*** End Patch"].join("\n") },
    }
  }
  if (text.includes("[webfetch]"))
    return {
      type: "tool-call",
      name: "webfetch",
      input: { url: `${required(fixture.codex).url}/approval-switch`, format: "text" },
    }
  if (text.includes("[websearch]")) return { type: "tool-call", name: "websearch", input: { query: "latest bios" } }
  return { type: "text", text: "답변" }
}

/** Waits until core's config holds a `websearch` value that matches (the config watcher reloaded the file). */
async function configured(match: (value: unknown) => boolean) {
  const rig = required(fixture.rig)
  await waitUntil(
    async () => {
      const entries = await rig.server.call("GET", "/api/config")
      const last = (Array.isArray(entries) ? entries : [])
        .filter(
          (entry) => isRecord(entry) && entry.type === "document" && isRecord(entry.info) && "websearch" in entry.info,
        )
        .at(-1)
      return isRecord(last) && isRecord(last.info) && match(last.info.websearch)
    },
    "core never loaded the websearch key",
    30_000,
  )
}

/** Waits until no config document holds a `websearch` key (the watcher reloaded the file after `default`). */
async function unconfigured() {
  const rig = required(fixture.rig)
  await waitUntil(
    async () => {
      const entries = await rig.server.call("GET", "/api/config")
      return (
        Array.isArray(entries) &&
        !entries.some(
          (entry) => isRecord(entry) && entry.type === "document" && isRecord(entry.info) && "websearch" in entry.info,
        )
      )
    },
    "core kept the websearch key",
    30_000,
  )
}

/** The tool names of the last model request. */
function lastTools() {
  const last = required(fixture.codex).requests.findLast((request) => request.model !== undefined)
  const tools = isRecord(last?.json) && Array.isArray(last.json.tools) ? last.json.tools : []
  return tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []))
}

/** Every permission request the server asked (`permission.asked`). */
function asks(): ReadonlyArray<ServerEvent> {
  return required(fixture.rig).events.events.filter((event) => event.type === "permission.asked")
}

function forms(): ReadonlyArray<ServerEvent> {
  return required(fixture.rig).events.events.filter((event) => event.type === "form.created")
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
