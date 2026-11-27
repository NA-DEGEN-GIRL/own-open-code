export * as Ideas from "./ideas.js"

// Idea notes (02 §9.2 "아이디어 노트", 03 §4.4.1): the global sticky notes, kept by this PC's service and tied to no
// project or conversation. Plain constants without the schema graph, so own-web's first chunk imports them without
// Effect.

/** Text length of one idea in UTF-16 code units, like the browser's text field counts. A sticky note, not a document. */
export const TEXT_MAX = 2_000
/** Ideas this PC keeps. A save that would add one more is `ideas_limit`. */
export const MAX = 1_000
/** Idea ids: the browser's `crypto.randomUUID()` and the like. No separators, no control characters. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** Paper colors, in picker order. Each has a theme token (`--own-sticky-<color>`); `yellow` is the default. */
export const COLORS = ["yellow", "pink", "green", "blue", "purple"] as const
export type Color = (typeof COLORS)[number]
