export * as CreatorBridge from "./creator-bridge.js"

import type { Broker } from "@own/protocol"
import type { Creator } from "@own/protocol/creator"

/**
 * own.creator's extensions on SSH hosts (17 §10, 04 §9.3) between the plugins of one process. Plugin modules are imported
 * again per Location and per plugin bundle, so every role lives on `globalThis` (as {@link GitHubBridge} does); the
 * newest provider answers.
 *
 * - On this PC, own.creator provides the {@link Source}: the read-only view of its store each host may have and the
 *   bytes of the versions that view names. own-accounts' broker answers a host's `creator.get` and `creator.file` from
 *   it and tells the hosts when it changed (`creator.changed`). A host's `creator.report` lands in {@link report}: this
 *   process's memory, never the store.
 * - The broker publishes the {@link Hosts} it serves, so Settings can list them.
 * - On a host, own-accounts' remote broker client provides the {@link Link} (its requests to the PC and the moments to
 *   ask again); own.creator's mirror reads through it. Nothing on this bridge writes the PC's store.
 */

export interface Source {
  /** The extensions that reach `hostId`, as the host may have them. */
  readonly view: (hostId: string) => Promise<Creator.MirrorView>
  /** One chunk of a file of a version `hostId`'s view names now; `undefined` refuses (not in its view, not a file). */
  readonly file: (hostId: string, request: Broker.CreatorFile) => Promise<Broker.CreatorChunk | undefined>
}

export interface Hosts {
  /** The hosts the broker serves now and whether each has a session. */
  readonly list: () => ReadonlyArray<{ readonly id: string; readonly connected: boolean }>
}

export interface Reply {
  readonly ok: boolean
  readonly result?: unknown
  /** The broker's refusal (`skew_drain`: the PC runs another build and answers no `creator.*`). */
  readonly error?: string
}

export interface Link {
  /** One request to the PC's broker; `ok: false` when there is no normal-mode session or the PC refused. */
  readonly request: (method: "creator.get" | "creator.file" | "creator.report", params: unknown, timeoutMs: number) => Promise<Reply>
  /** Called when a normal-mode session came up and when the PC says its extensions changed. Returns the unsubscribe. */
  readonly on: (listener: () => void) => () => void
}

interface Holder {
  sources: Source[]
  hosts: Hosts[]
  links: Link[]
  sourceListeners: Set<() => void>
  linkListeners: Set<() => void>
  reportListeners: Set<() => void>
  reports: Map<string, Creator.HostReport>
  timer: ReturnType<typeof setTimeout> | undefined
  reportTimer: ReturnType<typeof setTimeout> | undefined
}

const KEY = Symbol.for("own-open-code.creator-bridge")

function holder(): Holder {
  // The process-wide state lives on globalThis by design, like the runtime singleton (01 §4).
  const root = globalThis as unknown as Record<symbol, Holder | undefined>
  const existing = root[KEY]
  if (existing) return existing
  const created: Holder = {
    sources: [],
    hosts: [],
    links: [],
    sourceListeners: new Set(),
    linkListeners: new Set(),
    reportListeners: new Set(),
    reports: new Map(),
    timer: undefined,
    reportTimer: undefined,
  }
  root[KEY] = created
  return created
}

function stack<T>(list: T[], item: T) {
  list.push(item)
  return () => {
    const index = list.lastIndexOf(item)
    if (index >= 0) list.splice(index, 1)
  }
}

function fire(listeners: ReadonlySet<() => void>) {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A listener's failure is its own; the others still hear.
    }
  }
}

// ---- this PC ----

/** Makes `source` the one the broker asks; the result takes it back. */
export function provideSource(source: Source) {
  const undo = stack(holder().sources, source)
  changed()
  return () => {
    undo()
    changed()
  }
}

export function source(): Source | undefined {
  return holder().sources.at(-1)
}

/** The store changed: the broker tells every host (coalesced: every Location's instance reloads on one write). */
export function changed() {
  const state = holder()
  if (state.timer !== undefined) return
  state.timer = setTimeout(() => {
    state.timer = undefined
    fire(state.sourceListeners)
  }, 100)
  state.timer.unref?.()
}

/** The broker's subscription to {@link changed}. */
export function onChanged(listener: () => void) {
  const set = holder().sourceListeners
  set.add(listener)
  return () => void set.delete(listener)
}

export function provideHosts(hosts: Hosts) {
  return stack(holder().hosts, hosts)
}

export function hosts(): ReadonlyArray<{ readonly id: string; readonly connected: boolean }> {
  return holder().hosts.at(-1)?.list() ?? []
}

/**
 * A host's report of its mirror (`creator.report`): kept in memory, the newest per host. Listeners hear only a report
 * that says something new, at most once per {@link REPORT_COALESCE_MS}: every Location's instance and every open
 * Settings window reads the store again on a report, so a host sending reports in a loop must not drive that (17 §10).
 */
export function report(hostId: string, value: Creator.HostReport) {
  const state = holder()
  const before = state.reports.get(hostId)
  state.reports.set(hostId, value)
  if (before !== undefined && before.revision === value.revision && same(before.extensions, value.extensions)) return
  if (state.reportTimer !== undefined) return
  state.reportTimer = setTimeout(() => {
    state.reportTimer = undefined
    fire(state.reportListeners)
  }, REPORT_COALESCE_MS)
  state.reportTimer.unref?.()
}

export const REPORT_COALESCE_MS = 1_000

function same(a: ReadonlyArray<Creator.HostState>, b: ReadonlyArray<Creator.HostState>) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A host the broker no longer serves: its report goes too, so Settings stops listing it. */
export function forget(hostId: string) {
  if (holder().reports.delete(hostId)) fire(holder().reportListeners)
}

export function reports(): ReadonlyMap<string, Creator.HostReport> {
  return holder().reports
}

export function onReport(listener: () => void) {
  const set = holder().reportListeners
  set.add(listener)
  return () => void set.delete(listener)
}

// ---- a host ----

export function provideLink(link: Link) {
  const undo = stack(holder().links, link)
  const unsubscribe = link.on(() => fire(holder().linkListeners))
  fire(holder().linkListeners)
  return () => {
    unsubscribe()
    undo()
  }
}

export function link(): Link | undefined {
  return holder().links.at(-1)
}

/** Called when the link came up, the PC's extensions changed, or a link was provided. */
export function onLink(listener: () => void) {
  const set = holder().linkListeners
  set.add(listener)
  return () => void set.delete(listener)
}
