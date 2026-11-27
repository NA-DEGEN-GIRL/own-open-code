export * as McpService from "./service.js"

import os from "node:os"
import path from "node:path"
import { McpRules, McpSecrets, OwnMcp, OwnID, type OwnError } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Location } from "../location.js"
import { McpFold } from "./fold.js"
import { McpProbe } from "./probe.js"
import { McpRegistry } from "./registry.js"
import { McpSources } from "./sources.js"
import { McpStore } from "./store.js"

/**
 * The `mcp.*` methods of own.accounts (03 §18.14, SM) on the control Location's instance: the servers own added
 * (`McpStore`), the list's kept switches, the connection test (`McpProbe`), the import from other tools
 * (`McpSources`) and 찾아서 설치 (`McpRegistry`). Every change tells every Location to fold its MCP servers again
 * (`mcp.changed`) and open pages to read the list again (the `mcp.changed` event). Logs name servers, never a value,
 * a command line or an address.
 */

export type Failure = {
  readonly type: OwnError.Name
  readonly message: string
  readonly data: object
}
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure }

/** One row of a scan: the first place a definition was found and how own would store it, then its other places. */
interface Row {
  readonly found: McpSources.Found
  readonly also: Array<{ readonly found: McpSources.Found; readonly stored: Stored }>
  readonly stored?: Stored
}
type Scan = { readonly expiresAt: number; readonly rows: ReadonlyArray<Row> }
type Stored = { readonly transport: McpStore.Entry["transport"]; readonly values: McpStore.Values }

