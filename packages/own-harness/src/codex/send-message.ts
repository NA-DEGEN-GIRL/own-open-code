// Ports Codex's `send_message_to_user_async` (codex-rs/core/src/tools/handlers/send_message_to_user_async.rs,
// rust-v0.171.0): the model sends the user a concise message during ongoing work without ending its turn. Codex shows
// it as a final-answer message delivered asynchronously and answers `{"accepted":true}`; any reply arrives later as
// ordinary input. Offered to root agents of models whose catalog lists `send_message_to_user_async` (GPT-6.2), as a
// direct tool only (never nested in Code Mode's `exec`, `spec_plan.rs`).
// Ported from openai/codex (Apache-2.0) @ rust-v0.171.0.
export * as SendMessage from "./send-message.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Gate } from "../gate.js"
import { AgentArgs } from "./agents/args.js"
import type { Catalog } from "./catalog.js"

export const NAME = "send_message_to_user_async"

/** The tool as Codex declares it (`ToolSpec::Function`, `strict: false`, no extra properties). */
export const DESCRIPTION =
  "Send a concise message that needs the user's attention during ongoing work. The tool returns immediately without ending the turn or waiting for a reply; any reply arrives asynchronously as a new user message. Use this tool to report a critical blocker or a finding that may change the task's direction, or to answer a user question or status request received while work is still in progress. Use this tool when a message needs the user's immediate attention; use commentary for routine progress and intermediate context. Use clear formatting, such as bolding questions, to make requests easy to notice and answer."

export const PARAMETERS = {
  type: "object",
  properties: {
    message: { type: "string", description: "The concise question or update to send to the user." },
  },
  required: ["message"],
  additionalProperties: false,
}

export function available(model: Catalog.Model) {
  return (model.experimental_supported_tools ?? []).includes(NAME)
}

const ARGS: AgentArgs.Struct = { name: "SendMessageToUserAsyncArgs", fields: [{ name: "message", type: "string", required: true }] }

/** The message Codex shows, or the error text it answers the model with (`parse_arguments`, trimmed, non-empty). */
export function render(raw: unknown): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string } {
  const parsed = AgentArgs.parse(ARGS, JSON.stringify(raw ?? {}))
  if (!parsed.ok) return { ok: false, text: parsed.error }
  const text = String(parsed.values.get("message")).trim()
  return text === "" ? { ok: false, text: "message must not be empty" } : { ok: true, text }
}

export const register = (ctx: Pick<Context, "tool">) =>
  ctx.tool.transform((editor) => {
    editor.add({
      name: NAME,
      description: DESCRIPTION,
      input: PARAMETERS,
      options: { codemode: false, permission: Gate.ACTION },
      execute: (raw: unknown) =>
        Effect.sync(() => {
          const rendered = render(raw)
          // The message travels in the metadata for the transcript; the model sees Codex's answer.
          return rendered.ok
            ? { content: '{"accepted":true}', metadata: { truncated: true, message: rendered.text } }
            : { content: rendered.text, metadata: { truncated: true } }
        }),
    })
  })
