export * as Commands from "./commands.js"

import type { CommandInvocation } from "@opencode/plugin/effect/command"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import type { V1Hooks } from "../omo-runtime.js"

/** omo's commands the MVP offers (15 §5). */
export const COMMANDS = ["stop-continuation"] as const

/** own's command that undoes `/stop-continuation` without a restart (OMO-P8, 15 §3.4). */
export const RESUME = "resume-continuation"
export const RESUME_DESCRIPTION = "/stop-continuation으로 멈춘 omo의 남은 할 일 이어서 하기를 다시 켜요"

/** The error a command gives outside an omo session (15 §3.4). */
export const NOT_OMO = "omo (원본) 세션에서만 써요."

/** `/resume-continuation`'s error in own.team's sessions, where omo never continues open todos (15 §3.10). */
export const TEAM = "팀 대화에서는 omo가 남은 할 일을 이어서 하지 않아요. 다음 일은 팀 메인과 팀 소식이 정해요."

/**
 * Registers omo's commands from its config result (`config.command[name]`: `{description, template}`) and own's
 * `/resume-continuation`. Running omo's command in an omo session runs omo's `command.execute.before` and sends the
 * template (with `$ARGUMENTS`) as the prompt. `/resume-continuation` runs only that hook, which clears omo's stop
 * (OMO-P8), sends nothing and calls `resumed`, which lets omo continue an idle session's open todos now; in own.team's
 * sessions it fails with {@link TEAM}. Anywhere else either fails with {@link NOT_OMO}.
 */
export const register = (
  ctx: Pick<Context, "command" | "session">,
  input: {
    readonly commands: Readonly<Record<string, unknown>>
    readonly hooks: V1Hooks
    readonly isOmo: (sessionID: string) => Promise<boolean>
    readonly isTeam: (sessionID: string) => Promise<boolean>
    readonly resumed: (sessionID: string) => void
  },
) =>
  Effect.gen(function* () {
    const defined = COMMANDS.flatMap((name) => {
      const value = input.commands[name]
      if (typeof value !== "object" || value === null || !("template" in value) || typeof value.template !== "string")
        return []
      const description = "description" in value && typeof value.description === "string" ? value.description : undefined
      return [{ name, template: value.template, ...(description === undefined ? {} : { description }) }]
    })
    yield* ctx.command.transform((editor) => {
      defined.forEach((command) =>
        editor.add({
          name: command.name,
          ...(command.description === undefined ? {} : { description: command.description }),
          execute: (invocation) => run(ctx, input, command, invocation),
        }),
      )
      editor.add({
        name: RESUME,
        description: RESUME_DESCRIPTION,
        execute: (invocation) =>
          Effect.gen(function* () {
            const omo = yield* Effect.promise(() => input.isOmo(invocation.sessionID))
            if (omo && (yield* Effect.promise(() => input.isTeam(invocation.sessionID)))) return yield* Effect.fail(new Error(TEAM))
            yield* before(input, RESUME, invocation)
            input.resumed(invocation.sessionID)
          }),
      })
    })
    yield* ctx.command.reload()
  })

function run(
  ctx: Pick<Context, "session">,
  input: { readonly hooks: V1Hooks; readonly isOmo: (sessionID: string) => Promise<boolean> },
  command: { readonly name: string; readonly template: string },
  invocation: CommandInvocation,
) {
  return Effect.gen(function* () {
    const extra = yield* before(input, command.name, invocation)
    const text = [command.template.replaceAll("$ARGUMENTS", invocation.prompt.text.trim()), ...extra].join("\n\n")
    yield* ctx.session.prompt({ sessionID: invocation.sessionID, text, delivery: invocation.delivery })
  })
}

/** omo's `command.execute.before` in an omo session (else {@link NOT_OMO}): the text parts it adds. */
function before(
  input: { readonly hooks: V1Hooks; readonly isOmo: (sessionID: string) => Promise<boolean> },
  name: string,
  invocation: CommandInvocation,
) {
  return Effect.gen(function* () {
    if (!(yield* Effect.promise(() => input.isOmo(invocation.sessionID)))) return yield* Effect.fail(new Error(NOT_OMO))
    const output = { parts: [] as Array<{ type: string; text?: string; [key: string]: unknown }> }
    yield* Effect.tryPromise(() =>
      input.hooks["command.execute.before"]?.(
        { command: name, sessionID: invocation.sessionID, arguments: invocation.prompt.text.trim() },
        output,
      ) ?? Promise.resolve(),
    )
    return output.parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
  })
}
