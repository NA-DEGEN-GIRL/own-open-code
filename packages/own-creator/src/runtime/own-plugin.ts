// own-plugin.ts: the API of a creator code plugin (own/docs/17 §12.2). own writes this file into every C3 version; the
// plugin's entry imports it and default-exports `definePlugin({ hooks })`. own's shim (the version's `server.ts`) loads
// the plugin into the service and gives each hook a copy of the request without credentials: headers, provider options
// and keys never reach it, and only the parts named below are read back. A hook that throws, or runs longer than its
// time, stops the plugin in that Location; the service keeps running.
//
// The plugin's code may import only its own files and this one, and may not name `process`, `Bun`, `require`,
// `globalThis`, `fetch` or `eval` (own's staging refuses them, 17 §12.3). Those checks are a wall, not a sandbox: the
// plugin runs in the service process, which is why the switch is off by default.

/** A JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** One part of the system prompt. */
export interface SystemText {
  readonly type: "text"
  text: string
}

/** A conversation message as the provider request holds it (JSON). */
export interface Message {
  readonly role: string
  content: Json
  readonly [key: string]: Json | undefined
}

/** The request of one model call, as a hook sees it. */
export interface Request {
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string }
  /** The system prompt; edit `text` or the list. Changing it changes the cached prefix. */
  system: SystemText[]
  /** The conversation; append or edit. Changing earlier messages changes the cached prefix. */
  messages: Message[]
  /** The request's tools by name (read-only). */
  readonly tools: ReadonlyArray<string>
}

/** A compaction request: the same, and own's compaction prompt when own sets one. */
export interface Compaction extends Request {
  /** own's compaction prompt; edit to change what the summary asks for (undefined when core's own prompt runs). */
  prompt?: string
}

export interface Hooks {
  /** Before every model call of a conversation (core's `context` hook). */
  readonly context?: (request: Request) => void | Promise<void>
  /** Before a compaction's model call (core's `compaction` hook). */
  readonly compaction?: (request: Compaction) => void | Promise<void>
}

export interface PluginDefinition {
  readonly hooks: Hooks
}

/** The plugin's default export. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}
