// Boots the upstream server from source (own-accounts' e2e kit) with own-accounts and own.computer-use (driver
// "fake": an in-memory desktop, never the real one) and a fake OpenAI Responses provider, then checks the wiring end to
// end: the computer tools are absent from model requests until own-accounts turns computer use on for the session (for
// a config-defined agent too, through the deny registered again after the plugins activated), a Code Mode screenshot
// reaches the next model request as an image, and the kill switch blocks the next call. The same flow then runs
// against the single-file bundle built by own-remote's release bundler (cross-bundle Effect interop).
// On Windows the bundle also runs with the in-process driver (`driver: "windows"`): a read-only `cursor_position` call
// starts its desktop worker from the bundled source text and gets `hello`, `cursor.get` and `displays` answered on the
// real desktop (no input, no capture).
// An own `compat` slot (a local model through own-accounts, 02 §3.3) shows the same path over Chat Completions: the
// screenshot reaches a model that reads images as an `image_url` part, and a text-only model is refused with
// `[computer.no_vision]` before the driver (01 §10.2).
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { OwnComputer } from "@own/protocol/rpc-computer"
import {
  openAIResponsesProvider,
  opencodeConfig,
  REPO_ROOT,
  startFakeOpenAIChat,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIChat,
  type FakeOpenAIResponses,
  type FakeProvider,
  type OpencodeServer,
  type Reply,
} from "../../../own-accounts/test/e2e-kit"
import { plugins } from "../../../own-remote/script/bundle.ts"

const BOOT_TIMEOUT = 180_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const COMPUTER = path.join(REPO_ROOT, "packages/own-computer-use")
const MODEL = { providerID: "fake-a", id: "m" }
const SCREENSHOT = "return await tools.computer.screenshot({})"

async function boot(fake: FakeOpenAIResponses, computer: string, buildId: string, driver: "fake" | "windows" = "fake") {
  return startOpencodeServer({
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) =>
      opencodeConfig({
        providers: {
          // A large window: screenshots are big, and an automatic compaction would take the scripted replies.
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { m: { name: "m", limit: { context: 4_000_000, output: 32_000 } } },
          }),
        },
        plugins: [
          { package: ACCOUNTS, options: { home: paths.ownHome, buildId: `${buildId}-accounts`, vault: "memory" } },
          { package: computer, options: { home: paths.ownHome, buildId, driver } },
        ],
        // Created by core's config plugin after external plugins ran their agent transforms.
        extra: { agents: { helper: { description: "config-defined agent", mode: "primary" } } },
      }),
  })
}

async function rpc(server: OpencodeServer, id: string, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${id}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  return { status: response.status, body: (await response.json()) as { output?: unknown } }
}

interface AgentRow {
  readonly id: string
  readonly permissions: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: string }>
}

function isDeny(rule: AgentRow["permissions"][number]) {
  return rule.action === "computer" && rule.resource === "*" && rule.effect === "deny"
}

/** The workspace's agents once the config's `helper` carries the computer deny (the late registration ran). */
async function denied(server: OpencodeServer) {
  const deadline = Date.now() + 30_000
  while (true) {
    const response = await server.request("GET", "/api/agent", {
      query: { "location[directory]": server.paths.workspace },
    })
    const agents = ((await response.json()) as { data: ReadonlyArray<AgentRow> }).data
    if (agents.find((agent) => agent.id === "helper")?.permissions.some(isDeny)) return agents
    if (Date.now() > deadline) throw new Error("the config agent never got the computer deny")
    await Bun.sleep(100)
  }
}

/** One prompt turn: the scripted replies, then the bodies of the model requests it made. */
async function turn(server: OpencodeServer, fake: FakeProvider, sessionID: string, replies: ReadonlyArray<Reply>) {
  const before = fake.requests.length
  fake.enqueue(...replies)
  await server.prompt(sessionID, "go")
  await server.waitIdle(sessionID)
  return fake.requests.slice(before).map((request) => request.body)
}

interface Setup {
  readonly computer: string
  readonly buildId: string
  /** Removed after the run (the bundle's temp directory). */
  readonly temp?: string
}

