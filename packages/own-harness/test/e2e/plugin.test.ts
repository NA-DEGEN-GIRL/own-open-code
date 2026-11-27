// Boots the upstream server from source (own-accounts' e2e kit) with own.harness and a fake OpenAI Responses provider,
// then checks the H0 wiring end to end: a new top-level session gets the default harness in its metadata, a child gets
// its parent's, a session that names one keeps it, and `session.set` switches between runs with one notice that the
// next model request carries before the prompt. The same flow then runs against the single-file bundle built by
// own-remote's release bundler (cross-bundle Effect interop through `Portable.definition`).
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  openAIResponsesProvider,
  opencodeConfig,
  REPO_ROOT,
  sessionInfo,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { plugins } from "../../../own-remote/script/bundle.ts"
import { Gate } from "../../src/gate.js"
import { Notice } from "../../src/notice.js"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "m" }

flow("own.harness from source", async () => ({ plugin: path.join(REPO_ROOT, "packages/own-harness") }))

flow("own.harness as the release bundle", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "own-harness-bundle-"))
  // The source server reports app version "local"; the bundle's guard must expect exactly that.
  const built = await plugins({ out: temp, version: "local", buildId: "e2eharness01", packages: ["own-harness"] })
  expect(fs.readFileSync(built["own-harness"]!, "utf8")).toContain('"e2eharness01"')
  return { plugin: path.dirname(built["own-harness"]!), temp }
})

