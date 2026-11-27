/** A message as these fakes keep them: core's fields the readers look at. */
interface Row {
  readonly id: string
  readonly type: string
}

interface Input {
  readonly type?: string
  readonly order?: "asc" | "desc"
  readonly limit?: number
  readonly cursor?: { readonly id: string; readonly direction: "previous" | "next" }
}

/**
 * `ctx.session.messages` over a fake's whole transcript (oldest first), paged the way core's `SessionStore.messages`
 * pages rows: `type` filters, `order` defaults to newest first, a `next` cursor reads past the named message in that
 * order and a `previous` one before it.
 */
export function messagesOver<T extends Row>(rows: () => ReadonlyArray<T>) {
  return async (input: Input): Promise<ReadonlyArray<T>> => {
    const all = rows()
    const at = input.cursor === undefined ? undefined : all.findIndex((row) => row.id === input.cursor?.id)
    if (at === -1) return []
    const order = input.order ?? "desc"
    const inRange = (index: number) => {
      if (at === undefined) return true
      const after = order === "asc" ? index > at : index < at
      return input.cursor?.direction === "previous" ? !after && index !== at : after
    }
    const matching = all.filter((row, index) => (input.type === undefined || row.type === input.type) && inRange(index))
    const ordered = order === "asc" ? matching : matching.toReversed()
    if (input.cursor?.direction !== "previous") return ordered.slice(0, input.limit)
    return input.limit === undefined ? ordered : ordered.slice(Math.max(0, ordered.length - input.limit))
  }
}
