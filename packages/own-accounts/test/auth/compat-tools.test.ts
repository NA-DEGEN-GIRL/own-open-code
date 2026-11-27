// 02 §3.3, the request shaping of compat slots (local models):
// - a model registered without tools (its server said so, or the user's `도구: 끔`) chats without them. Core sends
//   every tool whatever `capabilities.tools` says, and a server such as Ollama refuses a request with tools for a
//   model without the capability, so own-accounts leaves the tool definitions out of that model's requests;
// - on an Ollama server, an image type its OpenAI-compatible API does not decode (a GIF) becomes core's note for an
//   unreadable image, or the stored image would fail every later request; png, jpeg and webp pass.
// Every credential is fake; nothing reaches a network.

import { describe, expect, test } from "bun:test"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Templates } from "../../src/slots/templates.js"
import { registryWith } from "../slots/support.js"
import { authSetup, context, message, registeredHooks } from "./support.js"

const SESSION = "ses_compat_tools_test"
const TOOLS: SessionContext["tools"] = {
  read: { description: "Read a file.", input: { type: "object" } },
  bash: { description: "Run a command.", input: { type: "object" } },
}

function ref(providerID: string, id: string) {
  return Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })
}

async function setup() {
  const base = await registryWith([
    { kind: "compat", label: "L", slug: "llll", baseURL: "http://127.0.0.1:1/v1" },
    { kind: "compat", label: "V", slug: "vvvv", baseURL: "http://127.0.0.1:2/v1" },
    { kind: "ds", label: "D", slug: "dddd" },
  ])
  const built = Templates.fromCompat(
    [
      { id: "chat-only", contextLimit: 32_768, tools: "off" },
      { id: "agent", contextLimit: 32_768, image: "on" },
    ],
    "2026-10-18T00:00:00Z",
  )
  if (!built.ok) throw new Error(built.reason)
  // `llll` is an Ollama server, `vvvv` a vLLM one.
  const family = { acc_llll: "ollama", acc_vvvv: "vllm" } as const
  return authSetup({
    registry: {
      ...base,
      accounts: base.accounts.map((account) =>
        account.id in family
          ? {
              ...account,
              compat: { server: { family: family[account.id as keyof typeof family], overflowClassified: false } },
            }
          : account,
      ),
      modelTemplates: { ...base.modelTemplates, tpl_compat_test: built.template },
    },
  })
}

describe("compat models without tools (02 §3.3)", () => {
  test("their context, compaction and generate requests carry no tool definitions; other models keep theirs", async () => {
    await using s = await setup()
    const hooks = await registeredHooks(s)
    const shaped = async (name: string, model: Model.Ref) => {
      const event: SessionContext = { ...context(SESSION, model), tools: { ...TOOLS } }
      await hooks.get(name)?.(event)
      return event.tools
    }
    for (const name of ["context", "compaction", "generate"]) {
      expect(await shaped(name, ref("own-compat-llll", "chat-only"))).toEqual({})
      expect(await shaped(name, ref("own-compat-llll", "agent"))).toEqual(TOOLS)
      expect(await shaped(name, ref("own-ds-dddd", "deepseek-v4-pro"))).toEqual(TOOLS)
      // Not an own slot: untouched.
      expect(await shaped(name, ref("ollama", "chat-only"))).toEqual(TOOLS)
    }
  })
})

describe("images an Ollama server cannot decode (02 §3.3)", () => {
  const PNG = {
    type: "media",
    media: { kind: "image", mediaType: "image/png", source: { type: "base64", data: "iVBO" } },
  }
  const GIF = {
    type: "media",
    filename: "spinner.gif",
    media: { kind: "image", mediaType: "image/gif", source: { type: "base64", data: "R0lG" } },
  }
  const history = () => [
    message({ id: "msg_u1", role: "user", content: [{ type: "text", text: "look" }, PNG, GIF] }),
    message({
      id: "msg_t1",
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "two images" },
              { type: "file", mime: "image/gif", name: "anim.gif", uri: "data:image/gif;base64,R0lG" },
              { type: "file", mime: "image/webp", name: "still.webp", uri: "data:image/webp;base64,UklG" },
            ],
          },
        },
      ],
    }),
  ]
  const NOTE = (name: string) =>
    `ERROR: Cannot read "${name}" (this model does not support image/gif input). Inform the user.`

  test("a GIF becomes core's note on an Ollama compat slot; png and webp pass; other servers are untouched", async () => {
    await using s = await setup()
    const hooks = await registeredHooks(s)
    const shaped = async (model: Model.Ref) => {
      const event: SessionContext = { ...context(SESSION, model, { messages: history() }) }
      await hooks.get("context")?.(event)
      return event.messages
    }
    const ollama = await shaped(ref("own-compat-llll", "agent"))
    expect(ollama[0]?.content as unknown).toEqual([
      { type: "text", text: "look" },
      PNG,
      { type: "text", text: NOTE("spinner.gif") },
    ])
    expect(ollama[1]?.content).toMatchObject([
      {
        type: "tool-result",
        result: {
          value: [
            { type: "text", text: "two images" },
            { type: "text", text: NOTE("anim.gif") },
            { type: "file", mime: "image/webp" },
          ],
        },
      },
    ])
    // The same history gives the same bytes on every request.
    expect(JSON.stringify(await shaped(ref("own-compat-llll", "agent")))).toBe(JSON.stringify(ollama))
    for (const model of [ref("own-compat-vvvv", "agent"), ref("own-ds-dddd", "deepseek-v4-pro")])
      expect(JSON.stringify(await shaped(model))).toBe(JSON.stringify(history()))
  })
})
