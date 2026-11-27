// OWN-PATCH(P-019) begin
import type { Tool } from "@opencode/schema/tool"
import type { Effect } from "effect"
// OWN-PATCH(P-019) end
import type { Hooks } from "./registration.js"

export interface ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
  // OWN-PATCH(P-046) begin
  /** The session that starts the command (its `metadata.sessionID`), when a session starts it. */
  readonly sessionID?: string
  /** The command's id (`Shell.Info.id`, the `shell.exited` and `shell.deleted` events'), made before the hooks run. */
  readonly id?: string
  // OWN-PATCH(P-046) end
}

export interface ShellHooks {
  readonly "create.before": ShellCreateBefore
}

export interface ShellDomain {
  readonly hook: Hooks<ShellHooks>
  // OWN-PATCH(P-019) begin
  /**
   * Approves a command a plugin tool runs itself, exactly as core's shell tool approves its own: the working directory
   * and every `cd` target outside the Location ask `external_directory`, then each parsed command asks `shell`.
   * `shell` is the shell that will run it (a name or path such as `powershell` or `/bin/bash`). Answers the absolute
   * working directory.
   */
  readonly authorize: (
    input: { readonly command: string; readonly cwd: string; readonly shell: string },
    context: Tool.Context,
  ) => Effect.Effect<{ readonly cwd: string }, Tool.Error>
  // OWN-PATCH(P-019) end
}
