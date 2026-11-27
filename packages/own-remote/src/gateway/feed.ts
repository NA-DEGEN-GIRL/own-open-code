export * as Feed from "./feed.js"

import fs from "node:fs/promises"
import path from "node:path"
import timers from "node:timers/promises"
import { Option, Schema } from "effect"
import { OwnID } from "@own/protocol"
import { OwnTeamRouting } from "@own/protocol/rpc-team-routing"
import { Fsx, ServiceTarget } from "@own/runtime"
import type { Log } from "../log.js"
import type { OwnRemote } from "../protocol/rpc-remote.js"
import type { Devices } from "./devices.js"
import type { GatewayServer } from "./server.js"

/**
 * The notification feed (05 §13.6, 03 §21.3): durable, per-device cursor, items without content (no model output,
 * prompt, path or secret; the session title only). The producer runs in the pinned gateway, not in a Location's
 * plugin instance: it subscribes to the local service's `/api/event` over loopback (the whole bus, every Location,
 * 05 §13.4 "고정과 깨우기" 3) with the registration's Basic credential, so items keep accumulating while no device (and
 * no desktop window) is connected. Devices read it with `feed.list` after a reconnect (MG6).
 *
 * Team decisions (06 §9.8, FeedKind `team.decision`): a confirm step waiting on the PC (`warn`) and a failed
 * integration (`danger`), from the local team and from every ready host's team. For a host the producer keeps one
 * narrow subscription to that server's `/api/event` through own-remote's tunnel (the endpoint and signed token of
 * `hosts()`, in process, 04 §12.7) and reads only `rpc.own.team.*` there (spec addition (3) of T3; 04 §12.3's remote
 * subscription is still off in this build, `events.state: "off"`): it reconnects with backoff and ends when the host
 * leaves `ready`. Other remote sessions' items stay with that subscription; host disconnections are recorded from
 * `rpc.own.remote.host.state`.
 */

export const MAX_ITEMS = 10_000
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** How often the ready hosts are checked besides `host.state` events (the local stream may be down). */
const HOSTS_MS = 10_000

export interface Input {
  readonly ownHome: string
  readonly log: Log.Logger
  readonly service: ServiceTarget.Source
  /** The local server's control location (`OWN_HOME\control`), where `own.team` answers (06 §2.7). */
  readonly controlDir: string
  readonly devices: Devices.Store
  readonly hosts: () => GatewayServer.HostAccess | undefined
  readonly emit: (item: OwnRemote.FeedItem) => void
  readonly now?: () => number
}

/** A server whose events the producer reads: `local` or a ready host (its key is the items' `serverKey`). */
interface Server {
  readonly key: string
  readonly url: string
  readonly authorization: string
  readonly controlDir: string
}

interface SessionInfo {
  title?: string
  parentID?: string
  directory?: string
}

export class Producer {
  readonly dir: string
  readonly #input: Input
  readonly #now: () => number
  #items: OwnRemote.FeedItem[] = []
  #loaded: Promise<void> | undefined
  /** Aborted by `stop()`: ends the local subscription and its backoff (a later `start()` begins a new one). */
  #life: AbortController | undefined
  #watch: ReturnType<typeof setInterval> | undefined
  /** hostId → the team subscription of a ready host. */
  readonly #remote = new Map<string, AbortController>()
  readonly #sessions = new Map<string, SessionInfo>()
  /** hostId → last stage seen, to record a ready → not-ready change once. */
  readonly #hostStages = new Map<string, string>()
  /** Same kind of the same session within 10 s merges (03 §9 병합 규칙). */
  readonly #recent = new Map<string, number>()
  #write: Promise<void> = Promise.resolve()

  constructor(input: Input) {
    this.#input = input
    this.#now = input.now ?? Date.now
    this.dir = path.join(input.ownHome, "feed")
  }