export function create(deps: Deps) {
  const store = McpStore.file(deps)
  const log = deps.log.child("mcp")
  const now = () => deps.clock.now()
  const scans = new Map<string, Scan>()

  const fail = (type: OwnError.Name, message: string, data: object = {}): Answer<never> => ({
    ok: false,
    error: { type, message, data },
  })

  async function resolved() {
    const file = await store.read()
    const servers = await Promise.all(
      file.servers.map(async (entry) => ({ entry, values: await McpStore.values(deps, entry) })),
    )
    return { file, servers }
  }

  async function list(input: { readonly directory?: string } = {}): Promise<OwnMcp.View> {
    const read = await resolved()
    const errors = input.directory === undefined ? undefined : await coreErrors(read.servers, input.directory)
    return {
      servers: read.servers.map((item) => McpStore.view(item.entry, item.values)),
      overrides: read.file.overrides,
      vault: read.servers.some((item) => item.values === undefined) ? "unavailable" : "ok",
      ...(errors === undefined ? {} : { errors }),
    }
  }

  /**
   * Core's error text of own's failed servers in a project's Location, each with its stored values cut out as in a
   * connection test: the page shows this, never core's own text, for own's servers. A server whose values the vault
   * did not give has nothing to cut them with, so its text is left out.
   */
  async function coreErrors(servers: ReadonlyArray<McpFold.Resolved>, directory: string) {
    if (!path.isAbsolute(directory)) return undefined
    const here = servers.filter((item) => McpFold.applies(item.entry.scope, directory))
    if (here.length === 0) return {}
    const listed = await deps.ctx.mcp.list({ location: { directory } }).catch((error: unknown) => {
      log.warn("mcp_status_unavailable", { error })
      return undefined
    })
    if (listed === undefined) return undefined
    return Object.fromEntries(
      listed.data.flatMap((server) => {
        const own = here.find((item) => item.entry.name === server.name)
        const error = "error" in server.status ? server.status.error : undefined
        if (own?.values === undefined || error === undefined) return []
        return [[server.name, McpProbe.mask(error, secretsOf(own.entry.transport, own.values)).slice(0, 4_000)]]
      }),
    )
  }

  async function summary(): Promise<OwnMcp.Summary> {
    const read = await resolved()
    return {
      servers: read.servers.map((item) => {
        const from = McpStore.from(item.entry)
        return {
          name: item.entry.name,
          scope: item.entry.scope,
          ...(from ? { from } : {}),
          ...(item.values === undefined ? { missing: true } : {}),
        }
      }),
      overrides: read.file.overrides,
    }
  }

  function changed() {
    deps.runtime.broadcast.emit("mcp.changed", {})
    void deps.emitter.global("mcp.changed", {})
  }

  async function save(input: OwnMcp.SaveInput): Promise<Answer<OwnMcp.View>> {
    if (!absolute(input.scope)) return fail("mcp_invalid", "a project folder must be absolute", { field: "directory" })
    const file = await store.read()
    const existing = input.id === undefined ? undefined : file.servers.find((entry) => entry.id === input.id)
    if (input.id !== undefined && existing === undefined)
      return fail("mcp_not_found", "no such server", { id: input.id })
    if (taken(file.servers, input.name, input.scope, input.id))
      return fail("mcp_name_taken", "another server has this name there", { name: input.name })
    const stored = existing === undefined ? McpStore.NO_VALUES : await McpStore.values(deps, existing)
    if (stored === undefined) return fail("vault_unavailable", "the vault did not answer")
    const built = build(input.transport, existing, stored)
    if (!built.ok) return built
    const id = existing?.id ?? OwnMcp.ID.create()
    if (!(await McpStore.storeValues(deps, id, built.value.values)))
      return fail("vault_unavailable", "the vault did not answer")
    const at = now()
    const registry = existing?.registry ?? (existing === undefined ? input.registry : undefined)
    const entry: McpStore.Entry = {
      id,
      name: input.name,
      scope: input.scope,
      transport: built.value.transport,
      ...(existing?.origin ? { origin: existing.origin } : {}),
      ...(registry ? { registry } : {}),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }
    await store.update((current) => ({
      ...current,
      servers: [...current.servers.filter((item) => item.id !== id), entry],
      // A renamed (or moved) server keeps its switches where it still runs.
      overrides: existing ? follow(current, existing, entry) : current.overrides,
    }))
    log.info("mcp_saved", { id, name: input.name, type: entry.transport.type, scope: input.scope.type, new: !existing })
    changed()
    return { ok: true, value: await list() }
  }

  async function remove(id: OwnMcp.ID): Promise<Answer<OwnMcp.View>> {
    const file = await store.read()
    const entry = file.servers.find((item) => item.id === id)
    if (entry === undefined) return fail("mcp_not_found", "no such server", { id })
    if (McpStore.holds(entry)) {
      const removed = await deps.runtime.credentials.removeFeatureKey(McpStore.vaultID(id))
      if (!removed.ok) return fail("vault_unavailable", "the vault did not answer")
    }
    await store.update((current) => ({
      ...current,
      servers: current.servers.filter((item) => item.id !== id),
      // Its switches go too, so a later server of the same name starts on; another project's are not its own.
      overrides: follow(current, entry, undefined),
    }))
    log.info("mcp_removed", { id, name: entry.name })
    changed()
    return { ok: true, value: await list() }
  }

  /**
   * The list's switch (SG): in every project without `directory`, else in that folder; `null` deletes the switch at
   * exactly that place, so the folder inherits again. For own's server that reaches the place a value equal to what it
   * inherits (the global switch, then the folders that hold it, else on) deletes the switch instead of storing it, so
   * a later global switch is not held back by a stale `on`; a config file's names are stored as given (their own file
   * may turn them off).
   */
  async function enable(input: {
    readonly directory?: string
    readonly name: string
    readonly enabled: boolean | null
  }): Promise<Answer<OwnMcp.View>> {
    const directory = input.directory
    if (directory !== undefined && !path.isAbsolute(directory))
      return fail("mcp_invalid", "a project folder must be absolute", { field: "directory" })
    await store.update((current) => {
      const rest = current.overrides.filter(
        (item) => !(item.name === input.name && samePlace(item.directory, directory)),
      )
      const enabled = input.enabled
      if (enabled === null) return { ...current, overrides: rest }
      const own = current.servers.some(
        (entry) => entry.name === input.name && (directory === undefined || McpFold.applies(entry.scope, directory)),
      )
      const repeats = own && McpStore.inherited(rest, input.name, directory) === enabled
      const place = directory === undefined ? {} : { directory }
      return { ...current, overrides: repeats ? rest : [...rest, { ...place, name: input.name, enabled }] }
    })
    log.info("mcp_switched", { name: input.name, enabled: input.enabled, global: directory === undefined })
    changed()
    return { ok: true, value: await list() }
  }

  async function test(input: OwnMcp.TestInput): Promise<Answer<OwnMcp.Check>> {
    if (input.directory !== undefined && !path.isAbsolute(input.directory))
      return fail("mcp_invalid", "a project folder must be absolute", { field: "directory" })
    const file = await store.read()
    const entry = input.id === undefined ? undefined : file.servers.find((item) => item.id === input.id)
    if (input.id !== undefined && entry === undefined) return fail("mcp_not_found", "no such server", { id: input.id })
    if (entry === undefined && input.transport === undefined)
      return fail("mcp_invalid", "nothing to test", { field: "test" })
    const stored = entry === undefined ? McpStore.NO_VALUES : await McpStore.values(deps, entry)
    if (stored === undefined) return fail("vault_unavailable", "the vault did not answer")
    const resolved = input.transport
      ? build(input.transport, entry, stored)
      : { ok: true as const, value: { transport: entry!.transport, values: stored } }
    if (!resolved.ok) return resolved
    const directory =
      input.directory ?? (entry?.scope.type === "project" ? entry.scope.directory : undefined) ?? os.homedir()
    const transport = resolved.value.transport
    const values = resolved.value.values
    const target: McpProbe.Target =
      transport.type === "local"
        ? {
            type: "local",
            command: McpRules.expand(transport.command, values.env),
            args: transport.args.map((arg) => McpRules.expand(arg, values.env)),
            cwd: McpProbe.workingFolder(transport.cwd, directory),
            env: values.env,
          }
        : {
            type: "remote",
            url:
              (transport.hidden ? (values.url ?? transport.url) : transport.url) +
              (transport.query ? (values.search ?? "") : ""),
            headers: values.headers,
          }
    const check = await McpProbe.probe(target, { now, secrets: secretsOf(transport, values) })
    log.info("mcp_tested", {
      ...(entry ? { id: entry.id, name: entry.name } : {}),
      type: transport.type,
      ok: check.ok,
      tools: check.tools.length,
      ...(check.failure ? { failure: check.failure } : {}),
    })
    // A saved server's own test is kept for the list (`도구 N개`); a form's test is not.
    if (entry !== undefined && input.transport === undefined) {
      await store.update((current) => ({
        ...current,
        servers: current.servers.map((item) => (item.id === entry.id ? { ...item, check } : item)),
      }))
      changed()
    }
    return { ok: true, value: check }
  }

  async function scan(input: { readonly directory?: string }): Promise<OwnMcp.Scan> {
    const directory = input.directory !== undefined && path.isAbsolute(input.directory) ? input.directory : undefined
    const options = deps.options
    const read = await McpSources.read(
      {
        codexHome: options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        // The option (tests) alone; else the user's home and the service's CLAUDE_CONFIG_DIR (an own login folder).
        claudeHomes:
          options.claudeHome !== undefined
            ? [options.claudeHome]
            : [os.homedir(), ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : [])],
        ...(directory === undefined ? {} : { directory }),
      },
      process.env,
    )
    const file = await store.read()
    const names = new Set(file.servers.map((entry) => entry.name.toLowerCase()))
    // A hidden address is compared by its real value, which only the vault has.
    const owned = new Set(
      await Promise.all(
        file.servers.map(async (entry) =>
          McpStore.definition(
            entry.transport,
            entry.transport.type === "remote" && entry.transport.hidden
              ? await McpStore.values(deps, entry)
              : undefined,
          ),
        ),
      ),
    )
    const at = now()
    for (const [nonce, item] of scans) if (item.expiresAt <= at) scans.delete(nonce)
    const rows = merged(read.found)
    const candidates = rows.map((row, index): OwnMcp.Candidate => {
      const item = row.found
      const suggested = McpRules.suggestName(item.name, names)
      names.add(suggested.toLowerCase())
      const scope: OwnMcp.Scope =
        directory !== undefined && (item.source === "claude-project" || item.source === "project-file")
          ? { type: "project", directory }
          : { type: "global" }
      const enabled = item.enabled || row.also.some((other) => other.found.enabled)
      const stored = row.stored
      return {
        key: `c${index + 1}`,
        source: item.source,
        name: item.name,
        also: row.also.map((other) =>
          stored === undefined || McpStore.sameValues(stored.values, other.stored.values)
            ? { source: other.found.source, name: other.found.name }
            : { source: other.found.source, name: other.found.name, differs: true, values: valuesOf(other.stored) },
        ),
        suggested,
        scope,
        ...(stored ? { transport: McpStore.transportView(stored.transport, stored.values) } : {}),
        enabled,
        notes: enabled ? item.notes.filter((note) => note !== "disabled") : item.notes,
        ...(item.problem ? { problem: item.problem } : {}),
        imported: stored !== undefined && owned.has(McpStore.definition(stored.transport, stored.values)),
      }
    })
    const nonce = OwnID.Nonce.create()
    const expiresAt = at + OwnMcp.SCAN_TTL_MS
    scans.set(nonce, { expiresAt, rows })
    log.info("mcp_scanned", {
      files: read.files.filter((item) => item.state === "found").length,
      candidates: candidates.length,
      merged: read.found.length - rows.length,
    })
    return { nonce, expiresAt, files: read.files, candidates }
  }

  async function apply(input: {
    readonly nonce: string
    readonly picks: ReadonlyArray<OwnMcp.Pick>
  }): Promise<Answer<OwnMcp.Applied>> {
    const read = scans.get(input.nonce)
    if (read === undefined || read.expiresAt <= now()) return fail("nonce_invalid", "the scan expired")
    const picked = input.picks.flatMap((pick) => {
      const place = placeOf(read.rows[Number(pick.key.slice(1)) - 1], pick)
      return place === undefined ? [] : [{ pick, place }]
    })
    if (picked.length !== input.picks.length)
      return fail("mcp_invalid", "not a candidate of this scan", { field: "pick" })
    if (picked.some((item) => !absolute(item.pick.scope)))
      return fail("mcp_invalid", "a project folder must be absolute", { field: "directory" })
    const file = await store.read()
    const clash = picked.find(
      (item, index) =>
        taken(file.servers, item.pick.name, item.pick.scope, undefined) ||
        picked.slice(0, index).some((other) => overlaps(other.pick, item.pick)),
    )
    if (clash) return fail("mcp_name_taken", "another server has this name there", { name: clash.pick.name })
    // Out of the map while it is applied, so the same nonce cannot import twice; put back unless everything went in.
    scans.delete(input.nonce)
    const at = now()
    const entries = picked.map(
      (item): McpStore.Entry => ({
        id: OwnMcp.ID.create(),
        name: item.pick.name,
        scope: item.pick.scope,
        transport: item.place.stored.transport,
        origin: { source: item.place.found.source, name: item.place.found.name },
        createdAt: at,
        updatedAt: at,
      }),
    )
    // The values first, then the list: a vault that stops answering half way leaves no server without its values.
    const stored = await storeAll(
      entries.map((entry, index) => ({ id: entry.id, values: picked[index]!.place.stored.values })),
    )
    const written =
      stored &&
      (await store
        .update((current) => ({ ...current, servers: [...current.servers, ...entries] }))
        .then(
          () => true,
          (error: unknown) => {
            log.error("mcp_import_write_failed", { error })
            return false
          },
        ))
    if (!written) {
      await removeAll(entries.map((entry) => entry.id))
      if (read.expiresAt > now()) scans.set(input.nonce, read)
      return stored
        ? fail("internal_error", "the server list could not be written")
        : fail("vault_unavailable", "the vault did not answer")
    }
    log.info("mcp_imported", { servers: entries.length, names: entries.map((entry) => entry.name) })
    changed()
    return {
      ok: true,
      value: {
        imported: picked.map((item, index) => ({ key: item.pick.key, id: entries[index]!.id, name: item.pick.name })),
        view: await list(),
      },
    }
  }

  async function registry(input: OwnMcp.RegistrySearch): Promise<Answer<OwnMcp.RegistryPage>> {
    // A test service given other endpoints but no registry of its own never asks the real one.
    const overrides = deps.endpoints.overrides
    const base =
      overrides.mcpRegistry ?? (Object.keys(overrides).length === 0 ? deps.endpoints.url.mcpRegistry : undefined)
    if (base === undefined)
      return fail("mcp_registry_unavailable", "the MCP Registry is not asked here", { reason: "disabled" })
    const file = await store.read()
    const result = await McpRegistry.search({
      base,
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      taken: file.servers.map((entry) => entry.name),
    })
    log.info("mcp_registry_searched", {
      ok: result.ok,
      ...(result.ok ? { entries: result.value.entries.length } : { reason: result.error.reason }),
    })
    if (!result.ok) return fail("mcp_registry_unavailable", "the MCP Registry did not answer", result.error)
    return result
  }

  /** Stores every server's values; `false` when the vault refused any (the caller removes them all). */
  async function storeAll(items: ReadonlyArray<{ readonly id: string; readonly values: McpStore.Values }>) {
    const stored = await Promise.all(items.map((item) => McpStore.storeValues(deps, item.id, item.values)))
    return stored.every(Boolean)
  }

  /** Removes the vault items of servers that were not added after all; an item the vault keeps is logged by id. */
  async function removeAll(ids: ReadonlyArray<string>) {
    const results = await Promise.all(
      ids.map(async (id) => ({ id, ok: (await deps.runtime.credentials.removeFeatureKey(McpStore.vaultID(id))).ok })),
    )
    const left = results.filter((item) => !item.ok).map((item) => item.id)
    if (left.length > 0) log.warn("mcp_import_orphans", { ids: left })
  }

  return { list, summary, save, remove, enable, test, scan, apply, registry }
}

