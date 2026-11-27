// OWN-PATCH(P-028) begin
import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { ToolInputRepairPlugin } from "@opencode/core/plugin/tool-input-repair"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const identity = {
  sessionID: Session.ID.make("ses_repair_alias"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_repair_alias"),
}

// A request may list a registered tool under another tool's name (own's harnesses list `pi_edit` as `edit`). The
// repair must fit the input to the tool that runs, not to the closed schema of the tool that owns the name.
it.effect("an aliased call is repaired against the tool it runs", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const registry = yield* Tool.Service
    const executed: unknown[] = []
    yield* plugins.activate([{ ...ToolInputRepairPlugin.Plugin, revision: "1" }])
    yield* registry.transform((draft) => {
      draft.add({
        name: "edit",
        options: { codemode: false },
        description: "Core-shaped edit",
        input: Schema.Struct({ filePath: Schema.String }),
        execute: () => Effect.succeed({ content: "core edit" }),
      })
      draft.add({
        name: "pi_edit",
        options: { codemode: false },
        description: "Pi-shaped edit",
        input: Schema.Struct({ path: Schema.String, edits: Schema.Array(Schema.Struct({ oldText: Schema.String })) }),
        execute: (input) => Effect.sync(() => executed.push(input)).pipe(Effect.as({ content: "pi edit" })),
      })
    })
    const snapshot = yield* registry.snapshot()
    const pi = snapshot.definitions.find((definition) => definition.name === "pi_edit")
    if (pi === undefined) throw new Error("pi_edit is not listed")
    yield* snapshot.execute({
      ...identity,
      call: { type: "tool-call", id: "call-alias", name: "edit", input: '{"path":"a.ts","edits":[{"oldText":"x"}]}' },
      definitions: new Map([["edit", pi]]),
    })
    expect(executed).toEqual([{ path: "a.ts", edits: [{ oldText: "x" }] }])
  }),
)
// Upstream's fixed alias runs a `bash` call as `shell` when no tool is named `bash`. A harness that lists its own tool
// as `bash` (own's pi lists `pi_bash` so) keeps it: the call runs the listed tool and gets no alias note.
it.effect("a listed alias wins over the fixed bash alias", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const registry = yield* Tool.Service
    const executed: string[] = []
    yield* plugins.activate([{ ...ToolInputRepairPlugin.Plugin, revision: "1" }])
    yield* registry.transform((draft) => {
      draft.add({
        name: "shell",
        options: { codemode: false },
        description: "Core-shaped shell",
        input: Schema.Struct({ command: Schema.String }),
        execute: () => Effect.sync(() => executed.push("shell")).pipe(Effect.as({ content: "shell" })),
      })
      draft.add({
        name: "pi_bash",
        options: { codemode: false },
        description: "Pi-shaped bash",
        input: Schema.Struct({ command: Schema.String }),
        execute: (input) => Effect.sync(() => executed.push(`pi_bash ${input.command}`)).pipe(Effect.as({ content: "pi" })),
      })
    })
    const snapshot = yield* registry.snapshot()
    const pi = snapshot.definitions.find((definition) => definition.name === "pi_bash")
    if (pi === undefined) throw new Error("pi_bash is not listed")
    const result = yield* snapshot.execute({
      ...identity,
      call: { type: "tool-call", id: "call-bash", name: "bash", input: { command: "ls" } },
      definitions: new Map([["bash", pi]]),
    })
    expect(executed).toEqual(["pi_bash ls"])
    expect(JSON.stringify(result)).not.toContain("There is no")
  }),
)
// OWN-PATCH(P-028) end
