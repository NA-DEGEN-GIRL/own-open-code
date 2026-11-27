// One server's runtime (03 §16.3, 04 §12.1): event bus, SWR session index, session-ui data (createData), typed
// own.accounts client and OwnStore exist from the start, so the cached session list paints before the host has
// even resolved the server (05 T0-2 before T0-1). `attach(entry)` then opens the client and the single event
// stream; attaching again (SSH endpoint epoch, desktop service restart) replaces them without touching the stores.
// The TeamStore (own.team, 06 §9), the own.import client (09 §5) and the own.harness client (10 §3.8) exist from the
// start too but ask nothing until a screen needs them.
import { OpenCode, type LocationRef, type OpenCodeClient } from "@opencode/client"
// The modules themselves, not `@opencode/client/solid`: that index also re-exports the persistent PTY client, whose
// schema pulls core's session and event schemas into the first chunk (PF5, upstream v2.2.5; vendored.yaml deep-import).
import { createClientConnection } from "../../../client/src/solid/connection"
import { createData, locationKey, type Data } from "../../../client/src/solid/data"
import { createRoot, createSignal, getOwner, onCleanup } from "solid-js"
import type { HostConnection } from "@/host"
import { createTeamStore } from "@/team/store"
import { createEventBus } from "./events"
import { createHarnessRpc } from "./harness-rpc"
import { createImportRpc, importOrigin } from "./import-rpc"
import { createOwnStore, type OwnStore } from "./own-store"
import { ALL_SCOPES, createOwnRpc, OwnRpcError, type OwnScope } from "./rpc"
import type { SessionListCache } from "./session-cache"
import { createSessionIndex, type IndexSource } from "./session-index"
import type { ServerEntry, ServerKey } from "./servers"
import { createTeamRpc } from "./team-rpc"

/** 03 §16.4: 30 messages on first open locally, 10 for SSH servers (04 §12.5). */
const INITIAL_MESSAGES = { local: 30, ssh: 10 } as const
/** How long the control fallback waits for the first project list (02 §9.1). */
const CONTROL_WAIT_MS = 10_000

type Connection = ReturnType<typeof createClientConnection>

export class NotConnectedError extends Error {
  override readonly name = "NotConnectedError"
}

