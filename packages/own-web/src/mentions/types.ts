// Shared shapes of the composer suggestions (03 §18.12 `@` mentions, §18.13 `/` commands). Providers are pluggable:
// the mention providers live in this folder, the command providers in src/commands; the engine only knows this
// contract. Pure types, no runtime code, so any module may import them.
import type { ServerKey, ServerRuntime } from "@/data"

/** A chip shown outside the text (03 §4.6, §12 rule 1). Sent as prompt parts, never inline markup. */
export type MentionChip =
  | {
      readonly kind: "file"
      /** Relative to the session location (as `fs.find` returns it) or absolute. `/` separators. */
      readonly path: string
      readonly directory?: boolean
      /** `#L10-40` (1-based, inclusive). Files only. */
      readonly range?: LineRange
    }
  | { readonly kind: "reference"; readonly name: string; readonly path: string }
  | { readonly kind: "agent"; readonly name: string }
  | { readonly kind: "skill"; readonly id: string; readonly name: string }
  | { readonly kind: "resource"; readonly server: string; readonly uri: string; readonly name: string }

export interface LineRange {
  readonly start: number
  /** Omitted for a single line. */
  readonly end?: number
}

/** What the text before the caret asks for. Positions are string offsets in the textarea value. */
export type Trigger =
  | { readonly kind: "mention"; readonly query: string; readonly start: number; readonly end: number }
  /** `/name` while the caret is still inside the first word (the command list). */
  | { readonly kind: "command"; readonly query: string; readonly start: number; readonly end: number }
  /** `/name args…`: argument completion (e.g. `/agent`, `/skills`) or just the argument hint. */
  | {
      readonly kind: "argument"
      readonly command: string
      readonly query: string
      /** Start of the whole `/name args` text (0) and the caret. */
      readonly start: number
      readonly end: number
    }

export interface SuggestItem {
  /** Unique across providers of one list. */
  readonly id: string
  /** Provider id; items are grouped by it in provider order. */
  readonly group: string
  /** Main text: a path, `@name`, `/name`. */
  readonly label: string
  /** Muted second text: a description or a folder. */
  readonly detail?: string
  /** Argument hint (`[commit|branch|pr]`). */
  readonly hint?: string
  /** Small tag after the label (`MCP`, `사용자`, a shortcut). */
  readonly badge?: string
  /** One glyph in front of the label. */
  readonly icon?: string
}

export interface SuggestContext {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  /** `undefined` on the new-session screen. */
  readonly sessionID: string | undefined
  /** The session's location directory (server-normalized), or the new session's folder. */
  readonly directory: string | undefined
}

/** What choosing an item does. The engine applies the text edit first (never while composing), then the rest. */
export interface SelectEffect {
  /** Replaces the trigger text (`@query`, `/query`, `/name args`) with this. `""` removes it. */
  readonly text?: string
  readonly chip?: MentionChip
  /** Runs after the edit (client commands). */
  readonly run?: () => void | Promise<void>
}

export interface SuggestGroupView {
  readonly id: string
  readonly label: string
  /** A one-line note under the header (e.g. the agent switch cache note). */
  readonly note?: string
  readonly items: readonly SuggestItem[]
}

export interface SuggestProvider {
  readonly id: string
  /** Which trigger feeds it. */
  readonly trigger: "mention" | "command" | "argument"
  /** `argument` providers: whether they complete (or hint) this command's arguments. */
  accepts?(command: string, context: SuggestContext): boolean
  /** Group header. */
  label(trigger: Trigger): string
  /** One line under the header (a cache note, an argument hint). A group with only a note still shows. */
  note?(context: SuggestContext, trigger: Trigger): string | undefined
  readonly limit: number
  /**
   * Local candidates, ranked by the engine against `keys`. Reactive: read catalogs from stores so a late catalog
   * load updates an open list. Called while composing too (outside the input element, 03 §12 rule 5).
   */
  local?(context: SuggestContext): readonly SuggestItem[]
  /** Ranking keys for `local` items; the label when omitted. */
  keys?(item: SuggestItem): readonly string[]
  /**
   * Remote search, already ranked by the server (fs.find: fuzzysort on the server, 03 §18.12 "클라이언트에서 다시
   * 정렬하지 않는다"). Debounced 80 ms, never sent while composing (rule 9), stale answers dropped.
   */
  remote?(query: string, context: SuggestContext, signal: AbortSignal): Promise<readonly SuggestItem[]>
  /** Items shown above the remote ones, deduplicated by id (recently changed files, 18.12). */
  pinned?(query: string, context: SuggestContext): readonly SuggestItem[]
  /** Starts loading catalogs the first time the list opens (not at startup, PF6). */
  prepare?(context: SuggestContext): void
  select(item: SuggestItem, context: SuggestContext): SelectEffect | undefined
}
