// Router ledger lines of the open session (02 §7.5, §9.2 `ledger.session`, §9.3 `ledger.step`), keyed by message id:
// a step's line by its assistant message, so a turn footer reads only its own steps (03 §20.2 R1), and a compaction's
// by its compaction message (SL 2026-10-26), so its marker names the account that signed it. The first page loads
// when the router is ready (and again after every resync); older pages load when a footer or the compactions viewer
// asks for a message the loaded pages do not cover. `ledger.step` arrives already coalesced at 250 ms by OwnStore (R3).
import type { Ledger } from "@own/protocol"
import { batch, createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { OwnStore } from "@/data"

const PAGE = 1_000

export function createLedgerLines(input: {
  readonly own: OwnStore
  readonly sessionID: string
  /** The router answers and the session's directory is known (session-location method, 02 §9.1). */
  readonly ready: Accessor<boolean>
}) {
  const [lines, setLines] = createStore<Record<string, Ledger.Line>>({})
  // A footer asks for every step of its turn, most of which may have no line yet: an id without one is read behind one
  // signal. Solid's store keeps a signal for every key read in a tracking scope (one per message scrolled past).
  const [added, setAdded] = createSignal(0)
  const state = { cursor: undefined as string | undefined, loading: undefined as Promise<void> | undefined }

  const add = (items: readonly Ledger.Line[]) =>
    batch(() => {
      const kept = items.filter(
        (line): line is Ledger.Line & { messageID: string } =>
          (line.kind === "primary" || line.kind === "compaction") && !!line.messageID,
      )
      const fresh = untrack(() => kept.some((line) => !(line.messageID in lines)))
      kept.forEach((line) => setLines(line.messageID, reconcile(line)))
      if (fresh) setAdded((count) => count + 1)
    })

  const load = (cursor?: string) => {
    state.loading ??= input.own.rpc
      .call("ledger.session", { sessionID: input.sessionID, limit: PAGE, cursor })
      .then((output) => {
        add(output.steps)
        state.cursor = output.cursor
      })
      .catch((error: unknown) => console.warn("[own-web] ledger.session failed", error))
      .finally(() => {
        state.loading = undefined
      })
    return state.loading
  }

  createEffect(on(input.ready, (ready) => ready && void load(), { defer: false }))
  onCleanup(
    input.own.on("ledger.step", (event) => {
      if (event.data.line.sessionID === input.sessionID) add([event.data.line])
    }),
  )

  return {
    line: (messageID: string): Ledger.Line | undefined =>
      untrack(() => messageID in lines) ? lines[messageID] : void added(),
    /** A footer or the compactions viewer found no line for its message: fetch the next older page, if there is one. */
    wantOlder() {
      if (!state.cursor || state.loading || !input.ready()) return
      void load(state.cursor)
    },
  }
}

export type LedgerLines = ReturnType<typeof createLedgerLines>
