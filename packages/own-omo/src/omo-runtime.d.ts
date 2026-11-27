// What `omo-runtime.js` (src/runtime-entry.ts bundled with the vendored oh-my-opencode, script/bundle.ts) exports, as
// far as the host calls it. The vendored sources are not type-checked here: these are the OpenCode 1 plugin shapes omo
// uses (`@opencode-ai/plugin` 1.18.31) and the few omo functions the host needs.

/** A part of an OpenCode 1 message as hooks see it. */
export interface V1Part {
  type: string
  text?: string
  synthetic?: boolean
  [key: string]: unknown
}

/** An OpenCode 1 tool definition (`tool()`): zod argument shapes and a promise-based `execute`. */
export interface V1ToolDefinition {
  description: string
  args: Record<string, unknown>
  execute: (args: Record<string, unknown>, context: V1ToolContext) => Promise<V1ToolResult>
}

export type V1ToolResult = string | { readonly output: string; readonly title?: string; readonly metadata?: Record<string, unknown> }

export interface V1ToolContext {
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
  readonly directory: string
  readonly worktree: string
  readonly callID: string
  readonly abort: AbortSignal
  readonly metadata: (input: { readonly title?: string; readonly metadata?: Record<string, unknown> }) => void
  readonly ask: (input: {
    readonly permission: string
    readonly patterns: ReadonlyArray<string>
    readonly always?: ReadonlyArray<string>
    readonly metadata?: Record<string, unknown>
  }) => Promise<void>
}

export interface V1Event {
  readonly type: string
  readonly properties?: Record<string, unknown>
}

export interface V1Hooks {
  readonly tool?: Record<string, V1ToolDefinition>
  readonly config?: (config: Record<string, unknown>) => Promise<void>
  readonly "chat.message"?: (
    input: {
      readonly sessionID: string
      readonly agent?: string
      readonly model?: { readonly providerID: string; readonly modelID: string }
      readonly messageID?: string
    },
    output: { message: Record<string, unknown>; parts: Array<V1Part> },
  ) => Promise<void>
  readonly "experimental.chat.system.transform"?: (
    input: { readonly sessionID?: string; readonly model: { readonly id: string; readonly providerID: string } },
    output: { system: Array<string> },
  ) => Promise<void>
  readonly event?: (input: { readonly event: V1Event }) => Promise<void>
  readonly "tool.execute.before"?: (
    input: { tool: string; readonly sessionID: string; readonly callID: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void>
  readonly "tool.execute.after"?: (
    input: { readonly tool: string; readonly sessionID: string; readonly callID: string; readonly args?: Record<string, unknown> },
    output: { title: string; output: string; metadata: Record<string, unknown> },
  ) => Promise<void>
  readonly "tool.definition"?: (
    input: { readonly toolID: string },
    output: { description: string; parameters: unknown },
  ) => Promise<void>
  readonly "command.execute.before"?: (
    input: { readonly command: string; readonly sessionID: string; readonly arguments: string },
    output: { parts: Array<V1Part> },
  ) => Promise<void>
  readonly dispose?: () => Promise<void>
}

/** What omo's plugin entry receives (OpenCode 1 `PluginInput`). */
export interface V1Input {
  readonly client: unknown
  readonly directory: string
  readonly worktree: string
  readonly project: { readonly id: string; readonly worktree: string }
  readonly serverUrl: undefined
  readonly $: unknown
  readonly experimental_workspace: { register(): void }
}

/**
 * What omo's `createHooks` returns, as far as the host touches it: the todo continuation's event handler, which omo's
 * event dispatcher reads from this object for every event.
 */
export interface V1CreatedHooks {
  readonly todoContinuationEnforcer?: { readonly handler: (input: { readonly event: V1Event }) => Promise<void> } | null
  readonly [key: string]: unknown
}

/** `createPluginModule`'s injectable startup steps the host replaces (src/runtime.ts). */
export type PluginModuleOverrides = Record<string, unknown>

export interface ZodLike {
  object(shape: Record<string, unknown>): {
    safeParse(input: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: { message: string } }
  }
  toJSONSchema(schema: unknown, options?: Record<string, unknown>): Record<string, unknown>
}

export interface OmoRuntime {
  readonly version: string
  readonly createPluginModule: (overrides: PluginModuleOverrides) => {
    readonly id: string
    readonly server: (input: V1Input, options?: Record<string, unknown>) => Promise<V1Hooks>
  }
  readonly createManagers: (args: Record<string, unknown>) => unknown
  readonly createHooks: (args: Record<string, unknown>) => V1CreatedHooks
  readonly setVersionCache: (version: string | null) => void
  readonly setLogFile: (filePath: string) => void
  readonly setMainSession: (sessionID: string | undefined) => void
  readonly getSessionAgent: (sessionID: string) => string | undefined
  readonly AGENT_DISPLAY_NAMES: Readonly<Record<string, string>>
  readonly getAgentConfigKey: (name: string) => string
  readonly getAgentToolRestrictions: (name: string, options?: { includeTeamToolDenylist?: boolean }) => Record<string, boolean>
  readonly OhMyOpenCodeConfigSchema: {
    safeParse(input: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: { message: string } }
  }
  readonly HookNameSchema: { readonly options: ReadonlyArray<string> }
  readonly OMO_INTERNAL_INITIATOR_MARKER: string
  readonly z: ZodLike
}
