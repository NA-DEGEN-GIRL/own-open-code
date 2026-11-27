// Tool cards for the `codex` harness's tools (10 §3.8): session-ui draws tools by name (its renderer registry and the
// timeline's grouping both branch on `shell`, `patch`, `question`, `read`, `execute`, `subagent`), so Codex's
// `exec_command`, `write_stdin`, `apply_patch`, `request_user_input`, `view_image`, Code Mode's `exec` and the agent
// tools' `spawn_agent` parts are shown under those names. The `pi` harness's `bash` is the shell card; its `read`,
// `edit` and `write` share core's names, and only Pi's `edit{path, edits[]}` input is given session-ui's fields. The
// `dsh` harness's `pwsh` (and `bash` outside Windows) is the shell card too; its `read`, `write` and `edit` take
// `file_path`, `old_string`, `new_string` and `replace_all`, which are given core's names. omo (원본)'s `task` and
// `call_omo_agent` (own-omo, own/docs/15) are subagent cards: the agent is the call's `subagent_type` (or its
// category), and the child session is the result's `metadata.sessionID` as own-omo reports it; its `todowrite` is the
// generic card.
// The web search card (03 §18.2, WM 2026-10-19): session-ui titles it from the tool's `metadata.provider` (the
// service id, capitalized: `Own-chatgpt 웹 검색`), so an aliasing with `webSearchTitle` hands it own's title for that
// id instead (`ChatGPT로 검색`, `Parallel로 검색 (무료)`, `여러 서비스로 검색 · ChatGPT·Exa` from the tool's text, MS);
// ui-i18n.ts makes session-ui's template the title alone.
// The alias is display-only: a Proxy over the store's own objects, so streaming updates still show, and one wrapper
// per object keeps session-ui's identity-keyed caches (mapArray, WeakMaps) stable. `unwrapped` gives own code the
// store's object back (the service id, not the title).
import type { SessionMessageInfo } from "@opencode/client/promise"

const ALIASES: Readonly<Record<string, string>> = {
  exec_command: "shell",
  write_stdin: "shell",
  apply_patch: "patch",
  request_user_input: "question",
  view_image: "read",
  exec: "execute",
  collaboration__spawn_agent: "subagent",
  multi_agent_v1__spawn_agent: "subagent",
  bash: "shell",
  pwsh: "shell",
  task: "subagent",
  call_omo_agent: "subagent",
}

type Part = { readonly type: string; readonly name?: string; readonly state?: Record<string, unknown> }

/**
 * The title of a web search card for the service id that answers it and the tool's state (its text names the services
 * of a multi-service search); read while session-ui draws, so reactive.
 */
export type WebSearchTitle = (provider: string, state: Readonly<Record<string, unknown>>) => string

const RAW = Symbol("own.tool-alias.raw")

/** The store's own object behind an aliased one (the same object when it was not aliased). */
export function unwrapped<T>(value: T): T {
  return ((value as { [RAW]?: T } | undefined)?.[RAW] ?? value) as T
}

