// The `⋯` items of 문맥 비우기 (03 §4.4), loaded when the menu first opens: `문맥 비우기` after `압축 내용 보기`
// (`이미 새 문맥이에요` when nothing the model sees follows the active boundary), `문맥 비우기 되돌리기` while the active
// boundary is a reset, and a note while one waits for the turn. None on a subagent conversation or without `prompt`.
import type { ServerRuntime } from "@/data"
import type { Locale } from "@/i18n"
import type { MenuItem } from "@/servers/menu"
import { showToast } from "@/switcher/toast"
import { resetContext, undoReset } from "./actions"
import { activeReset, hasContext, pendingReset } from "./model"
import { resetText } from "./strings"

export type ResetMenu = typeof resetMenuItems

export function resetMenuItems(input: {
  readonly runtime: ServerRuntime
  readonly sessionID: string
  readonly locale: Locale
}): MenuItem[] {
  const runtime = input.runtime
  const sessionID = input.sessionID
  const words = (key: Parameters<typeof resetText.text>[1]) => resetText.text(input.locale, key)
  const session = runtime.data.session.get(sessionID)
  if (!session || session.parentID || !runtime.rpc.can("prompt")) return []
  if (pendingReset(runtime.data.session.pending.list(sessionID)))
    return [{ note: words("own.reset.queued"), testid: "session-menu-reset-pending" }]
  const deps = { runtime, sessionID, locale: input.locale, toast: showToast }
  const messages = runtime.data.session.message.list(sessionID)
  const active = activeReset(messages)
  return [
    hasContext(messages)
      ? { label: words("own.reset.menu"), onSelect: () => void resetContext(deps), testid: "session-menu-reset" }
      : { note: words("own.reset.already"), testid: "session-menu-reset-fresh" },
    ...(active && !session.revert
      ? [
          {
            label: words("own.reset.menuUndo"),
            onSelect: () => void undoReset({ ...deps, resetID: active.id }),
            testid: "session-menu-reset-undo",
          },
        ]
      : []),
  ]
}
