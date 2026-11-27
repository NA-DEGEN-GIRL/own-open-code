// 문맥 비우기 (03 §18.18, 11 §7, core P-035): the lazy chunk behind `/reset-context`, the `⋯` item, the palette and
// the marker line. First-chunk code imports it dynamically only (`await import("@/context-reset")`), so nothing here
// counts against PF5.
export {
  compactBehindReset,
  compactionSettled,
  problem,
  released,
  resetContext,
  undoReset,
  type ResetDeps,
  type UndoDeps,
} from "./actions"
export { chooseUndo } from "./choose"
export { activeReset, hasContext, isReset, justReset, markerState, pendingReset } from "./model"
export { resetEn, resetKo, resetText, useResetText, type ResetKey } from "./strings"
