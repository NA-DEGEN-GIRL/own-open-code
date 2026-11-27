// own-mcp.ts: own's helper for a creator MCP server (own/docs/17 §11.3). own writes this file into every C2 version
// beside the server's own files; the server imports it (`./own-mcp.ts`) and calls `serve`. It runs inside own's
// WebAssembly JavaScript sandbox (QuickJS, `mcp-sandbox.ts`) together with the server's code. The sandbox has no
// environment, no process, no Bun or Node and no disk: the only way out is own's bridge (`__own`), whose every call
// own's sandbox process checks (project files only, the declared hosts only). This file only gives that bridge a
// friendly shape; nothing here is a boundary. Changing this file changes every new version's hash, never an existing
// one's.

/** A JSON value a tool takes or returns. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** A JSON schema object for a tool's arguments (`type: "object"`). */
export interface InputSchema {
  readonly type: "object"
  readonly properties?: Readonly<Record<string, unknown>>
  readonly required?: ReadonlyArray<string>
  readonly additionalProperties?: boolean
  readonly [key: string]: unknown
}

/** What one call may use besides its arguments. */
export interface ToolContext {
  /** The conversation's project folder. */
  readonly project: string
  /** Files inside the project folder; paths are relative to it, and nothing outside it (or a credential file) opens. */
  readonly files: Files
  /** HTTP to the hosts the item declares (`hosts`), which the user approved with the version. */
  readonly fetch: (url: string, init?: FetchInit) => Promise<FetchResponse>
  /** A line for the extension's log in Settings > 확장. */
  readonly log: (message: string) => void
  /** When the call's time is up (milliseconds since 1970); own stops the call then. */
  readonly deadline: number
}

export interface Files {
  read(file: string): Promise<string>
  write(file: string, text: string): Promise<void>
  list(folder?: string): Promise<string[]>
  exists(file: string): Promise<boolean>
}

export interface FetchInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export interface FetchResponse {
  readonly status: number
  readonly ok: boolean
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  text(): Promise<string>
  json(): Promise<Json>
}

/** A tool's answer: text, a JSON value (sent as text), or an error the model sees. */
export type ToolResult = string | { readonly text: string } | { readonly json: Json } | { readonly error: string }

export interface ToolDefinition {
  readonly description: string
  readonly input?: InputSchema
  // The arguments arrive as the model wrote them; check what you rely on.
  readonly run: (args: Record<string, Json>, context: ToolContext) => ToolResult | Promise<ToolResult>
}

export interface ServerDefinition {
  readonly name: string
  readonly version?: string
  readonly tools: Readonly<Record<string, ToolDefinition>>
}

/** A tool call's answer as MCP carries it. */
export interface CallResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly isError?: boolean
}

/** own's bridge: the sandbox's only way out, checked by own's sandbox process. Strings in, strings out. */
interface Bridge {
  readonly project: string
  readonly outputChars: number
  read(file: string): string
  write(file: string, text: string): string | undefined
  list(folder: string): string
  exists(file: string): boolean
  log(line: string): void
  fetch(request: string): Promise<string>
  deadline(): number
  serve(dispatch: { list(): string; call(name: string, args: string): Promise<string> }): void
  test(name: string, run: () => unknown): void
}

declare const __own: Bridge

/** Starts the server. Call it once, from the entry file. */
export function serve(definition: ServerDefinition) {
  __own.serve({
    list: () =>
      JSON.stringify(
        Object.entries(definition.tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.input ?? { type: "object", properties: {} },
        })),
      ),
    call: async (name, args) => JSON.stringify(await callTool(definition, name, parseArgs(args))),
  })
}

/** Runs one tool as a call would (the extension's own tests use it). */
export async function callTool(
  definition: ServerDefinition,
  name: string,
  args: Record<string, Json> = {},
): Promise<CallResult> {
  const tool = Object.hasOwn(definition.tools, name) ? definition.tools[name] : undefined
  if (tool === undefined) return text(`No tool '${name}'.`, true)
  try {
    const result = await tool.run(args, context())
    if (typeof result === "string") return text(result, false)
    if ("error" in result) return text(result.error, true)
    if ("json" in result) return text(JSON.stringify(result.json, null, 2), false)
    return text(result.text, false)
  } catch (error) {
    return text(`The tool failed: ${error instanceof Error ? error.message : String(error)}`, true)
  }
}

/** own's bridge reports a refused call as a string beginning with this marker; turn it back into a thrown error. */
const ERR = "ERR"
function unwrap(value: string) {
  if (value.startsWith(ERR)) throw new Error(value.slice(ERR.length))
  return value
}

function context(): ToolContext {
  return {
    project: __own.project,
    files: {
      read: async (file) => unwrap(__own.read(file)),
      write: async (file, value) => void unwrap(__own.write(file, String(value)) ?? ""),
      list: async (folder = ".") => JSON.parse(unwrap(__own.list(folder))) as string[],
      exists: async (file) => __own.exists(file),
    },
    fetch: async (url, init = {}) => {
      const answer = JSON.parse(await __own.fetch(JSON.stringify({ url, ...init }))) as {
        status: number
        url: string
        headers: Record<string, string>
        body: string
      }
      return {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        url: answer.url,
        headers: answer.headers,
        text: async () => answer.body,
        json: async () => JSON.parse(answer.body) as Json,
      }
    },
    log: (message) => __own.log(String(message)),
    deadline: __own.deadline(),
  }
}

function text(value: string, isError: boolean): CallResult {
  const max = __own.outputChars
  const cut = value.length > max ? `${value.slice(0, max)}\n[cut at ${max}]` : value
  return { content: [{ type: "text", text: cut }], ...(isError ? { isError: true } : {}) }
}

function parseArgs(raw: string): Record<string, Json> {
  const value: unknown = JSON.parse(raw)
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : {}
}

// ---- the extension's tests (`*.test.ts`), run inside the sandbox at staging ----

/** One test; `run` may be async. Staging runs every test file's tests in the sandbox, against a scratch project. */
export function test(name: string, run: () => unknown) {
  __own.test(name, run)
}

/** `describe` groups tests by name only. */
export function describe(name: string, run: () => void) {
  void name
  run()
}

/** A few matchers, enough for a tool's tests. */
export function expect(actual: unknown) {
  const fail = (message: string): never => {
    throw new Error(message)
  }
  const show = (value: unknown) => {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return {
    toBe: (expected: unknown) => void (Object.is(actual, expected) || fail(`expected ${show(expected)}, got ${show(actual)}`)),
    toEqual: (expected: unknown) =>
      void (show(actual) === show(expected) || fail(`expected ${show(expected)}, got ${show(actual)}`)),
    toContain: (expected: unknown) =>
      void ((typeof actual === "string" && typeof expected === "string" && actual.includes(expected)) ||
        (Array.isArray(actual) && actual.includes(expected)) ||
        fail(`expected ${show(actual)} to contain ${show(expected)}`)),
    toBeTruthy: () => void (actual ? true : fail(`expected ${show(actual)} to be truthy`)),
    toBeFalsy: () => void (actual ? fail(`expected ${show(actual)} to be falsy`) : true),
    toThrow: () => {
      if (typeof actual !== "function") return fail("toThrow needs a function")
      try {
        ;(actual as () => unknown)()
      } catch {
        return
      }
      fail("expected the function to throw")
    },
  }
}
