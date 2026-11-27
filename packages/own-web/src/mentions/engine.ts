// The suggestion engine (lazy chunk, loaded when a list first opens): providers → ranked groups. Local catalogs are
// ranked on every query change (a few hundred items at most, one pass); remote search (files) is debounced 80 ms,
// never sent while composing (03 §12 rule 9), aborted when a newer query starts and ignored when stale. The list
// shows the previous remote answer until the next one lands, so typing never flickers.
import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { bestScore, matchClass, rank } from "./rank"
import { splitRange } from "./range"
import type { SuggestContext, SuggestGroupView, SuggestItem, SuggestProvider, Trigger } from "./types"

export const REMOTE_DEBOUNCE_MS = 80

export interface SuggestEngineInput {
  readonly providers: () => readonly SuggestProvider[]
  readonly context: () => SuggestContext | undefined
  /** The open trigger (already filtered for dismissal); `undefined` when the list is closed. */
  readonly trigger: () => Trigger | undefined
  readonly composing: () => boolean
  readonly debounceMs?: number
}

export function createSuggestEngine(input: SuggestEngineInput) {
  // A signal, not a store: items must stay the providers' own objects (they key WeakMaps), not store proxies.
  const [remote, setRemote] = createSignal<Readonly<Record<string, readonly SuggestItem[] | undefined>>>({})
  const [loading, setLoading] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  const active = createMemo(() => {
    const trigger = input.trigger()
    const context = input.context()
    if (!trigger || !context) return []
    return input.providers().filter((provider) => serves(provider, trigger, context))
  })
  const query = () => input.trigger()?.query ?? ""
  /** Which list is open: a new list starts without the previous list's remote answers. */
  const listKey = createMemo(() => {
    const trigger = input.trigger()
    const context = input.context()
    if (!trigger || !context) return undefined
    const scope = trigger.kind === "argument" ? `argument:${trigger.command}` : trigger.kind
    return `${context.serverKey}\n${context.sessionID ?? ""}\n${context.directory ?? ""}\n${scope}`
  })

  // Catalogs load when a list opens (not at startup, PF6).
  createEffect(
    on(listKey, (key) => {
      if (!key) return
      const context = untrack(input.context)
      if (!context) return
      untrack(active).forEach((provider) => provider.prepare?.(context))
      batch(() => {
        setRemote({})
        setFailed(false)
      })
    }),
  )

  // Remote search.
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let sequence = 0
  const cancel = () => {
    clearTimeout(timer)
    controller?.abort()
    controller = undefined
  }
  onCleanup(cancel)
  createEffect(() => {
    const context = input.context()
    const providers = active().filter((provider) => provider.remote)
    const current = query()
    if (!context || !providers.length || !listKey()) {
      cancel()
      setLoading(false)
      return
    }
    // Rule 9: never while composing; the effect runs again on compositionend.
    if (input.composing()) return
    cancel()
    const id = ++sequence
    setLoading(true)
    timer = setTimeout(() => {
      const abort = new AbortController()
      controller = abort
      void Promise.allSettled(
        providers.map((provider) =>
          provider.remote!(current, context, abort.signal).then((items) => ({ provider: provider.id, items })),
        ),
      ).then((results) => {
        if (id !== sequence) return
        batch(() => {
          const next = { ...remote() }
          results.forEach((result) => {
            if (result.status === "fulfilled") next[result.value.provider] = result.value.items
          })
          setRemote(next)
          setFailed(results.some((result) => result.status === "rejected" && !isAbort(result.reason)))
          setLoading(false)
        })
      })
    }, input.debounceMs ?? REMOTE_DEBOUNCE_MS)
  })

  /** Groups, plus the match class of every row (to preselect across groups without reordering them). */
  const built = createMemo(() => {
    const context = input.context()
    const trigger = input.trigger()
    const strength = new Map<string, number>()
    if (!context || !trigger) return { groups: [] as SuggestGroupView[], strength }
    const current = trigger.query
    // `#L10-40` belongs to the chosen file, not to the match.
    const plain = trigger.kind === "mention" ? splitRange(current).query : current
    const groups = active().flatMap((provider): SuggestGroupView[] => {
      const seen = new Set<string>()
      const unique = (item: SuggestItem) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      }
      const pinned = provider.pinned?.(current, context) ?? []
      const found = provider.remote ? (remote()[provider.id] ?? []) : []
      const keys = provider.keys ?? ((item: SuggestItem) => [item.label])
      const local = provider.local ? rank(provider.local(context), plain, keys, provider.limit) : []
      const items = [...pinned, ...found, ...local].filter(unique).slice(0, provider.limit)
      items.forEach((item) => strength.set(item.id, matchClass(bestScore(item, plain, keys))))
      const note = provider.note?.(context, trigger)
      if (!items.length && !note) return []
      return [{ id: provider.id, label: provider.label(trigger), note, items }]
    })
    return { groups, strength }
  })
  const groups = () => built().groups
  const items = createMemo(() => groups().flatMap((group) => group.items))
  const byID = createMemo(() => new Map(items().map((item) => [item.id, item])))
  /** The first row of the strongest match class: an exact `/compact` wins over a weak match in an earlier group. */
  const preferred = createMemo(() => {
    const strength = built().strength
    return items().reduce<SuggestItem | undefined>(
      (best, item) => (!best || (strength.get(item.id) ?? 0) > (strength.get(best.id) ?? 0) ? item : best),
      undefined,
    )
  })

  return {
    groups,
    items,
    item: (id: string) => byID().get(id),
    preferred,
    /** A remote search is pending or running. */
    loading,
    /** The last remote search failed (not aborted). */
    failed,
    /** Whether the open list has remote providers (files): an empty answer is worth saying then. */
    searches: () => active().some((provider) => provider.remote),
    select(item: SuggestItem) {
      const context = input.context()
      const provider = active().find((candidate) => candidate.id === item.group)
      return context && provider ? provider.select(item, context) : undefined
    },
  }
}

export type SuggestEngine = ReturnType<typeof createSuggestEngine>

function serves(provider: SuggestProvider, trigger: Trigger, context: SuggestContext) {
  if (provider.trigger !== trigger.kind) return false
  return trigger.kind !== "argument" || (provider.accepts?.(trigger.command, context) ?? false)
}

function isAbort(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}
