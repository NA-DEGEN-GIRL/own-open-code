export * as StoreWatch from "./watch.js"

import fs from "node:fs"
import path from "node:path"
import { Hash } from "@own/runtime"
import type { Deps } from "../deps.js"
import { CodexMeta } from "./codex-meta.js"

/** Quiet period after the last file event before the file is re-read (writers replace files via temp + rename). */
export const DEBOUNCE_MS = 150

type StoreName = "accounts" | "policy" | "ratecards" | "trust" | "presets" | "codex-meta"

/**
 * Registry changes made by another process (02 §3.8 "다른 프로세스의 변경은 fs.watch로 받는다"): watches `OWN_HOME` for
 * `accounts.json`, `policy.json`, `ratecards.json`, `trust.json`, `presets.json` (07 §8.1) and `codex-meta.json`
 * (07 §4.5). Every instance watches, but only the current runtime leader acts, so one process-wide
 * `store.changed{origin:"external"}` is broadcast per change. A file whose content equals what this process last read
 * or wrote (its own write) is ignored. Returns the stop function.
 */
export function start(deps: Deps) {
  const log = deps.log.child("slots.watch")
  const files = {
    accounts: deps.runtime.registry,
    policy: deps.runtime.policy,
    ratecards: deps.runtime.ratecards,
    trust: deps.runtime.trust,
    presets: deps.runtime.presets,
    "codex-meta": CodexMeta.file(deps.runtime.layout),
  } satisfies Record<StoreName, unknown>
  const names = new Map(
    (Object.keys(files) as StoreName[]).map((store) => [path.basename(files[store].file).toLowerCase(), store]),
  )
  const pending = new Map<StoreName, () => void>()

  const check = async (store: StoreName) => {
    if (!deps.runtime.isLeader()) return
    const file = files[store]
    const before: unknown = file.cached()
    if (before === undefined) return
    // This process's own write may still be finishing (a busy loop runs the debounce before its continuation): the
    // file then holds what it is writing, not another process's change.
    const writing: unknown = file.writing()
    const after: unknown = await file.read().catch((error: unknown) => {
      log.warn("store_unreadable", { store, error })
      return undefined
    })
    if (after === undefined) return
    const stable = Hash.stable(after)
    if (stable === Hash.stable(before) || (writing !== undefined && stable === Hash.stable(writing))) return
    const revision = store === "accounts" ? deps.runtime.registry.cached()?.revision : undefined
    log.info("store_changed_externally", { store, revision })
    deps.runtime.broadcast.emit("store.changed", { store, origin: "external", revision })
  }

  const watcher = watch(deps.runtime.layout.root, (filename) => {
    const store = names.get(filename.toLowerCase())
    if (!store) return
    pending.get(store)?.()
    pending.set(
      store,
      deps.clock.schedule(DEBOUNCE_MS, () => {
        pending.delete(store)
        void check(store).catch((error: unknown) => log.warn("store_check_failed", { store, error }))
      }),
    )
  })
  if (!watcher) log.warn("store_watch_unavailable", { root: deps.runtime.layout.root })

  return () => {
    watcher?.close()
    for (const cancel of pending.values()) cancel()
    pending.clear()
  }
}

function watch(root: string, onFile: (filename: string) => void) {
  try {
    const watcher = fs.watch(root, { persistent: false }, (_event, filename) => {
      if (filename) onFile(filename.toString())
    })
    watcher.on("error", () => watcher.close())
    return watcher
  } catch {
    // A missing or unwatchable OWN_HOME only loses external change detection; RPC changes still propagate.
    return undefined
  }
}
