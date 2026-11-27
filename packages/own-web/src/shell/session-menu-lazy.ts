// The conversation `⋯` items that arrive when the menu first opens, in one lazy chunk (the first chunk's budget, PF5):
// 문맥 비우기 (context-reset/menu.ts), 곁질문 (side/menu.ts, 03 §4.4.2) and, on a paired device, 브라우저
// (browser/remote/menu.ts, 05 §8.10).
import { remoteBrowserItems } from "@/browser/remote/menu"
import { resetMenuItems } from "@/context-reset/menu"
import type { DataLayer, ServerRuntime } from "@/data"
import type { Locale } from "@/i18n"
import { sideMenuItems } from "@/side/menu"
import type { Shell } from "./context"

export type LazyMenu = typeof lazyMenuItems

export function lazyMenuItems(input: {
  readonly data: DataLayer
  readonly shell: Shell
  readonly runtime: ServerRuntime
  readonly sessionID: string
  readonly locale: Locale
}) {
  return { reset: resetMenuItems(input), side: sideMenuItems(input), browser: remoteBrowserItems(input) }
}
