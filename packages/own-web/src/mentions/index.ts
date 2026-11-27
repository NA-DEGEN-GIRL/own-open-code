// Mentions module entry (03 §18.12 `@` mentions; with src/commands, §18.13 `/` commands): pluggable suggestion
// providers the composer mounts. Owner: mentions. The composer (integrator) wires:
//   const suggest = createComposerSuggest({ element, context, draftKey, disabled, actions: useCommandActions(…) })
//   <SuggestPopover suggest={suggest} /> before the textarea, <MentionChips suggest={suggest} /> above it,
//   the textarea events (keydown first), `submitClient` before `planSend`, `send` instead of `data.session.prompt`.
import type { LineRange, MentionChip } from "./types"

export { createComposerSuggest, type ComposerSuggest, type ComposerSuggestOptions } from "./suggest"
export { MentionChips, SuggestPopover } from "./view"
export { chipID, chipToken, createChipStore, fileUri, mentionParts, type ChipStore, type MentionParts } from "./chips"
export { MENTION_INTENT, requestMention, type MentionIntent } from "./intents"
export { formatRange, splitRange } from "./range"
export { detectTrigger } from "./trigger"
export type {
  LineRange,
  MentionChip,
  SelectEffect,
  SuggestContext,
  SuggestGroupView,
  SuggestItem,
  SuggestProvider,
  Trigger,
} from "./types"

/**
 * The chip for lines picked in the review or files tab (03 §10 `Ctrl+Shift+L` "선택 영역을 문맥에 추가"): the owner
 * of that tab calls `suggest.addChip(selectionChip(path, start, end))`.
 */
export function selectionChip(path: string, start: number, end?: number): MentionChip {
  const range: LineRange | undefined =
    start > 0
      ? { start: Math.min(start, end ?? start), end: end && end !== start ? Math.max(start, end) : undefined }
      : undefined
  return { kind: "file", path: path.replaceAll("\\", "/"), range }
}
