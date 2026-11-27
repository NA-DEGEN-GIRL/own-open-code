// The image tools on a real server (decisions US5, IM): a connected provider with an image model makes upstream list
// `generate_image` (`experimental_image_generate` before v2.4.0) in every conversation, and one with a video model
// `generate_video` (v2.4.0). With own-accounts loaded neither core tool is ever in the request's tools; own's `image_generate` is, from the request after `policy.set{imageGenerate: true}`
// (설정 > 이미지 만들기), and leaves again with `false`. The unit test is image/tool.test.ts, the
// chain image/flow.e2e.test.ts. Every credential is fake; the servers bind 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Policy } from "@own/protocol"
import {
  openAIResponsesProvider,
  opencodeConfig,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../e2e-kit"

setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const ACCOUNTS = path.join(import.meta.dir, "../..")
const MODEL = { providerID: "fake-a", id: "gpt-5.5" }

const fixture: { fake?: FakeOpenAIResponses; server?: OpencodeServer } = {}

beforeAll(async () => {
  const fake = startFakeOpenAIResponses({ models: ["gpt-5.5", "gpt-image-2", "sora-fake"] })
  fixture.fake = fake
  fixture.server = await startOpencodeServer({
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) =>
      opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-image-tool",
            models: {
              "gpt-5.5": { name: "gpt-5.5" },
              "gpt-image-2": { name: "GPT Image 2", type: "image" },
              "sora-fake": { name: "Fake video", type: "video" },
            },
          }),
        },
        model: `${MODEL.providerID}/${MODEL.id}`,
        // The kit turns core's tools off like own's fold; on here, so the fold is what keeps them out.
        extra: { experimental: { image_generate: true, video_generate: true } },
        plugins: [
          {
            package: ACCOUNTS,
            options: { home: paths.ownHome, buildId: `e2e-image-tool-${process.pid}`, vault: "memory" },
          },
        ],
      }),
  })
  // The model list holds chat models only; the image model reaches core's catalog with the provider.
  await fixture.server.waitForModels([MODEL])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.server?.stop()
  await fixture.fake?.stop()
}, 60_000)

describe("own's image tool follows policy.imageGenerate (US5, IM)", () => {
  test(
    "off by default, own's listed once turned on and core's never, gone again once turned off",
    async () => {
      expect(await listed("default")).toEqual({ core: false, video: false, own: false })
      await setting(true)
      expect(await listed("on")).toEqual({ core: false, video: false, own: true })
      await setting(false)
      expect(await listed("off")).toEqual({ core: false, video: false, own: false })
    },
    TURN_TIMEOUT * 3,
  )
})

async function setting(imageGenerate: boolean) {
  const output = await rpc("policy.set", { patch: { imageGenerate } })
  const policy = isRecord(output.policy) ? output.policy : {}
  expect(policy.imageGenerate).toBe(imageGenerate)
}

/** Whether a new session's first request lists the image tool. */
async function listed(label: string) {
  const server = required(fixture.server)
  const fake = required(fixture.fake)
  const text = `Image tool ${label}.`
  const created = (await server.call("POST", "/api/session", {
    body: { title: `image tool ${label}`, model: MODEL, location: { directory: server.paths.workspace } },
  })) as { data: { id: string } }
  fake.enqueue({ type: "text", text: "ok" })
  const before = fake.requests.length
  await server.prompt(created.data.id, text)
  await server.waitIdle(created.data.id)
  const sent = fake.requests
    .slice(before)
    .map((request) => request.json)
    .find((body) => isRecord(body) && Array.isArray(body.tools) && JSON.stringify(body.input).includes(text))
  if (!isRecord(sent) || !Array.isArray(sent.tools)) throw new Error(`no request carried ${text}`)
  const names = sent.tools.map((tool) => (isRecord(tool) ? tool.name : undefined))
  return {
    core: names.includes(Policy.IMAGE_GENERATE_TOOL),
    video: names.includes(Policy.VIDEO_GENERATE_TOOL),
    own: names.includes("image_generate"),
  }
}

async function rpc(method: string, input: unknown) {
  const server = required(fixture.server)
  const response = await server.request("POST", `/api/rpc/own.accounts/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const body: unknown = await response.json()
  if (response.status !== 200 || !isRecord(body) || !isRecord(body.output))
    throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body.output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
