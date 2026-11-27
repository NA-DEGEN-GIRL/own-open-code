// Command sources for the palette (03 §3 "명령 팔레트", 19.15). The palette owns the built-in commands (panels, pages,
// sessions, model @ account, theme…); feature modules add theirs (git actions, worktrees, notes, pin/archive,
// background tasks, find…) with `usePaletteCommands` in a component they already mount, so nothing is imported by
// the palette and nothing runs until the palette opens. Kept free of UI imports: it is in the first chunk.
import { onCleanup } from "solid-js"
import type { ShortcutID } from "@/keyboard/keymap"

/** Order of the groups when nothing is typed (03 §3 list order, then the rest of 19.15). */
export const PALETTE_GROUPS = [
  "recent",
  "session",
  "model",
  "sessionOps",
  "navigate",
  "panel",
  "terminal",
  "review",
  "git",
  "worktree",
  "project",
  "agent",
  "approval",
  "compaction",
  "mcp",
  "notes",
  "settings",
  "view",
  "shortcut",
  "app",
] as const

export type PaletteGroup = (typeof PALETTE_GROUPS)[number]

export interface PaletteCommand {
  /** Stable id (`<module>.<action>[:<arg>]`, e.g. `git.commit`, `theme:dark`): recent use and tests key on it. */
  readonly id: string
  /** Already translated. */
  readonly title: string
  readonly group: PaletteGroup
  /** Muted text after the title: a folder, an account, "현재". */
  readonly detail?: string
  /** More words to match: the other language's label, English names, ids. Never shown. */
  readonly keywords?: readonly string[]
  /** Shown on the right with the user's current keys. */
  readonly shortcut?: ShortcutID
  /** Runs after the palette closed and focus went back to where it was. */
  readonly run: () => void | Promise<void>
}

/** Read when the palette opens (and again while it is open if the signals it reads change). */
export type PaletteSource = () => readonly PaletteCommand[]

const sources = new Set<PaletteSource>()

/** Adds a source; returns its removal. */
export function registerPaletteSource(source: PaletteSource) {
  sources.add(source)
  return () => void sources.delete(source)
}

/** Registers for the lifetime of the calling component. */
export function usePaletteCommands(source: PaletteSource) {
  onCleanup(registerPaletteSource(source))
}

/** @internal src/palette: the external sources, in registration order. */
export function paletteSources(): readonly PaletteSource[] {
  return [...sources]
}