function flow(name: string, setup: () => Promise<Setup>) {
  describe(name, () => {
    const state: { server?: OpencodeServer; fake?: FakeOpenAIResponses; temp?: string } = {}

    beforeAll(async () => {
      const input = await setup()
      state.temp = input.temp
      state.fake = startFakeOpenAIResponses({ models: ["m"] })
      state.server = await boot(state.fake, input.computer, input.buildId)
      await state.server.waitForModels([MODEL])
    }, BOOT_TIMEOUT)

    afterAll(async () => {
      await state.server?.stop()
      await state.fake?.stop()
      if (state.temp !== undefined) fs.rmSync(state.temp, { recursive: true, force: true })
    }, 60_000)

    test("tools are hidden until the session enables computer use; a screenshot reaches the model; the kill switch stops", async () => {
      const server = state.server!
      const fake = state.fake!
      const status = await rpc(server, OwnComputer.ID, "status")
      expect(status.status).toBe(200)
      expect(status.body.output).toMatchObject({ available: true, driver: "fake", killSwitch: { engaged: false } })
      expect(server.logs()).not.toMatch(/own\.computer-use.*(setup_failed|guard_failed)/)

      const session = await server.createSession({ model: MODEL, title: "computer use" })
      const hidden = await turn(server, fake, session.id, [{ type: "text", text: "ok" }])
      expect(hidden.length).toBeGreaterThan(0)
      for (const body of hidden) expect(body).not.toContain("computer.screenshot")

      const enabled = await rpc(server, OwnAccounts.ID, "session.approval.set", {
        sessionID: session.id,
        mode: "ask",
        computerUse: "on",
      })
      expect(enabled.status).toBe(200)
      expect(enabled.body.output).toMatchObject({ computerUse: "on" })

      const shot = await turn(server, fake, session.id, [
        { type: "tool-call", name: "execute", input: { code: SCREENSHOT } },
        { type: "text", text: "seen" },
      ])
      expect(shot).toHaveLength(2)
      expect(shot[0]).toContain("computer.screenshot")
      expect(shot[1]).toMatch(/data:image\/png;base64,iVBORw0KGgo/)
      // Code Mode hands the tool output to the code and re-attaches the image to the execute result (the returned
      // value is compact JSON since upstream v2.4).
      expect(shot[1]).toMatch(/\\"captureId\\": ?\\"cap_[0-9a-z]+\\"/)

      const engaged = await rpc(server, OwnComputer.ID, "killswitch.engage")
      expect(engaged.body.output).toMatchObject({ engaged: true, reason: "rpc" })
      const stopped = await turn(server, fake, session.id, [
        { type: "tool-call", name: "execute", input: { code: SCREENSHOT } },
        { type: "text", text: "stopped" },
      ])
      expect(stopped[1]).toContain("[computer.stopped]")

      const audit = (await rpc(server, OwnComputer.ID, "audit.list", { sessionID: session.id })).body.output as {
        readonly entries: ReadonlyArray<OwnComputer.AuditEntry>
      }
      expect(audit.entries.map((entry) => [entry.outcome, entry.code])).toEqual([
        ["denied", "stopped"],
        ["ok", undefined],
      ])
      await rpc(server, OwnComputer.ID, "killswitch.reset")
    }, 120_000)

    test("a config-defined agent gets the deny too: its tools are listed only after the session switch is on", async () => {
      const server = state.server!
      const fake = state.fake!
      // Core creates the config's agents after every configured plugin; the deny registered again after this
      // Location's plugin.updated reaches them. Every agent ends up with exactly one deny and no other rule (TG16).
      const agents = await denied(server)
      expect(agents.map((agent) => agent.id)).toContain("helper")
      for (const agent of agents) expect(agent.permissions.filter(isDeny)).toHaveLength(1)

      const created = await server.request("POST", "/api/session", {
        body: { title: "config agent", model: MODEL, agent: "helper", location: { directory: server.paths.workspace } },
      })
      expect(created.status).toBe(200)
      const session = ((await created.json()) as { data: { id: string } }).data
      const hidden = await turn(server, fake, session.id, [{ type: "text", text: "ok" }])
      expect(hidden.length).toBeGreaterThan(0)
      for (const body of hidden) expect(body).not.toContain("computer.screenshot")

      const enabled = await rpc(server, OwnAccounts.ID, "session.approval.set", {
        sessionID: session.id,
        mode: "ask",
        computerUse: "on",
      })
      expect(enabled.status).toBe(200)
      const shot = await turn(server, fake, session.id, [
        { type: "tool-call", name: "execute", input: { code: SCREENSHOT } },
        { type: "text", text: "seen" },
      ])
      expect(shot).toHaveLength(2)
      expect(shot[0]).toContain("computer.screenshot")
      expect(shot[1]).toMatch(/data:image\/png;base64,iVBORw0KGgo/)
    }, 120_000)
  })
}

