export * as GitHubCommands from "./commands.js"

/** Past this many tracked commands, ones that never started are let go. */
export const MAX = 1000
/**
 * `shell.created` reaches the plugin through the event stream after the spawn: a command younger than this may run
 * already although its event has not come, so it is never let go.
 */
export const START_GRACE_MS = 60_000

/**
 * Core's shell commands whose git login ends with their `shell.exited` (GH-27), by command id. A command whose
 * permission was refused never starts, so never exits: past {@link MAX} the oldest that never started
 * (`shell.created`) and is older than {@link START_GRACE_MS} is let go, and its login ends with it. A started command
 * keeps its login until its exit however many there are; one that exited is gone already (decisions RL2-L4).
 */
export function make<T extends { readonly exit: AbortController }>(input: {
  readonly now: () => number
  readonly max?: number
}) {
  const commands = new Map<string, { readonly value: T; readonly at: number; started: boolean }>()
  return {
    add: (id: string, value: T) => {
      commands.set(id, { value, at: input.now(), started: false })
      if (commands.size <= (input.max ?? MAX)) return
      const now = input.now()
      const idle = [...commands].find((entry) => !entry[1].started && now - entry[1].at >= START_GRACE_MS)
      if (!idle) return
      commands.delete(idle[0])
      idle[1].value.exit.abort()
    },
    /** The command's process was spawned (`shell.created`): it is kept until its exit. */
    started: (id: string) => {
      const entry = commands.get(id)
      if (entry) entry.started = true
      return entry?.value
    },
    /** The command ended (`shell.exited`, `shell.deleted`): its login ends. */
    ended: (id: string) => {
      const entry = commands.get(id)
      if (!entry) return
      commands.delete(id)
      entry.value.exit.abort()
    },
    clear: () => {
      for (const entry of commands.values()) entry.value.exit.abort()
      commands.clear()
    },
    has: (id: string) => commands.has(id),
  }
}
