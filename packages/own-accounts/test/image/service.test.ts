// The image tool's chain (02 §9.6, decisions IM) against fake OpenAI Images and Codex backends on 127.0.0.1: keys in
// the user's order, a key with no money marked used up and skipped, a plain 429 asked again, a refused prompt ending
// the chain, and the Codex subscription fallback from the most remaining limit. The registry, the logins and the
// ledger are small stand-ins; the real-server path is image/flow.e2e.test.ts. Every key and token is fake.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { OwnImage, type Account, type Limit } from "@own/protocol"
import { ImageService } from "../../src/image/service.js"
import type { Modules } from "../../src/modules.js"
import { PolicyRules } from "../../src/switching/policy.js"
import { testDeps } from "../support/deps.js"

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082",
  "hex",
)

type Script = (request: { key: string; path: string; body: unknown; count: number }) => Response

const server: { url: string; seen: Array<{ key: string; path: string; body: unknown }>; script: Script; stop?: () => void } = {
  url: "",
  seen: [],
  script: () => Response.json({}, { status: 500 }),
}

beforeAll(() => {
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      const type = request.headers.get("content-type") ?? ""
      const body = type.includes("json") ? await request.json() : Object.fromEntries((await request.formData()).entries())
      server.seen.push({ key, path: url.pathname, body })
      return server.script({ key, path: url.pathname, body, count: server.seen.filter((item) => item.key === key).length })
    },
  })
  server.url = fake.url.origin
  server.stop = () => void fake.stop(true)
})

afterAll(() => server.stop?.())

const ok = (usage?: unknown) =>
  Response.json({ created: 1, data: [{ b64_json: PNG.toString("base64") }], output_format: "png", ...(usage ? { usage } : {}) })
const quota = () =>
  Response.json(
    { error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } },
    { status: 429 },
  )
const rate = () =>
  Response.json({ error: { message: "Rate limit reached.", type: "requests", code: "rate_limit_exceeded" } }, { status: 429 })

function account(id: string, kind: "oai" | "codex", label: string, status: Account.Info["status"] = "ready") {
  return { id, kind, label, providerID: `own-${kind}-${id.slice(-4).toLowerCase()}`, status } as unknown as Account.Info
}

const KEY1 = account("acc_KEY1", "oai", "OpenAI 1")
const KEY2 = account("acc_KEY2", "oai", "OpenAI 2")
const SUB1 = account("acc_SUB1", "codex", "ChatGPT 01")
const SUB3 = account("acc_SUB3", "codex", "ChatGPT 03")
const SECRETS: Record<string, string> = {
  acc_KEY1: "sk-fake-key-one",
  acc_KEY2: "sk-fake-key-two",
  acc_SUB1: "fake-token-01",
  acc_SUB3: "fake-token-03",
}

async function rig(accounts: Account.Info[], setting: OwnImage.Setting = {}) {
  const t = await testDeps({
    ctx: storage(),
    options: { endpoints: { openai: `${server.url}/v1`, codex: `${server.url}/backend-api/codex` } },
  })
  await t.deps.runtime.policy.update((stored) => PolicyRules.apply(stored, { image: setting }))
  const recorded: unknown[] = []
  const unauthorized: string[] = []
  const modules = {
    slots: { snapshot: () => ({ accounts }) },
    logins: {
      headers: async (item: Account.Info) => ({
        ok: true,
        headers: { authorization: `Bearer ${SECRETS[item.id]}` },
        hash: "h",
        expiresAt: null,
        source: "vault",
      }),
      unauthorized: (item: Account.Info) => void unauthorized.push(item.id),
    },
    telemetry: { recordImage: async (input: unknown) => void recorded.push(input) },
  } as unknown as Modules.All
  const waits: number[] = []
  const service = ImageService.create(t.deps, modules, { wait: async (ms) => void waits.push(ms) })
  return { t, service, recorded, waits, [Symbol.asyncDispose]: () => t[Symbol.asyncDispose]() }
}

function storage() {
  const values = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => void values.set(key, value),
    },
  }
}

const request = (extra: Partial<ImageService.Request> = {}): ImageService.Request => ({
  sessionID: "ses_test",
  prompt: "a red cube",
  images: [],
  signal: new AbortController().signal,
  ...extra,
})

