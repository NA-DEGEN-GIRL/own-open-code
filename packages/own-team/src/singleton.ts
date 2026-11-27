export * as Singleton from "./singleton.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Fsx, Lock } from "@own/runtime"
import { Build } from "./build.js"
import { Controller } from "./controller.js"
import type { Log } from "./log.js"

/**
 * The process-lifetime controller (06 §2.6): created on first use under
 * `globalThis[Symbol.for("own-open-code.team-controller/<buildId>")]`, shared by every plugin instance of the build
 * (plugin modules are imported again per Location, so module state is never shared), and closed `lingerSeconds` (30)
 * after the last reference is released, so one area Location going down never stops a running step.
 *
 * Old and new builds may overlap briefly in one process after a reload: only the holder of
 * `OWN_HOME\locks\team-controller.lock` writes KV and runs ops; the other waits for the file to go away (the
 * own-remote controller's rule, 04 §4.1). The holder touches the file every {@link HEARTBEAT_MS}; a file not touched
 * for {@link LEASE_MS} is stale even when its pid runs (Windows gives a dead holder's pid to new processes), so a
 * crash never leaves the controller waiting for good. A failed write of the file is retried, never left pending.
 *
 * RH-20: while a live process holds it (a second service on the same OWN_HOME, a stuck older one that still touches
 * its file), the wait is logged (`controller_lock_waiting`, again every {@link LOCK_LOG_MS}) and the controller says so
 * (`Controller.waitingForLock`: `health`, `diagnostics`, `team_status`); RPC methods and tools that write answer
 * `unavailable` after a short wait instead of hanging (`Services.Base.ready`).
 */

export interface Input extends Controller.Input {
  /** Seconds the controller outlives its last reference. Default 30. */
  readonly lingerSeconds?: number
}

export interface Handle {
  readonly controller: Controller.Service
  /** Resolves once this build holds the controller lock and the controller started. */
  readonly ready: Promise<void>
  /** Drops this reference; the last one closes the controller after the linger. Idempotent. */
  release(): Promise<void>
}

interface Slot {
  readonly controller: Controller.Service
  ready: Promise<void>
  readonly home: string
  refs: number
  linger: (() => void) | undefined
  closing: Promise<void> | undefined
  lock: { readonly file: string; readonly token: string } | undefined
  heartbeat: ReturnType<typeof setInterval> | undefined
  cancelled: boolean
}

/** A lock file its holder has not touched for this long is stale, whatever its pid. */
export const LEASE_MS = 60_000
/** How often the holder touches its lock file. */
export const HEARTBEAT_MS = 15_000
/** How long a failed write of the lock file waits before the next try. */
const RETRY_MS = 1_000
/** How often a wait for another process's lock is logged again. */
export const LOCK_LOG_MS = 5 * 60_000

export function key(buildId: string) {
  return Symbol.for(`own-open-code.team-controller/${buildId}`)
}

/** The lock file of the controller (06 §2.4). */
export function lockFile(home: string) {
  return path.join(home, "locks", "team-controller.lock")
}

export function acquire(input: Input): Handle {
  const existing = slots()[key(input.buildId)]
  if (existing && existing.home !== input.home)
    throw new Error(`own-team ${input.buildId} already uses OWN_HOME ${existing.home}, not ${input.home}`)
  const slot = existing && !existing.closing ? existing : create(input)
  slot.linger?.()
  slot.linger = undefined
  slot.refs++
  const released = { done: false }
  return {
    controller: slot.controller,
    ready: slot.ready,
    release: async () => {
      if (released.done) return
      released.done = true
      slot.refs--
      if (slot.refs > 0) return
      const close = () => {
        slot.linger = undefined
        if (slot.refs > 0) return
        if (slots()[key(input.buildId)] === slot) delete slots()[key(input.buildId)]
        slot.closing = shutdown(slot)
      }
      const seconds = input.lingerSeconds ?? Build.LINGER_SECONDS
      if (seconds === 0) {
        close()
        await slot.closing
        return
      }
      slot.linger = input.clock.schedule(seconds * 1000, close)
    },
  }
}

/** References and state of a build's controller, if it exists (tests, diagnostics). */
export function peek(buildId: string) {
  const slot = slots()[key(buildId)]
  return slot && { refs: slot.refs, lingering: slot.linger !== undefined, controller: slot.controller }
}

