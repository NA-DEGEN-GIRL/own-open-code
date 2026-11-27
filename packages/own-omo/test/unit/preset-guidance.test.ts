// own's preset guidance is not omo's (15 §3.4): own-accounts writes the `own.preset` session instruction entry by
// provider group, and its text tells the model to delegate with core's `subagent` tool, which an omo request removes.
// An omo request carries neither the entry in the instruction baseline nor its later changes or removal in history;
// other entries (the team's) and everything else stay byte for byte, and other sessions keep the entry. The entry and
// notice forms are core's (core/src/session/instruction-entry.ts), the key own-accounts'.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Message, SystemPart } from "@opencode/ai/effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Preset } from "@own/protocol/preset"
import { Effect } from "effect"
import { PresetGuidance } from "../../../own-accounts/src/presets/guidance.js"
import { Bridge } from "../../src/host/hooks.js"
import type { Overlays } from "../../src/host/overlay.js"
import type { OmoSessions } from "../../src/host/session.js"
import type { Runtime } from "../../src/runtime.js"

const GUIDANCE = Preset.renderGuidance({ delegation: "active", ultra: false, caps: Preset.CAPS, cards: {} })!.text
const block = (key: string, value: string) => `<context key="${key}">\n${value}\n</context>`
const PRESET = block("own.preset", GUIDANCE)
const TEAM = block("own.team.role", "You own the area cl-perf.")
const ENVIRONMENT =
  "Today's date: Sat Nov 07 2026\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: C:/work/app\n</env>"
const CHANGED = `The context under "own.preset" changed and supersedes the previous value:\n${PRESET}`
const REMOVED = `The context under "own.preset" no longer applies. Disregard it.`

function deps(omo: boolean) {
  const started = {
    hooks: {},
    runtime: { getAgentConfigKey: () => "sisyphus", getAgentToolRestrictions: () => ({}) },
    agents: { toV1: (agent: string) => agent },
    registered: [],
  }
  // SAFETY: the request transform reads `ensure()` of the host, `isOmo` of the session cache and `get` of the overlays.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    host: { ensure: async () => started } as unknown as Runtime.Host,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    sessions: { isOmo: async () => omo } as unknown as OmoSessions.Cache,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    overlays: { get: () => Effect.succeed({ tools: {} }) } as unknown as Overlays.Store,
  }
}

function request(baseline: string, messages: ReadonlyArray<Message>) {
  // SAFETY: the request shape core hands the hooks, with only the fields the transform reads.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    sessionID: "ses_omo_preset",
    agent: "explore",
    model: { providerID: "deepseek", id: "deepseek-v4-pro" },
    system: [SystemPart.make("CORE-AGENT-PROMPT"), SystemPart.make(baseline)],
    messages: [...messages],
    options: {},
    tools: {},
  } as unknown as SessionContext
}

const texts = (event: SessionContext) =>
  event.messages.map((message) => [
    message.role,
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("|"),
  ])

describe("own.preset in omo sessions", () => {
  test("the baseline loses the entry and keeps the team's; history loses its changes and removal", async () => {
    const user = Message.make({ role: "user", content: "hi" })
    const event = request(`${ENVIRONMENT}\n\n${PRESET}\n\n${TEAM}`, [
      user,
      Message.system(CHANGED),
      Message.system(`Today's date: Sun Nov 08 2026\n\n${REMOVED}`),
      Message.system(`${CHANGED}\n\n${block("own.team.role", "You own the area cl-ui.")}`),
    ])
    await Bridge.transform(deps(true), event)
    expect(event.system.map((part) => part.text)).toEqual(["CORE-AGENT-PROMPT", `${ENVIRONMENT}\n\n${TEAM}`])
    expect(texts(event)).toEqual([
      ["user", "hi"],
      ["system", "Today's date: Sun Nov 08 2026"],
      ["system", block("own.team.role", "You own the area cl-ui.")],
    ])
    expect(event.messages[0]).toBe(user)
    // The guidance names the tool omo removes; nothing of it is left.
    expect(GUIDANCE).toContain("subagent tool")
    expect(JSON.stringify([event.system, texts(event)])).not.toContain("own.preset")
  })

  test("an entry that is the whole baseline goes with its part; a request without it is not touched", async () => {
    const alone = request(PRESET, [])
    await Bridge.transform(deps(true), alone)
    expect(alone.system.map((part) => part.text)).toEqual(["CORE-AGENT-PROMPT"])
    const plain = request(`${ENVIRONMENT}\n\n${TEAM}`, [Message.system(TEAM)])
    const [system, messages] = [plain.system, plain.messages]
    await Bridge.transform(deps(true), plain)
    expect(plain.system).toEqual(system)
    expect(plain.messages).toEqual(messages)
  })

  test("other sessions keep the entry", async () => {
    const event = request(`${ENVIRONMENT}\n\n${PRESET}`, [Message.system(CHANGED)])
    await Bridge.transform(deps(false), event)
    expect(event.system[1]!.text).toBe(`${ENVIRONMENT}\n\n${PRESET}`)
    expect(texts(event)).toEqual([["system", CHANGED]])
  })

  test("the key is own-accounts', the forms are core's", async () => {
    expect(Bridge.PRESET_KEY).toBe(PresetGuidance.KEY)
    const core = await Bun.file(path.join(import.meta.dir, "../../../core/src/session/instruction-entry.ts")).text()
    expect(core).toContain('[`<context key="${key}">`, renderValue(value), "</context>"].join("\\n")')
    expect(core).toContain('`The context under "${entry.key}" changed and supersedes the previous value:`,')
    expect(core).toContain('`The context under "${entry.key}" no longer applies. Disregard it.`')
  })
})
