// The dsh harness's supporting pieces: the request-series reasons (src/dsh/series.ts), the balance-before-rate-limit
// reading (errors.ts), the tool gate and the history translation of the shell tool (gate.ts, registry.ts).
import { describe, expect, test } from "bun:test"
import { Message, SystemPart, ToolCallPart } from "@opencode/ai/effect"
import { Gate } from "../../../src/gate.js"
import { History } from "../../../src/history.js"
import { Registry } from "../../../src/registry.js"
import { DshErrors } from "../../../src/dsh/errors.js"
import { DshSeries } from "../../../src/dsh/series.js"
import { DshShell } from "../../../src/dsh/shell.js"

const request = (messages: Array<string>, overrides: Partial<DshSeries.Request> = {}): DshSeries.Request => ({
  model: "deepseek/deepseek-v4-pro",
  options: { maxTokens: 256_000 },
  tools: { read: { description: "r", input: {} } },
  system: [SystemPart.make("prompt")],
  messages: messages.map((text) => Message.make({ role: "user", content: text })),
  ...overrides,
})

describe("DshSeries", () => {
  test("initial, resume, an extension that continues, a change of header and a rewritten series", () => {
    const memory = new DshSeries.Memory()
    expect(memory.record("s", DshSeries.print(request(["a"])), false)).toEqual({ reason: "initial", kept: 0 })
    expect(memory.record("s", DshSeries.print(request(["a", "b"])), true)).toEqual({ reason: undefined, kept: 1 })
    expect(memory.record("r", DshSeries.print(request(["a"])), true)).toMatchObject({ reason: "resume" })
    expect(
      memory.record(
        "s",
        DshSeries.print(request(["a", "b", "c"], { tools: { write: { description: "w", input: {} } } })),
        true,
      ),
    ).toEqual({ reason: "change", startsSeries: false, changed: ["tools"], kept: 2 })
    // A compaction rewrote what came before: a new series, with how many messages still lead.
    expect(
      memory.record(
        "s",
        DshSeries.print(request(["checkpoint", "c"], { tools: { write: { description: "w", input: {} } } })),
        true,
      ),
    ).toEqual({ reason: "series", startsSeries: true, changed: [], kept: 0 })
    expect(
      memory.record(
        "s",
        DshSeries.print(
          request(["checkpoint", "c"], {
            system: [SystemPart.make("other")],
            tools: { write: { description: "w", input: {} } },
          }),
        ),
        true,
      ),
    ).toMatchObject({ reason: "series", changed: ["system"] })
  })
})

describe("DshErrors", () => {
  test("an exhausted balance or quota is read before a rate limit, whatever the status", () => {
    expect(DshErrors.exhausted({ type: "provider.rate-limit", message: "Insufficient Balance", status: 429 })).toBe(
      true,
    )
    expect(DshErrors.exhausted({ type: "provider.error", message: "x", status: 402 })).toBe(true)
    expect(
      DshErrors.exhausted({
        type: "provider.error",
        message: "bad",
        response: { body: '{"error":{"code":"insufficient_quota"}}' },
      }),
    ).toBe(true)
    expect(DshErrors.exhausted({ type: "provider.error", message: "You exceeded your current quota" })).toBe(true)
    expect(
      DshErrors.exhausted({ type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 }),
    ).toBe(false)
    expect(DshErrors.isQuotaExceeded("out of credits")).toBe(true)
  })
})

describe("gate and history", () => {
  test("a dsh session lists dsh's tools only; switching away drops the rule", () => {
    const other = { action: "edit", resource: "*", effect: "ask" as const }
    expect(Gate.rules([other, Gate.PI_ALLOW], "dsh")).toEqual([other, Gate.DSH_ALLOW])
    expect(Gate.rules([Gate.DSH_ALLOW, other], "codex")).toEqual([other, Gate.ALLOW])
    expect(Gate.ACTIONS.dsh).toBe(Gate.DSH_ACTION)
  })

  test("past shell calls translate into dsh's shell tool and back", () => {
    const history = [
      Message.make({
        role: "assistant",
        content: [ToolCallPart.make({ id: "c1", name: "exec_command", input: { cmd: "ls", workdir: "w" } })],
      }),
    ]
    const dsh = History.translate(history, Registry.dsh)
    expect(dsh[0]!.content[0]).toMatchObject({ name: DshShell.kind(), input: { command: "ls", workdir: "w" } })
    const back = History.translate(dsh, Registry.codex)
    expect(back[0]!.content[0]).toMatchObject({ name: "exec_command", input: { cmd: "ls", workdir: "w" } })
    expect(Registry.get("dsh")).toBe(Registry.dsh)
    expect(Registry.dsh.tools.patch).toBeUndefined()
  })
})

describe("dsh shell environment", () => {
  test("keeps git's environment config whole and still drops credential-shaped names", () => {
    const env = DshShell.environment(
      "bash",
      {},
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
        GIT_CONFIG_VALUE_0: "!helper",
        OPENAI_API_KEY: "sk-test",
        GITHUB_TOKEN: "t",
        DSH_INTERNAL: "x",
      },
    )
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "!helper",
    })
    expect(Object.keys(env)).not.toContainAnyValues(["OPENAI_API_KEY", "GITHUB_TOKEN", "DSH_INTERNAL"])
  })
})