  load() {
    this.#loaded ??= (async () => {
      const files = (await fs.readdir(this.dir).catch(() => [] as string[]))
        .filter((name) => /^feed-\d{4}-\d{2}\.jsonl$/.test(name))
        .sort()
        .slice(-2)
      const items: OwnRemote.FeedItem[] = []
      for (const name of files) {
        const text = (await Fsx.readText(path.join(this.dir, name)).catch(() => undefined)) ?? ""
        for (const line of text.split("\n")) {
          if (!line.trim()) continue
          try {
            const item = JSON.parse(line) as OwnRemote.FeedItem
            if (typeof item.id === "string" && typeof item.at === "number") items.push(item)
          } catch {
            // a torn last line after a crash
          }
        }
      }
      const since = this.#now() - KEEP_MS
      this.#items = items.filter((item) => item.at >= since).sort(byId).slice(-MAX_ITEMS)
    })()
    return this.#loaded
  }

  /** Items after `after` (exclusive), oldest first, and the device's acknowledged cursor. */
  async list(input: { readonly after?: string; readonly limit?: number; readonly deviceId?: string }) {
    await this.load()
    const device = input.deviceId ? this.#input.devices.get(input.deviceId) : undefined
    const after = input.after ?? device?.feedCursor ?? undefined
    const limit = input.limit ?? 50
    const items = (after ? this.#items.filter((item) => item.id > after) : this.#items).slice(0, limit)
    const servers = device?.servers
    return {
      items: servers && servers.mode === "only" ? items.filter((item) => servers.keys.includes(item.serverKey)) : items,
      ack: device?.feedCursor ?? null,
    }
  }

  async ack(deviceId: string, upTo: string) {
    const device = this.#input.devices.get(deviceId)
    if (!device) return false
    if (device.feedCursor && device.feedCursor >= upTo) return true
    await this.#input.devices.update(deviceId, { feedCursor: upTo })
    return true
  }

  items() {
    return [...this.#items]
  }

  start() {
    if (this.#life) return
    const life = new AbortController()
    this.#life = life
    void this.load().then(() => {
      if (life.signal.aborted) return
      this.#syncHosts()
      this.#watch = setInterval(() => this.#syncHosts(), HOSTS_MS)
      this.#watch.unref?.()
      return this.#loop(life.signal)
    })
  }

  async stop() {
    this.#life?.abort()
    this.#life = undefined
    if (this.#watch) clearInterval(this.#watch)
    this.#watch = undefined
    for (const follow of this.#remote.values()) follow.abort()
    this.#remote.clear()
    await this.#write.catch(() => undefined)
  }

  async #loop(signal: AbortSignal) {
    let delay = 1000
    while (!signal.aborted) {
      const target = await this.#input.service.current().catch(() => undefined)
      if (target) {
        const local = { key: "local", ...target, controlDir: this.#input.controlDir }
        const status = await this.#subscribe(local, signal).catch(() => 0)
        if (status === 401) this.#input.service.invalidate()
        if (status === 200) delay = 1000
      }
      await timers.setTimeout(delay, undefined, { signal, ref: false }).catch(() => undefined)
      delay = Math.min(delay * 2, 30_000)
    }
  }

  /** One team subscription per ready host; one whose host left `ready` (or the list) is ended. */
  #syncHosts() {
    if (!this.#life) return
    const ready = new Set(
      (this.#input.hosts()?.list() ?? []).filter((host) => host.stage === "ready").map((host) => host.id),
    )
    for (const [hostId, follow] of this.#remote) {
      if (ready.has(hostId)) continue
      follow.abort()
      this.#remote.delete(hostId)
    }
    for (const hostId of ready) {
      if (this.#remote.has(hostId)) continue
      const follow = new AbortController()
      this.#remote.set(hostId, follow)
      void this.#follow(hostId, follow)
    }
  }

  async #follow(hostId: string, follow: AbortController) {
    let delay = 1000
    while (!follow.signal.aborted) {
      // Only while ready: resolving a host in another stage would start a connection (the feed never connects one).
      const hosts = this.#input.hosts()
      if (!hosts || hosts.list().find((host) => host.id === hostId)?.stage !== "ready") break
      const endpoint = await hosts.endpoint(hostId).catch(() => null)
      if (endpoint) {
        const server = {
          key: hostId,
          url: endpoint.url,
          authorization: ServiceTarget.basic(endpoint.token),
          controlDir: endpoint.controlDir,
        }
        const status = await this.#subscribe(server, follow.signal).catch(() => 0)
        if (status === 200) delay = 1000
      }
      await timers.setTimeout(delay, undefined, { signal: follow.signal, ref: false }).catch(() => undefined)
      delay = Math.min(delay * 2, 30_000)
    }
    if (this.#remote.get(hostId) === follow) this.#remote.delete(hostId)
  }

  /** Reads a server's `/api/event` until it ends; the response status (200 once it was open). */
  async #subscribe(server: Server, signal: AbortSignal) {
    const response = await fetch(`${server.url}/api/event`, {
      headers: { authorization: server.authorization, accept: "text/event-stream" },
      signal,
    })
    if (!response.ok || !response.body) return response.status
    const decoder = new TextDecoder()
    let pending = ""
    const reader = response.body.getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        pending += decoder.decode(next.value, { stream: true })
        for (;;) {
          const index = pending.indexOf("\n\n")
          if (index < 0) break
          const frame = pending.slice(0, index)
          pending = pending.slice(index + 2)
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(line.charAt(5) === " " ? 6 : 5))
            .join("\n")
          if (data) this.#event(data, server)
        }
        if (pending.length > 4 * 1024 * 1024) pending = ""
      }
    } finally {
      reader.releaseLock()
    }
    return response.status
  }

  #event(text: string, server: Server) {
    // A host's stream also carries every session's streaming text: only own.team events are parsed there (04 §12.3).
    const local = server.key === "local"
    if (!local && !text.includes(`"rpc.${OwnTeamRouting.ID}.`)) return
    let event: { type?: unknown; data?: Record<string, unknown> }
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    const type = typeof event.type === "string" ? event.type : ""
    if (!local && !type.startsWith(`rpc.${OwnTeamRouting.ID}.`)) return
    const data = event.data ?? {}
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    switch (type) {
      case "session.created":
      case "session.renamed": {
        if (!sessionID) return
        const info = this.#sessions.get(sessionID) ?? {}
        if (typeof data.title === "string") info.title = data.title
        if (typeof data.parentID === "string") info.parentID = data.parentID
        this.#sessions.set(sessionID, info)
        if (this.#sessions.size > 5000) this.#sessions.delete(this.#sessions.keys().next().value!)
        return
      }
      case "session.execution.succeeded":
        if (sessionID) void this.#sessionItem("turn.completed", "info", sessionID, server)
        return
      case "permission.asked":
        if (sessionID) void this.#sessionItem("permission.asked", "warn", sessionID, server)
        return
      case "question.asked":
      case "form.created":
        if (sessionID) void this.#sessionItem("question.asked", "warn", sessionID, server)
        return
      case "rpc.own.accounts.account.status": {
        const status = data.status
        if (status === "needs_reauth" || status === "auth_failed") this.#add({ kind: "auth.expired", severity: "danger", serverKey: "local" })
        else if (status === "exhausted") this.#add({ kind: "quota.exhausted", severity: "warn", serverKey: "local" })
        else if (status === "ready" && data.reason === "reset") this.#add({ kind: "quota.reset", severity: "info", serverKey: "local" })
        return
      }
      case "rpc.own.accounts.alert": {
        const code = data.code
        const session = typeof data.sessionID === "string" ? { sessionID: data.sessionID } : {}
        if (code === "codex_source_stale") this.#add({ kind: "auth.expired", severity: "danger", serverKey: "local", ...session })
        else if (code === "claude_slot_billing" || code === "claude_extra_usage")
          this.#add({ kind: "claude_slot_billing", severity: "danger", serverKey: "local", ...session })
        return
      }
      case "rpc.own.accounts.switch.suggested":
        if (typeof data.sessionID === "string") void this.#sessionItem("switch.suggested", "info", data.sessionID, server)
        return
      case "rpc.own.remote.host.state": {
        const hostId = typeof data.hostId === "string" ? data.hostId : undefined
        const stage = typeof data.stage === "string" ? data.stage : undefined
        if (!hostId || !stage) return
        const previous = this.#hostStages.get(hostId)
        this.#hostStages.set(hostId, stage)
        if (previous === "ready" && (stage === "disconnected" || stage === "failed"))
          this.#add({ kind: "host.disconnected", severity: "warn", serverKey: hostId })
        this.#syncHosts()
        return
      }
      case "rpc.own.team.op.confirm":
        this.#teamDecision(server, data.teamID, "warn")
        return
      case "rpc.own.team.integration.changed":
        if (data.state === "failed") this.#teamDecision(server, data.teamID, "danger")
        return
    }
  }

  async #sessionItem(
    kind: OwnRemote.FeedKind,
    severity: OwnRemote.FeedItem["severity"],
    sessionID: string,
    server: Server,
  ) {
    const info = this.#sessions.get(sessionID) ?? (await this.#lookup(sessionID, server))
    // Subagent sessions: their parent's turn is the one that matters (03 §9).
    if (info?.parentID) return
    this.#add({
      kind,
      severity,
      serverKey: server.key,
      sessionID,
      ...(info?.title ? { title: info.title.slice(0, 120) } : {}),
    })
  }

  /**
   * A team waits for a decision on the PC or an integration failed (06 §9.8). The item points at the team's main
   * conversation, whose card shows it, with that conversation's title; the step's own text names files and folders
   * and never enters the feed. Decisions of one team merge like a session's items.
   */
  #teamDecision(server: Server, teamID: unknown, severity: "warn" | "danger") {
    if (typeof teamID !== "string") return
    if (this.#merged(`team.decision|${server.key}|${teamID}|${severity}`)) return
    void this.#teamMain(server, teamID).then((main) =>
      this.#record({ kind: "team.decision", severity, serverKey: server.key, ...main }),
    )
  }

  /** The main conversation of a team (`team.list` for its folder, then `team.get`) and its title; `{}` if unknown. */
  async #teamMain(server: Server, teamID: string): Promise<{ sessionID?: string; title?: string }> {
    const listed = Option.getOrUndefined(decodeList(await this.#team(server, "team.list", {})))
    const home = listed?.output.teams.find((team) => team.id === teamID)?.home
    if (home === undefined) return {}
    const got = Option.getOrUndefined(decodeGet(await this.#team(server, "team.get", { directory: home })))
    const sessionID = got?.output.team.main.sessionID
    if (sessionID === undefined) return {}
    const info = this.#sessions.get(sessionID) ?? (await this.#lookup(sessionID, server))
    return { sessionID, ...(info?.title ? { title: info.title.slice(0, 120) } : {}) }
  }

  /** An `own.team` read at the server's control location (06 §2.7); its JSON body, or `undefined`. */
  async #team(server: Server, method: "team.list" | "team.get", input: unknown): Promise<unknown> {
    const url = new URL(`${server.url}/api/rpc/${OwnTeamRouting.ID}/${method}`)
    url.searchParams.set("location[directory]", server.controlDir)
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: server.authorization, "content-type": "application/json" },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
    if (!response?.ok) return undefined
    return response.json().catch(() => undefined)
  }

  async #lookup(sessionID: string, server: Server): Promise<SessionInfo | undefined> {
    const response = await fetch(`${server.url}/api/session/${encodeURIComponent(sessionID)}`, {
      headers: { authorization: server.authorization },
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
    if (!response?.ok) return undefined
    const body = (await response.json().catch(() => undefined)) as { data?: { title?: unknown; parentID?: unknown } } | undefined
    const info: SessionInfo = {
      ...(typeof body?.data?.title === "string" ? { title: body.data.title } : {}),
      ...(typeof body?.data?.parentID === "string" ? { parentID: body.data.parentID } : {}),
    }
    this.#sessions.set(sessionID, info)
    return info
  }

  #add(input: Omit<OwnRemote.FeedItem, "id" | "at">) {
    if (this.#merged(`${input.kind}|${input.serverKey}|${input.sessionID ?? ""}`)) return
    this.#record(input)
  }

  /** Whether an item of `key` came within the last 10 s; either way `key` was seen now. */
  #merged(key: string) {
    const now = this.#now()
    const last = this.#recent.get(key)
    this.#recent.set(key, now)
    if (this.#recent.size > 1000) this.#recent.delete(this.#recent.keys().next().value!)
    return last !== undefined && now - last < 10_000
  }

  #record(input: Omit<OwnRemote.FeedItem, "id" | "at">) {
    const now = this.#now()
    const item: OwnRemote.FeedItem = { id: OwnID.ulid(now), at: now, ...input }
    this.#items.push(item)
    if (this.#items.length > MAX_ITEMS) this.#items.splice(0, this.#items.length - MAX_ITEMS)
    const file = path.join(this.dir, `feed-${new Date(now).toISOString().slice(0, 7)}.jsonl`)
    this.#write = this.#write
      .then(async () => {
        await fs.mkdir(this.dir, { recursive: true })
        await fs.appendFile(file, JSON.stringify(item) + "\n", { mode: 0o600 })
      })
      .catch((error: unknown) => this.#input.log.warn("feed_write_failed", { error: error instanceof Error ? error.name : "error" }))
    this.#input.emit(item)
  }
}

function byId(a: OwnRemote.FeedItem, b: OwnRemote.FeedItem) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The parts of `team.list` and `team.get` the feed reads (06 §9.8: a team's home, its main conversation), decoded once
 * where the answer arrives; anything else is no team.
 */
const decodeList = Schema.decodeUnknownOption(
  Schema.Struct({
    output: Schema.Struct({ teams: Schema.Array(Schema.Struct({ id: Schema.String, home: Schema.String })) }),
  }),
)
const decodeGet = Schema.decodeUnknownOption(
  Schema.Struct({
    output: Schema.Struct({ team: Schema.Struct({ main: Schema.Struct({ sessionID: Schema.String }) }) }),
  }),
)