flow("own.computer-use from source", async () => ({ computer: COMPUTER, buildId: "e2e-computer-source" }))

describe("own.computer-use on a compat slot (02 §3.3, 01 §10.2)", () => {
  const VISION = "local-vl"
  const TEXT = "local-text"
  const state: { server?: OpencodeServer; chat?: FakeOpenAIChat; providerID?: string } = {}

  beforeAll(async () => {
    state.chat = startFakeOpenAIChat({ models: [VISION, TEXT] })
    state.server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            { package: ACCOUNTS, options: { home: paths.ownHome, buildId: "e2e-compat-accounts", vault: "memory" } },
            { package: COMPUTER, options: { home: paths.ownHome, buildId: "e2e-compat-computer", driver: "fake" } },
          ],
        }),
    })
    const control = path.join(state.server.paths.ownHome, "control")
    const chat = state.chat
    await fsp.mkdir(control, { recursive: true })
    // Plugins load in the background since upstream v2.4.0 (#63814): own.accounts answers `rpc.unavailable` until it
    // registered in the control Location, so the call is asked again for up to 60 s.
    const server = state.server
    const response = await untilRegistered(() =>
      server.request("POST", `/api/rpc/${OwnAccounts.ID}/accounts.add.key`, {
        body: {
          input: {
            kind: "compat",
            label: "Local",
            key: "sk-e2e-compat-computer-0000000000000001",
            // The fake says nothing about its models, so the user's settings decide (`그림 입력`).
            options: {
              baseURL: chat.baseURL,
              models: [
                { id: VISION, contextLimit: 4_000_000, image: "on" },
                { id: TEXT, contextLimit: 4_000_000 },
              ],
            },
          },
        },
        query: { "location[directory]": control },
        directory: control,
      }),
    )
    const added = (await response.json()) as { output?: { account?: { providerID?: string } } }
    state.providerID = added.output?.account?.providerID
    if (!state.providerID) throw new Error(`accounts.add.key failed: ${JSON.stringify(added)}`)
    await state.server.waitForModels([
      { providerID: state.providerID, id: VISION },
      { providerID: state.providerID, id: TEXT },
    ])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await state.chat?.stop()
  }, 60_000)

  async function enabled(model: string) {
    const server = state.server!
    const session = await server.createSession({ model: { providerID: state.providerID!, id: model }, title: model })
    const result = await rpc(server, OwnAccounts.ID, "session.approval.set", {
      sessionID: session.id,
      mode: "ask",
      computerUse: "on",
    })
    expect(result.body.output).toMatchObject({ computerUse: "on" })
    return session
  }

  test("a model that reads images gets the screenshot as an image_url part", async () => {
    const session = await enabled(VISION)
    const shot = await turn(state.server!, state.chat!, session.id, [
      { type: "tool-call", name: "execute", input: { code: SCREENSHOT } },
      { type: "text", text: "seen" },
    ])
    expect(shot).toHaveLength(2)
    expect(shot[1]).toContain(`"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo`)
    expect(shot[1]).not.toContain("[computer.no_vision]")
  }, 120_000)

  test("a text-only model is refused with no_vision before the driver", async () => {
    const session = await enabled(TEXT)
    const refused = await turn(state.server!, state.chat!, session.id, [
      { type: "tool-call", name: "execute", input: { code: SCREENSHOT } },
      { type: "text", text: "refused" },
    ])
    expect(refused).toHaveLength(2)
    expect(refused[1]).toContain("[computer.no_vision]")
    expect(refused[1]).not.toContain("image_url")
    const audit = (await rpc(state.server!, OwnComputer.ID, "audit.list", { sessionID: session.id })).body.output as {
      readonly entries: ReadonlyArray<OwnComputer.AuditEntry>
    }
    expect(audit.entries.map((entry) => [entry.outcome, entry.code])).toEqual([["denied", "no_vision"]])
  }, 120_000)
})

