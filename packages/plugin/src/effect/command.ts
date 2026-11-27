import type { CommandApi } from "@opencode/client/effect/api"
import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import type { Effect } from "effect"
import type { Transform } from "./registration.js"

export interface CommandInvocation {
  readonly sessionID: Session.ID
  readonly prompt: PromptInput.Prompt
  readonly delivery: SessionInbox.Delivery
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: CommandInvocation) => Effect.Effect<void, unknown>
}

export interface CommandEditor {
  add(definition: CommandDefinition): void
  // OWN-PATCH(P-038) begin
  /** The command an earlier transform added under `name`, so a later transform can wrap it. */
  get(name: string): CommandDefinition | undefined
  // OWN-PATCH(P-038) end
}

export interface CommandDomain extends Pick<CommandApi<unknown>, "list"> {
  readonly transform: Transform<CommandEditor>
  readonly reload: () => Effect.Effect<void>
}
