// An omo session on upstream's Claude Agent provider (2026-10-31 decisions, own/reports/claude-agent-provider-2026-10-31.md
// §4.2): the provider reads its system prompt only from its options, which its own hooks filled from core's system
// before own-omo's transform ran. own-omo writes the final system (Sisyphus, omo's system transform and the overlay's
// text, with core's parts they kept) there as the agent role, with no separate instructions. Other providers' requests
// get no such options. omo's runtime is stood in for: Sisyphus's prompt and a system transform that appends a line.
import { describe, expect, test } from "bun:test"
import { SystemPart } from "@opencode/ai/effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect } from "effect"
import { Bridge } from "../../src/host/hooks.js"
import type { Overlays } from "../../src/host/overlay.js"
import type { OmoSessions } from "../../src/host/session.js"
import type { Runtime } from "../../src/runtime.js"

const ROLE = OwnHarness.CLAUDE_AGENT_ROLE
const INSTRUCTIONS = OwnHarness.CLAUDE_AGENT_INSTRUCTIONS

function deps(omo: boolean) {
  const started = {
    sisyphus: "SISYPHUS-PROMPT",
    hooks: {
      "experimental.chat.system.transform": async (_: unknown, output: { system: string[] }) => {
        output.system.push("OMO-SYSTEM-LINE")
      },
    },
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
    overlays: { get: () => Effect.succeed({ tools: {}, system: "OVERLAY-SKILL" }) } as unknown as Overlays.Store,
  }
}

function event(providerID: string) {
  // SAFETY: the request shape core hands the hooks, with only the fields the transform reads.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    sessionID: "ses_omo_claude",
    agent: "build",
    model: { providerID, id: "opus" },
    system: [
      SystemPart.make("CORE-AGENT-PROMPT"),
      SystemPart.make("CORE-INSTRUCTIONS"),
      SystemPart.make("PLUGIN-PART"),
    ],
    messages: [],
    // The provider's hooks ran first (on claude-agent): core's role and instructions.
    options:
      providerID === OwnHarness.CLAUDE_AGENT ? { [ROLE]: "", [INSTRUCTIONS]: "CORE-INSTRUCTIONS\n\nPLUGIN-PART" } : {},
    tools: {},
  } as unknown as SessionContext
}

describe("own-omo on the Claude Agent provider", () => {
  test("Sisyphus, omo's system transform and the overlay reach Claude as the agent role, nothing twice", async () => {
    const request = event(OwnHarness.CLAUDE_AGENT)
    await Bridge.transform(deps(true), request)
    const system = request.system.map((part) => part.text)
    expect(system).toEqual(["SISYPHUS-PROMPT", "CORE-INSTRUCTIONS", "PLUGIN-PART", "OMO-SYSTEM-LINE", "OVERLAY-SKILL"])
    expect(request.options[ROLE]).toBe(system.join("\n\n"))
    expect(request.options[INSTRUCTIONS]).toBe("")
  })

  test("other providers get no options, and a session that is not omo keeps the provider's", async () => {
    const other = event("anthropic")
    await Bridge.transform(deps(true), other)
    expect(other.options).toEqual({})
    expect(other.system.map((part) => part.text)).toContain("SISYPHUS-PROMPT")
    const plain = event(OwnHarness.CLAUDE_AGENT)
    await Bridge.transform(deps(false), plain)
    expect(plain.options).toEqual({ [ROLE]: "", [INSTRUCTIONS]: "CORE-INSTRUCTIONS\n\nPLUGIN-PART" })
    expect(plain.system.map((part) => part.text)[0]).toBe("CORE-AGENT-PROMPT")
  })
})
