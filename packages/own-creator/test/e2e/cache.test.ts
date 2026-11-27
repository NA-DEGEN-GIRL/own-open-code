// Prompt-cache goldens for extensions (own/docs/17 §5.6): in one running session, a prompt fragment and a Code Mode
// tool added between turns leave the request's tools and its cached prefix as they were (the change is appended after
// the conversation), while a direct tool changes the tool list and loses the cache, as the approval card warns. The
// store is written from outside the service here, so the folder watch is what applies the change.
// Run from a path without '#': `bun run test:e2e` in packages/own-creator.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Hash } from "@own/runtime"
import { waitUntil } from "../../../own-accounts/test/e2e-kit"
import { CreatorStore } from "../../src/store.js"
import { boot, BOOT_TIMEOUT, body, rpc, session, turn, type Rig } from "./kit.js"

setDefaultTimeout(180_000)

let rig: Rig
let sessionID: string
let store: CreatorStore.Store

const FRAGMENT = "CACHE-FRAGMENT: prefer small diffs."

function manifest(items: unknown[]) {
  return { format: "own.ext/1", id: "cache-probe", title: "Cache probe", items }
}

const fragment = { type: "prompt.fragment", id: "diffs", text: FRAGMENT }
const tool = (direct: boolean) => ({
  type: "tool.command",
  name: "probe",
  description: "Prints probe.",
  command: "echo probe",
  ...(direct ? { direct: true } : {}),
})

async function step(text: string) {
  const run = await turn(rig, sessionID, text, [{ type: "text", text: `answer to ${text}` }])
  const request = run.requests[0]!
  return {
    request,
    tools: Hash.stable(body(request).tools ?? []),
    cached: request.cache?.cachedTokens ?? 0,
    prompt: request.cache?.promptTokens ?? 0,
  }
}

async function applied(active: number) {
  await waitUntil(async () => {
    const list = (await rpc(rig.server, "list", {})) as {
      extensions?: Array<{ id: string; active: number; status: string }>
    }
    const found = list.extensions?.find((item) => item.id === "cache-probe")
    return found?.active === active && found.status === "active"
  }, `version ${active} applied`)
  // The service's reload follows its folder watch; give it the debounce.
  await Bun.sleep(600)
}

beforeAll(async () => {
  rig = await boot()
  store = new CreatorStore.Store(rig.home)
  sessionID = await session(rig.server)
}, BOOT_TIMEOUT)

afterAll(async () => {
  await rig?.server.stop()
  await rig?.fake.stop()
}, 60_000)

describe("extensions and the prompt cache of an open session", () => {
  test("a fragment, then a Code Mode tool, keep the prefix; a direct tool does not", async () => {
    await step("first")
    const base = await step("second")
    expect(base.cached).toBeGreaterThan(0)

    const created = await store.create(manifest([fragment]), "user")
    expect(created.ok).toBe(true)
    await applied(1)
    const withFragment = await step("third")
    expect(withFragment.tools).toBe(base.tools)
    expect(withFragment.request.body).toContain(FRAGMENT)
    // Everything the previous request sent is still a cached prefix (16-token blocks).
    expect(withFragment.cached).toBeGreaterThanOrEqual(base.prompt - 16)
    const messages = body(withFragment.request).messages
    expect(JSON.stringify(messages.slice(0, -2))).not.toContain(FRAGMENT)

    const codeMode = await store.update(manifest([fragment, tool(false)]), "user")
    expect(codeMode.ok).toBe(true)
    await applied(2)
    const withTool = await step("fourth")
    expect(withTool.tools).toBe(base.tools)
    expect(withTool.request.body).toContain("ext_probe")
    expect(withTool.cached).toBeGreaterThanOrEqual(withFragment.prompt - 16)

    const direct = await store.update(manifest([fragment, tool(true)]), "user")
    expect(direct.ok).toBe(true)
    await applied(3)
    const withDirect = await step("fifth")
    expect(withDirect.tools).not.toBe(base.tools)
    expect((body(withDirect.request).tools ?? []).map((item) => item.function.name)).toContain("ext_probe")
    expect(withDirect.cached).toBeLessThan(withTool.prompt / 2)

    // Back to the Code Mode version: the tool list is the earlier one again.
    const rolled = await store.rollback("cache-probe", 2, "user")
    expect(rolled.ok).toBe(true)
    await applied(2)
    const back = await step("sixth")
    expect(back.tools).toBe(base.tools)
  })
})