function flow(name: string, setup: () => Promise<{ readonly plugin: string; readonly temp?: string }>) {
  describe(name, () => {
    const state: { server?: OpencodeServer; fake?: FakeOpenAIResponses; temp?: string } = {}
    const server = () => state.server!

    beforeAll(async () => {
      const prepared = await setup()
      state.temp = prepared.temp
      const fake = startFakeOpenAIResponses()
      state.fake = fake
      state.server = await startOpencodeServer({
        startupTimeoutMs: 170_000,
        env: { OWN_OPEN_CODE: "1" },
        config: () =>
          opencodeConfig({
            providers: {
              "fake-a": openAIResponsesProvider(fake, { apiKey: "fake-key-a", models: { m: { name: "m" } } }),
            },
            plugins: [{ package: prepared.plugin, options: {} }],
          }),
      })
      await state.server.waitForModels([MODEL])
    }, BOOT_TIMEOUT)

    // Stopping the server and removing the bundle's folder can take longer than bun's 5 s hook default on a busy PC.
    afterAll(async () => {
      await state.server?.stop()
      await state.fake?.stop()
      if (state.temp) fs.rmSync(state.temp, { recursive: true, force: true })
    }, 60_000)

    async function harnessOf(sessionID: string) {
      return OwnHarness.bound((await sessionInfo(server(), sessionID)).metadata as Record<string, unknown> | undefined)
    }

    async function create(body: Record<string, unknown>) {
      const created = (await server().call("POST", "/api/session", {
        body: { title: "harness e2e", model: MODEL, location: { directory: server().paths.workspace }, ...body },
      })) as { data: { id: string } }
      return created.data.id
    }

    async function rpc(method: string, input: unknown) {
      const response = await server().request("POST", `/api/rpc/${OwnHarness.ID}/${method}`, {
        body: { input },
        query: { "location[directory]": server().paths.workspace },
      })
      return { status: response.status, body: (await response.json()) as { output?: unknown } }
    }

    test(
      "binding: default for a new session, the parent's for a child, an explicit one kept",
      async () => {
        const root = await create({})
        await until(async () => (await harnessOf(root)) === "codex")
        // H-D7 (amended 2026-10-17): own's revision is the plugin's default prompt variant.
        expect(OwnHarness.promptOf((await sessionInfo(server(), root)).metadata as Record<string, unknown>)).toBe("own")
        const child = await create({ parentID: root, location: undefined, metadata: { other: 1 } })
        await until(async () => (await harnessOf(child)) === "codex")
        expect((await sessionInfo(server(), child)).metadata).toMatchObject({ other: 1 })
        const explicit = await create({ metadata: { [OwnHarness.META_KEY]: OwnHarness.value("opencode") } })
        expect(await harnessOf(explicit)).toBe("opencode")
        // own-web's composer names the harness; the session still gets that harness's tool gate.
        const named = await create({ metadata: { [OwnHarness.META_KEY]: OwnHarness.value("codex") } })
        await until(async () =>
          ((await sessionInfo(server(), named)).permissions as ReadonlyArray<unknown> | undefined)?.some(
            (rule) => JSON.stringify(rule) === JSON.stringify(Gate.ALLOW),
          ) === true,
        )
        expect((await rpc("list", {})).body.output).toMatchObject({
          harnesses: ["opencode", "codex", "pi", "dsh", "claude-code"],
          default: "codex",
          prompts: ["reference", "own", "custom"],
          defaultPrompt: "own",
        })
      },
      60_000,
    )

    test(
      "defaults.set: a new top-level session that names none gets the stored default; a child keeps its parent's",
      async () => {
        const set = await rpc("defaults.set", { harness: "pi", prompt: "own" })
        expect(set.status).toBe(200)
        expect(set.body.output).toMatchObject({ default: "pi", defaultPrompt: "own" })
        try {
          const root = await create({})
          await until(async () => (await harnessOf(root)) === "pi")
          expect(OwnHarness.promptOf((await sessionInfo(server(), root)).metadata as Record<string, unknown>)).toBe("own")
          const parent = await create({ metadata: { [OwnHarness.META_KEY]: OwnHarness.value("codex") } })
          const child = await create({ parentID: parent, location: undefined })
          await until(async () => (await harnessOf(child)) === "codex")
        } finally {
          // Plugin storage outlives the test; the other tests expect the plugin options' codex and own.
          await rpc("defaults.set", { harness: "codex", prompt: "own" })
        }
      },
      60_000,
    )

    test(
      "session.set switches and the next request carries the notice before the prompt",
      async () => {
        const fake = state.fake!
        const sessionID = await create({ metadata: { [OwnHarness.META_KEY]: OwnHarness.value("opencode") } })
        const switched = await rpc("session.set", { sessionID, harness: "codex" })
        expect(switched.status).toBe(200)
        expect(switched.body.output).toEqual({ sessionID, harness: "codex", explicit: true, prompt: "reference" })
        expect(await harnessOf(sessionID)).toBe("codex")

        fake.enqueue({ type: "text", text: "ok" }, { type: "text", text: "title" })
        const before = fake.requests.length
        await server().prompt(sessionID, "hello there")
        await server().waitIdle(sessionID)
        const request = fake.requests
          .slice(before)
          .map((item) => item.body)
          .find((body) => body.includes("hello there"))
        expect(request).toBeDefined()
        const notice = JSON.stringify(Notice.text("opencode", "codex")).slice(1, -1)
        expect(request!.indexOf(notice)).toBeGreaterThan(-1)
        expect(request!.indexOf(notice)).toBeLessThan(request!.indexOf("hello there"))
        expect(request!.split(notice).length).toBe(2)
      },
      120_000,
    )

    test(
      "prompt variants: own's revision for a model outside Codex's catalog and for Pi, and back to the original",
      async () => {
        const fake = state.fake!
        const ask = async (sessionID: string, text: string) => {
          fake.enqueue({ type: "text", text: "ok" }, { type: "text", text: "title" })
          const before = fake.requests.length
          await server().prompt(sessionID, text)
          await server().waitIdle(sessionID)
          return fake.requests
            .slice(before)
            .map((item) => item.body)
            .find((body) => body.includes(text))!
        }
        const codex = await create({ metadata: { [OwnHarness.META_KEY]: OwnHarness.value("codex", "own") } })
        const revised = await ask(codex, "variant one")
        expect(revised).toContain("You are a coding agent running in own,")
        expect(revised).not.toContain("running in the Codex CLI")
        expect(revised).toContain("# Your Model")
        // own's approval modes in place of Codex's sandbox and escalation (10 §3.9); the session has no rules: ask.
        expect(revised).toContain("Approval mode: ask.")
        expect(revised).not.toContain("require_escalated")
        expect(revised).not.toContain('"prefix_rule"')
        expect(revised).toContain("apply_patch <<'EOF'")
        expect(revised).toContain("Each tool is listed by its argument names")
        const back = await rpc("session.set", { sessionID: codex, harness: "codex", prompt: "reference" })
        expect(back.body.output).toEqual({ sessionID: codex, harness: "codex", explicit: true, prompt: "reference" })
        const original = await ask(codex, "variant two")
        expect(original).toContain("You are a coding agent running in the Codex CLI")
        expect(original).not.toContain("# Your Model")
        expect(original).toContain("require_escalated")

        const pi = await create({ metadata: { [OwnHarness.META_KEY]: OwnHarness.value("pi", "own") } })
        const child = await create({ parentID: pi, location: undefined, metadata: { other: 1 } })
        await until(async () => OwnHarness.promptOf((await sessionInfo(server(), child)).metadata as Record<string, unknown> | undefined) === "own")
        expect(await ask(pi, "variant three")).toContain("Each tool is listed by its argument names")
      },
      180_000,
    )

    test("compaction.set stores the fallback list and null returns to the automatic choice", async () => {
      expect((await rpc("compaction.get", {})).body.output).toMatchObject({ automatic: true })
      const chosen = [{ providerID: "fake-a", modelID: "gpt-5.5" }]
      const set = await rpc("compaction.set", { models: chosen })
      expect(set.status).toBe(200)
      expect(set.body.output).toEqual({ automatic: false, models: chosen })
      expect((await rpc("compaction.get", {})).body.output).toEqual({ automatic: false, models: chosen })
      expect((await rpc("compaction.set", { models: null })).body.output).toMatchObject({ automatic: true })
    })

    test("an unknown session is session_not_found", async () => {
      const answer = await rpc("session.get", { sessionID: "ses_harness_e2e_unknown_aaaaaa" })
      expect(answer.status).toBe(400)
      expect(JSON.stringify(answer.body)).toContain("session_not_found")
    })
  })
}

/** Polls `check` every 50 ms for up to 15 s: own.harness stamps a new session after its `session.created` event. */
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met within 15 s")
    await Bun.sleep(50)
  }
}