export type Service = ReturnType<typeof create>

/**
 * The kept switches after own's server `from` changed into `to` (renamed or moved) or went (`undefined`): only the
 * switches of `from`'s name in folders `from` reached are its own; they follow its new name where `to` still runs and
 * go elsewhere. Another project's switch of that name (a config file's server there) is left as it is. The global
 * switch of `from`'s name follows the new name, or goes with the server (SG); it stays for the old name too while
 * another of own's servers still has that name (in projects `from` never met).
 */
function follow(
  file: Pick<McpStore.File, "servers" | "overrides">,
  from: Pick<McpStore.Entry, "id" | "name" | "scope">,
  to: Pick<McpStore.Entry, "name" | "scope"> | undefined,
) {
  const shared = file.servers.some((entry) => entry.id !== from.id && entry.name === from.name)
  return file.overrides.flatMap((item) => {
    if (item.name !== from.name) return [item]
    const directory = item.directory
    if (directory === undefined) {
      const moved = to === undefined || to.name === from.name ? [] : [{ ...item, name: to.name }]
      return [...(shared || to?.name === from.name ? [item] : []), ...moved]
    }
    if (!McpFold.applies(from.scope, directory)) return [item]
    if (to === undefined || !McpFold.applies(to.scope, directory)) return []
    return [{ ...item, name: to.name }]
  })
}

