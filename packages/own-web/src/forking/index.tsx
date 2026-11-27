// Forking module entry (03 §19.12, gap 28): fork from a specific message (`fork{before}`, the message goes back into
// the new session's composer; cache-aware notes, 02 §5.9(e)), fork the whole session, and the manual `/compact` entry
// with its progress chip (`압축 중…`) and failure banner. Pin/archive flags are cleared on every fork (01 §17.1 #27).
//
// Wiring (integrator, see the report):
//   shell: mount `<ForkHost />` once (next to `<RevertHost />`).
//   composer box (above the chips, next to the `compaction-requested` chip): `<CompactionStatus runtime sessionID />`.
//   context meter `지금 압축` and `/compact`: `useCompactNow()(runtime, sessionID)`; commands:
//     `useCommandActions({ overrides: { ...useForkCommands(), … } })` (`/fork` forks the whole session, clearing flags).
//   header `⋯` (03 §4.4: 포크, 이 메시지에서 포크, 압축): `useForkMenuItems(serverKey, sessionID)()` gives the three items.
//   transcript user-message menu (when it has one): `forkAction(serverKey)` like `revertAction`.
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import type { CommandActions, CommandContext } from "@/commands"
import { showToast } from "@/switcher/toast"
import { useCompactNow } from "./compaction-view"
import { forkSession } from "./fork"
import { openForkDialog } from "./host"
import { useForkText } from "./strings"

export { compactionTracker, createCompactionTracker, type CompactionTracker, type CompactionView } from "./compaction"
export { CompactionStatus, useCompactNow } from "./compaction-view"
export { forkSession, type ForkOutcome } from "./fork"
export { closeForkDialog, forkAction, forkDialogOpen, ForkHost, openForkDialog, type ForkRequest } from "./host"
export {
  clearForkFlags,
  compactionPhase,
  filterMessages,
  forkableMessages,
  type CompactionPhase,
  type ForkableMessage,
} from "./model"
export { forkEn, forkKo, forkText, useForkText } from "./strings"

export interface ForkMenuItem {
  readonly id: "fork" | "forkFrom" | "compact"
  readonly label: string
  readonly disabled: boolean
  run(): void
}

/** `/fork` and `/compact` for `useCommandActions({ overrides })`: the same paths as the menu and the meter. */
export function useForkCommands(): Pick<CommandActions, "fork" | "compact"> {
  const forkWhole = useForkWhole()
  const compactNow = useCompactNow()
  return {
    async fork(context: CommandContext) {
      if (context.sessionID) await forkWhole(context.serverKey, context.sessionID)
    },
    async compact(context: CommandContext) {
      if (context.sessionID) compactNow(context.runtime, context.sessionID)
    },
  }
}

/** The header `⋯` items of 03 §4.4 this module owns: 포크, 이 메시지에서 포크…, 지금 압축. */
export function useForkMenuItems(serverKey: () => ServerKey, sessionID: () => string | undefined) {
  const data = useData()
  const i18n = useI18n()
  const text = useForkText()
  const forkWhole = useForkWhole()
  const compactNow = useCompactNow()
  return (): ForkMenuItem[] => {
    const runtime = data.get(serverKey())
    const id = sessionID()
    const child = id ? !!runtime?.data.session.get(id)?.parentID : false
    // Forking creates a session and compacting admits work: both need the `prompt` scope (02 §9.1 device scopes).
    const none = !runtime || !id || !runtime.rpc.can("prompt")
    return [
      {
        id: "fork",
        label: text("own.fork.whole"),
        disabled: none,
        run: () => void (id && forkWhole(serverKey(), id)),
      },
      {
        id: "forkFrom",
        label: text("own.fork.fromMessage"),
        disabled: none,
        run: () => id && openForkDialog({ serverKey: serverKey(), sessionID: id }),
      },
      {
        id: "compact",
        label: i18n.t("own.ctx.compactNow"),
        disabled: none || child,
        run: () => runtime && id && compactNow(runtime, id),
      },
    ]
  }
}

/** Forks the whole history now, opens the fork and says the original is unchanged. */
function useForkWhole() {
  const data = useData()
  const router = useRouter()
  const text = useForkText()
  return async (serverKey: ServerKey, sessionID: string) => {
    const runtime = data.get(serverKey)
    if (!runtime) return
    const outcome = await forkSession({ runtime, serverKey, sessionID })
    if (!outcome.ok) return showToast({ tone: "danger", message: text("own.fork.failed", { reason: outcome.reason }) })
    showToast({ message: text("own.fork.done") })
    router.navigate({ name: "session", serverKey, sessionID: outcome.session.id })
    requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
  }
}
