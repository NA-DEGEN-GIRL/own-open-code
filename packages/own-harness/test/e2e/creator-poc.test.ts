// Creator mode proof of concept (own/reports/creator-mode-2026-11-04.md §6). Not a product test: it runs only with
// OWN_CREATOR_POC=1. It asks whether a plugin written at runtime (as a model in a "creator" session would write it)
// reaches a running server without a rebuild, through core's existing local-plugin path and nothing own adds:
//   1. a generated plugin directory listed in the config loads, and its tool reaches the model and runs;
//   2. rewriting the plugin's file hot-reloads it: the next request carries v2's tool and v2 runs;
//   3. a broken rewrite fails to load, and core keeps the previous generation running (rollback for free);
//   4. writing v1's bytes back is a rollback;
//   5. dropping the entry from the config removes the tool from the next request;
//   6–7. the same plugin as a Code Mode tool (codemode: true, core's default): adding and changing it.
// Also recorded: what each change does to the DeepSeek-style prefix cache of the same session.
// Run from a path without '#': `OWN_CREATOR_POC=1 bun test test/e2e/creator-poc.test.ts` in packages/own-harness.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  deepseekProvider,
  opencodeConfig,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"

setDefaultTimeout(60_000)

const ENABLED = process.env.OWN_CREATOR_POC === "1"
const BOOT_TIMEOUT = 560_000
const TURN_TIMEOUT = 120_000
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const TOOL = "creator_echo"

/** The plugin a creator session would write: a Promise plugin with one tool and a load marker. */
function pluginSource(version: string, marker: string, codemode = false) {
  return `import fs from "node:fs"
import { Schema } from "effect"

export default {
  id: "creator.echo",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: ${JSON.stringify(TOOL)},
        options: { codemode: ${codemode} },
        description: "Echo text back (${version}).",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        execute: async ({ text }) => ({ output: { text: "${version}:" + text }, content: "${version}:" + text }),
      })
    })
    fs.writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(version)})
  },
}
`
}

type Chat = {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>
  tools?: Array<{ function: { name: string; description: string } }>
}

let fake: FakeOpenAIChat
let server: OpencodeServer
let dir: string
let entry: string
let marker: string
let config: Record<string, unknown>