/** Two switch places are one: both global, or the same folder. */
function samePlace(a: string | undefined, b: string | undefined) {
  if (a === undefined || b === undefined) return a === b
  return Location.same(a, b)
}

/** The place whose values a pick takes: the row's first (`place` 0 or left out) or one of `also`. */
function placeOf(row: Row | undefined, pick: OwnMcp.Pick) {
  if (row?.stored === undefined) return undefined
  const index = pick.place ?? 0
  return index === 0 ? { found: row.found, stored: row.stored } : row.also[index - 1]
}

/**
 * The stored values of a server that are secrets, to cut out of what it or core says ({@link McpProbe.mask}, SM-25):
 * the environment values its command or arguments name as `${NAME}` (every value moved out of them), environment and
 * header values under a secret-looking name (`GITHUB_TOKEN`, `Authorization`), and under any name a value that may hold
 * one (`McpSecrets.secretValue`: a key, every address such as `DATABASE_URL=postgres://user:pw@…` or a webhook, a
 * connection string with `Password=`; the masker hides only their secret parts, SM-26), and the address's `?` part
 * and hidden address. Other values (`REGION=us-east-1`, `Accept: application/json`, a folder) stay readable in what
 * the server says.
 */
export function secretsOf(transport: McpStore.Entry["transport"], values: McpStore.Values) {
  const named = new Set(
    transport.type === "local" ? [transport.command, ...transport.args].flatMap(McpRules.references) : [],
  )
  const secret = (entry: [string, string]) =>
    named.has(entry[0]) || McpSecrets.secretName(entry[0]) || McpSecrets.secretValue(entry[1])
  return [...Object.entries(values.env).filter(secret), ...Object.entries(values.headers).filter(secret)]
    .map((entry) => entry[1])
    .concat(values.search ? [values.search] : [], values.url ? [values.url] : [])
}

