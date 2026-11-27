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
}
