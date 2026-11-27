export * as McpSends from "./sends.js"

import { Option, Schema } from "effect"
import { Broker, McpHost, McpSecrets, OwnID, type OwnMcp } from "@own/protocol"
import { Store } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { McpService } from "./service.js"
import { McpStore } from "./store.js"

/**
 * `이 키를 <host>에 보내기` (04 §13 "MCP", MH 2026-11-26): this PC's records of the MCP values the user sent to an SSH
 * host's server. Sending is never a default: each record is the user's explicit step for one host and one server,
 * naming which values go. The values are copied into this PC's vault (`mcp-send-<id>`, one JSON text) when sent, so
 * the host keeps getting exactly what the user sent until they send again or withdraw it, and a later change on this
 * PC never reaches the host silently (`differs` says own's server holds other values now). The broker answers that
 * host's `mcp.values` from the copy ({@link values}); the host keeps them in its service's memory only. The file
 * (`OWN_HOME\mcp-hosts.json`) holds ids and value names, never a value. Logs name ids and names only.
 */

export const EMPTY: McpHost.SendsFile = { version: 1, sends: [] }

/** One store per file and process, so the control Location and the broker share its mutex. */
const stores = new Map<string, Store.JsonFile<typeof McpHost.SendsFile>>()

export function file(deps: Pick<Deps, "runtime">) {
  const path = deps.runtime.layout.mcpHosts
  const known = stores.get(path)
  if (known) return known
  const created = new Store.JsonFile({ file: path, schema: McpHost.SendsFile, fallback: () => EMPTY })
  stores.set(path, created)
  return created
}

export function vaultID(id: string) {
  return `mcp-send-${id}` as const
}

const decodeValues = Schema.decodeUnknownOption(Schema.fromJsonString(McpStore.Values))

type Answer<T> = McpService.Answer<T>

export function create(deps: Deps) {
  const store = file(deps)
  const log = deps.log.child("mcp-hosts")
  const fail = (type: string, message: string, data: object = {}): Answer<never> => ({
    ok: false,
    error: { type: type as never, message, data },
  })

  async function view(input: McpHost.SendsInput = {}): Promise<McpHost.Sends> {
    const read = await store.read()
    const servers = (await McpStore.file(deps).read()).servers
    const sends = await Promise.all(
      read.sends
        .filter((record) => input.hostId === undefined || record.hostId === input.hostId)
        .map(async (record): Promise<McpHost.Send> => {
          const differs = await differ(record, servers)
          return {
            hostId: record.hostId,
            server: record.server,
            names: record.names,
            source: record.source,
            at: record.at,
            ...(differs ? { differs: true } : {}),
          }
        }),
    )
    return { sends }
  }

  /** Whether own's server holds other values now than the copy (a config file's source is not compared). */
  async function differ(record: McpHost.SendRecord, servers: ReadonlyArray<McpStore.Entry>) {
    if (record.source.type !== "own") return false
    const id = record.source.id
    const entry = servers.find((item) => item.id === id)
    if (!entry) return true
    const now = await McpStore.values(deps, entry)
    const copy = await read(record.id)
    if (now === undefined || copy === undefined) return false
    return !McpStore.sameValues(pick(now, record.names), copy)
  }

  async function send(input: McpHost.SendInput): Promise<Answer<McpHost.Sends>> {
    const source = await valuesOf(input.source)
    if (!source.ok) return source
    const missing = input.names.find((name) => !has(source.value, name))
    if (missing !== undefined) return fail("mcp_secret_missing", "no value of this name", { name: missing })
    const values = pick(source.value, input.names)
    const id = OwnID.ulid()
    const text = JSON.stringify(Schema.encodeSync(McpStore.Values)(values))
    if (!(await deps.runtime.credentials.storeFeatureKey(vaultID(id), text)).ok)
      return fail("vault_unavailable", "the vault did not answer")
    const at = deps.clock.now()
    const before = await store.read()
    const replaced = before.sends.filter((item) => item.hostId === input.hostId && item.server === input.server)
    const record: McpHost.SendRecord = {
      id,
      hostId: input.hostId,
      server: input.server,
      names: [...input.names],
      source:
        input.source.type === "own" ? { type: "own", id: input.source.id } : { type: "file", name: input.source.name },
      at,
    }
    await store.update((current) => ({
      ...current,
      sends: [
        ...current.sends.filter((item) => !(item.hostId === input.hostId && item.server === input.server)),
        record,
      ],
    }))
    // The copy it replaced goes; a vault that keeps it leaves an orphan named in the log, never a record.
    await Promise.all(replaced.map((item) => removeCopy(item.id)))
    log.info("mcp_values_sent", {
      hostId: input.hostId,
      server: input.server,
      names: input.names,
      source: record.source.type,
    })
    changed(input.hostId)
    return { ok: true, value: await view({ hostId: input.hostId }) }
  }

  async function unsend(input: McpHost.UnsendInput): Promise<Answer<McpHost.Sends>> {
    const before = await store.read()
    const gone = before.sends.filter((item) => item.hostId === input.hostId && item.server === input.server)
    const removed = await Promise.all(
      gone.map(async (item) => (await deps.runtime.credentials.removeFeatureKey(vaultID(item.id))).ok),
    )
    if (removed.some((ok) => !ok)) return fail("vault_unavailable", "the vault did not answer")
    await store.update((current) => ({
      ...current,
      sends: current.sends.filter((item) => !(item.hostId === input.hostId && item.server === input.server)),
    }))
    if (gone.length > 0) log.info("mcp_values_withdrawn", { hostId: input.hostId, server: input.server })
    changed(input.hostId)
    return { ok: true, value: await view({ hostId: input.hostId }) }
  }

  /** The values of a send's source: own's server's from the vault, a config file's as the page passed them. */
  async function valuesOf(source: McpHost.SendSource): Promise<Answer<McpStore.Values>> {
    if (source.type === "own") {
      const entry = (await McpStore.file(deps).read()).servers.find((item) => item.id === source.id)
      if (!entry) return fail("mcp_not_found", "no such server", { id: source.id })
      const values = await McpStore.values(deps, entry)
      if (values === undefined) return fail("vault_unavailable", "the vault did not answer")
      return { ok: true, value: values }
    }
    return fileValues(source.transport)
  }

  async function removeCopy(id: string) {
    const removed = await deps.runtime.credentials.removeFeatureKey(vaultID(id))
    if (!removed.ok) log.warn("mcp_send_orphan", { id })
  }

  async function read(id: string) {
    const stored = await deps.runtime.credentials.mcpSecrets(vaultID(id))
    if (!stored.ok) return undefined
    return Option.getOrUndefined(decodeValues(stored.text))
  }

  function changed(hostId: string) {
    deps.runtime.broadcast.emit("mcp.hosts.changed", { hostId })
    void deps.emitter.global("mcp.changed", {})
  }

  return { view, send, unsend, read }
}

