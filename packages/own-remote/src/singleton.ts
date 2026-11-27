export * as Singleton from "./singleton.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Fsx, Lock } from "@own/runtime"
import { Controller, type Input } from "./controller.js"
import { Operations } from "./operations.js"
import { Broker } from "./protocol/broker.js"

/**
 * Process-lifetime controller (04 §4.1): created on first use under `globalThis[Symbol.for("own-open-code.remote-
 * controller/<buildId>")]`, shared by every plugin instance of the build, closed `lingerSeconds` (30) after the last
 * reference is released. Location scopes never own an ssh process.
 *
 * Old and new builds may overlap briefly in one process after a reload; only the holder of
 * `OWN_HOME\locks\remote-controller.lock` runs tunnels, the other waits for the file to go away (04 §4.1).
 */
export interface Handle {
  readonly controller: Controller
  readonly operations: Operations
  /** Resolves once this build holds the controller lock and the controller has started. */
  readonly ready: Promise<void>
  release(): Promise<void>
}

interface Slot {
  readonly controller: Controller
  readonly operations: Operations
  readonly ready: Promise<void>
  readonly home: string
  refs: number
  linger: ReturnType<typeof setTimeout> | undefined
  closing: Promise<void> | undefined
  lock: { readonly file: string; readonly token: string } | undefined
  cancelled: boolean
}

export function key(buildId: string) {
  return Symbol.for(`own-open-code.remote-controller/${buildId}`)
}

function slots() {
  return globalThis as unknown as Record<symbol, Slot | undefined>
}

export function acquire(input: Input): Handle {
  const existing = slots()[key(input.buildId)]
  if (existing && existing.home !== input.ownHome)
    throw new Error(`own-remote ${input.buildId} already uses OWN_HOME ${existing.home}, not ${input.ownHome}`)
  const slot = existing && !existing.closing ? existing : create(input)
  if (slot.linger) clearTimeout(slot.linger)
  slot.linger = undefined
  slot.refs++
  let released = false
  return {
    controller: slot.controller,
    operations: slot.operations,
    ready: slot.ready,
    release: async () => {
      if (released) return
      released = true
      slot.refs--
      if (slot.refs > 0) return
      const seconds = input.options.lingerSeconds ?? 30
      const close = () => {
        if (slot.refs > 0) return
        if (slots()[key(input.buildId)] === slot) delete slots()[key(input.buildId)]
        slot.closing = shutdown(slot, input.buildId)
      }
      if (seconds === 0) {
        close()
        await slot.closing
        return
      }
      slot.linger = setTimeout(close, seconds * 1000)
      slot.linger.unref?.()
    },
  }
}

function create(input: Input): Slot {
  const controller = new Controller(input)
  const operations = new Operations(controller)
  const slot: Slot = {
    controller,
    operations,
    ready: Promise.resolve(),
    home: input.ownHome,
    refs: 0,
    linger: undefined,
    closing: undefined,
    lock: undefined,
    cancelled: false,
  }
  const ready = (async () => {
    await controller.registry.load()
    slot.lock = await takeLock(path.join(input.ownHome, "locks", "remote-controller.lock"), input.buildId, () => slot.cancelled)
    if (slot.cancelled) return
    await controller.start()
    ;(globalThis as unknown as Record<symbol, unknown>)[Broker.endpointsKey(input.buildId)] = controller.endpoints()
  })()
  ready.catch(() => {})
  ;(slot as { ready: Promise<void> }).ready = ready
  slots()[key(input.buildId)] = slot
  return slot
}

async function shutdown(slot: Slot, buildId: string) {
  slot.cancelled = true
  await slot.ready.catch(() => {})
  await slot.controller.close().catch(() => {})
  const endpoints = Broker.endpointsKey(buildId)
  delete (globalThis as unknown as Record<symbol, unknown>)[endpoints]
  if (slot.lock) {
    const text = await Fsx.readText(slot.lock.file).catch(() => undefined)
    if (text?.includes(slot.lock.token)) await Fsx.remove(slot.lock.file).catch(() => {})
  }
}

/**
 * `{pid, buildId, token}` created exclusively. A holder is stale when its pid is gone, or when it is this process
 * but no controller of its build is alive here any more (a crashed reload). Waits (1 s steps) otherwise.
 */
async function takeLock(file: string, buildId: string, cancelled: () => boolean) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const token = randomBytes(8).toString("hex")
  const body = JSON.stringify({ pid: process.pid, buildId, token, startedAt: Date.now() })
  for (;;) {
    if (cancelled()) return undefined
    try {
      await fs.writeFile(file, body, { flag: "wx", mode: 0o600 })
      return { file, token }
    } catch (error) {
      if (Fsx.code(error) !== "EEXIST") throw error
    }
    const holder = parse(await Fsx.readText(file).catch(() => undefined))
    const stale =
      !holder ||
      !Lock.isAlive(holder.pid) ||
      (holder.pid === process.pid && (holder.buildId === buildId || !slots()[key(holder.buildId)]))
    if (stale) {
      await Fsx.remove(file).catch(() => {})
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

function parse(text: string | undefined) {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return typeof value.pid === "number" && typeof value.buildId === "string"
      ? { pid: value.pid, buildId: value.buildId }
      : undefined
  } catch {
    return undefined
  }
}