/** An aliasing with its own wrapper caches: one per transcript view, so its web search titles are that view's. */
export function createToolAliases(options: { readonly webSearchTitle?: WebSearchTitle } = {}) {
  const messages = new WeakMap<object, SessionMessageInfo>()
  const parts = new WeakMap<object, Part>()
  const states = new WeakMap<object, Record<string, unknown>>()
  const metadatas = new WeakMap<object, Record<string, unknown>>()
  const title = options.webSearchTitle

  /** The message as session-ui should draw it: aliased tool parts, otherwise the same object. */
  function wrap(message: SessionMessageInfo): SessionMessageInfo {
    if (message.type !== "assistant") return message
    const content = (message as { content?: ReadonlyArray<Part> }).content
    if (!content?.some(aliased)) return message
    const known = messages.get(message)
    if (known) return known
    const wrapped = new Proxy(message, {
      get: (target, key) => {
        if (key === RAW) return target
        return key === "content"
          ? (((target as Record<PropertyKey, unknown>)[key] as ReadonlyArray<Part>) ?? []).map(part)
          : (target as Record<PropertyKey, unknown>)[key]
      },
    })
    messages.set(message, wrapped)
    return wrapped
  }

  function aliased(entry: Part) {
    return (
      entry.type === "tool" &&
      entry.name !== undefined &&
      (ALIASES[entry.name] !== undefined ||
        piEdit(entry) ||
        dshFile(entry) ||
        (entry.name === "websearch" && title !== undefined))
    )
  }

  function part(entry: Part): Part {
    if (!aliased(entry)) return entry
    const known = parts.get(entry)
    if (known) return known
    const name = entry.name!
    const wrapped = new Proxy(entry, {
      get: (target, key) => {
        if (key === RAW) return target
        if (key === "name") return ALIASES[name] ?? name
        const value = (target as Record<PropertyKey, unknown>)[key]
        return key === "state" && value && typeof value === "object"
          ? state(name, value as Record<string, unknown>)
          : value
      },
    })
    parts.set(entry, wrapped)
    return wrapped
  }

  /** Codex's input names where the session-ui renderer reads its own (`cmd` → `command`); a search's title. */
  function state(name: string, value: Record<string, unknown>) {
    const known = states.get(value)
    if (known) return known
    const wrapped = new Proxy(value, {
      get: (target, key) => {
        if (key === RAW) return target
        const field = (target as Record<PropertyKey, unknown>)[key]
        if (key === "metadata" && name === "websearch" && field && typeof field === "object")
          return metadata(field as Record<string, unknown>, target)
        if (key !== "input" || !field || typeof field !== "object") return field
        return input(name, field as Record<string, unknown>)
      },
    })
    states.set(value, wrapped)
    return wrapped
  }

  /** A web search's metadata whose `provider` reads as own's title for the service (session-ui shows only that). */
  function metadata(value: Record<string, unknown>, state: Record<string, unknown>) {
    const known = metadatas.get(value)
    if (known) return known
    const wrapped = new Proxy(value, {
      get: (target, key) => {
        if (key === RAW) return target
        const field = (target as Record<PropertyKey, unknown>)[key]
        return key === "provider" && typeof field === "string" && title ? title(field, state) : field
      },
    })
    metadatas.set(value, wrapped)
    return wrapped
  }

  return { wrap }
}

/** The aliasing without web search titles (Codex, Pi and dsh tool names only). */
export const withToolAliases = createToolAliases().wrap

/** dsh's file tools (`read`/`write`/`edit` with `file_path`), which core's cards read as `path`. */
function dshFile(entry: Part) {
  const input = entry.state?.input
  return (
    (entry.name === "read" || entry.name === "write" || entry.name === "edit") &&
    typeof input === "object" &&
    input !== null &&
    typeof (input as { file_path?: unknown }).file_path === "string"
  )
}

/** Pi's edit (`edit{path, edits[]}`), which core's edit card reads as `oldString`/`newString`. */
function piEdit(entry: Part) {
  const input = entry.state?.input
  return (
    entry.name === "edit" &&
    typeof input === "object" &&
    input !== null &&
    Array.isArray((input as { edits?: unknown }).edits)
  )
}

function input(name: string, value: Record<string, unknown>) {
  if (name === "exec_command" && typeof value.cmd === "string") return { ...value, command: value.cmd }
  if (name === "exec" && typeof value.input === "string") return { ...value, code: value.input }
  if (name.endsWith("__spawn_agent"))
    return {
      ...value,
      agent: typeof value.agent_type === "string" ? value.agent_type : "codex",
      description: typeof value.task_name === "string" ? value.task_name : "agent",
      prompt: value.message,
    }
  if (name === "task" || name === "call_omo_agent")
    return {
      ...value,
      agent:
        typeof value.subagent_type === "string"
          ? value.subagent_type
          : typeof value.category === "string"
            ? value.category
            : "task",
      description: typeof value.description === "string" ? value.description : "task",
    }
  // dsh's file tools: core's field names for its cards.
  if ((name === "read" || name === "write" || name === "edit") && typeof value.file_path === "string")
    return {
      ...value,
      path: value.file_path,
      ...(name === "edit"
        ? { oldString: value.old_string, newString: value.new_string, replaceAll: value.replace_all }
        : {}),
    }
  // One Pi replacement previews as core's edit; several show the diff the tool's result carries (`metadata.files`).
  if (name === "edit" && Array.isArray(value.edits)) {
    const only = value.edits.length === 1 ? (value.edits[0] as { oldText?: unknown; newText?: unknown }) : undefined
    return typeof only?.oldText === "string" && typeof only.newText === "string"
      ? { ...value, oldString: only.oldText, newString: only.newText }
      : value
  }
  if (name === "write_stdin")
    return {
      ...value,
      command: `write_stdin ${String(value.session_id ?? "")}${value.chars ? ` ${JSON.stringify(value.chars)}` : ""}`,
    }
  return value
}