/** A place's values by name and hint, so two places can be told apart without showing a value. */
function valuesOf(stored: Stored) {
  const view = McpStore.transportView(stored.transport, stored.values)
  return view.type === "local" ? view.env : view.headers
}

/** The found servers as rows: the same definition found again joins the first row that has it. */
function merged(found: ReadonlyArray<McpSources.Found>): Row[] {
  return found.reduce<{ rows: Row[]; by: Map<string, Row> }>(
    (state, item) => {
      const stored = item.draft && !item.problem ? storedOf(item.draft) : undefined
      const definition = stored ? McpStore.definition(stored.transport, stored.values) : undefined
      const same = definition === undefined ? undefined : state.by.get(definition)
      if (same && stored) {
        same.also.push({ found: item, stored })
        return state
      }
      const row: Row = { found: item, also: [], ...(stored ? { stored } : {}) }
      state.rows.push(row)
      if (definition !== undefined) state.by.set(definition, row)
      return state
    },
    { rows: [], by: new Map() },
  ).rows
}

/** How own stores a found server: names in the file, values (the address too when it holds one) in the vault. */
function storedOf(draft: McpSources.Draft): Stored {
  if (draft.type === "local")
    return {
      transport: {
        type: "local",
        command: draft.command,
        args: [...draft.args],
        ...(draft.cwd === undefined ? {} : { cwd: draft.cwd }),
        env: Object.keys(draft.env),
      },
      values: { env: { ...draft.env }, headers: {} },
    }
  const address = McpSecrets.address(draft.url, draft.written)
  return {
    transport: {
      type: "remote",
      url: address.shown,
      query: address.search !== "",
      ...(address.hidden ? { hidden: true } : {}),
      headers: Object.keys(draft.headers),
      oauth: draft.oauth,
    },
    values: {
      env: {},
      headers: { ...draft.headers },
      ...(address.search ? { search: address.search } : {}),
      ...(address.hidden ? { url: address.base } : {}),
    },
  }
}

