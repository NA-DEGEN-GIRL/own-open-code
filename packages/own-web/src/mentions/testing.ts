// Test support (unit tests of src/mentions and src/commands only; never imported by the app): a server runtime with
// the parts the suggestions read — per-location catalogs as a Solid store (so a late `sync` updates an open list like
// the real data layer), `fs.find`, `session.diff`, and a recorder for every write.
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"

export interface FakeCatalog {
  readonly agents?: readonly {
    id: string
    name: string
    mode: "subagent" | "primary" | "all"
    hidden?: boolean
    description?: string
  }[]
  readonly commands?: readonly { name: string; description?: string }[]
  readonly skills?: readonly { id: string; name: string; description?: string }[]
  readonly references?: readonly { name: string; path: string; description?: string; hidden?: boolean }[]
  readonly resources?: readonly { server: string; name: string; uri: string }[]
}

export interface FakeRuntimeOptions {
  readonly directory?: string
  readonly catalog?: FakeCatalog
  /** fs.find answer per query (default: files containing the query). */
  readonly files?: readonly string[]
  readonly findDelayMs?: number
  readonly diff?: readonly string[]
  readonly session?: {
    readonly id: string
    readonly agent?: string
    readonly revert?: { messageID: string }
    readonly running?: boolean
    readonly messages?: readonly { id: string; type: "user" | "assistant"; text?: string }[]
    readonly pending?: readonly { id: string; type: "user" }[]
    /** The session's metadata (own.harness binds a harness there). */
    readonly metadata?: Readonly<Record<string, unknown>>
  }
}

export function fakeRuntime(options: FakeRuntimeOptions = {}) {
  const directory = options.directory ?? "/repo"
  const calls: { method: string; input: unknown }[] = []
  const record = (method: string, input: unknown) => void calls.push({ method, input })
  const [catalog, setCatalog] = createStore<{ loaded: Record<string, boolean> }>({ loaded: {} })
  const catalogs = options.catalog ?? {}
  const session = options.session
  const [state, setState] = createStore({
    agent: session?.agent,
    revert: session?.revert,
    running: session?.running ?? false,
  })

  const resource = <T>(field: string, data: T) => ({
    list: (ref?: { directory: string }) => (ref?.directory === directory && catalog.loaded[field] ? data : undefined),
    sync: async (ref?: { directory: string }) => {
      record(`location.${field}.sync`, ref)
      setCatalog("loaded", field, true)
    },
  })

  const client = {
    file: {
      find: async (
        input: { query: string; limit?: number; location?: { directory?: string } },
        request?: { signal?: AbortSignal },
      ) => {
        record("file.find", input)
        if (options.findDelayMs) await new Promise((resolve) => setTimeout(resolve, options.findDelayMs))
        if (request?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" })
        const data = (options.files ?? [])
          .filter((path) => path.toLowerCase().includes(input.query.toLowerCase()))
          .slice(0, input.limit ?? 50)
          .map((path) => ({ path, type: path.endsWith("/") ? ("directory" as const) : ("file" as const) }))
        return { location: { directory }, data }
      },
    },
    session: {
      command: async (input: unknown) => record("session.command", input),
      diff: async (input: unknown) => {
        record("session.diff", input)
        return (options.diff ?? []).map((file) => ({ file, patch: "", additions: 1, deletions: 0, status: "modified" }))
      },
      fork: async (input: { sessionID: string }) => {
        record("session.fork", input)
        return { id: "ses_forked", projectID: "p1", location: { directory } }
      },
      interrupt: async (input: unknown) => {
        record("session.interrupt", input)
        setState("running", false)
      },
      switchAgent: async (input: { agent: string }) => {
        record("session.switchAgent", input)
        setState("agent", input.agent)
      },
      export: async (input: unknown) => {
        record("session.export", input)
        return { info: { id: session?.id ?? "ses", title: "세션: 내보내기?" }, messages: [] }
      },
      revert: {
        stage: async (input: { messageID: string }) => {
          record("session.revert.stage", input)
          setState("revert", { messageID: input.messageID })
        },
        clear: async (input: unknown) => {
          record("session.revert.clear", input)
          setState("revert", undefined)
        },
      },
      inbox: { cancel: async (input: unknown) => record("session.inbox.cancel", input) },
    },
  }

  const runtime = {
    key: "local",
    connection: { status: () => "connected" as const },
    client: () => client,
    sessions: { state: { sessions: session ? { [session.id]: { projectID: "p1" } } : {} } },
    data: {
      location: {
        agent: resource("agent", catalogs.agents ?? []),
        command: resource("command", catalogs.commands ?? []),
        skill: resource("skill", catalogs.skills ?? []),
        reference: resource(
          "reference",
          (catalogs.references ?? []).map((reference) => ({
            ...reference,
            source: { type: "local", path: reference.path },
          })),
        ),
        mcp: { resource: resource("mcpResource", catalogs.resources ?? []) },
      },
      session: {
        get: (id: string) =>
          session && id === session.id
            ? {
                id,
                projectID: "p1",
                agent: state.agent,
                revert: state.revert,
                location: { directory },
                metadata: session.metadata,
              }
            : undefined,
        status: (id: string) => (session && id === session.id && state.running ? "running" : "idle"),
        remember: (info: unknown) => record("session.remember", info),
        message: {
          list: (id: string) => (session && id === session.id ? (session.messages ?? []) : []),
          sync: async (id: string) => record("session.message.sync", id),
        },
        pending: { list: (id: string) => (session && id === session.id ? (session.pending ?? []) : []) },
        prompt: async (input: unknown) => record("session.prompt", input),
        compact: async (input: unknown) => record("session.compact", input),
      },
    },
  }
  return {
    // SAFETY: the suggestions read only the members above; tests exercise exactly those paths.
    runtime: runtime as unknown as ServerRuntime,
    calls,
    directory,
    /** Marks a catalog loaded without a `sync` call (the list is already in the data layer). */
    load: (...fields: string[]) => fields.forEach((field) => setCatalog("loaded", field, true)),
    setRunning: (running: boolean) => setState("running", running),
  }
}
