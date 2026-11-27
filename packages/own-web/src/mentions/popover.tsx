// The suggestion list (lazy chunk): grouped options above the composer, keyboard state owned by the controller.
// Capped lists (files 20, other groups 8, commands ≤ 50), so plain rows without virtualization (R2 applies to
// unbounded lists). Pointer-down keeps focus in the textarea (no blur, no composition commit by accident).
import { createEffect, For, on, Show } from "solid-js"
import { nextFrame } from "@/data/frame"
import { useMentionText } from "./strings"
import "./suggest.css"
import type { ComposerSuggest } from "./suggest"

export function SuggestList(props: { readonly suggest: ComposerSuggest }) {
  const text = useMentionText()
  const suggest = () => props.suggest
  const engine = () => suggest().engine()
  const groups = () => engine()?.groups() ?? []
  const empty = () => !groups().some((group) => group.items.length)
  const mention = () => suggest().trigger()?.kind === "mention"

  // Keep the active row visible after ↑/↓ (layout read on the next frame, never in the key handler).
  createEffect(
    on(
      () => suggest().activeDescendant(),
      (id) => {
        if (!id) return
        nextFrame(() => document.getElementById(id)?.scrollIntoView({ block: "nearest" }))
      },
      { defer: true },
    ),
  )

  return (
    <div
      class="own-sg"
      id={suggest().listbox}
      role="listbox"
      aria-label={text("own.mention.list")}
      data-testid="suggest-list"
      data-kind={suggest().trigger()?.kind}
      data-query={suggest().trigger()?.query}
      // Server results (files) can still land above the rows shown so far and move the default choice.
      aria-busy={engine()?.loading() ? "true" : "false"}
      onPointerDown={(event) => event.preventDefault()}
    >
      <For each={groups()}>
        {(group) => (
          <div class="own-sg-group" role="group" aria-label={group.label} data-group={group.id}>
            <Show when={group.label}>
              <div class="own-sg-head" aria-hidden="true">
                {group.label}
              </div>
            </Show>
            <Show when={group.note}>
              <div class="own-sg-note" data-testid="suggest-note">
                {group.note}
              </div>
            </Show>
            <For each={group.items}>
              {(item) => (
                <div
                  class="own-sg-opt"
                  role="option"
                  id={suggest().optionID(item)}
                  aria-selected={suggest().activeItem()?.id === item.id}
                  data-active={suggest().activeItem()?.id === item.id ? "" : undefined}
                  data-testid="suggest-option"
                  data-id={item.id}
                  onPointerMove={() => {
                    if (suggest().activeItem()?.id !== item.id) suggest().setActive(item.id)
                  }}
                  onClick={() => void suggest().choose(item)}
                >
                  <span class="own-sg-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span class="own-sg-label">{item.label}</span>
                  <Show when={item.hint}>
                    <span class="own-sg-hint">{item.hint}</span>
                  </Show>
                  <Show when={item.detail}>
                    <span class="own-sg-detail">{item.detail}</span>
                  </Show>
                  <Show when={item.badge}>
                    <span class="own-sg-badge">{item.badge}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
      <Show when={mention() && empty()}>
        <div class="own-sg-status" role="status" data-testid="suggest-status">
          {engine()?.loading()
            ? text("own.mention.loading")
            : engine()?.failed()
              ? text("own.mention.failed")
              : text("own.mention.empty")}
        </div>
      </Show>
      <Show when={mention() && !empty()}>
        <div class="own-sg-foot" aria-hidden="true">
          {text("own.mention.rangeHint")}
        </div>
      </Show>
    </div>
  )
}