/**
 * The stored form and values of a form's transport; left-out values come from `stored`. Values in the arguments move
 * into the environment values and an address that holds one is hidden (`McpSecrets`), so a form never puts a value
 * into the file; every `${NAME}` must name an environment value.
 */
function build(
  input: OwnMcp.TransportInput,
  existing: McpStore.Entry | undefined,
  stored: McpStore.Values,
): Answer<Stored> {
  const missing = (name: string): Answer<never> => ({
    ok: false,
    error: { type: "mcp_secret_missing", message: "no stored value of this name", data: { name } },
  })
  const invalid = (field: "url" | "args", message: string): Answer<never> => ({
    ok: false,
    error: { type: "mcp_invalid", message, data: { field } },
  })
  const codemode = input.codemode === undefined ? {} : { codemode: input.codemode }
  if (input.type === "local") {
    const lost = input.env.find((item) => item.value === undefined && stored.env[item.name] === undefined)
    if (lost) return missing(lost.name)
    const env = Object.fromEntries(input.env.map((item) => [item.name, item.value ?? stored.env[item.name]!]))
    const lifted = McpSecrets.lift(input.command, input.args, env)
    const unknown = [lifted.command, ...lifted.args]
      .flatMap(McpRules.references)
      .find((name) => !Object.hasOwn(lifted.env, name))
    if (unknown !== undefined) return invalid("args", "a reference names no environment value")
    return {
      ok: true,
      value: {
        transport: {
          type: "local",
          command: lifted.command,
          args: [...lifted.args],
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          env: Object.keys(lifted.env),
          ...codemode,
        },
        values: { env: { ...lifted.env }, headers: {} },
      },
    }
  }
  const lost = input.headers.find((item) => item.value === undefined && stored.headers[item.name] === undefined)
  if (lost) return missing(lost.name)
  const previous =
    existing?.transport.type === "remote"
      ? {
          base: existing.transport.hidden ? stored.url : existing.transport.url,
          search: existing.transport.query ? (stored.search ?? "") : "",
          hidden: existing.transport.hidden === true,
          shown: existing.transport.url,
        }
      : undefined
  const address =
    input.url === undefined
      ? previous?.base === undefined
        ? undefined
        : { ...previous, base: previous.base }
      : McpSources.httpURL(input.url)
        ? McpSecrets.address(input.url)
        : undefined
  if (address === undefined) return invalid("url", "not an http(s) address")
  const headers = Object.fromEntries(input.headers.map((item) => [item.name, item.value ?? stored.headers[item.name]!]))
  return {
    ok: true,
    value: {
      transport: {
        type: "remote",
        url: address.shown,
        query: address.search !== "",
        ...(address.hidden ? { hidden: true } : {}),
        headers: Object.keys(headers),
        oauth: input.oauth,
        ...codemode,
      },
      values: {
        env: {},
        headers,
        ...(address.search ? { search: address.search } : {}),
        ...(address.hidden ? { url: address.base } : {}),
      },
    },
  }
}

function absolute(scope: OwnMcp.Scope) {
  return scope.type === "global" || path.isAbsolute(scope.directory)
}

/** Two scopes reach a common Location: either is global, or one folder is inside the other. */
function reach(a: OwnMcp.Scope, b: OwnMcp.Scope) {
  if (a.type === "global" || b.type === "global") return true
  return Location.within(a.directory, b.directory) || Location.within(b.directory, a.directory)
}

function overlaps(a: { readonly name: string; readonly scope: OwnMcp.Scope }, b: typeof a) {
  return a.name.toLowerCase() === b.name.toLowerCase() && reach(a.scope, b.scope)
}

/** Core keeps one server per name in a Location, so two of own's may share a name only where they never meet. */
function taken(servers: ReadonlyArray<McpStore.Entry>, name: string, scope: OwnMcp.Scope, id: string | undefined) {
  return servers.some((entry) => entry.id !== id && overlaps(entry, { name, scope }))
}
