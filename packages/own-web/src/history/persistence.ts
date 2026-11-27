// Per-session draft persistence in the composer (03 §19.9): the text is composer/drafts.ts's (localStorage, swapped
// per session without re-creating the textarea); this hook adds the draft's mention chips and ready attachments
// (IndexedDB, image bytes as Blobs) and the save points the spec names — 500 ms debounce, blur and
// `visibilitychange` (plus `pagehide`, which a closing desktop window fires without `visibilitychange`).
//
// A draft's chips and attachments come back the first time its session is shown in this page, added to whatever the
// stores already hold for it (both dedupe). Nothing here touches the textarea, so a running IME composition is never
// disturbed (03 §12 rule 5). Saving starts for a draft only after its stored record was read, so an empty store at
// startup can never overwrite it.
import { createEffect, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
import { draftOf, type Attachments, type ReadyAttachment } from "@/attachments"
import { chipID, type ChipStore } from "@/mentions"
import { draftExtras, type DraftExtras, type DraftExtrasStore } from "./drafts"

export interface DraftPersistenceOptions {
  readonly serverKey: () => string
  /** `undefined` on the new-session screen. */
  readonly sessionID: () => string | undefined
  /** The composer's draft key (`composer/drafts` `draftKey`, also the chip store's key). */
  readonly draftKey: () => string
  readonly element: () => HTMLTextAreaElement | undefined
  /** The composer's mention chips (`suggest.chips`). */
  readonly chips?: ChipStore
  /** The composer's attachment store. */
  readonly attachments?: Pick<Attachments, "of" | "restore">
  /** The composer's text drafts: flushed on blur and when the page hides (composer/drafts.ts `flush`). */
  readonly text?: { flush(): void }
  readonly store?: DraftExtrasStore
}

interface Visited {
  readonly serverKey: string
  readonly sessionID: string | undefined
  /** Signature of what was last saved (or restored), so unchanged drafts are not written again. */
  signature: string
  /** The stored record was read; saving may start. */
  ready: boolean
}

export function useDraftPersistence(options: DraftPersistenceOptions) {
  const store = options.store ?? draftExtras
  const visited = new Map<string, Visited>()
  /** Bumped when a draft's record was read (its saving starts). */
  const [ready, setReady] = createSignal(0)

  const extrasOf = (key: string, entry: Visited): DraftExtras => ({
    chips: options.chips?.list(key) ?? [],
    attachments: (options.attachments?.of(entry.serverKey, entry.sessionID) ?? []).flatMap((chip) =>
      chip.state === "ready" && chip.ready ? [chip.ready] : [],
    ),
  })

  // First visit of a draft in this page: read its record, then add it to the stores.
  createEffect(
    on(options.draftKey, (key) => {
      if (visited.has(key)) return
      const entry: Visited = {
        serverKey: options.serverKey(),
        sessionID: options.sessionID(),
        signature: "",
        ready: false,
      }
      visited.set(key, entry)
      void store
        .load(key)
        .catch(() => undefined)
        .then((extras) => {
          if (extras) {
            extras.chips.forEach((chip) => options.chips?.add(key, chip))
            if (extras.attachments.length)
              options.attachments?.restore(draftOf(entry.serverKey, entry.sessionID), extras.attachments)
          }
          entry.signature = signature(untrack(() => extrasOf(key, entry)))
          entry.ready = true
          setReady((count) => count + 1)
        })
    }),
  )

  // Every visited draft (uploads finish after a session switch; restore requests target other drafts). The list reads
  // are fine-grained store reads, so this reruns only when a chip or an attachment of a visited draft changes.
  createEffect(() => {
    ready()
    for (const [key, entry] of visited) {
      if (!entry.ready) continue
      const extras = extrasOf(key, entry)
      const next = signature(extras)
      if (next === entry.signature) continue
      entry.signature = next
      store.save(key, extras)
    }
  })

  const flush = () => {
    options.text?.flush()
    void store.flush()
  }
  onMount(() => {
    const hidden = () => document.visibilityState === "hidden" && flush()
    document.addEventListener("visibilitychange", hidden)
    window.addEventListener("pagehide", flush)
    onCleanup(() => {
      document.removeEventListener("visibilitychange", hidden)
      window.removeEventListener("pagehide", flush)
    })
  })
  createEffect(() => {
    const element = options.element()
    if (!element) return
    element.addEventListener("blur", flush)
    onCleanup(() => element.removeEventListener("blur", flush))
  })

  return { flush }
}

/** Cheap identity of chips and attachments (inline bytes by length and tail, never the whole URI). */
export function signature(extras: DraftExtras) {
  return [
    ...extras.chips.map(chipID),
    ...extras.attachments.map((item: ReadyAttachment) =>
      item.kind === "path"
        ? `path:${item.path}`
        : `inline:${item.name}:${item.mime}:${item.uri.length}:${item.uri.slice(-24)}`,
    ),
  ].join("\n")
}