export type Sends = ReturnType<typeof create>

/**
 * The broker's answer to a host's `mcp.values` (04 §13 "MCP"): the copy sent to this host's server, for this host only;
 * `sent: false` when nothing is (withdrawn, never sent, or the vault did not give it: the server stays off there).
 */
export async function values(deps: Deps, hostId: string, server: string): Promise<Broker.McpValues> {
  const record = (await file(deps).read()).sends.find((item) => item.hostId === hostId && item.server === server)
  const none: Broker.McpValues = { sent: false, env: {}, headers: {} }
  if (!record) return none
  const copy = await create(deps).read(record.id)
  if (!copy) return none
  return {
    sent: true,
    env: copy.env,
    headers: copy.headers,
    ...(copy.search ? { search: copy.search } : {}),
    ...(copy.url ? { url: copy.url } : {}),
  }
}

/** Whether `values` holds the value `name` (an environment or header name, or the address's `URL`). */
function has(values: McpStore.Values, name: string) {
  if (name === McpHost.ADDRESS) return values.search !== undefined || values.url !== undefined
  return Object.hasOwn(values.env, name) || Object.hasOwn(values.headers, name)
}

/** Only the named values (`URL` takes the address's `?` part and hidden address). */
export function pick(values: McpStore.Values, names: ReadonlyArray<string>): McpStore.Values {
  const wanted = new Set(names)
  const address = wanted.has(McpHost.ADDRESS)
  return {
    env: Object.fromEntries(Object.entries(values.env).filter((entry) => wanted.has(entry[0]))),
    headers: Object.fromEntries(Object.entries(values.headers).filter((entry) => wanted.has(entry[0]))),
    ...(address && values.search ? { search: values.search } : {}),
    ...(address && values.url ? { url: values.url } : {}),
  }
}

/** A config file's server's values as the page read them from that file: environment, headers, the address's parts. */
function fileValues(transport: OwnMcp.TransportInput): Answer<McpStore.Values> {
  if (transport.type === "local")
    return {
      ok: true,
      value: {
        env: Object.fromEntries(
          transport.env.flatMap((item) => (item.value === undefined ? [] : [[item.name, item.value]])),
        ),
        headers: {},
      },
    }
  const headers = Object.fromEntries(
    transport.headers.flatMap((item) => (item.value === undefined ? [] : [[item.name, item.value]])),
  )
  if (transport.url === undefined || !URL.canParse(transport.url)) return { ok: true, value: { env: {}, headers } }
  const address = McpSecrets.address(transport.url)
  return {
    ok: true,
    value: {
      env: {},
      headers,
      ...(address.search ? { search: address.search } : {}),
      ...(address.hidden ? { url: address.base } : {}),
    },
  }
}