describe.skipIf(!ENABLED)("creator mode PoC: a runtime-written local plugin", () => {
  beforeAll(async () => {
    fake = startFakeOpenAIChat({ models: [MODEL.id], cache: { minTokens: 0, blockTokens: 16 } })
    server = await startOpencodeServer({
      startupTimeoutMs: 540_000,
      // The kit turns core's file watcher off for speed; plugin hot reload rides on it, as in an installed service.
      env: { OPENCODE_DISABLE_FILEWATCHER: undefined },
      config: (paths) => {
        // Where a creator store could live: one directory per generated plugin, outside the release's app folder.
        dir = path.join(paths.root, "creator", "plugins", "creator-echo")
        entry = path.join(dir, "index.ts")
        marker = path.join(paths.root, "creator", "loaded.txt")
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(entry, pluginSource("v1", marker))
        config = opencodeConfig({
          providers: {
            "fake-ds": deepseekProvider(fake, {
              apiKey: "fake-key-ds",
              models: { [MODEL.id]: { name: "DeepSeek V4 Pro", limit: { context: 1_000_000, output: 32_000 } } },
            }),
          },
          plugins: [{ package: dir, options: {} }],
          model: `${MODEL.providerID}/${MODEL.id}`,
        })
        return config
      },
    })
    await server.waitForModels([MODEL])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    await fake?.stop()
  })

  let session: { id: string }
  const seen: Array<{ step: string; tool?: string; result?: string; cached?: number; prompt?: number }> = []

  /** One turn: the model calls the tool once, then answers. Returns the two requests the turn sent. */
  async function turn(step: string, call: boolean) {
    const before = fake.requests.length
    if (call) fake.enqueue({ type: "tool-call", name: TOOL, input: { text: step } })
    fake.enqueue({ type: "text", text: `done ${step}` })
    await server.prompt(session.id, `step ${step}`)
    await server.waitIdle(session.id)
    const requests = (await fake.waitForRequests(before + (call ? 2 : 1))).slice(before)
    const first = JSON.parse(requests[0].body) as Chat
    const last = JSON.parse(requests[requests.length - 1].body) as Chat
    const tool = first.tools?.find((item) => item.function.name === TOOL)?.function.description
    const result = call
      ? String(last.messages.findLast((message) => message.role === "tool")?.content ?? "")
      : undefined
    seen.push({
      step,
      tool,
      result,
      cached: requests[0].cache?.cachedTokens,
      prompt: requests[0].cache?.promptTokens,
    })
    return { tool, result }
  }

  async function waitForMarker(version: string) {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === version) return
      await Bun.sleep(200)
    }
    throw new Error(`plugin ${version} never loaded`)
  }

  async function pluginState() {
    const list = (await server.call("GET", "/api/plugin")) as {
      data: Array<{ id?: string; source: unknown; state: unknown }>
    }
    return list.data.filter((item) => JSON.stringify(item.source).includes("creator-echo"))
  }

  test(
    "1. the generated plugin loads, its tool reaches the model and runs",
    async () => {
      await waitForMarker("v1")
      expect((await pluginState()).map((item) => item.state)).toEqual([{ status: "active" }])
      session = await server.createSession({ model: MODEL })
      const result = await turn("one", true)
      expect(result.tool).toBe("Echo text back (v1).")
      expect(result.result).toContain("v1:one")
      // A second turn with nothing changed: the cache baseline.
      await turn("one-b", false)
    },
    TURN_TIMEOUT,
  )

  test(
    "2. rewriting the file hot-reloads the plugin without a restart",
    async () => {
      fs.writeFileSync(entry, pluginSource("v2", marker))
      await waitForMarker("v2")
      const result = await turn("two", true)
      expect(result.tool).toBe("Echo text back (v2).")
      expect(result.result).toContain("v2:two")
    },
    TURN_TIMEOUT,
  )

  test(
    "3. a broken rewrite fails to load and v2 keeps running",
    async () => {
      // A pre-activation check would have caught this before any write (Bun's transpiler alone does).
      const broken = pluginSource("v3", marker).replace("setup: async", "setup: async (((")
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(broken)).toThrow()
      fs.writeFileSync(entry, broken)
      const deadline = Date.now() + 60_000
      let states = await pluginState()
      while (Date.now() < deadline && !states.some((item) => JSON.stringify(item.state).includes("failed"))) {
        await Bun.sleep(200)
        states = await pluginState()
      }
      seen.push({ step: `three: plugin list ${JSON.stringify(states.map((item) => item.state))}` })
      expect(states.some((item) => JSON.stringify(item.state).includes("failed"))).toBe(true)
      const result = await turn("three", true)
      expect(result.tool).toBe("Echo text back (v2).")
      expect(result.result).toContain("v2:three")
    },
    TURN_TIMEOUT,
  )

  test(
    "4. writing v1's bytes back rolls back",
    async () => {
      fs.writeFileSync(entry, pluginSource("v1", marker))
      await waitForMarker("v1")
      const result = await turn("four", true)
      expect(result.tool).toBe("Echo text back (v1).")
      expect(result.result).toContain("v1:four")
    },
    TURN_TIMEOUT,
  )

  test(
    "5. dropping the config entry removes the tool from the next request",
    async () => {
      const file = path.join(server.paths.config, "opencode.jsonc")
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      fs.writeFileSync(file, JSON.stringify({ ...current, plugins: [] }, null, 2))
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && (await pluginState()).length > 0) await Bun.sleep(200)
      expect(await pluginState()).toEqual([])
      const result = await turn("five", false)
      expect(result.tool).toBeUndefined()
    },
    TURN_TIMEOUT,
  )

  test(
    "6. re-adding it as a Code Mode tool keeps the direct tool list as it was",
    async () => {
      fs.writeFileSync(entry, pluginSource("v4", marker, true))
      const file = path.join(server.paths.config, "opencode.jsonc")
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      fs.writeFileSync(file, JSON.stringify({ ...current, plugins: [{ package: dir, options: {} }] }, null, 2))
      await waitForMarker("v4")
      const result = await turn("six", false)
      expect(result.tool).toBeUndefined()
    },
    TURN_TIMEOUT,
  )

  test(
    "7. changing the Code Mode tool",
    async () => {
      fs.writeFileSync(entry, pluginSource("v5", marker, true))
      await waitForMarker("v5")
      const result = await turn("seven", false)
      expect(result.tool).toBeUndefined()
      const last = JSON.parse(fake.requests[fake.requests.length - 1].body) as Chat & { messages: unknown[] }
      seen.push({ step: `seven: v5 in request ${JSON.stringify(last).includes("Echo text back (v5)")}` })
      console.log(JSON.stringify(seen, null, 2))
    },
    TURN_TIMEOUT,
  )
})