flow("own.computer-use as the release bundle", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "own-cu-bundle-"))
  // The source server reports app version "local"; the bundle's guard must expect exactly that.
  const built = await plugins({ out, version: "local", buildId: "e2ebundle001", packages: ["own-computer-use"] })
  expect(fs.readFileSync(built["own-computer-use"]!, "utf8")).toContain('"e2ebundle001"')
  return { computer: path.dirname(built["own-computer-use"]!), buildId: "e2e-computer-bundle", temp: out }
})

describe.skipIf(process.platform !== "win32")("own.computer-use bundle with the in-process Windows driver", () => {
  const state: { server?: OpencodeServer; fake?: FakeOpenAIResponses; temp?: string } = {}

  beforeAll(async () => {
    state.temp = fs.mkdtempSync(path.join(os.tmpdir(), "own-cu-bundle-ffi-"))
    const built = await plugins({
      out: state.temp,
      version: "local",
      buildId: "e2ebundle002",
      packages: ["own-computer-use"],
    })
    state.fake = startFakeOpenAIResponses({ models: ["m"] })
    state.server = await boot(state.fake, path.dirname(built["own-computer-use"]!), "e2e-computer-ffi", "windows")
    await state.server.waitForModels([MODEL])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await state.fake?.stop()
    if (state.temp !== undefined) fs.rmSync(state.temp, { recursive: true, force: true })
  }, 60_000)

  test("a computer call starts the desktop worker from the bundled source and it answers hello and displays", async () => {
    const server = state.server!
    const fake = state.fake!
    const before = (await rpc(server, OwnComputer.ID, "status")).body.output
    // Loading the plugin starts nothing.
    expect(before).toMatchObject({ available: true, driver: "windows", helper: { running: false } })
    const session = await server.createSession({ model: MODEL, title: "in-process driver" })
    await rpc(server, OwnAccounts.ID, "session.approval.set", { sessionID: session.id, mode: "ask", computerUse: "on" })
    const requests = await turn(server, fake, session.id, [
      {
        type: "tool-call",
        name: "execute",
        // A read-only screenshot also runs capture and the GDI+ resize/encode from the minified bundle's worker source.
        input: {
          code: "const cursor = await tools.computer.cursor_position({}); await tools.computer.screenshot({}); return cursor",
        },
      },
      { type: "text", text: "done" },
    ])
    expect(requests).toHaveLength(2)
    const after = (await rpc(server, OwnComputer.ID, "status")).body.output as OwnComputer.Status
    // hello answered by the bundle's worker: protocol 1, Per-Monitor-V2 (else it is refused and never runs), version.
    expect(after.helper).toMatchObject({ running: true, version: "local", protocol: 1 })
    // Another own-open-code service may hold the desktop mutex on a developer PC; then only hello is proven.
    const busy = requests[1]!.includes("another own-open-code computer-use driver")
    if (busy) console.warn("[own-cu-e2e] another driver holds the desktop mutex; displays not checked")
    // A locked or minimized remote desktop can be neither read (GetCursorPos) nor captured; the worker then answers
    // desktop_unavailable, so only hello is proven.
    const away = requests[1]!.includes("[computer.desktop_unavailable]")
    if (away) console.warn("[own-cu-e2e] the desktop is not interactive; cursor and capture not checked")
    // cursor.get and displays answered; with no screenshot yet the cursor has no image coordinates (`{x: null}`).
    if (!busy && !away) expect(requests[1]).toMatch(/\\"x\\": ?null/)
    if (!busy && !away) expect(requests[1]).not.toMatch(/\[computer\.[a-z_]+\]/)
    if (!busy && !away) expect(requests[1]).toMatch(/data:image\/(png|jpeg);base64,/)
    expect(server.logs()).not.toMatch(/own\.computer-use.*(setup_failed|guard_failed)/)
    const restarted = (await rpc(server, OwnComputer.ID, "helper.restart")).body.output
    expect(restarted).toMatchObject({ running: false })
  }, 120_000)
})

/** Sends again while the RPC answers `rpc.unavailable` (its plugin still loading), for up to 60 s. */
async function untilRegistered(send: () => Promise<Response>, deadline = Date.now() + 60_000): Promise<Response> {
  const response = await send()
  if (response.ok || Date.now() > deadline) return response
  if (!(await response.clone().text()).includes("rpc.unavailable")) return response
  await Bun.sleep(200)
  return untilRegistered(send, deadline)
}
