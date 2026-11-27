// What the composer renders (first chunk): the popover slot (the list itself is the lazy chunk) and the mention
// chips outside the text (03 §4.6 `[@ src/router.ts#L10-40 ✕]`, §12 rule 1).
import { For, lazy, Show, Suspense } from "solid-js"
import { chipID, chipToken } from "./chips"
import { useMentionText, type MentionKey } from "./strings"
import type { ComposerSuggest } from "./suggest"
import type { MentionChip } from "./types"
import "./chips.css"

const List = lazy(() => import("./lazy").then((module) => ({ default: module.SuggestList })))

/**
 * Mount inside the composer box, right before the textarea: the list is positioned above the box from this
 * zero-height anchor, so it never shifts the textarea (R7).
 */
export function SuggestPopover(props: { readonly suggest: ComposerSuggest }) {
  return (
    <div class="own-sg-anchor">
      <Show when={props.suggest.visible()}>
        <Suspense>
          <List suggest={props.suggest} />
        </Suspense>
      </Show>
    </div>
  )
}

const KIND: Record<MentionChip["kind"], MentionKey> = {
  file: "own.mention.kind.file",
  reference: "own.mention.kind.reference",
  agent: "own.mention.kind.agent",
  skill: "own.mention.kind.skill",
  resource: "own.mention.kind.resource",
}

const ICON: Record<MentionChip["kind"], string> = {
  file: "@",
  reference: "⌂",
  agent: "◎",
  skill: "✦",
  resource: "⧉",
}

/** Chips of the draft on screen. Nothing is rendered without chips. */
export function MentionChips(props: { readonly suggest: ComposerSuggest }) {
  const text = useMentionText()
  return (
    <Show when={props.suggest.chipList().length}>
      <ul class="own-mc" aria-label={text("own.mention.chips")} data-testid="mention-chips">
        <For each={props.suggest.chipList()}>
          {(chip) => {
            const label = chipToken(chip).slice(1)
            return (
              <li
                class="own-mc-chip"
                data-kind={chip.kind}
                data-testid="mention-chip"
                title={`${text(KIND[chip.kind])} · ${chip.kind === "resource" ? chip.uri : label}`}
              >
                <span class="own-mc-icon" aria-hidden="true">
                  {ICON[chip.kind]}
                </span>
                <span class="own-mc-label">{label}</span>
                <button
                  type="button"
                  class="own-mc-remove"
                  aria-label={text("own.mention.remove", { label })}
                  onClick={() => props.suggest.removeChip(chipID(chip))}
                >
                  ✕
                </button>
              </li>
            )
          }}
        </For>
      </ul>
    </Show>
  )
}
