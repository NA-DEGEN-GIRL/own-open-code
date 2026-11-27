export * as Singleton from "./singleton.js"

import { Home } from "@own/runtime"
import { Effect } from "effect"
import type { Options } from "./options.js"

/**
 * Process state of one build of own.import (01 §4 "싱글턴 규칙"). A desktop bundle is one `index.js` that every
 * Location evaluates again, and a hot reload evaluates it once more, so module-level state is never shared. What must
 * be shared (the index, the Worker, plan nonces, the running job) lives here instead: on `globalThis` under the build
 * id, held by the live plugin instances and closed when the last one leaves. Overlapping builds after a hot reload use
 * different keys and never share state.
 *
 * Acquiring it is free (PF1/PF6): no file is read and no Worker starts. Each module declares its {@link Slot}s at
 * module level and creates their values on first use through {@link Shared.get}; slots are matched by name, so every
 * evaluation of the bundle reaches the same value.
 */
export interface Shared {
  readonly buildId: string
  /** `OWN_HOME` of the instance that created the entry; later instances share it. */
  readonly home: string
  /** The latest live instance's options: a changed config applies to the next call. */
  readonly options: () => Options.Info
  /** The value of `slot`, created on first use by any instance and kept until the last instance releases. */
  readonly get: <T>(slot: Slot<T>) => T
}

export interface Slot<T> {
  /** Unique within own.import, e.g. `index` or `worker`. */
  readonly name: string
  /** Synchronous, so two instances asking at once never both create a value. */
  readonly create: (shared: Shared) => T
  /** Runs when the last instance releases the entry, in reverse creation order. */
  readonly close?: (value: T) => Effect.Effect<void>
}

export function slot<T>(
  name: string,
  create: (shared: Shared) => T,
  close?: (value: T) => Effect.Effect<void>,
): Slot<T> {
  return { name, create, close }
}

export interface Input {
  readonly buildId: string
  readonly options: Options.Info
}

/** The shared state of `input.buildId`, created on first use and closed when the last instance's scope ends. */
export const acquire = (input: Input) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const key = Symbol.for(`own-open-code.import/${input.buildId}`)
      // A wrapper of its own, so a release removes exactly this instance even when two pass the same options.
      const instance = { options: input.options }
      const entry = registry()[key] ?? create(input)
      registry()[key] = entry
      entry.live.push(instance)
      return { key, entry, instance }
    }),
    (held) =>
      Effect.suspend(() => {
        held.entry.live.splice(held.entry.live.indexOf(held.instance), 1)
        if (held.entry.live.length > 0) return Effect.void
        if (registry()[held.key] === held.entry) delete registry()[held.key]
        return held.entry.close
      }),
  ).pipe(Effect.map((held) => held.entry.shared))

interface Entry {
  readonly live: Array<{ readonly options: Options.Info }>
  readonly shared: Shared
  readonly close: Effect.Effect<void>
}

function create(input: Input): Entry {
  const live: Entry["live"] = []
  const values = new Map<string, { readonly value: unknown; readonly close?: Effect.Effect<void> }>()
  const shared: Shared = {
    buildId: input.buildId,
    home: Home.resolve({ home: input.options.home }),
    options: () => live.at(-1)?.options ?? input.options,
    get: <T>(slot: Slot<T>): T => {
      const existing = values.get(slot.name)
      if (existing !== undefined) return existing.value as T
      const value = slot.create(shared)
      values.set(slot.name, { value, close: slot.close?.(value) })
      return value
    },
  }
  return {
    live,
    shared,
    close: Effect.suspend(() => {
      const closers = [...values.values()].reverse().flatMap((item) => (item.close ? [item.close] : []))
      values.clear()
      // One failing closer never keeps the others from running.
      return Effect.forEach(closers, (closer) => Effect.exit(closer), { discard: true })
    }),
  }
}

function registry() {
  return globalThis as unknown as Record<symbol, Entry | undefined>
}