export function createServerRuntime(input: {
  readonly key: ServerKey
  readonly kind: ServerEntry["kind"]
  readonly cache: SessionListCache
  readonly onRows?: (source: Exclude<IndexSource, "empty">) => void
  /** SSH servers: the store accounts and limits come from (this PC's, 04 §12.6). */
  readonly registry?: () => OwnStore | undefined
}) {
  const owner = getOwner()
  const bus = createEventBus()
  onCleanup(() => bus.dispose())
  const [entry, setEntry] = createSignal<ServerEntry>()
  const [live, setLive] = createSignal<{ client: OpenCodeClient; connection: Connection; dispose: () => void }>()
  onCleanup(() => live()?.dispose())

  const client = () => {
    const current = live()
    if (!current) throw new NotConnectedError(`server ${input.key} is not connected yet`)
    return current.client
  }
  const connection = {
    status: () => live()?.connection.status() ?? "connecting",
    attempt: () => live()?.connection.attempt() ?? 0,
    error: () => live()?.connection.error(),
  }

  const sessions = createSessionIndex({
    serverKey: input.key,
    client,
    bus,
    cache: input.cache,
    onRows: input.onRows,
  })
  onCleanup(() => sessions.dispose())

  const data = createData({
    api: client,
    directory: "",
    initialMessageLimit: () => INITIAL_MESSAGES[input.kind],
    // Tool screenshots are never shown in the transcript, and in a long computer-use session they are nearly every
    // byte of it: live events keep none either (an image card reads its message on its own).
    omitToolFileData: true,
    event: {
      on: bus.on,
      listen: (handler) => bus.listen((event) => handler({ name: event.type, details: event })),
    },
    connection,
  })
  // An imported conversation (09 §4.7) comes whole in its `session.created` commit, while createData takes every new
  // session's transcript as empty and complete (its band-aid for live sessions), so its first view would show no
  // message until a reload. Its messages are read on first view instead. A `listen` handler: it runs after
  // createData's own (also `listen`, registered first), which `bus.on` handlers precede.
  bus.listen((event) => {
    if (event.type === "session.created" && importOrigin(event.data.metadata))
      data.session.message.invalidate(event.data.sessionID)
  })
  // A context reset (03 §18.18, core P-035) brings no message event: its marker comes, and its undo changes it, with
  // the next read of the transcript. `bus.on` runs before createData's handler, so the delivered item is still pending.
  // An item this window never saw admitted (a reconnect or a restart in between) may be a reset too: the read finds its
  // projected marker.
  const reread = (sessionID: string) => {
    data.session.message.invalidate(sessionID)
    if (data.session.message.list(sessionID).length) void data.session.message.sync(sessionID).catch(() => undefined)
  }
  // A reset settles every compaction still pending at its delivery as not needed (cancelled right after): the reset
  // chunk says why its chip went, naming the session, since any session this window tracks may be the one.
  bus.on("session.inbox.delivered", (event) => {
    const pending = data.session.pending.list(event.data.sessionID)
    const at = pending.findIndex((entry) => entry.id === event.data.inboxID)
    if (at < 0 || pending[at]!.type === "reset") reread(event.data.sessionID)
    if (pending[at]?.type === "reset" && pending.some((entry) => entry.type === "compaction"))
      void import("@/context-reset").then((reset) =>
        reset.compactionSettled(data.session.get(event.data.sessionID)?.title),
      )
  })
  bus.on("session.reset.undone", (event) => reread(event.data.sessionID))
  // A reset cancelled while it waited, by any client: what the composer queued only because of it steers now.
  bus.on("session.inbox.cancelled", (event) => {
    const pending = data.session.pending.list(event.data.sessionID)
    const at = pending.findIndex((entry) => entry.id === event.data.inboxID)
    if (pending[at]?.type === "reset")
      void import("@/context-reset").then((reset) => reset.released(client, event.data.sessionID, pending.slice(at)))
  })

  const sessionDirectory = (sessionID: string) =>
    data.session.get(sessionID)?.location.directory ?? sessions.directory(sessionID)
  const rpc = createOwnRpc({
    client,
    routing: { control: () => control(), sessionDirectory },
    scopes: () => scopesOf(entry()),
  })
  const control = controlResolver(
    () => entry()?.controlDir,
    sessions,
    (directory) => rpc.call("health", {}, { directory }),
  )
  const own = createOwnStore({ rpc, bus, client, sessionDirectory, registry: input.registry })
  onCleanup(() => own.dispose())
  onCleanup(staleSkillsOnSwitch(data, own))
  // own.team of this server (06 §2.7): every call at its control location, scopes of this connection.
  const team = createTeamStore({
    rpc: createTeamRpc({ client, control: () => control(), scopes: () => scopesOf(entry()) }),
    bus,
    session: (sessionID) => data.session.get(sessionID),
    connected: () => connection.status() === "connected",
  })
  onCleanup(() => team.dispose())
  // own.import of this server (09 §5): every call at its control location, scopes of this connection. Making it only
  // builds closures; the import screens and the sidebar's `새 N개` row (both after the first paint, 09 §6) ask through
  // it. v1 runs own.import on this PC only, so an SSH server answers its `health` with an RPC error and the screens
  // leave the entries out.
  const imports = createImportRpc({ client, control: () => control(), scopes: () => scopesOf(entry()) })
  // own.harness of this server (10 §3.8, §6.1): this PC and remote installs carry it, so the harness pill works on every
  // server, through the phone gateway too, with the scopes of this connection.
  const harness = createHarnessRpc({ client, control: () => control(), scopes: () => scopesOf(entry()) })

  return {
    key: input.key,
    kind: input.kind,
    entry,
    client,
    bus,
    connection,
    data,
    sessions,
    rpc,
    own,
    /** own.team registry of this server (06 §9) with its typed client at `team.rpc`; screens call `team.ensure()`. */
    team,
    /** Typed own.import client of this server (09 §5). */
    imports,
    /** Typed own.harness client of this server (10 §3.8); screens use src/harness. */
    harness,
    /** Control location of this server (02 §9.1; SSH servers: `resolve`'s `controlDir` only, 04 §16.6). */
    control,
    /** Opens (or replaces) the client and the event stream for this server. */
    attach(next: ServerEntry, reconnect?: () => Promise<HostConnection>) {
      live()?.dispose()
      setEntry(next)
      const made = createRoot((dispose) => {
        const state = { client: make(next, next.baseUrl) }
        const stream = createClientConnection(state.client, {
          onEvent: (event) => bus.publish(event),
          flushInterval: 16,
          pageLifecycle: true,
          reconnect: reconnect
            ? async (signal) => {
                const resolved = await reconnect()
                if (signal.aborted || resolved.baseUrl === next.baseUrl) return state.client
                state.client = make(next, resolved.baseUrl)
                return state.client
              }
            : undefined,
        })
        return { client: state.client, connection: stream, dispose, state }
      }, owner)
      setLive({
        get client() {
          return made.state.client
        },
        connection: made.connection,
        dispose: made.dispose,
      })
    },
  }
}

