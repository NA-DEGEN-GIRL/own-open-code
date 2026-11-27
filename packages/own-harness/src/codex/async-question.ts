// Ports Codex's `request_user_input_async` (codex-rs/core/src/tools/handlers/request_user_input_async.rs,
// rust-v0.162.1): the model puts questions to the user without waiting. Codex shows them as a final-answer message
// delivered asynchronously and answers `{"accepted":true}`; the user's reply arrives later as ordinary input. Offered
// to models whose catalog lists `request_user_input_async` or `send_user_message_async` (the gpt-6 family).
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as AsyncQuestion from "./async-question.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Gate } from "../gate.js"
import type { Catalog } from "./catalog.js"
import { CodeModeTools } from "./code-mode-tools.js"

export const NAME = "request_user_input_async"

export function available(model: Catalog.Model) {
  return (model.experimental_supported_tools ?? []).some(
    (tool) => tool === "request_user_input_async" || tool === "send_user_message_async",
  )
}

interface Question {
  readonly title: string
  readonly options?: ReadonlyArray<string>
}

/** The message text Codex shows, or the error it answers the model with. */
export function render(raw: unknown): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string } {
  const questions = (raw as { questions?: ReadonlyArray<Question> }).questions ?? []
  if (questions.length === 0) return { ok: false, text: "questions must not be empty" }
  if (questions.some((question) => question.title.trim() === ""))
    return { ok: false, text: "question titles must not be empty" }
  if (questions.some((question) => question.options !== undefined && (question.options.length === 0 || question.options.some((option) => option.trim() === ""))))
    return { ok: false, text: "options must contain at least one non-empty answer" }
  return {
    ok: true,
    text: questions
      .map((question) => [question.title, ...(question.options ?? []).map((option) => `- ${option}`)].join("\n"))
      .join("\n\n"),
  }
}

export const register = (ctx: Pick<Context, "tool">) =>
  ctx.tool.transform((editor) => {
    const spec = CodeModeTools.spec("functions", NAME)
    editor.add({
      name: NAME,
      description: spec.description,
      input: spec.parameters!,
      options: { codemode: false, permission: Gate.ACTION },
      execute: (raw: unknown) =>
        Effect.sync(() => {
          const rendered = render(raw)
          // The questions travel in the metadata for the transcript; the model sees Codex's answer.
          return rendered.ok
            ? { content: '{"accepted":true}', metadata: { truncated: true, questions: rendered.text } }
            : { content: rendered.text, metadata: { truncated: true } }
        }),
    })
  })