function create(input: Input): Slot {
  const controller = new Controller.Service(input)
  const slot: Slot = {
    controller,
    ready: Promise.resolve(),
    home: input.home,
    refs: 0,
    linger: undefined,
    closing: undefined,
    lock: undefined,
    heartbeat: undefined,
    cancelled: false,
  }
  const ready = (async () => {
    const lock = await takeLock(
      lockFile(input.home),
      input.buildId,
      () => slot.cancelled,
      input.log,
      (holder) => controller.waitingForLock(holder),
    )
    slot.lock = lock
    if (slot.cancelled || !lock) return
    input.log.info("controller_lock_acquired", { file: lock.file, buildId: input.buildId })
    slot.heartbeat = setInterval(() => void touch(lock, input.log), HEARTBEAT_MS)
    slot.heartbeat.unref?.()
    controller.start()
  })()
  ready.catch((error: unknown) => input.log.error("controller_start_failed", { error }))
  slot.ready = ready
  slots()[key(input.buildId)] = slot
  return slot
}

async function shutdown(slot: Slot) {
  slot.cancelled = true
  await slot.ready.catch(() => {})
  clearInterval(slot.heartbeat)
  await slot.controller.close().catch(() => {})
  if (!slot.lock) return
  const text = await Fsx.readText(slot.lock.file).catch(() => undefined)
  if (text?.includes(slot.lock.token)) await Fsx.remove(slot.lock.file).catch(() => {})
}

/**
 * `{pid, buildId, token}` created exclusively. A holder is stale when its pid is gone, when its file was not touched
 * for {@link LEASE_MS} (a reused pid), or when it is this process but no controller of its build is alive here any more
 * (a crashed reload). Waits in 1 s steps otherwise. A write that fails for another reason than an existing file is
 * logged and tried again: writes wait for the lock, so giving up would leave them waiting for good.
 */
async function takeLock(
  file: string,
  buildId: string,
  cancelled: () => boolean,
  log: Log.Logger,
  waiting: (holder: { readonly pid: number; readonly buildId: string } | undefined) => void,
) {
  const token = randomBytes(8).toString("hex")
  const body = JSON.stringify({ pid: process.pid, buildId, token, startedAt: Date.now() })
  const told = { at: 0, since: 0 }
  for (;;) {
    if (cancelled()) return undefined
    const written = await fs
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fs.writeFile(file, body, { flag: "wx", mode: 0o600 }))
      .then(
        () => "written" as const,
        (error: unknown) => (Fsx.code(error) === "EEXIST" ? ("held" as const) : error),
      )
    if (written === "written") return { file, token }
    if (written !== "held") {
      log.warn("controller_lock_write_failed", { file, error: written })
      await Fsx.sleep(RETRY_MS)
      continue
    }
    const [text, stat] = await Promise.all([
      Fsx.readText(file).catch(() => undefined),
      fs.stat(file).catch(() => undefined),
    ])
    const holder = parseHolder(text)
    const stale =
      !holder ||
      !Lock.isAlive(holder.pid) ||
      (stat !== undefined && Date.now() - stat.mtimeMs > LEASE_MS) ||
      (holder.pid === process.pid && (holder.buildId === buildId || !slots()[key(holder.buildId)]))
    if (stale) {
      await Fsx.remove(file).catch(() => {})
      continue
    }
    const now = Date.now()
    if (told.since === 0) told.since = now
    if (now - told.at >= LOCK_LOG_MS) {
      told.at = now
      log.warn("controller_lock_waiting", {
        file,
        holderPid: holder.pid,
        holderBuild: holder.buildId,
        since: told.since,
      })
    }
    waiting({ pid: holder.pid, buildId: holder.buildId })
    await Fsx.sleep(1000)
  }
}

/** The holder's heartbeat: touches its lock file, and says so when the file is no longer its own. */
async function touch(lock: { readonly file: string; readonly token: string }, log: Log.Logger) {
  const text = await Fsx.readText(lock.file).catch(() => undefined)
  if (!text?.includes(lock.token)) return log.error("controller_lock_lost", { file: lock.file, pid: process.pid })
  const now = new Date()
  await fs.utimes(lock.file, now, now).catch((error: unknown) => log.warn("controller_lock_touch_failed", { error }))
}

const decodeHolder = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, buildId: Schema.String })),
)

function parseHolder(text: string | undefined) {
  return text === undefined ? undefined : Option.getOrUndefined(decodeHolder(text))
}

// The controller lives on globalThis by design (06 §2.6); this is the one place that indexes it.
function slots() {
  return globalThis as unknown as Record<symbol, Slot | undefined>
}