export type ServerRuntime = ReturnType<typeof createServerRuntime>

/**
 * A skill switch (SG-18) folds every open Location's skills again, but core announces that reload without a Location
 * (`skill.updated` with none, which createData drops, SG-5). own.accounts' `skillset.changed` reaches every window and
 * phone through its own event stream, so it marks every skill list this runtime has read as stale: the next `@` or
 * `/` list, ✦ popover or settings page reads it again. A list on screen is read again by its own listener. createData
 * does not say which Locations it holds, so the lists read are remembered as they are synced.
 */
export function staleSkillsOnSwitch(data: Pick<Data, "location">, own: Pick<OwnStore, "on">) {
  const skill = data.location.skill
  const read = new Map<string, LocationRef>()
  data.location.skill = {
    ...skill,
    sync(ref) {
      if (ref) read.set(locationKey(ref), ref)
      return skill.sync(ref)
    },
  }
  return own.on("skillset.changed", () => read.forEach((ref) => skill.invalidate(ref)))
}

function make(entry: ServerEntry, baseUrl: string) {
  const made = OpenCode.make({ baseUrl, headers: entry.headers?.() })
  // Transcript pages come without tool results' file bytes (core P-055); a server without it sends them whole and the
  // store drops them (`omitToolFileData`). Asked in the query, not a header: a custom header makes every page a
  // preflighted request (one more round trip per cursor, which the preflight cache keys by URL).
  const pages = OpenCode.make({
    baseUrl,
    headers: entry.headers?.(),
    fetch: Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        const next = new URL(String(url))
        next.searchParams.set("own-capabilities", "own-omit-tool-file-data")
        return fetch(next, init)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const client = { ...made, message: pages.message }
  return entry.kind === "ssh" ? remoteClient(client) : client
}

/**
 * 04 §12.5: calls that read a session's whole history at once never go to an SSH server (tens of MB over a slow
 * link); the remote client does not offer them.
 */
function remoteClient(client: OpenCodeClient): OpenCodeClient {
  return {
    ...client,
    session: {
      ...client.session,
      export: () => Promise.reject(new RemoteHistoryError("session.export is not sent to a remote server (04 §12.5)")),
    },
  }
}

export class RemoteHistoryError extends Error {
  override readonly name = "RemoteHistoryError"
}

/** PC windows hold every scope; a gateway device holds what the gateway granted, never `local` (02 §9.1). */
function scopesOf(entry: ServerEntry | undefined): ReadonlySet<OwnScope> {
  if (!entry || entry.auth !== "device") return ALL_SCOPES
  return new Set((entry.scopes ?? ["read"]).filter((scope) => scope !== "local"))
}

/**
 * Control location (02 §9.1): the host's `controlDir`, else `health` on a project location the UI already knows.
 * Never an arbitrary directory: that would create a heavy Location (G15).
 */
function controlResolver(
  given: () => string | undefined,
  sessions: { readonly fresh: Promise<void>; directories(): string[] },
  health: (directory: string) => Promise<{ readonly controlDir?: string | null }>,
) {
  let resolved: Promise<string> | undefined
  return () => {
    const direct = given()
    if (direct) return Promise.resolve(direct)
    resolved ??= (async () => {
      if (!sessions.directories().length)
        await Promise.race([sessions.fresh, new Promise((resolve) => setTimeout(resolve, CONTROL_WAIT_MS))])
      const known = sessions.directories()[0]
      if (!known) throw new OwnRpcError("own.control_unknown", "No control location yet: open a project first")
      const result = await health(known)
      if (!result.controlDir) throw new OwnRpcError("own.control_unknown", "health did not report controlDir")
      return result.controlDir
    })().catch((error: unknown) => {
      resolved = undefined
      throw error
    })
    return resolved
  }
}
