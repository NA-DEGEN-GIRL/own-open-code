// 곁질문 (03 §4.4.2): `/btw <질문>` in the composer, the palette's `곁질문…` and the conversation `⋯`'s `곁질문…` open the
// side panel of a conversation, with a question to ask at once or an empty box. The shell shows the panel (a lazy chunk)
// while `sideTarget()` holds one. First-chunk safe: nothing here imports the panel.
import { createSignal } from "solid-js"
import type { ServerKey } from "@/data"

export interface OpenSideDetail {
  readonly serverKey: ServerKey
  readonly sessionID: string
  /** Asked at once as a new side thread; without it the panel opens with its box focused. */
  readonly question?: string
}

const [target, setTarget] = createSignal<OpenSideDetail>()

/** The panel on screen; a new object for every open, so a second `/btw` remounts it with its question. */
export const sideTarget = target

export function openSide(detail: OpenSideDetail) {
  setTarget({ ...detail })
}

export function closeSide() {
  setTarget(undefined)
}