describe("image chain (02 §9.6)", () => {
  test("key 1 out of quota is marked and skipped, key 2 answers with the family's default and is priced", async () => {
    server.seen = []
    server.script = (input) =>
      input.key === SECRETS.acc_KEY1
        ? quota()
        : ok({ input_tokens: 20, output_tokens: 1000, input_tokens_details: { text_tokens: 20, image_tokens: 0 } })
    await using r = await rig([KEY1, KEY2])
    const outcome = await r.service.generate(request())
    expect(outcome.type).toBe("done")
    if (outcome.type !== "done") return
    expect(outcome.account.id).toBe(KEY2.id)
    expect(outcome.model).toBe(OwnImage.FLARE)
    expect(outcome.costUSD).toBeCloseTo((20 * 5 + 1000 * 30) / 1_000_000, 8)
    expect(outcome.steps.map((step) => [step.label, step.outcome])).toEqual([
      ["OpenAI 1", "failed"],
      ["OpenAI 2", "used"],
    ])
    expect(outcome.steps[0]?.why).toContain("insufficient_quota")
    expect(server.seen.map((item) => [item.key, item.path, (item.body as { model?: string }).model])).toEqual([
      [SECRETS.acc_KEY1, "/v1/images/generations", OwnImage.FLARE],
      [SECRETS.acc_KEY2, "/v1/images/generations", OwnImage.FLARE],
    ])
    // The mark keeps key 1 out of the next call, and the view shows it with OpenAI's code.
    server.seen = []
    const again = await r.service.generate(request({ model: OwnImage.SUNBURST }))
    expect(again.type).toBe("done")
    expect(server.seen.map((item) => item.key)).toEqual([SECRETS.acc_KEY2])
    expect((server.seen[0]?.body as { model?: string }).model).toBe(OwnImage.SUNBURST)
    const view = await r.service.view()
    expect(view.keys.map((key) => [key.label, key.exhausted?.code])).toEqual([
      ["OpenAI 1", "insufficient_quota"],
      ["OpenAI 2", undefined],
    ])
    // Cleared (the user topped it up), key 1 is asked first again.
    await r.service.clear(KEY1.id)
    expect((await r.service.view()).keys[0]?.exhausted).toBeUndefined()
  })

  test("the user's key order and switches decide the chain", async () => {
    server.seen = []
    server.script = () => ok()
    await using r = await rig([KEY1, KEY2], { keyOrder: [KEY2.id as never], keyOff: [] })
    const outcome = await r.service.generate(request())
    expect(outcome.type === "done" && outcome.account.id).toBe(KEY2.id)
    await using off = await rig([KEY1, KEY2], { keyOff: [KEY1.id as never] })
    server.seen = []
    const second = await off.service.generate(request())
    expect(second.type === "done" && second.account.id).toBe(KEY2.id)
    expect(second.steps[0]).toMatchObject({ label: "OpenAI 1", outcome: "skipped" })
  })

  test("a plain 429 is asked again on the same key after a wait, not skipped", async () => {
    server.seen = []
    server.script = (input) => (input.count === 1 ? rate() : ok())
    await using r = await rig([KEY1, KEY2])
    const outcome = await r.service.generate(request())
    expect(outcome.type === "done" && outcome.account.id).toBe(KEY1.id)
    expect(server.seen.map((item) => item.key)).toEqual([SECRETS.acc_KEY1, SECRETS.acc_KEY1])
    expect(r.waits).toEqual([ImageService.RETRIES[0]!])
    expect((await r.service.view()).keys.every((key) => key.exhausted === undefined)).toBe(true)
  })

  test("a refused prompt ends the chain: no other key is asked", async () => {
    server.seen = []
    server.script = () =>
      Response.json({ error: { message: "rejected", type: "invalid_request_error", code: "moderation_blocked" } }, { status: 400 })
    await using r = await rig([KEY1, KEY2])
    const outcome = await r.service.generate(request())
    expect(outcome).toMatchObject({ type: "refused", code: "moderation_blocked", status: 400 })
    expect(server.seen).toHaveLength(1)
  })

  test("every key used up: the subscription with the most remaining limit makes it with the backend's model", async () => {
    server.seen = []
    server.script = (input) => (input.path.startsWith("/v1/") ? quota() : ok())
    await using r = await rig([KEY1, KEY2, SUB1, SUB3])
    const now = r.t.deps.clock.now()
    r.t.deps.runtime.limits.upsert([window(SUB1.id, 80, now), window(SUB3.id, 10, now)])
    const outcome = await r.service.generate(request({ model: OwnImage.SUNBURST }))
    expect(outcome.type).toBe("done")
    if (outcome.type !== "done") return
    expect(outcome).toMatchObject({ route: "codex", model: OwnImage.GPT_IMAGE_2 })
    expect(outcome.account.id).toBe(SUB3.id)
    expect(outcome.costUSD).toBeUndefined()
    expect(server.seen.map((item) => [item.key, item.path])).toEqual([
      [SECRETS.acc_KEY1, "/v1/images/generations"],
      [SECRETS.acc_KEY2, "/v1/images/generations"],
      [SECRETS.acc_SUB3, "/backend-api/codex/images/generations"],
    ])
    expect(server.seen[2]?.body).toMatchObject({ model: OwnImage.GPT_IMAGE_2, prompt: "a red cube" })
    expect((await r.service.view()).codex.map((item) => item.label)).toEqual(["ChatGPT 03", "ChatGPT 01"])
  })

  test("the Codex fallback turned off, or no account at all: unavailable, with each source's reason", async () => {
    server.seen = []
    server.script = () => quota()
    await using off = await rig([KEY1, SUB1], { codexFallback: false })
    const first = await off.service.generate(request())
    expect(first.type).toBe("unavailable")
    expect(first.steps.map((step) => [step.label, step.outcome])).toEqual([
      ["OpenAI 1", "failed"],
      ["Codex 구독", "skipped"],
    ])
    expect(server.seen.map((item) => item.path)).toEqual(["/v1/images/generations"])
    await using none = await rig([])
    const outcome = await none.service.generate(request())
    expect(outcome.type).toBe("unavailable")
    expect(outcome.steps.map((step) => step.why)).toEqual(["OpenAI API 키 계정이 없어요", "ChatGPT 구독 계정이 없어요"])
    expect(await none.service.available()).toBe(false)
  })

  test("API 키 쓰기 off: no key is asked, the subscription makes it directly (IM-12)", async () => {
    server.seen = []
    server.script = () => ok()
    await using r = await rig([KEY1, KEY2, SUB1], { useKeys: false })
    expect(await r.service.available()).toBe(true)
    const outcome = await r.service.generate(request())
    expect(outcome).toMatchObject({ type: "done", route: "codex", model: OwnImage.GPT_IMAGE_2 })
    expect(outcome.steps.map((step) => [step.label, step.outcome])).toEqual([["ChatGPT 01", "used"]])
    expect(server.seen.map((item) => [item.key, item.path])).toEqual([
      [SECRETS.acc_SUB1, "/backend-api/codex/images/generations"],
    ])
    expect((await r.service.view()).setting.useKeys).toBe(false)
  })

  test("only key 2 switched on: key 1 is never asked, whatever its order", async () => {
    server.seen = []
    server.script = () => ok()
    await using r = await rig([KEY1, KEY2, SUB1], { keyOff: [KEY1.id as never] })
    const outcome = await r.service.generate(request())
    expect(outcome.type === "done" && outcome.account.id).toBe(KEY2.id)
    expect(server.seen.map((item) => item.key)).toEqual([SECRETS.acc_KEY2])
  })

  test("everything off or used up: unavailable before any request (IM-13)", async () => {
    server.seen = []
    server.script = () => ok()
    // Key 1 switched off, key 2 marked used up, ChatGPT 01 switched off, ChatGPT 03 at its limit.
    await using r = await rig([KEY1, KEY2, SUB1, SUB3], { keyOff: [KEY1.id as never], codexOff: [SUB1.id as never] })
    server.script = () => quota()
    await r.service.generate(request())
    expect(server.seen.map((item) => item.key)).toEqual([SECRETS.acc_KEY2, SECRETS.acc_SUB3])
    const now = r.t.deps.clock.now()
    r.t.deps.runtime.limits.upsert([{ ...window(SUB3.id, 100, now), status: "exhausted" } as Limit.Window])
    server.seen = []
    expect(await r.service.available()).toBe(false)
    const outcome = await r.service.generate(request())
    expect(server.seen).toEqual([])
    expect(outcome.type).toBe("unavailable")
    expect(outcome.steps.map((step) => [step.label, step.outcome])).toEqual([
      ["OpenAI 1", "skipped"],
      ["OpenAI 2", "skipped"],
      // Subscriptions from the most remaining limit: 03 has a known window, 01 none.
      ["ChatGPT 03", "skipped"],
      ["ChatGPT 01", "skipped"],
    ])
    expect(outcome.steps[1]?.why).toContain("바닥났어요")
    expect(outcome.steps[2]?.why).toBe("사용 한도에 닿아 있어요")
  })

  test("an edit sends the images as multipart to the API and as data URLs to the backend", async () => {
    server.seen = []
    server.script = (input) => (input.key === SECRETS.acc_KEY1 ? quota() : ok())
    await using r = await rig([KEY1, SUB1])
    const images = [{ bytes: new Uint8Array(PNG), mime: "image/png", name: "in.png" }]
    const outcome = await r.service.generate(request({ images, model: OwnImage.SUNBURST, complexity: "low" }))
    expect(outcome.type === "done" && outcome.route).toBe("codex")
    expect(server.seen[0]?.path).toBe("/v1/images/edits")
    // GPT Image 2.6's complexity goes to the API as a form field (IM-17), never to the Codex backend.
    expect(server.seen[0]?.body).toMatchObject({ model: "gpt-image-2.6-sunburst", prompt: "a red cube", complexity: "low" })
    expect(server.seen[1]?.path).toBe("/backend-api/codex/images/edits")
    const sent = server.seen[1]?.body as { images?: Array<{ image_url: string }>; complexity?: string }
    expect(sent.images?.[0]?.image_url.startsWith("data:image/png;base64,")).toBe(true)
    expect(sent.complexity).toBeUndefined()
  })

  test("GPT Image 2.6 (IM-15, IM-16): auto sends 2.6 Flare; a stored gpt-image-1.5 sends gpt-image-2 and is rewritten", async () => {
    server.seen = []
    server.script = () => ok({ input_tokens: 20, output_tokens: 1000, input_tokens_details: { text_tokens: 20, image_tokens: 0 } })
    await using r = await rig([KEY2])
    const auto = await r.service.generate(request({ complexity: "high" }))
    expect(auto.type === "done" && auto.model).toBe("gpt-image-2.6-flare")
    expect(server.seen[0]?.body).toMatchObject({ model: "gpt-image-2.6-flare", complexity: "high" })

    // policy.json from a build that offered gpt-image-1.5: it still reads, as gpt-image-2.
    const file = r.t.deps.runtime.policy.file
    const stored = await Bun.file(file).json()
    await Bun.write(file, JSON.stringify({ ...stored, image: { family: "gpt-image-1.5", quality: "low" } }))
    await r.t.deps.runtime.policy.read()
    expect(r.service.setting().family).toBe("gpt-image-2")
    server.seen = []
    const fixed = await r.service.generate(request())
    expect(fixed.type === "done" && fixed.model).toBe("gpt-image-2")
    expect(server.seen[0]?.body).toMatchObject({ model: "gpt-image-2", quality: "low" })
    // The next change to policy.json writes the migrated value.
    await r.t.deps.runtime.policy.update((current) => PolicyRules.apply(current, { horizonRequests: 4 }))
    expect((await Bun.file(file).json()).image).toEqual({ family: "gpt-image-2", quality: "low" })
  })
})

function window(accountID: string, usedPercent: number, now: number): Limit.Window {
  return {
    id: "codex.primary",
    accountID,
    providerID: "own-codex-x",
    scope: "account",
    kind: "rolling_quota",
    label: "5시간",
    usedPercent,
    windowMinutes: 300,
    resetAt: now + 3_600_000,
    status: "ok",
    confidence: "exact",
    observedAt: now,
    source: "header",
  } as unknown as Limit.Window
}
